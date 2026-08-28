// Pure utility coverage for web-extension/utils.js. These tests deliberately
// run without a DOM implementation: the small window/document values below are
// only the URL base that browser URL resolution normally reads.
//
//   node utils.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pageUrl = 'https://example.com/articles/chapter.html?edition=2';
const sandbox = {
    console: console,
    crypto: crypto,
    URL: URL,
    Uint8Array: Uint8Array,
    ArrayBuffer: ArrayBuffer,
    window: {
        location: {
            href: pageUrl,
            origin: 'https://example.com',
            protocol: 'https:',
            host: 'example.com'
        }
    },
    document: {baseURI: pageUrl},
    chrome: {runtime: {sendMessage: () => {}}}
};
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'web-extension', 'utils.js'), 'utf8'),
    sandbox,
    {filename: 'utils.js'}
);

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''));
    if (!ok) failures++;
}
function eq(name, actual, expected) {
    check(name, actual === expected,
          actual === expected ? '' : 'got ' + JSON.stringify(actual) +
                                     ' wanted ' + JSON.stringify(expected));
}
function bytes() {
    return new Uint8Array(Array.prototype.slice.call(arguments)).buffer;
}

// ---- language tags --------------------------------------------------------

eq('language underscores are normalized', sandbox.normalizeLanguageTag(' EN_us '), 'en-US');
eq('language script and region use conventional case',
   sandbox.normalizeLanguageTag('ZH-hANS-cn'), 'zh-Hans-CN');
eq('three-letter language tags survive', sandbox.normalizeLanguageTag('fil-PH'), 'fil-PH');
for (const value of ['', '   ', 'javascript', '{{locale}}', 'en--US', 'e', 'en-verylongtag',
                     null, undefined, 42]) {
    eq('invalid language is rejected: ' + JSON.stringify(value),
       sandbox.normalizeLanguageTag(value), '');
}

// Subtags are positional, so a per-subtag "1-8 alphanumeric" test is not the
// grammar: every value below is alphanumeric and none of them is a tag.
// epubcheck reports these as OPF-092.
for (const value of ['en-1', 'en-9', 'en-12', 'en-2-3', 'en-US-1', 'en-Latn-US-abcd',
                     'x-private', 'en-x', 'en-a']) {
    eq('a well-shaped subtag in the wrong position is rejected: ' + value,
       sandbox.normalizeLanguageTag(value), '');
}
// ...and the rest of the grammar still passes. Rejecting a tag epubcheck would
// have taken costs the page its language, so the check has to be the grammar
// and not a subset of it.
for (const value of ['zh-yue', 'es-419', 'en-1abc', 'de-DE-1901', 'en-Latn-US-fonipa',
                     'en-x-foo', 'nan-Hant-TW']) {
    eq('a valid tag survives unchanged: ' + value,
       sandbox.normalizeLanguageTag(value), value);
}
eq('an extension singleton ends the region casing',
   sandbox.normalizeLanguageTag('EN-us-U-ca-gregory'), 'en-US-u-ca-gregory');

// ---- dates ----------------------------------------------------------------
//
// The well-formed branch keeps its text verbatim, which is only safe if the
// fields in it are a real moment: "2024-02-31" parses as a shape and fails
// epubcheck as a dc:date (OPF-053).

for (const [value, expected] of [
    ['2024', '2024'],
    ['2024-02', '2024-02'],
    ['2024-02-29', '2024-02-29'],
    ['2000-02-29', '2000-02-29'],
    ['2024-12-31', '2024-12-31'],
    ['2024-01-01T23:59:59Z', '2024-01-01T23:59:59Z'],
    ['2024-01-01T09:30:00+02:00', '2024-01-01T09:30:00+02:00'],
    ['  2024-03-01  ', '2024-03-01'],
    ['Fri, 01 Mar 2024 09:00:00 GMT', '2024-03-01T09:00:00Z']
]) {
    eq('a real date is kept: ' + JSON.stringify(value),
       sandbox.normalizeDate(value), expected);
}
for (const value of [
    '2024-99-99',       // no such month or day
    '2024-00-10',       // months count from one
    '2024-13-01',
    '2024-02-31',       // never a day
    '2023-02-29',       // not a leap year
    '1900-02-29',       // a century that is not a leap year
    '2024-01-32',
    '2024-01-01T29:70Z',
    '2024-01-01T24:00:00Z',
    '2024-01-01T09:30:60Z',
    '2024-01-01T09:30:00+25:00',
    '2024-01-01T09:30:00+02:99',
    '1399-01-01',       // implausible year, checked before the fields
    '', '   ', 'last tuesday', null, undefined, 42
]) {
    eq('an impossible date is rejected: ' + JSON.stringify(value),
       sandbox.normalizeDate(value), '');
}

