// The four passkey ceremonies. Each is: ask the server for options, let the
// authenticator answer, hand the answer back.

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { api } from './api'
import { loadMe } from './store'

export const signIn = async (): Promise<void> => {
  const { id, options } = await api.loginOptions()
  await api.loginVerify({ id, response: await startAuthentication({ optionsJSON: options }) })
  await loadMe()
}

export const registerWithInvite = async (code: string): Promise<void> => {
  const { id, options } = await api.registerOptions(code)
  await api.registerVerify({ id, response: await startRegistration({ optionsJSON: options }) })
  await loadMe()
}

export const addPasskey = async (): Promise<void> => {
  const { id, options } = await api.passkeyOptions()
  await api.passkeyVerify({ id, response: await startRegistration({ optionsJSON: options }) })
}

export const confirmLink = async (link: string): Promise<void> => {
  const { id, options } = await api.linkOptions(link)
  await api.linkConfirm(link, { id, response: await startAuthentication({ optionsJSON: options }) })
}
