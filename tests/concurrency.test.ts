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
 * Phase 4 — multi-flow concurrency.
 *
 * Exit criteria from the spec:
 *   `welcome` and `premium` flows don't conflict; `premium.start()` waits for
 *   `welcome.complete`.
 *
 * Modes:
 *   - "queue" (default): enqueue; auto-start on terminal.
 *   - "preempt": pause the active flow, start the new one, resume on finish.
 *   - "parallel": coexist; both flows active at once.
 */

const allTexts = (env: TelegramTestEnvironment): string[] =>
	env.apiCalls
		.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
		.map((c) => (c.params as { text?: string }).text ?? "");

// Phase-4 plugins must share a storage for multi-flow coordination to work.
// In real code, pass the same `memoryStorage()` / redis instance into every
// `createOnboarding` call. The default (module-level) storage already does
// this implicitly.
const sharedStorage = () => memoryStorage();

describe("@gramio/onboarding — Phase 4 concurrency: queue (default)", () => {
	it("premium.start() enqueues while welcome is active, auto-starts on complete", async () => {
		const storage = sharedStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "welcome-1", buttons: ["next"] })
			.step("done", { text: "welcome-done" })
			.onComplete((ctx) => ctx.send("welcome: aboard"))
			.build();
		const premium = createOnboarding({ id: "premium", storage })
			.step("perks", { text: "premium-perks" })
			.build();

		const results: Record<string, StartResult | undefined> = {};
		const bot = new Bot("test_token").extend(welcome).extend(premium);

		bot.command("start", async (ctx) => {
			const ns = (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<StartResult> } };
				}
			).onboarding;
			results.welcome = await ns.welcome.start();
		});
		bot.command("premium", async (ctx) => {
			const ns = (
				ctx as unknown as {
					onboarding: { premium: { start(): Promise<StartResult> } };
				}
			).onboarding;
			results.premium = await ns.premium.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		expect(results.welcome).toBe("started");

		await user.sendCommand("premium");
		expect(results.premium).toBe("queued");
		// Premium should NOT be active yet — welcome still owns the screen.
		expect(allTexts(env)).not.toContain("premium-perks");

		// Complete welcome by clicking through to the terminal step.
		const hi = env.lastBotMessage();
		await user.on(hi!).clickByText("Next");

		// After welcome.complete the coordinator should dequeue + start premium.
		const texts = allTexts(env);
		expect(texts).toContain("welcome-done");
		expect(texts).toContain("welcome: aboard");
		expect(texts).toContain("premium-perks");
	});

	it("two queued flows run in FIFO order (welcome → premium → farewell)", async () => {
		const storage = sharedStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("only", { text: "welcome-x", buttons: ["next"] })
			.build();
		const premium = createOnboarding({ id: "premium", storage })
			.step("only", { text: "premium-x", buttons: ["next"] })
			.build();
		const farewell = createOnboarding({ id: "farewell", storage })
			.step("only", { text: "farewell-x", buttons: ["next"] })
			.build();

		const bot = new Bot("test_token")
			.extend(welcome)
			.extend(premium)
			.extend(farewell);
		bot.command("go", async (ctx) => {
			const ns = (
				ctx as unknown as {
					onboarding: {
						welcome: { start(): Promise<StartResult> };
						premium: { start(): Promise<StartResult> };
						farewell: { start(): Promise<StartResult> };
					};
				}
			).onboarding;
			await ns.welcome.start();
			await ns.premium.start();
			await ns.farewell.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("go");

		// Click Next on welcome → completes welcome → coord starts premium.
		await user.on(env.lastBotMessage()!).clickByText("Next");
		// Click Next on premium → completes premium → coord starts farewell.
		await user.on(env.lastBotMessage()!).clickByText("Next");
		// Click Next on farewell → completes it (queue drained).
		await user.on(env.lastBotMessage()!).clickByText("Next");

		const orderedStepTexts = allTexts(env).filter((t) =>
			["welcome-x", "premium-x", "farewell-x"].includes(t),
		);
		expect(orderedStepTexts).toEqual(["welcome-x", "premium-x", "farewell-x"]);
	});
});

