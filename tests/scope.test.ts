import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import type { TelegramInlineKeyboardMarkup } from "@gramio/types";
import { Bot } from "gramio";
import { createOnboarding, memoryStorage } from "../src/index.js";

/**
 * Phase 5 — cross-chat scoping via `renderIn`.
 *
 * Exit criteria from the spec:
 *   A DM step "add me to your group" auto-advances when the user appears in
 *   a group; the next step renders in the group without a "Next" button.
 *
 * Mechanism:
 *   When a step has `renderIn: "group" | "dm" | fn` and the current ctx's
 *   scope doesn't match, the runner sets `pendingStepId` instead of
 *   rendering. The derive hook re-attempts the render on every inbound
 *   update whose ctx matches the step's scope.
 */

const flatButtons = (rm: unknown) =>
	(rm as TelegramInlineKeyboardMarkup).inline_keyboard.flat();

const allTexts = (env: TelegramTestEnvironment): string[] =>
	env.apiCalls
		.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
		.map((c) => (c.params as { text?: string }).text ?? "");

describe("@gramio/onboarding — Phase 5 renderIn + pending", () => {
	it("advancing to a group-only step defers render until user appears in a group", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("intro", { text: "Add me to your group!", buttons: ["next"] })
			.step("demo", { text: "Here in your group!", renderIn: "group" })
			.onComplete((ctx) => ctx.send("welcome aboard"))
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		const group = env.createChat({ type: "group", id: -1001 });

		// 1. /start in DM → step 1 renders.
		await user.sendCommand("start");
		expect(allTexts(env)).toContain("Add me to your group!");

		// 2. Click Next → moves to step 2 (renderIn: "group"), but we're in DM.
		// Nothing new should render; pendingStepId is set.
		await user
			.on(env.lastBotMessage({ withReplyMarkup: true })!)
			.clickByText("Next");
		expect(allTexts(env)).not.toContain("Here in your group!");

		// 3. User sends an unrelated message in a group chat — derive hook sees
		// the pending step is now eligible and renders it in the group.
		await user.in(group).sendMessage("hello team");

		const groupSend = env
			.filterApiCalls("sendMessage")
			.find(
				(c) =>
					(c.params as { text?: string }).text === "Here in your group!" &&
					(c.params as { chat_id: number }).chat_id === group.payload.id,
			);
		expect(groupSend).toBeDefined();

		// 4. Group default: no Next/Skip/Dismiss — only Exit remains. And since
		// the step doesn't list any `buttons`, the inline renderer sends no
		// keyboard at all (exit would have to be declared explicitly).
		const rm = (groupSend!.params as { reply_markup?: unknown }).reply_markup;
		expect(rm).toBeUndefined();
	});

	it("group defaults strip Next/Skip/Dismiss; Exit stays on group-scoped steps", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("intro", { text: "Go to a group.", buttons: ["next"] })
			.step("demo", {
				text: "In your group.",
				renderIn: "group",
				// Ask for every possible button — the renderer must still drop
				// next/skip/dismiss in group scope per GROUP_DEFAULTS.
				buttons: ["next", "skip", "dismiss", "exit"],
			})
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		const group = env.createChat({ type: "group", id: -1002 });

		await user.sendCommand("start");
		await user
			.on(env.lastBotMessage({ withReplyMarkup: true })!)
			.clickByText("Next");
		await user.in(group).sendMessage("arrived");

		const groupSend = env
			.filterApiCalls("sendMessage")
			.find(
				(c) =>
					(c.params as { text?: string }).text === "In your group." &&
					(c.params as { chat_id: number }).chat_id === group.payload.id,
			);
		expect(groupSend).toBeDefined();
		const buttons = flatButtons(
			(groupSend!.params as { reply_markup: unknown }).reply_markup,
		);
		expect(buttons.map((b) => b.text)).toEqual(["Exit"]);
	});

	it("renderIn function predicate gates rendering", async () => {
		const flow = createOnboarding({ id: "admin", storage: memoryStorage() })
			.step("hi", {
				text: "Admin-only step.",
				renderIn: (ctx) => (ctx as { from?: { id?: number } }).from?.id === 42,
			})
			.build();

		const bot = new Bot("test_token").extend(flow);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { admin: { start(): Promise<unknown> } };
				}
			).onboarding.admin.start(),
		);

		const env = new TelegramTestEnvironment(bot);
		const nonAdmin = env.createUser({ id: 1 });
		const admin = env.createUser({ id: 42 });

		// Non-admin triggers /start — predicate rejects, step goes pending.
		await nonAdmin.sendCommand("start");
		expect(allTexts(env)).not.toContain("Admin-only step.");

		// Admin sends any update — derive hook re-evaluates predicate on the
		// admin's ctx. Scope key is user-based by default, so this is a
		// different user and a different record. The pending render only
		// replays for the SAME user who triggered it.
		await admin.sendMessage("hi bot");
		expect(allTexts(env)).not.toContain("Admin-only step.");

		// But if the non-admin's next update comes from a ctx where the
		// predicate flips (it can't, by construction — but imagine a context
		// function that tests ctx.chat), the render would fire. Here we assert
		// the negative: without eligibility the step stays pending.
		expect(allTexts(env)).toEqual([]);
	});
});
