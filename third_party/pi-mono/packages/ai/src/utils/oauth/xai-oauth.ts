/**
 * xAI OAuth flow (Grok CLI / SuperGrok / X Premium+)
 * RFC 8628 device authorization grant against auth.x.ai.
 */

import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type {
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "./types.ts";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const AUTH_BASE_URL = "https://auth.x.ai";
const DEVICE_CODE_URL = `${AUTH_BASE_URL}/oauth2/device/code`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth2/token`;
const USERINFO_URL = `${AUTH_BASE_URL}/oauth2/userinfo`;
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval?: number;
	expires_in?: number;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
};

type UserinfoResponse = {
	email?: string;
	sub?: string;
};

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

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postForm(
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<{ body: unknown; response: Response }> {
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
	let body: unknown;
	try {
		body = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	return { body, response };
}

async function startDeviceFlow(
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<DeviceCodeResponse> {
	const { body, response } = await postForm(
		DEVICE_CODE_URL,
		{ client_id: CLIENT_ID, scope: SCOPES },
		signal,
		fetchImpl,
	);

	if (!response.ok) {
		throw new Error(
			`xAI device authorization failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`,
		);
	}

	const data = body as Partial<DeviceCodeResponse> | undefined;
	if (
		!data ||
		typeof data.device_code !== "string" ||
		typeof data.user_code !== "string" ||
		typeof data.verification_uri !== "string"
	) {
		throw new Error("xAI device authorization response missing required fields");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		verification_uri_complete:
			typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : undefined,
		interval: typeof data.interval === "number" ? data.interval : undefined,
		expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
	};
}

async function pollForToken(
	device: DeviceCodeResponse,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<TokenResponse> {
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		signal,
		poll: async () => {
			const { body, response } = await postForm(
				TOKEN_URL,
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: CLIENT_ID,
					device_code: device.device_code,
				},
				signal,
				fetchImpl,
			);

			const token = (body ?? {}) as TokenResponse;
			if (response.ok && token.error === undefined) {
				return { status: "complete", value: token };
			}

			switch (token.error) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return { status: "slow_down" };
				case "expired_token":
					return { status: "failed", message: "xAI device code expired; restart the login" };
				case "access_denied":
					return { status: "failed", message: "xAI device authorization was denied" };
				default:
					return {
						status: "failed",
						message:
							`xAI device token request failed: ${response.status} ${token.error_description ?? token.error ?? ""}`.trim(),
					};
			}
		},
	});
}

/** Fetch optional OIDC userinfo; failures leave identity fields unset. */
async function fetchUserinfo(
	accessToken: string,
	signal?: AbortSignal,
	fetchImpl: typeof globalThis.fetch = fetch,
): Promise<UserinfoResponse | null> {
	try {
		const response = await fetchImpl(USERINFO_URL, {
			headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
			signal: requestSignal(signal),
		});
		if (!response.ok) return null;
		return (await response.json()) as UserinfoResponse;
	} catch {
		return null;
	}
}

function credentialsFromToken(token: TokenResponse, userinfo: UserinfoResponse | null): OAuthCredentials {
	if (!token.access_token || !token.refresh_token || typeof token.expires_in !== "number") {
		throw new Error(`xAI token response missing fields: ${JSON.stringify(token)}`);
	}

	const claims = decodeJwtPayload(token.access_token);
	const accountId =
		(typeof claims?.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined) ?? userinfo?.sub;

	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
		...(accountId ? { accountId } : {}),
		...(userinfo?.email ? { email: userinfo.email } : {}),
	};
}

/**
 * Login with xAI OAuth (device code flow)
 */
export async function loginXaiOAuth(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;

	options.onProgress?.("Requesting device authorization...");
	const device = await startDeviceFlow(options.signal, fetchImpl);

	options.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri_complete ?? device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	options.onProgress?.("Waiting for device authorization...");
	const token = await pollForToken(device, options.signal, fetchImpl);
	const userinfo = await fetchUserinfo(token.access_token ?? "", options.signal, fetchImpl);
	return credentialsFromToken(token, userinfo);
}

/**
 * Refresh xAI OAuth token
 */
export async function refreshXaiOAuthToken(
	credentials: OAuthCredentials,
	fetchImpl?: typeof globalThis.fetch,
): Promise<OAuthCredentials> {
	const { body, response } = await postForm(
		TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		},
		undefined,
		fetchImpl,
	);

	const token = (body ?? {}) as TokenResponse;
	if (!response.ok || !token.access_token) {
		throw new Error(
			`xAI token refresh failed: ${response.status} ${token.error_description ?? token.error ?? ""}`.trim(),
		);
	}

	const userinfo = await fetchUserinfo(token.access_token, undefined, fetchImpl);
	const claims = decodeJwtPayload(token.access_token);
	const accountId =
		(typeof claims?.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined) ??
		userinfo?.sub ??
		(typeof credentials.accountId === "string" ? credentials.accountId : undefined);
	const email = userinfo?.email ?? (typeof credentials.email === "string" ? credentials.email : undefined);

	return {
		access: token.access_token,
		refresh: token.refresh_token ?? credentials.refresh,
		expires:
			typeof token.expires_in === "number"
				? Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS
				: credentials.expires,
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
	};
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok or X Premium+)",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXaiOAuth({
			onDeviceCode: callbacks.onDeviceCode,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
			fetch: callbacks.fetch,
		});
	},

	async refreshToken(
		credentials: OAuthCredentials,
		options?: { fetch?: typeof globalThis.fetch },
	): Promise<OAuthCredentials> {
		return refreshXaiOAuthToken(credentials, options?.fetch);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
