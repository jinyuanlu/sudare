import type { ConvSummary } from '@sudare/protocol'
import { t } from '../i18n'
import { Link } from '../router'
import { useStore } from '../store'
import { Badge, Loading } from '../ui'
import { fmtTime } from '../util'

const NavItem = ({ href, label, n, active }: { href: string; label: string; n?: number; active: boolean }) => (
  <Link href={href} class="nav-item" aria-current={active ? 'page' : undefined}>
    {label}
    <Badge n={n ?? 0} label={label} />
  </Link>
)

const ConvItem = ({ c, active }: { c: ConvSummary; active: boolean }) => (
  <li>
    <Link href={`/c/${c.id}`} class={`conv-item${c.archived ? ' dim' : ''}`} data-testid="conv-item" aria-current={active ? 'page' : undefined}>
      <span class="conv-topic">{c.topic}</span>
      <span class="conv-meta">
        {c.round ? <span class="tag round-tag">{t('home.round')}</span> : null}
        {c.archived ? <span class="tag">{t('home.archived')}</span> : null}
        {c.pending > 0 ? <span class="badge urgent" aria-label={t('home.pending', { n: c.pending })}>@{c.pending}</span> : null}
        <Badge n={c.unread} label={t('home.unread')} />
      </span>
      <span class="muted small">
        {t('home.as', { handle: c.handle })} · {t('common.members', { n: c.members })}{c.last_ts > 0 ? ` · ${fmtTime(c.last_ts)}` : ''}
      </span>
    </Link>
  </li>
)

/** The list pane: navigation with counts, then every conversation. */
export const Home = ({ active, section }: { active: string | null; section: string }) => {
  const convs = useStore((s) => s.convs)
  const attention = useStore((s) => s.inbox?.filter((i) => i.state === 'unread' || i.state === 'read').length ?? 0)
  const drafts = useStore((s) => s.drafts?.filter((d) => d.status === 'pending' || d.status === 'approving').length ?? 0)
  const invites = useStore((s) => s.invites?.length ?? 0)
  const live = useStore((s) => s.live)
  return (
    <div class="home">
      <header class="bar">
        <div class="bar-title">
          <h1>Sudare</h1>
          {live ? null : <div class="muted small" role="status">{t('home.offline')}</div>}
        </div>
        <Link href="/new" class="button primary">{t('home.new')}</Link>
      </header>
      <nav class="nav" aria-label={t('home.nav')}>
        <NavItem href="/inbox" label={t('inbox.title')} n={attention} active={section === 'inbox'} />
        <NavItem href="/drafts" label={t('drafts.title')} n={drafts} active={section === 'drafts'} />
        <NavItem href="/invites" label={t('invites.title')} n={invites} active={section === 'invites'} />
        <NavItem href="/search" label={t('search.title')} active={section === 'search'} />
        <NavItem href="/settings" label={t('settings.title')} active={section === 'settings'} />
      </nav>
      {convs === null ? <Loading /> : convs.length === 0 ? <p class="muted pad">{t('home.empty')}</p> : (
        <ul class="conv-list" aria-label={t('home.list')}>
          {convs.map((c) => <ConvItem key={c.id} c={c} active={c.id === active} />)}
        </ul>
      )}
    </div>
  )
}
