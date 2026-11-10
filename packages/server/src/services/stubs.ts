import type { ConvId, PrincipalId } from '@sudare/protocol'
import type { ConversationDO } from '../do/conversation'
import type { PrincipalDO } from '../do/principal'
import type { Env } from '../env'

/**
 * The RPC surface of a Durable Object as its own method signatures. Workers'
 * stub typing erases union arms that mention `unknown`; our results are plain
 * structured-cloneable data, so the class's signatures are the truth.
 */
type Rpc<T> = { [K in keyof T as T[K] extends (...args: never[]) => Promise<unknown> ? K : never]: T[K] }

export const convStub = (env: Env, conv: ConvId) =>
  env.CONVERSATION.get(env.CONVERSATION.idFromName(conv)) as unknown as Rpc<ConversationDO>

export const principalStub = (env: Env, p: PrincipalId) =>
  env.PRINCIPAL.get(env.PRINCIPAL.idFromName(p)) as unknown as Rpc<PrincipalDO>

export const principalSocket = (env: Env, p: PrincipalId, request: Request) =>
  env.PRINCIPAL.get(env.PRINCIPAL.idFromName(p)).fetch(request)
