import type { Storage } from "@gramio/storage";
import type { BotLike, Context, ContextType, MaybePromise } from "gramio";

// ─────────────────────────────────────────────────────────────────────────────
// Context aliases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A context whose type lives between message-shaped and callback-shaped — the
 * two events onboarding hooks ever fire from. We narrow to this union so
 * `ctx.send`, `ctx.from`, `ctx.chatId` etc. resolve to real getters inside hook
 * handlers.
 *
 * NOTE: we intentionally do NOT add a `[key: string]: unknown` index signature
 * here. That would seem convenient (`ctx.onboarding` "just works"), but it
 * widens every real getter to `unknown` via the intersection, and handlers
 * can't even call `ctx.send` without casting. Plugin-injected properties
 * belong on the user side via TS module augmentation of `ContextType`.
 */
export type AnyCtx =
	| ContextType<BotLike, "message">
	| ContextType<BotLike, "callback_query">;

export type CallbackCtx = ContextType<BotLike, "callback_query">;

// ─────────────────────────────────────────────────────────────────────────────
// Status machine
// ─────────────────────────────────────────────────────────────────────────────

export type FlowStatus =
	| "null"
	| "active"
	| "exited"
	| "completed"
	| "dismissed"
	| "paused";

export type ExitReason = "user" | "timeout" | "preempt" | "exitAll";
export type LeaveReason =
	| "next"
	| "skip"
	| "goto"
	| "exit"
	| "dismiss"
	| "complete";

export type StartResult =
	| "started"
	| "resumed"
	| "already-active"
	| "already-completed"
	| "dismissed"
	| "opted-out"
	| "queued"
	| "preempted";

export type NextResult =
	| "advanced"
	| "completed"
	| "inactive"
	| "step-mismatch";

// ─────────────────────────────────────────────────────────────────────────────
// Storage contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisted record for a flow run, OR for the per-user global opt-out.
 * Two `kind`s share a single Storage interface so all keys live together.
 */
export interface OnboardingRecord {
	kind: "flow" | "global";

	/** kind === "flow": which flow this record represents */
	flowId?: string;
	/** kind === "flow": short random id minted on each `start()`; protects against stale callbacks after force-restart */
	runId?: string;
	status?: FlowStatus;
	stepId?: string;
	/** A step that wants to render but the current scope (DM/group) is wrong — render when an eligible update arrives */
	pendingStepId?: string;
	chatId?: number;
	messageId?: number;
	data?: Record<string, unknown>;
	startedAt?: number;
	updatedAt?: number;

	/** kind === "global": persistent opt-out flag */
	disabled?: boolean;
	/** kind === "global": pending starts when concurrency = "queue" (Phase 4) */
	queue?: { flowId: string; from?: string }[];
	/** kind === "global": LIFO stack of flows paused by a preempt (Phase 4) */
	preemptStack?: { flowId: string }[];
}

/** Map of all keys we write to the underlying Storage. */
export type OnboardingStorageMap = Record<
	`flow:${string}:${string}` | `global:${string}`,
	OnboardingRecord
>;

export type OnboardingStorage = Storage<OnboardingStorageMap>;

// ─────────────────────────────────────────────────────────────────────────────
// Step config
// ─────────────────────────────────────────────────────────────────────────────

export type ButtonKind = "next" | "skip" | "exit" | "dismiss";

export interface ScopeControls {
	next?: boolean;
	skip?: boolean;
	exit?: boolean;
	dismiss?: boolean;
}

export interface ControlsConfig {
	dm?: ScopeControls;
	group?: ScopeControls;
}

export interface MediaSpec {
	type: "photo" | "video" | "animation" | "document" | "audio";
	media: string;
}

export type StepContent<Data, _Steps extends string> = {
	/** Render via @gramio/views (Phase 2). Detects `ctx.render` at runtime. */
	view?: unknown | ((ctx: AnyCtx) => unknown);
	args?: unknown | ((ctx: AnyCtx) => unknown);
	/** Inline shortcut when no views plugin is attached. */
	text?: string | ((ctx: AnyCtx) => string);
	media?: MediaSpec | ((ctx: AnyCtx) => MediaSpec);
	/** ignored when `view` is set (the view owns the keyboard) */
	buttons?: ButtonKind[];
	/** Reserved for future typing — not yet used at runtime. */
	__data?: Data;
};

export interface StepHooks<Steps extends string> {
	advanceOn?: (ctx: AnyCtx) => MaybePromise<boolean>;
	passthrough?: boolean;
	skipWhen?: (ctx: AnyCtx) => MaybePromise<boolean>;
	renderIn?: "dm" | "group" | "any" | ((ctx: AnyCtx) => boolean);
	chat?: "same" | "await" | ((ctx: AnyCtx) => number);
	controls?: ControlsConfig;
	onEnter?: (ctx: AnyCtx) => MaybePromise<unknown>;
	onLeave?: (
		ctx: AnyCtx,
		meta: { to: Steps | null; reason: LeaveReason },
	) => MaybePromise<unknown>;
}

export type StepConfig<Data, Steps extends string> = StepContent<Data, Steps> &
	StepHooks<Steps>;

// ─────────────────────────────────────────────────────────────────────────────
// View-injected onboarding ctx (this.onboarding inside a view)
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingViewCtx<Steps extends string = string> {
	flowId: string;
	stepId: Steps;
	data: Record<string, unknown>;

	/** `undefined` when the current scope (DM/group) disallows this control. */
	next: string | undefined;
	skip: string | undefined;
	/** `exit` is always defined — it's the universal escape hatch. */
	exit: string;
	dismiss: string | undefined;
	/** `exitAll` is always defined — the nuclear option. */
	exitAll: string;

	goto(id: Steps): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime — ctx.onboarding namespace
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowControl<Steps extends string = string> {
	readonly status: FlowStatus;
	readonly isActive: boolean;
	readonly isDismissed: boolean;
	readonly currentStep: Steps | null;
	readonly data: Record<string, unknown>;

	start(opts?: {
		from?: Steps;
		force?: boolean;
	}): Promise<StartResult>;
	next(opts?: { from?: Steps }): Promise<NextResult>;
	goto(id: Steps): Promise<void>;
	skip(): Promise<void>;
	exit(): Promise<void>;
	dismiss(): Promise<void>;
	undismiss(): Promise<void>;
	complete(): Promise<void>;
}

export interface OnboardingNamespace {
	readonly active: { id: string; step: string } | null;
	readonly list: string[];
	readonly allDisabled: boolean;

	disableAll(): Promise<void>;
	enableAll(): Promise<void>;
	exitAll(): Promise<void>;

	flow(id: string): FlowControl | undefined;

	/** Dynamic indexed access — typed via TS module augmentation. */
	[flowId: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder/plugin options
// ─────────────────────────────────────────────────────────────────────────────

export type ScopeResolver = "user" | "chat" | ((ctx: AnyCtx) => string);
export type ConcurrencyMode = "queue" | "preempt" | "parallel";
export type ErrorMode = "forward-to-bot" | "throw";

export interface CreateOnboardingOpts {
	id: string;
	storage?: OnboardingStorage;
	concurrency?: ConcurrencyMode;
	timeoutMs?: number;
	resumeOnStart?: boolean;
	scope?: ScopeResolver;
	controls?: ControlsConfig;
	errors?: ErrorMode;
}

export type Scope = "dm" | "group";
