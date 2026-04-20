import { describe, expect, it } from "bun:test";
import { MessageObject, TelegramTestEnvironment } from "@gramio/test";
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

const asInlineMarkup = (rm: unknown): TelegramInlineKeyboardMarkup =>
	JSON.parse(JSON.stringify(rm)) as TelegramInlineKeyboardMarkup;

const flatButtons = (rm: unknown) => asInlineMarkup(rm).inline_keyboard.flat();

const lastSentText = (env: TelegramTestEnvironment): string | undefined => {
	for (let i = env.apiCalls.length - 1; i >= 0; i--) {
		const call = env.apiCalls[i]!;
		if (call.method === "sendMessage" || call.method === "editMessageText") {
			return (call.params as { text?: string }).text;
		}
	}
	return undefined;
};

/**
 * Build a MessageObject mirror of the bot's last `sendMessage` reply matching
 * `text`, so `user.on(msg).clickByText(...)` and edit-callback tracking work.
 */
const bubbleFromLastSend = (
	env: TelegramTestEnvironment,
	text: string,
	chatId: number,
): MessageObject => {
	const sends = env.apiCalls.filter(
		(c) =>
			c.method === "sendMessage" &&
			(c.params as { text?: string }).text === text,
	);
	const last = sends[sends.length - 1];
	if (!last) throw new Error(`No sendMessage with text "${text}" recorded`);
	const params = last.params as {
		text: string;
		reply_markup?: unknown;
		chat_id: number;
	};
	const response = last.response as { message_id?: number } | undefined;
	return new MessageObject({
		message_id: response?.message_id ?? 1,
		date: Math.floor(Date.now() / 1e3),
		chat: { id: chatId, type: "private", first_name: "Test" },
		from: { id: 1, is_bot: true, first_name: "Bot" },
		text: params.text,
		// `InlineKeyboard` only exposes `inline_keyboard` via its `toJSON()`.
		// Roundtrip so `clickByText`'s `"inline_keyboard" in markup` check passes.
		reply_markup: params.reply_markup
			? (JSON.parse(JSON.stringify(params.reply_markup)) as never)
			: undefined,
	});
};

const refreshBubbleFromLastEdit = (
	env: TelegramTestEnvironment,
	bubble: MessageObject,
): void => {
	for (let i = env.apiCalls.length - 1; i >= 0; i--) {
		const call = env.apiCalls[i]!;
		if (call.method !== "editMessageText") continue;
		const editParams = call.params as {
			text: string;
			reply_markup?: unknown;
		};
		bubble.payload.text = editParams.text;
		bubble.payload.reply_markup = editParams.reply_markup
			? (JSON.parse(JSON.stringify(editParams.reply_markup)) as never)
			: undefined;
		return;
	}
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
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
		await user.on(bubble).clickByText("Next");

		expect(lastSentText(env)).toBe("Send any link!");
	});

	it("walks through all 3 steps and fires onComplete", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
		await user.on(bubble).clickByText("Next");

		// After edit, the same bubble is re-used by the runner. Refresh its
		// reply_markup from the latest editMessageText call.
		refreshBubbleFromLastEdit(env, bubble);
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
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
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
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
		await user.on(bubble).clickByText("Next"); // → "Send any link!"

		refreshBubbleFromLastEdit(env, bubble);
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
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
		await user.on(bubble).clickByText("Next");

		// Refresh + click "Don't show again" on step 2.
		refreshBubbleFromLastEdit(env, bubble);
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

	it("double-click on Next is idempotent (stale stepId is no-op)", async () => {
		const { bot } = buildBasicBot();
		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		const bubble = bubbleFromLastSend(
			env,
			"Hi! Press next to continue.",
			user.payload.id,
		);
		await user.on(bubble).clickByText("Next");

		// Re-click with the *stale* keyboard (still pointing at step "hi"). The
		// runner should silently no-op because the token's stepId no longer
		// matches the stored one.
		await user.on(bubble).clickByText("Next").catch(() => undefined);

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
