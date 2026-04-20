import type { Plugin } from "gramio";
import { createOnboardingPlugin } from "./plugin.js";
import type {
	AnyCtx,
	CreateOnboardingOpts,
	ExitReason,
	StepConfig,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Internal flow definition (consumed by createPlugin)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowDefinition {
	opts: Required<
		Pick<CreateOnboardingOpts, "id" | "concurrency" | "errors" | "scope">
	> &
		Omit<CreateOnboardingOpts, "id" | "concurrency" | "errors" | "scope">;
	steps: { id: string; config: StepConfig<any, string> }[];
	hooks: FlowHooks;
}

export interface FlowHooks {
	onComplete?: (
		ctx: AnyCtx,
		meta: { data: Record<string, unknown> },
	) => unknown;
	onExit?: (
		ctx: AnyCtx,
		meta: { at: string; reason: ExitReason },
	) => unknown;
	onDismiss?: (ctx: AnyCtx, meta: { at: string }) => unknown;
	onStepChange?: (
		ctx: AnyCtx,
		meta: { from: string | null; to: string },
	) => unknown;
	onMissingStep?: (
		ctx: AnyCtx,
		meta: { oldStepId: string; availableSteps: string[] },
	) => string | "complete" | "exit";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public builder type
// ─────────────────────────────────────────────────────────────────────────────

export interface OnboardingBuilder<Data, Steps extends string> {
	step<Id extends string>(
		id: Id,
		config: StepConfig<Data, Steps | Id>,
	): OnboardingBuilder<Data, Steps | Id>;

	onComplete(
		handler: (
			ctx: AnyCtx,
			meta: { data: Record<string, unknown> },
		) => unknown,
	): OnboardingBuilder<Data, Steps>;

	onExit(
		handler: (
			ctx: AnyCtx,
			meta: { at: Steps; reason: ExitReason },
		) => unknown,
	): OnboardingBuilder<Data, Steps>;

	onDismiss(
		handler: (ctx: AnyCtx, meta: { at: Steps }) => unknown,
	): OnboardingBuilder<Data, Steps>;

	onStepChange(
		handler: (
			ctx: AnyCtx,
			meta: { from: Steps | null; to: Steps },
		) => unknown,
	): OnboardingBuilder<Data, Steps>;

	onMissingStep(
		handler: (
			ctx: AnyCtx,
			meta: { oldStepId: string; availableSteps: Steps[] },
		) => Steps | "complete" | "exit",
	): OnboardingBuilder<Data, Steps>;

	/** Build the GramIO Plugin. Pass to `bot.extend(...)`. */
	build(): Plugin;

	/** @internal — snapshot the definition (for tests / introspection). */
	"~build"(): FlowDefinition;
}

// ─────────────────────────────────────────────────────────────────────────────
// createOnboarding — public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an onboarding flow definition. Call `.build()` (re-exported by the
 * `plugin` module as `(builder).build()`) to produce a GramIO Plugin you
 * can pass to `bot.extend(...)`.
 *
 * @example
 * ```ts
 * const welcome = createOnboarding({ id: "welcome" })
 *   .step("hi",   { text: "Hi!", buttons: ["next"] })
 *   .step("done", { text: "Done!" })
 *   .build();
 *
 * bot.extend(welcome);
 * ```
 */
export function createOnboarding<Data extends object = {}>(
	opts: CreateOnboardingOpts,
): OnboardingBuilder<Data, never> {
	if (!opts.id) {
		throw new Error("@gramio/onboarding: `id` is required");
	}

	const def: FlowDefinition = {
		opts: {
			id: opts.id,
			storage: opts.storage,
			concurrency: opts.concurrency ?? "queue",
			timeoutMs: opts.timeoutMs,
			resumeOnStart: opts.resumeOnStart ?? true,
			scope: opts.scope ?? "user",
			controls: opts.controls,
			errors: opts.errors ?? "forward-to-bot",
		},
		steps: [],
		hooks: {},
	};

	const builder: OnboardingBuilder<Data, never> = {
		step(id, config) {
			if (def.steps.some((s) => s.id === id)) {
				throw new Error(
					`@gramio/onboarding[${def.opts.id}]: duplicate step id "${id}"`,
				);
			}
			def.steps.push({ id, config: config as StepConfig<any, string> });
			return builder as unknown as OnboardingBuilder<Data, never>;
		},
		onComplete(handler) {
			def.hooks.onComplete = handler as FlowHooks["onComplete"];
			return builder;
		},
		onExit(handler) {
			def.hooks.onExit = handler as FlowHooks["onExit"];
			return builder;
		},
		onDismiss(handler) {
			def.hooks.onDismiss = handler as FlowHooks["onDismiss"];
			return builder;
		},
		onStepChange(handler) {
			def.hooks.onStepChange = handler as FlowHooks["onStepChange"];
			return builder;
		},
		onMissingStep(handler) {
			def.hooks.onMissingStep = handler as FlowHooks["onMissingStep"];
			return builder;
		},
		build() {
			if (def.steps.length === 0) {
				throw new Error(
					`@gramio/onboarding[${def.opts.id}]: at least one step is required`,
				);
			}
			return createOnboardingPlugin(def);
		},
		"~build"() {
			if (def.steps.length === 0) {
				throw new Error(
					`@gramio/onboarding[${def.opts.id}]: at least one step is required`,
				);
			}
			return def;
		},
	};

	return builder;
}
