#!/bin/bash
# Everything that can run without a package install.
set -u

cd "$(dirname "$0")" || exit 1
status=0

echo "### DOM tests (headless Chrome)"
./run-dom-tests.sh || status=1

echo
echo "### chapter outline and navigation tree"
node outline.js || status=1

# Both shapes, because the package metadata differs between them: a one-chapter
# book states the article's own date and description, a compilation cannot.
for build in "fixture.epub" "single.epub --single"; do
    set -- $build
    echo
    echo "### building out/$1 with the extension's own saveEbook.js"
    node build-epub.js "out/$1" ${2:-} || status=1

    echo
    echo "### epub structure: $1"
    node check-epub.js "out/$1" || status=1

    echo
    echo "### EPUBCheck: $1"
    ./run-epubcheck.sh "out/$1" || status=1
done

echo
[ "$status" -eq 0 ] && echo "ALL PASSED" || echo "FAILURES - see above"
exit $status
