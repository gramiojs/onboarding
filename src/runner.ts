import type { FlowDefinition } from "./builder.js";
import { renderInline } from "./render/inline.js";
import { renderView, shouldRenderViaViews } from "./render/views.js";
import { type DecodedToken, type Op, encode, newRunId } from "./tokens.js";
import type {
	AnyCtx,
	ExitReason,
	FlowControl,
	FlowStatus,
	LeaveReason,
	NextResult,
	OnboardingRecord,
	OnboardingStorage,
	OnboardingViewCtx,
	Scope,
	ScopeControls,
	StartResult,
	StepConfig,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

export function flowKey(flowId: string, scopeKey: string) {
	return `flow:${flowId}:${scopeKey}` as const;
}

export function globalKey(scopeKey: string) {
	return `global:${scopeKey}` as const;
}

export function resolveScopeKey(def: FlowDefinition, ctx: AnyCtx): string {
	const s = def.opts.scope;
	if (typeof s === "function") return s(ctx);
	if (s === "chat") {
		return String((ctx as { chatId?: number }).chatId ?? "anonymous");
	}
	return String((ctx as { from?: { id?: number } }).from?.id ?? "anonymous");
}

export async function loadRecord(
	storage: OnboardingStorage,
	flowId: string,
	scopeKey: string,
): Promise<OnboardingRecord | null> {
	const r = await storage.get(flowKey(flowId, scopeKey));
	return r ?? null;
}

export async function loadGlobal(
	storage: OnboardingStorage,
	scopeKey: string,
): Promise<OnboardingRecord> {
	const r = await storage.get(globalKey(scopeKey));
	return r ?? { kind: "global", disabled: false };
}

async function saveRecord(
	storage: OnboardingStorage,
	flowId: string,
	scopeKey: string,
	record: OnboardingRecord,
): Promise<void> {
	await storage.set(flowKey(flowId, scopeKey), {
		...record,
		updatedAt: Date.now(),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope + controls resolution
// ─────────────────────────────────────────────────────────────────────────────

export function detectScope(ctx: AnyCtx): Scope {
	// `callback_query` contexts expose chat at `ctx.message.chat`, not `ctx.chat`.
	const direct = (ctx as { chat?: { type?: string } }).chat?.type;
	const viaMessage = (ctx as { message?: { chat?: { type?: string } } }).message
		?.chat?.type;
	const type = direct ?? viaMessage;
	return type === "private" ? "dm" : "group";
}

const DM_DEFAULTS: Required<ScopeControls> = {
	next: true,
	skip: true,
	exit: true,
	dismiss: true,
};

const GROUP_DEFAULTS: Required<ScopeControls> = {
	next: false,
	skip: false,
	exit: true,
	dismiss: false,
};

export function effectiveControls(
	def: FlowDefinition,
	step: StepConfig<unknown, string>,
	scope: Scope,
): Required<ScopeControls> {
	const base = scope === "dm" ? DM_DEFAULTS : GROUP_DEFAULTS;
	const flowOverride = def.opts.controls?.[scope];
	const stepOverride = step.controls?.[scope];
	return { ...base, ...flowOverride, ...stepOverride };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens for view-injected ctx
// ─────────────────────────────────────────────────────────────────────────────

export function buildTokens(
	def: FlowDefinition,
	step: StepConfig<unknown, string>,
	stepId: string,
	runId: string,
	data: Record<string, unknown>,
	scope: Scope,
): OnboardingViewCtx {
	const c = effectiveControls(def, step, scope);
	return {
		flowId: def.opts.id,
		stepId,
		data,
		next: c.next ? encode("next", def.opts.id, runId, stepId) : undefined,
		skip: c.skip ? encode("skip", def.opts.id, runId, stepId) : undefined,
		exit: encode("exit", def.opts.id, runId, stepId),
		dismiss: c.dismiss
			? encode("dismiss", def.opts.id, runId, stepId)
			: undefined,
		exitAll: encode("exitAll", def.opts.id, runId, stepId),
		goto: (target: string) =>
			encode("goto", def.opts.id, runId, stepId, target),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Step lookup + missing-step fallback
// ─────────────────────────────────────────────────────────────────────────────

export function getStepIndex(
	def: FlowDefinition,
	stepId: string | undefined,
): number {
	if (!stepId) return -1;
	return def.steps.findIndex((s) => s.id === stepId);
}

export function resolveCurrentStep(
	def: FlowDefinition,
	ctx: AnyCtx,
	record: OnboardingRecord,
): {
	step: { id: string; config: StepConfig<unknown, string> } | null;
	advanced: boolean;
} {
	const idx = getStepIndex(def, record.stepId);
	if (idx >= 0) return { step: def.steps[idx]!, advanced: false };

	const oldStepId = record.stepId ?? "";
	if (def.hooks.onMissingStep) {
		const decision = def.hooks.onMissingStep(ctx, {
			oldStepId,
			availableSteps: def.steps.map((s) => s.id),
		});
		if (decision === "complete" || decision === "exit") {
			return { step: null, advanced: true };
		}
		const found = def.steps.find((s) => s.id === decision);
		if (found) return { step: found, advanced: true };
	}

	// Default fallback: nearest step at (old-index + 1) — but the old index is
	// gone, so fall back to the next remaining step starting from index 0.
	if (def.steps.length > 0) return { step: def.steps[0]!, advanced: true };
	return { step: null, advanced: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Render dispatcher
// ─────────────────────────────────────────────────────────────────────────────

async function renderStep(
	def: FlowDefinition,
	ctx: AnyCtx,
	step: { id: string; config: StepConfig<unknown, string> },
	runId: string,
	data: Record<string, unknown>,
): Promise<{ messageId?: number }> {
	const scope = detectScope(ctx);
	const tokens = buildTokens(def, step.config, step.id, runId, data, scope);

	if (shouldRenderViaViews(ctx, step.config)) {
		await renderView(ctx, step.config, tokens);
		return {};
	}

	const messageId = await renderInline(ctx, step.config, tokens);
	return { messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowControl factory — one per ctx per flow
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowRuntime {
	def: FlowDefinition;
	storage: OnboardingStorage;
	bot: { errorHandler?: (err: unknown, meta: object) => unknown } | null;
}

/**
 * Per-user coordinator shared by all flows in a single `ctx.onboarding`
 * namespace. The namespace builds one instance and passes it into every
 * `makeFlowControl` so flows can (a) learn about each other and (b) trigger
 * queue/preempt resumption when they finish — without reaching across plugins.
 */
export interface FlowCoordinator {
	/** Is there another flow currently active or paused for this user? */
	hasActiveOther(exceptFlowId: string): boolean;
	/** Record a deferred start request. */
	enqueueStart(entry: { flowId: string; from?: string }): Promise<void>;
	/** Pause every other active flow, pushing each onto the preempt stack. */
	pauseOthers(starterFlowId: string): Promise<void>;
	/** Called by a flow after it hits `completed | exited | dismissed`. */
	onFlowTerminal(
		flowId: string,
		terminal: "completed" | "exited" | "dismissed",
	): Promise<void>;
}

export function makeFlowControl(
	rt: FlowRuntime,
	ctx: AnyCtx,
	scopeKey: string,
	record: OnboardingRecord | null,
	globalRec: OnboardingRecord,
	coord?: FlowCoordinator,
): FlowControl {
	const def = rt.def;

	// Local mutable cache so sync getters reflect the latest in-update mutation.
	let local: OnboardingRecord = record ?? {
		kind: "flow",
		flowId: def.opts.id,
		status: "null",
		data: {},
	};
	let globalLocal = globalRec;

	const sync = async () => {
		await saveRecord(rt.storage, def.opts.id, scopeKey, local);
	};

	async function transition(
		newStatus: FlowStatus,
		extra: Partial<OnboardingRecord> = {},
	) {
		local = {
			...local,
			kind: "flow",
			flowId: def.opts.id,
			status: newStatus,
			...extra,
		};
		await sync();
	}

	async function startImpl(opts?: {
		from?: string;
		force?: boolean;
	}): Promise<StartResult> {
		if (globalLocal.disabled) return "opted-out";
		const status = local.status ?? "null";

		if (status === "dismissed") return "dismissed";

		// Paused → resume. Re-render the current step and reactivate. Triggered
		// by the preempting flow finishing (via coord.onFlowTerminal) or by a
		// user-initiated `.start()` on a paused flow.
		if (status === "paused") {
			await transition("active");
			const cur = def.steps.find((s) => s.id === local.stepId);
			if (cur) await safeRender(cur);
			return "resumed";
		}

		// Concurrency coordination. Only kicks in when another flow is live
		// AND we're not already active (active → handled by existing resume
		// logic below — a flow can always restart itself).
		let preempted = false;
		if (status !== "active" && coord?.hasActiveOther(def.opts.id)) {
			const mode = def.opts.concurrency;
			if (mode === "queue") {
				await coord.enqueueStart({ flowId: def.opts.id, from: opts?.from });
				return "queued";
			}
			if (mode === "preempt") {
				await coord.pauseOthers(def.opts.id);
				preempted = true;
			}
			// `parallel` — fall through, start normally alongside others.
		}

		if (status === "completed" && !opts?.force) return "already-completed";
		if (status === "active") {
			if (def.opts.resumeOnStart && !opts?.force) return "already-active";
			// fall through to restart
		}

		const fromIdx = opts?.from ? getStepIndex(def, opts.from) : 0;
		const startIdx = fromIdx >= 0 ? fromIdx : 0;
		const firstStep = def.steps[startIdx];
		if (!firstStep) return "already-completed";

		const runId = newRunId();
		await transition("active", {
			runId,
			stepId: firstStep.id,
			data: local.data ?? {},
			startedAt: Date.now(),
			chatId: (ctx as { chatId?: number }).chatId,
		});

		await runStepHooks(def, ctx, null, firstStep.id, "next").catch((e) =>
			forward(rt, e, "start.onStepChange"),
		);

		try {
			const out = await renderStep(
				def,
				ctx,
				firstStep,
				runId,
				local.data ?? {},
			);
			if (out.messageId !== undefined) {
				local.messageId = out.messageId;
				await sync();
			}
		} catch (e) {
			forward(rt, e, "start.render");
		}

		if (preempted) return "preempted";
		return status === "exited" || status === "completed" || status === "null"
			? "started"
			: "resumed";
	}

	async function pauseImpl(): Promise<void> {
		if (local.status !== "active") return;
		await transition("paused");
	}

	async function nextImpl(opts?: { from?: string }): Promise<NextResult> {
		if (local.status !== "active") return "inactive";
		if (opts?.from && opts.from !== local.stepId) return "step-mismatch";

		const idx = getStepIndex(def, local.stepId);
		if (idx < 0) {
			// missing step → fallback resolution will fire on next render
			const { step } = resolveCurrentStep(def, ctx, local);
			if (!step) {
				await completeImpl();
				return "completed";
			}
			local.stepId = step.id;
			await sync();
			await safeRender(step);
			return "advanced";
		}

		const nextStep = def.steps[idx + 1];
		if (!nextStep) {
			await completeImpl();
			return "completed";
		}

		await runStepHooks(
			def,
			ctx,
			local.stepId ?? null,
			nextStep.id,
			"next",
		).catch((e) => forward(rt, e, "next.onStepChange"));
		local.stepId = nextStep.id;
		await sync();
		await safeRender(nextStep);

		// Terminal step has no successor — show its message, then complete.
		if (idx + 2 >= def.steps.length) {
			await completeImpl();
			return "completed";
		}
		return "advanced";
	}

	async function gotoImpl(id: string): Promise<void> {
		if (local.status !== "active") return;
		const target = def.steps.find((s) => s.id === id);
		if (!target) return;
		await runStepHooks(def, ctx, local.stepId ?? null, target.id, "goto").catch(
			(e) => forward(rt, e, "goto.onStepChange"),
		);
		local.stepId = target.id;
		await sync();
		await safeRender(target);
	}

	async function skipImpl(): Promise<void> {
		if (local.status !== "active") return;
		await nextImpl();
	}

	async function exitImpl(reason: ExitReason = "user"): Promise<void> {
		if (local.status !== "active" && local.status !== "paused") return;
		const at = local.stepId ?? "";
		await transition("exited");
		if (def.hooks.onExit) {
			try {
				await def.hooks.onExit(ctx, { at, reason });
			} catch (e) {
				forward(rt, e, "exit.hook");
			}
		}
		if (coord) {
			await coord
				.onFlowTerminal(def.opts.id, "exited")
				.catch((e) => forward(rt, e, "exit.coord"));
		}
	}

	async function dismissImpl(): Promise<void> {
		const at = local.stepId ?? "";
		await transition("dismissed");
		if (def.hooks.onDismiss) {
			try {
				await def.hooks.onDismiss(ctx, { at });
			} catch (e) {
				forward(rt, e, "dismiss.hook");
			}
		}
		if (coord) {
			await coord
				.onFlowTerminal(def.opts.id, "dismissed")
				.catch((e) => forward(rt, e, "dismiss.coord"));
		}
	}

	async function undismissImpl(): Promise<void> {
		if (local.status !== "dismissed") return;
		await transition("null");
	}

	async function completeImpl(): Promise<void> {
		const data = local.data ?? {};
		await transition("completed");
		if (def.hooks.onComplete) {
			try {
				await def.hooks.onComplete(ctx, { data });
			} catch (e) {
				forward(rt, e, "complete.hook");
			}
		}
		if (coord) {
			await coord
				.onFlowTerminal(def.opts.id, "completed")
				.catch((e) => forward(rt, e, "complete.coord"));
		}
	}

	async function safeRender(step: {
		id: string;
		config: StepConfig<unknown, string>;
	}) {
		try {
			const out = await renderStep(
				def,
				ctx,
				step,
				local.runId ?? "",
				local.data ?? {},
			);
			if (out.messageId !== undefined) {
				local.messageId = out.messageId;
				await sync();
			}
		} catch (e) {
			forward(rt, e, "render");
		}
	}

	const ff = (label: string, fn: () => Promise<unknown>) =>
		fireAndForget(rt, label, fn);

	const control: FlowControl = {
		get status() {
			return (local.status ?? "null") as FlowStatus;
		},
		get isActive() {
			return local.status === "active";
		},
		get isDismissed() {
			return local.status === "dismissed";
		},
		get currentStep() {
			return (local.stepId ?? null) as string | null;
		},
		get data() {
			local.data ??= {};
			return local.data;
		},

		start: (opts) => ff("start", () => startImpl(opts)) as Promise<StartResult>,
		next: (opts) => ff("next", () => nextImpl(opts)) as Promise<NextResult>,
		goto: (id) => ff("goto", () => gotoImpl(id)) as Promise<void>,
		skip: () => ff("skip", () => skipImpl()) as Promise<void>,
		exit: () => ff("exit", () => exitImpl("user")) as Promise<void>,
		dismiss: () => ff("dismiss", () => dismissImpl()) as Promise<void>,
		undismiss: () => ff("undismiss", () => undismissImpl()) as Promise<void>,
		complete: () => ff("complete", () => completeImpl()) as Promise<void>,
	};

	// Expose internal accessors used by the callback handler & namespace builder.
	Object.defineProperty(control, "~", {
		enumerable: false,
		value: {
			get local() {
				return local;
			},
			set local(v: OnboardingRecord) {
				local = v;
			},
			get globalLocal() {
				return globalLocal;
			},
			set globalLocal(v: OnboardingRecord) {
				globalLocal = v;
			},
			renderStep: safeRender,
			startImpl,
			nextImpl,
			gotoImpl,
			skipImpl,
			exitImpl,
			dismissImpl,
			undismissImpl,
			completeImpl,
			pauseImpl,
			sync,
		},
	});

	return control;
}

export function getInternals(control: FlowControl) {
	return (control as unknown as { "~": Internals })["~"];
}

interface Internals {
	local: OnboardingRecord;
	globalLocal: OnboardingRecord;
	renderStep: (step: {
		id: string;
		config: StepConfig<unknown, string>;
	}) => Promise<void>;
	startImpl: (opts?: {
		from?: string;
		force?: boolean;
	}) => Promise<StartResult>;
	nextImpl: (opts?: { from?: string }) => Promise<NextResult>;
	gotoImpl: (id: string) => Promise<void>;
	skipImpl: () => Promise<void>;
	exitImpl: (reason?: ExitReason) => Promise<void>;
	dismissImpl: () => Promise<void>;
	undismissImpl: () => Promise<void>;
	completeImpl: () => Promise<void>;
	pauseImpl: () => Promise<void>;
	sync: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step lifecycle hook helper
// ─────────────────────────────────────────────────────────────────────────────

async function runStepHooks(
	def: FlowDefinition,
	ctx: AnyCtx,
	from: string | null,
	to: string,
	_reason: LeaveReason,
): Promise<void> {
	if (def.hooks.onStepChange) {
		await def.hooks.onStepChange(ctx, { from, to });
	}
	const target = def.steps.find((s) => s.id === to);
	if (target?.config.onEnter) {
		await target.config.onEnter(ctx);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fire-and-forget wrapper — no ctx.onboarding.* call ever rejects
// ─────────────────────────────────────────────────────────────────────────────

export function fireAndForget<T>(
	rt: FlowRuntime,
	op: string,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	if (rt.def.opts.errors === "throw") return fn();
	return fn().catch((err) => {
		forward(rt, err, op);
		return undefined;
	});
}

function forward(rt: FlowRuntime, err: unknown, op: string) {
	const handler = rt.bot?.errorHandler;
	if (handler) {
		try {
			handler(err, { source: "onboarding", flowId: rt.def.opts.id, op });
			return;
		} catch {
			// ignore errors-in-error-handler
		}
	}
	if (typeof console !== "undefined" && typeof console.error === "function") {
		console.error(`[@gramio/onboarding][${rt.def.opts.id}] ${op}:`, err);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback handler — processes onb:* tokens
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCallback(
	rt: FlowRuntime,
	ctx: AnyCtx,
	control: FlowControl,
	token: DecodedToken,
): Promise<boolean> {
	if (token.flowId !== rt.def.opts.id) return false;

	const internals = getInternals(control);
	const local = internals.local;

	// Stale runId — record was force-restarted since this callback was emitted.
	if (local.runId && token.runId && local.runId !== token.runId) {
		await answerCallback(ctx, "Already moving on");
		return true;
	}

	// Stale stepId — user double-clicked or hit a Next from a previous step.
	const opNeedsStepMatch: Record<Op, boolean> = {
		next: true,
		skip: true,
		goto: true,
		exit: false,
		dismiss: false,
		exitAll: false,
	};
	if (opNeedsStepMatch[token.op] && local.stepId !== token.stepId) {
		await answerCallback(ctx, "Already moving on");
		return true;
	}

	switch (token.op) {
		case "next":
			await internals.nextImpl();
			break;
		case "skip":
			await internals.skipImpl();
			break;
		case "goto":
			if (token.target) await internals.gotoImpl(token.target);
			break;
		case "exit":
			await internals.exitImpl();
			break;
		case "dismiss":
			await internals.dismissImpl();
			break;
		case "exitAll":
			// Handled at the namespace level — dismiss + disableAll.
			await internals.dismissImpl();
			break;
	}

	await answerCallback(ctx);
	return true;
}

async function answerCallback(ctx: AnyCtx, text?: string): Promise<void> {
	const c = ctx as {
		answerCallbackQuery?: (params?: { text?: string }) => Promise<unknown>;
		answer?: (params?: { text?: string }) => Promise<unknown>;
	};
	const fn = c.answerCallbackQuery ?? c.answer;
	if (!fn) return;
	try {
		await fn(text ? { text } : undefined);
	} catch {
		// already answered
	}
}
