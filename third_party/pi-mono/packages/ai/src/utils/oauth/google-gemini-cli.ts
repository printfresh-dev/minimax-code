/**
 * Google Gemini CLI OAuth flow (Cloud Code Assist)
 * Authorization-code flow (no PKCE, confidential client) with a local
 * loopback callback server, followed by Cloud Code Assist project discovery.
 */

import type { createServer, Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
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

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const SCOPES =
	"https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

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
			throw new Error("Google Gemini CLI OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function createState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
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

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
				res.end(oauthErrorHtml("Google authentication did not complete.", `Error: ${error}`));
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
			res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
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

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
};

async function postForm(
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponse> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Google token request failed (${response.status}): ${text || response.statusText}`);
	}

	return JSON.parse(text) as TokenResponse;
}

async function exchangeAuthorizationCode(
	code: string,
	redirectUri: string,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponse> {
	return postForm(
		TOKEN_URL,
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
		},
		signal,
		fetchImpl,
	);
}

/** Fetch optional OIDC userinfo; failures leave identity fields unset. */
async function fetchUserinfo(
	accessToken: string,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<{ email?: string } | null> {
	try {
		const response = await fetchImpl(USERINFO_URL, {
			headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
			signal: requestSignal(signal),
		});
		if (!response.ok) return null;
		return (await response.json()) as { email?: string };
	} catch {
		return null;
	}
}

function geminiCliUserAgent(): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/gemini-3.1-pro-preview (${platform}; ${arch}; terminal)`;
}

function cloudCodeHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": geminiCliUserAgent(),
		"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
	};
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	name?: string;
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

interface GoogleRpcErrorResponse {
	error?: {
		details?: Array<{ reason?: string }>;
	};
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	if (!("error" in payload)) return false;
	const error = (payload as GoogleRpcErrorResponse).error;
	if (!error?.details || !Array.isArray(error.details)) return false;
	return error.details.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new Error("Login cancelled"));
	}
	const { promise, resolve, reject } = promiseWithResolvers<void>();
	const onAbort = () => {
		clearTimeout(timeout);
		reject(new Error("Login cancelled"));
	};
	const timeout = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	onProgress?: (message: string) => void,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<LongRunningOperationResponse> {
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})...`);
			await abortableSleep(POLL_INTERVAL_MS, signal);
		}
		if (signal?.aborted) throw new Error("Login cancelled");

		const response = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
			method: "GET",
			headers,
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as LongRunningOperationResponse;
		if (data.done) {
			return data;
		}
	}

	throw new Error(`Project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`);
}

/**
 * Resolve the Cloud Code Assist project for this account: loadCodeAssist
 * first, onboardUser + LRO polling when the account has no project yet, and
 * finally the "default" project id when the backend reports none.
 */
async function discoverProject(
	accessToken: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<string> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = cloudCodeHeaders(accessToken);

	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
		signal: requestSignal(signal),
	});

	let data: LoadCodeAssistPayload;

	if (!loadResponse.ok) {
		let errorPayload: unknown;
		try {
			errorPayload = await loadResponse.clone().json();
		} catch {
			errorPayload = undefined;
		}

		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			const errorText = await loadResponse.text();
			throw new Error(
				`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
			);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistPayload;
	}

	if (data.currentTier) {
		return data.cloudaicompanionProject ?? envProjectId ?? "default";
	}

	const tier = data.allowedTiers?.find((t) => t.isDefault) ?? { id: TIER_LEGACY };
	const tierId = tier.id ?? TIER_FREE;

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");

	const onboardBody: Record<string, unknown> = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};

	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
	}

	const onboardResponse = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody),
		signal: requestSignal(signal),
	});

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(
			`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
		);
	}

	let lroData = (await onboardResponse.json()) as LongRunningOperationResponse;

	if (!lroData.done && lroData.name) {
		lroData = await pollOperation(lroData.name, headers, signal, onProgress, fetchImpl);
	}

	return lroData.response?.cloudaicompanionProject?.id ?? envProjectId ?? "default";
}

/**
 * Login with Google Gemini CLI OAuth (authorization code, no PKCE)
 */
export async function loginGoogleGeminiCli(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const state = createState();
	const server = await startCallbackServer(state);

	let code: string | undefined;
	const redirectUri = server.redirectUri;

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			state,
			access_type: "offline",
			prompt: "consent",
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete the sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
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
		const token = await exchangeAuthorizationCode(code, redirectUri, options.signal, fetchImpl);

		if (!token.access_token || !token.refresh_token || typeof token.expires_in !== "number") {
			throw new Error(`Google token response missing fields: ${JSON.stringify(token)}`);
		}

		const userinfo = await fetchUserinfo(token.access_token, options.signal, fetchImpl);
		const projectId = await discoverProject(
			token.access_token,
			options.onProgress,
			options.signal,
			fetchImpl,
		);

		return {
			access: token.access_token,
			refresh: token.refresh_token,
			expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
			projectId,
			...(userinfo?.email ? { email: userinfo.email } : {}),
		};
	} finally {
		server.server.close();
	}
}

/**
 * Refresh Google Gemini CLI OAuth token
 */
export async function refreshGoogleGeminiCliToken(
	credentials: OAuthCredentials,
	fetchImpl?: typeof globalThis.fetch,
): Promise<OAuthCredentials> {
	if (!credentials.projectId) {
		throw new Error("google-gemini-cli credentials are missing projectId; sign in again");
	}

	const token = await postForm(
		TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: credentials.refresh,
		},
		undefined,
		fetchImpl,
	);

	if (!token.access_token) {
		throw new Error(`Google token refresh response missing access_token: ${JSON.stringify(token)}`);
	}

	return {
		...credentials,
		access: token.access_token,
		refresh: token.refresh_token ?? credentials.refresh,
		expires:
			typeof token.expires_in === "number"
				? Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS
				: credentials.expires,
	};
}

export const googleGeminiCliOAuthProvider: OAuthProviderInterface = {
	id: "google-gemini-cli",
	name: "Google Cloud Code Assist (Gemini CLI)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGoogleGeminiCli({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
			fetch: callbacks.fetch,
		});
	},

	async refreshToken(
		credentials: OAuthCredentials,
		options?: { fetch?: typeof globalThis.fetch },
	): Promise<OAuthCredentials> {
		return refreshGoogleGeminiCliToken(credentials, options?.fetch);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return JSON.stringify({ token: credentials.access, projectId: credentials.projectId });
	},
};
