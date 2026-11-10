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

function omitField<T, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value
  return rest
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
      input: { text: true, pdf: false, image: true, audio: false, video: false },
      output: {
        text: true,
        image: false,
        audio: false,
        video: false,
        pdf: false,
      },
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

test("filter short-circuits in order and keeps only models that match no rule", () => {
  const kept = filterAndMapModels([
    makeModel({
      ...BASE_MODEL,
      id: "e2ee-triple-hit",
      offline: true,
      supportsFunctionCalling: false,
    }),
    makeModel({
      ...BASE_MODEL,
      id: "beta-deprecated-double-hit",
      betaModel: true,
      deprecated: true,
    }),
    makeModel({ ...BASE_MODEL, id: "offline-only", offline: true }),
    makeModel({ ...BASE_MODEL, id: "beta-only", betaModel: true }),
    makeModel({ ...BASE_MODEL, id: "deprecated-only", deprecated: true }),
    makeSimpleModel("e2ee-prefix-only"),
    makeModel({ ...BASE_MODEL, id: "flagged-e2ee-only", supportsE2EE: true }),
    makeModel({ ...BASE_MODEL, id: "tee-flag-only", supportsTeeAttestation: true }),
    makeModel({
      ...BASE_MODEL,
      id: "no-function-calling-only",
      supportsFunctionCalling: false,
    }),
    makeSimpleModel("green-a"),
    makeSimpleModel("green-b"),
  ])
  expect(Object.keys(kept)).toEqual(["green-a", "green-b"])
})

interface ProbeFlags {
  offline: boolean
  betaModel: boolean
  supportsFunctionCalling: boolean
}

interface ProbeModel {
  model: VeniceModel
  reads: string[]
}

type ProbeSpec = VeniceModel["model_spec"]
type ProbeCapabilities = ProbeSpec["capabilities"]

// Replaces a data property with a get accessor that records the read before
// returning the value. The target keeps its concrete VeniceModel shape.
function defineRead<T, K extends keyof T>(
  target: T,
  key: K,
  label: string,
  reads: string[],
  read: () => T[K],
): void {
  Object.defineProperty(target, key, {
    get: () => {
      reads.push(label)
      return read()
    },
    enumerable: true,
    configurable: true,
  })
}

function makeProbeCapabilities(
  reads: string[],
  supportsFunctionCalling: boolean,
): ProbeCapabilities {
  const capabilities: ProbeCapabilities = {
    supportsFunctionCalling,
    supportsVision: false,
    supportsReasoning: false,
    supportsAudioInput: false,
    supportsE2EE: false,
    supportsTeeAttestation: false,
  }
  defineRead(
    capabilities,
    "supportsFunctionCalling",
    "supportsFunctionCalling",
    reads,
    () => supportsFunctionCalling,
  )
  defineRead(capabilities, "supportsE2EE", "supportsE2EE", reads, () => false)
  defineRead(
    capabilities,
    "supportsTeeAttestation",
    "supportsTeeAttestation",
    reads,
    () => false,
  )
  return capabilities
}

function makeProbeSpec(
  id: string,
  flags: ProbeFlags,
  reads: string[],
): ProbeSpec {
  const spec: ProbeSpec = {
    name: `Probe ${id}`,
    offline: flags.offline,
    betaModel: flags.betaModel,
    deprecation: null,
    availableContextTokens: 8192,
    maxCompletionTokens: 4096,
    capabilities: makeProbeCapabilities(reads, flags.supportsFunctionCalling),
    pricing: { input: { usd: 1 }, output: { usd: 2 } },
  }
  const capabilities = spec.capabilities
  defineRead(spec, "offline", "offline", reads, () => flags.offline)
  defineRead(spec, "betaModel", "betaModel", reads, () => flags.betaModel)
  defineRead(spec, "deprecation", "deprecation", reads, () => null)
  defineRead(spec, "capabilities", "capabilities", reads, () => capabilities)
  return spec
}

function makeProbeModel(id: string, flags: ProbeFlags): ProbeModel {
  const reads: string[] = []
  const model: VeniceModel = { id, model_spec: makeProbeSpec(id, flags, reads) }
  return { model, reads }
}

test("filter stops an offline model before reading later fields", () => {
  const probe = makeProbeModel("offline-probe", {
    offline: true,
    betaModel: true,
    supportsFunctionCalling: false,
  })
  expect(filterAndMapModels([probe.model])).toEqual({})
  expect(probe.reads).toContain("offline")
  expect(probe.reads).not.toContain("betaModel")
  expect(probe.reads).not.toContain("deprecation")
  expect(probe.reads).not.toContain("capabilities")
})

test("filter stops an e2ee-prefixed model before reading the e2ee flags", () => {
  const probe = makeProbeModel("e2ee-prefix-probe", {
    offline: false,
    betaModel: false,
    supportsFunctionCalling: true,
  })
  expect(filterAndMapModels([probe.model])).toEqual({})
  expect(probe.reads).toContain("offline")
  expect(probe.reads).toContain("betaModel")
  expect(probe.reads).toContain("deprecation")
  expect(probe.reads).not.toContain("supportsE2EE")
  expect(probe.reads).not.toContain("supportsTeeAttestation")
})

