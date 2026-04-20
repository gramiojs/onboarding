import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import { Bot } from "gramio";
import {
	type OnboardingNamespace,
	type StartResult,
	createOnboarding,
	memoryStorage,
} from "../src/index.js";

/**
 * Phase 6 — opt-out layer.
 *
 * Exit criteria from the spec:
 *   - User clicks "I know already" on welcome → subsequent `.start()` is a no-op.
 *   - User clicks "No more tutorials" (exitAll) → any flow's `.start()` returns "opted-out".
 *
 * This file pins the programmatic surface around that: per-flow dismiss vs.
 * namespace-wide disableAll/exitAll/enableAll, plus the matching StartResult
 * codes and the onDismiss hook.
 */

const allTexts = (env: TelegramTestEnvironment): string[] =>
	env.apiCalls
		.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
		.map((c) => (c.params as { text?: string }).text ?? "");

describe("@gramio/onboarding — Phase 6 opt-out: per-flow dismiss", () => {
	it("dismiss() blocks subsequent start() with 'dismissed' code", async () => {
		const results: StartResult[] = [];
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("kill", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { dismiss(): Promise<void> } };
				}
			).onboarding.welcome.dismiss();
		});
		bot.command("start", async (ctx) => {
			const r = await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<StartResult> } };
				}
			).onboarding.welcome.start();
			results.push(r);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("kill");
		await user.sendCommand("start");

		expect(results).toEqual(["dismissed"]);
	});

	it("undismiss() clears the dismissed state so start() works again", async () => {
		const results: StartResult[] = [];
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "welcome-hi" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("kill", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { dismiss(): Promise<void> } };
				}
			).onboarding.welcome.dismiss();
		});
		bot.command("revive", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { undismiss(): Promise<void> } };
				}
			).onboarding.welcome.undismiss();
		});
		bot.command("start", async (ctx) => {
			results.push(
				await (
					ctx as unknown as {
						onboarding: { welcome: { start(): Promise<StartResult> } };
					}
				).onboarding.welcome.start(),
			);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("kill");
		await user.sendCommand("start"); // "dismissed"
		await user.sendCommand("revive");
		await user.sendCommand("start"); // "started"

		expect(results).toEqual(["dismissed", "started"]);
		expect(allTexts(env)).toContain("welcome-hi");
	});

	it("onDismiss hook fires with the step id at which dismiss was called", async () => {
		let captured: { at: string } | null = null;
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!", buttons: ["dismiss"] })
			.onDismiss((_ctx, meta) => {
				captured = meta;
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

		await user.sendCommand("start");
		await user
			.on(env.lastBotMessage({ withReplyMarkup: true })!)
			.clickByText("Don't show again");

		expect(captured).toEqual({ at: "hi" });
	});
});

describe("@gramio/onboarding — Phase 6 opt-out: namespace-wide disable", () => {
	it("disableAll() makes every flow's start() return 'opted-out'", async () => {
		const storage = memoryStorage();
		const results: Record<string, StartResult | undefined> = {};
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "welcome-hi" })
			.build();
		const premium = createOnboarding({ id: "premium", storage })
			.step("perks", { text: "premium-perks" })
			.build();

		const bot = new Bot("test_token").extend(welcome).extend(premium);
		bot.command("nuke", (ctx) =>
			(
				ctx as unknown as { onboarding: OnboardingNamespace }
			).onboarding.disableAll(),
		);
		bot.command("welcome", async (ctx) => {
			results.welcome = await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<StartResult> } };
				}
			).onboarding.welcome.start();
		});
		bot.command("premium", async (ctx) => {
			results.premium = await (
				ctx as unknown as {
					onboarding: { premium: { start(): Promise<StartResult> } };
				}
			).onboarding.premium.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("nuke");
		await user.sendCommand("welcome");
		await user.sendCommand("premium");

		expect(results.welcome).toBe("opted-out");
		expect(results.premium).toBe("opted-out");
		expect(allTexts(env)).not.toContain("welcome-hi");
		expect(allTexts(env)).not.toContain("premium-perks");
	});

	it("enableAll() restores start() across flows", async () => {
		const storage = memoryStorage();
		const results: StartResult[] = [];
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "welcome-hi" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("nuke", (ctx) =>
			(
				ctx as unknown as { onboarding: OnboardingNamespace }
			).onboarding.disableAll(),
		);
		bot.command("revive", (ctx) =>
			(
				ctx as unknown as { onboarding: OnboardingNamespace }
			).onboarding.enableAll(),
		);
		bot.command("start", async (ctx) => {
			results.push(
				await (
					ctx as unknown as {
						onboarding: { welcome: { start(): Promise<StartResult> } };
					}
				).onboarding.welcome.start(),
			);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("nuke");
		await user.sendCommand("start"); // "opted-out"
		await user.sendCommand("revive");
		await user.sendCommand("start"); // "started"

		expect(results).toEqual(["opted-out", "started"]);
		expect(allTexts(env)).toContain("welcome-hi");
	});

	it("exitAll() method dismisses active flows AND flips disableAll", async () => {
		const storage = memoryStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "welcome-hi", buttons: ["next"] })
			.step("done", { text: "welcome-done" })
			.build();
		const premium = createOnboarding({ id: "premium", storage })
			.step("only", { text: "premium-only" })
			.build();

		const results: Record<string, StartResult | undefined> = {};
		const bot = new Bot("test_token").extend(welcome).extend(premium);
		bot.command("start", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start();
		});
		bot.command("nuke", async (ctx) => {
			await (
				ctx as unknown as { onboarding: OnboardingNamespace }
			).onboarding.exitAll();
		});
		bot.command("again", async (ctx) => {
			const ns = (
				ctx as unknown as {
					onboarding: {
						welcome: { start(): Promise<StartResult> };
						premium: { start(): Promise<StartResult> };
					};
				}
			).onboarding;
			results.welcome = await ns.welcome.start();
			results.premium = await ns.premium.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start"); // welcome active on step "hi"
		await user.sendCommand("nuke"); // exitAll → dismiss welcome + disableAll
		await user.sendCommand("again");

		// Both short-circuit on the global `disabled` flag (checked before the
		// per-flow `dismissed` status), so every flow reports "opted-out" —
		// that's the spec's exit criterion for `exitAll`.
		expect(results.welcome).toBe("opted-out");
		expect(results.premium).toBe("opted-out");
	});

	it("allDisabled getter reflects disableAll state", async () => {
		const storage = memoryStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "Hi!" })
			.build();

		const snapshots: boolean[] = [];
		const bot = new Bot("test_token").extend(welcome);
		bot.command("peek", (ctx) => {
			snapshots.push(
				(ctx as unknown as { onboarding: OnboardingNamespace }).onboarding
					.allDisabled,
			);
			return ctx.send("ok");
		});
		bot.command("nuke", (ctx) =>
			(
				ctx as unknown as { onboarding: OnboardingNamespace }
			).onboarding.disableAll(),
		);

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("peek"); // false
		await user.sendCommand("nuke");
		await user.sendCommand("peek"); // true

		expect(snapshots).toEqual([false, true]);
	});
});
