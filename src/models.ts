import { BASE, fetchModels } from "./venice"
import type { FetchLike, VeniceModel } from "./venice"

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelCostCache {
  read: number
  write: number
}

export interface ModelCost {
  input: number
  output: number
  cache: ModelCostCache
}

export interface ModelCapabilitiesInput {
  text: boolean
  pdf: boolean
  image: boolean
  audio: boolean
}

export interface ModelCapabilitiesOutput {
  text: boolean
  image: boolean
  audio: boolean
  video: boolean
}

export interface ModelCapabilities {
  reasoning: boolean
  toolcall: boolean
  attachment: boolean
  input: ModelCapabilitiesInput
  output: ModelCapabilitiesOutput
  temperature: boolean
  interleaved: boolean
}

export interface ModelApi {
  id: string
  url: string
  npm: string
}

export interface ModelOptions {
  [key: string]: string
}

export interface ModelHeaders {
  [name: string]: string
}

export interface ModelEntry {
  id: string
  name: string
  status: "active"
  release_date: string
  limit: ModelLimit
  cost: ModelCost
  capabilities: ModelCapabilities
  api: ModelApi
  options: ModelOptions
  headers: ModelHeaders
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
    status: "active",
    release_date: "",
    limit: {
      context: spec.availableContextTokens,
      output: spec.maxCompletionTokens,
    },
    cost: {
      input: spec.pricing.input.usd,
      output: spec.pricing.output.usd,
      cache: {
        read: spec.pricing.cache_input?.usd ?? 0,
        write: spec.pricing.cache_write?.usd ?? 0,
      },
    },
    capabilities: {
      reasoning: capabilities.supportsReasoning,
      toolcall: capabilities.supportsFunctionCalling,
      attachment: capabilities.supportsVision,
      input: {
        text: true,
        pdf: false,
        image: capabilities.supportsVision,
        audio: capabilities.supportsAudioInput,
      },
      output: {
        text: true,
        image: false,
        audio: false,
        video: false,
      },
      temperature: true,
      interleaved: false,
    },
    api: {
      id: model.id,
      url: BASE,
      npm: "@ai-sdk/openai-compatible",
    },
    options: {},
    headers: {},
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
    Object.defineProperty(models, model.id, {
      value: mapVeniceModel(model),
      enumerable: true,
      writable: true,
      configurable: true,
    })
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
