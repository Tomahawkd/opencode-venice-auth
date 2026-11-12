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
}

export interface EstimateWindow {
  name: string
  amount: number
  limit: number
  unit: "credits"
  display: string
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

function creditWindows(
  balances: RateLimitsResponse["data"]["balances"],
  option: PlanOption,
): UsageWindow[] {
  const left = balances.BUNDLED_CREDITS
  if (left === undefined) return []
  const plan = option.plan
  if (plan === undefined || left > plan.credits) {
    if (left <= 0) return []
    return [{ name: "Plan credits", balance: left, unit: "credits" }]
  }
  const remaining = left < 0 ? 0 : left
  return [
    {
      name: "Plan credits (est.)",
      amount: round2(plan.credits - remaining),
      limit: plan.credits,
      unit: "credits",
      display: `${remaining} of ${plan.credits} credits left`,
      aside: true,
    },
  ]
}

function walletWindows(
  data: RateLimitsResponse["data"],
  option: PlanOption,
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
  windows.push(...creditWindows(data.balances, option))
  const usd = data.balances.USD
  if (usd !== undefined) {
    windows.push({
      name: "API balance",
      balance: usd < 0 ? 0 : usd,
      unit: "USD",
    })
  }
  return windows
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
): TextWindow[] {
  const windows: TextWindow[] = []
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
): TextWindow[] {
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
  const windows: TextWindow[] = []
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

export function mapRateLimits(
  data: RateLimitsResponse,
  option: PlanOption = { invalid: false },
): UsageSuccess {
  const entries = data.data.rateLimits
  const windows: UsageWindow[] = [
    ...walletWindows(data.data, option),
    ...collectAccountWindows(entries),
    ...collectModelWindows(entries),
  ]
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
