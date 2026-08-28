#!/bin/bash
# Validates a generated .epub with EPUBCheck - the actual acceptance criterion
# for this extension, since "the file opens in a reader" is what users care about
# and EPUBCheck is what the stores and readers agree on.
#
#   ./run-epubcheck.sh [book.epub] [--strict]
#
# --strict also fails on warnings. EPUBCheck exits 0 for a book that only warns,
# and most warnings are advisory - but some store ingestion pipelines gate on a
# clean run, so the books whose shape should produce nothing at all are checked
# for nothing at all.
#
# EPUBCheck is not vendored (it is a ~10MB JVM tool). Provide it with either:
#   brew install epubcheck            # puts `epubcheck` on PATH
#   EPUBCHECK_JAR=/path/epubcheck.jar # https://github.com/w3c/epubcheck/releases
set -u

cd "$(dirname "$0")" || exit 1

EPUB="${1:-out/fixture.epub}"
STRICT=""
[ "${2:-}" = "--strict" ] && STRICT=1

if [ ! -f "$EPUB" ]; then
    echo "building $EPUB first"
    node build-epub.js "$EPUB" || exit 1
fi

if command -v epubcheck >/dev/null 2>&1; then
    set -- epubcheck "$EPUB"
elif [ -n "${EPUBCHECK_JAR:-}" ] && [ -f "$EPUBCHECK_JAR" ]; then
    if ! command -v java >/dev/null 2>&1; then
        echo "SKIP: EPUBCHECK_JAR is set but there is no java on PATH" >&2
        exit 0
    fi
    set -- java -jar "$EPUBCHECK_JAR" "$EPUB"
else
    echo "SKIP: EPUBCheck not found."
    echo "      brew install epubcheck   (or set EPUBCHECK_JAR=/path/to/epubcheck.jar)"
    echo "      Structural checks that do not need it: node check-epub.js $EPUB"
    exit 0
fi

# EPUBCheck reports on stderr; keep both streams so the output reads the same as
# running it by hand, and so --strict can see the warnings.
output=$("$@" 2>&1)
code=$?
printf '%s\n' "$output"

if [ -n "$STRICT" ] && [ "$code" -eq 0 ] && printf '%s' "$output" | grep -q 'WARNING('; then
    echo "FAILED: $EPUB is valid but not warning-free, and this book is held to warning-free"
    exit 1
fi

exit $code
