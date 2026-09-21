/**
 * In-band thinking-section scanners for streamed visible text.
 *
 * Hosted models sometimes leak raw chat-template reasoning markup (`<think>`,
 * ` ```thinking `, Gemma/Harmony channels, …) into the visible `content`
 * channel instead of returning structured thinking events. These scanners heal
 * such leaks back into thinking events.
 */

export type ThinkingScanEvent =
	| { type: "text"; text: string }
	| { type: "thinkingStart" }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd"; thinking: string }
	/**
	 * A reasoning close tag with no open in this stream. Chat templates that
	 * prefill the opener into the prompt (DeepSeek-R1, Qwen3-Thinking) make the
	 * model stream only the close, so everything emitted as `text` before this
	 * event was reasoning. Only {@link ThinkingInbandScanner} with `impliedOpen`
	 * emits it.
	 */
	| { type: "impliedThinkingEnd" };

export interface ThinkingScanner {
	feed(text: string): ThinkingScanEvent[];
	flush(): ThinkingScanEvent[];
}

function partialSuffixOverlap(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let k = max; k > 0; k--) {
		if (text.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

function partialSuffixOverlapAny(text: string, tags: readonly string[]): number {
	let best = 0;
	for (const tag of tags) best = Math.max(best, partialSuffixOverlap(text, tag));
	return best;
}

/** A complete fence line: ≤3 lead spaces, a run of ≥3 backticks/tildes, then an info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** ≤3 lead spaces then a (possibly partial) backtick run and whatever follows it. */
const BACKTICK_LEAD = /^ {0,3}(`*)([\s\S]*)$/;
/** A language-tag info string: one token, no whitespace (markers an inner fence opener carries). */
const LANG_TOKEN = /^[A-Za-z0-9_+#-]+$/;

/** Result of feeding bytes to {@link FencedThinkingScanner}. */
export interface FencedThinkingResult {
	/** Thinking text to emit for this feed (may be empty). */
	readonly thinking: string;
	/** True once the thinking closer has been consumed. */
	readonly closed: boolean;
	/** Bytes after the closing fence (visible reply); only meaningful when {@link closed}. */
	readonly rest: string;
}

/**
 * Stateful, line-oriented close-matcher for one ` ```thinking ` block. Owns the
 * partial-line buffer so an ambiguous trailing fence is held until it resolves.
 *
 * A naive `indexOf("```")` closes the thinking section at the FIRST backtick
 * fence inside the reasoning, so an inner ` ```rs … ``` ` code block would leak
 * its body (and everything after) into the visible channel. This scanner tracks
 * inner-fence nesting so only the real thinking closer ends the block.
 *
 * Distinguishing an inner opener from the closer: a fenced code block opener is
 * ` ``` ` immediately followed by a language token (`rs`, `tool_code`, `c++` …)
 * and a newline. The thinking closer is a bare ` ``` `, or ` ``` ` glued to the
 * visible reply — its remainder is prose (contains whitespace/punctuation), not
 * a language token.
 */
export class FencedThinkingScanner {
	#buffer = "";
	/** The fence run that opened the current nested code block, or "" at top level. */
	#inner = "";
	/** Bytes of the leading (incomplete) line already returned as thinking. */
	#emitted = 0;

	/**
	 * Feed bytes and return thinking deltas plus close state. When `final`, the
	 * held tail resolves: a bare ` ``` ` or a ` ```<reply> ` fence closes the
	 * block (remainder becomes `rest`), otherwise it is unterminated thinking.
	 */
	feed(text: string, final: boolean): FencedThinkingResult {
		this.#buffer += text;
		let thinking = "";
		for (;;) {
			const nl = this.#buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.#buffer.slice(0, nl);
			if (!this.#inner) {
				const close = this.#closeRest(line);
				if (close !== undefined) {
					// Closer bytes are always held, so #emitted is 0 and nothing leaked.
					const rest = close + this.#buffer.slice(nl); // keep the newline with the reply
					this.#reset();
					return { thinking, closed: true, rest };
				}
			}
			// Content line (including an inner-fence open/close).
			thinking += this.#buffer.slice(this.#emitted, nl + 1);
			this.#updateInner(line);
			this.#buffer = this.#buffer.slice(nl + 1);
			this.#emitted = 0;
		}

		const tail = this.#buffer;
		if (this.#inner) {
			// Inside a nested block every byte is thinking content: emit eagerly,
			// keeping it buffered until the newline classifies the line.
			thinking += tail.slice(this.#emitted);
			this.#emitted = tail.length;
			return { thinking, closed: false, rest: "" };
		}

		if (final) {
			const close = this.#closeRestFinal(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
		} else {
			const close = this.#closeRestStreamingTail(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
			if (this.#mustHold(tail)) return { thinking, closed: false, rest: "" };
		}
		// Either final (flush the remainder) or a line that can no longer be a fence.
		thinking += tail.slice(this.#emitted);
		if (final) this.#reset();
		else this.#emitted = tail.length;
		return { thinking, closed: false, rest: "" };
	}

	/**
	 * Complete line close test. A bare backtick fence closes thinking; a
	 * language-token fence line opens an inner block; prose-like remainder is the
	 * inline visible reply.
	 */
	#closeRest(line: string): string | undefined {
		const m = BACKTICK_LEAD.exec(line);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return ""; // bare close (only whitespace)
		if (LANG_TOKEN.test(rest)) return undefined; // language-tagged inner opener
		return rest;
	}

	/** Final tail close test: EOF disambiguates any top-level backtick run as the closer. */
	#closeRestFinal(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		return rest.trim() === "" ? "" : rest;
	}

	/** Streaming tail close test: only a prose-like inline reply resolves the close. */
	#closeRestStreamingTail(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "" || LANG_TOKEN.test(rest)) return undefined;
		return rest;
	}

	/** Whether a top-level trailing partial is still undecided and must be held. */
	#mustHold(tail: string): boolean {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m) return false;
		const ticks = m[1]!.length;
		const rest = m[2]!;
		// A growing backtick run could still reach a fence. A complete run plus
		// a language-token prefix is also undecided until a newline confirms an
		// inner opener or a non-token character confirms an inline close.
		if (rest === "" || rest.trim() === "") return ticks >= 1 || /^ {0,3}$/.test(tail);
		return ticks >= 3 && LANG_TOKEN.test(rest);
	}

	#reset(): void {
		this.#buffer = "";
		this.#inner = "";
		this.#emitted = 0;
	}

	/** Toggle nested-fence state for a completed content line. */
	#updateInner(line: string): void {
		const fence = FENCE_LINE.exec(line);
		if (!fence) return;
		const run = fence[1]!;
		const info = fence[2]!.trim();
		if (!this.#inner) {
			// A top-level closer was already handled by #closeRest, so this opens a
			// nested code block (tilde fence, or backtick fence with a language token).
			this.#inner = run;
		} else if (run[0] === this.#inner[0] && run.length >= this.#inner.length && info === "") {
			// Closing fence: same char, at least as long, no info string.
			this.#inner = "";
		}
	}
}

type Tag = {
	readonly open: string;
	readonly close: string;
	readonly fenced?: boolean;
	/** Chat templates prefill this opener into the prompt, so a bare close can imply it. */
	readonly impliedOpen?: boolean;
};

/**
 * Every dialect's in-band thinking section in its canonical rendered form.
 * Plain (attribute-free) delimiters only — matching what models leak in
 * practice.
 */
const TAGS: readonly Tag[] = [
	// deepseek, glm, hermes, kimi, qwen3 (and anthropic/minimax/xml). DeepSeek-R1
	// and Qwen3-Thinking templates prefill the opener, so the model streams only
	// the close when the host does not split reasoning into its own field.
	{ open: "<think>", close: "</think>", impliedOpen: true },
	{ open: "<thinking>", close: "</thinking>" }, // anthropic, minimax, xml
	{ open: "<scratchpad>", close: "</scratchpad>" }, // anthropic
	{ open: "```thinking\n", close: "```", fenced: true }, // gemini fenced thinking
	{ open: "<|channel>thought\n", close: "<channel|>" }, // gemma reasoning channel
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (rendered)
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (bare leak)
];
const OPENS = TAGS.map(tag => tag.open);
const IMPLIED_OPEN_TAGS = TAGS.filter(tag => tag.impliedOpen);
const IMPLIED_OPEN_DELIMITERS = [...OPENS, ...IMPLIED_OPEN_TAGS.map(tag => tag.close)];

export interface ThinkingInbandScannerOptions {
	/**
	 * Report a bare reasoning close tag (no open seen) as an `impliedThinkingEnd`
	 * event instead of passing it through as text. Off by default: only a
	 * consumer that owns the whole message can reclassify the text before it.
	 */
	readonly impliedOpen?: boolean;
}

export class ThinkingInbandScanner implements ThinkingScanner {
	readonly #impliedOpen: boolean;
	#buffer = "";
	#closeTag = "";
	#thinking = "";
	/** Fence-aware close-matcher while inside a ` ```thinking ` block; undefined otherwise. */
	#fenced: FencedThinkingScanner | undefined;
	/** Backtick count that opened the Markdown code span/fence we are inside; 0 when not in code. */
	#codeTicks = 0;
	/** True when {@link #codeTicks} opened a fenced block (closes on a fence line), not an inline span. */
	#codeFenced = false;
	/**
	 * Leading-space count on the current output line, or -1 once a non-space
	 * character has appeared. Starts at 0 (line start) so a fence opening the
	 * stream — or one indented ≤3 spaces, as CommonMark allows — is recognized.
	 */
	#lineIndent = 0;

	constructor(options: ThinkingInbandScannerOptions = {}) {
		this.#impliedOpen = options.impliedOpen === true;
	}

	feed(text: string): ThinkingScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): ThinkingScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		return events;
	}

	#consume(final: boolean): ThinkingScanEvent[] {
		const events: ThinkingScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				// Run even with an empty buffer so a held partial close flushes on final.
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const close = this.#buffer.indexOf(this.#closeTag);
				if (close === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [this.#closeTag]);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, close), events);
				this.#buffer = this.#buffer.slice(close + this.#closeTag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				continue;
			}
			if (this.#codeTicks > 0) {
				if (this.#emitCode(final, events)) continue;
				break;
			}

			const hit = scanVisible(this.#buffer, final, this.#impliedOpen);
			if (hit.kind === "none") {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				break;
			}
			if (hit.index > 0) this.#emitText(this.#buffer.slice(0, hit.index), events);
			if (hit.kind === "hold") {
				this.#buffer = this.#buffer.slice(hit.index);
				break;
			}
			if (hit.kind === "impliedClose") {
				this.#buffer = this.#buffer.slice(hit.index + hit.tag.close.length);
				events.push({ type: "impliedThinkingEnd" });
				continue;
			}
			if (hit.kind === "code") {
				const fenced = hit.ticks >= 3 && this.#lineIndent >= 0 && this.#lineIndent <= 3;
				this.#emitText(this.#buffer.slice(hit.index, hit.index + hit.ticks), events);
				this.#buffer = this.#buffer.slice(hit.index + hit.ticks);
				this.#codeTicks = hit.ticks;
				this.#codeFenced = fenced;
				continue;
			}
			this.#buffer = this.#buffer.slice(hit.index + hit.tag.open.length);
			this.#closeTag = hit.tag.close;
			this.#thinking = "";
			if (hit.tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	/**
	 * Emit buffered content while inside a Markdown code region, suppressing
	 * reasoning-tag detection. A fenced block closes only on a fence line (a line
	 * of backticks ≥ the opener); an inline span closes on the first backtick run
	 * of exactly the opener length. Returns true when the region closed and the
	 * loop should continue, false when it held back and should break.
	 */
	#emitCode(final: boolean, events: ThinkingScanEvent[]): boolean {
		if (this.#codeFenced) {
			const end = findFenceCloseEnd(this.#buffer, this.#codeTicks, final);
			if (end !== -1) {
				this.#emitText(this.#buffer.slice(0, end), events);
				this.#buffer = this.#buffer.slice(end);
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return true;
			}
			if (final) {
				this.#emitText(this.#buffer, events);
				this.#buffer = "";
				this.#codeTicks = 0;
				this.#codeFenced = false;
				return false;
			}
			// Stream committed lines; hold only the last (possibly partial) fence line.
			const lastNl = this.#buffer.lastIndexOf("\n");
			if (lastNl !== -1) {
				this.#emitText(this.#buffer.slice(0, lastNl + 1), events);
				this.#buffer = this.#buffer.slice(lastNl + 1);
			}
			return false;
		}
		const close = findBacktickRun(this.#buffer, 0, this.#codeTicks);
		if (close !== -1 && (final || close + this.#codeTicks < this.#buffer.length)) {
			this.#emitText(this.#buffer.slice(0, close + this.#codeTicks), events);
			this.#buffer = this.#buffer.slice(close + this.#codeTicks);
			this.#codeTicks = 0;
			return true;
		}
		// No committed close yet: emit text, holding a trailing backtick run that
		// may still grow into — or past — the closing delimiter.
		const hold = final ? 0 : trailingBacktickRun(this.#buffer);
		this.#emitText(this.#buffer.slice(0, this.#buffer.length - hold), events);
		this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
		if (final) this.#codeTicks = 0;
		return false;
	}

	#emitText(text: string, events: ThinkingScanEvent[]): void {
		if (text.length === 0) return;
		events.push({ type: "text", text });
		this.#lineIndent = trailingLineIndent(text, this.#lineIndent);
	}

	#emitThinking(delta: string, events: ThinkingScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

/** Outcome of scanning idle visible text for the next reasoning-tag or code-span boundary. */
type VisibleHit =
	| { readonly kind: "tag"; readonly index: number; readonly tag: Tag }
	| { readonly kind: "impliedClose"; readonly index: number; readonly tag: Tag }
	| { readonly kind: "code"; readonly index: number; readonly ticks: number }
	| { readonly kind: "hold"; readonly index: number }
	| { readonly kind: "none" };

/**
 * Walk idle visible text for the earliest boundary: a leaked reasoning-tag open,
 * a bare close of an implied-open tag (when `impliedOpen`), a Markdown
 * code-span/fence opener (a backtick run), or — when more chunks may follow — a
 * held partial delimiter at the buffer tail.
 *
 * Reasoning tags win at any position so the gemini ` ```thinking ` fence is
 * healed instead of being read as a code fence. Backtick runs enter code mode so
 * a literal `<think>` inside inline code or a fenced block stays visible text.
 */
function scanVisible(buffer: string, final: boolean, impliedOpen: boolean): VisibleHit {
	const delimiters = impliedOpen ? IMPLIED_OPEN_DELIMITERS : OPENS;
	for (let i = 0; i < buffer.length; i++) {
		const tag = TAGS.find(candidate => buffer.startsWith(candidate.open, i));
		if (tag) return { kind: "tag", index: i, tag };
		if (impliedOpen) {
			const closed = IMPLIED_OPEN_TAGS.find(candidate => buffer.startsWith(candidate.close, i));
			if (closed) return { kind: "impliedClose", index: i, tag: closed };
		}
		if (!final) {
			const rest = buffer.slice(i);
			if (delimiters.some(delimiter => delimiter.length > rest.length && delimiter.startsWith(rest))) {
				return { kind: "hold", index: i };
			}
		}
		if (buffer[i] === "`") {
			const ticks = backtickRun(buffer, i);
			if (!final && i + ticks === buffer.length) return { kind: "hold", index: i };
			return { kind: "code", index: i, ticks };
		}
	}
	return { kind: "none" };
}

/** Length of the maximal backtick run beginning at `from`. */
function backtickRun(buffer: string, from: number): number {
	let end = from;
	while (end < buffer.length && buffer[end] === "`") end++;
	return end - from;
}

/** Index of the first maximal backtick run of exactly `ticks` at/after `from`, else -1. */
function findBacktickRun(buffer: string, from: number, ticks: number): number {
	for (let i = buffer.indexOf("`", from); i !== -1; i = buffer.indexOf("`", i)) {
		const run = backtickRun(buffer, i);
		if (run === ticks) return i;
		i += run;
	}
	return -1;
}

/** Length of a backtick run that ends at the buffer tail; 0 when the tail is not a backtick. */
function trailingBacktickRun(buffer: string): number {
	let start = buffer.length;
	while (start > 0 && buffer[start - 1] === "`") start--;
	return buffer.length - start;
}

/**
 * Leading-space count of the line at the tail of `text`, continuing from the
 * prior line's `indent` state (see {@link ThinkingInbandScanner.#lineIndent}).
 * Returns -1 once any non-space character has appeared on the current line.
 */
function trailingLineIndent(text: string, prior: number): number {
	const lastNl = text.lastIndexOf("\n");
	let indent = lastNl === -1 ? prior : 0;
	for (let i = lastNl + 1; i < text.length; i++) {
		if (indent === -1) break;
		indent = text[i] === " " ? indent + 1 : -1;
	}
	return indent;
}

/**
 * Index just past the first closing fence line for a fenced block opened with
 * `ticks` backticks, or -1 when none is committed yet. A closing fence is a whole
 * line whose trimmed content is only backticks, at least `ticks` of them. A line
 * without a terminating newline is committed only when `final` (no more input can
 * extend it into a non-fence line).
 */
function findFenceCloseEnd(buffer: string, ticks: number, final: boolean): number {
	for (let start = 0; start <= buffer.length; ) {
		const nl = buffer.indexOf("\n", start);
		const terminated = nl !== -1;
		const line = buffer.slice(start, terminated ? nl : buffer.length).trim();
		if (line.length >= ticks && isAllBackticks(line) && (terminated || final)) {
			return terminated ? nl + 1 : buffer.length;
		}
		if (!terminated) break;
		start = nl + 1;
	}
	return -1;
}

/** True when `text` is non-empty and every character is a backtick. */
function isAllBackticks(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text[i] !== "`") return false;
	return text.length > 0;
}
