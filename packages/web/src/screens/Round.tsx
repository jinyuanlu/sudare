import { useState } from 'preact/hooks'
import { LIMITS, type ConvId, type ConvView, type RoundView } from '@sudare/protocol'
import { api } from '../api'
import type { Names } from '../data'
import { useAction, useNow } from '../hooks'
import { t } from '../i18n'
import { ErrorNote, Field, Modal } from '../ui'
import { fmtDuration } from '../util'

const BriefField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <Field label={t('round.brief')} hint={t('round.briefHint')}>
    <textarea rows={4} maxLength={LIMITS.brief} value={value} onInput={(e) => onChange(e.currentTarget.value)} />
  </Field>
)

export const OpenRoundDialog = ({ conv, onClose, onOpened }: { conv: ConvId; onClose: () => void; onOpened: () => void }) => {
  const d = LIMITS.budgetDefault
  const max = LIMITS.budgetMax
  const [goal, setGoal] = useState('')
  const [brief, setBrief] = useState('')
  const [budget, setBudget] = useState({ messages: String(d.messages), chars: String(d.chars), minutes: String(d.minutes) })
  const act = useAction()
  const open = (e: Event) => {
    e.preventDefault()
    void act.run(async () => {
      await api.openRound(conv, { goal: goal.trim(), brief, messages: Number(budget.messages), chars: Number(budget.chars), minutes: Number(budget.minutes) })
      onOpened()
    })
  }
  const num = (key: keyof typeof budget, label: string, limit: number) => (
    <Field label={label}>
      <input type="number" inputMode="numeric" min={1} max={limit} step={1} required value={budget[key]} onInput={(e) => setBudget({ ...budget, [key]: e.currentTarget.value })} />
    </Field>
  )
  return (
    <Modal title={t('round.openAction')} onClose={onClose}>
      <form onSubmit={open}>
        <p class="muted small">{t('round.explain')}</p>
        <Field label={t('round.goal')}>
          <textarea rows={3} maxLength={LIMITS.goal} required value={goal} onInput={(e) => setGoal(e.currentTarget.value)} />
        </Field>
        <div class="grid3">
          {num('messages', t('round.messages'), max.messages)}
          {num('chars', t('round.chars'), max.chars)}
          {num('minutes', t('round.minutes'), max.minutes)}
        </div>
        <BriefField value={brief} onChange={setBrief} />
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy || goal.trim() === ''}>{t('round.openAction')}</button>
      </form>
    </Modal>
  )
}

const JoinRoundDialog = ({ round, onClose, onJoined }: { round: RoundView; onClose: () => void; onJoined: () => void }) => {
  const [brief, setBrief] = useState('')
  const act = useAction()
  const join = (e: Event) => {
    e.preventDefault()
    void act.run(async () => {
      await api.joinRound(round.id, brief)
      onJoined()
    })
  }
  return (
    <Modal title={t('round.join')} onClose={onClose}>
      <form onSubmit={join}>
        <p class="muted small">{t('round.rule')}</p>
        <BriefField value={brief} onChange={setBrief} />
        <ErrorNote error={act.error} />
        <button type="submit" class="primary" disabled={act.busy}>{t('round.join')}</button>
      </form>
    </Modal>
  )
}

type BannerProps = { view: ConvView; round: RoundView; name: Names; onChanged: () => void }

export const RoundBanner = ({ view, round, name, onChanged }: BannerProps) => {
  const now = useNow(1000)
  const act = useAction()
  const [joining, setJoining] = useState(false)
  const joined = round.joined.includes(view.me)
  const { budget, used } = round
  const list = (ids: typeof round.joined) => (ids.length > 0 ? ids.map(name).join(', ') : t('common.nobody'))
  const close = () => {
    if (confirm(t('round.closeConfirm'))) void act.run(async () => { await api.closeRound(round.id); onChanged() })
  }
  return (
    <section class="round" aria-label={t('round.banner')}>
      <div class="round-head">
        <strong>{t('round.banner')}</strong>
        <span class="tag round-tag" role="timer">{t('round.left', { time: fmtDuration(budget.until - now) })}</span>
      </div>
      <p class="round-goal">{round.goal}</p>
      <p class="small">
        {t('round.used', { used: used.messages, max: budget.messages, left: Math.max(0, budget.messages - used.messages) })} ·{' '}
        {t('round.usedChars', { used: used.chars, max: budget.chars, left: Math.max(0, budget.chars - used.chars) })}
      </p>
      <p class="small">{t('round.joined', { who: list(round.joined) })} · {t('round.seated', { who: list(round.seated) })}</p>
      <p class="muted small">{t('round.rule')}</p>
      <ErrorNote error={act.error} />
      <div class="row">
        {joined
          ? <button type="button" disabled={act.busy} onClick={close}>{t('round.close')}</button>
          : <button type="button" class="primary" onClick={() => setJoining(true)}>{t('round.join')}</button>}
      </div>
      {joining ? <JoinRoundDialog round={round} onClose={() => setJoining(false)} onJoined={() => { setJoining(false); onChanged() }} /> : null}
    </section>
  )
}
