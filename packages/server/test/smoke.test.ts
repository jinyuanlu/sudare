import { describe, expect, it } from 'vitest'
import { eventually, founder } from './harness'

describe('smoke', () => {
  it('bootstraps, registers the first person with a passkey, and lists the conversation', async () => {
    const { who, conv } = await founder()
    const list = await eventually(async () => { const l = await who.convs(); return l.length ? l : null })
    expect(list[0]!.id).toBe(conv)
    expect(list[0]!.topic).toBe('Bootstrap')
    expect((await who.get('/me')).body.default_handle).toBe('ann')
  })
})
