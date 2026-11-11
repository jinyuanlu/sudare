// A picture pasted into a terminal's text field arrives as the path of a file: the
// terminal, or Claude Code, saved the clipboard to a temporary file and typed its name.
// Find such paths in what the person wrote, so the picture is sent and not its name.

const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`
// 'quoted', "quoted", or bare with backslash-escaped spaces; absolute, or under ~/.
const PATH = new RegExp(String.raw`(?<=^|\s)'((?:\/|~\/)[^'\n]+${EXT})'(?=\s|$)|(?<=^|\s)"((?:\/|~\/)[^"\n]+${EXT})"(?=\s|$)|(?<=^|\s)((?:\/|~\/)(?:\\.|[^\s'"\\])+${EXT})(?=\s|$)`, 'gi')

export type Found = { paths: string[]; rest: string }

/** The picture files named in `text`, in order, and the text without them. At most `max`; the rest stay as text. */
export const picturePaths = (text: string, max = 4): Found => {
  const paths: string[] = []
  const rest = text.replace(PATH, (hit, single?: string, double?: string, bare?: string) => {
    if (paths.length >= max) return hit
    paths.push(single ?? double ?? (bare ?? '').replace(/\\(.)/g, '$1'))
    return ' '
  })
  return { paths, rest: paths.length > 0 ? rest.replace(/[ \t]{2,}/g, ' ').trim() : text }
}
