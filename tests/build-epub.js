// Builds a .epub from fixture chapters using the extension's real
// saveEbook.js, so what EPUBCheck validates is the file the extension ships -
// not a reimplementation of it.
//
//   node build-epub.js [out.epub] [--single]
//
// --single builds a one-chapter book. That is the dominant real case ("save this
// page"), and the package metadata takes different branches for it: dc:date and
// dc:description come from the article itself, which would be a guess to assert
// for a book assembled from several pages.
//
// saveEbook.js expects a browser: the handful of globals it touches are stubbed
// below, and downloadBlob() is swapped for a write to disk.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'web-extension');
const args = process.argv.slice(2);
const single = args.indexOf('--single') > -1;
const outFile = args.filter((a) => a !== '--single')[0] ||
                path.join(__dirname, 'out', 'fixture.epub');

// 1x1 png
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>').toString('base64');
// 1x1 lossless webp - a core image type since epub 3.3, so it goes in unchanged
const WEBP_1X1 = 'UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAEAcQ/Y/+BSKi/wEA';

const chapters = [
    {
        title: 'First chapter & its <ampersands>',
        url: 'chapter0.xhtml',
        baseUrl: 'https://example.com/one/',
        sourceUrl: 'https://example.com/one/article?id=1&ref=x',
        metadata: {
            lang: 'en-US',
            // two authors: one invertible into a file-as, one an organisation
            // that must not be ("News, BBC")
            authors: ['Jane Smith', 'BBC News'],
            publisher: 'Example & Co',
            description: 'A description with <angle brackets> & an ampersand.',
            date: '2024-03-01'
        },
        styleFileName: 'style0.css',
        styleFileContent: '.a1 {color:rgb(0, 0, 0);font-size:12px;}',
        // img-3 is the chapter a version that could not type a webp left in
        // storage: an image with no resolvable media type, which cannot be
        // declared in the manifest. It and the <img> below pointing at it must
        // both be gone from the built book - either one surviving alone is
        // invalid, and the pair of them is what an upgrade actually finds.
        images: [{filename: 'img-1.png', data: PNG_1X1},
                 {filename: 'img-4.webp', data: WEBP_1X1},
                 {filename: 'img-3.TODO-EXTRACT', data: WEBP_1X1}],
        // a described image and a decorative one: both are answers, so this
        // chapter alone would support the alternativeText claim
        // A heading structure that does not match its nesting: h2, then h4 (a
        // level the page skipped), then back to h2. Also an empty heading, which
        // cannot be linked to, and one carrying an id of its own.
        content: '<div><h1>A different opening heading</h1>' +
                 '<p class="a1">Text with an image ' +
                 '<img src="../images/img-1.png" alt="A described photograph" /> ' +
                 '<img src="../images/img-1.png" alt="" /> and a break<br /></p>' +
                 '<p class="a1">A webp, which epub 3.3 readers must render ' +
                 '<img src="../images/img-4.webp" alt="A webp photograph" />' +
                 '<img src="../images/img-3.TODO-EXTRACT" alt="never resolved" /></p>' +
                 '<h2>Background &amp; context</h2><p class="a1">one</p>' +
                 '<h4>A skipped level</h4><p class="a1">two</p>' +
                 '<h2 id="results">Results</h2><p class="a1">three</p>' +
                 // one link into the chapter that resolves and one that does
                 // not: the target of the second is the kind of element that
                 // never leaves extraction, and a fragment pointing at nothing
                 // is an epubcheck error rather than a dead link
                 '<p class="a1"><a href="#results">back to the results</a> and ' +
                 '<a href="#never-extracted">a target that did not survive</a></p>' +
                 '<h3>  </h3><p class="a1">four</p></div>'
    },
    {
        title: 'Second chapter — unicode: éèü 你好',
        url: 'chapter1.xhtml',
        // no sourceUrl: a chapter buffered by a version that predates it, which
        // has to fall back to baseUrl rather than lose dc:source
        baseUrl: 'https://example.com/two/',
        // a page that stated a different language, and junk in the fields that
        // must not reach the package document
        metadata: {
            lang: 'ZH_hans_cn',
            authors: ['李雷'],
            publisher: '',
            description: '',
            date: '2024-04-02T09:30:00+02:00'
        },
        styleFileName: 'style1.css',
        styleFileContent: '.b2 {margin:0;}',
        images: [{filename: 'img-2.svg', data: SVG}],
        // an image whose source page said nothing about it - which must pull the
        // whole book's alternativeText claim, and turn the svg into something
        // that might animate
        // opens with a heading that is the page title: the chapter must not end
        // up with the title printed and listed twice
        //
        // ...and it is the only chapter with MathML, so properties="mathml" has
        // to appear on this manifest item and on no other
        content: '<div><h1>Second chapter — unicode: éèü 你好</h1>' +
                 // the structural attributes, in a shape EPUBCheck has to
                 // accept: a merged cell renders as an unmerged one without
                 // them, so every row after it is short
                 '<table><caption>A table with merged cells</caption>' +
                 '<colgroup><col span="2" /><col /></colgroup>' +
                 '<thead><tr><th scope="col">a</th><th scope="col">b</th>' +
                 '<th scope="col">c</th></tr></thead>' +
                 '<tbody><tr><td colspan="2">spans two</td>' +
                 '<td rowspan="2">two rows tall</td></tr>' +
                 '<tr><th scope="row">a row header</th><td>cell</td></tr></tbody></table>' +
                 '<ol start="7" reversed="reversed"><li>seven</li>' +
                 '<li value="42">forty two</li></ol>' +
                 '<blockquote cite="https://example.com/source"><p class="b2">quoted</p>' +
                 '</blockquote>' +
                 '<p class="b2" lang="fr" dir="ltr">un paragraphe, ' +
                 '<abbr title="s\'il vous plaît">svp</abbr>, on ' +
                 '<time datetime="2024-03-01">1 mars</time></p>' +
                 '<p class="b2">A display equation ' +
                 '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"' +
                 ' alttext="\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}">' +
                 '<mrow><msubsup><mo largeop="true" stretchy="true">∫</mo><mn>0</mn><mi>∞</mi></msubsup>' +
                 '<msup><mi>e</mi><mrow><mo>−</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></msup>' +
                 '<mo>=</mo><mfrac><msqrt><mi>π</mi></msqrt><mn>2</mn></mfrac></mrow>' +
                 '</math></p>' +
                 '<img src="../images/img-2.svg" /></div>'
    }
];

