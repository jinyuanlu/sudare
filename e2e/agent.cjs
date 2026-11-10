// End-to-end, the agent path, in a real browser:
//   an MCP client enrols through the OAuth consent page (loopback + PKCE),
//   a message is handed off in the web app, the agent claims it and drafts a
//   reply over MCP, the person approves the draft in the web app, and the
//   other person receives it marked as sent via an agent.
//
//   sh scripts/quickstart.sh                         # one terminal
//   ADMIN_SECRET=... node e2e/agent.cjs              # another
const { chromium } = require('playwright')
const http = require('node:http')
const crypto = require('node:crypto')

const ORIGIN = process.env.SUDARE_ORIGIN ?? 'http://localhost:8787'
const ADMIN = process.env.ADMIN_SECRET
const b64url = (b) => Buffer.from(b).toString('base64url')
const json = (r) => r.json()

const person = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { page, context }
}

const join = async (who, url, handle) => {
  await who.page.goto(url)
  await who.page.getByTestId('register').click()
  await who.page.getByTestId('handle').fill(handle)
  await who.page.getByTestId('join').click()
  await who.page.getByTestId('composer').waitFor()
}

/** The first person: through open sign-up where the server has it, else through the operator's link. */
const start = async (who, handle, topic) => {
  const site = await fetch(`${ORIGIN}/api/site`).then((r) => r.json())
  if (!site.signup) {
    if (!ADMIN) throw new Error('set ADMIN_SECRET (this server has no open sign-up)')
    const boot = await fetch(`${ORIGIN}/admin/bootstrap`, {
      method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ topic }),
    }).then((r) => r.json())
    return join(who, boot.url, handle)
  }
  await who.page.goto(`${ORIGIN}/login`)
  await who.page.getByTestId('signup').click()
  await who.page.getByTestId('handle').fill(handle)
  await who.page.getByTestId('join').click()
  await who.page.getByTestId('composer').waitFor()
}

/** A local MCP client: dynamic registration, then authorization code + PKCE to a loopback port. */
const enrol = async (who) => {
  let resolve
  const got = new Promise((r) => (resolve = r))
  const server = http.createServer((req, res) => {
    resolve(new URL(req.url, 'http://127.0.0.1'))
    res.end('You can close this tab.')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const redirect = `http://127.0.0.1:${server.address().port}/callback`

  const meta = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`).then(json)
  const client = await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E Agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  }).then(json)
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope: 'agent', state: 'e2e', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` })

  // The person is signed in already, so the consent page shows directly.
  await who.page.goto(`${meta.authorization_endpoint}?${query}`)
  await who.page.getByText('E2E Agent').first().waitFor()
  await who.page.getByLabel('Name this device').fill('e2e laptop')
  await who.page.getByRole('button', { name: 'Allow' }).click()
  const back = await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error('no OAuth callback')), 15_000))]).catch(async (e) => {
    throw new Error(`${e.message}; the browser is at ${who.page.url()} showing: ${(await who.page.innerText('body')).slice(0, 300)}`)
  })
  server.close()
  if (back.searchParams.get('state') !== 'e2e' || back.searchParams.get('iss') !== meta.issuer) throw new Error('bad callback: state or iss')

  const token = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }),
  }).then(json)
  if (!token.access_token) throw new Error(`no token: ${JSON.stringify(token)}`)
  let n = 0
  return async (name, args = {}) => {
    const r = await fetch(`${ORIGIN}/mcp`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    }).then(json)
    const data = JSON.parse(r.result.content[0].text)
    if (r.result.isError) throw new Error(`${name}: ${JSON.stringify(data)}`)
    return data
  }
}

;(async () => {
  const browser = await chromium.launch()
  const [ann, bob] = [await person(browser), await person(browser)]

  await start(ann, 'ann', 'Agent path')
  const conv = new URL(ann.page.url()).pathname.split('/')[2]
  const link = await ann.page.evaluate((id) => fetch(`/api/convs/${id}/invites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"link":true}' }).then((r) => r.json()), conv)
  await join(bob, link.url, 'bob')

  const tool = await enrol(bob)
  if ((await tool('inbox')).messages.length !== 0) throw new Error('I2: the agent sees a message nobody handed off')

  await ann.page.getByTestId('composer').fill('bob, what TTL do you want for the cache?')
  await ann.page.getByTestId('send').click()

  // bob, the human, hands the message to his agent, read-only.
  await bob.page.goto(`${ORIGIN}/inbox`)
  await bob.page.getByText('what TTL do you want').first().waitFor()
  await bob.page.getByRole('button', { name: /ask my agent/i }).first().click()

  // The agent picks it up and drafts. Nothing is sent yet.
  let waiting = []
  for (let i = 0; i < 50 && waiting.length === 0; i++) {
    waiting = (await tool('inbox')).messages
    if (waiting.length === 0) await new Promise((r) => setTimeout(r, 100))
  }
  if (waiting.length !== 1) throw new Error('the handed-off message did not reach the agent')
  const claimed = await tool('claim', { msg: waiting[0].msg })
  if (claimed.mode !== 'readonly' || !/TTL/.test(claimed.message.untrusted_text)) throw new Error('claim returned the wrong message or mode')
  const draft = await tool('draft', { conv, text: 'Five minutes works for us.', to: ['ann'], cause: waiting[0].msg })
  if ((await ann.page.getByTestId('msg').filter({ hasText: 'Five minutes' }).count()) !== 0) throw new Error('I1: a draft was delivered without approval')

  // bob approves it in the web app.
  await bob.page.goto(`${ORIGIN}/drafts`)
  await bob.page.getByRole('button', { name: 'Send', exact: true }).first().waitFor().catch(async (e) => {
    throw new Error(`drafts page shows: ${(await bob.page.innerText('body')).slice(0, 500)} :: ${e.message.slice(0, 80)}`)
  })
  await bob.page.getByRole('button', { name: 'Send', exact: true }).first().click()

  // ann receives it live, marked as written by an agent and approved.
  const row = ann.page.getByTestId('msg').filter({ hasText: 'Five minutes works for us.' }).first()
  await row.waitFor({ timeout: 10_000 })
  if (!/agent/i.test(await row.innerText())) throw new Error('the delegate badge is missing')
  if ((await tool('draft_status', { draft: draft.draft })).status !== 'approved') throw new Error('the agent was not told its draft was approved')
  // Sending the reply finished the message: nothing is left for the agent, and its access to the room has ended.
  if ((await tool('inbox')).messages.length !== 0) throw new Error('the answered message is still waiting for an agent')
  if ((await tool('history', { conv }).then(() => 'readable', () => 'closed')) !== 'closed') throw new Error('the agent can still read the room after the reply was sent')

  // bob revokes the device in Settings; the token stops working.
  await bob.page.goto(`${ORIGIN}/settings`)
  const revoke = bob.page.getByRole('button', { name: /disconnect/i })
  await revoke.first().waitFor()
  bob.page.on('dialog', (d) => d.accept())
  await revoke.first().click()
  await revoke.first().waitFor({ state: 'detached' }) // bob's only device is gone from the list
  const after = await tool('inbox').then(() => 'still works', () => 'refused')
  if (after !== 'refused') throw new Error('the revoked device can still call tools')

  await browser.close()
  console.log('ok: OAuth consent, ask my agent, claim, draft, send in app, agent badge, disconnect')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
