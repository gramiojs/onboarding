import { Plugin } from "gramio";
import type { FlowDefinition } from "./builder.js";
import {
	type FlowCoordinator,
	type FlowRuntime,
	getInternals,
	globalKey,
	handleCallback,
	isEligibleForStep,
	loadGlobal,
	loadRecord,
	makeFlowControl,
	resolveCurrentStep,
	resolveScopeKey,
} from "./runner.js";
import { memoryStorage } from "./storage/memory.js";
import { decode } from "./tokens.js";
import type {
	AnyCtx,
	FlowControl,
	FlowStatus,
	OnboardingNamespace,
	OnboardingStorage,
} from "./types.js";

const NS_MARKER = Symbol.for("@gramio/onboarding/ns");

// Module-level registry of every plugin's runtime, indexed by flowId. Used by
// `coord.onFlowTerminal` (and `pauseOthers`) to bootstrap a control for a flow
// whose `.derive` hook hasn't fired yet on the current ctx — gramio's
// `.extend()` bundles each plugin's derive+on into an isolated chain, so when
// welcome's callback handler runs, premium's derive may not have added its
// control to the shared namespace yet.
const flowRegistry = new Map<string, FlowRuntime>();

interface InternalNamespace extends OnboardingNamespace {
	[NS_MARKER]: true;
	"~controls": Map<string, FlowControl>;
	"~storages": Map<string, OnboardingStorage>;
	"~scopeKeys": Map<string, string>;
	"~coord": FlowCoordinator;
	"~ctx": AnyCtx;
}

/** Module-level lazy-shared default storage so multi-flow setups Just Work. */
let defaultStorageInstance: OnboardingStorage | null = null;
function getDefaultStorage(): OnboardingStorage {
	defaultStorageInstance ??= memoryStorage();
	return defaultStorageInstance;
}

const DERIVE_EVENTS = ["message", "callback_query"] as const;

export function createOnboardingPlugin(def: FlowDefinition): Plugin {
	const storage = def.opts.storage ?? getDefaultStorage();
	const flowId = def.opts.id;
	const pluginName = `@gramio/onboarding[${flowId}]`;

	const rt: FlowRuntime = { def, storage, bot: null };
	flowRegistry.set(flowId, rt);

	const plugin = new Plugin(pluginName)
		.derive(DERIVE_EVENTS, async (ctx) => {
			const c = ctx as unknown as AnyCtx;

			// Capture bot reference for error forwarding (best-effort).
			if (!rt.bot && (c as { bot?: unknown }).bot) {
				rt.bot = (c as { bot: { errorHandler?: (...a: unknown[]) => unknown } })
					.bot as FlowRuntime["bot"];
			}

			const scopeKey = resolveScopeKey(def, c);
			const [globalRec, record] = await Promise.all([
				loadGlobal(storage, scopeKey),
				loadRecord(storage, flowId, scopeKey),
			]);

			// Reconcile schema drift: if the stored stepId no longer exists,
			// resolve via onMissingStep / fallback BEFORE exposing FlowControl.
			let activeRecord = record;
			if (
				record?.status === "active" &&
				record.stepId &&
				!def.steps.some((s) => s.id === record.stepId)
			) {
				const { step } = resolveCurrentStep(def, c, record);
				if (!step) {
					activeRecord = { ...record, status: "completed" as FlowStatus };
				} else {
					activeRecord = { ...record, stepId: step.id };
				}
				await storage.set(`flow:${flowId}:${scopeKey}`, activeRecord);
			}

			const ns = upsertNamespace(c, storage, scopeKey, rt);
			const control = makeFlowControl(
				rt,
				c,
				scopeKey,
				activeRecord,
				globalRec,
				ns["~coord"],
			);
			ns[flowId] = control;
			ns["~controls"].set(flowId, control);
			if (!ns.list.includes(flowId)) ns.list.push(flowId);

			// Phase 5: if a prior advance left a step pending (ineligible scope
			// at that time), re-attempt rendering now that we have a fresh ctx.
			// `safeRender` itself re-checks eligibility, so a still-ineligible
			// update is a no-op that keeps pendingStepId intact.
			if (activeRecord?.status === "active" && activeRecord.pendingStepId) {
				const pending = def.steps.find(
					(s) => s.id === activeRecord.pendingStepId,
				);
				if (pending && isEligibleForStep(c, pending.config)) {
					const internals = getInternals(control);
					internals.local = {
						...internals.local,
						stepId: pending.id,
					};
					await internals.renderStep(pending);
				}
			}

			return { onboarding: ns as unknown as OnboardingNamespace };
		})
		.on("message", async (ctx, next) => {
			const c = ctx as unknown as AnyCtx;
			const ns = (c as { onboarding?: InternalNamespace }).onboarding;
			const control = ns?.["~controls"].get(flowId);

			// Nothing to do if this flow isn't currently active for the user.
			if (!control || control.status !== "active") return next();

			const stepId = control.currentStep;
			if (!stepId) return next();
			const step = def.steps.find((s) => s.id === stepId);
			if (!step?.config.advanceOn) return next();

			let matched = false;
			try {
				matched = await step.config.advanceOn(c);
			} catch (err) {
				rt.bot?.errorHandler?.(err, {
					source: "onboarding",
					flowId,
					op: "advanceOn",
				});
			}

			if (matched) {
				// `from` guard protects against races: if the step already advanced
				// (e.g. via a parallel button click), we skip the duplicate next().
				await control.next({ from: stepId });
			}

			// Default: let the update flow to business handlers. `passthrough: false`
			// only suppresses forwarding when we actually advanced.
			if (matched && step.config.passthrough === false) return;
			return next();
		})
		.on("callback_query", async (ctx, next) => {
			const c = ctx as unknown as AnyCtx;
			const data = (c as { data?: string }).data;
			if (!data) return next();
			const token = decode(data);
			if (!token || token.flowId !== flowId) return next();

			const ns = (c as { onboarding?: InternalNamespace }).onboarding;
			const control = ns?.["~controls"].get(flowId);
			if (!control) return next();

			// `exitAll` is shared across all registered flows in this namespace.
			if (token.op === "exitAll") {
				if (ns) await runExitAll(ns);
				const c2 = c as {
					answerCallbackQuery?: (p?: { text?: string }) => Promise<unknown>;
					answer?: (p?: { text?: string }) => Promise<unknown>;
				};
				try {
					await (c2.answerCallbackQuery ?? c2.answer)?.();
				} catch {
					// ignore
				}
				return;
			}

			await handleCallback(rt, c, control, token);
		});

	return plugin as unknown as Plugin;
}