// ---- safe link schemes ----------------------------------------------------

for (const href of ['https://example.com', 'HTTP://example.com', '../chapter', '#note', 'mailto:a@example.com']) {
    check('safe link is accepted: ' + href, sandbox.isSafeLinkUrl(href));
}
for (const href of [
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    '\u0000j\u0001a\u0002v\u0003a\nscript:alert(1)',
    ' DATA: text/html,boom',
    'vBsCrIpT:msgbox(1)',
    'blob:https://example.com/id',
    'file\rsystem:https://example.com/id'
]) {
    check('unsafe link is rejected: ' + JSON.stringify(href), !sandbox.isSafeLinkUrl(href));
}

// ---- URL resolution -------------------------------------------------------

eq('relative URL', sandbox.getAbsoluteUrl('images/cover.png'),
   'https://example.com/articles/images/cover.png');
eq('fragment-only URL', sandbox.getAbsoluteUrl('#notes'), pageUrl + '#notes');
eq('query-only URL', sandbox.getAbsoluteUrl('?print=1'),
   'https://example.com/articles/chapter.html?print=1');
eq('parent-directory URL', sandbox.getAbsoluteUrl('../sources/original'),
   'https://example.com/sources/original');
eq('protocol-relative URL', sandbox.getAbsoluteUrl('//cdn.example.net/image.png'),
   'https://cdn.example.net/image.png');
eq('root-relative URL', sandbox.getAbsoluteUrl('/about'), 'https://example.com/about');
eq('mailto URL is not made relative', sandbox.getAbsoluteUrl('mailto:editor@example.com'),
   'mailto:editor@example.com');
eq('tel URL is not made relative', sandbox.getAbsoluteUrl('tel:+12025550123'),
   'tel:+12025550123');
eq('numeric HTML entities are decoded before resolving',
   sandbox.getAbsoluteUrl('next?a=1&#38;b=2'),
   'https://example.com/articles/next?a=1&b=2');

// ---- XML ------------------------------------------------------------------

eq('invalid XML characters are removed while XML whitespace survives',
   sandbox.removeInvalidXMLChars('a\u0000\u0008\t\n\r\u000b\u000c\u000e\u001f\ufffe\uffffb'),
   'a\t\n\rb');
eq('XML attributes escape all five predefined characters',
   sandbox.escapeXMLChars('A & <tag> "quoted" \'single\'\u0000'),
   'A &amp; &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;');
eq('XML text leaves quotes alone',
   sandbox.escapeXMLText('A & <tag> "quoted" \'single\'\u0000'),
   'A &amp; &lt;tag&gt; "quoted" \'single\'');

// ---- UUID -----------------------------------------------------------------

const uuid = sandbox.generateUuid();
check('UUID has RFC 4122 version-4 format',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid),
      uuid);
check('UUID calls produce different values', sandbox.generateUuid() !== uuid);
const nativeCrypto = sandbox.crypto;
sandbox.crypto = {getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto)};
const fallbackUuid = sandbox.generateUuid();
check('fallback UUID also has RFC 4122 version-4 format',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fallbackUuid),
      fallbackUuid);
sandbox.crypto = nativeCrypto;

// ---- filenames ------------------------------------------------------------

eq('path separators are removed from an ebook filename',
   sandbox.removeSpecialChars('A/B/C'), 'A-B-C');
eq('XML entity spellings cannot introduce markup into a filename',
   sandbox.getEbookFileName('Rock &amp; Roll &lt;Live&gt; &quot;Mix&quot; &apos;24&apos;'),
   'Rock & Roll Live Mix 24');
eq('filename sanitization preserves Unicode',
   sandbox.getEbookFileName(sandbox.removeSpecialChars('Café/你好')), 'Café-你好');

// ---- title slugs ----------------------------------------------------------

eq('a slug is lowercase, ascii, and joined by underscores',
   sandbox.slugifyTitle('Hello World: An Article!'), 'hello_world_an_article');
eq('accents fold onto the letters they are drawn over',
   sandbox.slugifyTitle('Café Society — Part 1'), 'cafe_society_part_1');
eq('a slug has no leading or trailing underscore',
   sandbox.slugifyTitle('  ...Ends & Edges...  '), 'ends_edges');
eq('a long title is cut down rather than written out',
   sandbox.slugifyTitle('a'.repeat(200)), 'a'.repeat(40));
