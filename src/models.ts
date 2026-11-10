import { fetchModels } from "./venice"
import type { FetchLike, VeniceModel } from "./venice"

export interface ModelCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelModalities {
  input: string[]
  output: string[]
}

export interface ModelEntry {
  id: string
  name: string
  reasoning: boolean
  tool_call: boolean
  modalities: ModelModalities
  limit: ModelLimit
  cost: ModelCost
}

export type ProviderModels = { [id: string]: ModelEntry }

export interface ProviderModelsAuth {
  type?: string
  key?: string
}

export interface ProviderModelsOptions {
  auth?: ProviderModelsAuth
}

export interface ProviderWithModels {
  models: ProviderModels
}

export type ProviderModelsHook = (
  provider: ProviderWithModels,
  options?: ProviderModelsOptions,
) => Promise<ProviderModels>

function mapVeniceModel(model: VeniceModel): ModelEntry {
  const spec = model.model_spec
  const capabilities = spec.capabilities
  return {
    id: model.id,
    name: spec.name,
    reasoning: capabilities.supportsReasoning,
    tool_call: capabilities.supportsFunctionCalling,
    modalities: {
      input: [
        "text",
        ...(capabilities.supportsVision ? ["image"] : []),
        ...(capabilities.supportsAudioInput ? ["audio"] : []),
      ],
      output: ["text"],
    },
    limit: {
      context: spec.availableContextTokens,
      output: spec.maxCompletionTokens,
    },
    cost: {
      input: spec.pricing.input.usd,
      output: spec.pricing.output.usd,
      ...(spec.pricing.cache_input ? { cache_read: spec.pricing.cache_input.usd } : {}),
      ...(spec.pricing.cache_write ? { cache_write: spec.pricing.cache_write.usd } : {}),
    },
  }
}

export function filterAndMapModels(list: VeniceModel[]): ProviderModels {
  const models: ProviderModels = {}
  for (const model of list) {
    const spec = model.model_spec
    if (spec.offline === true) continue
    if (spec.betaModel === true) continue
    if (spec.deprecation != null) continue
    if (
      model.id.startsWith("e2ee-") ||
      spec.capabilities.supportsE2EE === true ||
      spec.capabilities.supportsTeeAttestation === true
    ) {
      continue
    }
    if (spec.capabilities.supportsFunctionCalling === false) continue
    models[model.id] = mapVeniceModel(model)
  }
  return models
}

export function createProviderModels({
  fetchImpl = fetch,
}: { fetchImpl?: FetchLike } = {}): ProviderModelsHook {
  return async (provider, options) => {
    const auth = options?.auth
    if (auth?.type !== "api" || !auth.key) return provider.models
    const result = await fetchModels(auth.key, fetchImpl)
    if (!result.ok) {
      if (result.status === 401) {
        throw Object.assign(new Error("Venice API key was rejected (HTTP 401)"), {
          signIn: "expired",
        })
      }
      return provider.models
    }
    return filterAndMapModels(result.data.data)
  }
}
