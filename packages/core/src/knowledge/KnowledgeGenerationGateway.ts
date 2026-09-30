import type { KnowledgeHostSettingKey, KnowledgeHostSettingsStore } from './KnowledgeHostSettingsStore.js';
import {
  resolveKnowledgeProviderApiKey,
  type KnowledgeProviderCredentialPolicy,
  type KnowledgeProviderProfile,
  type KnowledgeProviderProfileStore,
} from './KnowledgeProviderProfiles.js';
import {
  classifyProviderFailure,
  providerFallbackWarning,
  type ProviderFallbackReason,
  type ProviderFallbackWarning,
} from './KnowledgeProviderFallback.js';

export interface KnowledgeJsonCompletionInput {
  profile: KnowledgeProviderProfile;
  environment: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
}

/** Structural view of the single-shot JSON call implemented by `OpenAICompatibleProvider.completeJson`. */
export interface KnowledgeJsonCompletionClient {
  completeJson(input: KnowledgeJsonCompletionInput): Promise<{ value: unknown }>;
}

export interface KnowledgeGenerationGatewayOptions {
  profileStore: Pick<KnowledgeProviderProfileStore, 'get'>;
  hostSettings: Pick<KnowledgeHostSettingsStore, 'get'>;
  client: KnowledgeJsonCompletionClient;
  environment?: NodeJS.ProcessEnv;
  /** Must match the policy given to the client so a missing credential is reported before any request is made. */
  credentialPolicy?: KnowledgeProviderCredentialPolicy;
}

export interface KnowledgeGenerationRequest {
  projectId: string;
  /** Explicit call input; wins over the host-local setting. */
  explicitProfileName?: string | null;
  settingKey: KnowledgeHostSettingKey;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface KnowledgeGenerationFailure {
  ok: false;
  warning: ProviderFallbackWarning;
}

export type KnowledgeGenerationOutcome = { ok: true; value: unknown; profileName: string } | KnowledgeGenerationFailure;

function failure(reason: ProviderFallbackReason): KnowledgeGenerationFailure {
  return { ok: false, warning: providerFallbackWarning(reason) };
}

/**
 * Resolves a reviewed provider profile (explicit input, then the host-local setting, never a guessed default) and makes
 * one non-streaming JSON request. It never throws for provider problems: every failure becomes a fixed-message warning.
 */
export class KnowledgeGenerationGateway {
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(private readonly options: KnowledgeGenerationGatewayOptions) {
    this.environment = options.environment ?? process.env;
  }

  public async requestJson(request: KnowledgeGenerationRequest): Promise<KnowledgeGenerationOutcome> {
    const resolved = this.resolveProfile(request);
    if (!resolved.ok) return resolved;
    const { profile } = resolved;
    try {
      const completion = await this.options.client.completeJson({
        profile,
        environment: this.environment,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        signal: request.signal,
      });
      return { ok: true, value: completion.value, profileName: profile.profileName };
    } catch (error) {
      return failure(classifyProviderFailure(error));
    }
  }

  private resolveProfile(
    request: KnowledgeGenerationRequest,
  ): { ok: true; profile: KnowledgeProviderProfile } | KnowledgeGenerationFailure {
    let name: string | null;
    try {
      name = request.explicitProfileName ?? this.options.hostSettings.get(request.projectId, request.settingKey);
    } catch {
      return failure('no_profile');
    }
    if (name === null) return failure('no_profile');
    let profile: KnowledgeProviderProfile | null;
    try {
      profile = this.options.profileStore.get(request.projectId, name);
    } catch {
      profile = null;
    }
    if (profile === null) return failure('no_profile');
    if (!profile.enabled) return failure('profile_disabled');
    if (!profile.capabilities.includes('generation')) {
      return failure('capability_missing');
    }
    if (profile.apiKeyEnv !== null) {
      const key = resolveKnowledgeProviderApiKey(profile, this.environment, this.options.credentialPolicy);
      if (key.apiKey === null) return failure('missing_credentials');
    }
    return { ok: true, profile };
  }
}
