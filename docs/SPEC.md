# `@gramio/onboarding` — Implementation Plan

> Self-contained spec. Final design after iteration. Reads from scratch, no conversation history required.

---

## 1. Vision and scope

A plugin for **declarative user tutorials**: "walk the user through the bot's features one step at a time, with a Next button or the ability to perform the described action to advance." Key requirements:

- **Declarative steps** that read like a script.
- **Auto-advance on user action** — user sent a link → the "here's how I download files" step is marked complete, and the bot performs the action as it normally would.
- **Render delegated to `@gramio/views`** (optional) — views decide `edit` vs `send`, not us.
- **No hard peer-deps** — `views` and `session` are detected via capability detection; plugin works without them.
- **Multiple independent flows per bot** (`welcome`, `premium`, `new-feature`).
- **Cross-chat**: start in DM → continue in a group; "Next" buttons look bad in groups, handle that.
- **Ladder of user refusals**: skip-step → exit-flow → dismiss-flow-forever → disable-all-tutorials.
- **Fire-and-forget API** — `ctx.onboarding.*` calls are safe to leave un-`await`ed.
- **Storage-agnostic** — small interface, three built-in adapters (memory / session / redis).

Out of scope:
- Complex wizard forms (separation of concerns with `@gramio/scenes`).
- A/B testing tutorial variants (separate topic).
- Analytics/metrics (hooks only — bring your own).

---

## 2. Architecture

```
┌─ createOnboarding({ id, storage, ... })
│     ├─ .step(id, config)
│     ├─ .onComplete / .onExit / .onDismiss / .onStepChange
│     └─ .build() → OnboardingPlugin<Steps>
│
├─ bot.extend(plugin)
│     └─ registers:
│         - ctx.onboarding.<flowId>  (FlowControl)
│         - ctx.onboarding.active    (which flow is currently active)
│         - ctx.onboarding.disableAll / enableAll / allDisabled
│         - internal callback handler for "onb:*" prefix
│         - global middleware for advanceOn predicates
│
└─ OnboardingRunner (one per plugin):
    ├─ Storage (pluggable)             { flowId, userId, status, stepId, chatId, messageId, data, startedAt }
    ├─ Renderer                        delegate to ctx.render if present, else built-in send/edit
    ├─ AdvanceEngine                   button | ctx.onboarding.*.next() | advanceOn predicate
    ├─ ConcurrencyCoordinator          one flow active per user (queue/preempt/parallel)
    └─ ScopeResolver                   renderIn: dm/group/any, chat routing
```

The plugin doesn't touch other handlers. The only middleware it installs runs at the start of each update to check `advanceOn` predicates of active steps. Everything else flows through the `ctx.onboarding.*` API from user code.

---

## 3. Public API (target surface)

### 3.1 Builder

```ts
interface CreateOnboardingOpts {
  id: string;                              // required unique flow id
  storage: OnboardingStorage;
  concurrency?: "queue" | "preempt" | "parallel";   // default "queue"
  timeoutMs?: number;                      // default 24h; auto-exit if user abandons
  resumeOnStart?: boolean;                 // default true
  scope?: "user" | "chat" | (ctx) => string;        // default "user" (storage key)
  controls?: {
    dm?:    { next?: boolean; skip?: boolean; exit?: boolean; dismiss?: boolean };
    group?: { next?: boolean; skip?: boolean; exit?: boolean; dismiss?: boolean };
  };
  errors?: "forward-to-bot" | "throw";     // default "forward-to-bot" (fire-and-forget)
}

function createOnboarding<Data = {}>(opts: CreateOnboardingOpts): OnboardingBuilder<Data, never>;

interface OnboardingBuilder<Data, Steps extends string> {
  step<Id extends string>(id: Id, config: StepConfig<Data, Steps | Id>): OnboardingBuilder<Data, Steps | Id>;
  onComplete(handler: (ctx, meta: { data: Record<string, unknown> }) => unknown): this;
  onExit(handler: (ctx, meta: { at: Steps; reason: ExitReason }) => unknown): this;
  onDismiss(handler: (ctx, meta: { at: Steps }) => unknown): this;
  onStepChange(handler: (ctx, meta: { from: Steps | null; to: Steps }) => unknown): this;
  onMissingStep(
    handler: (ctx, meta: { oldStepId: string; availableSteps: Steps[] }) =>
      Steps | "complete" | "exit"
  ): this;
  build(): OnboardingPlugin<Steps>;
}

type ExitReason = "user" | "timeout" | "preempt" | "exitAll";
```

