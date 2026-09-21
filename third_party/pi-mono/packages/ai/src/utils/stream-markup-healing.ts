/**
 * Streaming-safe filter for leaked chat-template thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content`
 * instead of returning structured events. This vendored variant supports only
 * the `"thinking"` pattern: a {@link ThinkingInbandScanner} heals leaked
 * reasoning idioms (`<think>`, `<thinking>`, ` ```thinking `, Gemma/Harmony
 * channels, …) out of the visible channel.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt held-back
 * partial tag buffers.
 */

import { ThinkingInbandScanner, type ThinkingScanEvent } from "./thinking-scanner.ts";

export type StreamMarkupHealingPattern = "thinking";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string };

export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	/** Always-on healer for leaked reasoning idioms in the visible text channel. */
	readonly #thinkingScanner = new ThinkingInbandScanner();

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/** Feed a chunk and return visible text only. */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Unterminated
	 * thinking blocks are emitted as thinking.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		return this.#convertScannerEvents(this.#thinkingScanner.flush());
	}

	/** Flush held-back text only. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			}
		}
		return clean;
	}

	#convertScannerEvents(events: readonly ThinkingScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "impliedThinkingEnd": // never emitted: the thinking scanner runs without `impliedOpen`
					break;
			}
		}
		return out;
	}
}
