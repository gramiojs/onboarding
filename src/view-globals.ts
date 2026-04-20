import { AsyncLocalStorage } from "node:async_hooks";
import type { OnboardingViewCtx } from "./types.js";

/**
 * Phase 2 — view integration.
 *
 * The runner stashes the per-render `OnboardingViewCtx` in an
 * AsyncLocalStorage so views rendered from inside an onboarding step can read
 * it. Exposure to views happens via `withOnboardingGlobals(globals)` — which
 * returns a *thunk*, leveraging `@gramio/views`' lazy-globals support
 * (`buildRender` accepts `Globals | (() => Globals)` since v0.2). The thunk
 * is invoked once per render, inside the runner's `runWithOnboardingTokens`
 * scope, so `onboarding` is always the live token bundle for the current
 * step (or `undefined` outside an onboarding-driven render).
 *
 * @example
 * ```ts
 * import { initViewsBuilder } from "@gramio/views";
 * import { withOnboardingGlobals, type OnboardingViewCtx } from "@gramio/onboarding";
 *
 * interface Globals {
 *   user: User;
 *   onboarding: OnboardingViewCtx | undefined;
 * }
 *
 * const defineView = initViewsBuilder<Globals>();
 *
 * bot.derive(["message", "callback_query"], (ctx) => ({
 *   render: defineView.buildRender(
 *     ctx,
 *     withOnboardingGlobals({
 *       user: { id: ctx.from!.id, name: ctx.from!.firstName },
 *     }),
 *   ),
 * }));
 * ```
 */
const tokens = new AsyncLocalStorage<OnboardingViewCtx>();

export function runWithOnboardingTokens<T>(
	value: OnboardingViewCtx,
	fn: () => Promise<T> | T,
): Promise<T> | T {
	return tokens.run(value, fn);
}

export function getCurrentOnboardingTokens(): OnboardingViewCtx | undefined {
	return tokens.getStore();
}

/**
 * Wrap your view globals so `this.onboarding` is the live token bundle
 * for the current onboarding step inside any view rendered from a hook.
 * Outside an onboarding-driven render it resolves to `undefined`.
 *
 * Returns a thunk consumed by `defineView.buildRender(ctx, thunk)` — re-run
 * on every render, so middleware that mutated state between `.derive()` and
 * `ctx.render()` is reflected.
 */
export function withOnboardingGlobals<T extends object>(
	globals: T,
): () => T & { onboarding: OnboardingViewCtx | undefined } {
	return () => ({
		...globals,
		onboarding: getCurrentOnboardingTokens(),
	});
}