### 3.2 Step config

```ts
interface StepConfig<Data, Steps extends string> {
  // ── Content (pick one form) ──────────────────────────
  view?: View | string | ((ctx) => View);                 // @gramio/views — view instance or id for JSON
  args?: unknown | ((ctx) => unknown);                    // arguments for view.render
  text?: string | ((ctx) => string);                      // shortcut — inline, no views
  media?: MediaSpec | ((ctx) => MediaSpec);

  // ── Controls ─────────────────────────────────────────
  buttons?: Array<"next" | "skip" | "exit" | "dismiss">;  // inline-only (text), not for view
  advanceOn?: (ctx) => boolean | Promise<boolean>;         // auto-advance on update
  passthrough?: boolean;                                   // default true — update also flows to regular handlers
  skipWhen?: (ctx) => boolean | Promise<boolean>;          // skip step entirely on enter

  // ── Scope (DM vs group, cross-chat) ─────────────────
  renderIn?: "dm" | "group" | "any" | (ctx) => boolean;   // default "any"
  chat?: "same" | "await" | (ctx) => number;              // where to render the next bubble
  controls?: {                                             // per-step override
    dm?:    { next?: boolean; skip?: boolean; exit?: boolean; dismiss?: boolean };
    group?: { next?: boolean; skip?: boolean; exit?: boolean; dismiss?: boolean };
  };

  // ── Step hooks ───────────────────────────────────────
  onEnter?: (ctx) => unknown;
  onLeave?: (ctx, meta: { to: Steps | null; reason: LeaveReason }) => unknown;
}

type LeaveReason = "next" | "skip" | "goto" | "exit" | "dismiss" | "complete";
```

### 3.3 Runtime — `ctx.onboarding`

```ts
// Namespace object — covers all registered flows.
interface OnboardingNamespace {
  readonly active: { id: string; step: string } | null;    // which flow is active for this user
  readonly list: string[];                                  // all registered flow ids
  readonly allDisabled: boolean;                            // global opt-out?

  disableAll(): Promise<void>;
  enableAll(): Promise<void>;
  exitAll(): Promise<void>;                                 // dismiss all active/queued + disableAll

  // Dynamic access to a flow by id:
  [flowId: string]: FlowControl<string>;                    // typed via module augmentation
}

interface FlowControl<StepIds extends string> {
  // ── state ────────────────────────────────────────────
  readonly status: "null" | "active" | "exited" | "completed" | "dismissed";
  readonly isActive: boolean;
  readonly isDismissed: boolean;
  readonly currentStep: StepIds | null;
  readonly data: Record<string, unknown>;

  // ── actions ──────────────────────────────────────────
  start(opts?: { from?: StepIds; force?: boolean }): Promise<StartResult>;
  next(opts?: { from?: StepIds }): Promise<NextResult>;
  goto(id: StepIds): Promise<void>;
  skip(): Promise<void>;
  exit(): Promise<void>;
  dismiss(): Promise<void>;
  undismiss(): Promise<void>;
  complete(): Promise<void>;
}

type StartResult = "started" | "resumed" | "already-active" | "already-completed"
                 | "dismissed" | "opted-out" | "queued" | "preempted";

type NextResult  = "advanced" | "completed" | "inactive" | "step-mismatch";
```

Typing for `ctx.onboarding.welcome` — via TS module augmentation emitted by the builder on `.build()` (same approach `@gramio/session` uses to extend context types).

### 3.4 View-inject: `this.onboarding`

When the runner renders a step via `ctx.render(view, args)`, it **injects `this.onboarding` into the view context** (only for the duration of that render). Outside onboarding — `undefined`.

```ts
interface OnboardingViewCtx<Steps extends string> {
  flowId: string;
  stepId: Steps;
  data: Record<string, unknown>;

  // callback_data tokens — ready-to-use strings for InlineKeyboard.text(label, data)
  next: string | undefined;       // undefined if next is disallowed in current scope (e.g. group)
  skip: string | undefined;
  exit: string;                   // exit is always available — escape hatch
  dismiss: string | undefined;    // undefined if flow doesn't support dismiss
  exitAll: string;                // always available — nuclear option
  goto(id: Steps): string;
}
```

