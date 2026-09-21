import { parseStreamingJson } from "./json-parse.ts";

const LF = 0x0a;
const CR = 0x0d;

export class AbortError extends Error {
	constructor(signal: AbortSignal) {
		const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
		super(`Aborted: ${message}`, { cause: signal.reason });
		this.name = "AbortError";
	}
}

/**
 * Abortable async iteration over a {@link ReadableStream}. Reads the source
 * reader directly and yields each chunk, so the consumer's `for await` drives a
 * single read loop with no intermediate stream or per-chunk enqueue.
 *
 * Unlike `stream.pipeThrough(..., { signal })`, this explicitly cancels the
 * source reader on abort or early `break`, propagating HTTP-client disconnects
 * and watchdog timeouts to the backend request instead of only stopping the
 * local consumer. On abort it throws {@link AbortError}; the lock is released
 * on completion, abort, throw, or early exit. The source is cancelled only on
 * abort or early exit — never on natural EOF.
 */
export async function* abortableSource<T>(stream: ReadableStream<T>, signal?: AbortSignal): AsyncGenerator<T> {
	if (signal?.aborted) throw new AbortError(signal);
	const reader = stream.getReader();
	let onAbort: (() => void) | undefined;
	if (signal) {
		onAbort = () => {
			void reader.cancel(signal.reason).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
	}
	let completed = false;
	try {
		for (;;) {
			const result = await reader.read();
			if (signal?.aborted) throw new AbortError(signal);
			if (result.done) {
				completed = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		// Propagate early-exit (`break`/`return`) and abort to the backend; skip
		// on natural EOF where the stream already closed itself.
		if (!completed) {
			try {
				await reader.cancel();
			} catch {}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

/**
 * Amortized byte accumulator for chunked stream readers.
 *
 * Holds the unconsumed tail of a stream in a single growing `Buffer` so that
 * appending N chunks costs O(total bytes) instead of re-copying the whole
 * prefix per chunk. Backs {@link readSseEvents}; also usable directly when a
 * reader needs its own framing loop (see `consume` and `flush`).
 */
export class ConcatSink {
	#space?: Buffer;
	#length = 0;
	#skipLeadingLf = false;

	#ensureCapacity(size: number): Buffer {
		const space = this.#space;
		if (space && space.length >= size) return space;
		const nextSize = space ? Math.max(size, space.length * 2) : size;
		const next = Buffer.allocUnsafe(nextSize);
		if (space && this.#length > 0) {
			space.copy(next, 0, 0, this.#length);
		}
		this.#space = next;
		return next;
	}

	append(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) return;
		const offset = this.#length;
		const space = this.#ensureCapacity(offset + n);
		space.set(chunk, offset);
		this.#length += n;
	}

	reset(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) {
			this.#length = 0;
			return;
		}
		const space = this.#ensureCapacity(n);
		space.set(chunk, 0);
		this.#length = n;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	/**
	 * The buffered bytes as a live view — invalidated by the next `append`,
	 * `reset` or `consume`.
	 */
	flush(): Uint8Array | undefined {
		if (!this.#length) return undefined;
		return this.#space!.subarray(0, this.#length);
	}

	/** Drop the first `count` buffered bytes, keeping the remainder. */
	consume(count: number) {
		if (count <= 0) return;
		if (count >= this.#length) {
			this.#length = 0;
			return;
		}
		this.#space!.copyWithin(0, count, this.#length);
		this.#length -= count;
	}

	clear() {
		this.#length = 0;
	}

	appendAndFlushText(chunk: Uint8Array, decoder: { decode(input?: Uint8Array): string }): string | undefined {
		let start = 0;
		if (this.#skipLeadingLf) {
			if (chunk.length === 0) return undefined;
			this.#skipLeadingLf = false;
			if (chunk[0] === LF) start = 1;
		}

		const lastLineEnd = Math.max(chunk.lastIndexOf(LF), chunk.lastIndexOf(CR));
		if (lastLineEnd < start) {
			if (start < chunk.length) this.append(chunk.subarray(start));
			return undefined;
		}

		const completeEnd = lastLineEnd + 1;
		this.#skipLeadingLf = chunk[lastLineEnd] === CR && completeEnd === chunk.length;
		let text: string;
		if (this.isEmpty) {
			const complete = start === 0 && completeEnd === chunk.length ? chunk : chunk.subarray(start, completeEnd);
			text = decoder.decode(complete);
		} else {
			this.append(chunk.subarray(start, completeEnd));
			text = decoder.decode(this.flush());
			this.clear();
		}
		if (completeEnd < chunk.length) {
			this.append(chunk.subarray(completeEnd));
		}
		return text;
	}
}

// =============================================================================
// SSE (Server-Sent Events)
// =============================================================================

/**
 * A single Server-Sent Event dispatched on a blank-line boundary.
 *
 * - `event` is the value of the most recent `event:` field, or `null` if none.
 * - `data` is the concatenation (joined by `\n`) of every `data:` field in the
 *   event, exactly as required by the SSE spec.
 * - `raw` is the list of decoded non-empty lines that made up the event,
 *   preserved for diagnostic context (error reporting, debugging). The
 *   dispatching blank line is not included.
 * - `id` and `retry` are present only when the event carried valid fields with
 *   those names. Control-only events are yielded so reconnecting transports can
 *   retain the cursor and server-requested retry interval.
 */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	/**
	 * Decoded wire lines for this event (`event:`/`data:`/etc.), for the
	 * diagnostic pipeline. Populated only when the reader opts in via
	 * {@link ReadSseEventsOptions.captureRaw} (or attaches an `onSseEvent`
	 * observer to the JSON readers, which opt in automatically); otherwise
	 * `[]`.
	 */
	raw: string[];
	id?: string;
	retry?: number;
}

interface SseEventState {
	event: string | null;
	// `data` accumulates across multiple `data:` lines per the SSE spec, joined
	// by `\n`. We keep the running string here and append as lines arrive instead
	// of buffering an array and joining at flush. `null` means "no data: field
	// seen yet" (distinct from a `data:` field with an empty value).
	data: string | null;
	// Diagnostic wire lines, captured only when a reader asked for them (see
	// `readSseEventsOptions.captureRaw`): per-frame array+slice allocation on
	// the token path otherwise. `null` means capture is off.
	raw: string[] | null;
	id?: string;
	retry?: number;
}

// Complete lines are decoded in one batch per source chunk. Each batch ends on
// an ASCII line-ending byte, which cannot split a multi-byte UTF-8 sequence.
const SSE_DECODER = new TextDecoder("utf-8");

const trailingEvents = new WeakSet<ServerSentEvent>();

function flushSseEvent(state: SseEventState): ServerSentEvent | null {
	if (state.event === null && state.data === null && state.id === undefined && state.retry === undefined) {
		if (state.raw !== null) state.raw = [];
		return null;
	}
	const event: ServerSentEvent = {
		event: state.event,
		data: state.data ?? "",
		raw: state.raw ?? [],
	};
	if (state.id !== undefined) event.id = state.id;
	if (state.retry !== undefined) event.retry = state.retry;
	state.event = null;
	state.data = null;
	if (state.raw !== null) state.raw = [];
	state.id = undefined;
	state.retry = undefined;
	return event;
}

function pushSseLine(line: string, state: SseEventState): ServerSentEvent | null {
	if (line.length === 0) return flushSseEvent(state);

	// Comment line: keep in `raw` for diagnostic context, skip parsing.
	if (line.charCodeAt(0) === 0x3a /* ':' */) {
		state.raw?.push(line);
		return null;
	}

	state.raw?.push(line);

	const colon = line.indexOf(":");
	const fieldName = colon === -1 ? line : line.slice(0, colon);
	let value = colon === -1 ? "" : line.slice(colon + 1);
	if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		if (state.data === null) {
			state.data = value;
		} else {
			state.data += "\n";
			state.data += value;
		}
	} else if (fieldName === "id") {
		if (!value.includes("\0")) state.id = value;
	} else if (fieldName === "retry" && value.length > 0) {
		let valid = true;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code < 0x30 || code > 0x39) {
				valid = false;
				break;
			}
		}
		if (valid) {
			const retry = Number(value);
			if (Number.isSafeInteger(retry)) state.retry = retry;
		}
	}
	return null;
}

/**
 * Stream raw Server-Sent Events from an HTTP response body.
 *
 * Yields one `ServerSentEvent` per blank-line dispatch. The consumer is
 * responsible for parsing `data` (e.g. JSON, plain text, error envelope).
 * Use `readSseJson` instead when every event is a single `data:` JSON object
 * and you don't need access to the `event:` field.
 *
 * Internally backed by a Buffer-based reader (`ConcatSink`) that batches all
 * complete lines in each source chunk into one UTF-8 decode.
 */
export interface ReadSseEventsOptions {
	/**
	 * Capture per-line wire text into `event.raw` for the diagnostic
	 * pipeline (`onSseEvent` observers, raw-SSE viewer). Off by default:
	 * every frame otherwise pays an array allocation plus one string slice
	 * per line on the token path.
	 */
	captureRaw?: boolean;
}

export async function* readSseEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	options?: ReadSseEventsOptions,
): AsyncGenerator<ServerSentEvent> {
	const lineBuffer = new ConcatSink();
	const captureRaw = options?.captureRaw === true;
	const state: SseEventState = { event: null, data: null, raw: captureRaw ? [] : null };
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			const text = lineBuffer.appendAndFlushText(chunk, SSE_DECODER);
			if (text === undefined) continue;
			let start = 0;
			while (start < text.length) {
				let lineEnd = start;
				while (lineEnd < text.length) {
					const code = text.charCodeAt(lineEnd);
					if (code === LF || code === CR) break;
					lineEnd++;
				}
				const event = pushSseLine(text.slice(start, lineEnd), state);
				if (event) yield event;
				if (text.charCodeAt(lineEnd) === CR && text.charCodeAt(lineEnd + 1) === LF) {
					lineEnd++;
				}
				start = lineEnd + 1;
			}
		}
		// Treat any trailing partial line (no terminating line ending) as complete.
		if (!lineBuffer.isEmpty) {
			const tail = lineBuffer.flush();
			if (tail) {
				lineBuffer.clear();
				const event = pushSseLine(SSE_DECODER.decode(tail), state);
				if (event) {
					trailingEvents.add(event);
					yield event;
				}
			}
		}
		// Real services don't always close on a blank line — flush any pending event.
		const trailing = flushSseEvent(state);
		if (trailing) {
			trailingEvents.add(trailing);
			yield trailing;
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export type SseEventObserver = (event: ServerSentEvent) => void;

function notifySseEventObserver(observer: SseEventObserver | undefined, event: ServerSentEvent): void {
	if (!observer) return;
	try {
		observer(event);
	} catch {
		// Diagnostic observers must never perturb provider stream consumption.
	}
}

function isRecoverableTrailingJson(data: string): boolean {
	const first = data.trimStart()[0];
	if (first !== "{" && first !== "[") return false;
	// Best-effort relaxed recovery via the shared streaming JSON parser: a
	// container-shaped final event that fails strict `JSON.parse` is treated as a
	// cut-off (or lightly malformed) stream tail and ends iteration cleanly instead
	// of throwing. Non-container final events (plain-text errors, bare scalars) are
	// not recoverable and still surface as a SyntaxError.
	const recovered = parseStreamingJson<unknown>(data);
	return typeof recovered === "object" && recovered !== null;
}

/**
 * One dispatched `data:` frame from {@link readSseFrames}: either the parsed JSON
 * value, or the text of a frame `JSON.parse` rejected together with the
 * `SyntaxError` it raised (so the strict reader can rethrow it unchanged).
 */
type SseFrame<T> = { ok: true; value: T } | { ok: false; raw: string; error: SyntaxError };

/**
 * Shared `data:`-line framing for {@link readSseJson}: skips empty events,
 * stops at the OpenAI `[DONE]` sentinel, notifies the diagnostic observer, and
 * treats a container-shaped stream tail as a clean end of iteration.
 */
async function* readSseFrames<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
): AsyncGenerator<SseFrame<T>> {
	// The diagnostic observer is the only reader of `raw`; capture it exactly
	// when one is attached so the hot path stays allocation-free.
	for await (const sse of readSseEvents(stream, signal, onEvent ? { captureRaw: true } : undefined)) {
		const isTrailing = trailingEvents.has(sse);
		notifySseEventObserver(onEvent, sse);
		const data = sse.data;
		if (data === "" || data === "[DONE]") {
			if (data === "[DONE]") return;
			continue;
		}
		try {
			yield { ok: true, value: JSON.parse(data) as T };
		} catch (err) {
			if (err instanceof SyntaxError && isTrailing && isRecoverableTrailingJson(data)) {
				return;
			}
			if (err instanceof SyntaxError) {
				yield { ok: false, raw: data, error: err };
				continue;
			}
			throw err;
		}
	}
}

/**
 * Stream parsed JSON objects from SSE `data:` lines.
 *
 * Thin wrapper over {@link readSseEvents}: yields one parsed JSON value per
 * dispatched SSE event, skipping events with empty `data` and stopping at the
 * OpenAI-style `[DONE]` sentinel.
 */
export async function* readSseJson<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
): AsyncGenerator<T> {
	for await (const frame of readSseFrames<T>(stream, signal, onEvent)) {
		if (!frame.ok) throw frame.error;
		yield frame.value;
	}
}
