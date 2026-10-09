import type { ImageSource, Register } from 'claude-code'

const MAX_COLUMNS = 80
const MAX_ROWS = 30
// Rough image pixels per terminal column, used only to pick how wide to draw.
const CELL_WIDTH = 9
// A cell's height over its width, until the terminal says (cellAspectFor).
const DEFAULT_CELL_ASPECT = 2
const MAX_PNG_BYTES = 2 * 1024 * 1024

const PASTE_TOKEN = /\[Image #(\d+)\]/g
// ![alt](/abs/or/~/path.png) in a reply.
const MD_IMAGE = /!\[([^\]]*)\]\(((?:~|\/)[^)\s]+?\.(?:png|jpe?g|gif|webp))\)/gi
// Fenced code blocks (a still-open one runs to the end) and inline code spans.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

// `origin` is the file the picture came from, opened in place of a cached copy.
type Picture = { source: ImageSource; width: number; height: number; origin?: string }

// Where a picture comes from, before it is sized and converted.
type Spec =
  | { kind: 'b64'; data: string; mime: string; width?: number; height?: number; origin?: string }
  | { kind: 'path'; path: string }

// The picture is stretched to fill its box, so the box keeps the picture's
// shape in the terminal's real cells.
let cellAspect = DEFAULT_CELL_ASPECT

const boxFor = (width: number, height: number) => {
  let columns = Math.min(MAX_COLUMNS, Math.max(8, Math.round(width / CELL_WIDTH)))
  let rows = Math.round((columns * height) / width / cellAspect)

  if (rows > MAX_ROWS) {
    columns = Math.max(8, Math.round((MAX_ROWS * cellAspect * width) / height))
    rows = MAX_ROWS
  }

  return { columns: Math.min(columns, MAX_COLUMNS), rows: Math.max(1, rows) }
}

// The cell's shape from the terminal's own size report (TIOCGWINSZ: rows,
// columns, then pixels across and down), asked of the tty of the nearest
// process up the tree that has one. Perl makes the ioctl; where any of it is
// missing (no perl, a terminal that reports no pixels) the guess stands.
const MEASURE_CELL = `
p=$$
while [ "$p" -gt 1 ]; do
  t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
  case "$t" in ''|'?'|'??') p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); [ -n "$p" ] || exit 1 ;; *) break ;; esac
done
[ "$p" -gt 1 ] || exit 1
case "$(uname)" in Darwin) req=0x40087468 ;; *) req=0x5413 ;; esac
exec perl -e 'open(my $t, "<", $ARGV[0]) or exit 1; my $b = "\\0" x 8;
  ioctl($t, hex($ARGV[1]), $b) or exit 1; print join(" ", unpack("S4", $b))' "/dev/$t" "$req"
`

let measuring: Promise<void> | null = null

// Measured once a load and again at each turn (a font size may change), with
// a redraw when the shape moved.
const measureCell = ($: any): Promise<void> =>
  (measuring ??= $.process
    .run(['sh', '-c', MEASURE_CELL])
    .then((r: any) => {
      const [rows, columns, xpix, ypix] = String(r.stdout).trim().split(' ').map(Number)
      const aspect = rows && columns && xpix && ypix ? ypix / rows / (xpix / columns) : NaN

      if (r.exitCode === 0 && aspect > 1 && aspect < 4 && Math.abs(aspect - cellAspect) > 0.01) {
        cellAspect = aspect
        $.ui.invalidate('ui.render')
      }
    })
    .catch(() => {})
    .finally(() => {
      measuring = null
    }))

// Whether this load has measured yet: the first picture asks.
let measured = false

// A PNG's size from its IHDR chunk: bytes 16-23 of the file.
const pngSize = (b64: string) => {
  try {
    const head = atob(b64.slice(0, 44))
    const u32 = (o: number) =>
      ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0
    return head.slice(1, 4) === 'PNG' ? { width: u32(16), height: u32(20) } : null
  } catch {
    return null
  }
}

// FNV-1a, so two keys that read alike once made file-safe keep apart.
const hash = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const safeKey = (s: string) => `${s.replace(/[^A-Za-z0-9._-]/g, '_').slice(-100)}-${hash(s)}`

