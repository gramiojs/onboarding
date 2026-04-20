import type { AnyCtx, OnboardingViewCtx, StepConfig } from "../types.js";
import { runWithOnboardingTokens } from "../view-globals.js";

/**
 * Render via @gramio/views. We never reach into views' internals — just call
 * the user-installed `ctx.render(view, args)`. The runner pushes the current
 * `OnboardingViewCtx` onto an AsyncLocalStorage so `withOnboardingGlobals()`
 * (spread into the user's globals) resolves to a real value while the view's
 * render function runs.
 */
export async function renderView(
	ctx: AnyCtx,
	step: StepConfig<unknown, string>,
	tokens: OnboardingViewCtx,
): Promise<void> {
	const render = (ctx as { render?: unknown }).render as
		| ((view: unknown, ...args: unknown[]) => Promise<unknown>)
		| undefined;
	if (!render) {
		throw new Error(
			"@gramio/onboarding: step.view is set but ctx.render is not present. Did you forget to register @gramio/views?",
		);
	}

	const view = resolveView(step, ctx);
	const args = resolveArgs(step.args, ctx);

	await runWithOnboardingTokens(tokens, () => render(view, ...args));
}

function resolveView(
	step: StepConfig<unknown, string>,
	ctx: AnyCtx,
): unknown {
	if (typeof step.view === "function") {
		return (step.view as (ctx: AnyCtx) => unknown)(ctx);
	}
	return step.view;
}

function resolveArgs(
	args: StepConfig<unknown, string>["args"],
	ctx: AnyCtx,
): unknown[] {
	if (args === undefined) return [];
	if (typeof args === "function") {
		const resolved = (args as (ctx: AnyCtx) => unknown)(ctx);
		return Array.isArray(resolved) ? resolved : [resolved];
	}
	return Array.isArray(args) ? args : [args];
}

/**
 * Capability detection. The view path runs only when both the step asks for a
 * view AND the user has registered @gramio/views (so `ctx.render` is present).
 */
export function shouldRenderViaViews(
	ctx: AnyCtx,
	step: StepConfig<unknown, string>,
): boolean {
	return Boolean(step.view) && typeof (ctx as { render?: unknown }).render === "function";
}
