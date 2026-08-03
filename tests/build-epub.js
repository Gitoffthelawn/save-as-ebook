// Builds a .epub from fixture chapters using the extension's real
// saveEbook.js, so what EPUBCheck validates is the file the extension ships -
// not a reimplementation of it.
//
//   node build-epub.js [out.epub]
//
// saveEbook.js expects a browser: the handful of globals it touches are stubbed
// below, and downloadBlob() is swapped for a write to disk.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'web-extension');
const outFile = process.argv[2] || path.join(__dirname, 'out', 'fixture.epub');

// 1x1 png
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>').toString('base64');

const chapters = [
    {
        title: 'First chapter & its <ampersands>',
        url: 'chapter0.xhtml',
        baseUrl: 'https://example.com/one',
        styleFileName: 'style0.css',
        styleFileContent: '.a1 {color:rgb(0, 0, 0);font-size:12px;}',
        images: [{filename: 'img-1.png', data: PNG_1X1}],
        content: '<div><h1>First</h1><p class="a1">Text with an image ' +
                 '<img src="../images/img-1.png" /> and a break<br /></p></div>'
    },
    {
        title: 'Second chapter — unicode: éèü 你好',
        url: 'chapter1.xhtml',
        baseUrl: 'https://example.com/two',
        styleFileName: 'style1.css',
        styleFileContent: '.b2 {margin:0;}',
        images: [{filename: 'img-2.svg', data: SVG}],
        content: '<div><h1>Second</h1><table><tr><td>cell</td></tr></table>' +
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
vm.runInContext('_buildEbook(FIXTURE)', Object.assign(sandbox, {FIXTURE: chapters}));

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
