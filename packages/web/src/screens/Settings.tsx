import { useState } from 'preact/hooks'
import type { DeviceView } from '@sudare/protocol'
import { api, type NewToken } from '../api'
import { useAction, useLoad } from '../hooks'
import { t, type Lang } from '../i18n'
import { addPasskey } from '../passkey'
import { navigate } from '../router'
import { LANG_KEY, setState, signedOut, useStore } from '../store'
import { CopyButton, ErrorNote, Field, Loading, Page, QuickStart } from '../ui'
import { base64UrlToBytes, fmtDate, isIOS, isStandalone } from '../util'

const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const currentPush = async (): Promise<{ reg: ServiceWorkerRegistration; sub: PushSubscription | null } | null> => {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? { reg, sub: await reg.pushManager.getSubscription() } : null
}

/** Best effort: a signed-out browser should not keep being woken. */
const dropPush = async (): Promise<void> => {
  const push = await currentPush().catch(() => null)
  if (!push?.sub) return
  await api.pushUnsubscribe(push.sub.endpoint).catch(() => undefined)
  await push.sub.unsubscribe().catch(() => undefined)
}

const PushSection = ({ vapid }: { vapid: string | null }) => {
  const push = useLoad(currentPush, [])
  const act = useAction()
  const [denied, setDenied] = useState(false)
  const enable = () => void act.run(async () => {
    const reg = push.data?.reg
    if (!reg || !vapid) return
    if ((await Notification.requestPermission()) !== 'granted') {
      setDenied(true)
      return
    }
    // Pushes carry no payload, so the server needs the endpoint and nothing else.
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapid) })
    await api.pushSubscribe(sub.endpoint)
    push.reload()
  })
  const disable = () => void act.run(async () => {
    await dropPush()
    push.reload()
  })
  const body = () => {
    if (!vapid) return <p class="muted small">{t('push.off')}</p>
    if (isIOS() && !isStandalone()) return <p class="muted small">{t('push.ios')}</p>
    if (push.loading && push.data === undefined) return <Loading />
    if (!push.data) return <p class="muted small">{t('push.unsupported')}</p>
    return (
      <>
        <p class="muted small">{t('push.explain')}</p>
        {denied || Notification.permission === 'denied' ? <p class="error" role="alert">{t('push.denied')}</p> : null}
        <ErrorNote error={act.error} />
        {push.data.sub
          ? <button type="button" disabled={act.busy} onClick={disable}>{t('push.disable')}</button>
          : <button type="button" class="primary" disabled={act.busy} onClick={enable}>{t('push.enable')}</button>}
      </>
    )
  }
  return <section><h2>{t('push.title')}</h2>{body()}</section>
}

const DeviceRow = ({ d, onChanged }: { d: DeviceView; onChanged: () => void }) => {
  const [name, setName] = useState(d.name)
  const act = useAction()
  const patch = (next: { name: string; rounds: boolean }) => void act.run(async () => {
    await api.patchDevice(d.id, next)
    onChanged()
  })
  const revoke = () => {
    if (confirm(t('devices.revokeConfirm', { name: d.name }))) void act.run(async () => { await api.revokeDevice(d.id); onChanged() })
  }
  return (
    <li class="card">
      <form class="row" onSubmit={(e) => { e.preventDefault(); patch({ name: name.trim(), rounds: d.rounds }) }}>
        <input value={name} maxLength={60} required aria-label={t('devices.name')} onInput={(e) => setName(e.currentTarget.value)} />
        <button type="submit" disabled={act.busy || name.trim() === '' || name.trim() === d.name}>{t('devices.rename')}</button>
      </form>
      <p class="muted small">
        {t(d.kind === 'oauth' ? 'devices.oauth' : 'devices.token')} · {d.client} · {d.last_active ? t('devices.active', { when: fmtDate(d.last_active) }) : t('devices.never')} ·{' '}
        {d.expires ? t('common.expires', { when: fmtDate(d.expires) }) : t('devices.noExpiry')}
      </p>
      <label class="inline">
        <input type="checkbox" checked={d.rounds} disabled={act.busy} onChange={(e) => patch({ name: d.name, rounds: e.currentTarget.checked })} /> {t('devices.rounds')}
      </label>
      <ErrorNote error={act.error} />
      <div class="row"><button type="button" class="danger" disabled={act.busy} onClick={revoke}>{t('devices.revoke')}</button></div>
    </li>
  )
}

const mcpConfig = (made: NewToken): string =>
  JSON.stringify({ mcpServers: { sudare: { type: 'http', url: made.mcp, headers: { Authorization: `Bearer ${made.token}` } } } }, null, 2)