test("filter reads every earlier field before stopping on function calling", () => {
  const probe = makeProbeModel("no-fc-probe", {
    offline: false,
    betaModel: false,
    supportsFunctionCalling: false,
  })
  expect(filterAndMapModels([probe.model])).toEqual({})
  expect(probe.reads).toContain("offline")
  expect(probe.reads).toContain("betaModel")
  expect(probe.reads).toContain("deprecation")
  expect(probe.reads).toContain("capabilities")
  expect(probe.reads).toContain("supportsE2EE")
  expect(probe.reads).toContain("supportsTeeAttestation")
  expect(probe.reads).toContain("supportsFunctionCalling")
  // The capabilities container is read twice (e2ee block, then function-calling
  // block); only each rule field's first read carries the ordering contract.
  const ruleFields = [
    "offline",
    "betaModel",
    "deprecation",
    "supportsE2EE",
    "supportsFunctionCalling",
  ]
  const firstReadIndexes = ruleFields.map((field) => probe.reads.indexOf(field))
  for (const [position, index] of firstReadIndexes.entries()) {
    expect(index).toBeGreaterThanOrEqual(0)
    if (position > 0) {
      expect(index).toBeGreaterThan(firstReadIndexes[position - 1])
    }
  }
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
    cost: { input: 2.5, output: 7.5, cache: { read: 0.3125, write: 3.125 } },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: false,
      input: {
        text: true,
        pdf: false,
        image: false,
        audio: false,
        video: false,
      },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      temperature: true,
      interleaved: false,
    },
    api: { id: "values", url: BASE, npm: "@ai-sdk/openai-compatible" },
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
  const expectedInputs = [
    { id: "plain", image: false, audio: false },
    { id: "vision", image: true, audio: false },
    { id: "audio", image: false, audio: true },
    { id: "both", image: true, audio: true },
  ]
  for (const expected of expectedInputs) {
    expect(kept[expected.id]?.capabilities.input).toEqual({
      text: true,
      pdf: false,
      image: expected.image,
      audio: expected.audio,
      video: false,
    })
    expect(kept[expected.id]?.capabilities.attachment).toBe(expected.image)
  }
  for (const entry of Object.values(kept)) {
    expect(entry.capabilities.output).toEqual({
      text: true,
      image: false,
      audio: false,
      video: false,
      pdf: false,
    })
  }
})

function fixtureEntry(): VeniceModel {
  return modelsResponseSchema.parse(fixture).data[0]
}

function withModelSpec<T>(entry: VeniceModel, modelSpec: T) {
  return { data: [{ ...entry, model_spec: modelSpec }] }
}

test("modelsResponseSchema rejects a broken top-level or model_spec field", () => {
  const entry = fixtureEntry()
  const spec = entry.model_spec
  expect(modelsResponseSchema.safeParse({ data: [entry] }).success).toBe(true)
  const cases = [
    { label: "data missing", response: {} },
    { label: "data is not an array", response: { data: {} } },
    { label: "id missing", response: { data: [omitField(entry, "id")] } },
    { label: "id is a number", response: { data: [{ ...entry, id: 7 }] } },
    {
      label: "model_spec missing",
      response: { data: [omitField(entry, "model_spec")] },
    },
    {
      label: "name missing",
      response: withModelSpec(entry, omitField(spec, "name")),
    },
    {
      label: "name is a number",
      response: withModelSpec(entry, { ...spec, name: 7 }),
    },
    {
      label: "offline missing",
      response: withModelSpec(entry, omitField(spec, "offline")),
    },
    {
      label: "offline is a string",
      response: withModelSpec(entry, { ...spec, offline: "false" }),
    },
    {
      label: "availableContextTokens missing",
      response: withModelSpec(entry, omitField(spec, "availableContextTokens")),
    },
    {
      label: "availableContextTokens is null",
      response: withModelSpec(entry, {
        ...spec,
        availableContextTokens: null,
      }),
    },
    { label: "maxCompletionTokens missing", response: withModelSpec(entry, omitField(spec, "maxCompletionTokens")) },
  ]
  for (const broken of cases) {
    expect(
      modelsResponseSchema.safeParse(broken.response).success,
      broken.label,
    ).toBe(false)
  }
})

