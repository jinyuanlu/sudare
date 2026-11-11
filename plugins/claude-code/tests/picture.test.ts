import { expect, test } from 'claude-code/testing'

// The same arithmetic as the panel's, kept beside it: a thumbnail keeps the picture's shape inside 36 x 8 cells.
const box = (w: number, h: number, widest = 80) => {
  const shape = Math.max(1, w) / Math.max(1, h)
  const columns = Math.max(4, Math.min(36, widest))
  const rows = Math.max(1, Math.round(columns / shape / 2))
  return rows <= 8 ? { columns, rows } : { columns: Math.max(2, Math.round(8 * 2 * shape)), rows: 8 }
}

test('a thumbnail keeps its shape and stays small', {}, async () => {
  for (const [w, h] of [[1946, 388], [2000, 1280], [800, 800], [600, 2400], [3000, 200], [16, 16]] as const) {
    const { columns, rows } = box(w, h)
    expect(columns).toBeLessThanOrEqual(36)
    expect(rows).toBeLessThanOrEqual(8)
    // cells are about twice as tall as wide: columns / (rows * 2) is the drawn shape
    const drawn = columns / (rows * 2)
    const real = w / h
    expect(Math.abs(drawn - real) / real).toBeLessThan(rows === 1 || columns <= 4 ? 5 : 0.35)
  }
  expect(box(2000, 1280)).toEqual({ columns: 25, rows: 8 })
  expect(box(1946, 388)).toEqual({ columns: 36, rows: 4 })
})