const TokenForm = ({ onMade }: { onMade: () => void }) => {
  const [name, setName] = useState('')
  const [days, setDays] = useState('30')
  const [rounds, setRounds] = useState(false)
  const [made, setMade] = useState<NewToken | null>(null)
  const act = useAction()
  const create = (e: Event) => {
    e.preventDefault()
    void act.run(async () => {
      setMade(await api.newToken({ name: name.trim(), days: Number(days), rounds }))
      setName('')
      onMade()
    })
  }
  return (
    <>
      <form class="card" onSubmit={create}>
        <h3>{t('devices.generate')}</h3>
        <p class="muted small">{t('devices.generateHint')}</p>
        <Field label={t('devices.name')}>
          <input value={name} maxLength={60} required onInput={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label={t('devices.days')}>
          <input type="number" inputMode="numeric" min={1} max={365} step={1} required value={days} onInput={(e) => setDays(e.currentTarget.value)} />
        </Field>
        <label class="inline"><input type="checkbox" checked={rounds} onChange={(e) => setRounds(e.currentTarget.checked)} /> {t('devices.rounds')}</label>
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy || name.trim() === ''}>{t('devices.generate')}</button>
      </form>
      {made ? (
        <div class="once" role="status">
          <p class="warn">{t('devices.tokenOnce')}</p>
          <input readOnly class="mono" value={made.token} aria-label={t('devices.tokenLabel')} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={made.token} />
          <pre class="note mono">{mcpConfig(made)}</pre>
          <CopyButton text={mcpConfig(made)} label={t('devices.copyConfig')} />
        </div>
      ) : null}
    </>
  )
}

const Devices = () => {
  const devices = useLoad(api.devices, [])
  const mcp = `${location.origin}/mcp`
  return (
    <section>
      <h2>{t('devices.title')}</h2>
      <QuickStart open />
      <p class="small">{t('devices.connect')}</p>
      <div class="once"><input readOnly class="mono" value={mcp} aria-label={t('devices.mcpUrl')} onFocus={(e) => e.currentTarget.select()} /><CopyButton text={mcp} /></div>
      <ErrorNote error={devices.error} />
      {!devices.data && !devices.error ? <Loading /> : null}
      {devices.data?.length === 0 ? <p class="muted small">{t('devices.empty')}</p> : null}
      <ul class="cards">{devices.data?.map((d) => <DeviceRow key={`${d.id}/${d.name}/${d.rounds}`} d={d} onChanged={devices.reload} />)}</ul>
      <TokenForm onMade={devices.reload} />
    </section>
  )
}

export const SettingsScreen = () => {
  const me = useStore((s) => s.me)
  const lang = useStore((s) => s.lang)
  const passkey = useAction()
  const out = useAction()
  const [added, setAdded] = useState(false)
  const setLang = (next: Lang) => {
    localStorage.setItem(LANG_KEY, next)
    setState({ lang: next })
  }
  const signOut = () => void out.run(async () => {
    await dropPush()
    await api.logout()
    signedOut()
    navigate('/login')
  })
  return (
    <Page title={t('settings.title')}>
      <section>
        <h2>{t('settings.you')}</h2>
        <p>{t('settings.handle')}: <strong>{me?.default_handle ?? t('settings.noHandle')}</strong></p>
        <p class="muted small">{t('settings.handleHint')}</p>
        <Field label={t('settings.language')}>
          <select value={lang} onChange={(e) => setLang(e.currentTarget.value === 'zh' ? 'zh' : 'en')}>
            <option value="en">English</option>
            <option value="zh">简体中文</option>
          </select>
        </Field>
      </section>
      <PushSection vapid={me?.vapid_key ?? null} />
      <section>
        <h2>{t('settings.passkeys')}</h2>
        <p class="muted small">{t('settings.passkeyHint')}</p>
        <ErrorNote error={passkey.error} />
        {added ? <p class="ok" role="status">{t('settings.passkeyAdded')}</p> : null}
        <button type="button" disabled={passkey.busy} onClick={() => void passkey.run(async () => { setAdded(false); await addPasskey(); setAdded(true) })}>
          {t('settings.addPasskey')}
        </button>
      </section>
      <Devices />
      <section>
        <h2>{t('settings.session')}</h2>
        {me ? <p class="muted small">{t('settings.sessionUntil', { when: fmtDate(me.session_expires) })}</p> : null}
        <ErrorNote error={out.error} />
        <button type="button" class="danger" disabled={out.busy} onClick={signOut}>{t('settings.signOut')}</button>
      </section>
    </Page>
  )
}
