# CLAUDE.md

Guidance for Claude Code when working on `@gramio/onboarding`.

## Project Overview

`@gramio/onboarding` is a plugin for [GramIO](https://gramio.dev) that implements **declarative user tutorials**: walk a user through bot features step by step, advancing on a button click or on a real user action. Steps are declared as a script; the plugin handles state, callbacks, scope (DM vs group), and refusal semantics (skip / exit / dismiss / disable-all).

The full design spec lives in `documentation/ideas/onboarding-plugin.md` (the documentation repo). Read it before making non-trivial changes.

## Development Commands

```bash
bunx pkgroll              # Build dist/
tsc --noEmit              # Type check (strict)
bun test                  # Run tests with bun:test
bunx biome check          # Lint with Biome
bunx biome check --write  # Auto-fix
```

## Architecture

```
src/
├── index.ts          Public API re-exports
├── builder.ts        createOnboarding(opts).step(...).build()
├── plugin.ts         GramIO Plugin: derive ctx.onboarding, on("callback_query") for "onb:*"
├── runner.ts         Step lifecycle: enter/leave, status transitions, missing-step fallback
├── types.ts          OnboardingStorage, OnboardingRecord, StepConfig, FlowControl, ...
├── tokens.ts         Encode/decode "onb:<op>:<flowId>:<runId>:<stepId>" callback_data
├── view-globals.ts   AsyncLocalStorage helper for views integration (Phase 2)
├── render/
│   ├── inline.ts     Built-in renderer: text + InlineKeyboard, send/editMessageText auto-detect
│   └── views.ts      @gramio/views integration: detect ctx.render, inject this.onboarding
└── storage/
    └── memory.ts     Wrapper around @gramio/storage's inMemoryStorage()
```

### Key invariants

- **Fire-and-forget**: every `ctx.onboarding.*` call returns `Promise<T> | void` and **never rejects**. Failures are forwarded to `bot.errorHandler` with `{ source: "onboarding", flowId, op }`.
- **runId in callback_data**: every `start()` writes a fresh short random `runId` to the record. Stale callbacks from a previous run are no-op'd via `answerCallbackQuery("Already moving on")`.
- **Status machine**: `null → active → completed | exited | dismissed`. `dismissed` and `disableAll` are NOT broken by `force: true` — only `completed` is.
- **Multi-flow ready from day one**: each `createOnboarding()` returns a separate Plugin. The shared `ctx.onboarding` namespace is built by the first plugin to `derive`; subsequent plugins augment it.
- **Capability-detected views**: `ctx.render` is detected at runtime; if absent the inline renderer kicks in. `@gramio/views` is an OPTIONAL peer-dependency.

## Phases shipped so far

- **Phase 1** — inline `text + buttons` steps, memory storage, `ctx.onboarding.<flow>.start/next/exit/complete/skip/goto`, callback handler with runId, `onMissingStep` fallback, fire-and-forget wrapper.
- **Phase 2** — `step.view` rendering via `ctx.render`, `this.onboarding` injection through opt-in `withOnboardingGlobals(...)` helper that uses `AsyncLocalStorage` to scope tokens per render call.
- **Phase 3** — `advanceOn(ctx) => boolean` middleware installed per-plugin on `message` updates: while the flow is active it evaluates the current step's predicate, advances via `control.next({ from })`, and (with `passthrough: true`, the default) forwards the update to business handlers. `passthrough: false` suppresses forwarding only when a match actually fired. Programmatic `ctx.onboarding.<flow>.next({ from })` returns `NextResult` (`advanced | completed | inactive | step-mismatch`).

Future phases (4-8) are described in the spec.

## Code Style

- Biome config matches `@gramio/scenes`: non-null assertions allowed, `any` allowed, no `noBannedTypes`.
- Strict TypeScript; prefer typed step ids via the builder generic.
- No `any` in public types.
