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

export const principalSocket = (env: Env, p: PrincipalId, request: Request) => {
  // The object learns whose socket this is from the Worker, never from the client.
  const headers = new Headers(request.headers)
  headers.set('X-Sudare-Principal', p)
  return env.PRINCIPAL.get(env.PRINCIPAL.idFromName(p)).fetch(new Request(request, { headers }))
}
