# @gramio/onboarding

> **Status:** alpha — Phase 1 + Phase 2 implemented. See `documentation/ideas/onboarding-plugin.md` for the full roadmap.

Declarative user tutorials for [GramIO](https://gramio.dev) bots. Walk a user through your bot's features one step at a time — advance on a "Next" button, or on the user actually doing the thing the step describes.

```ts
import { Bot } from "gramio";
import { createOnboarding } from "@gramio/onboarding";

const welcome = createOnboarding({ id: "welcome" })
    .step("hi",    { text: "Hi! I'll show you around.", buttons: ["next", "exit"] })
    .step("links", { text: "Send me any link — I'll download it.", buttons: ["next", "exit", "dismiss"] })
    .step("done",  { text: "All set!" })
    .onComplete((ctx) => ctx.send("Welcome aboard! /help is always available."))
    .build();

const bot = new Bot(process.env.BOT_TOKEN!).extend(welcome);

bot.command("start", (ctx) => {
    ctx.onboarding.welcome.start();
    return ctx.send("Let's start!");
});

bot.start();
```

## Highlights

- **Declarative steps** — read like a script
- **Auto-advance on user action** — `ctx.onboarding.<flow>.next({ from: "links" })` from a real handler
- **Fire-and-forget API** — calls never throw; failures forwarded to `bot.errorHandler`
- **Refusal ladder** — skip → exit → dismiss → `disableAll`, all opt-in via buttons
- **Multi-flow ready** — `welcome`, `premium`, `new-feature` extend the bot independently
- **Optional views integration** — pass `step.view` and use `@gramio/views` for rich content
- **Storage-agnostic** — pluggable `Storage` from `@gramio/storage` (memory / redis / sqlite / cloudflare)

## Installation

```bash
bun add @gramio/onboarding
# or npm/pnpm/yarn
```

## Documentation

Full API reference: [gramio.dev/plugins/official/onboarding](https://gramio.dev/plugins/official/onboarding) (coming soon).

The design spec — including phases not yet implemented — lives at `documentation/ideas/onboarding-plugin.md` in the [documentation repo](https://github.com/gramiojs/documentation).

## License

MIT
