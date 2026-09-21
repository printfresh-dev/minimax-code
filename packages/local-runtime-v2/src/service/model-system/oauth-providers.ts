// Third-party OAuth provider registry for the local model system.
//
// Each spec describes one provider that authenticates through the pi-ai OAuth
// registry (`AuthStorage` + `getOAuthProvider`) and is exposed to the user as a
// `custom_provider` entry with `options.authMode: 'oauth'`. The generic
// `OAuthProviderManager` drives login, persists credentials and writes the
// provider config; this file only carries the per-provider data.
//
// Model catalogs are static snapshots of each provider's subscription model
// list (matching the oh-my-pi reference registry). Codex is the exception: its
// catalog is discovered from the ChatGPT backend after login.

import { OPENAI_CODEX_PROVIDER_ID } from '@mavis/config';

import type { LocalCustomProviderConfig, LocalModelConfig } from './contracts.js';

export type OAuthLoginMethod = 'browser' | 'device_code';

/** Raw OAuth credential fields a catalog getter may need (Codex: accountId). */
export interface OAuthStoredCredentials {
  access: string;
  accountId?: string;
}
export interface OAuthProviderSpec {
  /** Provider id — pi-ai OAuth registry key, AuthStorage key and custom_provider key. */
  readonly id: string;
  /** Display name shown in /login, /provider and `mcode provider` output. */
  readonly name: string;
  /** Login methods the provider supports, in preference order. */
  readonly methods: readonly OAuthLoginMethod[];
  /** Short name used in user-facing error messages (defaults to `name`). */
  readonly errorLabel?: string;
  /** Local callback port for browser flows; used in EADDRINUSE messages. */
  readonly callbackPort?: number;
  /**
   * Feature gate. Absent = always enabled. Codex keeps its historical
   * `beta.codexOAuth` flag; the newer providers ship unconditionally.
   */
  readonly enabled?: (config: { beta?: { codexOAuth?: boolean } }) => boolean;
  /**
   * Provider catalog for `custom_provider` config writes. Receives the stored
   * OAuth credentials (access token, account id) when available. Codex
   * discovers its models from the backend; the others ship a static list.
   */
  readonly catalog: (
    credentials: Promise<OAuthStoredCredentials | undefined>,
    fetchImpl: typeof fetch | undefined,
  ) => Promise<LocalCustomProviderConfig>;
}

function model(
  id: string,
  name: string,
  input: { context: number; output: number; image?: boolean; efforts?: readonly string[] },
): [string, LocalModelConfig] {
  return [
    id,
    {
      name,
      reasoning: (input.efforts?.length ?? 0) > 0,
      attachment: input.image === true,
      tool_call: true,
      modalities: { input: input.image ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context: input.context, output: input.output },
      ...(input.efforts?.length ? { thinking: { effortOptions: [...input.efforts] } } : {}),
    },
  ];
}

const ANTHROPIC_CATALOG: LocalCustomProviderConfig = {
  api: 'anthropic-messages',
  name: 'Anthropic (Claude Pro/Max)',
  kind: 'oauth',
  enabled: true,
  options: { authMode: 'oauth', baseURL: 'https://api.anthropic.com' },
  models: Object.fromEntries([
    model('claude-sonnet-5', 'Claude Sonnet 5', {
      context: 1_000_000,
      output: 128_000,
      image: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }),
    model('claude-fable-5', 'Claude Fable 5', {
      context: 1_000_000,
      output: 128_000,
      image: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }),
    model('claude-mythos-5', 'Claude Mythos 5', {
      context: 1_000_000,
      output: 128_000,
      image: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }),
    model('claude-fable-5-1', 'Claude Fable 5.1', {
      context: 1_000_000,
      output: 128_000,
      image: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }),
    model('claude-mythos-5-1', 'Claude Mythos 5.1', {
      context: 1_000_000,
      output: 128_000,
      image: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }),
  ]),
};