describe("@gramio/onboarding — Phase 4 concurrency: preempt", () => {
	it("preempt pauses the active flow and resumes it on terminal of the new one", async () => {
		const storage = sharedStorage();
		const welcome = createOnboarding({
			id: "welcome",
			storage,
			concurrency: "queue", // default, but explicit for clarity
		})
			.step("a", { text: "welcome-a", buttons: ["next"] })
			.step("b", { text: "welcome-b" })
			.onComplete((ctx) => ctx.send("welcome: done"))
			.build();

		const announce = createOnboarding({
			id: "announce",
			storage,
			concurrency: "preempt",
		})
			.step("only", { text: "announce-only", buttons: ["next"] })
			.build();

		const results: Record<string, StartResult | undefined> = {};
		const bot = new Bot("test_token").extend(welcome).extend(announce);

		bot.command("start", async (ctx) => {
			results.welcome = await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<StartResult> } };
				}
			).onboarding.welcome.start();
		});
		bot.command("announce", async (ctx) => {
			results.announce = await (
				ctx as unknown as {
					onboarding: { announce: { start(): Promise<StartResult> } };
				}
			).onboarding.announce.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		expect(results.welcome).toBe("started");

		await user.sendCommand("announce");
		// Announce preempts welcome — pauses it, starts itself.
		expect(results.announce).toBe("preempted");

		const texts = allTexts(env);
		expect(texts).toContain("announce-only");

		// Click Next on announce → completes → coord pops preemptStack and
		// resumes welcome, re-rendering its current step ("welcome-a").
		await user.on(env.lastBotMessage()!).clickByText("Next");
		expect(
			allTexts(env).filter((t) => t === "welcome-a").length,
		).toBeGreaterThanOrEqual(2);

		// Welcome is active again; clicking Next advances it to "welcome-b".
		await user.on(env.lastBotMessage()!).clickByText("Next");
		expect(allTexts(env)).toContain("welcome-b");
	});
});

describe("@gramio/onboarding — Phase 4 concurrency: parallel", () => {
	it("parallel mode lets both flows run simultaneously", async () => {
		const storage = sharedStorage();
		const welcome = createOnboarding({
			id: "welcome",
			storage,
			concurrency: "parallel",
		})
			.step("only", { text: "welcome-only" })
			.build();
		const tip = createOnboarding({
			id: "tip",
			storage,
			concurrency: "parallel",
		})
			.step("only", { text: "tip-only" })
			.build();

		const results: Record<string, StartResult | undefined> = {};
		const bot = new Bot("test_token").extend(welcome).extend(tip);
		bot.command("go", async (ctx) => {
			const ns = (
				ctx as unknown as {
					onboarding: {
						welcome: { start(): Promise<StartResult> };
						tip: { start(): Promise<StartResult> };
					};
				}
			).onboarding;
			results.welcome = await ns.welcome.start();
			results.tip = await ns.tip.start();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("go");

		// Both should report `started` (neither blocks the other).
		expect(results.welcome).toBe("started");
		expect(results.tip).toBe("started");
		expect(allTexts(env)).toContain("welcome-only");
		expect(allTexts(env)).toContain("tip-only");
	});
});

describe("@gramio/onboarding — Phase 4 namespace surface", () => {
	it("ns.active returns the first active flow when one is live", async () => {
		const storage = sharedStorage();
		const welcome = createOnboarding({ id: "welcome", storage })
			.step("hi", { text: "welcome-hi", buttons: ["next"] })
			.step("done", { text: "welcome-done" })
			.build();

		let seen: { id: string; step: string } | null = null;
		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start();
		});
		bot.command("peek", (ctx) => {
			seen = (ctx as unknown as { onboarding: OnboardingNamespace }).onboarding
				.active;
			return ctx.send("ok");
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		await user.sendCommand("peek");
		expect(seen).toEqual({ id: "welcome", step: "hi" });
	});
});
