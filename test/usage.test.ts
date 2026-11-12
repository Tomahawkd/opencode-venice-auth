import { expect, test } from "bun:test"
import { createAuth } from "../src/auth"
import { createUsage, mapRateLimits, resolvePlan } from "../src/usage"
import type { UsageAuth, UsageSuccess } from "../src/usage"
import { BASE } from "../src/venice"
import type { FetchLike, FetchResponse, RateLimitsResponse } from "../src/venice"
import fixture from "./fixtures/rate-limits.json"

interface RecordedCall {
  url: string
  headers?: { [name: string]: string }
}

function makeStub(response: FetchResponse): {
  fetchImpl: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    return response
  }
  return { fetchImpl, calls }
}

interface SampleOverrides {
  balances?: RateLimitsResponse["data"]["balances"]
  keyExpiration?: string | null
  rateLimits?: RateLimitsResponse["data"]["rateLimits"]
}

function makeSample(overrides: SampleOverrides = {}): RateLimitsResponse {
  return {
    data: {
      accessPermitted: true,
      apiTier: { id: "paid", isCharged: true },
      balances: overrides.balances ?? fixture.data.balances,
      keyExpiration:
        overrides.keyExpiration === undefined
          ? fixture.data.keyExpiration
          : overrides.keyExpiration,
      nextEpochBegins: fixture.data.nextEpochBegins,
      rateLimits: overrides.rateLimits ?? fixture.data.rateLimits,
    },
  }
}

function walletSample(
  balances: RateLimitsResponse["data"]["balances"],
): RateLimitsResponse {
  return makeSample({ balances, rateLimits: [] })
}

function apiAuth(key: string): () => Promise<UsageAuth> {
  return async () => ({ type: "api", key })
}

const FIXTURE_REPORT: UsageSuccess = {
  until: "2025-06-01T00:00:00.000Z",
  windows: [
    {
      name: "Daily DIEM",
      balance: 100.023,
      unit: "DIEM",
      resetsAt: "2025-05-07T00:00:00.000Z",
    },
    { name: "Plan credits", balance: 25, unit: "credits" },
    { name: "API balance", balance: 50.23, unit: "USD", aside: true },
  ],
}

const FIXED_NOW = new Date("2026-11-12T08:00:00.000Z")
const FIXED_RESETS_AT = "2026-12-01T00:00:00.000Z"
const ESTIMATE_SPAN_SECONDS = 2592000

test("createAuth exposes a usage hook that runs through the injected fetch", async () => {
  expect(typeof createAuth().usage).toBe("function")

  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const usage = createAuth({ fetchImpl: stub.fetchImpl }).usage
  const result = await usage(apiAuth("assembly-key"))
  expect(result).toEqual(FIXTURE_REPORT)
  expect(stub.calls).toHaveLength(1)
})

test("the fixture maps only to balance and expiration windows", async () => {
  const key = "fixture-key"
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const usage = createUsage(stub.fetchImpl)

  const result = await usage(apiAuth(key))
  expect(result).toEqual(FIXTURE_REPORT)
  expect(stub.calls).toHaveLength(1)
  expect(stub.calls[0]?.url).toBe(`${BASE}/api_keys/rate_limits`)
  expect(stub.calls[0]?.headers?.["authorization"]).toBe(`Bearer ${key}`)
  expect(stub.calls[0]?.headers?.["accept"]).toBe("application/json")
})

test("a null key expiration leaves until absent", () => {
  const result = mapRateLimits(makeSample({ keyExpiration: null }))
  expect("until" in result).toBe(false)
  expect(result.windows).toEqual([
    {
      name: "Daily DIEM",
      balance: 100.023,
      unit: "DIEM",
      resetsAt: "2025-05-07T00:00:00.000Z",
    },
    { name: "Plan credits", balance: 25, unit: "credits" },
    { name: "API balance", balance: 50.23, unit: "USD", aside: true },
  ])
})

test("windows follow the Venice charge order and carry currency-specific fields", () => {
  const result = mapRateLimits(
    makeSample({
      rateLimits: [
        { rateLimits: [{ amount: 50, type: "RPM" }] },
        {
          apiModelId: "model-a",
          rateLimits: [{ amount: 100, type: "RPM" }],
        },
      ],
    }),
    resolvePlan({ plan: "gold" }),
  )

  expect(result.windows).toEqual([
    {
      name: "Daily DIEM",
      balance: 100.023,
      unit: "DIEM",
      resetsAt: "2025-05-07T00:00:00.000Z",
    },
    { name: "Plan credits", balance: 25, unit: "credits" },
    { name: "API balance", balance: 50.23, unit: "USD", aside: true },
    {
      name: "plan option",
      display: "not recognized; use pro, plus or max",
    },
  ])
  expect("plan" in result).toBe(false)
})

