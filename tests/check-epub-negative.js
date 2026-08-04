// Proves that each important check in check-epub.js rejects a deliberately
// broken archive. A non-zero exit alone is not enough: every case must print
// the particular FAIL line it was designed to exercise.
//
//   node check-epub-negative.js [out/fixture.epub]

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const fixture = process.argv[2] || path.join(__dirname, 'out', 'fixture.epub');
const checker = path.join(__dirname, 'check-epub.js');
const builder = path.join(__dirname, 'build-epub.js');
const mimetype = 'application/epub+zip';

const sandbox = {console, setTimeout, clearTimeout, setInterval, clearInterval,
                 setImmediate, Promise, Blob, Uint8Array, ArrayBuffer, Date, Math, JSON};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web-extension', 'libs', 'jszip.js'), 'utf8'),
                sandbox, {filename: 'jszip.js'});
const JSZip = sandbox.JSZip;

let failures = 0;

function checkerResult(file) {
    return childProcess.spawnSync(process.execPath, [checker, file], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
}

function pass(name) {
    console.log('PASS ' + name);
}

function fail(name, detail) {
    failures++;
    console.log('FAIL ' + name + ' -- ' + detail);
}

function replace(text, before, after) {
    if (text.indexOf(before) < 0) {
        throw new Error('fixture no longer contains ' + JSON.stringify(before));
    }
    return text.replace(before, after);
}

async function rewrite(zip, name, change) {
    const original = await zip.file(name).async('string');
    zip.file(name, change(original));
}

async function mutatedArchive(raw, mutate) {
    const zip = await JSZip.loadAsync(raw);
    await mutate(zip);
    // Loading and regenerating a zip loses the per-entry compression setting.
    // Set this explicitly so mutations unrelated to OCF stay isolated.
    zip.file('mimetype', mimetype, {compression: 'STORE'});
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

async function compressedMimetype(raw) {
    const zip = await JSZip.loadAsync(raw);
    zip.file('mimetype', mimetype, {compression: 'DEFLATE'});
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

async function misplacedMimetype(raw) {
    const source = await JSZip.loadAsync(raw);
    const zip = new JSZip();
    const names = Object.keys(source.files).filter((name) => name !== 'mimetype');
    for (const name of names) {
        const entry = source.files[name];
        if (!entry.dir) {
            zip.file(name, await entry.async('uint8array'), {binary: true});
        }
    }
    zip.file('mimetype', mimetype, {compression: 'STORE'});
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}

async function runCase(tempDir, raw, test) {
    const file = path.join(tempDir, test.slug + '.epub');
    let archive;
    try {
        archive = test.archive ? await test.archive(raw) : await mutatedArchive(raw, test.mutate);
    } catch (error) {
        fail(test.name, 'could not build corrupt fixture: ' + error.message);
        return;
    }
    fs.writeFileSync(file, archive);

    const result = checkerResult(file);
    const output = (result.stdout || '') + (result.stderr || '');
    const expected = 'FAIL ' + test.expected;
    if (result.status === 1 && output.indexOf(expected) > -1) {
        pass(test.name);
    } else {
        fail(test.name, 'wanted exit 1 and ' + JSON.stringify(expected) +
             ', got exit ' + result.status + '\n' + output.trim());
    }
}

(async () => {
    if (!fs.existsSync(fixture)) {
        const built = childProcess.spawnSync(process.execPath, [builder, fixture], {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024
        });
        if (built.status !== 0) {
            console.error((built.stdout || '') + (built.stderr || ''));
            process.exit(1);
        }
    }

    const valid = checkerResult(fixture);
    if (valid.status !== 0) {
        console.error('The negative-test baseline is not valid:\n' +
                      (valid.stdout || '') + (valid.stderr || ''));
        process.exit(1);
    }
    pass('uncorrupted baseline passes before negative checks');

    const raw = fs.readFileSync(fixture);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-as-ebook-check-'));
    const tests = [
        {
            name: 'compressed mimetype is rejected',
            slug: 'compressed-mimetype',
            expected: 'mimetype is the first entry and uncompressed',
            archive: compressedMimetype
        },
        {
            name: 'misplaced mimetype is rejected',
            slug: 'misplaced-mimetype',
            expected: 'mimetype is the first entry and uncompressed',
            archive: misplacedMimetype
        },
        {
            name: 'a manifest entry whose file is missing is rejected',
            slug: 'missing-manifest-file',
            expected: 'every manifest href exists in the archive',
            mutate: (zip) => zip.remove('OEBPS/ebook.css')
        },
        {
            name: 'duplicate manifest IDs are rejected',
            slug: 'duplicate-manifest-id',
            expected: 'manifest ids are unique',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf, 'id="style1"', 'id="style0"'))
        },
        {
            name: 'a dangling spine idref is rejected',
            slug: 'dangling-spine',
            expected: 'every spine itemref resolves',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf, 'idref="ebook1"', 'idref="missing-chapter"'))
        },
        {
            name: 'a dangling image source is rejected',
            slug: 'dangling-image',
            expected: 'every <img> in the content resolves to a file in the archive',
            mutate: (zip) => rewrite(zip, 'OEBPS/pages/chapter0.xhtml', (xhtml) =>
                replace(xhtml, '../images/img-1.png', '../images/missing.png'))
        },
        {
            name: 'a dangling navigation file is rejected',
            slug: 'dangling-navigation',
            expected: 'every navigation target resolves to a file and an id in it',
            mutate: (zip) => rewrite(zip, 'OEBPS/toc.xhtml', (nav) =>
                replace(nav, 'href="pages/chapter0.xhtml"', 'href="pages/missing.xhtml"'))
        },
        {
            name: 'a dangling content fragment is rejected',
            slug: 'dangling-fragment',
            expected: 'every link into a chapter resolves to an id in that same chapter',
            mutate: (zip) => rewrite(zip, 'OEBPS/pages/chapter0.xhtml', (xhtml) =>
                replace(xhtml, 'href="#results"', 'href="#missing-fragment"'))
        },
        {
            name: 'an incorrect manifest media type is rejected',
            slug: 'incorrect-media-type',
            expected: 'manifest media types match their files',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf, 'media-type="image/png"', 'media-type="image/jpeg"'))
        },
        {
            name: 'MathML without a mathml manifest property is rejected',
            slug: 'mathml-undeclared',
            expected: 'properties="mathml" is declared for exactly the files that contain MathML',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf, ' properties="mathml" media-type="application/xhtml+xml"',
                             ' media-type="application/xhtml+xml"'))
        },
        {
            name: 'a false mathml manifest property is rejected',
            slug: 'mathml-false-property',
            expected: 'properties="mathml" is declared for exactly the files that contain MathML',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf, 'id="ebook0" href=', 'id="ebook0" properties="mathml" href='))
        },
        {
            name: 'a false alternativeText accessibility claim is rejected',
            slug: 'false-accessibility-claim',
            expected: 'alternativeText is claimed only when every image is accounted for',
            mutate: (zip) => rewrite(zip, 'OEBPS/content.opf', (opf) =>
                replace(opf,
                        '<meta property="schema:accessibilityFeature">tableOfContents</meta>',
                        '<meta property="schema:accessibilityFeature">tableOfContents</meta>\n' +
                        '<meta property="schema:accessibilityFeature">alternativeText</meta>'))
        },
        {
            name: 'mismatched OPF and NCX identifiers are rejected',
            slug: 'mismatched-identifiers',
            expected: 'ncx dtb:uid matches dc:identifier',
            mutate: (zip) => rewrite(zip, 'OEBPS/toc.ncx', (ncx) =>
                ncx.replace(/content="urn:uuid:[^"]+"/, 'content="urn:uuid:00000000-0000-4000-8000-000000000000"'))
        }
    ];

    try {
        for (const test of tests) {
            await runCase(tempDir, raw, test);
        }
    } finally {
        fs.rmSync(tempDir, {recursive: true, force: true});
    }

    console.log(failures === 0 ? '\nnegative EPUB checks OK' :
                '\n' + failures + ' negative EPUB check(s) failed');
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error('FAILED to run negative EPUB checks:', error);
    process.exit(1);
});
