// What a few leading bytes say a picture is. The server stores and serves only what it
// recognises here, under the type it found, never the type a client claimed.

import type { ImageType } from '@sudare/protocol'

export type Sniffed = { type: ImageType; w: number; h: number }

const ascii = (b: Uint8Array, at: number, text: string): boolean => [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0))
const be16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!
const be32 = (b: Uint8Array, at: number): number => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
const le16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)

const png = (b: Uint8Array): Sniffed | null =>
  b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR') ? { type: 'image/png', w: be32(b, 16), h: be32(b, 20) } : null

const gif = (b: Uint8Array): Sniffed | null =>
  b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) ? { type: 'image/gif', w: le16(b, 6), h: le16(b, 8) } : null

const webp = (b: Uint8Array): Sniffed | null => {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  if (ascii(b, 12, 'VP8X')) return { type: 'image/webp', w: le24(b, 24) + 1, h: le24(b, 27) + 1 }
  if (ascii(b, 12, 'VP8 ')) return { type: 'image/webp', w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff }
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! * 0x1000000)
    return { type: 'image/webp', w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

/** JPEG: walk the segments to the first start-of-frame, which holds the size. */
const jpeg = (b: Uint8Array): Sniffed | null => {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    if (marker === 0xff) { at += 1; continue }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) return { type: 'image/jpeg', w: be16(b, at + 7), h: be16(b, at + 5) }
    if (marker === 0xd9 || marker === 0xda) return null
    at += 2 + be16(b, at + 2)
  }
  return null
}

export const sniffImage = (b: Uint8Array): Sniffed | null => {
  const found = png(b) ?? jpeg(b) ?? gif(b) ?? webp(b)
  return found && found.w >= 1 && found.h >= 1 ? found : null
}

export const fromBase64 = (text: string): Uint8Array | null => {
  try {
    const raw = atob(text)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export const toBase64 = (bytes: Uint8Array): string => {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(raw)
}
