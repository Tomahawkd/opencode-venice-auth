import { z } from "zod"

export const BASE = "https://api.venice.ai/api/v1"

export const UNEXPECTED_RESPONSE_SHAPE = "unexpected response shape"

// Schema aligned field by field with the official Venice OpenAPI document
// (20261110.030206) for GET /api_keys/rate_limits.
export const rateLimitsResponseSchema = z.object({
  data: z.object({
    accessPermitted: z.boolean(),
    apiTier: z.object({
      id: z.string(),
      isCharged: z.boolean(),
    }),
    balances: z.object({
      USD: z.number().optional(),
      DIEM: z.number().optional(),
      BUNDLED_CREDITS: z.number().optional(),
    }),
    keyExpiration: z.string().nullable(),
    nextEpochBegins: z.string(),
    rateLimits: z.array(
      z.object({
        apiModelId: z.string().optional(),
        rateLimits: z.array(
          z.object({ amount: z.number(), type: z.string() }),
        ),
      }),
    ),
  }),
})

export type RateLimitsResponse = z.infer<typeof rateLimitsResponseSchema>

export type RateLimitsResult =
  | { ok: true; data: RateLimitsResponse }
  | { ok: false; status: number; detail?: string }

// Endpoint-agnostic JSON value shared by fetch callers, so each response
// shape can be parsed independently of the fetch abstraction.
export type JsonScalar = string | number | boolean | null
export interface JsonObject {
  [key: string]: JsonValue | undefined
}
export type JsonValue = JsonScalar | JsonValue[] | JsonObject

// Minimal fetch shape. Tests inject plain objects; the global fetch is
// structurally compatible with it.
export interface FetchOptions {
  headers?: { [name: string]: string }
}

export interface FetchResponse {
  ok: boolean
  status: number
  json: () => Promise<JsonValue>
}

export type FetchLike = (url: string, init?: FetchOptions) => Promise<FetchResponse>

// Reads a response body as JSON. A syntax error means the body is not JSON,
// which callers treat as an unexpected shape; every other read error is a
// transport failure and must propagate.
async function readJsonBody(res: FetchResponse): Promise<JsonValue | undefined> {
  try {
    return await res.json()
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function fetchRateLimits(
  key: string,
  fetchImpl: FetchLike = fetch,
): Promise<RateLimitsResult> {
  const res = await fetchImpl(`${BASE}/api_keys/rate_limits`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  })
  if (!res.ok) return { ok: false, status: res.status }
  const json = await readJsonBody(res)
  if (json === undefined) {
    return { ok: false, status: res.status, detail: UNEXPECTED_RESPONSE_SHAPE }
  }
  const parsed = rateLimitsResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, status: res.status, detail: UNEXPECTED_RESPONSE_SHAPE }
  }
  return { ok: true, data: parsed.data }
}

const usdPriceSchema = z.object({ usd: z.number() })

const modelCapabilitiesSchema = z.object({
  supportsFunctionCalling: z.boolean(),
  supportsVision: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsAudioInput: z.boolean(),
  supportsE2EE: z.boolean(),
  supportsTeeAttestation: z.boolean(),
})

const modelSpecSchema = z.object({
  name: z.string(),
  offline: z.boolean(),
  betaModel: z.boolean().optional(),
  deprecation: z.object({ date: z.string().optional() }).nullable().optional(),
  availableContextTokens: z.number(),
  maxCompletionTokens: z.number(),
  capabilities: modelCapabilitiesSchema,
  pricing: z.object({
    input: usdPriceSchema,
    output: usdPriceSchema,
    cache_input: usdPriceSchema.optional(),
    cache_write: usdPriceSchema.optional(),
  }),
})

const modelEntrySchema = z.object({
  id: z.string(),
  model_spec: modelSpecSchema,
})

export const modelsResponseSchema = z.object({
  data: z.array(modelEntrySchema),
})

export type ModelsResponse = z.infer<typeof modelsResponseSchema>
export type VeniceModel = ModelsResponse["data"][number]

export type ModelsResult =
  | { ok: true; data: ModelsResponse }
  | { ok: false; status: number; detail?: string }

export async function fetchModels(
  key: string,
  fetchImpl: FetchLike = fetch,
): Promise<ModelsResult> {
  const res = await fetchImpl(`${BASE}/models?type=text`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  })
  if (!res.ok) return { ok: false, status: res.status }
  const json = await readJsonBody(res)
  if (json === undefined) {
    return { ok: false, status: res.status, detail: UNEXPECTED_RESPONSE_SHAPE }
  }
  const parsed = modelsResponseSchema.safeParse(json)
  if (!parsed.success) {
    return { ok: false, status: res.status, detail: UNEXPECTED_RESPONSE_SHAPE }
  }
  return { ok: true, data: parsed.data }
}
