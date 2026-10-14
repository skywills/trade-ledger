import type {
  NativeBackendOptions,
  NativeCatalogOverrides,
} from "@nathapp/nax-agent";
import {
  type Client,
  createClient,
  createMemoryCredentialStore,
  defaultProtocols,
  type ProviderOverride,
  type RawModel,
  type RawProvider,
  type ResolvedModel,
} from "@nathapp/nax-ai";
import type { LlmProfileSnapshot, ProfilePricing } from "./profiles.js";

/**
 * Catalog/override construction shared by the native session backend and the
 * direct compatibility client.
 *
 * The library is always pointed at the loopback gateway, never the real
 * upstream: the gateway's `baseUrl` is what reaches `provider.baseUrl` and the
 * protocol-side override. Local pricing is zero only to satisfy the required
 * catalog fields, so app usage stays `unpriced` unless the user supplied
 * explicit rates.
 */
const ZERO_PRICING: ProfilePricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * The wire provider a local OpenAI-compatible endpoint is wired under.
 *
 * The app's adapter identity is `openai` (the OpenAI chat-completions
 * vocabulary), but the pinned bundled `openai` provider carries only
 * `openai-responses` models, so nax-ai has no same-protocol sibling to template
 * a hand-declared `openai-completions` entry from and refuses the override.
 * `openrouter` is an existing model in the bundled catalog whose provider does
 * carry `openai-completions`, and nax-ai's own documentation uses it for
 * openai-completions overrides. The gateway owns the real base URL and auth, so
 * no request ever reaches the OpenRouter service. No provider id is invented.
 */
export const LOCAL_OPENAI_COMPATIBLE_PROVIDER = "openrouter";

/**
 * Maps the app's adapter identity to the provider id the wire understands.
 *
 * Only `openai` + `openai-completions` needs remapping (the rule above); a
 * profile pinned to any other provider/protocol pair keeps its own id, so e.g.
 * `openai`/`openai-responses` still templates off the bundled `openai` models.
 */
export function wireProviderId(profile: LlmProfileSnapshot): string {
  if (
    profile.provider === "openai" &&
    profile.protocol === "openai-completions"
  ) {
    return LOCAL_OPENAI_COMPATIBLE_PROVIDER;
  }
  return profile.provider;
}

export function profilePricing(profile: LlmProfileSnapshot): ProfilePricing {
  return profile.pricing ?? ZERO_PRICING;
}

function catalogModel(
  profile: LlmProfileSnapshot,
): NativeCatalogOverrides[number]["models"][number] {
  return {
    id: profile.modelId,
    protocol: profile.protocol,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    supportsTools: profile.supportsTools,
    thinkingLevels: profile.thinkingLevels,
    pricing: profilePricing(profile),
  };
}

function rawModel(profile: LlmProfileSnapshot): RawModel {
  return {
    id: profile.modelId,
    protocol: profile.protocol,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    supportsTools: profile.supportsTools,
    thinkingLevels: profile.thinkingLevels,
    pricing: profilePricing(profile),
  };
}

function resolvedModel(profile: LlmProfileSnapshot): ResolvedModel {
  return {
    id: profile.modelId,
    provider: wireProviderId(profile),
    protocol: profile.protocol,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    supportsTools: profile.supportsTools,
    thinkingLevels: profile.thinkingLevels,
    pricing: profilePricing(profile),
  };
}

/** Overrides for `nativeBackend({ catalogOverrides })`. */
export function buildCatalogOverrides(
  profile: LlmProfileSnapshot,
  gatewayBaseUrl: string,
): NativeCatalogOverrides {
  return [
    {
      provider: wireProviderId(profile),
      baseUrl: gatewayBaseUrl,
      models: [catalogModel(profile)],
    },
  ];
}

/** The `NativeBackendOptions` a Task 13 session opens through. */
export function buildBackendOptions(
  profile: LlmProfileSnapshot,
  gatewayBaseUrl: string,
  gatewayToken: string,
): NativeBackendOptions {
  const provider = wireProviderId(profile);
  return {
    model: `${provider}/${profile.modelId}`,
    catalogOverrides: buildCatalogOverrides(profile, gatewayBaseUrl),
    credentials: {
      kind: "memory",
      credentials: {
        [provider]: { kind: "api-key", key: gatewayToken },
      },
    },
  };
}

/**
 * A direct nax-ai client for the compatibility roundtrip. Both catalogs are
 * given the same override so the model resolves client-side and the protocol
 * resolves it at the wire (nax-ai issue #36), and both point at the gateway.
 */
export function buildCompatibilityClient(
  profile: LlmProfileSnapshot,
  gatewayBaseUrl: string,
  gatewayToken: string,
): Client {
  const provider = wireProviderId(profile);
  const rawProvider: RawProvider = {
    id: provider,
    baseUrl: gatewayBaseUrl,
    auth: { kind: "api-key" },
    defaultProtocol: profile.protocol,
    models: [rawModel(profile)],
  };
  const override: ProviderOverride = {
    provider,
    baseUrl: gatewayBaseUrl,
    models: [resolvedModel(profile)],
  };
  const credentials = createMemoryCredentialStore({
    [provider]: { kind: "api-key", key: gatewayToken },
  });
  return createClient({
    providers: [rawProvider],
    protocols: ({ providerOverrides }) =>
      defaultProtocols({ providerOverrides, credentials }),
    providerOverrides: [override],
    transportRetries: 0,
  });
}