// The cache holds what was pasted and read, so it is the person's own: a
// folder under their TMPDIR, made 0700, refused if it is a link or not theirs.
let cacheDir: Promise<string | null> | null = null

const cacheDirFor = ($: any): Promise<string | null> =>
  (cacheDir ??= $.process
    .run([
      'sh',
      '-c',
      'd="${TMPDIR:-/tmp}"; d="${d%/}/claude-inline-images-$(id -u)"; ' +
        'mkdir -p -m 700 "$d" && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d" && printf %s "$d"',
    ])
    .then((r: any) => (r.exitCode === 0 && r.stdout ? r.stdout : null))
    .catch(() => ((cacheDir = null), null)))

// Writes "$1" as a PNG from the image at "$2", or from base64 on stdin when
// "$2" is empty, then prints the PNG's first 24 bytes in base64 for pngSize.
// sips on macOS; ImageMagick (magick, else convert) elsewhere, first frame only.
const TO_PNG = `
out=$1 in=$2
case "$(uname)" in Darwin) decode='base64 -D' ;; *) decode='base64 -d' ;; esac
if [ -z "$in" ]; then
  in="$out.in"
  trap 'rm -f "$in"' EXIT
  $decode > "$in" || exit 1
fi
if command -v sips >/dev/null 2>&1; then
  sips -s format png "$in" --out "$out" >/dev/null 2>&1
elif command -v magick >/dev/null 2>&1; then
  magick "$in[0]" "png:$out"
elif command -v convert >/dev/null 2>&1; then
  convert "$in[0]" "png:$out"
else
  exit 3
fi || exit 1
head -c 24 "$out" | base64 | tr -d '\\n'
`

const toPng = async ($: any, key: string, args: { stdin?: string; path?: string }) => {
  const dir = await cacheDirFor($)
  if (!dir) {
    return null
  }

  const out = `${dir}/${key}.png`
  const conv = await $.process.run(['sh', '-c', TO_PNG, 'sh', out, args.path ?? ''], { stdin: args.stdin })
  const size = conv.exitCode === 0 ? pngSize(conv.stdout.trim()) : null

  return size?.width && size.height ? { source: { file: out, format: 'png' as const }, ...size } : null
}

const toPicture = ($: any, key: string, spec: Spec): Promise<Picture | null> => {
  if (spec.kind === 'path') {
    return toPng($, key, { path: spec.path }).then(p => p && { ...p, origin: spec.path })
  }

  const size =
    spec.width && spec.height ? { width: spec.width, height: spec.height } : spec.mime === 'image/png' ? pngSize(spec.data) : null

  if (spec.mime === 'image/png' && size && spec.data.length * 0.75 <= MAX_PNG_BYTES) {
    return Promise.resolve({ source: { png: spec.data }, ...size, origin: spec.origin })
  }

  return toPng($, key, { stdin: spec.data }).then(p => p && { ...p, origin: spec.origin })
}

// Pictures hidden by a press on their caption, by key: kept for this load only.
const hidden = new Set<string>()

const toggle = ($: any, key: string) => {
  hidden.has(key) ? hidden.delete(key) : hidden.add(key)
  $.ui.invalidate('ui.render')
}

// Opens "$1" in the default app, first writing it from base64 on stdin when
// "$2" says so: open on macOS, xdg-open (left running) elsewhere.
const OPEN = `
case "$(uname)" in Darwin) decode='base64 -D' ;; *) decode='base64 -d' ;; esac
if [ "$2" = write ]; then $decode > "$1" || exit 1; fi
if [ "$(uname)" = Darwin ]; then
  open "$1"
else
  nohup xdg-open "$1" >/dev/null 2>&1 &
fi
`

// Open in the default app: the file it came from, else the converted copy,
// else the PNG bytes written out to the cache first.
const openPicture = async ($: any, key: string, p: Picture) => {
  const file = p.origin ?? ('file' in p.source ? p.source.file : undefined)

  if (file) {
    await $.process.run(['sh', '-c', OPEN, 'sh', file, ''])
    return
  }

  const dir = await cacheDirFor($)

  if ('png' in p.source && dir) {
    const out = `${dir}/${safeKey(`open-${key}`)}.png`
    await $.process.run(['sh', '-c', OPEN, 'sh', out, 'write'], { stdin: p.source.png })
  }
}

