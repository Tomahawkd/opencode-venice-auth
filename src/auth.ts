import { BASE, fetchRateLimits } from "./venice"
import type { FetchLike } from "./venice"
import { createUsage } from "./usage"
import type { UsageReport } from "./usage"

export interface AuthorizeInputs {
  [name: string]: string
}

interface ApiAuth {
  type: "api"
  key: string
}

interface OauthAuth {
  type: "oauth"
  key?: undefined
}

type VeniceAuth = ApiAuth | OauthAuth

interface AuthFailure {
  type: "failed"
  error: string
}

interface AuthSuccess {
  type: "success"
  key: string
}

type AuthResult = AuthFailure | AuthSuccess

interface AuthPrompt {
  type: "text"
  key: string
  message: string
  placeholder: string
  validate: (value: string) => string | undefined
}

interface AuthMethod {
  type: "api"
  label: string
  placeholder: string
  keyless: true
  prompts: AuthPrompt[]
  authorize: (inputs?: AuthorizeInputs) => Promise<AuthResult>
}

interface AuthLoaderResult {
  baseURL?: string
  apiKey?: string
}

interface AuthHooks {
  provider: "venice"
  methods: AuthMethod[]
  loader: (
    getAuth: () => Promise<VeniceAuth | undefined>,
  ) => Promise<AuthLoaderResult>
  usage: (getAuth: () => Promise<VeniceAuth | undefined>) => Promise<UsageReport>
}

interface CreateAuthOptions {
  fetchImpl?: FetchLike
}

export function createAuth({ fetchImpl = fetch }: CreateAuthOptions = {}): AuthHooks {
  return {
    provider: "venice", usage: createUsage(fetchImpl),
    methods: [
      {
        type: "api",
        label: "Venice API key",
        placeholder: "Your Venice API key",
        keyless: true,
        prompts: [
          {
            type: "text",
            key: "apiKey",
            message: "Venice API key",
            placeholder: "Your Venice API key",
            validate: (value: string) => value.trim() ? undefined : "A Venice API key is required",
          },
        ],
        async authorize(inputs?: AuthorizeInputs): Promise<AuthResult> {
          const apiKey = inputs?.apiKey?.trim()
          if (!apiKey) {
            return { type: "failed", error: "A Venice API key is required" }
          }
          const result = await fetchRateLimits(apiKey, fetchImpl)
          if (!result.ok) {
            const detail = result.detail ? `: ${result.detail}` : ""
            return {
              type: "failed",
              error: `Venice rejected this API key (HTTP ${result.status})${detail}`,
            }
          }
          if (!result.data.data.accessPermitted) {
            return {
              type: "failed",
              error: "This key cannot use Venice inference APIs (accessPermitted=false)",
            }
          }
          return { type: "success", key: apiKey }
        },
      },
    ],
    async loader(
      getAuth: () => Promise<VeniceAuth | undefined>,
    ): Promise<AuthLoaderResult> {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: BASE, apiKey: auth.key }
    },
  }
}
