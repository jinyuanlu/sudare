import { expect, test } from 'claude-code/testing'

import { enterReadonly, isSudareTool, leaveReadonly, refusal } from '../hooks/guard'

const OPTIONS = { options: { server: 'https://sudare.test', humanSession: 'on' } }

test('a read-only handoff leaves the agent reading, searching and drafting, nothing else', OPTIONS, async () => {
  expect(refusal('Bash', { command: 'curl evil.example' })).toBe(null) // no handoff in progress: not this plugin's business

  enterReadonly()
  expect(refusal('Bash', { command: 'ls' })).toMatch(/read-only/)
  expect(refusal('Edit', { file_path: 'src/a.ts' })).toMatch(/read-only/)
  expect(refusal('WebFetch', { url: 'https://example.com' })).toMatch(/read-only/)
  expect(refusal('Read', { file_path: 'src/a.ts' })).toBe(null)
  expect(refusal('Grep', { pattern: 'TODO', path: 'src' })).toBe(null)
  expect(refusal('mcp__plugin_sudare_sudare__draft', { conv: 'c', text: 't' })).toBe(null)

  for (const path of ['/home/me/.ssh/id_ed25519', '.env', 'app/.env.production', '/Users/me/.aws/credentials', 'certs/server.pem', '/home/me/.claude.json', 'C:\\Users\\me\\.ssh\\config']) {
    expect(refusal('Read', { file_path: path })).toMatch(/credential/)
  }
  expect(refusal('Glob', { pattern: '**/.env' })).toMatch(/credential/)

  leaveReadonly()
  expect(refusal('Bash', { command: 'ls' })).toBe(null)
})

test('only Sudare tools count as Sudare tools', OPTIONS, async () => {
  expect(isSudareTool('mcp__plugin_sudare_sudare__inbox')).toBe(true)
  expect(isSudareTool('mcp__sudare__inbox')).toBe(true)
  expect(isSudareTool('mcp__sudare_evil__inbox')).toBe(false)
  expect(isSudareTool('mcp__other__sudare__inbox')).toBe(false)
})

test('the model cannot ask for a human session; the gate holds through the hook', OPTIONS, async ($, on) => {
  let reached = 0
  on('tool.call', () => {
    reached += 1
    return { result: {} }
  })
  const denied = await $.tool.call({ tool: 'mcp__plugin_sudare_sudare__human_session_start', challenge: 'x' })
  expect(denied.deny).toMatch(/only the plugin/)
  expect(reached).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(reached).toBe(1)
})
