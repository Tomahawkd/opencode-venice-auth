import { expect, test } from "bun:test"
import { _internal } from "../index"
import { createProviderModels, filterAndMapModels } from "../src/models"
import type { ProviderModelsOptions } from "../src/models"
import { BASE, fetchModels, modelsResponseSchema } from "../src/venice"
import type { FetchLike, FetchResponse, VeniceModel } from "../src/venice"
import fixture from "./fixtures/models.json"

// Snapshot 2026-11-10: GET /models?type=text unauthenticated; sequential filter hits
// offline 0, beta 2, deprecation 4, e2ee 13, no-function-calling 1; kept 119
const SNAPSHOT = {
  total: 139,
  offline: 0,
  beta: 2,
  deprecation: 4,
  e2ee: 13,
  noFc: 1,
  kept: 119,
}

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

function snapshotModels(): VeniceModel[] {
  return modelsResponseSchema.parse(fixture).data
}

interface SyntheticModelInput {
  id: string
  name: string
  offline: boolean
  betaModel: boolean
  deprecated: boolean
  supportsFunctionCalling: boolean
  supportsVision: boolean
  supportsAudioInput: boolean
  supportsReasoning: boolean
  supportsE2EE: boolean
  supportsTeeAttestation: boolean
  availableContextTokens: number
  maxCompletionTokens: number
  inputUsd: number
  outputUsd: number
  cacheInputUsd?: number
  cacheWriteUsd?: number
}

const BASE_MODEL: SyntheticModelInput = {
  id: "model-1",
  name: "Model 1",
  offline: false,
  betaModel: false,
  deprecated: false,
  supportsFunctionCalling: true,
  supportsVision: false,
  supportsAudioInput: false,
  supportsReasoning: false,
  supportsE2EE: false,
  supportsTeeAttestation: false,
  availableContextTokens: 8192,
  maxCompletionTokens: 4096,
  inputUsd: 1,
  outputUsd: 2,
}

function makeModel(input: SyntheticModelInput): VeniceModel {
  return {
    id: input.id,
    model_spec: {
      name: input.name,
      offline: input.offline,
      betaModel: input.betaModel,
      deprecation: input.deprecated ? { date: "2026-01-01" } : null,
      availableContextTokens: input.availableContextTokens,
      maxCompletionTokens: input.maxCompletionTokens,
      capabilities: {
        supportsFunctionCalling: input.supportsFunctionCalling,
        supportsVision: input.supportsVision,
        supportsReasoning: input.supportsReasoning,
        supportsAudioInput: input.supportsAudioInput,
        supportsE2EE: input.supportsE2EE,
        supportsTeeAttestation: input.supportsTeeAttestation,
      },
      pricing: {
        input: { usd: input.inputUsd },
        output: { usd: input.outputUsd },
        ...(input.cacheInputUsd === undefined
          ? {}
          : { cache_input: { usd: input.cacheInputUsd } }),
        ...(input.cacheWriteUsd === undefined
          ? {}
          : { cache_write: { usd: input.cacheWriteUsd } }),
      },
    },
  }
}

function makeSimpleModel(id: string): VeniceModel {
  return makeModel({ ...BASE_MODEL, id })
}

test("server exposes the venice provider with a models hook", async () => {
  const hooks = await _internal.server()
  expect(hooks.provider.id).toBe("venice")
  expect(typeof hooks.provider.models).toBe("function")
})

test("fetchModels parses the snapshot and sends the bearer token", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const result = await fetchModels("test-key", stub.fetchImpl)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.data.data).toHaveLength(SNAPSHOT.total)
  }
  expect(stub.calls).toHaveLength(1)
  expect(stub.calls[0]?.url).toBe(`${BASE}/models?type=text`)
  expect(stub.calls[0]?.headers?.["authorization"]).toBe("Bearer test-key")
  expect(stub.calls[0]?.headers?.["accept"]).toBe("application/json")
})

test("fetchModels reports non-2xx statuses without parsing the body", async () => {
  for (const status of [401, 500]) {
    const stub = makeStub({ ok: false, status, json: async () => ({}) })
    const result = await fetchModels("key", stub.fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(status)
    }
  }
})

