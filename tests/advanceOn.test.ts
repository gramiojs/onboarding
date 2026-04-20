import { describe, expect, it } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import { Bot } from "gramio";
import {
	type NextResult,
	type OnboardingNamespace,
	createOnboarding,
	memoryStorage,
} from "../src/index.js";

/**
 * Phase 3 — `advanceOn` middleware + `next({ from })` programmatic advance.
 *
 * The plugin installs an `.on("message")` middleware that, while a flow is
 * active, evaluates the current step's `advanceOn(ctx) => boolean`. On match,
 * it advances the step; by default the update still passes to business
 * handlers (`passthrough: true`). `passthrough: false` suppresses forwarding
 * after a match.
 *
 * All three paths must be idempotent with `ctx.onboarding.<flow>.next({ from })`
 * called from a user handler — double-match (advanceOn + next() from handler)
 * resolves to a single advance via the `from` stepId guard.
 */

const lastText = (env: TelegramTestEnvironment): string | undefined => {
	for (let i = env.apiCalls.length - 1; i >= 0; i--) {
		const call = env.apiCalls[i]!;
		if (call.method === "sendMessage" || call.method === "editMessageText") {
			return (call.params as { text?: string }).text;
		}
	}
	return undefined;
};

const allTexts = (env: TelegramTestEnvironment): string[] =>
	env.apiCalls
		.filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
		.map((c) => (c.params as { text?: string }).text ?? "");

const URL_RE = /https?:\/\/\S+/;

describe("@gramio/onboarding — Phase 3 advanceOn middleware", () => {
	it("advanceOn matches → step advances AND business handler still runs (passthrough default)", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!", buttons: ["next"] })
			.step("links", {
				text: "Send me any link!",
				buttons: ["next"],
				advanceOn: (ctx) => {
					const text = (ctx as { text?: string }).text;
					return Boolean(text && URL_RE.test(text));
				},
			})
			.step("done", { text: "All set!" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", async (ctx) => {
			await (
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start();
		});
		// Business handler that reacts to the link — MUST still run after the
		// advanceOn match so the user sees the "Downloading…" reply.
		bot.on("message", async (ctx, next) => {
			const text = (ctx as { text?: string }).text;
			if (text && URL_RE.test(text)) {
				await ctx.send("Downloading…");
				return;
			}
			return next();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		// Jump past step 1 with a button click, so step 2 ("links") is active.
		await user
			.on(env.lastBotMessage({ withReplyMarkup: true })!)
			.clickByText("Next");

		expect(lastText(env)).toBe("Send me any link!");

		// Now the advanceOn match — sending a link should BOTH advance the flow
		// AND let the business handler produce its reply.
		await user.sendMessage("https://example.com/file.zip");

		const texts = allTexts(env);
		expect(texts).toContain("Downloading…");
		expect(texts).toContain("All set!");
	});

	it("passthrough: false stops the chain after an advanceOn match", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("capture", {
				text: "Say anything.",
				advanceOn: () => true,
				passthrough: false,
			})
			.step("done", { text: "Captured!" })
			.build();

		let businessHandlerFired = false;
		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);
		bot.on("message", (ctx, next) => {
			// Command messages still reach here via `next()` chain, so filter.
			if ((ctx as { text?: string }).text?.startsWith("/")) return next();
			businessHandlerFired = true;
			return next();
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		await user.sendMessage("anything goes");

		expect(businessHandlerFired).toBe(false);
		expect(allTexts(env)).toContain("Captured!");
	});

	it("advanceOn is ignored when the flow is not active", async () => {
		let predicateCalls = 0;
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", {
				text: "Hi!",
				advanceOn: () => {
					predicateCalls++;
					return true;
				},
			})
			.step("done", { text: "Done!" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		// Deliberately no `/start` handler — the flow never transitions to active.
		bot.on("message", (ctx) => ctx.send("echo"));

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendMessage("random");
		await user.sendMessage("another");

		expect(predicateCalls).toBe(0);
		expect(allTexts(env)).toEqual(["echo", "echo"]);
	});

	it("advanceOn predicate returning false leaves the step unchanged", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", {
				text: "Send me a link.",
				advanceOn: (ctx) =>
					Boolean(
						(ctx as { text?: string }).text &&
							URL_RE.test((ctx as { text?: string }).text!),
					),
			})
			.step("done", { text: "All set!" })
			.build();

		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);
		bot.on("message", (ctx) => ctx.send("ack"));

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		await user.sendMessage("hello, no link here");
		await user.sendMessage("still nothing");

		// Step hasn't advanced, so "All set!" must NOT appear.
		expect(allTexts(env)).not.toContain("All set!");
	});
});

describe("@gramio/onboarding — Phase 3 next({ from }) programmatic advance", () => {
	it("next({ from }) advances when the guard matches the current step", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!", buttons: ["next"] })
			.step("links", { text: "Send any link!", buttons: ["next"] })
			.step("done", { text: "All set!" })
			.build();

		let nextResult: NextResult | undefined;
		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);
		bot.on("message", async (ctx, next) => {
			const text = (ctx as { text?: string }).text;
			if (!text || !URL_RE.test(text)) return next();
			nextResult = (await (
				ctx as unknown as {
					onboarding: {
						welcome: { next(opts: { from: string }): Promise<NextResult> };
					};
				}
			).onboarding.welcome.next({ from: "links" })) as NextResult;
			await ctx.send("Downloading…");
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		await user
			.on(env.lastBotMessage({ withReplyMarkup: true })!)
			.clickByText("Next");
		await user.sendMessage("https://example.com/file.zip");

		expect(nextResult === "advanced" || nextResult === "completed").toBe(true);
		expect(allTexts(env)).toContain("Downloading…");
		expect(allTexts(env)).toContain("All set!");
	});

	it("next({ from }) returns step-mismatch when the guard is wrong", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!", buttons: ["next"] })
			.step("done", { text: "Done!" })
			.build();

		let result: NextResult | undefined;
		const bot = new Bot("test_token").extend(welcome);
		bot.command("start", (ctx) =>
			(
				ctx as unknown as {
					onboarding: { welcome: { start(): Promise<unknown> } };
				}
			).onboarding.welcome.start(),
		);
		bot.command("probe", async (ctx) => {
			result = (await (
				ctx as unknown as {
					onboarding: {
						welcome: { next(opts: { from: string }): Promise<NextResult> };
					};
				}
			).onboarding.welcome.next({ from: "not-a-real-step" })) as NextResult;
			return ctx.send(`result:${result}`);
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();

		await user.sendCommand("start");
		await user.sendCommand("probe");

		expect(result).toBe("step-mismatch");
		expect(env.lastBotMessage()?.payload.text).toBe("result:step-mismatch");
	});

	it("next() when no flow is active returns inactive", async () => {
		const welcome = createOnboarding({
			id: "welcome",
			storage: memoryStorage(),
		})
			.step("hi", { text: "Hi!", buttons: ["next"] })
			.step("done", { text: "Done!" })
			.build();

		let result: NextResult | undefined;
		const bot = new Bot("test_token").extend(welcome);
		bot.command("probe", async (ctx) => {
			result = (await (
				ctx as unknown as {
					onboarding: OnboardingNamespace & {
						welcome: { next(): Promise<NextResult> };
					};
				}
			).onboarding.welcome.next()) as NextResult;
		});

		const env = new TelegramTestEnvironment(bot);
		const user = env.createUser();
		await user.sendCommand("probe");

		expect(result).toBe("inactive");
	});
});
