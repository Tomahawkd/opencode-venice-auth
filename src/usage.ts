import { fetchRateLimits } from "./venice"
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
  if (balances.USD !== undefined) return `$${balances.USD}`
  if (balances.DIEM !== undefined) return `${balances.DIEM} DIEM`
  if (balances.BUNDLED_CREDITS !== undefined) {
    return `${balances.BUNDLED_CREDITS} BUNDLED_CREDITS`
  }
  return undefined
}

export function mapRateLimits(data: RateLimitsResponse): UsageSuccess {
  const windows = data.data.rateLimits
    .filter((entry) => entry.rateLimits.length > 0)
    .map((entry) => ({
      name: entry.apiModelId ?? "all models",
      display: entry.rateLimits
        .map((limit) => `${limit.amount} ${limit.type}`)
        .join(" / "),
    }))

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
  if (failure.detail === "unexpected response shape") {
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