`next/skip/dismiss` may be `undefined` if the current scope (DM/group) disallows them. The view decides: `if (this.onboarding?.next) kb.text("Next", this.onboarding.next);`.

---

## 4. Canonical declaration example

```ts
import { Bot, InlineKeyboard } from "gramio";
import { initViewsBuilder } from "@gramio/views";
import { createOnboarding, redisStorage } from "@gramio/onboarding";

interface Data { user: { id: number; name: string } }
const defineView = initViewsBuilder<Data>();

const welcomeView = defineView().render(function () {
  const kb = new InlineKeyboard();
  if (this.onboarding?.next) kb.text("Let's go", this.onboarding.next);
  return this.response.text(`Hi, ${this.user.name}!`).keyboard(kb);
});

const linksView = defineView().render(function () {
  const kb = new InlineKeyboard();
  if (this.onboarding?.next) kb.text("Next", this.onboarding.next);
  if (this.onboarding) {
    kb.row()
      .text("Exit",          this.onboarding.exit)
      .text("I know already", this.onboarding.dismiss ?? this.onboarding.exit);
  }
  return this.response
    .text("Send me any link — I'll download the file. Try it!")
    .keyboard(kb);
});

const welcome = createOnboarding<Data>({
  id: "welcome",
  storage: redisStorage({ client, prefix: "onb" }),
  controls: {
    dm:    { next: true,  skip: true, exit: true, dismiss: true },
    group: { next: false, skip: false, exit: true, dismiss: true },
  },
})
  .step("welcome", { view: welcomeView })
  .step("links",   { view: linksView })
  .step("done",    { text: "Done!", buttons: ["next"] })
  .onComplete((ctx) => ctx.send("Welcome aboard! /help is always available."))
  .onExit((ctx, { at, reason }) =>
    reason === "user"
      ? ctx.send(`Paused at "${at}". Resume — /welcome_tour.`)
      : undefined,
  )
  .onDismiss((ctx) => ctx.send("OK, I won't bring up this tutorial again."))
  .build();

const premium = createOnboarding<Data>({
  id: "premium",
  storage: redisStorage({ client, prefix: "onb" }),
  concurrency: "queue",           // waits if welcome is still running
})
  .step("perks",   { view: perksView })
  .step("upgrade", { view: upgradeView })
  .build();

const bot = new Bot(process.env.BOT_TOKEN!)
  .derive(["message", "callback_query"], (ctx) => ({
    render: defineView.buildRender(ctx, {
      user: { id: ctx.from!.id, name: ctx.from!.firstName },
    }),
  }))
  .extend(welcome)
  .extend(premium);

bot.command("start",          (ctx) => { ctx.onboarding.welcome.start(); return ctx.send("Let's start!"); });
bot.command("welcome_tour",   (ctx) => ctx.onboarding.welcome.start({ force: true }));
bot.command("premium_tour",   (ctx) => ctx.onboarding.premium.start());
bot.command("no_tutorials",   (ctx) => { ctx.onboarding.disableAll(); return ctx.send("OK, silent mode."); });

bot.on("message", (ctx, next) => {
  const url = ctx.text?.match(/https?:\/\/\S+/)?.[0];
  if (!url) return next();

  downloadFile(url);
  ctx.onboarding.welcome.next({ from: "links" });   // no-op if not on the "links" step
  return ctx.send("Downloading…");
});
```

---

## 5. Lifecycle / status machine

### 5.1 Flow statuses (per-user)

```
null ──start()──► active ──complete()──► completed
                    │                     │
                    ├─exit()─► exited ────┤ (start can bring it back)
                    │                     │
                    ├─dismiss()─► dismissed (start{force} = no-op)
                    │
                    └─timeoutMs / exitAll ─► exited / dismissed
```

### 5.2 `start()` behavior by status

| `status` | `start()` | `start({ force: true })` | Returns |
|---|---|---|---|
| `null` | start | start | `"started"` |
| `active` | resume (if `resumeOnStart`), else no-op | restart from first step | `"resumed"` / `"already-active"` |
| `exited` | start fresh | start fresh | `"started"` |
| `completed` | no-op | restart from first step | `"already-completed"` / `"started"` |
| `dismissed` | no-op | **no-op** (respect explicit refusal) | `"dismissed"` / `"dismissed"` |
| global `disableAll` | no-op | **no-op** | `"opted-out"` |