// ─────────────────────────────────────────────────────────────────────────────
// Namespace coordination — shared OnboardingNamespace across multiple plugins
// ─────────────────────────────────────────────────────────────────────────────

function upsertNamespace(
	ctx: AnyCtx,
	storage: OnboardingStorage,
	scopeKey: string,
	rt: FlowRuntime,
): InternalNamespace {
	const existing = (ctx as { onboarding?: unknown }).onboarding as
		| InternalNamespace
		| undefined;
	if (existing?.[NS_MARKER]) {
		existing["~storages"].set(rt.def.opts.id, storage);
		existing["~scopeKeys"].set(rt.def.opts.id, scopeKey);
		// Keep ctx fresh — each plugin's derive refreshes the pointer.
		(existing as { "~ctx": AnyCtx })["~ctx"] = ctx;
		return existing;
	}

	const controls = new Map<string, FlowControl>();
	const storages = new Map<string, OnboardingStorage>();
	const scopeKeys = new Map<string, string>();
	storages.set(rt.def.opts.id, storage);
	scopeKeys.set(rt.def.opts.id, scopeKey);

	// Multi-flow coordination lives on a single canonical storage — the first
	// one registered with this namespace. In practice every plugin shares the
	// same storage (explicit or the module-level default), so "canonical" is
	// whichever is set first here. Different storages per flow would produce
	// uncoordinated queues — documented tradeoff for Phase 4 MVP.
	const canonicalStorage = storage;

	// `ns` is defined below; the coord closures need a stable reference. We
	// thread ctx via the namespace itself so each derive refresh updates it.
	let nsRef: InternalNamespace | null = null;

	async function bootstrapControl(
		targetFlowId: string,
	): Promise<FlowControl | undefined> {
		if (!nsRef) return undefined;
		const existing = controls.get(targetFlowId);
		if (existing) return existing;
		const targetRt = flowRegistry.get(targetFlowId);
		if (!targetRt) return undefined;
		const ctx2 = nsRef["~ctx"];
		const sk = resolveScopeKey(targetRt.def, ctx2);
		const [gl, rec] = await Promise.all([
			loadGlobal(targetRt.storage, sk),
			loadRecord(targetRt.storage, targetFlowId, sk),
		]);
		const ctrl = makeFlowControl(targetRt, ctx2, sk, rec, gl, coord);
		controls.set(targetFlowId, ctrl);
		storages.set(targetFlowId, targetRt.storage);
		scopeKeys.set(targetFlowId, sk);
		nsRef[targetFlowId] = ctrl;
		if (!nsRef.list.includes(targetFlowId)) nsRef.list.push(targetFlowId);
		return ctrl;
	}

	const coord: FlowCoordinator = {
		hasActiveOther(exceptFlowId) {
			for (const [id, ctrl] of controls) {
				if (id === exceptFlowId) continue;
				if (ctrl.status === "active" || ctrl.status === "paused") return true;
			}
			return false;
		},

		async enqueueStart(entry) {
			const g = (await canonicalStorage.get(globalKey(scopeKey))) ?? {
				kind: "global" as const,
			};
			const queue = [...(g.queue ?? []), entry];
			await canonicalStorage.set(globalKey(scopeKey), { ...g, queue });
		},

		async pauseOthers(starterFlowId) {
			// Pause already-registered active flows…
			for (const [id, ctrl] of controls) {
				if (id === starterFlowId) continue;
				if (ctrl.status !== "active") continue;
				await getInternals(ctrl).pauseImpl();
				const g = (await canonicalStorage.get(globalKey(scopeKey))) ?? {
					kind: "global" as const,
				};
				const stack = [...(g.preemptStack ?? []), { flowId: id }];
				await canonicalStorage.set(globalKey(scopeKey), {
					...g,
					preemptStack: stack,
				});
			}
			// …plus any flow that's active on disk but not yet derived on this ctx.
			for (const [fid, frt] of flowRegistry) {
				if (fid === starterFlowId) continue;
				if (controls.has(fid)) continue;
				if (!nsRef) continue;
				const sk = resolveScopeKey(frt.def, nsRef["~ctx"]);
				const rec = await loadRecord(frt.storage, fid, sk);
				if (rec?.status !== "active") continue;
				const ctrl = await bootstrapControl(fid);
				if (!ctrl) continue;
				await getInternals(ctrl).pauseImpl();
				const g = (await canonicalStorage.get(globalKey(scopeKey))) ?? {
					kind: "global" as const,
				};
				const stack = [...(g.preemptStack ?? []), { flowId: fid }];
				await canonicalStorage.set(globalKey(scopeKey), {
					...g,
					preemptStack: stack,
				});
			}
		},

		async onFlowTerminal(finishedFlowId, _terminal) {
			const g = (await canonicalStorage.get(globalKey(scopeKey))) ?? {
				kind: "global" as const,
			};

			// 1. Preempt stack wins — LIFO resume of the flow that was paused.
			const stack = g.preemptStack ?? [];
			if (stack.length > 0) {
				const top = stack[stack.length - 1]!;
				await canonicalStorage.set(globalKey(scopeKey), {
					...g,
					preemptStack: stack.slice(0, -1),
				});
				const ctrl =
					controls.get(top.flowId) ?? (await bootstrapControl(top.flowId));
				if (ctrl) await ctrl.start();
				return;
			}

			// 2. Otherwise drain the FIFO queue.
			const queue = g.queue ?? [];
			if (queue.length === 0) return;
			const [head, ...rest] = queue;
			await canonicalStorage.set(globalKey(scopeKey), { ...g, queue: rest });
			if (!head || head.flowId === finishedFlowId) return;
			const ctrl =
				controls.get(head.flowId) ?? (await bootstrapControl(head.flowId));
			if (ctrl) {
				await ctrl.start(head.from ? { from: head.from } : undefined);
			}
		},
	};

	const ns: InternalNamespace = {
		[NS_MARKER]: true,
		"~controls": controls,
		"~storages": storages,
		"~scopeKeys": scopeKeys,
		"~coord": coord,
		"~ctx": ctx,
		list: [],

		get active() {
			for (const [id, ctrl] of controls) {
				if (ctrl.status === "active") {
					return { id, step: ctrl.currentStep ?? "" };
				}
			}
			return null;
		},

		get allDisabled() {
			for (const [id, ctrl] of controls) {
				const internals = getInternals(ctrl);
				if (internals.globalLocal.disabled) return true;
				void id; // eslint stub
			}
			return false;
		},

		flow(id: string) {
			return controls.get(id);
		},

		async disableAll() {
			await Promise.all(
				[...storages.entries()].map(async ([id, s]) => {
					const sk = scopeKeys.get(id) ?? scopeKey;
					await s.set(`global:${sk}`, {
						kind: "global",
						disabled: true,
					});
					const c = controls.get(id);
					if (c)
						getInternals(c).globalLocal = { kind: "global", disabled: true };
				}),
			);
		},

		async enableAll() {
			await Promise.all(
				[...storages.entries()].map(async ([id, s]) => {
					const sk = scopeKeys.get(id) ?? scopeKey;
					await s.set(`global:${sk}`, {
						kind: "global",
						disabled: false,
					});
					const c = controls.get(id);
					if (c)
						getInternals(c).globalLocal = { kind: "global", disabled: false };
				}),
			);
		},

		async exitAll() {
			await runExitAll(ns);
		},
	};

	nsRef = ns;
	return ns;
}

async function runExitAll(ns: InternalNamespace): Promise<void> {
	for (const ctrl of ns["~controls"].values()) {
		if (ctrl.status === "active" || ctrl.status === "paused") {
			await ctrl.dismiss();
		}
	}
	await ns.disableAll();
}