// Converted pictures by key, so a redraw never converts twice.
const cache = new Map<string, Promise<Picture | null>>()
// Keys whose conversion was cut off (a redraw or an interrupt aborts the hook
// that started it), retried on the next draw and nudged at the next turn.
const failed = new Set<string>()

// A conversion that throws leaves the cache, so it is never stuck as a failure.
const convert = ($: any, key: string, spec: Spec): Promise<Picture | null> => {
  const attempt = toPicture($, safeKey(key), spec).then(
    p => (failed.delete(key), p),
    () => {
      if (cache.get(key) === attempt) {
        cache.delete(key)
      }
      failed.add(key)
      return null
    },
  )
  cache.set(key, attempt)
  return attempt
}

const picturesFor = async ($: any, keyed: { key: string; spec: Spec }[]): Promise<Picture[]> => {
  if (!measured) {
    measured = true
    void measureCell($)
  }

  const pending = keyed.map(async ({ key, spec }) => {
    const picture = await (cache.get(key) ?? convert($, key, spec))
    // Started by a draw since superseded: try again under this one, joining a
    // retry another draw may have started meanwhile.
    return picture ?? (failed.has(key) ? (cache.get(key) ?? convert($, key, spec)) : null)
  })

  return (await Promise.all(pending)).filter((p): p is Picture => p !== null)
}

// Image content blocks anywhere in a tool's output: the API's
// { type: 'image', source: { data, media_type } } or MCP's { type: 'image', data, mimeType }.
const findBlocks = (value: any, depth: number, found: Spec[]) => {
  if (depth > 5 || value === null || typeof value !== 'object') {
    return found
  }

  if (Array.isArray(value)) {
    value.forEach(v => findBlocks(v, depth + 1, found))
    return found
  }

  if (value.type === 'image') {
    const data = value.source?.data ?? value.data
    const mime = value.source?.media_type ?? value.mimeType ?? value.media_type

    if (typeof data === 'string' && typeof mime === 'string') {
      found.push({ kind: 'b64', data, mime })
      return found
    }
  }

  Object.values(value).forEach(v => findBlocks(v, depth + 1, found))
  return found
}

const imagesIn = (tool: string, output: any, input?: any): Spec[] => {
  if (output == null) {
    return []
  }

  if (tool === 'Read') {
    if (output.type !== 'image') {
      return []
    }
    const d = output.file.dimensions
    return [
      {
        kind: 'b64',
        data: output.file.base64,
        mime: output.file.type,
        width: d?.displayWidth ?? d?.originalWidth,
        height: d?.displayHeight ?? d?.originalHeight,
        origin: input?.file_path,
      },
    ]
  }

  if (tool === 'SendUserFile' || tool === 'SendUserMessage') {
    return (output.attachments ?? []).filter((a: any) => a.isImage).map((a: any) => ({ kind: 'path', path: a.path }))
  }

  return findBlocks(output, 0, [])
}

const keyedFor = (id: string, specs: Spec[]) => specs.map((spec, i) => ({ key: `${id}-${i}`, spec }))

// Each picture under a caption (its label, if given, then its size): press it to
// hide or show the picture, "open" to open it in the default app.
const imagesTree = ($: any, e: any, id: string, pictures: Picture[], labels: string[] = []) => {
  const { Box, Button, Image } = $.ui.resolve(e)

  return (
    <Box flexDirection="column">
      {pictures.map((p, i) => {
        const key = `${id}-${i}`
        const isHidden = hidden.has(key)
        const { columns, rows } = boxFor(p.width, p.height)
        return (
          <Box key={`box-${key}`} flexDirection="column">
            <Box flexDirection="row" gap={2}>
              <Button key={`toggle-${key}`} plain dimColor onPress={() => toggle($, key)}>
                {`${isHidden ? '▸' : '▾'} ${labels[i] ?? 'image'} ${p.width}×${p.height}${isHidden ? ' (hidden)' : ''}`}
              </Button>
              <Button key={`open-${key}`} plain dimColor onPress={() => void openPicture($, key, p)}>
                ↗ open
              </Button>
            </Box>
            {isHidden ? null : (
              <Image key={key} source={p.source} columns={columns} rows={rows} alt={`[image ${p.width}×${p.height}]`} />
            )}
          </Box>
        )
      })}
    </Box>
  )
}

