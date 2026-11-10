import { expect, test } from "bun:test"
import { createAuth } from "../src/auth"
import { createUsage, mapRateLimits } from "../src/usage"
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

function apiAuth(key: string): () => Promise<UsageAuth> {
  return async () => ({ type: "api", key })
}

const FIXTURE_REPORT: UsageSuccess = {
  balance: "$50.23 · 100.023 DIEM · 25 BUNDLED_CREDITS",
  until: "2025-06-01T00:00:00.000Z",
  windows: [{ name: "zai-org-glm-5-1", display: "100 RPM" }],
}

test("createAuth exposes a usage hook that runs through the injected fetch", async () => {
  expect(typeof createAuth().usage).toBe("function")

  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const usage = createAuth({ fetchImpl: stub.fetchImpl }).usage
  const result = await usage(apiAuth("assembly-key"))
  expect(result).toEqual(FIXTURE_REPORT)
  expect(stub.calls).toHaveLength(1)
})

test("the fixture maps to balance, expiration and display-only windows", async () => {
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
  expect(result.balance).toBe("$50.23 · 100.023 DIEM · 25 BUNDLED_CREDITS")
})

test("balance joins all present currencies in USD, DIEM, bundled credits order", () => {
  const all = mapRateLimits(makeSample())
  expect(all.balance).toBe("$50.23 · 100.023 DIEM · 25 BUNDLED_CREDITS")

  const withoutUsd = mapRateLimits(
    makeSample({ balances: { DIEM: 100.023, BUNDLED_CREDITS: 25 } }),
  )
  expect(withoutUsd.balance).toBe("100.023 DIEM · 25 BUNDLED_CREDITS")

  const credits = mapRateLimits(
    makeSample({ balances: { BUNDLED_CREDITS: 25 } }),
  )
  expect(credits.balance).toBe("25 BUNDLED_CREDITS")

  const empty = mapRateLimits(makeSample({ balances: {} }))
  expect("balance" in empty).toBe(false)
})

test("zero-valued USD balances are kept in the joined display", () => {
  const withDiem = mapRateLimits(makeSample({ balances: { USD: 0, DIEM: 100 } }))
  expect(withDiem.balance).toBe("$0 · 100 DIEM")

  const usdOnly = mapRateLimits(makeSample({ balances: { USD: 0 } }))
  expect(usdOnly.balance).toBe("$0")
})

test("rate limits become display-only windows and empty entries are skipped", () => {
  const result = mapRateLimits(
    makeSample({
      rateLimits: [
        {
          apiModelId: "model-a",
          rateLimits: [
            { amount: 100, type: "RPM" },
            { amount: 10000, type: "TPM" },
          ],
        },
        { rateLimits: [{ amount: 50, type: "RPM" }] },
        { apiModelId: "empty", rateLimits: [] },
      ],
    }),
  )
  expect(result.windows).toEqual([
    { name: "model-a", display: "100 RPM / 10000 TPM" },
    { name: "all models", display: "50 RPM" },
  ])

  const none = mapRateLimits(makeSample({ rateLimits: [] }))
  expect(none.windows).toEqual([])
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
