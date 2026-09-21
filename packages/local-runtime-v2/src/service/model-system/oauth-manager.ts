import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { oauthAuthFileName } from '@mavis/config';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalModelConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import type { OAuthLoginMethod, OAuthProviderSpec } from './oauth-providers.js';

export type OAuthProviderState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export interface OAuthProviderLoginOptions {
  method?: OAuthLoginMethod;
}

export interface OAuthProviderDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface OAuthProviderStatus {
  state: OAuthProviderState;
  providerId: string;
  error?: string;
  loginId?: string;
  method?: OAuthLoginMethod;
  authUrl?: string;
  deviceCode?: OAuthProviderDeviceCode;
}

export type OAuthProviderStartResult = OAuthProviderStatus;

type LoginAttempt = {
  id: string;
  providerId: string;
  method: OAuthLoginMethod;
  controller: AbortController;
  start: Promise<OAuthProviderStartResult>;
  resolve: (result: OAuthProviderStartResult) => void;
  reject: (error: Error) => void;
  result?: OAuthProviderStartResult;
  timeout?: ReturnType<typeof setTimeout>;
};

/** Raw OAuth credential fields a catalog getter may need (Codex: accountId). */
export interface OAuthStoredCredentials {
  access: string;
  accountId?: string;
}

export interface OAuthAuthStorage {
  getCredentials(provider: string): Promise<OAuthStoredCredentials | undefined>;
  hasOAuth(provider: string): boolean;
  removeOAuth(provider: string): void;
  login(provider: string, callbacks: OAuthLoginCallbacks): Promise<void>;
}

export interface OAuthProviderManagerDeps {
  configGetter: () => LocalRuntimeConfig;
  fetchImpl?: typeof fetch;
  updateByokConfig?: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  removeLegacyProvider?: (providerId: string) => Promise<unknown>;
  authStorageFactory?: (authPath: string) => OAuthAuthStorage;
  /** Per-provider catalog override (tests, Codex backend discovery). */
  catalogGetter?: (
    spec: OAuthProviderSpec,
    credentials: Promise<OAuthStoredCredentials | undefined>,
    fetchImpl: typeof fetch | undefined,
  ) => Promise<LocalCustomProviderConfig>;

}

export class OAuthProviderError extends Error {
  override name = 'OAuthProviderError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function defaultAuthStorageFactory(
  deps: OAuthProviderManagerDeps,
): (authPath: string) => OAuthAuthStorage {
  return (authPath) => {
    const storage = AuthStorage.create(authPath);
    return {
      getCredentials: async (provider) => {
        if (storage.getAll()[provider]?.type !== 'oauth') return undefined;
        const access = await storage.getApiKey(provider, {
          includeFallback: false,
          fetch: deps.fetchImpl,
        });
        const credentials = storage.getAll()[provider];
        const accountId = credentials?.type === 'oauth' ? credentials.accountId : undefined;
        return access ? { access, ...(typeof accountId === 'string' && accountId ? { accountId } : {}) } : undefined;
      },
      hasOAuth: (provider) => storage.getAll()[provider]?.type === 'oauth',
      removeOAuth: (provider) => {
        storage.logout(provider);
        const [error] = storage.drainErrors();
        if (error) throw error;
      },
      login: async (provider, callbacks) => {
        // Keep late token responses from a cancelled attempt out of profile storage.
        const pending = AuthStorage.inMemory();
        await pending.login(provider, callbacks);
        callbacks.signal?.throwIfAborted();
        const credentials = pending.getAll()[provider];
        if (!credentials) throw new Error(`${provider} OAuth credentials are unavailable.`);
        storage.set(provider, credentials);
        const [error] = storage.drainErrors();
        if (error) throw error;
      },
    };
  };
}

/**
 * Owns OAuth login, pending authorization details and credential persistence
 * for every registered provider spec. One manager instance serves all
 * providers; per-provider state is keyed by provider id.
 */
export class OAuthProviderManager {
  private readonly authStorageFactory: (authPath: string) => OAuthAuthStorage;
  private readonly catalogGetter: (
    spec: OAuthProviderSpec,
    credentials: Promise<OAuthStoredCredentials | undefined>,
    fetchImpl: typeof fetch | undefined,
  ) => Promise<LocalCustomProviderConfig>;
  private pendingCatalog = new Map<string, Promise<void>>();
  private credentialGeneration = new Map<string, number>();
  private logins = new Map<string, LoginAttempt>();
  private lastError = new Map<string, string>();

