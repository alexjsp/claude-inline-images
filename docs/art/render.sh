#!/bin/sh
# Renders template.html with headless Chrome into the two images in docs/:
# social-preview.png (1280x640, for GitHub's Settings → Social preview) and
# header.png (the README header, drawn at 2x for sharp screens).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}

render() { # <out> <scale> <url fragment>
  "$chrome" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor="$2" --window-size=1280,640 \
    --screenshot="$1" "file://$here/template.html$3" 2>/dev/null
}

render "$here/../social-preview.png" 1 ""
render "$here/../header.png" 2 "#header"