const labelFor = (tool: string, input: any, output: any) => {
  if (tool === 'Read') {
    return input?.file_path ?? ''
  }
  if (tool === 'SendUserFile' || tool === 'SendUserMessage') {
    return (output?.attachments ?? []).map((a: any) => a.path).join(', ')
  }
  const json = JSON.stringify(input ?? {})
  return json.length > 100 ? `${json.slice(0, 99)}…` : json
}

// Pasted images by `${session}-${n}` for [Image #N], read off the stored
// messages: numbering starts over in a new session (/clear, /resume).
const pastes = new Map<string, Spec>()
// Those already looked for, so one gone from the messages (compacted away) is
// not looked for again on every redraw.
const sought = new Set<string>()

// A prompt draws before it is stored, so its pastes are missed the first time:
// once a turn is under way, look again for any still missing and redraw, which
// also retries conversions a redraw or an interrupt cut off.
const retryPastes = ($: any) => {
  const missing = [...sought].filter(id => !pastes.has(id))

  if (missing.length > 0 || failed.size > 0) {
    missing.forEach(id => sought.delete(id))
    $.ui.invalidate('ui.render')
  }
}

// A prompt carries an image block for each image pasted into it, in order; a
// number seen in an earlier prompt is only a mention of that one. A prompt
// whose new numbers and blocks do not pair up is left alone.
const loadPastes = async ($: any, session: string) => {
  const messages: any[] = await $.session.messages({ as: 'api' })
  const seen = new Set<number>()

  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) {
      continue
    }
    const text = m.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
    const fresh = [...new Set([...text.matchAll(PASTE_TOKEN)].map(match => Number(match[1])))].filter(n => !seen.has(n))
    const blocks = m.content.filter((b: any) => b.type === 'image' && b.source?.type === 'base64')

    fresh.forEach(n => seen.add(n))
    if (fresh.length === 0 || fresh.length !== blocks.length) {
      continue
    }
    fresh.forEach((n, i) => {
      const id = `${session}-${n}`
      if (!pastes.has(id)) {
        pastes.set(id, { kind: 'b64', data: blocks[i].source.data, mime: blocks[i].source.media_type })
      }
    })
  }
}

let home: Promise<string> | null = null

const expandHome = async ($: any, path: string) => {
  if (!path.startsWith('~')) {
    return path
  }
  home ??= $.process.run(['printenv', 'HOME']).then((r: any) => r.stdout.trim())
  return (await home) + path.slice(1)
}