`force` only breaks through `completed`. It does **not** break through `dismissed` or `disableAll` (developer must explicitly call `undismiss()` / `enableAll()`).

### 5.3 Concurrency (multiple flows)

A per-user coordinator holds one "active" flow plus a queue of pending ones:

| `concurrency` | Behavior on `start()` if another flow is active |
|---|---|
| `queue` (default) | enqueue, auto-start after the current flow finishes (`complete`/`exit`/`dismiss`/`timeout`). `start()` returns `"queued"`. |
| `preempt` | pause current → start new. When the new one finishes, attempt to resume the paused one. The pause is stored in storage (`status: "paused"` — internal, not exposed). Returns `"preempted"`. |
| `parallel` | coexist. Multiple flows can be active for one user at the same time. Rare use — best for very short announcement tutorials. |

`ctx.onboarding.active` returns the first active flow (or `null`). For `parallel`, which one is returned is unspecified.

### 5.4 Refusal ladder

```
skip          — skip the current step, stay in the flow
exit          — leave the flow, .start() can bring the user back
dismiss       — leave + "don't show this flow again" (undismiss resets)
exitAll       — dismiss all active + disableAll (nuclear)
disableAll    — flag on the user, does not touch active flows
```

A view can include any of these buttons — they're all exposed via `this.onboarding.*`.

---

## 6. Views integration

### 6.1 Soft dependency

The plugin detects `ctx.render` on the context. If present — use it (that means `@gramio/views` is registered). If absent — use the built-in mini-renderer (send / editMessageText / editMessageMedia with auto-detect based on the context type).

```ts
// pseudocode for runner render
async function renderStep(ctx, step, injectOnboarding) {
  const viewCtx = { ...ctx, onboarding: injectOnboarding };

  if (ctx.render && step.view) {
    return ctx.render.call(viewCtx, step.view, resolveArgs(step.args, ctx));
  }

  // fallback — inline step
  const payload = buildInlinePayload(step, viewCtx);
  return isCallback(ctx)
    ? ctx.editText(payload.text, payload.options)
    : ctx.send(payload.text, payload.options);
}
```

### 6.2 Views JSON adapter

Tokens are exposed via globals (`{{$onboarding.next}}`):

```json
{
  "links": {
    "text": "Send a link!",
    "reply_markup": {
      "inline_keyboard": [[
        { "text": "Next", "callback_data": "{{$onboarding.next}}" },
        { "text": "Exit", "callback_data": "{{$onboarding.exit}}" }
      ]]
    }
  }
}
```

The runner passes `onboarding` into the `globals` of `buildRender` for the duration of step rendering. Outside onboarding the field is absent — templates can check via a custom `resolve`.

### 6.3 Inline steps (no views)

`{ text, media?, buttons? }` — shortcut for 2-3 screen tutorials. The runner builds an `InlineKeyboard` from `buttons: ["next", "skip", "exit", "dismiss"]`, honoring `controls` for the current scope.

---

## 7. Advance mechanisms

Three ways to advance a step, all idempotent via `stepId` in `callback_data`:

### 7.1 Button (callback)

The view places `this.onboarding.next` as `callback_data`. The runner catches the `onb:*` prefix, parses `{op, flowId, stepId}`, checks currency (current step == stepId), performs the op, calls `answerCallbackQuery`.

