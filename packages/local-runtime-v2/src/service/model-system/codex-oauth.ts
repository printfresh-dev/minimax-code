import { OPENAI_CODEX_PROVIDER_ID } from './identity.js';
import { CodexModelDiscoveryClient } from './connectivity/codex-model-discovery.js';
import { OAuthProviderError } from './oauth-manager.js';
import type { OAuthProviderSpec } from './oauth-providers.js';

export { OPENAI_CODEX_PROVIDER_ID } from './identity.js';

export type CodexOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export type CodexOAuthLoginMethod = 'browser' | 'device_code';

export interface CodexOAuthLoginOptions {
  method?: CodexOAuthLoginMethod;
}

export interface CodexOAuthDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface CodexOAuthStatus {
  state: CodexOAuthState;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  error?: string;
  loginId?: string;
  method?: CodexOAuthLoginMethod;
  authUrl?: string;
  deviceCode?: CodexOAuthDeviceCode;
}

export type CodexOAuthStartResult = CodexOAuthStatus;

export class CodexOAuthError extends OAuthProviderError {
  override name = 'CodexOAuthError';
}

/**
 * Codex spec: beta-gated behind `beta.codexOAuth`, models discovered from the
 * ChatGPT backend using the stored account id. All other providers live in
 * `oauth-providers.ts` and are driven by the same OAuthProviderManager.
 */
export const CODEX_OAUTH_SPEC: OAuthProviderSpec = {
  id: OPENAI_CODEX_PROVIDER_ID,
  name: 'OpenAI Codex',
  errorLabel: 'Codex',
  callbackPort: 1455,
  methods: ['browser', 'device_code'],
  enabled: (config) => config.beta?.codexOAuth === true,
  catalog: async (credentialsPromise, fetchImpl) => {
    const credentials = await credentialsPromise;
    if (!credentials?.accountId) {
      throw new CodexOAuthError(
        401,
        'Codex OAuth credentials are unavailable. Reconnect to retry.',
        'OAUTH_CREDENTIALS_UNAVAILABLE',
      );
    }
    return new CodexModelDiscoveryClient(fetchImpl).discover({
      access: credentials.access,
      accountId: credentials.accountId,
    });
  },
};
