import { Plugin } from "gramio";
import type { FlowDefinition } from "./builder.js";
import {
	type FlowRuntime,
	getInternals,
	handleCallback,
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

interface InternalNamespace extends OnboardingNamespace {
	[NS_MARKER]: true;
	"~controls": Map<string, FlowControl>;
	"~storages": Map<string, OnboardingStorage>;
	"~scopeKeys": Map<string, string>;
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

			const control = makeFlowControl(rt, c, scopeKey, activeRecord, globalRec);

			const ns = upsertNamespace(c, storage, scopeKey, rt);
			ns[flowId] = control;
			ns["~controls"].set(flowId, control);
			if (!ns.list.includes(flowId)) ns.list.push(flowId);

			return { onboarding: ns as unknown as OnboardingNamespace };
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
	if (existing && existing[NS_MARKER]) {
		existing["~storages"].set(rt.def.opts.id, storage);
		existing["~scopeKeys"].set(rt.def.opts.id, scopeKey);
		return existing;
	}

	const controls = new Map<string, FlowControl>();
	const storages = new Map<string, OnboardingStorage>();
	const scopeKeys = new Map<string, string>();
	storages.set(rt.def.opts.id, storage);
	scopeKeys.set(rt.def.opts.id, scopeKey);

	const ns: InternalNamespace = {
		[NS_MARKER]: true,
		"~controls": controls,
		"~storages": storages,
		"~scopeKeys": scopeKeys,
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
					if (c) getInternals(c).globalLocal = { kind: "global", disabled: true };
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
					if (c) getInternals(c).globalLocal = { kind: "global", disabled: false };
				}),
			);
		},

		async exitAll() {
			await runExitAll(ns);
		},
	};

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
