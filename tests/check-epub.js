// Structural checks on a generated .epub that do not need a JVM.
//
//   node check-epub.js out/fixture.epub
//
// EPUBCheck stays the acceptance criterion - see run-epubcheck.sh. This covers
// the failures this extension actually produces, which are referential rather
// than schema-level: an <img> pointing at a file that was never downloaded, a
// manifest entry with no file behind it, two entries sharing an id.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, 'out', 'fixture.epub');

const sandbox = {console, setTimeout, clearTimeout, setInterval, clearInterval,
                 setImmediate, Promise, Blob, Uint8Array, ArrayBuffer, Date, Math, JSON};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web-extension', 'libs', 'jszip.js'), 'utf8'),
                sandbox, {filename: 'jszip.js'});
const JSZip = sandbox.JSZip;

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''));
    if (!ok) failures++;
}

const raw = fs.readFileSync(file);

// OCF: the mimetype entry must come first and be stored, so a reader can find
// the magic bytes at a fixed offset without inflating anything
check('mimetype is the first entry and uncompressed',
      raw.slice(30, 38).toString('latin1') === 'mimetype' &&
      raw.slice(38, 58).toString('latin1') === 'application/epub+zip',
      'bytes at offset 30: ' + JSON.stringify(raw.slice(30, 58).toString('latin1')));

JSZip.loadAsync(raw).then(async (zip) => {
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

    check('container.xml present', names.indexOf('META-INF/container.xml') > -1);

    const container = await zip.file('META-INF/container.xml').async('string');
    const rootPath = (container.match(/full-path="([^"]+)"/) || [])[1];
    check('container.xml names a package document', !!rootPath, 'full-path=' + rootPath);
    check('the package document exists', !!rootPath && names.indexOf(rootPath) > -1);

    const opf = await zip.file(rootPath).async('string');
    const opfDir = path.posix.dirname(rootPath);

    // every manifest item must have a file behind it, and a unique id
    const items = [...opf.matchAll(/<item\s+([^>]*)\/>/g)].map((m) => ({
        id: (m[1].match(/id="([^"]+)"/) || [])[1],
        href: (m[1].match(/href="([^"]+)"/) || [])[1]
    }));
    check('manifest is not empty', items.length > 0, items.length + ' items');

    const missing = items.filter((i) => names.indexOf(path.posix.join(opfDir, i.href)) < 0);
    check('every manifest href exists in the archive', missing.length === 0,
          missing.map((i) => i.href).join(', '));

    const ids = items.map((i) => i.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    check('manifest ids are unique', dupes.length === 0, dupes.join(', '));

    // every spine itemref must name a manifest item
    const idrefs = [...opf.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => m[1]);
    const danglingRefs = idrefs.filter((r) => ids.indexOf(r) < 0);
    check('every spine itemref resolves', danglingRefs.length === 0, danglingRefs.join(', '));

    // the failure mode that dedupe and the TODO-EXTRACT rewrite can produce:
    // content referencing an image file that is not in the archive
    const dangling = [];
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');
        for (const m of xhtml.matchAll(/<img[^>]+src="([^"]+)"/g)) {
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]));
            if (names.indexOf(resolved) < 0) {
                dangling.push(name + ' -> ' + m[1]);
            }
        }
    }
    check('every <img> in the content resolves to a file in the archive',
          dangling.length === 0, dangling.join(', '));

    const placeholders = names.filter((n) => n.indexOf('TODO-EXTRACT') > -1);
    check('no unresolved image-type placeholders', placeholders.length === 0,
          placeholders.join(', '));

    console.log(failures === 0 ? '\nepub structure OK' : '\n' + failures + ' structural failure(s)');
    process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
    console.error('FAILED to read the epub:', e);
    process.exit(1);
});
