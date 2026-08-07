// Builds a .epub from fixture chapters using the extension's real
// saveEbook.js, so what EPUBCheck validates is the file the extension ships -
// not a reimplementation of it.
//
//   node build-epub.js [out.epub] [--single] [--chapters file.json]
//
// --single builds a one-chapter book. That is the dominant real case ("save this
// page"), and the package metadata takes different branches for it: dc:date and
// dc:description come from the article itself, which would be a guess to assert
// for a book assembled from several pages.
//
// --chapters builds from a chapter list on disk instead of the fixture below.
// build-edited-epub.sh writes one out of the chapter editor - chapters that were
// edited in a live DOM and serialized back - so that EPUBCheck sees the content
// an edit produces and not only the content extraction produces.
//
// saveEbook.js expects a browser: the handful of globals it touches are stubbed
// below, and downloadBlob() is swapped for a write to disk.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'web-extension');
const args = process.argv.slice(2);
const single = args.indexOf('--single') > -1;
const chaptersFlag = args.indexOf('--chapters');
const chaptersFile = chaptersFlag > -1 ? args[chaptersFlag + 1] : null;
// the first argument that is not a flag, and not the file name belonging to one
const outFile = args.filter((a, i) => a !== '--single' && a !== '--chapters' &&
                                      !(chaptersFlag > -1 && i === chaptersFlag + 1))[0] ||
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
        // Css the user wrote for this one chapter, alongside the book-wide
        // stylesheet passed to buildEbook() below. Both are here so that
        // EPUBCheck sees them: user-authored css is deliberately not held to the
        // allowlist extraction uses, and this is what says that a book carrying
        // some is still a valid book.
        customCss: '.a1 {text-align: justify;}\n' +
                   // and that what does escape a stylesheet is taken out before
                   // it can contradict a manifest that claims no remote resources
                   '.a1 {background-image: url("https://cdn.example.com/paper.png");}\n' +
                   '@import url("https://cdn.example.com/more.css");',
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
                 // Links to other pages of the same site, as extraction leaves
                 // them - absolute, because while this chapter was extracted the
                 // rest of the book did not exist. Two of them are chapters here
                 // and have to end up pointing at those files; the third is a
                 // page nobody saved and has to be left addressing the web.
                 // The second chapter is addressed by the url its baseUrl names,
                 // since it predates sourceUrl entirely.
                 '<p class="a1"><a href="https://example.com/three/article#summary">the third chapter</a>, ' +
                 '<a href="https://example.com/two/">the second chapter</a>, ' +
                 '<a href="https://example.com/three/article#not-extracted">a heading it does not have</a> ' +
                 'and <a href="https://example.com/elsewhere">a page nobody saved</a></p>' +
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
    },
    {
        title: 'الفصل الثالث',
        url: 'chapter2.xhtml',
        baseUrl: 'https://example.com/three/',
        sourceUrl: 'https://example.com/three/article',
        metadata: {
            lang: 'ar',
            // What the page said about which way it reads. Whether it said it
            // with <html dir> or in css, extraction reports it the same way -
            // and this is the only value it ever reports, so the book turns its
            // pages right to left and this chapter's <html> carries dir.
            dir: 'rtl',
            authors: [],
            publisher: '',
            description: '',
            date: ''
        },
        // What a user typed about this chapter in the editor, over a page that
        // said nothing: a creator and a date that reach the package document
        // from the panel rather than from any <head>. The name is one getFileAs()
        // must decline to invert, so the refinement it does get is a role and
        // nothing more.
        metadataOverride: {
            lang: '',
            authors: ['أحمد الشيخ'],
            publisher: '',
            description: '',
            date: '1998-05-04'
        },
        styleFileName: 'style2.css',
        styleFileContent: '.c3 {color:rgb(0, 0, 0);}',
        // no images and no formulas: this chapter is here for direction and for
        // being a link target, and it must not move the book's accessibility
        // claims while it is
        images: [],
        content: '<div><h1>الفصل الثالث</h1>' +
                 '<p class="c3">فقرة عربية بها نص.</p>' +
                 '<h2 id="summary">ملخص</h2>' +
                 '<p class="c3">نص الملخص.</p></div>'
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
    // the real constructor, which chapterUrlKey() parses addresses with, plus
    // the two statics the download path calls
    URL: Object.assign(class extends URL {}, {
        createObjectURL: () => 'blob:stub',
        revokeObjectURL: () => {}
    }),
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

let toBuild = chapters;
if (chaptersFile) {
    toBuild = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    if (!Array.isArray(toBuild) || toBuild.length === 0) {
        console.error('FAILED: ' + chaptersFile + ' holds no chapters');
        process.exit(1);
    }
    console.log('building from ' + chaptersFile + ' (' + toBuild.length + ' chapters)');
}

// The book metadata a user stated in the editor. Only the publisher: the fields
// beside it are what the fixture chapters are here to exercise - dc:date and
// dc:description branch on how many chapters there are, dc:language is read off
// the pages, and dc:creator is where getFileAs() has to decide what it can
// invert. Overriding those would replace the cases with a constant. The
// publisher is stated with characters that have to be escaped, which is the one
// thing a stated value can do to a package that a derived one cannot.
vm.runInContext('buildEbook(FIXTURE, {title: "Fixture Book", css: BOOK_CSS, metadata: BOOK_META})',
                Object.assign(sandbox, {
                    FIXTURE: single ? toBuild.slice(0, 1) : toBuild,
                    BOOK_CSS: 'body {\n    font-family: serif;\n    line-height: 1.5;\n}\n' +
                              'blockquote {\n    font-style: italic;\n}\n',
                    BOOK_META: {publisher: 'A & B Books <Ltd>'}
                }));

// buildEbook finishes asynchronously in generateAsync
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
        console.error('FAILED: buildEbook never produced a file');
        process.exit(1);
    }
    setTimeout(wait, 50);
})();