test("fetchModels rejects a body with the wrong shape as unexpected", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => ({}) })
  const result = await fetchModels("key", stub.fetchImpl)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.status).toBe(200)
    expect(result.detail).toBe("unexpected response shape")
  }
})

test("fetchModels rejects invalid JSON as unexpected", async () => {
  const stub = makeStub({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token")
    },
  })
  const result = await fetchModels("key", stub.fetchImpl)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.status).toBe(200)
    expect(result.detail).toBe("unexpected response shape")
  }
})

test("fetchModels propagates body read and network failures", async () => {
  const readFailure = makeStub({
    ok: true,
    status: 200,
    json: async () => {
      throw new TypeError("read interrupted")
    },
  })
  await expect(fetchModels("key", readFailure.fetchImpl)).rejects.toThrow(
    "read interrupted",
  )

  const fetchImpl: FetchLike = async () => {
    throw new Error("network down")
  }
  await expect(fetchModels("key", fetchImpl)).rejects.toThrow("network down")
})

test("snapshot filtering keeps the recorded number of models", () => {
  const models = snapshotModels()
  expect(models).toHaveLength(SNAPSHOT.total)
  expect(Object.keys(filterAndMapModels(models))).toHaveLength(SNAPSHOT.kept)
})

test("snapshot sequential filter hits match the recorded counts", () => {
  const models = snapshotModels()
  const hits = { offline: 0, beta: 0, deprecation: 0, e2ee: 0, noFc: 0 }
  for (const model of models) {
    const spec = model.model_spec
    if (spec.offline === true) {
      hits.offline += 1
      continue
    }
    if (spec.betaModel === true) {
      hits.beta += 1
      continue
    }
    if (spec.deprecation != null) {
      hits.deprecation += 1
      continue
    }
    if (
      model.id.startsWith("e2ee-") ||
      spec.capabilities.supportsE2EE === true ||
      spec.capabilities.supportsTeeAttestation === true
    ) {
      hits.e2ee += 1
      continue
    }
    if (spec.capabilities.supportsFunctionCalling === false) {
      hits.noFc += 1
      continue
    }
  }
  expect(hits).toEqual({
    offline: SNAPSHOT.offline,
    beta: SNAPSHOT.beta,
    deprecation: SNAPSHOT.deprecation,
    e2ee: SNAPSHOT.e2ee,
    noFc: SNAPSHOT.noFc,
  })
})

test("snapshot mapping preserves a fully populated model", () => {
  const mapped = filterAndMapModels(snapshotModels())
  expect(mapped["qwen-3-8-max"]).toEqual({
    id: "qwen-3-8-max",
    name: "Qwen 3.8 Max",
    status: "active",
    release_date: "",
    limit: { context: 1000000, output: 131072 },
    cost: {
      input: 2.5,
      output: 7.5,
      cache: { read: 0.3125, write: 3.125 },
    },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: true,
      input: { text: true, pdf: false, image: true, audio: false },
      output: { text: true, image: false, audio: false, video: false },
      temperature: true,
      interleaved: false,
    },
    api: {
      id: "qwen-3-8-max",
      url: BASE,
      npm: "@ai-sdk/openai-compatible",
    },
    options: {},
    headers: {},
  })
})

test("snapshot mapping fills absent cache prices with zero", () => {
  const models = snapshotModels()
  const mapped = filterAndMapModels(models)
  const source = models.find(
    (model) =>
      mapped[model.id] !== undefined &&
      model.model_spec.pricing.cache_input === undefined &&
      model.model_spec.pricing.cache_write === undefined,
  )
  if (source === undefined) {
    throw new Error("fixture has no kept model without cache pricing")
  }
  const entry = mapped[source.id]
  expect(entry?.cost.cache.read).toBe(0)
  expect(entry?.cost.cache.write).toBe(0)
})

test("snapshot mapping marks audio input when the capability is set", () => {
  const models = snapshotModels()
  const mapped = filterAndMapModels(models)
  const source = models.find(
    (model) =>
      mapped[model.id] !== undefined &&
      model.model_spec.capabilities.supportsAudioInput === true,
  )
  if (source === undefined) {
    throw new Error("fixture has no kept model with audio input")
  }
  expect(mapped[source.id]?.capabilities.input.audio).toBe(true)
})