Stale clicks (`stepId` doesn't match current) — silent no-op + `answerCallbackQuery("Already moving on")`.

### 7.2 Programmatic: `ctx.onboarding.welcome.next({ from })`

From any handler. `from` acts as a guard: "only advance if we're currently on this step." Without `from` — advance if any step of the flow is active.

Returns `NextResult` — the handler can decide what to do next (show its own acknowledgment vs. let the tutorial take over).

### 7.3 Declarative `advanceOn(ctx) => boolean`

Sugar over `next()`. The runner installs a middleware that — when a flow is active — checks the current step's predicate before business handlers. Match → calls `next()` and (with `passthrough: true`, the default) lets the update flow into regular handlers.

**Rule:** per step, use either `advanceOn` or `next({ from })`. Both are valid (idempotency protects you), but document that mixing them is confusing.

### 7.4 Where the next step renders (edit vs send)

Views' auto-detect decides:
- Trigger is a button (callback_query) → `editMessageText/Media` on the same bubble.
- Trigger is `next()` from a message handler → `send` a new bubble.
- Trigger is `advanceOn` match → `send` (the update is a message/other), unless `passthrough` is disabled.

The plugin forwards the trigger context to `ctx.render` — views do the rest.

---

## 8. Cross-chat scoping

### 8.1 `renderIn`

```ts
.step("try-in-group", {
  view: groupDemoView,
  renderIn: "group",       // "dm" | "group" | "any" | (ctx) => boolean
})
```

When the runner must render a step but the current update isn't from an eligible chat → the step goes into `pending` (stored as `pendingStepId` while `currentStepId` stays the same). The next update from the same user in an eligible chat → the runner renders the pending step, updates `chatId`/`messageId`.

### 8.2 `chat: "same" | "await" | resolver`

- `"same"` (default) — render in the same chat the trigger came from.
- `"await"` — wait until the user appears in a different chat (used with `renderIn`).
- `(ctx) => chatId` — explicit resolver (e.g. from `ctx.onboarding.welcome.data.groupId`).

### 8.3 Per-scope controls

```ts
// Flow-global:
controls: {
  dm:    { next: true,  skip: true, exit: true, dismiss: true },
  group: { next: false, skip: false, exit: true, dismiss: true },
}

// Step-level override:
.step("demo", { view: demoView, controls: { group: { next: false } } })
```

Runtime: the runner determines the scope of the current chat (`ctx.chat.type === "private"` → `dm`, else → `group`), resolves effective controls (flow → step), and exposes `this.onboarding.next/skip/dismiss` as either a string or `undefined`. Views render a button only when the token is defined.

**Default:** in groups, `next/skip/dismiss` are off by default — a "Next" button in group chat looks terrible. `exit` is always available. Advance in groups goes through `advanceOn` or `ctx.onboarding.*.next()` from handlers.

---

## 9. Global opt-out

A separate key in storage: `global:<userId> = { disabled: true }`. Not bound to any specific flow.

### API

```ts
ctx.onboarding.disableAll();      // persistent flag
ctx.onboarding.enableAll();       // unlock
ctx.onboarding.allDisabled;       // boolean

ctx.onboarding.exitAll();
// = dismiss all active flows + clear pending queue + disableAll()
```

### View token

`this.onboarding.exitAll` is always defined. Typical usage:

```ts
kb.row().text("No more tutorials", this.onboarding.exitAll);
```

### Check on start

`start()` on any flow first reads `global:<userId>.disabled`. If `true` → returns `"opted-out"`, does nothing. `force: true` does **not** break through — the user explicitly said "don't bother me."

---

## 10. Storage

### 10.1 Contract

```ts
interface OnboardingStorage {
  get(key: string): Promise<OnboardingRecord | null>;
  set(key: string, record: OnboardingRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

interface OnboardingRecord {
  kind: "flow" | "global";

  // kind === "flow"
  flowId?: string;
  userId?: number;                // or string for custom scope
  status?: "null" | "active" | "paused" | "exited" | "completed" | "dismissed";
  stepId?: string;
  pendingStepId?: string;         // step waiting for eligible chat
  chatId?: number;
  messageId?: number;
  data?: Record<string, unknown>;
  startedAt?: number;

  // kind === "global"
  disabled?: boolean;
  queue?: Array<{ flowId: string; from?: string }>;  // pending starts
}
```

Keys:
- `flow:{flowId}:{scopeKey}` — flow state per scope.
- `global:{scopeKey}` — opt-out + queue.

`scopeKey` = `userId` by default, or the result of the `scope` resolver.

### 10.2 Built-in adapters

- **`memoryStorage()`** — `Map<string, OnboardingRecord>`, for dev/tests.
- **`sessionStorage({ namespace })`** — on top of `@gramio/session`. Detects `ctx.session` in the middleware chain. If absent — throws at `.build()` time with a clear error message.
- **`redisStorage({ client, prefix, ttlSec? })`** — `ioredis` / `redis` compatible. TTL optional (no TTL by default).

Users can write their own: the three-method interface is intentionally minimal.

---

## 11. Fire-and-forget

All `ctx.onboarding.*` methods return `Promise<void>` (or `Promise<SomeResult>`) that **never rejects**. Errors (storage, render, network) are forwarded to `bot.errorHandler` with `{ source: "onboarding", flowId, op }`.

```ts
// safe:
bot.command("start", (ctx) => {
  ctx.onboarding.welcome.start();
  return ctx.send("Let's go!");
});

// when you do need await — message ordering matters:
await ctx.onboarding.welcome.next();
await ctx.send("Done.");
```

Internally:

```ts
function detach<T>(p: Promise<T>, bot: Bot, meta: ErrorMeta): Promise<T | void> {
  return p.catch((err) => bot.errorHandler(err, meta));
}
```

Opt-in `errors: "throw"` — for those who prefer to fail loudly; default is `"forward-to-bot"`.

---

## 12. Edge cases / guarantees

1. **Double "Next" click before the edit lands** — the callback contains `stepId`. If it doesn't match `currentStepId` in storage → no-op + `answerCallbackQuery("Already moving on")`. Two clicks = one advance.

2. **View renders both inside and outside onboarding** — `this.onboarding` is `undefined` outside onboarding. The `if (this.onboarding?.next)` check is mandatory, TS enforces it. Same pattern for `skip/dismiss`, which may also be `undefined` in groups.

3. **Step wants input (name, age)** — through `ctx.onboarding.<flow>.data`:
   ```ts
   .step("ask-name", { view: askNameView })   // no autoNext

   bot.on("message", async (ctx, next) => {
     if (ctx.onboarding.welcome.currentStep !== "ask-name") return next();
     ctx.onboarding.welcome.data.name = ctx.text;
     ctx.onboarding.welcome.next({ from: "ask-name" });
   });
   ```
   For real forms — `@gramio/scenes`/`wizard`, don't mix.

4. **User deleted the tutorial bubble** — `editMessageText` throws `message to edit not found`. The runner catches it, `send`s a new bubble, updates `messageId`. Handled at the renderer level.

5. **`skipWhen` returns `true` on `onEnter`** — the runner skips the step and moves to the next one. Useful: "if the user already set a language, skip the language-picker step."

6. **`timeout` during `paused` (preempted)** — a paused flow can expire too. Timers run on both active and paused; `exit` on timeout records `reason: "timeout"`.

7. **`extend` ordering** — onboarding must be extended **after** the views-derive, otherwise `ctx.render` won't be in context when the runner tries to render. If `ctx.render` isn't found at `.build()` time → warning log, fallback to built-in renderer.

8. **Flow removed from code but state remains in storage** — the runner checks at start: unknown `flowId` in storage → ignored on `start()`, optional cleanup job (opt-in).

9. **Step schema evolution (added / removed / renamed a step between deploys)** — handled at the runner level when resolving current/next step:

   | Scenario | Default behavior |
   |---|---|
   | Step added in the middle/end | "next" resolves against the current step list — the user sees the new step if they reach it. OK, no intervention needed. |
   | Steps reordered | As long as `stepId` still exists — OK. Order comes from the current list. |
   | View content changed | The next `editMessage*` renders new content on the same bubble. OK. |
   | **Step removed / renamed while user is on it** | Runner calls `.onMissingStep()` if provided, otherwise fallback: first step at (old-index + 1) in the current list → if none, `complete()`. |
   | In-flight callback after a deploy | `runId` + `stepId` in `callback_data`. `runId` matches, `stepId` still exists → works. Otherwise falls into the missing-step branch. |
   | User finished the old version, a new step was added | Intentionally **not** shown — `completed` stays `completed`. For announcements — use a **separate flow** (`v2-features`), not a force-restart of `welcome`. |

   Hook for complex migrations:

   ```ts
   createOnboarding({ id: "welcome", ... })
     .step("welcome", ...)
     .step("attachments", ...)   // was "links", renamed
     .step("done", ...)
     .onMissingStep((ctx, { oldStepId, availableSteps }) => {
       if (oldStepId === "links") return "attachments";  // rename map
       return "complete";
     })
     .build();
   ```

   The `data` bucket is the user's responsibility; for new steps that require specific fields, use `skipWhen: (ctx) => !flow.data.someField`.

---

## 13. Implementation milestones

Broken into phases, each is a separate PR:

### Phase 1: Core skeleton + inline steps

- `createOnboarding` builder with typed step ids.
- `StepConfig` with `text` / `buttons` (no views, no advanceOn, no scope).
- `memoryStorage` + contract.
- `ctx.onboarding.<flowId>` namespace (single flow for now).
- Core ops: `start`, `next`, `exit`, `complete`.
- Callback handler on `onb:*`.
- Hooks: `onComplete`, `onExit`.
- Fire-and-forget wrapper.

**Exit criteria:** `/start` launches a 3-step inline tutorial with next/exit buttons; state survives bot restarts (via memory within a single process session). **Missing-step default is built in from this phase:** if storage has a `stepId` that's not in the current list → forward to the nearest remaining step or `complete()`. Without this, any rename/delete breaks existing users in production.

### Phase 2: `@gramio/views` integration

- Capability detect for `ctx.render`.
- Inject `this.onboarding` into view context (runtime wrapping).
- `step.view` / `step.args` support.
- JSON adapter — `{{$onboarding.*}}` globals.
- Fallback to built-in renderer when views isn't present.

**Exit criteria:** same tutorial, but steps are full views with media and i18n via the views plugin.

### Phase 3: `ctx.onboarding.next({ from })` + `advanceOn`

- Middleware for `advanceOn` — runs only when a flow is active.
- `passthrough: true` default.
- `NextResult` / `from` guard.
- Test double-click idempotency.

**Exit criteria:** the "send a link" step can be completed both by clicking "Next" and by actually sending a link; the business handler runs normally.

### Phase 4: Multi-flow + concurrency

- Multiple `extend(createOnboarding(...))` per bot.
- `concurrency: "queue" | "preempt" | "parallel"`.
- `queue` stored in `global:<userId>.queue`.
- `paused` status (internal).
- `ctx.onboarding.active` / `ctx.onboarding.list`.

**Exit criteria:** `welcome` and `premium` flows don't conflict; `premium.start()` waits for `welcome.complete`.

### Phase 5: Cross-chat scoping

- `renderIn` with pending-step logic.
- `chat: "same" | "await" | resolver`.
- Per-scope `controls` (DM vs group).
- View token is `undefined` in disallowed scope.
- Group default — `next/skip/dismiss` off.

**Exit criteria:** a DM step "add me to your group" auto-advances when the user appears in a group; the next step renders in the group without a "Next" button.

### Phase 6: Opt-out layer

- `dismiss` / `undismiss` / status.
- `disableAll` / `enableAll` / `allDisabled`.
- `exitAll` — dismiss + disable.
- `this.onboarding.dismiss` / `exitAll` tokens.
- `onDismiss` hook.
- Flag checks in `start()`.

**Exit criteria:** user clicks "I know already" on welcome → subsequent `.start()` is no-op. Clicks "No more tutorials" → any flow's `.start()` returns `"opted-out"`.

### Phase 7: Storage adapters

- `sessionStorage` on top of `@gramio/session`.
- `redisStorage`.
- Tests for all three against a shared contract.
- Documentation page in `docs/plugins/official/`.

### Phase 8: Skills + examples

- `skills/plugins/onboarding.md` — guide for AI.
- `skills/examples/onboarding-basic.ts` — inline tutorial.
- `skills/examples/onboarding-views.ts` — with views.
- `skills/examples/onboarding-multi-flow.ts` — welcome + premium.
- Corresponding tests in `tests/examples/`.

---

## 14. Testing strategy

Each phase has unit + runtime tests via `@gramio/test` (`TelegramTestEnvironment`). Template:

```ts
// tests/onboarding/basic.test.ts
import { expect, test } from "bun:test";
import { TelegramTestEnvironment } from "@gramio/test";
import { bot } from "../../skills/examples/onboarding-basic";

test("welcome flow advances via button", async () => {
  const env = new TelegramTestEnvironment(bot);
  const user = env.user(42);

  await user.sendCommand("/start");
  expect(env.lastBotMessage()).toContain("Let's go");

  await user.clickInlineButton("Let's go");
  expect(env.lastBotMessage()).toContain("link");

  await user.sendMessage("https://example.com/file.zip");
  expect(env.allBotMessages()).toContainOneMatching(/Downloading/);
  expect(env.allBotMessages()).toContainOneMatching(/Next/);
  // advanced via a real action — new bubble, not an edit
});

test("start() after completed is no-op without force", async () => {
  // ...run through to the end...
  await user.sendCommand("/start");
  expect(env.messageCountSince(finishMark)).toBe(0);  // nothing sent
  await user.sendCommand("/welcome_tour");            // calls start({ force: true })
  expect(env.lastBotMessage()).toContain("Let's go"); // restarted
});

test("dismiss survives force", async () => {
  // ...run to the "links" step...
  await user.clickInlineButton("I know already");     // dismiss
  await user.sendCommand("/welcome_tour");            // start({ force: true })
  expect(env.messageCountSince(dismissMark)).toBe(0); // dismiss isn't broken by force
});
```

Required coverage:
- happy path for every verb (`next`, `skip`, `exit`, `dismiss`, `complete`, `exitAll`);
- double-click idempotency;
- every transition in the status machine;
- concurrency for queue / preempt;
- cross-chat: pending → eligible;
- per-scope controls: no-next-in-group;
- views integration vs fallback;
- `disableAll` blocks all `start()`.

---

## 15. Open questions / tradeoffs to decide during implementation

1. **Typing `ctx.onboarding.<flowId>` — augmentation vs `.onboarding("welcome")`.**
   Augmentation looks nicer (`ctx.onboarding.welcome.next()`), but requires a module declaration at `.build()` time, which is harder to debug if the user doesn't import the types. A function (`ctx.onboarding("welcome").next()`) is dumber but more explicit. **Recommendation:** augmentation, with a fallback function `ctx.onboarding.flow("welcome")` for the untyped case.

2. **`concurrency: "queue"` default — or fail loudly on conflict?**
   Queue is gentler but hides from the developer the fact that the user has two tutorials. **Recommendation:** queue + warning to `bot.errorHandler` with `{ severity: "warn", source: "onboarding.concurrency" }`.

3. **Injecting `this.onboarding` — via `ctx.render` wrapping or via a separate view-ctx extension?**
   Wrapping `ctx.render` requires detecting the function on the context and monkey-patching for the duration of the call — fragile. Cleaner: `defineView` from views accepts extra globals per call. **Verify the views API during implementation**; if it's missing, contribute upstream.

4. **Cross-chat pending step — how long to wait?**
   If the user was sent to an "add me to the group" step and forgot — it hangs forever. Pending has its own timeout (`pendingTimeoutMs`, default 7 days). After timeout — exit with `reason: "timeout"`.

5. **Nonce in callback_data?**
   `stepId` is enough for idempotency on normal next. But with `force: true` restart, old callbacks could fire on the new run. **Solution:** add `runId` (short random) to `callback_data` on every `start()`, store in state. `onb:next:{flowId}:{runId}:{stepId}`. Protects against stale callbacks after force.

6. **`scope: "chat"` — one tutorial per chat, not per user.**
   Useful for group tutorials where "teach the group how to use the bot" makes sense. Edge case; implementable in phase 5 alongside cross-chat.

---

## 16. TL;DR for the implementer

- **Start from Phase 1** — inline steps + memory + one flow. No views, no advanceOn, no scope. 200-300 lines + tests.
- **Every `ctx.onboarding.*` returns `Promise<T> | void` with a `catch` forwarding to `bot.errorHandler`** — this is the foundation, don't forget it in phase 1.
- **Injecting `this.onboarding` is the most fragile part** — do it in phase 2 via the views API, not via monkey-patching.
- **The status machine is the single source of truth for "can start."** All force/dismiss/disableAll checks live in one place.
- **Don't try to skip the `runId` in callback_data** — stale clicks after a force-restart are painful to debug.
- **`@gramio/views` / `@gramio/session` are NOT peer-deps.** Capability detect at runtime. Integration tests for both scenarios (with views / without views).
- **Buttons in groups are off by default** — that's the UX default, don't forget in phase 5.
- **exitAll = dismiss all + disableAll.** The "screw all of this" semantic is a critical atomic action, tested separately.
- **Step evolution is safe for add/reorder/rename (via `.onMissingStep()`).** To "show a new feature to users who already completed welcome" — use a **separate flow** (`v2-features`, `new-attachments-announce`), not a force-restart of the old one. That's exactly what multi-flow is for.
