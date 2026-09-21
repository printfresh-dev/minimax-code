// Third-party OAuth provider ids shared by the runtime, the TUI and the CLI.
//
// These providers authenticate through the pi-ai OAuth registry
// (`@earendil-works/pi-ai` `getOAuthProvider`) and persist credentials through
// `AuthStorage` files inside the data dir. The provider id is the storage key
// and the `custom_provider` config key at once, so it must stay stable.

/** OpenAI ChatGPT subscription login (Codex). Predates the generic registry. */
export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';

/** OAuth providers added on top of the generic provider login flow. */
export const OAUTH_PROVIDER_IDS = [
  OPENAI_CODEX_PROVIDER_ID,
  'anthropic',
  'google-gemini-cli',
  'xai-oauth',
  'devin',
] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];


const OAUTH_PROVIDER_ID_TABLE: Record<OAuthProviderId, true> = {
  [OPENAI_CODEX_PROVIDER_ID]: true,
  anthropic: true,
  'google-gemini-cli': true,
  'xai-oauth': true,
  devin: true,
};

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && value in OAUTH_PROVIDER_ID_TABLE;
}

/**
 * Credential file (inside the data dir) that stores a provider's OAuth grant.
 * `openai-codex` keeps its historical standalone file; every other provider
 * shares `oauth.json` (AuthStorage keys entries by provider id).
 */
export function oauthAuthFileName(providerId: string): string {
  return providerId === OPENAI_CODEX_PROVIDER_ID ? 'codex-auth.json' : 'oauth.json';
}
