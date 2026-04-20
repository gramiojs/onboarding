import { describe, expect, it } from "bun:test";
import {
	type ButtonKind,
	type ExitReason,
	type FlowControl,
	type FlowStatus,
	type LeaveReason,
	type NextResult,
	type OnboardingBuilder,
	type OnboardingNamespace,
	type OnboardingRecord,
	type OnboardingStorageMap,
	type OnboardingViewCtx,
	type ScopeControls,
	type StartResult,
	type StepConfig,
	createOnboarding,
	withOnboardingGlobals,
} from "../src/index.js";

/**
 * Compile-time type tests for @gramio/onboarding.
 *
 * The convention (mirrors @gramio/dialog/tests/types.test.ts):
 *   `@ts-expect-error` annotations ARE the assertion. If the line below one
 *   compiles, this file fails to typecheck — the test fails at build time.
 *
 *   `bun run check` (= `tsc --noEmit`) is the test runner.
 *
 * `bun test` runs the few `expect()` calls in here too, just to surface that
 * the file was loaded — but the real value lives in tsc output.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Public re-exports — surface area sanity
// ─────────────────────────────────────────────────────────────────────────────

describe("Public types are exported", () => {
	it("type-only exports compile", () => {
		const _flowStatuses: FlowStatus[] = [
			"null",
			"active",
			"exited",
			"completed",
			"dismissed",
			"paused",
		];
		const _exitReasons: ExitReason[] = [
			"user",
			"timeout",
			"preempt",
			"exitAll",
		];
		const _leaveReasons: LeaveReason[] = [
			"next",
			"skip",
			"goto",
			"exit",
			"dismiss",
			"complete",
		];
		const _startResults: StartResult[] = [
			"started",
			"resumed",
			"already-active",
			"already-completed",
			"dismissed",
			"opted-out",
			"queued",
			"preempted",
		];
		const _nextResults: NextResult[] = [
			"advanced",
			"completed",
			"inactive",
			"step-mismatch",
		];
		const _btn: ButtonKind[] = ["next", "skip", "exit", "dismiss"];

		expect(_flowStatuses.length).toBe(6);
		expect(_exitReasons.length).toBe(4);
		expect(_leaveReasons.length).toBe(6);
		expect(_startResults.length).toBe(8);
		expect(_nextResults.length).toBe(4);
		expect(_btn.length).toBe(4);
	});

	it("FlowStatus literal union — no extras", () => {
		// @ts-expect-error — "frozen" is not a valid FlowStatus
		const _bad: FlowStatus = "frozen";
	});

	it("ButtonKind literal union — no extras", () => {
		// @ts-expect-error — "back" isn't a known ButtonKind
		const _bad: ButtonKind = "back";
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Builder — Steps union accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe("Builder Steps accumulation", () => {
	it("step() accumulates ids into the Steps union", () => {
		const b = createOnboarding({ id: "t1" })
			.step("hi", { text: "1" })
			.step("links", { text: "2" })
			.step("done", { text: "3" });

		// Type-level: extract Steps from OnboardingBuilder<Data, Steps>
		type Extract<T> = T extends OnboardingBuilder<infer _D, infer S>
			? S
			: never;
		type Steps = Extract<typeof b>;

		const _ok1: Steps = "hi";
		const _ok2: Steps = "links";
		const _ok3: Steps = "done";

		// @ts-expect-error — "typo" was never registered
		const _bad: Steps = "typo";

		expect(_ok1).toBe("hi");
	});

	it("createOnboarding starts with Steps = never", () => {
		const b = createOnboarding({ id: "t2" });
		type Extract<T> = T extends OnboardingBuilder<infer _D, infer S>
			? S
			: never;
		type Steps = Extract<typeof b>;

		const _check: [Steps] extends [never] ? true : false = true;
		expect(_check).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Step config — buttons, controls, content
// ─────────────────────────────────────────────────────────────────────────────

describe("StepConfig type safety", () => {
	it("buttons accepts only ButtonKind values", () => {
		createOnboarding({ id: "t3" }).step("hi", {
			text: "ok",
			buttons: ["next", "skip", "exit", "dismiss"],
		});

		createOnboarding({ id: "t4" }).step("hi", {
			text: "ok",
			// @ts-expect-error — "back" is not a ButtonKind
			buttons: ["next", "back"],
		});
	});

	it("controls.dm/group take ScopeControls (booleans only)", () => {
		createOnboarding({ id: "t5" }).step("hi", {
			text: "ok",
			controls: { dm: { next: true, dismiss: false } },
		});

		createOnboarding({ id: "t6" }).step("hi", {
			text: "ok",
			// @ts-expect-error — must be boolean, not string
			controls: { dm: { next: "yes" } },
		});

		createOnboarding({ id: "t7" }).step("hi", {
			text: "ok",
			// @ts-expect-error — "channel" is not a known scope
			controls: { channel: { next: true } },
		});
	});

	it("renderIn accepts the documented literals", () => {
		createOnboarding({ id: "t8" }).step("hi", {
			text: "ok",
			renderIn: "dm",
		});
		createOnboarding({ id: "t9" }).step("hi", {
			text: "ok",
			renderIn: (_ctx) => true,
		});

		createOnboarding({ id: "t10" }).step("hi", {
			text: "ok",
			// @ts-expect-error — "private" isn't a renderIn literal
			renderIn: "private",
		});
	});

	it("text accepts string OR (ctx) => string", () => {
		createOnboarding({ id: "t11" }).step("hi", { text: "static" });
		createOnboarding({ id: "t12" }).step("hi", { text: (_c) => "dynamic" });

		createOnboarding({ id: "t13" }).step("hi", {
			// @ts-expect-error — number is not a valid text
			text: 42,
		});
	});

	it("media requires {type, media}", () => {
		createOnboarding({ id: "t14" }).step("hi", {
			text: "x",
			media: { type: "photo", media: "file_id" },
		});

		createOnboarding({ id: "t15" }).step("hi", {
			text: "x",
			// @ts-expect-error — "gif" isn't a valid media type
			media: { type: "gif", media: "x" },
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Hooks — Steps narrowing
// ─────────────────────────────────────────────────────────────────────────────

describe("Hook callbacks narrow Steps", () => {
	it("onExit meta.at is the Steps union", () => {
		createOnboarding({ id: "h1" })
			.step("hi", { text: "1" })
			.step("done", { text: "2" })
			.onExit((_ctx, { at, reason }) => {
				const _ok: "hi" | "done" = at;
				const _r: ExitReason = reason;

				// @ts-expect-error — "wrong" not in Steps
				const _bad: "wrong" = at;
				void _ok;
				void _r;
				void _bad;
			});
	});

	it("onDismiss meta.at is the Steps union", () => {
		createOnboarding({ id: "h2" })
			.step("a", { text: "1" })
			.step("b", { text: "2" })
			.onDismiss((_ctx, { at }) => {
				const _ok: "a" | "b" = at;

				// @ts-expect-error — "c" not in Steps
				const _bad: "c" = at;
				void _ok;
				void _bad;
			});
	});

	it("onStepChange meta.from / .to are Steps", () => {
		createOnboarding({ id: "h3" })
			.step("a", { text: "1" })
			.step("b", { text: "2" })
			.onStepChange((_ctx, { from, to }) => {
				const _from: "a" | "b" | null = from;
				const _to: "a" | "b" = to;

				// @ts-expect-error — "x" not in Steps
				const _bad: "x" = to;
				void _from;
				void _to;
				void _bad;
			});
	});

	it("onMissingStep return type is Steps | 'complete' | 'exit'", () => {
		createOnboarding({ id: "h4" })
			.step("a", { text: "1" })
			.step("b", { text: "2" })
			.onMissingStep((_ctx, { oldStepId, availableSteps }) => {
				const _o: string = oldStepId;
				const _av: ("a" | "b")[] = availableSteps;
				void _o;
				void _av;
				return "a";
			});

		createOnboarding({ id: "h5" })
			.step("a", { text: "1" })
			.onMissingStep((_ctx, _meta) => "complete");

		createOnboarding({ id: "h6" })
			.step("a", { text: "1" })
			// @ts-expect-error — "wrong" is not a registered step (or "complete"/"exit")
			.onMissingStep((_ctx, _meta) => "wrong");
	});

	it("onComplete meta.data is Record<string, unknown> (typed Data — gap)", () => {
		createOnboarding({ id: "h7" })
			.step("a", { text: "1" })
			.onComplete((_ctx, { data }) => {
				// Today the public hook says Record<string, unknown>.
				// If we ever propagate `Data` from createOnboarding<Data>, this test
				// will need narrowing. For now, document the floor.
				const _d: Record<string, unknown> = data;
				void _d;
			});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Storage map — keys are template-literal strings
// ─────────────────────────────────────────────────────────────────────────────

describe("OnboardingStorageMap key shape", () => {
	it("keys are flow:<id>:<scope> | global:<scope>", () => {
		const _flow: keyof OnboardingStorageMap = "flow:welcome:42";
		const _global: keyof OnboardingStorageMap = "global:42";
		void _flow;
		void _global;
	});

	it("OnboardingRecord disjoint kinds", () => {
		const flow: OnboardingRecord = {
			kind: "flow",
			flowId: "welcome",
			status: "active",
			stepId: "hi",
		};
		const global: OnboardingRecord = { kind: "global", disabled: true };
		void flow;
		void global;

		// @ts-expect-error — "session" is not a valid kind
		const _bad: OnboardingRecord = { kind: "session" };
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. OnboardingViewCtx — token typing
// ─────────────────────────────────────────────────────────────────────────────

describe("OnboardingViewCtx token shape", () => {
	it("exit / exitAll are always-defined strings; next/skip/dismiss are optional", () => {
		const _typeOnly = () => {
			const tokens: OnboardingViewCtx<"hi" | "done"> = {
				flowId: "welcome",
				stepId: "hi",
				data: {},
				next: "x",
				skip: undefined,
				exit: "x",
				dismiss: undefined,
				exitAll: "x",
				goto: (_id) => "x",
			};

			// @ts-expect-error — exit must be string, not undefined
			const _bad1: OnboardingViewCtx = { ...tokens, exit: undefined };

			const _ok: string | undefined = tokens.next;
			void _ok;
			void _bad1;
		};
		void _typeOnly;
		expect(true).toBe(true);
	});

	it("goto narrows to Steps when generic is supplied", () => {
		const _typeOnly = (tokens: OnboardingViewCtx<"hi" | "done">) => {
			tokens.goto("hi");
			tokens.goto("done");
			// @ts-expect-error — "wrong" not in the Steps generic
			tokens.goto("wrong");
		};
		void _typeOnly;
		expect(true).toBe(true);
	});

	it("stepId is narrowed to Steps when generic is supplied", () => {
		const _typeOnly = (tokens: OnboardingViewCtx<"hi" | "done">) => {
			const _id: "hi" | "done" = tokens.stepId;
			void _id;
		};
		void _typeOnly;
		expect(true).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. FlowControl — typed surface (currently DEFAULT-Steps; this surfaces a gap)
// ─────────────────────────────────────────────────────────────────────────────

describe("FlowControl typed surface", () => {
	it("typed FlowControl narrows start/next/goto", () => {
		const _typeOnly = (ctrl: FlowControl<"hi" | "done">) => {
			const _step: "hi" | "done" | null = ctrl.currentStep;
			void _step;

			ctrl.start({ from: "hi" });
			ctrl.next({ from: "done" });
			ctrl.goto("hi");

			// @ts-expect-error — "x" not in Steps
			ctrl.start({ from: "x" });
			// @ts-expect-error — "x" not in Steps
			ctrl.next({ from: "x" });
			// @ts-expect-error — "x" not in Steps
			ctrl.goto("x");
		};
		void _typeOnly;
		expect(true).toBe(true);
	});

	it("default-generic FlowControl falls back to string (escape hatch)", () => {
		const _typeOnly = (ctrl: FlowControl) => {
			ctrl.start({ from: "anything" });
			ctrl.next({ from: "anything" });
			ctrl.goto("anything");

			const _step: string | null = ctrl.currentStep;
			void _step;
		};
		void _typeOnly;
		expect(true).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. OnboardingNamespace — runtime API
// ─────────────────────────────────────────────────────────────────────────────

describe("OnboardingNamespace runtime API", () => {
	it("flow(id) returns FlowControl | undefined", () => {
		const _typeOnly = (ns: OnboardingNamespace) => {
			const fc = ns.flow("welcome");
			const _check: FlowControl | undefined = fc;
			void _check;

			// All three "all" methods are async voids
			const _da: Promise<void> = ns.disableAll();
			const _ea: Promise<void> = ns.enableAll();
			const _xa: Promise<void> = ns.exitAll();
			void _da;
			void _ea;
			void _xa;
		};
		void _typeOnly;
		expect(true).toBe(true);
	});

	it("active is { id, step } | null", () => {
		const _typeOnly = (ns: OnboardingNamespace) => {
			const a = ns.active;
			if (a) {
				const _id: string = a.id;
				const _step: string = a.step;
				void _id;
				void _step;
			}
		};
		void _typeOnly;
		expect(true).toBe(true);
	});

	it("indexed access is `unknown` (typed via augmentation — see GAP below)", () => {
		const _typeOnly = (ns: OnboardingNamespace) => {
			const wf = ns.welcome;
			// Today: no narrowing — users must cast.
			const _u: unknown = wf;
			void _u;
		};
		void _typeOnly;
		expect(true).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. withOnboardingGlobals — wrapper preserves user globals + adds onboarding
// ─────────────────────────────────────────────────────────────────────────────

describe("withOnboardingGlobals wrapper", () => {
	it("returns a per-render thunk yielding user globals + live `onboarding`", () => {
		const thunk = withOnboardingGlobals({
			user: { id: 1, name: "alice" },
			locale: "en" as "en" | "ru",
		});

		// `thunk` is `() => Globals` — buildRender accepts both shapes.
		const _isThunk: () => unknown = thunk;
		void _isThunk;

		const snapshot = thunk();
		const _id: number = snapshot.user.id;
		const _name: string = snapshot.user.name;
		const _locale: "en" | "ru" = snapshot.locale;
		const _onb: OnboardingViewCtx | undefined = snapshot.onboarding;

		expect(snapshot.user.id).toBe(1);
		expect(snapshot.user.name).toBe("alice");
		expect(snapshot.onboarding).toBeUndefined();

		void _id;
		void _name;
		void _locale;
		void _onb;
	});

	it("rejects non-object input", () => {
		// @ts-expect-error — must be an object
		withOnboardingGlobals("nope");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. createOnboarding<Data> — generic propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("createOnboarding<Data> generic", () => {
	it("Data parameter is currently structurally inert (GAP)", () => {
		// What we WANT: step.text/media/buttons handlers see Data inside ctx.
		//   step("hi", { text: (ctx) => `hello ${ctx.onboarding.welcome.data.name}` })
		//                                                     ^? typed
		// What we have today: createOnboarding<Data> accepts Data but never
		// flows it into StepConfig handlers. The generic is a placeholder.
		//
		// This `Data` shape compiles but the type is *unused* at the boundary —
		// the test below documents the floor so future work can tighten it.
		const _b = createOnboarding<{ name: string; age: number }>({
			id: "g1",
		}).step("hi", { text: "hello" });

		void _b;
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. CreateOnboardingOpts validation
// ─────────────────────────────────────────────────────────────────────────────

describe("CreateOnboardingOpts shape", () => {
	it("accepts the documented unions", () => {
		createOnboarding({
			id: "o1",
			concurrency: "queue",
			errors: "forward-to-bot",
			scope: "user",
			resumeOnStart: true,
			timeoutMs: 30_000,
		});
		createOnboarding({
			id: "o2",
			concurrency: "preempt",
			errors: "throw",
			scope: "chat",
		});
		createOnboarding({
			id: "o3",
			scope: (_ctx) => "custom-key",
		});
	});

	it("rejects bad enum literals", () => {
		createOnboarding({
			id: "o4",
			// @ts-expect-error — "serial" isn't a ConcurrencyMode
			concurrency: "serial",
		});

		createOnboarding({
			id: "o5",
			// @ts-expect-error — "log" isn't an ErrorMode
			errors: "log",
		});

		createOnboarding({
			id: "o6",
			// @ts-expect-error — "channel" isn't a ScopeResolver literal
			scope: "channel",
		});
	});

	it("controls config — only dm/group keys", () => {
		createOnboarding({
			id: "o7",
			controls: { dm: { next: true }, group: { exit: true } },
		});

		createOnboarding({
			id: "o8",
			// @ts-expect-error — "private" isn't a controls scope
			controls: { private: { next: true } },
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Module-augmentation contract for ctx.onboarding (THE BIGGEST GAP)
// ─────────────────────────────────────────────────────────────────────────────

describe("ctx.onboarding module augmentation contract", () => {
	it("documents what users currently must write to get types", () => {
		// GAP: bot.extend(welcomePlugin) does NOT widen the context union with
		// `onboarding: OnboardingNamespace & { welcome: FlowControl<...> }`.
		// Users either:
		//   (a) cast: (ctx as { onboarding: OnboardingNamespace }).onboarding
		//   (b) declare module augmentation themselves
		//
		// This test pins (b) so we don't accidentally regress what little users
		// CAN do today — and to make the gap visible to maintainers.

		const _typeOnly = (
			ns: OnboardingNamespace & { welcome: FlowControl<"hi" | "done"> },
		) => {
			const _step: "hi" | "done" | null = ns.welcome.currentStep;
			void _step;

			ns.welcome.start({ from: "hi" });
			ns.welcome.goto("done");

			// @ts-expect-error — "x" not in welcome's Steps
			ns.welcome.goto("x");
		};
		void _typeOnly;
		expect(true).toBe(true);
	});
});
