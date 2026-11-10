import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, type Site } from './api'
import { t } from './i18n'
import { Link } from './router'
import { errText } from './util'

export const ErrorNote = ({ error }: { error: unknown }) =>
  error ? <p class="error" role="alert">{typeof error === 'string' ? error : errText(error)}</p> : null

export const Loading = () => <p class="muted pad" role="status">{t('common.loading')}</p>

type PageProps = { title: string; back?: string; sub?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; wide?: boolean }

export const Page = ({ title, back = '/', sub, actions, children, wide }: PageProps) => (
  <section class="page">
    <header class="bar">
      <Link class="back" href={back} aria-label={t('common.back')}>‹</Link>
      <div class="bar-title">
        <h1>{title}</h1>
        {sub ? <div class="muted small">{sub}</div> : null}
      </div>
      {actions}
    </header>
    <div class={wide ? 'body' : 'body narrow'}>{children}</div>
  </section>
)

let site: Promise<Site> | null = null
/** What this server says about itself; asked once. */
export const useSite = (): Site | null => {
  const [s, set] = useState<Site | null>(null)
  useEffect(() => { void (site ??= api.site().catch(() => ({ signup: false, notice: '' }))).then(set) }, [])
  return s
}

/** The operator's one line about this server, where there is one. */
export const SiteNotice = () => {
  const notice = useSite()?.notice
  return notice ? <p class="muted small site-notice" data-testid="site-notice">{notice}</p> : null
}

/** A full-screen card for the signed-out and one-purpose pages. */
export const Solo = ({ title, children }: { title: string; children: ComponentChildren }) => (
  <main class="solo">
    <img src="/icon.svg" alt="" width="56" height="56" />
    <h1>{title}</h1>
    {children}
    <SiteNotice />
  </main>
)

export const Modal = ({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) => {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])
  return (
    <dialog ref={ref} class="modal" aria-label={title} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <header class="bar">
        <h2>{title}</h2>
        <button type="button" class="ghost" onClick={onClose} aria-label={t('common.close')}>✕</button>
      </header>
      <div class="modal-body">{children}</div>
    </dialog>
  )
}

const INSTALL = 'claude plugin install sudare --marketplace jinyuanlu/sudare'
const PUBLIC_INSTANCE = 'https://sudare.luke.archi'

/** How to get Sudare into Claude Code: one command and two steps, always in view. */
export const QuickStart = ({ onDismiss }: { onDismiss?: () => void }) => (
  <section class="quick">
    <h3>{t('quick.title')}</h3>
    <p class="muted small">{t('quick.lead')}</p>
    <ol>
      <li>
        {t('quick.s1')}
        <div class="row"><code>{INSTALL.split(' ').map((w, i) => <>{i ? ' ' : ''}<span class="nb">{w}</span></>)}</code> <CopyButton text={INSTALL} label={t('quick.copy')} /></div>
      </li>
      {location.origin !== PUBLIC_INSTANCE ? <li>{t('quick.server', { origin: location.origin })}</li> : null}
      <li>{t('quick.s2')}</li>
      <li>{t('quick.s3')}</li>
    </ol>
    {onDismiss ? <button type="button" class="link" onClick={onDismiss}>{t('quick.dismiss')}</button> : null}
  </section>
)

export const CopyButton = ({ text, label }: { text: string; label?: string }) => {
  const [done, setDone] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setDone(true)
      setTimeout(() => setDone(false), 1500)
    })
  }
  return <button type="button" onClick={copy}>{done ? t('common.copied') : (label ?? t('common.copy'))}</button>
}

type FieldProps = { label: string; hint?: string; children: ComponentChildren }
/** A labelled control: the label wraps its input, so no ids are needed. */
export const Field = ({ label, hint, children }: FieldProps) => (
  <label class="field">
    <span class="field-label">{label}</span>
    {children}
    {hint ? <span class="muted small">{hint}</span> : null}
  </label>
)

export const Badge = ({ n, label }: { n: number; label: string }) =>
  n > 0 ? <span class="badge" aria-label={`${n} ${label}`}>{n > 99 ? '99+' : n}</span> : null
