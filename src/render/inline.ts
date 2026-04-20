import { InlineKeyboard } from "gramio";
import type {
	AnyCtx,
	ButtonKind,
	OnboardingViewCtx,
	StepConfig,
} from "../types.js";

/**
 * Built-in renderer used when no `step.view` is set OR `@gramio/views` is not
 * registered. Builds an `InlineKeyboard` from `step.buttons` honouring the
 * scope-effective controls, then either edits the current callback bubble or
 * sends a fresh message.
 *
 * Returns the `messageId` of the rendered bubble so the runner can store it.
 */
export async function renderInline(
	ctx: AnyCtx,
	step: StepConfig<unknown, string>,
	tokens: OnboardingViewCtx,
): Promise<number | undefined> {
	const text = resolveText(step, ctx);
	if (text === undefined) return undefined;

	const { keyboard, hasButtons } = buildKeyboard(step.buttons, tokens);
	const replyMarkup = hasButtons ? keyboard : undefined;

	const isCallback = ctx.is("callback_query");
	const hasMessage = isCallback && (ctx as any).message;

	try {
		if (isCallback && hasMessage) {
			await (ctx as any).editText(text, { reply_markup: replyMarkup });
			const msgId = (ctx as any).message?.id as number | undefined;
			return msgId;
		}
		const sent = await (ctx as any).send(text, { reply_markup: replyMarkup });
		return extractMessageId(sent);
	} catch (err) {
		// "message to edit not found" / "message can't be edited" — fall back to send.
		if (isCallback) {
			const sent = await (ctx as any).send(text, { reply_markup: replyMarkup });
			return extractMessageId(sent);
		}
		throw err;
	}
}

function resolveText(
	step: StepConfig<unknown, string>,
	ctx: AnyCtx,
): string | undefined {
	const t = step.text;
	if (typeof t === "function") return (t as (ctx: AnyCtx) => string)(ctx);
	return t;
}

function buildKeyboard(
	buttons: ButtonKind[] | undefined,
	tokens: OnboardingViewCtx,
): { keyboard: InlineKeyboard; hasButtons: boolean } {
	const kb = new InlineKeyboard();
	if (!buttons?.length) return { keyboard: kb, hasButtons: false };

	const labels: Record<ButtonKind, string> = {
		next: "Next",
		skip: "Skip",
		exit: "Exit",
		dismiss: "Don't show again",
	};

	let added = 0;
	let firstInRow = true;
	for (const kind of buttons) {
		const data = pickToken(kind, tokens);
		if (!data) continue;
		if (!firstInRow) kb.row();
		kb.text(labels[kind], data);
		firstInRow = false;
		added++;
	}
	return { keyboard: kb, hasButtons: added > 0 };
}

function pickToken(
	kind: ButtonKind,
	tokens: OnboardingViewCtx,
): string | undefined {
	switch (kind) {
		case "next":
			return tokens.next;
		case "skip":
			return tokens.skip;
		case "exit":
			return tokens.exit;
		case "dismiss":
			return tokens.dismiss;
	}
}

function extractMessageId(sent: unknown): number | undefined {
	if (sent && typeof sent === "object" && "id" in sent) {
		const id = (sent as { id: unknown }).id;
		if (typeof id === "number") return id;
	}
	if (sent && typeof sent === "object" && "message_id" in sent) {
		const id = (sent as { message_id: unknown }).message_id;
		if (typeof id === "number") return id;
	}
	return undefined;
}