test("modelsResponseSchema rejects a broken capability field", () => {
  const entry = fixtureEntry()
  const spec = entry.model_spec
  const capabilities = spec.capabilities
  const withCapabilities = <T>(value: T) =>
    withModelSpec(entry, { ...spec, capabilities: value })
  const cases = [
    { label: "capabilities missing", response: withModelSpec(entry, omitField(spec, "capabilities")) },
    {
      label: "supportsFunctionCalling missing",
      response: withCapabilities(
        omitField(capabilities, "supportsFunctionCalling"),
      ),
    },
    {
      label: "supportsVision is a number",
      response: withCapabilities({ ...capabilities, supportsVision: 1 }),
    },
    {
      label: "supportsReasoning missing",
      response: withCapabilities(omitField(capabilities, "supportsReasoning")),
    },
    {
      label: "supportsAudioInput missing",
      response: withCapabilities(omitField(capabilities, "supportsAudioInput")),
    },
    {
      label: "supportsE2EE missing",
      response: withCapabilities(omitField(capabilities, "supportsE2EE")),
    },
    {
      label: "supportsTeeAttestation missing",
      response: withCapabilities(
        omitField(capabilities, "supportsTeeAttestation"),
      ),
    },
  ]
  for (const broken of cases) {
    expect(
      modelsResponseSchema.safeParse(broken.response).success,
      broken.label,
    ).toBe(false)
  }
})

test("modelsResponseSchema rejects a broken pricing or optional field", () => {
  const entry = fixtureEntry()
  const spec = entry.model_spec
  const pricing = spec.pricing
  const withSpec = <T>(value: T) => withModelSpec(entry, value)
  const withPricing = <T>(value: T) =>
    withModelSpec(entry, { ...spec, pricing: value })
  const cases = [
    { label: "pricing missing", response: withSpec(omitField(spec, "pricing")) },
    {
      label: "pricing.input missing",
      response: withPricing(omitField(pricing, "input")),
    },
    {
      label: "pricing.input.usd is a string",
      response: withPricing({ ...pricing, input: { usd: "2.5" } }),
    },
    {
      label: "pricing.output missing",
      response: withPricing(omitField(pricing, "output")),
    },
    {
      label: "pricing.output.usd is a boolean",
      response: withPricing({ ...pricing, output: { usd: false } }),
    },
    {
      label: "pricing.cache_input.usd is a boolean",
      response: withPricing({ ...pricing, cache_input: { usd: true } }),
    },
    {
      label: "pricing.cache_write.usd is a string",
      response: withPricing({ ...pricing, cache_write: { usd: "free" } }),
    },
    {
      label: "betaModel is a string",
      response: withSpec({ ...spec, betaModel: "yes" }),
    },
    {
      label: "deprecation is a number",
      response: withSpec({ ...spec, deprecation: 3 }),
    },
  ]
  for (const broken of cases) {
    expect(
      modelsResponseSchema.safeParse(broken.response).success,
      broken.label,
    ).toBe(false)
  }
})

test("modelsResponseSchema rejects model_spec and capability type errors", () => {
  const entry = fixtureEntry()
  const spec = entry.model_spec
  const capabilities = spec.capabilities
  const withSpec = <T>(value: T) => withModelSpec(entry, value)
  const withCapabilities = <T>(value: T) =>
    withModelSpec(entry, { ...spec, capabilities: value })
  expect(modelsResponseSchema.safeParse({ data: [entry] }).success).toBe(true)
  const cases = [
    {
      label: "model_spec is a string",
      response: withSpec("model_spec"),
    },
    {
      label: "maxCompletionTokens is a string",
      response: withSpec({ ...spec, maxCompletionTokens: "4096" }),
    },
    {
      label: "supportsFunctionCalling is a number",
      response: withCapabilities({ ...capabilities, supportsFunctionCalling: 1 }),
    },
    {
      label: "supportsReasoning is a number",
      response: withCapabilities({ ...capabilities, supportsReasoning: 1 }),
    },
    {
      label: "supportsAudioInput is a number",
      response: withCapabilities({ ...capabilities, supportsAudioInput: 1 }),
    },
    {
      label: "supportsE2EE is a number",
      response: withCapabilities({ ...capabilities, supportsE2EE: 1 }),
    },
    {
      label: "supportsTeeAttestation is a number",
      response: withCapabilities({ ...capabilities, supportsTeeAttestation: 1 }),
    },
    {
      label: "capabilities is a string",
      response: withCapabilities("capabilities"),
    },
  ]
  for (const broken of cases) {
    expect(
      modelsResponseSchema.safeParse(broken.response).success,
      broken.label,
    ).toBe(false)
  }
})

test("modelsResponseSchema rejects malformed pricing containers and absent usd", () => {
  const entry = fixtureEntry()
  const spec = entry.model_spec
  const pricing = spec.pricing
  const withPricing = <T>(value: T) =>
    withModelSpec(entry, { ...spec, pricing: value })
  expect(modelsResponseSchema.safeParse({ data: [entry] }).success).toBe(true)
  const cases = [
    {
      label: "pricing is a string",
      response: withPricing("pricing"),
    },
    {
      label: "pricing.input is a string",
      response: withPricing({ ...pricing, input: "2.5" }),
    },
    {
      label: "pricing.output is a string",
      response: withPricing({ ...pricing, output: "7.5" }),
    },
    {
      label: "pricing.input.usd missing",
      response: withPricing({ ...pricing, input: {} }),
    },
    {
      label: "pricing.output.usd missing",
      response: withPricing({ ...pricing, output: {} }),
    },
  ]
  for (const broken of cases) {
    expect(
      modelsResponseSchema.safeParse(broken.response).success,
      broken.label,
    ).toBe(false)
  }
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
