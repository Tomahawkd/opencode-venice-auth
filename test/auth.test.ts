import { expect, test } from "bun:test"
import { createAuth } from "../src/auth"
import type { AuthorizeInputs } from "../src/auth"
import { BASE, fetchRateLimits } from "../src/venice"
import type { FetchLike, FetchResponse } from "../src/venice"
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

test("api method shape is exact and authorize is callable", () => {
  const auth = createAuth()
  expect(auth.methods).toHaveLength(1)
  const method = auth.methods[0]
  expect(Object.keys(method).sort()).toEqual([
    "authorize",
    "label",
    "placeholder",
    "type",
  ])
  expect(method.type).toBe("api")
  expect(method.label).toBe("Venice API key")
  expect(method.placeholder).toBe("Your Venice API key")
  expect(typeof method.authorize).toBe("function")
})

test("missing, empty and blank keys fail with a required-key message", async () => {
  const method = createAuth().methods[0]
  const inputs: Array<AuthorizeInputs | undefined> = [
    undefined,
    {},
    { apiKey: "  " },
  ]
  for (const value of inputs) {
    const result = await method.authorize(value)
    expect(result.type).toBe("failed")
    if (result.type === "failed") {
      expect(result.error.toLowerCase()).toContain("required")
    }
  }
})

test("a 401 response fails with the HTTP status in the message", async () => {
  const stub = makeStub({ ok: false, status: 401, json: async () => ({}) })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "bad-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error).toContain("401")
  }
})

test("a 402 response fails with the HTTP status in the message", async () => {
  const stub = makeStub({ ok: false, status: 402, json: async () => ({}) })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "unfunded-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error).toContain("402")
  }
})

test("a valid key succeeds and the request carries the bearer token", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const key = "venice-test-key"
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: key,
  })
  expect(result).toEqual({ type: "success", key })
  expect(stub.calls).toHaveLength(1)
  expect(stub.calls[0]?.url).toBe(`${BASE}/api_keys/rate_limits`)
  expect(stub.calls[0]?.headers?.["authorization"]).toBe(`Bearer ${key}`)
})

test("a 200 response with an unexpected shape fails", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => ({}) })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "shape-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error.toLowerCase()).toContain("unexpected")
  }
})

test("a 200 response with invalid JSON fails with an unexpected-shape error", async () => {
  const stub = makeStub({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token")
    },
  })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "invalid-json-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error.toLowerCase()).toContain("unexpected")
  }
})

test("a 200 response with a deeply malformed body fails", async () => {
  const stub = makeStub({
    ok: true,
    status: 200,
    json: async () => ({ data: { accessPermitted: "yes" } }),
  })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "malformed-shape-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error.toLowerCase()).toContain("unexpected")
  }
})

test("a 200 response whose body read fails with a non-SyntaxError propagates", async () => {
  const stub = makeStub({
    ok: true,
    status: 200,
    json: async () => {
      throw new TypeError("read interrupted")
    },
  })
  const method = createAuth({ fetchImpl: stub.fetchImpl }).methods[0]
  await expect(
    method.authorize({ apiKey: "interrupted-key" }),
  ).rejects.toThrow("read interrupted")
})

test("a key without inference access fails with accessPermitted context", async () => {
  const denied = { data: { ...fixture.data, accessPermitted: false } }
  const stub = makeStub({ ok: true, status: 200, json: async () => denied })
  const result = await createAuth({ fetchImpl: stub.fetchImpl }).methods[0].authorize({
    apiKey: "no-inference-key",
  })
  expect(result.type).toBe("failed")
  if (result.type === "failed") {
    expect(result.error).toContain("accessPermitted")
  }
})

test("a network error propagates instead of being swallowed", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("network down")
  }
  const method = createAuth({ fetchImpl }).methods[0]
  await expect(method.authorize({ apiKey: "offline-key" })).rejects.toThrow(
    "network down",
  )
})

test("fetchRateLimits parses the fixture and accepts a null key expiration", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const result = await fetchRateLimits("key", stub.fetchImpl)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data.data.balances.USD).toBe(50.23)
  }

  const permanent = { data: { ...fixture.data, keyExpiration: null } }
  const permanentStub = makeStub({
    ok: true,
    status: 200,
    json: async () => permanent,
  })
  const permanentResult = await fetchRateLimits("key", permanentStub.fetchImpl)
  expect(permanentResult.ok).toBe(true)
  if (permanentResult.ok) {
    expect(permanentResult.data.data.keyExpiration).toBeNull()
  }
})

test("loader maps api auth to baseURL and apiKey and ignores other states", async () => {
  const auth = createAuth()
  const loaded = await auth.loader(async () => ({ type: "api", key: "stored-key" }))
  expect(loaded).toEqual({ baseURL: BASE, apiKey: "stored-key" })

  const missing = await auth.loader(async () => undefined)
  expect(missing).toEqual({})

  const oauth = await auth.loader(async () => ({ type: "oauth" }))
  expect(oauth).toEqual({})
})
