import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { ConversationDO } from './do/conversation'
import type { PrincipalDO } from './do/principal'

export type Env = {
  CONVERSATION: DurableObjectNamespace<ConversationDO>
  PRINCIPAL: DurableObjectNamespace<PrincipalDO>
  DB: D1Database
  OAUTH_KV: KVNamespace
  ASSETS: Fetcher
  OAUTH_PROVIDER: OAuthHelpers
  RL_PUBLIC?: RateLimit
  RL_WRITE?: RateLimit
  PUBLIC_ORIGIN: string
  ALLOWED_REDIRECT_ORIGINS: string
  ROUND_CLIENT_IDS: string
  PLUGIN_HUMAN_SESSION: string
  WEB_SESSION_HOURS: string
  PLUGIN_SESSION_HOURS: string
  PLUGIN_REMEMBER_HOURS?: string
  OPEN_SIGNUP?: string
  SIGNUP_DAILY_LIMIT?: string
  SITE_NOTICE?: string
  VAPID_SUBJECT: string
  VAPID_PUBLIC_KEY: string
  VAPID_PRIVATE_KEY?: string
  ADMIN_SECRET?: string
}

export const origin = (env: Env): string => env.PUBLIC_ORIGIN.replace(/\/+$/, '')
export const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
/** How long a remembered plugin session lasts; 0 means the operator does not allow remembering. */
export const rememberHours = (env: Env): number => {
  const n = Number(env.PLUGIN_REMEMBER_HOURS ?? 168)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Open sign-up: anyone may create an account without an invitation, up to a daily number. */
export const openSignup = (env: Env): boolean => env.OPEN_SIGNUP === 'on'
export const signupDailyLimit = (env: Env): number => hours(env.SIGNUP_DAILY_LIMIT, 500)

export const hours = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