  constructor(
    private readonly deps: OAuthProviderManagerDeps,
    private readonly specs: readonly OAuthProviderSpec[],
  ) {
    this.authStorageFactory = deps.authStorageFactory ?? defaultAuthStorageFactory(deps);
    this.catalogGetter =
      deps.catalogGetter ?? ((spec, credentials, fetchImpl) => spec.catalog(credentials, fetchImpl));
  }

  listProviders(): readonly OAuthProviderSpec[] {
    return this.specs.filter((spec) => this.enabled(spec));
  }

  getProviderStatus(providerId: string): OAuthProviderStatus {
    const spec = this.requireSpec(providerId);
    if (!this.enabled(spec)) return this.status(spec, 'hidden');
    const login = this.logins.get(spec.id);
    if (login) return this.loginStatus(spec, login);

    const authStorage = this.authStorage(spec.id);
    if (authStorage.hasOAuth(spec.id) && this.hasConfiguredProvider(spec.id)) {
      return this.status(spec, 'connected', this.lastError.get(spec.id));
    }
    const error = this.lastError.get(spec.id);
    if (error) return this.status(spec, 'failed', error);
    return this.status(spec, 'disconnected');
  }

  async refreshProviderModels(providerId: string): Promise<OAuthProviderStatus> {
    const spec = this.requireSpec(providerId);
    if (!this.enabled(spec)) {
      throw new OAuthProviderError(404, `${spec.name} OAuth is not enabled.`, 'FEATURE_DISABLED');
    }
    if (
      this.logins.has(spec.id) ||
      !this.authStorage(spec.id).hasOAuth(spec.id) ||
      !this.hasConfiguredProvider(spec.id)
    ) {
      throw new OAuthProviderError(
        409,
        `Connect ${spec.name} OAuth before fetching models.`,
        'OAUTH_NOT_CONNECTED',
      );
    }
    const generation = this.generation(spec.id);
    try {
      await this.ensureProviderConfigured(spec, false);
      if (generation === this.generation(spec.id)) this.lastError.delete(spec.id);
      return this.getProviderStatus(spec.id);
    } catch (error) {
      const message = oauthErrorMessage(spec, error);
      if (generation === this.generation(spec.id)) this.lastError.set(spec.id, message);
      if (error instanceof OAuthProviderError) throw error;
      throw new OAuthProviderError(502, message, 'MODEL_DISCOVERY_FAILED');
    }
  }

  async startProviderLogin(
    providerId: string,
    options: OAuthProviderLoginOptions = {},
  ): Promise<OAuthProviderStartResult> {
    const spec = this.requireSpec(providerId);
    if (!this.enabled(spec)) {
      throw new OAuthProviderError(404, `${spec.name} OAuth is not enabled.`, 'FEATURE_DISABLED');
    }
    const method = options.method ?? spec.methods[0] ?? 'browser';
    if (!spec.methods.includes(method)) {
      throw new OAuthProviderError(
        400,
        `${spec.name} does not support ${method} login.`,
        'OAUTH_INVALID_METHOD',
      );
    }
    const existing = this.logins.get(spec.id);
    if (existing) {
      if (existing.method !== method) {
        throw new OAuthProviderError(
          409,
          `Cancel the current ${spec.name} login before changing methods.`,
          'OAUTH_LOGIN_PENDING',
        );
      }
      return existing.start;
    }
    const authStorage = this.authStorage(spec.id);
    if (authStorage.hasOAuth(spec.id)) {
      if (!this.hasConfiguredProvider(spec.id)) await this.ensureProviderConfigured(spec);
      this.lastError.delete(spec.id);
      return this.getProviderStatus(spec.id);
    }
    this.lastError.delete(spec.id);
    const attempt = this.createLoginAttempt(spec, method);
    this.logins.set(spec.id, attempt);
    this.setLoginTimeout(spec, attempt, 15 * 60 * 1000);
    const completion = this.finishLogin(spec, authStorage, attempt);
    return Promise.race([attempt.start, completion]);
  }

