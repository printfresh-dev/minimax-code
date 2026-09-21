/**
 * Devin OAuth flow (Devin CLI)
 * Authorization-code + PKCE flow against app.devin.ai with a local loopback
 * callback server; the CLI token endpoint returns a session JWT.
 */

import type { createServer, Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProviderInterface,
} from "./types.ts";

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
const TOKEN_URL = "https://api.devin.ai/auth/cli/token";
const API_ENDPOINT = "https://api.devin.ai";
const ENTERPRISE_URL = "https://app.devin.ai";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const REQUEST_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Session JWTs without an `exp` claim are treated as valid for one year. */
const EXPIRES_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

/** ES2024 `Promise.withResolvers` stand-in for the ES2022 target. */
function promiseWithResolvers<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Devin OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = atob(payload);
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Epoch ms of the JWT `exp` claim minus skew, or undefined when absent/invalid. */
function jwtExpiryMs(token: string): number | undefined {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 - EXPIRY_SKEW_MS : undefined;
}

/**
 * Start the loopback callback server. Falls back to a random port when the
 * preferred port is already bound; the redirect URI always reflects the port
 * actually bound.
 */
async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer: createHttpServer } = await getNodeApis();

	const waitForCode = promiseWithResolvers<{ code: string; state: string } | null>();
	let waitSettled = false;
	const settleWait = (value: { code: string; state: string } | null) => {
		if (waitSettled) return;
		waitSettled = true;
		waitForCode.resolve(value);
	};

	const listening = promiseWithResolvers<CallbackServerInfo>();

	const server = createHttpServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Devin authentication did not complete.", `Error: ${error}`));
				return;
			}

			if (!code || !state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing code or state parameter."));
				return;
			}

			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml("Devin authentication completed. You can close this window."));
			settleWait({ code, state });
		} catch {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Internal error");
		}
	});

	let retriedWithRandomPort = false;
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (!retriedWithRandomPort && err.code === "EADDRINUSE") {
			retriedWithRandomPort = true;
			server.listen(0, CALLBACK_HOST);
			return;
		}
		listening.reject(err);
	});

	server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : CALLBACK_PORT;
		listening.resolve({
			server,
			redirectUri: `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`,
			cancelWait: () => {
				settleWait(null);
			},
			waitForCode: () => waitForCode.promise,
		});
	});

	return listening.promise;
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<string> {
	let response: Response;
	try {
		response = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ code, code_verifier: verifier }),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Devin token exchange failed (${response.status}): ${text || response.statusText}`);
	}

	let data: { token?: string };
	try {
		data = JSON.parse(text) as { token?: string };
	} catch {
		throw new Error(`Devin token exchange returned invalid JSON: ${text.slice(0, 500)}`);
	}

	if (typeof data.token !== "string" || data.token.length === 0) {
		throw new Error(`Devin token response missing token: ${text.slice(0, 500)}`);
	}

	return data.token;
}

function credentialsFromToken(token: string): OAuthCredentials {
	return {
		access: token,
		refresh: token,
		expires: jwtExpiryMs(token) ?? Date.now() + EXPIRES_FALLBACK_MS,
		apiEndpoint: API_ENDPOINT,
		enterpriseUrl: ENTERPRISE_URL,
	};
}

/**
 * Login with Devin OAuth (authorization code + PKCE)
 */
export async function loginDevin(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const server = await startCallbackServer(state);

	let code: string | undefined;
	const redirectUri = server.redirectUri;

	try {
		const authParams = new URLSearchParams({
			response_type: "code",
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			prompt: "select_account",
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Sign in to Devin in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== state) {
					throw new Error("OAuth state mismatch");
				}
				code = parsed.code;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== state) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: redirectUri,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		const token = await exchangeAuthorizationCode(code, verifier, options.signal, fetchImpl);
		return credentialsFromToken(token);
	} finally {
		server.server.close();
	}
}

export const devinOAuthProvider: OAuthProviderInterface = {
	id: "devin",
	name: "Devin",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginDevin({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
			fetch: callbacks.fetch,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		// Devin CLI session tokens have no refresh grant: the JWT is returned
		// unchanged while it is still valid and re-login is required past expiry.
		const expires = jwtExpiryMs(credentials.access) ?? credentials.expires;
		if (Date.now() >= expires) {
			throw new Error("Devin session token expired; sign in again");
		}
		return credentials;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
