import { BASE } from "./src/venice"
import type { JsonValue } from "./src/venice"
import { createAuth } from "./src/auth"
import { createProviderModels } from "./src/models"

interface PluginInput {
  directory?: string
}

type ServerArgs = [input?: PluginInput, options?: JsonValue]

interface ProviderEntry {
  name?: string
  npm?: string
  api?: string
}

interface ProviderMap {
  [id: string]: ProviderEntry
}

interface Config {
  provider?: ProviderMap
}

async function applyConfig(cfg: Config): Promise<void> {
  cfg.provider ??= {}
  const was = cfg.provider["venice"] ?? {}
  cfg.provider["venice"] = {
    ...was,
    name: was.name ?? "Venice",
    npm: "@ai-sdk/openai-compatible",
    api: BASE,
  }
}

const server = async (...args: ServerArgs) => ({
  config: applyConfig,
  auth: createAuth({ options: args[1] }),
  provider: { id: "venice", models: createProviderModels() },
})

export default { id: "opencode-venice-auth", server }
export const _internal = { applyConfig, server }