export const register: Register = on => {
  // A folded "Read N files" line has no result rows: unfold a group holding an
  // image so each call draws as its own ToolUse row.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const hasImage = e.props.calls.some(c => !c.isRunning && !c.isErrored && imagesIn(c.tool, c.output).length > 0)

    return hasImage && !e.props.isExpanded && e.surface === 'terminal'
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isRunning, isErrored, tool_use_id } = e.props as any
    const specs = e.surface === 'terminal' && !isRunning && !isErrored ? imagesIn(tool, output, input) : []

    if (specs.length === 0) {
      return next(e)
    }

    const id = tool_use_id ?? e.requestId
    const pictures = await picturesFor($, keyedFor(id, specs))

    if (pictures.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="success">⏺ </Text>
          <Text bold>{tool}</Text>({labelFor(tool, input, output)})
        </Text>
        <Box paddingLeft={2}>{imagesTree($, e, id, pictures)}</Box>
      </Box>
    )
  })

  // A standalone row's result block (SendUserFile, an MCP screenshot, an unfolded Read).
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, input, output, isErrored, tool_use_id } = e.props as any
    const specs = e.surface === 'terminal' && !isErrored ? imagesIn(tool, output, input) : []

    if (specs.length === 0) {
      return next(e)
    }

    const pictures = await picturesFor($, keyedFor(tool_use_id, specs))

    return pictures.length === 0 ? next(e) : imagesTree($, e, tool_use_id, pictures)
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    retryPastes($)
    if (measured) {
      await measureCell($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    retryPastes($)
    return result
  })

  // The person's prompt: each [Image #N] it names, drawn under the prompt's text.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const numbers = [...new Set([...e.props.text.matchAll(PASTE_TOKEN)].map(match => Number(match[1])))]
    // The person's own prompts only, typed here or sent from the app: not a
    // notification's or another agent's row, which the engine draws its own way.
    // A prompt stored before origins were stamped reads `unclassified`.
    const kind = e.props.origin?.kind
    const isPrompt = kind === 'composer' || kind === 'bridge' || (kind === 'unclassified' && !e.props.from)

    if (e.surface !== 'terminal' || !isPrompt || numbers.length === 0) {
      return next(e)
    }

    const session = await $.session.id()
    const ids = numbers.map(n => `${session}-${n}`)

    if (ids.some(id => !pastes.has(id) && !sought.has(id))) {
      ids.forEach(id => sought.add(id))
      await loadPastes($, session)
    }

    const drawn = (
      await Promise.all(
        numbers
          .filter(n => pastes.has(`${session}-${n}`))
          .map(async n => {
            const [picture] = await picturesFor($, [{ key: `paste-${session}-${n}`, spec: pastes.get(`${session}-${n}`)! }])
            return picture ? { n, picture } : null
          }),
      )
    ).filter(d => d !== null)

    if (drawn.length === 0) {
      return next(e)
    }

    // A drawn paste's [Image #N] moves from the prompt's text to its caption.
    const shown = new Set(drawn.map(d => d.n))
    const text = e.props.text
      .replace(PASTE_TOKEN, (token, n) => (shown.has(Number(n)) ? '' : token))
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>❯ </Text>
          {text}
        </Text>
        <Box paddingLeft={2}>
          {imagesTree(
            $,
            e,
            `paste-${e.requestId}`,
            drawn.map(d => d.picture),
            drawn.map(d => `[Image #${d.n}]`),
          )}
        </Box>
      </Box>
    )
  })

  // A reply's ![alt](/path.png): the markdown around it, the picture in its place.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { text, isFirstOfReply } = e.props
    // An image written inside a code block or span is code, drawn as written.
    const code = [...text.matchAll(CODE)].map(m => [m.index!, m.index! + m[0].length] as const)
    const matches = [...text.matchAll(MD_IMAGE)].filter(m => !code.some(([from, to]) => m.index! >= from && m.index! < to))

    if (e.surface !== 'terminal' || matches.length === 0) {
      return next(e)
    }

    // Keyed by the reply, not the path alone: each reply keeps the picture the
    // file held when it was first drawn, though the file is written again.
    const paths = await Promise.all(matches.map(m => expandHome($, m[2]!)))
    const pictures = await Promise.all(
      paths.map(
        async (path, i) =>
          (await picturesFor($, [{ key: `md-${e.requestId}-${i}-${path}`, spec: { kind: 'path', path } }]))[0] ?? null,
      ),
    )

    if (pictures.every(p => p === null)) {
      return next(e)
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const parts: any[] = []
    let at = 0

    matches.forEach((m, i) => {
      const before = text.slice(at, m.index).trim()
      if (before) {
        parts.push(<Markdown key={`t${i}`} text={before} />)
      }
      const p = pictures[i]
      parts.push(
        p ? (
          imagesTree($, e, `md-${e.requestId}-${i}`, [p])
        ) : (
          <Text key={`m${i}`} dimColor>
            [missing image {m[2]}]
          </Text>
        ),
      )
      at = m.index! + m[0].length
    })

    const rest = text.slice(at).trim()
    if (rest) {
      parts.push(<Markdown key="rest" text={rest} />)
    }

    return (
      <Box flexDirection="row">
        <Text>{isFirstOfReply ? '⏺ ' : '  '}</Text>
        <Box flexDirection="column" flexShrink={1}>
          {parts}
        </Box>
      </Box>
    )
  })
}
