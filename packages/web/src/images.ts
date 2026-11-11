// Getting a picture ready to upload: small enough for the server, with a PNG preview
// small enough for a terminal to draw. Everything here happens in the browser.

const FULL_BYTES = 3_500_000 // under the server's 4 MB cap
const FULL_SIDE = 2400
const THUMB_BYTES = 550_000
const KEPT_AS_IS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export type Prepared = { data: string; thumb: string | null; url: string }

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let raw = ''
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(raw)
}

const drawn = (bitmap: ImageBitmap, side: number, type: string, quality?: number): Promise<Blob | null> => {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

const firstThatFits = async (sizes: number[], limit: number, make: (side: number) => Promise<Blob | null>): Promise<Blob | null> => {
  for (const side of sizes) {
    const blob = await make(side)
    if (blob && blob.size <= limit) return blob
  }
  return null
}

/** Throws 'not_an_image' for something a browser cannot decode, 'too_large' for what cannot be made to fit. */
export const prepare = async (file: Blob): Promise<Prepared> => {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error('not_an_image')
  const asIs = KEPT_AS_IS.includes(file.type) && file.size <= FULL_BYTES && Math.max(bitmap.width, bitmap.height) <= 8000
  const full = asIs ? file : await firstThatFits([FULL_SIDE, 1600, 1200], FULL_BYTES, (side) => drawn(bitmap, side, 'image/jpeg', 0.86))
  if (!full) throw new Error('too_large')
  const thumb = await firstThatFits([640, 420, 280], THUMB_BYTES, (side) => drawn(bitmap, side, 'image/png'))
  bitmap.close()
  return { data: await toBase64(full), thumb: thumb ? await toBase64(thumb) : null, url: URL.createObjectURL(full) }
}