test("every snapshot entry is a text model with the nested constant fields", () => {
  const mapped = filterAndMapModels(snapshotModels())
  const entries = Object.values(mapped)
  expect(entries.length).toBe(SNAPSHOT.kept)
  for (const entry of entries) {
    expect(entry.capabilities.output.text).toBe(true)
    expect(entry.capabilities.input.text).toBe(true)
    expect(entry.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(entry.api.url).toBe(BASE)
    expect(entry.status).toBe("active")
  }
})

test("filter drops an offline model", () => {
  const kept = filterAndMapModels([
    makeModel({ ...BASE_MODEL, id: "offline", offline: true }),
    makeSimpleModel("available"),
  ])
  expect(Object.keys(kept)).toEqual(["available"])
})

test("filter drops a beta model", () => {
  const kept = filterAndMapModels([
    makeModel({ ...BASE_MODEL, id: "beta", betaModel: true }),
    makeSimpleModel("available"),
  ])
  expect(Object.keys(kept)).toEqual(["available"])
})

test("filter drops a deprecated model", () => {
  const kept = filterAndMapModels([
    makeModel({ ...BASE_MODEL, id: "deprecated", deprecated: true }),
    makeSimpleModel("available"),
  ])
  expect(Object.keys(kept)).toEqual(["available"])
})

test("filter drops e2ee models by prefix, e2ee flag or tee attestation flag", () => {
  const kept = filterAndMapModels([
    makeSimpleModel("e2ee-by-prefix"),
    makeModel({ ...BASE_MODEL, id: "flagged-e2ee", supportsE2EE: true }),
    makeModel({
      ...BASE_MODEL,
      id: "attested-tee",
      supportsTeeAttestation: true,
    }),
    makeSimpleModel("available"),
  ])
  expect(Object.keys(kept)).toEqual(["available"])
})

test("filter keeps a __proto__ model id as an own enumerable key", () => {
  const kept = filterAndMapModels([
    makeSimpleModel("__proto__"),
    makeSimpleModel("available"),
  ])
  expect(Object.hasOwn(kept, "__proto__")).toBe(true)
  expect(Object.keys(kept)).toEqual(["__proto__", "available"])
  expect(kept["__proto__"].id).toBe("__proto__")
})

test("filter drops a model without function calling", () => {
  const kept = filterAndMapModels([
    makeModel({
      ...BASE_MODEL,
      id: "no-fc",
      supportsFunctionCalling: false,
    }),
    makeSimpleModel("available"),
  ])
  expect(Object.keys(kept)).toEqual(["available"])
})

test("mapping passes name, limits and prices through and keys by id", () => {
  const kept = filterAndMapModels([
    makeModel({
      ...BASE_MODEL,
      id: "values",
      name: "Values",
      availableContextTokens: 1000000,
      maxCompletionTokens: 131072,
      inputUsd: 2.5,
      outputUsd: 7.5,
      cacheInputUsd: 0.3125,
      cacheWriteUsd: 3.125,
      supportsReasoning: true,
    }),
  ])
  expect(Object.keys(kept)).toEqual(["values"])
  expect(kept["values"]).toEqual({
    id: "values",
    name: "Values",
    status: "active",
    release_date: "",
    limit: { context: 1000000, output: 131072 },
    cost: {
      input: 2.5,
      output: 7.5,
      cache: { read: 0.3125, write: 3.125 },
    },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: false,
      input: { text: true, pdf: false, image: false, audio: false },
      output: { text: true, image: false, audio: false, video: false },
      temperature: true,
      interleaved: false,
    },
    api: {
      id: "values",
      url: BASE,
      npm: "@ai-sdk/openai-compatible",
    },
    options: {},
    headers: {},
  })
})

