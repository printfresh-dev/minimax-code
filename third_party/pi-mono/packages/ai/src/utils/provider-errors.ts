import type { StopReason } from "../types.ts";
import { extractHttpStatusFromError, isRetryableError, isRetryableStatus } from "./fetch-retry.ts";

/**
 * Minimal provider error taxonomy for the raw-transport providers
 * (google-gemini-cli, devin). The SDK-backed providers surface plain `Error`s;
 * these classes carry the extra classification (HTTP status, failure kind)
 * those transports need for endpoint failover and retry decisions.
 */

export class AbortError extends Error {
	constructor(message = "Request was aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export class StreamTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StreamTimeoutError";
	}
}

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

export class ConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigurationError";
	}
}

export class OAuthError extends Error {
	readonly info?: Record<string, unknown>;

	constructor(message: string, info?: Record<string, unknown>) {
		super(message);
		this.name = "OAuthError";
		this.info = info;
	}
}

export type ProviderResponseErrorKind =
	| "empty-body"
	| "empty-output"
	| "runtime"
	| "content-blocked"
	| "output"
	| "incomplete-stream"
	| "envelope";

export class ProviderResponseError extends Error {
	readonly provider?: string;
	readonly kind?: ProviderResponseErrorKind;

	constructor(message: string, info?: { provider?: string; kind?: ProviderResponseErrorKind }) {
		super(message);
		this.name = "ProviderResponseError";
		this.provider = info?.provider;
		this.kind = info?.kind;
	}
}

/** HTTP error carrying the response status (and headers) for classification. */
export class ApiHttpError extends Error {
	readonly status: number;
	readonly headers?: Headers;

	constructor(message: string, status: number, info?: { headers?: Headers }) {
		super(message);
		this.name = "ApiHttpError";
		this.status = status;
		this.headers = info?.headers;
	}
}

/** `true` for HTTP statuses worth retrying or failing over on (408, 429, 5xx). */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && isRetryableStatus(status);
}

/** `true` when an arbitrary thrown value looks transient (network, timeout, 5xx, …). */
export function isRetriableError(error: unknown): boolean {
	return isRetryableError(error);
}

export { extractHttpStatusFromError };

/** Marker for errors that should be treated as context-window overflow upstream. */
const kContextOverflow = Symbol("provider.error.contextOverflow");

/** Flag an error as a context-overflow failure for the session recovery path. */
export function markContextOverflow(error: Error): Error {
	(error as unknown as Record<symbol, unknown>)[kContextOverflow] = true;
	return error;
}

export function isContextOverflowError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as unknown as Record<symbol, unknown>)[kContextOverflow] === true
	);
}

export interface FinalizedStreamError {
	stopReason: Extract<StopReason, "error" | "aborted">;
	status?: number;
	message: string;
}

/**
 * Translate a thrown value into the terminal fields of an `AssistantMessage`:
 * the stop reason, an HTTP status when one is recoverable, and a message that
 * keeps the context-overflow marker detectable by `isContextOverflow`.
 */
export function finalizeStreamError(error: unknown, options?: { signal?: AbortSignal }): FinalizedStreamError {
	const aborted = options?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
	const status = extractHttpStatusFromError(error);
	let message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
	if (isContextOverflowError(error) && !/context[_ ]length[_ ]exceeded/i.test(message)) {
		message = `${message} (context_length_exceeded)`;
	}
	return { stopReason: aborted ? "aborted" : "error", status, message };
}
