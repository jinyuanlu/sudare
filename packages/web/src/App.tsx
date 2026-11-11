import { useEffect, useState } from 'preact/hooks'
import { t } from './i18n'
import { Link, loginPath, navigate, parseRoute, safeNext, useLocation, type Route } from './router'
import { useStore } from './store'
import { Loading, Page, Solo } from './ui'
import { Join, LinkScreen, Login } from './screens/Auth'
import { ConvScreen } from './screens/Conv'
import { Home } from './screens/Home'
import { DraftsScreen, InboxScreen, InvitesScreen, SearchScreen } from './screens/Lists'
import { NewScreen } from './screens/New'
import { NoteScreen, NotesScreen } from './screens/Notes'
import { SettingsScreen } from './screens/Settings'

const int = (raw: string | null): number | null => (raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null)

const Screen = ({ route, query }: { route: Route; query: URLSearchParams }) => {
  switch (route.name) {
    case 'conv': return <ConvScreen key={`${route.id}/${query.get('at') ?? ''}`} id={route.id} at={int(query.get('at'))} />
    case 'notes': return <NotesScreen key={route.id} id={route.id} />
    case 'note': return <NoteScreen key={route.note} id={route.id} note={route.note} rev={int(query.get('rev'))} />
    case 'new': return <NewScreen key={query.get('parent') ?? ''} parent={query.get('parent')} />
    case 'inbox': return <InboxScreen />
    case 'drafts': return <DraftsScreen />
    case 'invites': return <InvitesScreen />
    case 'search': return <SearchScreen key={query.get('q') ?? ''} query={query.get('q') ?? ''} />
    case 'settings': return <SettingsScreen />
    case 'home': return <p class="muted pad center placeholder">{t('home.pick')}</p>
    default: return <Page title={t('notfound.title')}><p>{t('notfound.body')}</p><Link class="button" href="/">{t('notfound.home')}</Link></Page>
  }
}

/** One picture, alone and large: what "enlarge" in a terminal opens. Click to switch between fitting the window and full size. */
const Picture = ({ conv, image }: { conv: string; image: string }) => {
  const [full, setFull] = useState(false)
  const [missing, setMissing] = useState(false)
  return (
    <main class={`picture${full ? ' full' : ''}`}>
      <p class="picture-bar"><Link href={`/c/${conv}`}>{t('picture.back')}</Link> <span class="muted small">{missing ? '' : t(full ? 'picture.fit' : 'picture.full')}</span></p>
      {missing
        ? <p class="error" role="alert">{t('picture.missing')}</p>
        : <img src={`/api/convs/${conv}/images/${image}`} alt={t('picture.alt')} data-testid="picture" onClick={() => setFull((f) => !f)} onError={() => setMissing(true)} />}
    </main>
  )
}

export const App = () => {
  const me = useStore((s) => s.me)
  const lang = useStore((s) => s.lang)
  const loc = useLocation()
  const route = parseRoute(loc.path)
  const open = route.name === 'login' || route.name === 'join'

  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en' }, [lang])
  // Signed out (or the session ended mid-use): sign in, then come back to this exact place.
  useEffect(() => { if (me === null && !open) navigate(loginPath(), true) }, [me, open, loc.path])

  const body = () => {
    if (route.name === 'login') return <Login next={safeNext(loc.query.get('next'))} me={me} />
    if (route.name === 'join') return <Join key={route.code} code={route.code} me={me} />
    if (me === undefined) return <Solo title="Sudare"><Loading /></Solo>
    if (me === null) return null
    if (route.name === 'link') return <LinkScreen key={route.id} id={route.id} />
    if (route.name === 'picture') return <Picture key={route.image} conv={route.id} image={route.image} />
    const active = route.name === 'conv' || route.name === 'notes' || route.name === 'note' ? route.id : null
    return (
      <div class="shell" data-route={route.name}>
        <aside class="list-pane"><Home active={active} section={route.name} /></aside>
        <main class="main-pane"><Screen route={route} query={loc.query} /></main>
      </div>
    )
  }
  // Keyed by language so every string is rendered again when it changes.
  return <div class="root" key={lang}>{body()}</div>
}