  cancelProviderLogin(providerId: string, loginId: string): OAuthProviderStatus {
    const spec = this.specs.find((entry) => entry.id === providerId);
    const attempt = spec ? this.logins.get(spec.id) : undefined;
    if (!spec || !attempt || attempt.id !== loginId) {
      return this.getProviderStatus(providerId);
    }
    this.logins.delete(spec.id);
    this.bumpGeneration(spec.id);
    this.pendingCatalog.delete(spec.id);
    this.lastError.delete(spec.id);
    clearTimeout(attempt.timeout);
    const error = new OAuthProviderError(
      409,
      `${spec.name} OAuth login was cancelled.`,
      'OAUTH_LOGIN_CANCELLED',
    );
    attempt.controller.abort(error);
    attempt.reject(error);
    return this.getProviderStatus(spec.id);
  }

  removeProviderCredentials(providerId: string): void {
    const spec = this.requireSpec(providerId);
    const attempt = this.logins.get(spec.id);
    if (attempt) this.cancelProviderLogin(spec.id, attempt.id);
    this.authStorage(spec.id).removeOAuth(spec.id);
    this.bumpGeneration(spec.id);
    this.pendingCatalog.delete(spec.id);
    this.lastError.delete(spec.id);
  }

  private requireSpec(providerId: string): OAuthProviderSpec {
    const spec = this.specs.find((entry) => entry.id === providerId);
    if (!spec) {
      throw new OAuthProviderError(
        404,
        `OAuth credential storage does not support provider ${providerId}.`,
        'PROVIDER_AUTH_UNAVAILABLE',
      );
    }
    return spec;
  }

  private generation(providerId: string): number {
    return this.credentialGeneration.get(providerId) ?? 0;
  }

  private bumpGeneration(providerId: string): void {
    this.credentialGeneration.set(providerId, this.generation(providerId) + 1);
  }

  private createLoginAttempt(spec: OAuthProviderSpec, method: OAuthLoginMethod): LoginAttempt {
    let resolve!: LoginAttempt['resolve'];
    let reject!: LoginAttempt['reject'];
    const start = new Promise<OAuthProviderStartResult>((resolveStart, rejectStart) => {
      resolve = resolveStart;
      reject = rejectStart;
    });
    return {
      id: randomUUID(),
      providerId: spec.id,
      method,
      controller: new AbortController(),
      start,
      resolve,
      reject,
    };
  }

  private loginStatus(spec: OAuthProviderSpec, attempt: LoginAttempt): OAuthProviderStartResult {
    return (
      attempt.result ?? {
        ...this.status(spec, 'pending'),
        loginId: attempt.id,
        method: attempt.method,
      }
    );
  }

  private setLoginTimeout(spec: OAuthProviderSpec, attempt: LoginAttempt, timeoutMs: number): void {
    clearTimeout(attempt.timeout);
    attempt.timeout = setTimeout(() => {
      const error = new OAuthProviderError(
        408,
        `${spec.errorLabel ?? spec.name} sign-in timed out. Start login again.`,
        'OAUTH_LOGIN_EXPIRED',
      );
      if (this.logins.get(spec.id) !== attempt) return;
      this.logins.delete(spec.id);
      this.bumpGeneration(spec.id);
      this.pendingCatalog.delete(spec.id);
      this.lastError.set(spec.id, error.message);
      attempt.controller.abort(error);
      attempt.reject(error);
    }, timeoutMs);
    attempt.timeout.unref?.();
  }

