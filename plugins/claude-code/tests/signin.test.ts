import { expect, test } from 'claude-code/testing'

const OPTIONS = { options: { server: 'https://sudare.test', humanSession: 'on' } }

test('the plugin itself may start a sign-in, through its own MCP connection', OPTIONS, async ($, on) => {
  const asked: string[] = []
  on('command.register', () => ({ value: { command: 'sudare' } }))
  on('mcp.call', (_, e) => {
    asked.push(JSON.stringify(e))
    return { value: { content: [{ type: 'text', text: JSON.stringify({ url: 'https://sudare.test/link/abc', link: 'abc', expires: 1 }) }], isError: false } }
  })
  on('tool.call', (_, e) => {
    asked.push(`tool.call ${String(e.tool)}`)
    return { result: { content: [{ type: 'text', text: JSON.stringify({ url: 'https://sudare.test/link/abc', link: 'abc', expires: 1 }) }], isError: false } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"confirmed":false}' } }))

  const out = await $.command.run({ command: 'sudare', args: 'signin' } as Parameters<typeof $.command.run>[0])
  expect(asked.length).toBeGreaterThan(0)
  expect(out.text).toMatch(/code/i)
})
