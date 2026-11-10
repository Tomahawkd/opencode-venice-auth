import { UNEXPECTED_RESPONSE_SHAPE, fetchRateLimits } from "./venice"
import type { FetchLike, RateLimitsResponse } from "./venice"

export interface UsageWindow {
  name: string
  display: string
}

export interface UsageSuccess {
  balance?: string
  until?: string
  windows: UsageWindow[]
}

export interface UsageFailure {
  error: string
  signIn?: "expired"
  windows: UsageWindow[]
}

export type UsageReport = UsageSuccess | UsageFailure

export interface UsageApiKeyAuth {
  type: "api"
  key: string
}

export interface UsageOauthAuth {
  type: "oauth"
}

export type UsageAuth = UsageApiKeyAuth | UsageOauthAuth

function formatBalance(
  balances: RateLimitsResponse["data"]["balances"],
): string | undefined {
  const parts: string[] = []
  if (balances.USD !== undefined) parts.push(`$${balances.USD}`)
  if (balances.DIEM !== undefined) parts.push(`${balances.DIEM} DIEM`)
  if (balances.BUNDLED_CREDITS !== undefined) {
    parts.push(`${balances.BUNDLED_CREDITS} BUNDLED_CREDITS`)
  }
  return parts.length > 0 ? parts.join(" · ") : undefined
}

interface RateLimitSummary {
  min: number
  max: number
  models: number
}

function formatSummary(summary: RateLimitSummary): string {
  if (summary.min === summary.max) {
    const noun = summary.models === 1 ? "model" : "models"
    return `${summary.min} across ${summary.models} ${noun}`
  }
  return `${summary.min}-${summary.max} across ${summary.models} models`
}

function collectAccountWindows(
  entries: RateLimitsResponse["data"]["rateLimits"],
): UsageWindow[] {
  const windows: UsageWindow[] = []
  for (const entry of entries) {
    if (entry.apiModelId !== undefined || entry.rateLimits.length === 0) continue
    windows.push({
      name: "all models",
      display: entry.rateLimits
        .map((limit) => `${limit.amount} ${limit.type}`)
        .join(" / "),
    })
  }
  return windows
}

function recordLimit(
  summaries: Map<string, RateLimitSummary>,
  order: string[],
  type: string,
  amount: number,
): void {
  const summary = summaries.get(type)
  if (summary === undefined) {
    summaries.set(type, { min: amount, max: amount, models: 0 })
    order.push(type)
    return
  }
  if (amount < summary.min) summary.min = amount
  if (amount > summary.max) summary.max = amount
}

function collectModelWindows(
  entries: RateLimitsResponse["data"]["rateLimits"],
): UsageWindow[] {
  const summaries = new Map<string, RateLimitSummary>()
  const order: string[] = []
  for (const entry of entries) {
    if (entry.apiModelId === undefined || entry.rateLimits.length === 0) continue
    const seen = new Set<string>()
    for (const limit of entry.rateLimits) {
      recordLimit(summaries, order, limit.type, limit.amount)
      seen.add(limit.type)
    }
    for (const type of seen) {
      const summary = summaries.get(type)
      if (summary !== undefined) summary.models += 1
    }
  }
  const windows: UsageWindow[] = []
  for (const type of order) {
    const summary = summaries.get(type)
    if (summary !== undefined) {
      windows.push({
        name: `per-model ${type}`,
        display: formatSummary(summary),
      })
    }
  }
  return windows
}

export function mapRateLimits(data: RateLimitsResponse): UsageSuccess {
  const entries = data.data.rateLimits
  const windows = [
    ...collectAccountWindows(entries),
    ...collectModelWindows(entries),
  ]

  const result: UsageSuccess = { windows }
  const balance = formatBalance(data.data.balances)
  if (balance !== undefined) result.balance = balance
  const expiration = data.data.keyExpiration
  if (expiration !== null) result.until = expiration
  return result
}

export function mapUsageFailure(failure: {
  status: number
  detail?: string
}): UsageFailure {
  if (failure.detail === UNEXPECTED_RESPONSE_SHAPE) {
    return {
      error: "Venice returned an unexpected usage response shape",
      windows: [],
    }
  }
  if (failure.status === 401) {
    return {
      error: "Venice rejected this API key (HTTP 401)",
      signIn: "expired",
      windows: [],
    }
  }
  if (failure.status === 402) {
    return {
      error:
        "Venice reports insufficient balance or a spending cap was reached (HTTP 402)",
      windows: [],
    }
  }
  return {
    error: `Venice usage request failed (HTTP ${failure.status})`,
    windows: [],
  }
}

export function createUsage(
  fetchImpl: FetchLike = fetch,
): (getAuth: () => Promise<UsageAuth | undefined>) => Promise<UsageReport> {
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return { windows: [] }
    const result = await fetchRateLimits(auth.key, fetchImpl)
    if (result.ok) return mapRateLimits(result.data)
    return mapUsageFailure(result)
  }
}
