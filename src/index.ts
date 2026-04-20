/**
 * @gramio/onboarding
 *
 * Declarative user-onboarding tutorials for GramIO.
 *
 * @example
 * ```ts
 * import { Bot } from "gramio";
 * import { createOnboarding } from "@gramio/onboarding";
 *
 * const welcome = createOnboarding({ id: "welcome" })
 *   .step("hi",   { text: "Hi! I'll show you around.", buttons: ["next", "exit"] })
 *   .step("done", { text: "All set!" })
 *   .onComplete((ctx) => ctx.send("Welcome aboard!"))
 *   .build();
 *
 * const bot = new Bot(process.env.BOT_TOKEN!).extend(welcome);
 * bot.command("start", (ctx) => {
 *   ctx.onboarding.welcome.start();
 *   return ctx.send("Let's start!");
 * });
 * bot.start();
 * ```
 */

export { createOnboarding } from "./builder.js";
export type { OnboardingBuilder, FlowDefinition, FlowHooks } from "./builder.js";

export { memoryStorage } from "./storage/memory.js";

export {
	withOnboardingGlobals,
	getCurrentOnboardingTokens,
} from "./view-globals.js";

export type {
	OnboardingStorage,
	OnboardingStorageMap,
	OnboardingRecord,
	OnboardingNamespace,
	OnboardingViewCtx,
	FlowControl,
	FlowStatus,
	StepConfig,
	StepContent,
	StepHooks,
	ButtonKind,
	ScopeControls,
	ControlsConfig,
	MediaSpec,
	CreateOnboardingOpts,
	ScopeResolver,
	ConcurrencyMode,
	ErrorMode,
	ExitReason,
	LeaveReason,
	StartResult,
	NextResult,
	Scope,
} from "./types.js";