test("rate limit entries do not produce any text windows", () => {
  const result = mapRateLimits(
    makeSample({
      rateLimits: [
        {
          rateLimits: [
            { amount: 50, type: "RPM" },
            { amount: 5000, type: "TPM" },
          ],
        },
        {
          apiModelId: "model-a",
          rateLimits: [
            { amount: 100, type: "RPM" },
            { amount: 10000, type: "TPM" },
          ],
        },
        {
          apiModelId: "model-b",
          rateLimits: [{ amount: 75, type: "RPM" }],
        },
      ],
    }),
  )
  expect(result.windows).toEqual([
    {
      name: "Daily DIEM",
      balance: 100.023,
      unit: "DIEM",
      resetsAt: "2025-05-07T00:00:00.000Z",
    },
    { name: "Plan credits", balance: 25, unit: "credits" },
    { name: "API balance", balance: 50.23, unit: "USD", aside: true },
  ])
})

test("zero and missing balances follow the per-currency visibility rules", () => {
  const zeroes = mapRateLimits(
    walletSample({ USD: 0, DIEM: 0, BUNDLED_CREDITS: 0 }),
  )
  expect(zeroes.windows).toEqual([
    { name: "Plan credits", balance: 0, unit: "credits" },
    { name: "API balance", balance: 0, unit: "USD", aside: true },
  ])

  const negativeUsd = mapRateLimits(walletSample({ USD: -3.5 }))
  expect(negativeUsd.windows).toEqual([
    { name: "API balance", balance: 0, unit: "USD", aside: true },
  ])

  const missingUsd = mapRateLimits(
    walletSample({ DIEM: 0, BUNDLED_CREDITS: 25 }),
  )
  expect(missingUsd.windows).toEqual([
    { name: "Plan credits", balance: 25, unit: "credits" },
  ])
})

test("Daily DIEM appears only above zero and resets at the next epoch", () => {
  const present = mapRateLimits(walletSample({ DIEM: 100.023, USD: 1 }))
  expect(present.windows[0]).toEqual({
    name: "Daily DIEM",
    balance: 100.023,
    unit: "DIEM",
    resetsAt: "2025-05-07T00:00:00.000Z",
  })

  const zero = mapRateLimits(walletSample({ DIEM: 0, USD: 1 }))
  expect(zero.windows).toEqual([{ name: "API balance", balance: 1, unit: "USD", aside: true }])
})

test("plan credits without a tier show the wallet at zero and floor negative balances", () => {
  const positive = mapRateLimits(walletSample({ BUNDLED_CREDITS: 25 }))
  expect(positive.windows).toEqual([
    { name: "Plan credits", balance: 25, unit: "credits" },
  ])

  const zero = mapRateLimits(walletSample({ BUNDLED_CREDITS: 0 }))
  expect(zero.windows).toEqual([
    { name: "Plan credits", balance: 0, unit: "credits" },
  ])

  const negative = mapRateLimits(walletSample({ BUNDLED_CREDITS: -4.5 }))
  expect(negative.windows).toEqual([
    { name: "Plan credits", balance: 0, unit: "credits" },
  ])

  const missing = mapRateLimits(walletSample({}))
  expect(missing.windows).toEqual([])
})

test("estimates cover the pro, plus and max tiers", () => {
  interface EstimateCase {
    plan: string
    balance: number
    label: string
    amount: number
    limit: number
    display: string
  }
  const cases: EstimateCase[] = [
    { plan: "pro", balance: 0, label: "Pro", amount: 1, limit: 1, display: "0 of 1 credits left" },
    { plan: "plus", balance: 25, label: "Plus", amount: 50, limit: 75, display: "25 of 75 credits left" },
    { plan: "max", balance: 225, label: "Max", amount: 0, limit: 225, display: "225 of 225 credits left" },
  ]
  for (const item of cases) {
    const result = mapRateLimits(
      walletSample({ BUNDLED_CREDITS: item.balance }),
      resolvePlan({ plan: item.plan }),
      FIXED_NOW,
    )
    expect(result.plan).toBe(item.label)
    expect(result.windows).toEqual([
      {
        name: "Plan credits (est.)",
        amount: item.amount,
        limit: item.limit,
        unit: "credits",
        display: item.display,
        resetsAt: FIXED_RESETS_AT,
        span: ESTIMATE_SPAN_SECONDS,
        aside: true,
      },
    ])
  }
})

