/**
 * Shared warning-only fallback vocabulary for the optional provider-backed slices (answer synthesis and semantic
 * summaries). Every failure maps to a fixed message so endpoints, keys, and provider transcripts can never leak.
 */
export type ProviderFallbackReason =
  | 'no_profile'
  | 'profile_disabled'
  | 'capability_missing'
  | 'missing_credentials'
  | 'unsafe_endpoint'
  | 'timeout'
  | 'provider_error'
  | 'invalid_response';

export interface ProviderFallbackWarning {
  code: 'provider_unavailable' | 'provider_invalid';
  reason: ProviderFallbackReason;
  message: string;
}

export const PROVIDER_FALLBACK_REASONS: readonly ProviderFallbackReason[] = [
  'no_profile',
  'profile_disabled',
  'capability_missing',
  'missing_credentials',
  'unsafe_endpoint',
  'timeout',
  'provider_error',
  'invalid_response',
];

const FALLBACK_MESSAGES: Readonly<Record<ProviderFallbackReason, string>> = {
  no_profile: 'No provider profile is selected for this request; the deterministic result was used.',
  profile_disabled: 'The selected provider profile is disabled; the deterministic result was used.',
  capability_missing: 'The selected provider profile does not declare the generation capability; the deterministic result was used.',
  missing_credentials: 'The selected provider profile has no usable credentials; the deterministic result was used.',
  unsafe_endpoint: 'The selected provider endpoint was rejected by the safety policy; the deterministic result was used.',
  timeout: 'The provider request timed out; the deterministic result was used.',
  provider_error: 'The provider request failed; the deterministic result was used.',
  invalid_response: 'The provider response failed grounding validation; the deterministic result was used.',
};

export function providerFallbackWarning(reason: ProviderFallbackReason): ProviderFallbackWarning {
  return {
    code: reason === 'invalid_response' ? 'provider_invalid' : 'provider_unavailable',
    reason,
    message: FALLBACK_MESSAGES[reason],
  };
}

/** Raised by provider transports with an already-classified reason; the message is never surfaced to callers. */
export class KnowledgeProviderCallError extends Error {
  public constructor(
    public readonly reason: ProviderFallbackReason,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeProviderCallError';
  }
}

export function classifyProviderFailure(error: unknown): ProviderFallbackReason {
  return error instanceof KnowledgeProviderCallError ? error.reason : 'provider_error';
}