  private loginCallbacks(
    spec: OAuthProviderSpec,
    attempt: LoginAttempt,
  ): OAuthLoginCallbacks {
    const { signal } = attempt.controller;
    const settle = (details: Partial<OAuthProviderStartResult>) => {
      signal.throwIfAborted();
      if (attempt.result) return;
      attempt.result = { ...this.loginStatus(spec, attempt), ...details };
      attempt.resolve(attempt.result);
    };
    return {
      onAuth: ({ url }) => {
        if (!url.trim())
          throw new OAuthProviderError(502, `${spec.name} OAuth returned no URL.`, 'OAUTH_START_FAILED');
        settle({ authUrl: url.trim() });
      },
      onDeviceCode: ({ userCode, verificationUri, expiresInSeconds = 900 }) => {
        if (
          !userCode ||
          !verificationUri ||
          !Number.isFinite(expiresInSeconds) ||
          expiresInSeconds <= 0
        ) {
          throw new OAuthProviderError(
            502,
            `${spec.name} OAuth returned invalid device-code details.`,
            'OAUTH_START_FAILED',
          );
        }
        this.setLoginTimeout(spec, attempt, expiresInSeconds * 1000);
        settle({
          deviceCode: {
            userCode,
            verificationUri,
            expiresAt: Date.now() + expiresInSeconds * 1000,
          },
        });
      },
      onPrompt: async () => {
        throw new Error(`${spec.name} OAuth browser callback expired. Start login again.`);
      },
      onSelect: async () => attempt.method,
      ...(attempt.method === 'browser'
        ? {
            onManualCodeInput: () =>
              new Promise<string>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              }),
          }
        : {}),
      signal,
      fetch: async (input, init) => {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]);
        return (this.deps.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: requestSignal });
      },
    };
  }

  private async finishLogin(
    spec: OAuthProviderSpec,
    authStorage: OAuthAuthStorage,
    attempt: LoginAttempt,
  ): Promise<OAuthProviderStartResult> {
    try {
      await authStorage.login(spec.id, this.loginCallbacks(spec, attempt));
      attempt.controller.signal.throwIfAborted();
      await this.ensureProviderConfigured(spec);
      attempt.controller.signal.throwIfAborted();
      if (this.logins.get(spec.id) !== attempt) return this.getProviderStatus(spec.id);
      this.lastError.delete(spec.id);
      this.logins.delete(spec.id);
      const connected = this.getProviderStatus(spec.id);
      attempt.resolve(connected);
      return connected;
    } catch (error) {
      if (this.logins.get(spec.id) !== attempt) return this.getProviderStatus(spec.id);
      const cause: unknown = attempt.controller.signal.reason ?? error;
      const message = oauthErrorMessage(spec, cause);
      this.lastError.set(spec.id, message);
      this.logins.delete(spec.id);
      const failure =
        cause instanceof OAuthProviderError
          ? cause
          : new OAuthProviderError(502, message, 'OAUTH_LOGIN_FAILED');
      attempt.reject(failure);
      throw failure;
    } finally {
      clearTimeout(attempt.timeout);
    }
  }

  private enabled(spec: OAuthProviderSpec): boolean {
    return spec.enabled ? spec.enabled(this.deps.configGetter()) : true;
  }

  private authStorage(providerId: string): OAuthAuthStorage {
    return this.authStorageFactory(
      join(this.deps.configGetter().dataDir, oauthAuthFileName(providerId)),
    );
  }

  private hasConfiguredProvider(providerId: string): boolean {
    return (
      Object.keys(
        this.deps.configGetter().custom_provider?.[providerId]?.models ??
          this.deps.configGetter().provider?.[providerId]?.models ??
          {},
      ).length > 0
    );
  }

  private async ensureProviderConfigured(spec: OAuthProviderSpec, createIfMissing = true): Promise<void> {
    const pending = this.pendingCatalog.get(spec.id);
    if (pending) return pending;
    const operation = this.refreshProviderCatalog(spec, createIfMissing);
    this.pendingCatalog.set(spec.id, operation);
    try {
      await operation;
    } finally {
      if (this.pendingCatalog.get(spec.id) === operation) this.pendingCatalog.delete(spec.id);
    }
  }

  private async refreshProviderCatalog(spec: OAuthProviderSpec, createIfMissing: boolean): Promise<void> {
    const updater = this.deps.updateByokConfig;
    if (!updater) {
      throw new OAuthProviderError(
        503,
        `${spec.name} OAuth provider configuration is unavailable.`,
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const initialConfig = this.deps.configGetter();
    const hasLegacyProvider = Boolean(initialConfig.provider?.[spec.id]);
    const canCreate =
      createIfMissing && !hasLegacyProvider && !initialConfig.custom_provider?.[spec.id];
    if (hasLegacyProvider && !this.deps.removeLegacyProvider) {
      throw new OAuthProviderError(
        503,
        `${spec.name} OAuth legacy provider removal is unavailable.`,
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const generation = this.generation(spec.id);
    let catalog: LocalCustomProviderConfig;
    try {
      catalog = await this.catalogGetter(
        spec,
        this.authStorage(spec.id).getCredentials(spec.id),
        this.deps.fetchImpl,
      );
    } catch (error) {
      if (error instanceof OAuthProviderError) throw error;
      throw new OAuthProviderError(
        502,
        `${spec.name} model discovery failed. Retry fetching models from model settings.`,
        'MODEL_DISCOVERY_FAILED',
      );
    }
    let configured = false;
    await updater((draft, currentConfig) => {
      if (generation !== this.generation(spec.id)) return;
      const exists =
        currentConfig.custom_provider?.[spec.id] ?? currentConfig.provider?.[spec.id];
      if (!exists && !canCreate) return;
      configureOAuthProvider(draft, currentConfig, spec, catalog);
      configured = true;
    });
    if (configured && hasLegacyProvider) {
      await this.deps.removeLegacyProvider?.(spec.id);
    }
  }

  private status(spec: OAuthProviderSpec, state: OAuthProviderState, error?: string): OAuthProviderStatus {
    return {
      state,
      providerId: spec.id,
      ...(error ? { error } : {}),
    };
  }
}

function configureOAuthProvider(
  draft: LocalByokConfigDraft,
  currentConfig: LocalRuntimeConfig,
  spec: OAuthProviderSpec,
  catalog: LocalCustomProviderConfig,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const current =
    currentConfig.custom_provider?.[spec.id] ?? currentConfig.provider?.[spec.id];
  tree[spec.id] = mergeOAuthProvider(current, catalog);
  draft.custom_provider = tree as Record<string, unknown>;
  if (draft.defaultModel?.startsWith(`${spec.id}/`)) {
    draft.defaultModel = `custom_provider:${draft.defaultModel}`;
  }
}

function mergeOAuthProvider(
  current: LocalCustomProviderConfig | undefined,
  catalog: LocalCustomProviderConfig,
): LocalCustomProviderConfig {
  const currentOptions = { ...(current?.options ?? {}) };
  delete currentOptions.apiKey;
  const currentModels = current?.models ?? {};
  return {
    ...current,
    api: current?.api ?? catalog.api,
    name: current?.name ?? catalog.name,
    kind: 'oauth',
    enabled: current?.enabled ?? true,
    options: {
      ...currentOptions,
      baseURL: current?.options?.baseURL ?? catalog.options?.baseURL,
      authMode: 'oauth',
    },
    models: mergeOAuthModels(currentModels, catalog.models ?? {}),
  };
}

function mergeOAuthModels(
  current: Record<string, LocalModelConfig>,
  discovered: Record<string, LocalModelConfig>,
): Record<string, LocalModelConfig> {
  // Stored fields are authoritative, including old catalog values whose edit history is unknown.
  const models = new Map(Object.entries(current));
  for (const [id, model] of Object.entries(discovered)) {
    const existing = models.get(id);
    models.set(id, {
      ...model,
      ...existing,
      ...(model.limit || existing?.limit ? { limit: { ...model.limit, ...existing?.limit } } : {}),
      ...(model.modalities || existing?.modalities
        ? { modalities: { ...model.modalities, ...existing?.modalities } }
        : {}),
      ...(model.thinking || existing?.thinking
        ? { thinking: { ...model.thinking, ...existing?.thinking } }
        : {}),
    });
  }
  return Object.fromEntries(models);
}

function oauthErrorMessage(spec: OAuthProviderSpec, error: unknown): string {
  if (error instanceof OAuthProviderError) return error.message;
  const label = spec.errorLabel ?? spec.name;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('callback expired')) return message;
  if (message.includes('EADDRINUSE')) {
    return spec.callbackPort
      ? `${label} OAuth callback port ${spec.callbackPort} is already in use.`
      : `${label} OAuth callback port is already in use.`;
  }
  if (message.startsWith('Device flow timed out')) return 'Device code expired. Start login again.';
  if (message.includes('device code login is not enabled')) {
    return 'Enable device code login in ChatGPT security settings or workspace permissions, then retry.';
  }
  if (message === 'Login cancelled') return `${label} OAuth login was cancelled.`;
  return `${label} OAuth login failed.`;
}
