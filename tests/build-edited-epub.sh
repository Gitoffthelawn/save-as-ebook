#!/bin/bash
# Builds a book out of chapters that were edited in the chapter editor, so that
# EPUBCheck sees content an edit produced.
#
# The editing happens in a real DOM - contentEditable, element removal and the
# serialization back out of it are all browser behaviour, and a shim would be
# testing the shim - so the chapters come from the headless run of
# dom/chapter-editing.html, which writes them into the page as JSON. This script
# lifts them back out of the dumped dom and hands them to the same builder the
# extension ships.
#
# The whole risk of the editing feature is emitting XHTML a reading system
# cannot parse. This is the step that would notice.
set -u

cd "$(dirname "$0")" || exit 1

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
    CHROME="$(command -v google-chrome || command -v chromium || true)"
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
    echo "SKIP: no Chrome found. Set CHROME=/path/to/chrome" >&2
    exit 0
fi

mkdir -p out

dom=$("$CHROME" --headless --disable-gpu --no-sandbox \
    --allow-file-access-from-files --virtual-time-budget=8000 \
    --dump-dom "file://$PWD/dom/chapter-editing.html" 2>/dev/null)

# One line, written by exportSavedChapters(). The dump is html, so the three
# characters the serializer escapes have to be put back before it is json again.
json=$(echo "$dom" \
    | grep -o '<pre id="edited-chapters">.*</pre>' \
    | sed -e 's/^<pre id="edited-chapters">//' -e 's|</pre>$||' \
          -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')

if [ -z "$json" ]; then
    echo "FAILED: the editing fixture produced no saved chapters"
    exit 1
fi

printf '%s' "$json" > out/edited-chapters.json

node build-epub.js out/edited.epub --chapters out/edited-chapters.json || exit 1
./run-epubcheck.sh out/edited.epub
