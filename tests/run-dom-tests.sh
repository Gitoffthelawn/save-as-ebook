#!/bin/bash
# Runs the DOM fixtures in headless Chrome and fails if any assertion failed.
#
# These need a real browser rather than a DOM shim: the extraction depends on
# getComputedStyle, layout (offsetWidth / getBoundingClientRect), canvas
# toDataURL and the HTML5 parser behind <template>, and a shim that fakes those
# would be testing the shim.
set -u

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
    CHROME="$(command -v google-chrome || command -v chromium || true)"
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
    echo "SKIP: no Chrome found. Set CHROME=/path/to/chrome" >&2
    exit 0
fi

cd "$(dirname "$0")/dom" || exit 1

failed=0
for fixture in *.html; do
    echo "== $fixture"
    dom=$("$CHROME" --headless --disable-gpu --no-sandbox \
        --allow-file-access-from-files --virtual-time-budget=8000 \
        --dump-dom "file://$PWD/$fixture" 2>/dev/null)
    output=$(echo "$dom" | grep -o '<li>[^<]*</li>' | sed 's/<[^>]*>//g')

    if [ -z "$output" ]; then
        echo "  FAIL: fixture produced no results (did a script throw before reporting?)"
        failed=1
        continue
    fi

    # Every fixture sets its title last. Without this a fixture that throws
    # halfway through still passes on the assertions it managed to report, and
    # the ones it never reached are indistinguishable from ones that do not
    # exist - which is also what happens to an assertion whose detail carries a
    # newline, since the grep above is line-based.
    if ! echo "$dom" | grep -q '<title>DONE</title>'; then
        echo "  FAIL: fixture did not run to completion (no DONE title)"
        failed=1
    fi

    echo "$output" | sed 's/^/  /'
    if echo "$output" | grep -q '^FAIL'; then
        failed=1
    fi
done

if [ "$failed" -ne 0 ]; then
    echo "DOM tests FAILED"
    exit 1
fi
echo "DOM tests passed"
