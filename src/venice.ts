import { z } from "zod"

export const BASE = "https://api.venice.ai/api/v1"

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

// Minimal fetch shape. Tests inject plain objects; the global fetch is
// structurally compatible with it.
export interface FetchOptions {
  headers?: { [name: string]: string }
}

export interface FetchResponse {
  ok: boolean
  status: number
  json: () => Promise<Partial<RateLimitsResponse>>
}

export type FetchLike = (url: string, init?: FetchOptions) => Promise<FetchResponse>

export async function fetchRateLimits(
  key: string,
  fetchImpl: FetchLike = fetch,
): Promise<RateLimitsResult> {
  const res = await fetchImpl(`${BASE}/api_keys/rate_limits`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  })
  if (!res.ok) return { ok: false, status: res.status }
  const parsed = rateLimitsResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    return { ok: false, status: res.status, detail: "unexpected response shape" }
  }
  return { ok: true, data: parsed.data }
}
