// Signed-out pages and the two one-purpose pages: sign in, invitation landing, plugin link.

import { useEffect, useState } from 'preact/hooks'
import type { Me } from '@sudare/protocol'
import { normalizeHandle } from '@sudare/protocol'
import { ApiFailure, api } from '../api'
import { useAction, useLoad } from '../hooks'
import { t } from '../i18n'
import { confirmLink, registerWithInvite, signIn } from '../passkey'
import { Link, navigate } from '../router'
import { refresh } from '../store'
import { ErrorNote, Field, Loading, Solo } from '../ui'
import { fmtDate, isCode } from '../util'

export const Login = ({ next, me }: { next: string; me: Me | null | undefined }) => {
  const act = useAction()
  // `next` may be a server-rendered page (OAuth consent): always a full page load.
  useEffect(() => { if (me) location.replace(next) }, [me, next])
  return (
    <Solo title={t('login.title')}>
      <p>{t('login.lead')}</p>
      <button type="button" class="primary big" data-testid="signin" disabled={act.busy || !!me} onClick={() => void act.run(signIn)}>
        {t('login.signin')}
      </button>
      <ErrorNote error={act.error} />
      <p class="muted small">{t('login.nosignup')}</p>
    </Solo>
  )
}

type CardProps = {
  topic: string; by: string; members: number; expires: number; suggested: string | null
  onJoin: (handle: string) => Promise<void>; onDecline?: () => Promise<void>
}

/** An invitation as a card with the handle to join under. Used for links and for received invitations. */
export const InviteCard = ({ topic, by, members, expires, suggested, onJoin, onDecline }: CardProps) => {
  const [handle, setHandle] = useState(suggested ?? '')
  const act = useAction()
  const join = (e: Event) => {
    e.preventDefault()
    void act.run(async () => {
      const h = normalizeHandle(handle)
      if (!h.ok) throw new ApiFailure('handle_invalid', 400)
      await onJoin(h.value)
    })
  }
  return (
    <form class="card" onSubmit={join}>
      <h2>{topic || t('join.untitled')}</h2>
      <p class="muted small">
        {t('join.by', { by })}{members > 0 ? ` · ${t('common.members', { n: members })}` : ''} · {t('common.expires', { when: fmtDate(expires) })}
      </p>
      <Field label={t('join.handle')} hint={t('join.handleHint')}>
        <input data-testid="handle" value={handle} maxLength={24} required autocomplete="nickname" onInput={(e) => setHandle(e.currentTarget.value)} />
      </Field>
      <ErrorNote error={act.error} />
      <div class="row">
        <button type="submit" class="primary" data-testid="join" disabled={act.busy}>{t('join.join')}</button>
        {onDecline ? <button type="button" disabled={act.busy} onClick={() => void act.run(onDecline)}>{t('join.decline')}</button> : null}
      </div>
    </form>
  )
}

const JoinSignedIn = ({ code }: { code: string }) => {
  const card = useLoad(() => api.joinCard(code), [code])
  const [member, setMember] = useState(false)
  if (card.error) return <ErrorNote error={card.error} />
  if (!card.data) return <Loading />
  const c = card.data
  const open = <Link class="button primary" href={`/c/${c.conv}`}>{t('join.open')}</Link>
  if (c.joined || member) return <><p>{t(c.joined ? 'join.joined' : 'err.already_member')}</p>{open}</>
  const join = async (handle: string) => {
    try {
      const r = await api.joinAccept(code, handle)
      await refresh('convs')
      navigate(`/c/${r.conv}`, true)
    } catch (e) {
      if (isCode(e, 'already_member')) setMember(true)
      else throw e
    }
  }
  return <InviteCard topic={c.topic} by={c.by} members={c.members} expires={c.expires} suggested={c.suggested_handle} onJoin={join} />
}

export const Join = ({ code, me }: { code: string; me: Me | null | undefined }) => {
  const check = useLoad(() => api.joinCheck(code), [code])
  const act = useAction()
  const body = () => {
    if (me === undefined || (!me && check.loading)) return <Loading />
    if (me) return <JoinSignedIn code={code} />
    if (check.error) return <ErrorNote error={check.error} />
    const { valid, registered } = check.data ?? { valid: false, registered: false }
    return (
      <>
        {valid || registered ? <p>{t(registered ? 'join.registered' : 'join.lead')}</p> : <p class="error" role="alert">{t('err.invite_invalid')}</p>}
        {valid && !registered ? (
          <button type="button" class="primary big" data-testid="register" disabled={act.busy} onClick={() => void act.run(() => registerWithInvite(code))}>
            {t('join.register')}
          </button>
        ) : null}
        <button type="button" class={valid && !registered ? 'big' : 'primary big'} data-testid="signin" disabled={act.busy} onClick={() => void act.run(signIn)}>
          {valid && !registered ? t('join.have') : t('login.signin')}
        </button>
        <ErrorNote error={act.error} />
        <p class="muted small">{t('join.passkeyHint')}</p>
      </>
    )
  }
  return <Solo title={t('join.title')}>{body()}</Solo>
}

export const LinkScreen = ({ id }: { id: string }) => {
  const info = useLoad(() => api.link(id), [id])
  const act = useAction()
  const [done, setDone] = useState(false)
  const confirm = () => void act.run(async () => { await confirmLink(id); setDone(true) })
  // Ask for the passkey as soon as the page is ready: one touch and it is done. Browsers
  // that insist on a click first refuse this quietly, and the button below still works.
  const ready = info.data !== undefined && !info.data.confirmed
  useEffect(() => {
    if (ready) confirm()
  }, [ready])
  const body = () => {
    if (done || info.data?.confirmed) return <p class="ok" role="status">{t('link.done')}</p>
    if (info.error) return isCode(info.error, 'not_found') ? <p class="error" role="alert">{t('link.missing')}</p> : <ErrorNote error={info.error} />
    if (!info.data) return <Loading />
    return (
      <>
        <p>{t('link.device', { device: info.data.device })}</p>
        <p class="code" aria-label={t('link.code')}>{info.data.code}</p>
        <p class="warn">{t('link.warning')}</p>
        <p class="muted small">{t('common.expires', { when: fmtDate(info.data.expires) })}</p>
        <button type="button" class="primary big" disabled={act.busy} onClick={confirm}>
          {t('link.confirm')}
        </button>
        {isCode(act.error, 'not_found') ? <p class="error" role="alert">{t('link.missing')}</p> : <ErrorNote error={act.error} />}
      </>
    )
  }
  return <Solo title={t('link.title')}>{body()}</Solo>
}
