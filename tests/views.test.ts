import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import type { TelegramInlineKeyboardMarkup } from "@gramio/types";
import { initViewsBuilder } from "@gramio/views";
import { Bot, InlineKeyboard } from "gramio";
import {
	createOnboarding,
	memoryStorage,
	type OnboardingViewCtx,
	withOnboardingGlobals,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (kept local to avoid touching the Phase 1 test file)
// ─────────────────────────────────────────────────────────────────────────────

const flatButtons = (rm: unknown) =>
	(JSON.parse(JSON.stringify(rm)) as TelegramInlineKeyboardMarkup)
		.inline_keyboard.flat();

interface ViewGlobals {
	greeting: string;
	onboarding: OnboardingViewCtx | undefined;
}

const buildBot = () => {
	const defineView = initViewsBuilder<ViewGlobals>();

	const welcomeView = defineView().render(function () {
		const tokens = this.onboarding;
		const kb = new InlineKeyboard();
		if (tokens?.next) kb.text("Continue", tokens.next);
		if (tokens?.exit) kb.row().text("Skip tour", tokens.exit);
		return this.response
			.text(`${this.greeting}, ${tokens?.stepId ?? "?"}!`)
			.keyboard(kb);
	});

	const storage = memoryStorage();
	const welcome = createOnboarding({ id: "welcome", storage })
		.step("hi", { view: welcomeView })
		.step("done", { text: "All set!" })
		.onComplete((ctx) => ctx.send("welcome aboard"))
		.build();

	const bot = new Bot("test_token")
		.extend(welcome)
		.derive(["message", "callback_query"], (ctx) => ({
			render: defineView.buildRender(
				ctx,
				withOnboardingGlobals({ greeting: "Hi" }),
			),
		}));

	bot.command("start", (ctx) =>
		(ctx as unknown as { onboarding: { welcome: { start(): Promise<unknown> } } })
			.onboarding.welcome.start(),
	);

	return { bot, storage };
};

describe("@gramio/onboarding — Phase 2 views integration", () => {
	it("renders a step via @gramio/views with `this.onboarding` injected", async () => {
		const { bot } = buildBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");

		const sent = env.lastApiCall("sendMessage");
		expect(sent).toBeDefined();
		expect((sent!.params as { text?: string }).text).toBe("Hi, hi!");

		const buttons = flatButtons((sent!.params as { reply_markup: unknown }).reply_markup);
		expect(buttons.map((b) => b.text)).toEqual(["Continue", "Skip tour"]);
		// Tokens must respect the 64-byte cap.
		for (const btn of buttons) {
			expect(btn.callback_data?.length ?? 0).toBeLessThanOrEqual(64);
		}
	});

	it("`this.onboarding` is undefined outside an onboarding-driven render", async () => {
		const defineView = initViewsBuilder<ViewGlobals>();
		const probeView = defineView().render(function () {
			const seen = this.onboarding === undefined ? "absent" : "present";
			return this.response.text(`tokens:${seen}`);
		});

		const bot = new Bot("test_token").derive(
			["message", "callback_query"],
			(ctx) => ({
				render: defineView.buildRender(
					ctx,
					withOnboardingGlobals({ greeting: "Hi" }),
				),
			}),
		);

		bot.command("probe", async (ctx) => {
			await (ctx as unknown as {
				render: (v: typeof probeView) => Promise<unknown>;
			}).render(probeView);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("probe");

		const sent = env.lastApiCall("sendMessage");
		expect((sent!.params as { text?: string }).text).toBe("tokens:absent");
	});

	it("falls back to inline render when ctx.render is missing", async () => {
		// View object is set, but no @gramio/views derive — `shouldRenderViaViews`
		// returns false, so the inline renderer takes over and produces "View!".
		const storage = memoryStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", {
				text: "fallback text",
				view: {} as never,
				buttons: ["next", "exit"],
			})
			.step("done", { text: "All set!" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(ctx as unknown as { onboarding: { welcome: { start(): Promise<unknown> } } })
				.onboarding.welcome.start(),
		);

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("start");

		const sent = env.lastApiCall("sendMessage");
		expect((sent!.params as { text?: string }).text).toBe("fallback text");
	});
});
