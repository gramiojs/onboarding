import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import type { TelegramInlineKeyboardMarkup } from "@gramio/types";
import { Bot } from "gramio";
import {
	createOnboarding,
	memoryStorage,
	type OnboardingNamespace,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const flatButtons = (rm: unknown) =>
	(rm as TelegramInlineKeyboardMarkup).inline_keyboard.flat();

/**
 * Pin the bot bubble whose `sendMessage` had `text`. Returns a live
 * `MessageObject` tracked by `env.botMessage(...)` — its `reply_markup`
 * auto-updates on `editMessageText` / `editMessageReplyMarkup`, so the
 * returned reference can be re-clicked after edits without refresh.
 *
 * We need this (vs. plain `env.lastBotMessage()`) because the `/start`
 * handler sends a trailing confirmation message AFTER `onboarding.start()`,
 * making "last" the wrong bubble.
 */
const bubbleByText = (env: TelegramTestEnvironment, text: string) => {
	for (let i = env.apiCalls.length - 1; i >= 0; i--) {
		const call = env.apiCalls[i]!;
		if (call.method !== "sendMessage") continue;
		if ((call.params as { text?: string }).text !== text) continue;
		const chatId = (call.params as { chat_id: number }).chat_id;
		const messageId = (call.response as { message_id?: number } | undefined)
			?.message_id;
		if (messageId === undefined) continue;
		const msg = env.botMessage(chatId, messageId);
		if (msg) return msg;
	}
	throw new Error(`No bot bubble with text "${text}" recorded`);
};

const lastSentText = (env: TelegramTestEnvironment): string | undefined => {
	for (let i = env.apiCalls.length - 1; i >= 0; i--) {
		const call = env.apiCalls[i]!;
		if (call.method === "sendMessage" || call.method === "editMessageText") {
			return (call.params as { text?: string }).text;
		}
	}
	return undefined;
};

const buildBasicBot = () => {
	const storage = memoryStorage();
	const welcome = createOnboarding({ id: "welcome", storage })
		.step("hi", { text: "Hi! Press next to continue.", buttons: ["next", "exit"] })
		.step("links", { text: "Send any link!", buttons: ["next", "dismiss"] })
		.step("done", { text: "All set!" })
		.onComplete((ctx) => ctx.send("welcome aboard"))
		.onExit((ctx, { reason }) => ctx.send(`paused: ${reason}`))
		.onDismiss((ctx) => ctx.send("ok, won't show again"))
		.build();

	const bot = new Bot("test_token").extend(welcome);

	bot.command("start", async (ctx) => {
		await (ctx as any).onboarding.welcome.start();
		return ctx.send("Let's start!");
	});
	bot.command("welcome_tour", async (ctx) =>
		(ctx as any).onboarding.welcome.start({ force: true }),
	);
	bot.command("disable_all", async (ctx) =>
		(ctx as any).onboarding.disableAll(),
	);

	return { bot, storage };
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("@gramio/onboarding — Phase 1 inline flow", () => {
	it("start() sends the first step's text + Next/Exit buttons", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");

		const sent = env.apiCalls.filter((c) => c.method === "sendMessage");
		const onboardingSend = sent.find(
			(c) =>
				(c.params as { text?: string }).text ===
				"Hi! Press next to continue.",
		);
		expect(onboardingSend).toBeDefined();
		const buttons = flatButtons(
			(onboardingSend!.params as { reply_markup: unknown }).reply_markup,
		);
		expect(buttons.map((b) => b.text)).toEqual(["Next", "Exit"]);
		// All token data must respect the 64-byte Telegram cap.
		for (const btn of buttons) {
			expect(btn.callback_data?.length ?? 0).toBeLessThanOrEqual(64);
		}
	});

	it("clicking Next advances to the second step (edits the bubble)", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		await user.on(bubble).clickByText("Next");

		expect(lastSentText(env)).toBe("Send any link!");
	});

	it("walks through all 3 steps and fires onComplete", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		await user.on(bubble).clickByText("Next");
		// Same bubble, mutated in place by the proxy after editMessageText.
		await user.on(bubble).clickByText("Next");

		const allTexts = env.apiCalls
			.filter(
				(c) => c.method === "sendMessage" || c.method === "editMessageText",
			)
			.map((c) => (c.params as { text?: string }).text);
		expect(allTexts).toContain("All set!");
		expect(allTexts).toContain("welcome aboard");
	});

	it("exit button fires onExit and sets status to 'paused'", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		await user.on(bubble).clickByText("Exit");

		const sent = env.apiCalls
			.filter((c) => c.method === "sendMessage")
			.map((c) => (c.params as { text?: string }).text);
		expect(sent).toContain("paused: user");
	});

	it("dismiss button blocks subsequent /start (without force)", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		await user.on(bubble).clickByText("Next"); // → "Send any link!"
		await user.on(bubble).clickByText("Don't show again");

		env.clearApiCalls();
		await user.sendCommand("start");

		const sent = env.apiCalls
			.filter((c) => c.method === "sendMessage")
			.map((c) => (c.params as { text?: string }).text);
		// "Let's start!" still fires (it's just a regular reply), but no onboarding bubble.
		expect(sent).toContain("Let's start!");
		expect(sent).not.toContain("Hi! Press next to continue.");
	});

	it("dismiss survives force: true", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		await user.on(bubble).clickByText("Next");
		await user.on(bubble).clickByText("Don't show again");

		env.clearApiCalls();
		await user.sendCommand("welcome_tour"); // calls start({ force: true })

		const sent = env.apiCalls
			.filter((c) => c.method === "sendMessage")
			.map((c) => (c.params as { text?: string }).text);
		expect(sent).not.toContain("Hi! Press next to continue.");
	});

	it("disableAll() blocks all subsequent start()", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("disable_all");
		env.clearApiCalls();

		await user.sendCommand("start");
		const sent = env.apiCalls
			.filter((c) => c.method === "sendMessage")
			.map((c) => (c.params as { text?: string }).text);
		expect(sent).toContain("Let's start!");
		expect(sent).not.toContain("Hi! Press next to continue.");
	});

	it("stale callback (replayed step-1 token) is a no-op after advancing", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleByText(env, "Hi! Press next to continue.");
		// Snapshot step-1's "Next" callback_data BEFORE we advance — once we
		// click, the bubble auto-syncs to step-2's keyboard and the original
		// token is gone from the live keyboard. This simulates a user clicking
		// a button whose callback data was minted for the previous step (e.g.
		// double-tap before Telegram delivered the edit, or a cached client).
		const staleNext = flatButtons(bubble.payload.reply_markup).find(
			(b) => b.text === "Next",
		)!.callback_data!;

		await user.on(bubble).clickByText("Next");
		await user.click(staleNext, bubble).catch(() => undefined);

		const distinct = new Set(
			env.apiCalls
				.filter(
					(c) =>
						c.method === "sendMessage" || c.method === "editMessageText",
				)
				.map((c) => (c.params as { text?: string }).text),
		);
		// We should NOT have advanced past "Send any link!".
		expect(distinct.has("All set!")).toBe(false);
	});

	it("onMissingStep fallback resolves a renamed step", async () => {
		const storage = memoryStorage();
		const userId = 99;
		await storage.set(`flow:welcome:${userId}`, {
			kind: "flow",
			flowId: "welcome",
			status: "active",
			stepId: "links",
			runId: "abcdef",
			data: {},
		});

		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "hi", buttons: ["next"] })
			.step("attachments", { text: "step renamed!", buttons: ["next"] })
			.step("done", { text: "done!" })
			.onMissingStep((_ctx, { oldStepId }) =>
				oldStepId === "links" ? "attachments" : "complete",
			)
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("ping", async (ctx) => {
			await (ctx as any).onboarding.welcome.next();
			return ctx.send("pong");
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser({ id: userId });
		await user.sendCommand("ping");

		const sent = env.apiCalls
			.filter(
				(c) => c.method === "sendMessage" || c.method === "editMessageText",
			)
			.map((c) => (c.params as { text?: string }).text);
		// `next()` from a renamed step should advance past "attachments" to "done!".
		expect(sent).toContain("done!");
	});
});

describe("@gramio/onboarding — namespace surface", () => {
	it("ctx.onboarding exposes status sync getters", async () => {
		const { bot } = buildBasicBot();

		let observed: string | undefined;
		bot.command("status", (ctx) => {
			const ns = (ctx as unknown as { onboarding: OnboardingNamespace }).onboarding;
			const flow = ns.flow("welcome");
			observed = flow?.status;
			return ctx.send(`status:${observed}`);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("status");
		expect(observed).toBe("null");

		await user.sendCommand("start");
		await user.sendCommand("status");
		expect(observed).toBe("active");
	});

	it("ctx.onboarding.list contains registered flow ids", async () => {
		const a = createOnboarding({ id: "alpha" })
			.step("only", { text: "alpha-1" })
			.build();
		const b = createOnboarding({ id: "beta" })
			.step("only", { text: "beta-1" })
			.build();

		let captured: string[] = [];
		const bot = new Bot("test_token")
			.extend(a)
			.extend(b)
			.command("inspect", (ctx) => {
				captured = [
					...(ctx as unknown as { onboarding: OnboardingNamespace }).onboarding.list,
				];
				return ctx.send("ok");
			});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("inspect");

		expect(captured.sort()).toEqual(["alpha", "beta"]);
	});
});
