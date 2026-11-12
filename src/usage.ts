import { z } from "zod"
import { UNEXPECTED_RESPONSE_SHAPE, fetchRateLimits } from "./venice"
import type { FetchLike, JsonValue, RateLimitsResponse } from "./venice"

export interface TextWindow {
  name: string
  display: string
}

export interface WalletWindow {
  name: string
  balance: number
  unit: "USD" | "DIEM" | "credits"
  resetsAt?: string
  aside?: true
}

export interface EstimateWindow {
  name: string
  amount: number
  limit: number
  unit: "credits"
  display: string
  resetsAt: string
  span: number
  aside: true
}

export type UsageWindow = TextWindow | WalletWindow | EstimateWindow

export interface UsageSuccess {
  plan?: string
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

export interface VenicePlan {
  label: string
  credits: number
}

const PLANS = new Map<string, VenicePlan>([
  ["pro", { label: "Pro", credits: 1 }],
  ["plus", { label: "Plus", credits: 75 }],
  ["max", { label: "Max", credits: 225 }],
])

const pluginOptionsSchema = z.object({ plan: z.string().optional() })

export interface PlanOption {
  plan?: VenicePlan
  invalid: boolean
}

// Options arrive as free-form JSON from the host. Only an object with a
// recognized plan name selects a tier; everything else is treated as "no
// tier configured" and, when it looked like a plan attempt, flagged for a
// trailing hint window.
export function resolvePlan(options: JsonValue | undefined): PlanOption {
  if (options === undefined || options === null) return { invalid: false }
  const parsed = pluginOptionsSchema.safeParse(options)
  if (!parsed.success) return { invalid: true }
  const raw = parsed.data.plan
  if (raw === undefined) return { invalid: false }
  const plan = PLANS.get(raw.trim().toLowerCase())
  if (plan === undefined) return { invalid: true }
  return { plan, invalid: false }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// Venice does not expose the subscription's real refresh day to an inference
// key, so the estimate assumes a new period on the first day of the next
// calendar month at 00:00 UTC and a length of 30 days.
const ESTIMATE_SPAN_SECONDS = 30 * 86400

function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

function creditWindows(
  balances: RateLimitsResponse["data"]["balances"],
  option: PlanOption,
  now: Date,
): UsageWindow[] {
  const left = balances.BUNDLED_CREDITS
  if (left === undefined) return []
  const plan = option.plan
  if (plan === undefined || left > plan.credits) {
    return [
      {
        name: "Plan credits",
        balance: left < 0 ? 0 : left,
        unit: "credits",
      },
    ]
  }
  const remaining = left < 0 ? 0 : left
  return [
    {
      name: "Plan credits (est.)",
      amount: round2(plan.credits - remaining),
      limit: plan.credits,
      unit: "credits",
      display: `${remaining} of ${plan.credits} credits left`,
      resetsAt: nextMonthStartUtc(now).toISOString(),
      span: ESTIMATE_SPAN_SECONDS,
      aside: true,
    },
  ]
}

function walletWindows(
  data: RateLimitsResponse["data"],
  option: PlanOption,
  now: Date,
): UsageWindow[] {
  const windows: UsageWindow[] = []
  const diem = data.balances.DIEM
  if (diem !== undefined && diem > 0) {
    windows.push({
      name: "Daily DIEM",
      balance: diem,
      unit: "DIEM",
      resetsAt: data.nextEpochBegins,
    })
  }
  windows.push(...creditWindows(data.balances, option, now))
  const usd = data.balances.USD
  if (usd !== undefined) {
    windows.push({
      name: "API balance",
      balance: usd < 0 ? 0 : usd,
      unit: "USD",
      aside: true,
    })
  }
  return windows
}

export function mapRateLimits(
  data: RateLimitsResponse,
  option: PlanOption = { invalid: false },
  now: Date = new Date(),
): UsageSuccess {
  const windows: UsageWindow[] = [...walletWindows(data.data, option, now)]
  if (option.invalid) {
    windows.push({
      name: "plan option",
      display: "not recognized; use pro, plus or max",
    })
  }

  const result: UsageSuccess = { windows }
  if (option.plan !== undefined) result.plan = option.plan.label
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
  options?: JsonValue,
): (getAuth: () => Promise<UsageAuth | undefined>) => Promise<UsageReport> {
  const option = resolvePlan(options)
  return async (getAuth) => {
    const auth = await getAuth()
    if (auth?.type !== "api" || !auth.key) return { windows: [] }
    const result = await fetchRateLimits(auth.key, fetchImpl)
    if (result.ok) return mapRateLimits(result.data, option)
    return mapUsageFailure(result)
  }
}
