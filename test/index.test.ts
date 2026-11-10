import { expect, test } from "bun:test"
import plugin from "../index"
import * as ns from "../index"
import { _internal } from "../index"
import { BASE } from "../src/venice"

interface TestProviderEntry {
  name?: string
  npm?: string
  api?: string
}

interface EntryWithOptions extends TestProviderEntry {
  options?: { x: number }
}

interface TestProviderMap {
  [id: string]: EntryWithOptions
}

interface TestConfig {
  provider?: TestProviderMap
}

test("entry module exports exactly default and _internal", () => {
  expect(Object.keys(ns).sort()).toEqual(["_internal", "default"])
})

test("default export carries the package id and a server function", () => {
  expect(plugin.id).toBe("opencode-venice-auth")
  expect(typeof plugin.server).toBe("function")
})

test("applyConfig fills name, npm and api for an empty config", async () => {
  const cfg: TestConfig = {}
  await _internal.applyConfig(cfg)
  expect(cfg.provider?.["venice"]).toEqual({
    name: "Venice",
    npm: "@ai-sdk/openai-compatible",
    api: BASE,
  })
})

test("applyConfig preserves a user name and extra fields while overriding npm and api", async () => {
  const cfg: TestConfig = {
    provider: {
      venice: {
        name: "Mine",
        options: { x: 1 },
        npm: "venice-ai-sdk-provider",
        api: "https://venice.example/old",
      },
    },
  }
  await _internal.applyConfig(cfg)
  const entry = cfg.provider?.["venice"]
  expect(entry?.name).toBe("Mine")
  expect(entry?.options?.x).toBe(1)
  expect(entry?.npm).toBe("@ai-sdk/openai-compatible")
  expect(entry?.api).toBe(BASE)
})

test("applyConfig leaves other providers untouched", async () => {
  const other = { name: "Other", npm: "other-npm" }
  const cfg: TestConfig = { provider: { other } }
  const before = cfg.provider?.["other"]
  await _internal.applyConfig(cfg)
  expect(cfg.provider?.["other"]).toBe(before)
  expect(cfg.provider?.["other"]).toEqual({ name: "Other", npm: "other-npm" })
})

test("server returns config and auth hooks for venice", async () => {
  const hooks = await _internal.server()
  expect(hooks.auth.provider).toBe("venice")
  expect(hooks.auth.methods).toHaveLength(1)
  expect(hooks.auth.methods[0]?.type).toBe("api")
  expect(typeof hooks.config).toBe("function")
})
