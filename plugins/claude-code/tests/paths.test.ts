import { expect, test } from 'claude-code/testing'
import { picturePaths } from '../hooks/paths'

test('a pasted screenshot is found by its path, however the terminal wrote it', {}, async () => {
  expect(picturePaths('/var/folders/5y/cs_q/T/TemporaryItems/shot.png')).toEqual({ paths: ['/var/folders/5y/cs_q/T/TemporaryItems/shot.png'], rest: '' })
  expect(picturePaths(String.raw`look /Users/me/Desktop/Screenshot\ 2026-11-11\ at\ 11.02.33.PNG here`))
    .toEqual({ paths: ['/Users/me/Desktop/Screenshot 2026-11-11 at 11.02.33.PNG'], rest: 'look here' })
  expect(picturePaths(`'/tmp/a b.jpeg' "~/Pictures/c d.webp" done`)).toEqual({ paths: ['/tmp/a b.jpeg', '~/Pictures/c d.webp'], rest: 'done' })
})

test('ordinary text is left alone', {}, async () => {
  for (const text of ['see docs/img/room.png in the repo', 'https://example.com/a.png', 'the file /etc/hosts', 'a.png', '/tmp/notes.png.txt is not one']) {
    expect(picturePaths(text)).toEqual({ paths: [], rest: text })
  }
  // More than four: the first four are pictures, the rest stay words.
  const many = picturePaths('/1.png /2.png /3.png /4.png /5.png')
  expect([many.paths.length, many.rest]).toEqual([4, '/5.png'])
})
