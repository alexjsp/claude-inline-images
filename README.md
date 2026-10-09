# inline-images

A [Claude Code](https://claude.com/claude-code) mod that draws images right in the terminal transcript, the way the desktop and mobile apps show them, using the kitty graphics protocol.

It draws:

- **Images Claude reads**: a `Read` of a PNG, JPEG, GIF or WebP shows the picture under the call.
- **Images Claude sends**: `SendUserFile` attachments, and image blocks returned by MCP tools (screenshots and the like).
- **Images you paste**: each `[Image #N]` in your prompt is drawn under it.
- **Markdown images in replies**: `![alt](/absolute/path.png)` or `~/path.png` in Claude's answer becomes the picture. Images inside code blocks are left as code.

Each picture has a small caption above it:

```
▾ [Image #3] 1206×1800   ↗ open
```

- Click the caption to hide the picture, and again to show it.
- Click `↗ open` to open the image in your default app.

## Requirements

- **Claude Code 2.1.294 or later**, the first version with mods (function hooks).
- **A terminal that draws kitty graphics**, such as [Ghostty](https://ghostty.org) or [kitty](https://sw.kovidgoyal.net/kitty/). Elsewhere Claude Code draws a dim `[image W×H]` placeholder instead.
- **macOS** uses the built-in `sips`, `base64`, `open` and `perl`.
- **Linux is untested for now.** The mod needs ImageMagick (`magick` or `convert`) to convert images, `xdg-open` to open them, and `perl` to read the terminal's cell size. If you try it, please open an issue saying how it went.

## Install

At a Claude Code prompt:

```
/plugin install inline-images --marketplace alexjsp/claude-inline-images
```

Answer `y` to add the marketplace, then press Enter to install it for your user. It is active right away, and in every session after.

### Inside tmux, herdr or another multiplexer

Claude Code only turns on terminal images when it can tell that the terminal supports them. A multiplexer hides that, so set this in your shell profile (for example `~/.zshenv`):

```sh
export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
```

The multiplexer also has to pass kitty graphics through to the outer terminal. In tmux that means `set -g allow-passthrough on`.

## How it works

The mod hooks Claude Code's `ui.render` events for tool calls, tool results, your prompts and Claude's replies. Where one carries an image, it draws Claude Code's `Image` element in place of the usual row.

- **Conversion:** images that aren't PNG, or are too large to send inline, are converted to PNG with `sips` (macOS) or ImageMagick (Linux).
- **Cache:** converted files go in a private cache folder, `$TMPDIR/claude-inline-images-<uid>` (mode 0700). Your OS clears it along with the rest of the temp folder.
- **Sizing:** each picture is sized from its pixel dimensions and the terminal's real cell size, up to 80 columns by 30 rows.

## Limitations

- **The picture itself can't be clicked.** The mod API gives images no click handling, so the caption holds the controls.
- **Claude Code still draws its own `⎿ [Image #N]` line** under a pasted image. Mods can't hide it.
- **Hidden pictures come back** when the mod reloads or the session restarts.
- **Pictures are drawn in full only in the terminal.** The desktop, web and mobile apps already show images, so the mod leaves them alone.

## Development

Run Claude Code with the mod loaded from your clone. Saving a file reloads it:

```sh
claude --plugin-dir /path/to/claude-inline-images
```

Once Claude Code has loaded the mod, it writes the API types into `.claude-plugin/types/`, which is ignored by git. Then:

```sh
claude plugin validate .
tsc -p . --noEmit
```

## License

[MIT](LICENSE)