// ---- browser stubs ----------------------------------------------------------

const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date: Date,
    Math: Math,
    crypto: crypto,
    JSON: JSON,
    Promise: Promise,
    Blob: Blob,
    URL: {createObjectURL: () => 'blob:stub', revokeObjectURL: () => {}},
    Uint8Array: Uint8Array,
    ArrayBuffer: ArrayBuffer,
    String: String,
    Object: Object,
    Array: Array,
    Error: Error,
    chrome: {
        runtime: {
            onMessage: {addListener: () => {}},
            sendMessage: () => {},
            lastError: null
        },
        i18n: {getMessage: (k) => k},
        storage: {local: {get: (k, cb) => cb({}), set: () => {}}}
    },
    document: {
        title: 'fixture',
        createElement: () => ({style: {}, click: () => {}, appendChild: () => {}}),
        body: {appendChild: () => {}, removeChild: () => {}},
        documentElement: {appendChild: () => {}, removeChild: () => {}}
    },
    window: {location: {href: 'https://example.com/', origin: 'https://example.com'}},
    navigator: {userAgent: 'node'}
};
sandbox.window.document = sandbox.document;
sandbox.self = sandbox.window;
vm.createContext(sandbox);

function load(file) {
    const code = fs.readFileSync(path.join(EXT, file), 'utf8');
    vm.runInContext(code, sandbox, {filename: file});
}

load('libs/jszip.js');
// the UMD wrapper attaches to `window` when there is one, which in a vm context
// is not the same object as the sandbox global
if (!sandbox.JSZip && sandbox.window.JSZip) {
    sandbox.JSZip = sandbox.window.JSZip;
}
load('utils.js');
load('saveEbook.js');

// ---- build ------------------------------------------------------------------

let built = null;
sandbox.downloadBlob = function (blob, fileName) {
    built = {blob: blob, fileName: fileName};
};

sandbox.ebookTitle = 'Fixture Book';
vm.runInContext('_buildEbook(FIXTURE)',
                Object.assign(sandbox, {FIXTURE: single ? chapters.slice(0, 1) : chapters}));

// _buildEbook finishes asynchronously in generateAsync
const deadline = Date.now() + 30000;
(function wait() {
    if (built) {
        built.blob.arrayBuffer().then((buf) => {
            fs.mkdirSync(path.dirname(outFile), {recursive: true});
            fs.writeFileSync(outFile, Buffer.from(buf));
            console.log('wrote ' + outFile + ' (' + Buffer.from(buf).length + ' bytes)');
        });
        return;
    }
    if (Date.now() > deadline) {
        console.error('FAILED: _buildEbook never produced a file');
        process.exit(1);
    }
    setTimeout(wait, 50);
})();
