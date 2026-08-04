#!/bin/bash
# Validates a generated .epub with EPUBCheck - the actual acceptance criterion
# for this extension, since "the file opens in a reader" is what users care about
# and EPUBCheck is what the stores and readers agree on.
#
# EPUBCheck is not vendored (it is a ~10MB JVM tool). Provide it with either:
#   brew install epubcheck            # puts `epubcheck` on PATH
#   EPUBCHECK_JAR=/path/epubcheck.jar # https://github.com/w3c/epubcheck/releases
set -u

cd "$(dirname "$0")" || exit 1

EPUB="${1:-out/fixture.epub}"

if [ ! -f "$EPUB" ]; then
    echo "building $EPUB first"
    node build-epub.js "$EPUB" || exit 1
fi

if command -v epubcheck >/dev/null 2>&1; then
    epubcheck "$EPUB"
    exit $?
fi

if [ -n "${EPUBCHECK_JAR:-}" ] && [ -f "$EPUBCHECK_JAR" ]; then
    if ! command -v java >/dev/null 2>&1; then
        echo "SKIP: EPUBCHECK_JAR is set but there is no java on PATH" >&2
        exit 0
    fi
    java -jar "$EPUBCHECK_JAR" "$EPUB"
    exit $?
fi

echo "SKIP: EPUBCheck not found."
echo "      brew install epubcheck   (or set EPUBCHECK_JAR=/path/to/epubcheck.jar)"
echo "      Structural checks that do not need it: node check-epub.js $EPUB"
exit 0
