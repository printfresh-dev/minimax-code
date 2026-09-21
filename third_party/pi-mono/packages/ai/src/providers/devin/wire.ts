/**
 * Devin (Codeium Cascade) wire constants shared by the pi-ai provider.
 * Vendored from oh-my-pi's `catalog/src/wire/devin.ts` + `wire/devin-proto.ts`.
 */

import { gunzipSync } from "node:zlib";
import { fromBinary, type MessageCodec, type ProtoMessage } from "./protobuf.ts";

/** Base host for Codeium/Windsurf's Cascade API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

/**
 * Released Devin CLI request identity. The backend gates behavior on this
 * tuple: `ideType: "chisel"` is what unlocks router assignment (`AssignModel`)
 * and the CLI model surface, which the older Windsurf identity does not reach.
 */
const DEVIN_CLI_METADATA = {
	ideName: "devin-cli",
	ideType: "chisel",
	ideVersion: "3000.6.2",
	extensionName: "chisel",
	extensionVersion: "3000.6.2",
	locale: DEVIN_LOCALE,
	os: DEVIN_OS,
} as const;

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Fields for `Metadata` on released-CLI calls (`GetUserJwt`, `AssignModel`,
 * `GetChatMessage`, `GetUserStatus`). `userJwt` stays empty for the calls the
 * CLI makes with the session token alone (auth, model assignment, usage).
 */
export function devinCliMetadata(apiKey: string | undefined, userJwt = "") {
	return {
		apiKey: normalizeDevinSessionToken(apiKey),
		userJwt,
		...DEVIN_CLI_METADATA,
	};
}

/**
 * Decode a unary Devin Connect response. Edges variously return bare protobuf
 * or a gzipped protobuf body; `fetch` normally decompresses first, so the
 * direct decode is attempted before the gzip fallback. Returns `null` when
 * neither representation decodes against `schema`.
 */
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array,
): TMessage | null {
	try {
		return fromBinary(schema, payload);
	} catch {
		try {
			return fromBinary(schema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}