test("estimate windows reset at the next month start and span 30 days", () => {
  const cases: Array<{ now: string; resetsAt: string }> = [
    { now: "2026-11-12T08:00:00.000Z", resetsAt: "2026-12-01T00:00:00.000Z" },
    { now: "2026-11-30T23:59:59.999Z", resetsAt: "2026-12-01T00:00:00.000Z" },
    { now: "2026-11-01T00:00:00.000Z", resetsAt: "2026-12-01T00:00:00.000Z" },
    { now: "2026-12-15T12:00:00.000Z", resetsAt: "2027-01-01T00:00:00.000Z" },
    { now: "2028-02-29T12:00:00.000Z", resetsAt: "2028-03-01T00:00:00.000Z" },
  ]
  for (const { now, resetsAt } of cases) {
    const result = mapRateLimits(
      walletSample({ BUNDLED_CREDITS: 25 }),
      resolvePlan({ plan: "plus" }),
      new Date(now),
    )
    expect(result.windows).toEqual([
      {
        name: "Plan credits (est.)",
        amount: 50,
        limit: 75,
        unit: "credits",
        display: "25 of 75 credits left",
        resetsAt,
        span: 2592000,
        aside: true,
      },
    ])
  }
})

test("plan names are matched case-insensitively with surrounding whitespace", () => {
  const result = mapRateLimits(
    walletSample({ BUNDLED_CREDITS: 25 }),
    resolvePlan({ plan: "  PlUs  " }),
    FIXED_NOW,
  )
  expect(result.plan).toBe("Plus")
  expect(result.windows[0]).toEqual({
    name: "Plan credits (est.)",
    amount: 50,
    limit: 75,
    unit: "credits",
    display: "25 of 75 credits left",
    resetsAt: FIXED_RESETS_AT,
    span: ESTIMATE_SPAN_SECONDS,
    aside: true,
  })
})

test("estimated usage is rounded to two decimals", () => {
  const result = mapRateLimits(
    walletSample({ BUNDLED_CREDITS: 25.006 }),
    resolvePlan({ plan: "plus" }),
    FIXED_NOW,
  )
  expect(result.windows).toEqual([
    {
      name: "Plan credits (est.)",
      amount: 49.99,
      limit: 75,
      unit: "credits",
      display: "25.006 of 75 credits left",
      resetsAt: FIXED_RESETS_AT,
      span: ESTIMATE_SPAN_SECONDS,
      aside: true,
    },
  ])
})

test("a zero balance with a tier shows the full quota used", () => {
  const result = mapRateLimits(
    walletSample({ BUNDLED_CREDITS: 0 }),
    resolvePlan({ plan: "plus" }),
    FIXED_NOW,
  )
  expect(result.windows).toEqual([
    {
      name: "Plan credits (est.)",
      amount: 75,
      limit: 75,
      unit: "credits",
      display: "0 of 75 credits left",
      resetsAt: FIXED_RESETS_AT,
      span: ESTIMATE_SPAN_SECONDS,
      aside: true,
    },
  ])
})

test("a negative bundled balance with a tier floors the estimate at zero", () => {
  const result = mapRateLimits(
    walletSample({ BUNDLED_CREDITS: -2 }),
    resolvePlan({ plan: "plus" }),
    FIXED_NOW,
  )
  expect(result.plan).toBe("Plus")
  expect(result.windows).toEqual([
    {
      name: "Plan credits (est.)",
      amount: 75,
      limit: 75,
      unit: "credits",
      display: "0 of 75 credits left",
      resetsAt: FIXED_RESETS_AT,
      span: ESTIMATE_SPAN_SECONDS,
      aside: true,
    },
  ])
})

test("a balance above the tier limit falls back to a wallet window", () => {
  const result = mapRateLimits(
    walletSample({ BUNDLED_CREDITS: 100 }),
    resolvePlan({ plan: "plus" }),
  )
  expect(result.plan).toBe("Plus")
  expect(result.windows).toEqual([
    { name: "Plan credits", balance: 100, unit: "credits" },
  ])
})