const GOOGLE_GEMINI_CLI_CATALOG: LocalCustomProviderConfig = {
  api: 'google-gemini-cli',
  name: 'Google Cloud Code Assist (Gemini)',
  kind: 'oauth',
  enabled: true,
  options: { authMode: 'oauth', baseURL: 'https://cloudcode-pa.googleapis.com' },
  models: Object.fromEntries([
    model('gemini-2.0-flash', 'Gemini 2.0 Flash', {
      context: 1_048_576,
      output: 8_192,
      image: true,
    }),
    model('gemini-2.5-flash', 'Gemini 2.5 Flash', {
      context: 1_048_576,
      output: 65_536,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('gemini-2.5-pro', 'Gemini 2.5 Pro', {
      context: 1_048_576,
      output: 65_536,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('gemini-3-flash-preview', 'Gemini 3 Flash Preview', {
      context: 1_048_576,
      output: 65_536,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('gemini-3-pro-preview', 'Gemini 3 Pro Preview', {
      context: 1_000_000,
      output: 64_000,
      image: true,
      efforts: ['low', 'high'],
    }),
    model('gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash Lite Preview', {
      context: 1_048_576,
      output: 65_536,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', {
      context: 1_048_576,
      output: 65_536,
      image: true,
      efforts: ['low', 'high'],
    }),
  ]),
};

const XAI_OAUTH_CATALOG: LocalCustomProviderConfig = {
  api: 'openai-responses',
  name: 'xAI Grok (SuperGrok / X Premium+)',
  kind: 'oauth',
  enabled: true,
  options: { authMode: 'oauth', baseURL: 'https://api.x.ai/v1' },
  models: Object.fromEntries([
    model('grok-4.6', 'Grok 4.6', {
      context: 500_000,
      output: 500_000,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    }),
    model('grok-4.5', 'Grok 4.5', {
      context: 500_000,
      output: 500_000,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('grok-4.3', 'Grok 4.3', {
      context: 1_000_000,
      output: 1_000_000,
      image: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    }),
    model('grok-4.20-0309-reasoning', 'Grok 4.20 (Reasoning)', {
      context: 2_000_000,
      output: 2_000_000,
      image: true,
    }),
    model('grok-4.20-0309-non-reasoning', 'Grok 4.20 (Non-Reasoning)', {
      context: 2_000_000,
      output: 2_000_000,
      image: true,
    }),
    model('grok-4.20-multi-agent-0309', 'Grok 4.20 (Multi-Agent)', {
      context: 2_000_000,
      output: 2_000_000,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    }),
    model('grok-build', 'Grok Build', {
      context: 512_000,
      output: 512_000,
      image: true,
    }),
    model('grok-build-0.1', 'Grok Build 0.1', {
      context: 256_000,
      output: 256_000,
      image: true,
    }),
    model('grok-composer-2.5-fast', 'Grok Composer 2.5 Fast', {
      context: 200_000,
      output: 200_000,
    }),
  ]),
};

const DEVIN_CATALOG: LocalCustomProviderConfig = {
  api: 'devin-agent',
  name: 'Devin',
  kind: 'oauth',
  enabled: true,
  options: { authMode: 'oauth', baseURL: 'https://server.codeium.com' },
  models: Object.fromEntries([
    model('swe-1-6', 'SWE-1.6', { context: 200_000, output: 128_000 }),
    model('swe-1-6-fast', 'SWE-1.6 Fast', { context: 200_000, output: 128_000 }),
    model('swe-2', 'SWE-2', { context: 200_000, output: 128_000 }),
  ]),
};

/**
 * Specs for every OAuth provider except Codex, which keeps its own manager
 * subclass (beta flag + backend model discovery). Order is the display order
 * in /login and /provider.
 */
export const OAUTH_PROVIDER_SPECS: readonly OAuthProviderSpec[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude Pro/Max)',
    methods: ['browser'],
    catalog: async () => ANTHROPIC_CATALOG,
  },
  {
    id: 'google-gemini-cli',
    name: 'Google Gemini (Code Assist)',
    methods: ['browser'],
    catalog: async () => GOOGLE_GEMINI_CLI_CATALOG,
  },
  {
    id: 'xai-oauth',
    name: 'xAI Grok (SuperGrok / X Premium+)',
    methods: ['device_code'],
    catalog: async () => XAI_OAUTH_CATALOG,
  },
  {
    id: 'devin',
    name: 'Devin',
    methods: ['browser'],
    catalog: async () => DEVIN_CATALOG,
  },
];

const OAUTH_PROVIDER_SPEC_TABLE: Record<string, OAuthProviderSpec> = Object.fromEntries(
  OAUTH_PROVIDER_SPECS.map((spec) => [spec.id, spec]),
);

export function getOAuthProviderSpec(id: string): OAuthProviderSpec | undefined {
  return OAUTH_PROVIDER_SPEC_TABLE[id];
}

export { OPENAI_CODEX_PROVIDER_ID };