test("mapping builds input capability booleans from the flags", () => {
  const kept = filterAndMapModels([
    makeSimpleModel("plain"),
    makeModel({ ...BASE_MODEL, id: "vision", supportsVision: true }),
    makeModel({ ...BASE_MODEL, id: "audio", supportsAudioInput: true }),
    makeModel({
      ...BASE_MODEL,
      id: "both",
      supportsVision: true,
      supportsAudioInput: true,
    }),
  ])
  expect(kept["plain"]?.capabilities.input).toEqual({
    text: true,
    pdf: false,
    image: false,
    audio: false,
  })
  expect(kept["vision"]?.capabilities.input).toEqual({
    text: true,
    pdf: false,
    image: true,
    audio: false,
  })
  expect(kept["audio"]?.capabilities.input).toEqual({
    text: true,
    pdf: false,
    image: false,
    audio: true,
  })
  expect(kept["both"]?.capabilities.input).toEqual({
    text: true,
    pdf: false,
    image: true,
    audio: true,
  })
  expect(kept["plain"]?.capabilities.attachment).toBe(
    kept["plain"]?.capabilities.input.image,
  )
  expect(kept["vision"]?.capabilities.attachment).toBe(
    kept["vision"]?.capabilities.input.image,
  )
  expect(kept["audio"]?.capabilities.attachment).toBe(
    kept["audio"]?.capabilities.input.image,
  )
  expect(kept["both"]?.capabilities.attachment).toBe(
    kept["both"]?.capabilities.input.image,
  )
})

test("hook returns the existing list when no api key is available", async () => {
  const hook = createProviderModels()
  const provider = {
    models: filterAndMapModels([makeSimpleModel("existing")]),
  }
  const options: Array<ProviderModelsOptions | undefined> = [
    undefined,
    { auth: { type: "oauth" } },
    { auth: { type: "api" } },
  ]
  for (const value of options) {
    expect(await hook(provider, value)).toBe(provider.models)
  }
})

test("hook marks the account as expired on HTTP 401", async () => {
  const stub = makeStub({ ok: false, status: 401, json: async () => ({}) })
  const hook = createProviderModels({ fetchImpl: stub.fetchImpl })
  const provider = { models: filterAndMapModels([makeSimpleModel("existing")]) }
  let error: Error | undefined
  try {
    await hook(provider, { auth: { type: "api", key: "expired-key" } })
  } catch (caught) {
    if (!(caught instanceof Error)) throw caught
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toContain("401")
  expect(error).toHaveProperty("signIn", "expired")
})

test("hook returns the existing list on other HTTP failures", async () => {
  for (const status of [500, 403]) {
    const stub = makeStub({ ok: false, status, json: async () => ({}) })
    const hook = createProviderModels({ fetchImpl: stub.fetchImpl })
    const provider = {
      models: filterAndMapModels([makeSimpleModel("existing")]),
    }
    expect(
      await hook(provider, { auth: { type: "api", key: "rejected-key" } }),
    ).toBe(provider.models)
  }
})

test("hook returns the existing list when the body cannot be parsed", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => ({}) })
  const hook = createProviderModels({ fetchImpl: stub.fetchImpl })
  const provider = { models: filterAndMapModels([makeSimpleModel("existing")]) }
  expect(
    await hook(provider, { auth: { type: "api", key: "shape-key" } }),
  ).toBe(provider.models)
})

test("hook replaces the list with the filtered snapshot on success", async () => {
  const stub = makeStub({ ok: true, status: 200, json: async () => fixture })
  const hook = createProviderModels({ fetchImpl: stub.fetchImpl })
  const provider = { models: filterAndMapModels([makeSimpleModel("existing")]) }
  const result = await hook(provider, { auth: { type: "api", key: "good-key" } })
  expect(result).not.toBe(provider.models)
  expect(Object.keys(result)).toHaveLength(SNAPSHOT.kept)
  expect(result).toEqual(filterAndMapModels(snapshotModels()))
})

test("hook propagates network failures", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("network down")
  }
  const hook = createProviderModels({ fetchImpl })
  const provider = { models: filterAndMapModels([makeSimpleModel("existing")]) }
  await expect(
    hook(provider, { auth: { type: "api", key: "offline-key" } }),
  ).rejects.toThrow("network down")
})
