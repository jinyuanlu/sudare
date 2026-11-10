// End-to-end smoke test in a real browser, with a virtual passkey authenticator.
//
//   pnpm dev                              # in one terminal (http://localhost:8787)
//   ADMIN_SECRET=... node e2e/smoke.cjs   # in another; needs `playwright` resolvable
//
// Two people register through invitation links, talk, and the message arrives
// live on the other side; then an addressed message is handed to an agent.
const { chromium } = require('playwright')

const ORIGIN = process.env.SUDARE_ORIGIN ?? 'http://localhost:8787'
const ADMIN = process.env.ADMIN_SECRET
const SHOTS = process.env.SHOTS

const person = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  return { page, errors }
}

const join = async (who, url, handle) => {
  await who.page.goto(url)
  await who.page.getByTestId('register').click()
  await who.page.getByTestId('handle').fill(handle)
  await who.page.getByTestId('join').click()
  await who.page.getByTestId('composer').waitFor()
}

const say = async (who, text) => {
  await who.page.getByTestId('composer').fill(text)
  await who.page.getByTestId('send').click()
  await who.page.getByTestId('msg').filter({ hasText: text }).first().waitFor()
}

const shot = (who, name) => (SHOTS ? who.page.screenshot({ path: `${SHOTS}/${name}.png` }) : null)

;(async () => {
  if (!ADMIN) throw new Error('set ADMIN_SECRET')
  const boot = await fetch(`${ORIGIN}/admin/bootstrap`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Cache plan' }),
  }).then((r) => r.json())

  const browser = await chromium.launch()
  const [ann, bob] = [await person(browser), await person(browser)]

  await join(ann, boot.url, 'ann')
  await say(ann, 'hello from ann')
  const conv = new URL(ann.page.url()).pathname.split('/')[2]
  const link = await ann.page.evaluate(
    (id) => fetch(`/api/convs/${id}/invites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"link":true}' }).then((r) => r.json()),
    conv,
  )

  await join(bob, link.url, 'bob')
  if ((await bob.page.getByTestId('msg').filter({ hasText: 'hello from ann' }).count()) !== 0) throw new Error('I12: bob sees history from before he joined')
  await say(bob, 'hi ann, bob here')
  // Live delivery: no reload on ann's side.
  await ann.page.getByTestId('msg').filter({ hasText: 'hi ann, bob here' }).first().waitFor({ timeout: 10_000 })
  await shot(ann, 'conversation')

  // In a two-person conversation bob's message is addressed to ann: it is in her inbox.
  await ann.page.goto(`${ORIGIN}/inbox`)
  await ann.page.getByText('hi ann, bob here').first().waitFor()
  await shot(ann, 'inbox')
  await ann.page.goto(`${ORIGIN}/settings`)
  await ann.page.waitForLoadState('networkidle')
  await shot(ann, 'settings')

  const headers = await fetch(`${ORIGIN}/login`).then((r) => r.headers)
  if (!(headers.get('content-security-policy') ?? '').includes("script-src 'self'")) throw new Error('CSP header missing on the app shell')

  const errors = [...ann.errors, ...bob.errors]
  await browser.close()
  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`)
  console.log('ok: register x2, join, send, live delivery, history boundary, inbox, CSP')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