test("missing bundled credits omit the plan window even with a tier", () => {
  const result = mapRateLimits(
    walletSample({ USD: 1 }),
    resolvePlan({ plan: "plus" }),
  )
  expect(result.plan).toBe("Plus")
  expect(result.windows).toEqual([
    { name: "API balance", balance: 1, unit: "USD", aside: true },
  ])
})

test("no options or a missing plan key do not add the hint window", () => {
  for (const option of [resolvePlan(undefined), resolvePlan(null), resolvePlan({})]) {
    const result = mapRateLimits(makeSample(), option)
    expect("plan" in result).toBe(false)
    expect(
      result.windows.some((window) => window.name === "plan option"),
    ).toBe(false)
  }
})

test("invalid plan options fall back to no tier and add the hint window", () => {
  const options = [
    resolvePlan({ plan: 42 }),
    resolvePlan({ plan: "gold" }),
    resolvePlan("plus"),
  ]
  for (const option of options) {
    expect(option).toEqual({ invalid: true })
    const result = mapRateLimits(makeSample(), option)
    expect("plan" in result).toBe(false)
    expect(result.windows).toContainEqual({
      name: "plan option",
      display: "not recognized; use pro, plus or max",
    })
    expect(result.windows).toContainEqual({
      name: "Plan credits",
      balance: 25,
      unit: "credits",
    })
  }
})

test("HTTP 402 reports a balance or spending-cap failure without marking sign-in", async () => {
  const stub = makeStub({ ok: false, status: 402, json: async () => ({}) })
  const result = await createUsage(stub.fetchImpl)(apiAuth("capped-key"))

  expect("error" in result).toBe(true)
  if ("error" in result) {
    expect(result.error).toBe(
      "Venice reports insufficient balance or a spending cap was reached (HTTP 402)",
    )
    expect(result.windows).toEqual([])
    expect("signIn" in result).toBe(false)
  }
})

test("HTTP 401 marks the account as expired", async () => {
  const stub = makeStub({ ok: false, status: 401, json: async () => ({}) })
  const result = await createUsage(stub.fetchImpl)(apiAuth("expired-key"))

  expect("error" in result).toBe(true)
  if ("error" in result) {
    expect(result.error).toBe("Venice rejected this API key (HTTP 401)")
    expect(result.signIn).toBe("expired")
    expect(result.windows).toEqual([])
  }
})

test("other non-2xx statuses fail without marking sign-in", async () => {
  const stub = makeStub({ ok: false, status: 500, json: async () => ({}) })
  const result = await createUsage(stub.fetchImpl)(apiAuth("failing-key"))

  expect("error" in result).toBe(true)
  if ("error" in result) {
    expect(result.error).toBe("Venice usage request failed (HTTP 500)")
    expect("signIn" in result).toBe(false)
    expect(result.windows).toEqual([])
  }
})

test("a 200 response with a malformed body maps to the unexpected-shape error", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => ({}) })
  const result = await createUsage(stub.fetchImpl)(apiAuth("shape-key"))

  expect("error" in result).toBe(true)
  if ("error" in result) {
    expect(result.error).toBe(
      "Venice returned an unexpected usage response shape",
    )
    expect("signIn" in result).toBe(false)
    expect(result.windows).toEqual([])
  }
})

test("a 200 response with invalid JSON maps to the unexpected-shape error", async () => {
  const stub = makeStub({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token")
    },
  })
  const result = await createUsage(stub.fetchImpl)(apiAuth("invalid-json-key"))

  expect("error" in result).toBe(true)
  if ("error" in result) {
    expect(result.error).toBe(
      "Venice returned an unexpected usage response shape",
    )
    expect("signIn" in result).toBe(false)
    expect(result.windows).toEqual([])
  }
})

test("missing, non-api or blank auth returns empty windows without a request", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const usage = createUsage(stub.fetchImpl)
  const states: Array<UsageAuth | undefined> = [
    undefined,
    { type: "oauth" },
    { type: "api", key: "" },
  ]

  for (const state of states) {
    const result = await usage(async () => state)
    expect(result).toEqual({ windows: [] })
  }
  expect(stub.calls).toHaveLength(0)
})

test("network failures propagate instead of being swallowed", async () => {
  const failure = new Error("network down")
  const fetchImpl: FetchLike = async () => {
    throw failure
  }
  const usage = createUsage(fetchImpl)
  await expect(usage(apiAuth("offline-key"))).rejects.toBe(failure)
})
