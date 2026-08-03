#!/bin/bash
# Everything that can run without a package install.
set -u

cd "$(dirname "$0")" || exit 1
status=0

echo "### DOM tests (headless Chrome)"
./run-dom-tests.sh || status=1

echo
echo "### building a fixture epub with the extension's own saveEbook.js"
node build-epub.js out/fixture.epub || status=1

echo
echo "### epub structure"
node check-epub.js out/fixture.epub || status=1

echo
echo "### EPUBCheck"
./run-epubcheck.sh out/fixture.epub || status=1

echo
[ "$status" -eq 0 ] && echo "ALL PASSED" || echo "FAILURES - see above"
exit $status