// The honest answer, and the reason buildEbook() cannot name a chapter file
// from a slug alone: there is nothing ascii here to name it with.
for (const title of ['Русская глава', '中文章节', 'Ελληνικά', 'العربية', '😀', '', null, undefined]) {
    eq('a title with no ascii in it slugs to nothing: ' + JSON.stringify(title),
       sandbox.slugifyTitle(title), '');
}
check('a stored chapter name is readable and ends in .xhtml',
      /^hello_world[0-9]+\.xhtml$/.test(sandbox.getPageUrl('Hello World')),
      sandbox.getPageUrl('Hello World'));
check('a stored chapter name for a non-Latin title is still a name',
      /^page[0-9]+\.xhtml$/.test(sandbox.getPageUrl('Русская глава')),
      sandbox.getPageUrl('Русская глава'));

// ---- base64 ---------------------------------------------------------------

const boundaryBuffers = [
    [],
    [0xff],
    [0xff, 0xee],
    [0xff, 0xee, 0xdd]
];
for (const values of boundaryBuffers) {
    const buffer = new Uint8Array(values).buffer;
    eq('base64 boundary size ' + values.length,
       sandbox.base64ArrayBuffer(buffer), Buffer.from(values).toString('base64'));
}
const largeBytes = new Uint8Array(256 * 1024 + 2);
for (let i = 0; i < largeBytes.length; i++) largeBytes[i] = (i * 31 + 17) & 0xff;
eq('large buffer base64 conversion', sandbox.base64ArrayBuffer(largeBytes.buffer),
   Buffer.from(largeBytes).toString('base64'));

// ---- image types ----------------------------------------------------------

eq('PNG signature',
   sandbox.sniffImageExtension(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'png');
eq('GIF87a signature', sandbox.sniffImageExtension(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)), 'gif');
eq('GIF89a signature', sandbox.sniffImageExtension(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'gif');
eq('JPEG signature', sandbox.sniffImageExtension(bytes(0xff, 0xd8, 0xff)), 'jpg');
eq('WebP signature', sandbox.sniffImageExtension(bytes(
    0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)), 'webp');

eq('truncated PNG is rejected', sandbox.sniffImageExtension(bytes(0x89, 0x50, 0x4e, 0x47)), '');
eq('truncated GIF is rejected', sandbox.sniffImageExtension(bytes(0x47, 0x49, 0x46, 0x38)), '');
eq('truncated JPEG is rejected', sandbox.sniffImageExtension(bytes(0xff, 0xd8)), '');
eq('truncated WebP is rejected', sandbox.sniffImageExtension(bytes(
    0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42)), '');
eq('RIFF WAVE data is not WebP', sandbox.sniffImageExtension(bytes(
    0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45)), '');
eq('WEBP marker at the wrong offset is rejected', sandbox.sniffImageExtension(bytes(
    0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50, 0x00, 0x00, 0x00, 0x00)), '');

eq('uppercase image extension', sandbox.getFileExtension('PHOTO.JpG'), 'jpeg');
eq('image extension before a query', sandbox.getFileExtension('cover.WEBP?width=800'), 'webp');
eq('image extension before a fragment', sandbox.getFileExtension('diagram.SVG#figure-1'), 'svg');
eq('image extension before query and fragment',
   sandbox.getFileExtension('cover.PNG?width=800#figure-1'), 'png');
eq('extension-like query value is not an extension',
   sandbox.getFileExtension('image?format=.png'), '');

// ---- literal image-name removal ------------------------------------------

const oddName = 'img.[draft](1)+$^?.png';
const imageMarkup = '<p><img src="../images/' + oddName + '" alt="drop" />' +
                    '<img src="../images/imgXdrafX1ZZZ.png" alt="keep" /></p>';
const withoutOddImage = sandbox.removeImgTags(imageMarkup, oddName);
check('an image name containing regex characters is removed literally',
      withoutOddImage.indexOf(oddName) === -1, withoutOddImage);
check('a regex-like image name does not remove a lookalike',
      withoutOddImage.indexOf('imgXdrafX1ZZZ.png') > -1, withoutOddImage);

// ---- XML-compatible ids ---------------------------------------------------

for (const id of ['intro', '_private', 'chapter-1', 'note.2', 'a_b-c.3']) {
    check('usable XML id: ' + id, sandbox.isUsableId(id));
}
for (const id of ['', '9lives', '-leading', '.leading', 'has space', 'has:colon', 'two#parts']) {
    check('unusable XML id: ' + JSON.stringify(id), !sandbox.isUsableId(id));
}

console.log(failures === 0 ? '\nutils OK' : '\n' + failures + ' utility failure(s)');
process.exit(failures === 0 ? 0 : 1);
