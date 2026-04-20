# @gramio/onboarding

> **Status:** alpha — phases 1–7 shipped (everything except the docs-site page + public skill examples). API is stable enough for real bots; semver resets to `0.x` once phase 8 lands.

Declarative user tutorials for [GramIO](https://gramio.dev) bots. Walk a user through your bot's features one step at a time — advance on a "Next" button, or on the user *actually doing* the thing the step describes.

```ts
import { Bot } from "gramio";
import { createOnboarding } from "@gramio/onboarding";

const welcome = createOnboarding({ id: "welcome" })
    .step("hi",    { text: "Hi! I'll show you around.", buttons: ["next", "exit"] })
    .step("links", {
        text: "Send me any link — I'll download it.",
        advanceOn: (ctx) => /https?:\/\//.test(ctx.text ?? ""),
    })
    .step("done",  { text: "All set!" })
    .onComplete((ctx) => ctx.send("Welcome aboard! /help is always available."))
    .build();

const bot = new Bot(process.env.BOT_TOKEN!).extend(welcome);

bot.command("start", (ctx) => {
    ctx.onboarding.welcome.start();
    return ctx.send("Let's start!");
});

bot.on("message", async (ctx, next) => {
    if (/https?:\/\//.test(ctx.text ?? "")) await ctx.send("Downloading…");
    return next();
});

bot.start();
```

The second step auto-advances when the user sends a real link. Your business handler still runs after the step advances (the default `passthrough: true`), so the user sees both "Downloading…" and "All set!" without any glue code.

---

## Why

Writing an onboarding tutorial without a plugin means hand-rolling a tiny state machine per bot: a flag per user, a switch per step, stale-button guards, DM-vs-group checks, an opt-out path, and a way to layer "welcome" on top of "premium upgrade" without them stepping on each other. `@gramio/onboarding` is that state machine, done once, typed, and pluggable.

- **Declarative steps** that read like a script.
- **Advance on real user actions** — not just button clicks.
- **Fire-and-forget API** — calls never reject; failures forward to `bot.errorHandler`.
- **Refusal ladder** — skip → exit → dismiss → `disableAll`, all opt-in via buttons.
- **Multi-flow concurrency** — queue, preempt, or run in parallel.
- **Cross-chat scoping** — DM steps that wait for the user to appear in a group before rendering there.
- **Optional views integration** — `step.view` works with `@gramio/views` for rich content.
- **Storage-agnostic** — any `Storage` from the `@gramio/storage-*` ecosystem.

---

## Install

```bash
bun add @gramio/onboarding
# or npm / pnpm / yarn
```

The plugin peer-depends on `gramio >= 0.7.0`. `@gramio/views` is an optional peer — pull it in only if you want view-rendered steps.

---

## Core concepts

### A flow

A **flow** is a named, ordered list of steps. You build one with the chainable builder and extend your `Bot` with it. One bot can have any number of flows.

```ts
const welcome = createOnboarding({ id: "welcome", storage: memoryStorage() })
    .step("hi",   { text: "Hi!", buttons: ["next"] })
    .step("done", { text: "Bye!" })
    .build();

bot.extend(welcome);
```

Every `createOnboarding({ id })` returns a separate `Plugin`. Multi-flow bots simply `.extend()` each one; they coordinate through a shared `ctx.onboarding` namespace built by whichever plugin derives first.

### A step

A step is a piece of content (`text` or `view`) plus a handful of hooks and constraints:

```ts
interface StepConfig {
    text?: string | ((ctx) => string);
    view?: View | string | ((ctx) => View);   // @gramio/views
    args?: unknown | ((ctx) => unknown);      // view args
    media?: MediaSpec | ((ctx) => MediaSpec);

    buttons?: Array<"next" | "skip" | "exit" | "dismiss">;
    advanceOn?: (ctx) => boolean | Promise<boolean>;
    passthrough?: boolean;      // default true

    renderIn?: "dm" | "group" | "any" | ((ctx) => boolean);
    controls?: {
        dm?:    { next?, skip?, exit?, dismiss? };
        group?: { next?, skip?, exit?, dismiss? };
    };

    onEnter?: (ctx) => unknown;
    onLeave?: (ctx, { to, reason }) => unknown;
}
```

`text` is the shortcut path — inline render with a built-in keyboard. `view` delegates to `@gramio/views`. You get both — pick per step.

### Status machine

Every flow has a per-user status:

```
null → active → completed | exited | dismissed
           ↕
         paused     (preempt mode only)
```

`completed` / `exited` / `dismissed` are terminal. `dismissed` sticks — users who "don't want to see this again" won't, even across `force: true` restarts (only explicit `undismiss()` or `enableAll()` clears it).

---

## Runtime: `ctx.onboarding`

Once you extend your bot with a flow, every handler sees a typed `ctx.onboarding` namespace:

```ts
bot.command("start", (ctx) => {
    ctx.onboarding.welcome.start();          // StartResult
    ctx.onboarding.welcome.next();            // NextResult
    ctx.onboarding.welcome.goto("links");
    ctx.onboarding.welcome.skip();
    ctx.onboarding.welcome.exit();
    ctx.onboarding.welcome.dismiss();
    ctx.onboarding.welcome.complete();

    ctx.onboarding.welcome.status;           // "active" | ...
    ctx.onboarding.welcome.currentStep;      // "hi"
    ctx.onboarding.welcome.isActive;
    ctx.onboarding.welcome.isDismissed;
    ctx.onboarding.welcome.data;             // step-shared scratchpad

    ctx.onboarding.active;                   // { id, step } | null
    ctx.onboarding.list;                     // ["welcome", "premium"]
    ctx.onboarding.flow("premium");          // lookup by id
    ctx.onboarding.disableAll();             // kill every flow
    ctx.onboarding.enableAll();
    ctx.onboarding.exitAll();                // dismiss all + disableAll
    ctx.onboarding.allDisabled;
});
```

### `StartResult`

```
"started" | "resumed" | "already-active" | "already-completed"
| "dismissed" | "opted-out" | "queued" | "preempted"
```

### `NextResult`

```
"advanced" | "completed" | "inactive" | "step-mismatch"
```

`step-mismatch` protects against races — pass `{ from: "links" }` to assert you're advancing from a specific step; if the user already clicked Next, the second call is a no-op.

---

## Advancing steps

Three ways to advance — pick whichever fits:

### 1. Button callback

```ts
.step("hi", { text: "Hi!", buttons: ["next"] })
```

The built-in renderer ships `Next` / `Skip` / `Exit` / `Don't show again` buttons. Callback data is `onb:<op>:<flowId>:<runId>:<stepId>` — stale clicks after a force-restart safely no-op with "Already moving on".

### 2. Declarative `advanceOn`

The step advances when the predicate matches an inbound message. By default the update **also** reaches your regular handlers (`passthrough: true`), so you don't have to duplicate logic:

```ts
.step("links", {
    text: "Send me a link.",
    advanceOn: (ctx) => /https?:\/\//.test(ctx.text ?? ""),
})

bot.on("message", (ctx, next) => {
    if (/https?:\/\//.test(ctx.text ?? "")) return ctx.send("Downloading…");
    return next();
});
```

Set `passthrough: false` on the step to stop the update from falling through after a match.

### 3. Programmatic from inside a handler

```ts
bot.on("message", async (ctx, next) => {
    if (!isLink(ctx.text)) return next();
    await ctx.onboarding.welcome.next({ from: "links" });
    await ctx.send("Downloading…");
});
```

The `{ from }` guard is idempotent with `advanceOn` — if both fire for the same update, only one advance happens.

---

## Cross-chat scoping

Steps can pin themselves to DM or group context:

```ts
const welcome = createOnboarding({ id: "welcome" })
    .step("ask-group",   { text: "Add me to your group!", buttons: ["next"] })
    .step("in-the-group", { text: "Hi team!", renderIn: "group" })
    .build();
```

When the next step's `renderIn` doesn't match the current chat (user clicked Next in DM but the step wants `"group"`), the runner doesn't render — it stashes `pendingStepId` on the record. The moment the user sends anything in a group, the derive hook sees the pending step is now eligible and renders it there.

Group steps default to showing only the `Exit` button (no Next/Skip/Dismiss noise in a group chat). Override per flow or per step:

```ts
createOnboarding({
    id: "welcome",
    controls: { group: { next: true } },   // flow-level
})
.step("demo", {
    text: "Here in your group!",
    renderIn: "group",
    controls: { group: { exit: false } },  // step-level
})
```

`renderIn` also accepts a function — e.g. `(ctx) => ctx.from?.id === ADMIN_ID` for admin-only steps.

---

## Multi-flow concurrency

Multiple flows coexist. What happens when two flows want to start at once is per-flow policy:

```ts
const welcome = createOnboarding({
    id: "welcome",
    concurrency: "queue",       // default — enqueue, auto-start on terminal
}).build();

const announce = createOnboarding({
    id: "announce",
    concurrency: "preempt",     // pause welcome, run announce, then resume
}).build();

const tip = createOnboarding({
    id: "tip",
    concurrency: "parallel",    // ignore coordination
}).build();

bot.extend(welcome).extend(announce).extend(tip);
```

- **`queue` (default)** — `start()` returns `"queued"` if another flow is live; the coordinator drains the FIFO queue on every terminal event.
- **`preempt`** — `start()` pauses every active flow (LIFO preempt stack), runs itself, then resumes the topmost paused flow. `start()` returns `"preempted"`.
- **`parallel`** — no coordination; multiple flows render simultaneously.

State lives on a shared `global:<scopeKey>` record, so coordination survives restarts as long as your storage does.

---

## Opt-out layer

Two levels, because "I've seen this one" and "stop all tutorials forever" aren't the same request.

```ts
// Per-flow — only this tutorial stops
await ctx.onboarding.welcome.dismiss();   // onDismiss hook fires
await ctx.onboarding.welcome.undismiss(); // reversible

// Namespace-wide — every flow is blocked
await ctx.onboarding.disableAll();        // start() returns "opted-out"
await ctx.onboarding.enableAll();         // reversible
await ctx.onboarding.exitAll();           // dismiss active + disableAll
```

Expose them in the UI by listing `"dismiss"` in `buttons` (rendered as *Don't show again*), or by emitting an `exitAll` token from a view. `startImpl` checks `disabled` before `dismissed`, so after `exitAll` every flow returns `"opted-out"`.

---

## Storage

The `storage:` option accepts any `Storage<OnboardingStorageMap>` — the same `Storage` interface every other GramIO plugin uses:

```ts
import { memoryStorage } from "@gramio/onboarding";
import { redisStorage } from "@gramio/storage-redis";

createOnboarding({ id: "welcome", storage: memoryStorage() });
createOnboarding({ id: "welcome", storage: redisStorage({ client }) });
```

No wrapper needed — the plugin stores records under `flow:<flowId>:<scopeKey>` and `global:<scopeKey>`, where `scopeKey` is `userId` by default (or `chatId`, or your own resolver via `scope: (ctx) => ...`).

### Writing a custom adapter

Ship any backend by implementing the `Storage<T>` interface and running the exported contract suite:

```ts
import { describe, it } from "bun:test";
import { getStorageContractCases } from "@gramio/onboarding";
import { myAdapter } from "./my-adapter.js";

describe("my adapter", () => {
    for (const c of getStorageContractCases(() => myAdapter({ fresh: true }))) {
        it(c.name, c.run);
    }
});
```

`getStorageContractCases()` is framework-agnostic — it returns `{ name, run }[]`, so you can wire it to `bun:test`, `vitest`, Jest, `node:test`, whatever. The suite pins get/set/has/delete semantics, overwrite behaviour, and nested-data round-trips.

---

## Views integration

If you pass `step.view` and `@gramio/views` is registered on the bot, the plugin calls `ctx.render(view, args)` instead of the inline renderer. Inside the view, `this.onboarding` exposes the token set:

```ts
interface OnboardingViewCtx {
    flowId: string;
    stepId: string;
    data: Record<string, unknown>;
    next: string | undefined;      // callback_data; undefined if control disabled
    skip: string | undefined;
    exit: string;                  // always defined
    dismiss: string | undefined;
    exitAll: string;               // always defined
    goto: (target: string) => string;
}
```

Thread it into the view with `withOnboardingGlobals()`:

```ts
import { withOnboardingGlobals } from "@gramio/onboarding";

const bot = new Bot(BOT_TOKEN)
    .extend(views([welcomeView]))
    .extend(welcome)
    .derive("message", withOnboardingGlobals());
```

`withOnboardingGlobals` uses `AsyncLocalStorage` to scope tokens per-render call — safe under concurrent updates.

---

## Error handling

Every `ctx.onboarding.*` method is fire-and-forget. They return a promise (so you *can* `await` the result code), but they never reject. Storage failures, render errors, user hooks that throw — all get forwarded to your `bot.errorHandler` with a structured payload:

```ts
bot.onError(({ error, context }) => {
    // context: { source: "onboarding", flowId: "welcome", op: "next.render" }
    logger.error(error, { source: context.source, flowId: context.flowId });
});
```

Set `errors: "throw"` on a flow if you want the loud version — useful in tests.

---

## Phases shipped

- **Phase 1** — inline `text + buttons` steps, memory storage, full `ctx.onboarding.*` surface, stale-callback guard via `runId`, `onMissingStep` fallback, fire-and-forget wrapper.
- **Phase 2** — `step.view` rendering via `ctx.render`, `this.onboarding` injection through `withOnboardingGlobals()`.
- **Phase 3** — `advanceOn(ctx) => boolean` middleware with default-on passthrough; programmatic `next({ from })` with `step-mismatch` guard.
- **Phase 4** — multi-flow concurrency (`queue` / `preempt` / `parallel`) with a per-user `FlowCoordinator`, FIFO queue + LIFO preempt stack persisted on `global:<scopeKey>`.
- **Phase 5** — `renderIn` cross-chat scoping with `pendingStepId` re-render on the next eligible update; DM/group control defaults.
- **Phase 6** — opt-out layer: `dismiss` / `undismiss` / `disableAll` / `enableAll` / `exitAll`, `opted-out` + `dismissed` start codes, `onDismiss` hook.
- **Phase 7** — framework-agnostic `getStorageContractCases()` suite; any `Storage<OnboardingStorageMap>` adapter plugs into the `storage:` option.

Phase 8 (docs-site page + AI-skill examples in the documentation repo) lands once the package is published.

---

## Development

```bash
bunx pkgroll        # Build dist/
tsc --noEmit        # Strict typecheck
bun test            # bun:test — currently 76 tests across 8 files
bunx biome check    # Lint
```

Tests live next to the phase they exercise — `tests/basic.test.ts`, `tests/advanceOn.test.ts`, `tests/concurrency.test.ts`, `tests/scope.test.ts`, `tests/optOut.test.ts`, `tests/storage-contract.test.ts`, etc. They drive a real `Bot` through `@gramio/test`'s `TelegramTestEnvironment` — no unit-test mocking; the tests are what a user would observe.

The design spec — rationale, open questions, and the full phase roadmap — lives at `documentation/ideas/onboarding-plugin.md` in the [documentation repo](https://github.com/gramiojs/documentation).

---

## License

MIT
