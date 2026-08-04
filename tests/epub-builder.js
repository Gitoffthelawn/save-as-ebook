// Scenario coverage for the real EPUB writer in web-extension/saveEbook.js.
// Each case builds an archive in memory and inspects the files JSZip produced.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'web-extension');
const IMAGE_BYTES = Buffer.from('image bytes used by the scenario tests').toString('base64');
const SVG_BYTES = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg">' + '<rect width="1" height="1"/>'.repeat(80) + '</svg>'
).toString('base64');

function makeSandbox() {
    const state = {title: 'Scenario Book', uuid: null, pages: [], downloads: [], messages: [], alerts: []};
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval: () => 1,
        clearInterval: () => {},
        Date,
        Math,
        crypto,
        JSON,
        Promise,
        Blob,
        // the real constructor, because chapterUrlKey() parses addresses with it,
        // plus the two statics the download path calls
        URL: Object.assign(class extends URL {}, {
            createObjectURL: () => 'blob:test',
            revokeObjectURL: () => {}
        }),
        Uint8Array,
        ArrayBuffer,
        String,
        Object,
        Array,
        Error,
        alert: (message) => state.alerts.push(message),
        chrome: {
            runtime: {
                onMessage: {addListener: () => {}},
                lastError: null,
                sendMessage: (message, callback) => {
                    state.messages.push(message);
                    let response = {};
                    if (message.type === 'get title') response = {title: state.title};
                    if (message.type === 'get uuid') response = {uuid: state.uuid};
                    if (message.type === 'get') response = {allPages: state.pages};
                    if (callback) callback(response);
                }
            },
            i18n: {getMessage: (key) => key},
            storage: {local: {get: (key, callback) => callback({}), set: () => {}}}
        },
        document: {
            title: 'fixture',
            createElement: () => ({style: {}, click: () => {}}),
            body: {appendChild: () => {}, removeChild: () => {}},
            documentElement: {appendChild: () => {}, removeChild: () => {}}
        },
        window: {location: {href: 'https://example.test/', origin: 'https://example.test'}},
        navigator: {userAgent: 'node'}
    };
    sandbox.window.document = sandbox.document;
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    for (const file of ['libs/jszip.js', 'utils.js', 'saveEbook.js']) {
        vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, {filename: file});
        if (!sandbox.JSZip && sandbox.window.JSZip) sandbox.JSZip = sandbox.window.JSZip;
    }
    return {sandbox, state};
}

function chapter(overrides) {
    return Object.assign({
        title: 'A chapter',
        url: 'chapter.xhtml',
        sourceUrl: 'https://example.test/article',
        metadata: {lang: 'en', authors: [], publisher: '', description: '', date: ''},
        styleFileName: 'chapter.css',
        styleFileContent: '',
        images: [],
        content: '<p>Text</p>'
    }, overrides || {});
}

async function build(env, pages, options) {
    options = options || {};
    const {sandbox, state} = env;
    state.title = options.title === undefined ? 'Scenario Book' : options.title;
    state.uuid = options.uuid || null;
    state.pages = pages;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('builder did not produce an EPUB')), 5000);
        sandbox.downloadBlob = (blob, fileName) => {
            blob.arrayBuffer().then((buffer) => {
                clearTimeout(timer);
                const result = {raw: Buffer.from(buffer), fileName};
                state.downloads.push(result);
                resolve(result);
            }, reject);
        };
        if (options.path === 'chapters') sandbox.buildEbookFromChapters();
        else if (options.path === 'one-shot') sandbox.buildEbook(pages);
        else {
            sandbox.ebookTitle = state.title;
            sandbox.ebookUuid = state.uuid;
            sandbox._buildEbook(pages);
        }
    });
}

async function inspect(env, result) {
    const zip = await env.sandbox.JSZip.loadAsync(result.raw);
    const read = async (name) => zip.file(name).async('string');
    return {
        zip,
        names: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
        opf: await read('OEBPS/content.opf'),
        nav: await read('OEBPS/toc.xhtml'),
        ncx: await read('OEBPS/toc.ncx'),
        read
    };
}

function identifier(opf) {
    return (opf.match(/<dc:identifier[^>]*>([^<]+)<\/dc:identifier>/) || [])[1];
}

function propertyValues(opf, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...opf.matchAll(new RegExp('<meta property="' + escaped + '">([^<]*)<\\/meta>', 'g'))]
        .map((match) => match[1]);
}

function centralCompressionMethods(raw) {
    const methods = {};
    for (let offset = 0; offset + 46 <= raw.length;) {
        const signature = raw.readUInt32LE(offset);
        if (signature !== 0x02014b50) {
            offset++;
            continue;
        }
        const nameLength = raw.readUInt16LE(offset + 28);
        const extraLength = raw.readUInt16LE(offset + 30);
        const commentLength = raw.readUInt16LE(offset + 32);
        const name = raw.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
        methods[name] = raw.readUInt16LE(offset + 10);
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return methods;
}

let failures = 0;
async function scenario(name, run) {
    try {
        await run();
        console.log('PASS ' + name);
    } catch (error) {
        failures++;
        console.log('FAIL ' + name + ' -- ' + error.message);
    }
}
function ok(value, message) {
    if (!value) throw new Error(message);
}
function equal(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message + ': got ' + JSON.stringify(actual) + ', wanted ' + JSON.stringify(expected));
    }
}

(async () => {
    await scenario('empty input is rejected and malformed records beside a valid chapter are skipped', async () => {
        const empty = makeSandbox();
        for (const value of [undefined, null, {}, [], [null, undefined, 'broken', {}]]) {
            empty.sandbox._buildEbook(value);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        equal(empty.state.downloads.length, 0, 'empty input must not download a book');
        equal(empty.state.alerts.length, 5, 'each empty build should report a useful failure');

        const env = makeSandbox();
        const page = chapter({title: 'The survivor'});
        const epub = await inspect(env, await build(env, [null, 'broken', {}, page]));
        equal((epub.opf.match(/<itemref /g) || []).length, 1, 'only the valid chapter should reach the spine');
        ok(epub.opf.includes('<dc:title id="t1">Scenario Book</dc:title>'), 'the valid chapter should still build');
    });

    await scenario('single-chapter and compilation package metadata take different branches', async () => {
        const first = chapter({
            url: 'one.xhtml',
            metadata: {lang: 'en', authors: [], publisher: '', description: 'Only this article', date: '2025-02-03'}
        });
        const second = chapter({
            title: 'Two', url: 'two.xhtml', styleFileName: 'two.css',
            metadata: {lang: 'en', authors: [], publisher: '', description: 'Not the book', date: '2025-04-05'}
        });
        let env = makeSandbox();
        let epub = await inspect(env, await build(env, [first]));
        ok(epub.opf.includes('<dc:date>2025-02-03</dc:date>'), 'single save should use the article date');
        ok(epub.opf.includes('<dc:description>Only this article</dc:description>'), 'single save should use its description');

        env = makeSandbox();
        epub = await inspect(env, await build(env, [first, second]));
        ok(!epub.opf.includes('<dc:description>'), 'a compilation must not borrow one chapter description');
        ok(!epub.opf.includes('<dc:date>2025-02-03</dc:date>'), 'a compilation should use its build date');
        equal((epub.opf.match(/property="dcterms:created"/g) || []).length, 2,
              'each chapter should retain its own date');
    });

    await scenario('rebuilt books keep their UUID while one-shot saves mint new UUIDs', async () => {
        const stable = '12345678-1234-4abc-8def-1234567890ab';
        const env = makeSandbox();
        const a = await inspect(env, await build(env, [chapter()], {path: 'chapters', uuid: stable}));
        const b = await inspect(env, await build(env, [chapter()], {path: 'chapters', uuid: stable}));
        equal(identifier(a.opf), 'urn:uuid:' + stable, 'stored UUID should be used');
        equal(identifier(b.opf), identifier(a.opf), 'rebuild UUID should be stable');

        const one = await inspect(env, await build(env, [chapter()], {path: 'one-shot'}));
        const two = await inspect(env, await build(env, [chapter()], {path: 'one-shot'}));
        ok(identifier(one.opf) !== identifier(two.opf), 'one-shot saves should not reuse an identifier');
    });

    await scenario('all package metadata and source URL values are XML escaped', async () => {
        const env = makeSandbox();
        const page = chapter({
            title: 'Chapter & <one> "quoted"',
            sourceUrl: 'https://example.test/?a=1&b="two"&c=\'three\'',
            metadata: {
                lang: 'en',
                authors: ['A & B <Authors>'],
                publisher: 'P & P <Press>',
                description: 'D & D <words> "quote" \'apostrophe\'',
                date: ''
            }
        });
        const epub = await inspect(env, await build(env, [page], {title: 'Book & <Archive> "Q" \'S\''}));
        ok(epub.opf.includes('Book &amp; &lt;Archive&gt; &quot;Q&quot; &apos;S&apos;'), 'book title was not escaped');
        ok(epub.opf.includes('A &amp; B &lt;Authors&gt;'), 'author was not escaped');
        ok(epub.opf.includes('P &amp; P &lt;Press&gt;'), 'publisher was not escaped');
        ok(epub.opf.includes('D &amp; D &lt;words&gt; &quot;quote&quot; &apos;apostrophe&apos;'), 'description was not escaped');
        ok(epub.opf.includes('https://example.test/?a=1&amp;b=&quot;two&quot;&amp;c=&apos;three&apos;'), 'source URL was not escaped');
        const content = await epub.read('OEBPS/pages/chapter.xhtml');
        ok(content.includes('<title>Chapter &amp; &lt;one&gt; &quot;quoted&quot;</title>'), 'chapter title was not escaped');
    });

    await scenario('duplicate image filenames produce one archive member and unique manifest IDs', async () => {
        const env = makeSandbox();
        const image = {filename: 'shared.png', data: IMAGE_BYTES};
        const pages = [
            chapter({url: 'one.xhtml', images: [image, image], content: '<img src="../images/shared.png" alt="one" />'}),
            chapter({title: 'Two', url: 'two.xhtml', styleFileName: 'two.css', images: [image],
                     content: '<img src="../images/shared.png" alt="two" />'})
        ];
        const epub = await inspect(env, await build(env, pages));
        equal(epub.names.filter((name) => name === 'OEBPS/images/shared.png').length, 1,
              'the zip should contain the shared image once');
        equal((epub.opf.match(/href="images\/shared\.png"/g) || []).length, 1,
              'the manifest should declare the shared image once');
        const ids = [...epub.opf.matchAll(/<item [^>]*id="([^"]+)"/g)].map((match) => match[1]);
        equal(new Set(ids).size, ids.length, 'manifest IDs must be unique');
    });

    await scenario('missing, unsupported, and duplicate images cannot leave dangling EPUB references', async () => {
        const env = makeSandbox();
        const page = chapter({
            images: [
                {filename: 'kept.jpg', data: IMAGE_BYTES},
                {filename: 'kept.jpg', data: IMAGE_BYTES},
                {filename: 'unsupported.bmp', data: IMAGE_BYTES},
                null,
                {filename: 'no-data.png'}
            ],
            content: '<img src="../images/kept.jpg" alt="kept" />' +
                     '<img src="../images/unsupported.bmp" alt="bad" />' +
                     '<img src="../images/missing.png" alt="missing" />' +
                     '<img src="../images/no-data.png" alt="empty" />'
        });
        const epub = await inspect(env, await build(env, [page]));
        const content = await epub.read('OEBPS/pages/chapter.xhtml');
        ok(content.includes('kept.jpg'), 'supported image was removed');
        ok(!/(unsupported\.bmp|missing\.png|no-data\.png)/.test(content), 'dangling image reference survived');
        equal(epub.names.filter((name) => name === 'OEBPS/images/kept.jpg').length, 1,
              'duplicate supported image should be stored once');
        ok(!/(unsupported\.bmp|missing\.png|no-data\.png)/.test(epub.opf), 'invalid image reached the manifest');
    });

    // A chapter buffered by an older version can still name an image by its
    // original address. That is not a reference into this archive, so repairing
    // dangling archive references must leave it where it is.
    await scenario('a remote image source is not mistaken for a missing archive file', async () => {
        const env = makeSandbox();
        const page = chapter({
            images: [{filename: 'local.png', data: IMAGE_BYTES}],
            content: '<img src="../images/local.png" alt="local" />' +
                     '<img src="https://cdn.example.test/images/photo.jpg" alt="remote" />' +
                     '<img src="//cdn.example.test/images/logo.png" alt="protocol relative" />'
        });
        const content = await (await inspect(env, await build(env, [page])))
              .read('OEBPS/pages/chapter.xhtml');
        ok(content.includes('cdn.example.test/images/photo.jpg'), 'remote image was dropped');
        ok(content.includes('//cdn.example.test/images/logo.png'), 'protocol-relative image was dropped');
        ok(content.includes('../images/local.png'), 'local image was dropped');
    });

    await scenario('SVG is deflated while PNG, GIF, JPEG, and WebP are stored', async () => {
        const env = makeSandbox();
        const extensions = ['svg', 'png', 'gif', 'jpg', 'webp'];
        const images = extensions.map((extension) => ({
            filename: 'asset.' + extension,
            data: extension === 'svg' ? SVG_BYTES : IMAGE_BYTES
        }));
        const content = extensions.map((extension) =>
            '<img src="../images/asset.' + extension + '" alt="' + extension + '" />').join('');
        const result = await build(env, [chapter({images, content})]);
        const methods = centralCompressionMethods(result.raw);
        equal(methods['OEBPS/images/asset.svg'], 8, 'SVG compression method');
        for (const extension of ['png', 'gif', 'jpg', 'webp']) {
            equal(methods['OEBPS/images/asset.' + extension], 0, extension + ' compression method');
        }
    });

    await scenario('image accessibility metadata follows described/decorative/undescribed/animatable truth tables', async () => {
        async function metadata(content, extension) {
            const env = makeSandbox();
            const images = extension ? [{filename: 'image.' + extension, data: IMAGE_BYTES}] : [];
            return (await inspect(env, await build(env, [chapter({images, content})]))).opf;
        }
        let opf = await metadata('<p>text only</p>');
        ok(propertyValues(opf, 'schema:accessModeSufficient').includes('textual'), 'text-only book should be textually sufficient');
        ok(!propertyValues(opf, 'schema:accessMode').includes('visual'), 'text-only book should not claim visual mode');

        opf = await metadata('<img src="../images/image.png" alt="description" />', 'png');
        ok(propertyValues(opf, 'schema:accessibilityFeature').includes('alternativeText'), 'described image should claim alternativeText');
        ok(propertyValues(opf, 'schema:accessModeSufficient').includes('textual'), 'described image should be accounted for');

        opf = await metadata('<img src="../images/image.png" alt="" />', 'png');
        ok(!propertyValues(opf, 'schema:accessibilityFeature').includes('alternativeText'), 'decorative-only image has no alternative text feature');
        ok(propertyValues(opf, 'schema:accessModeSufficient').includes('textual'), 'decorative image should be accounted for');

        opf = await metadata('<img src="../images/image.png" />', 'png');
        ok(!propertyValues(opf, 'schema:accessModeSufficient').includes('textual'), 'undescribed image prevents textual sufficiency');
        ok(!propertyValues(opf, 'schema:accessibilityFeature').includes('alternativeText'), 'undescribed image prevents alternativeText claim');

        opf = await metadata('<img src="../images/image.gif" alt="animation" />', 'gif');
        ok(!propertyValues(opf, 'schema:accessibilityHazard').includes('noFlashingHazard'), 'animatable image prevents no-flashing claim');
        ok(!propertyValues(opf, 'schema:accessibilityHazard').includes('noMotionSimulationHazard'), 'animatable image prevents no-motion claim');
    });

    await scenario('MathML and describedMath metadata distinguish formulas with and without alttext', async () => {
        async function mathOpf(openingTag) {
            const env = makeSandbox();
            const content = openingTag + '<mi>x</mi></math>';
            return inspect(env, await build(env, [chapter({content})]));
        }
        let epub = await mathOpf('<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="x">');
        ok(/id="ebook0"[^>]*properties="mathml"/.test(epub.opf), 'MathML chapter property is missing');
        ok(propertyValues(epub.opf, 'schema:accessibilityFeature').includes('MathML'), 'MathML feature is missing');
        ok(propertyValues(epub.opf, 'schema:accessibilityFeature').includes('describedMath'), 'describedMath should be present');

        epub = await mathOpf('<math xmlns="http://www.w3.org/1998/Math/MathML">');
        ok(propertyValues(epub.opf, 'schema:accessibilityFeature').includes('MathML'), 'MathML feature is missing without alttext');
        ok(!propertyValues(epub.opf, 'schema:accessibilityFeature').includes('describedMath'), 'undescribed formula must not claim describedMath');
    });

    await scenario('chapters without headings and same-level headings produce valid flat navigation', async () => {
        let env = makeSandbox();
        let epub = await inspect(env, await build(env, [
            chapter({url: 'one.xhtml', content: '<p>No headings</p>'}),
            chapter({title: 'Two', url: 'two.xhtml', styleFileName: 'two.css', content: '<p>Still none</p>'})
        ]));
        const toc = epub.nav.split('</nav>')[0];
        equal((toc.match(/<ol\b/g) || []).length, 1, 'heading-free navigation should have one list level');
        equal((epub.nav.match(/href="pages\//g) || []).length, 3,
              'two toc links plus the bodymatter landmark should be present');
        ok(!propertyValues(epub.opf, 'schema:accessibilityFeature').includes('structuralNavigation'),
           'heading-free chapters must not claim structural navigation');
        ok(epub.ncx.includes('name="dtb:depth" content="1"'), 'flat NCX depth should be one');

        env = makeSandbox();
        epub = await inspect(env, await build(env, [chapter({content: '<h2>One</h2><h2>Two</h2><h2>Three</h2>'})]));
        const headingToc = epub.nav.split('</nav>')[0];
        equal((headingToc.match(/<ol\b/g) || []).length, 2,
              'same-level headings should be siblings under the chapter, not nested in each other');
        ok(epub.ncx.includes('name="dtb:depth" content="2"'), 'chapter plus flat headings should have depth two');
    });

    await scenario('a right to left chapter turns the book without turning the other chapters', async () => {
        const rtl = (overrides) => chapter(Object.assign({
            metadata: {lang: 'ar', dir: 'rtl', authors: [], publisher: '', description: '', date: ''}
        }, overrides));

        let env = makeSandbox();
        let epub = await inspect(env, await build(env, [
            rtl({url: 'ar.xhtml'}),
            chapter({title: 'English', url: 'en.xhtml', styleFileName: 'en.css'})
        ]));
        ok(epub.opf.includes('page-progression-direction="rtl"'),
           'a book with a right to left chapter has to turn its pages that way');
        ok((await epub.read('OEBPS/pages/ar.xhtml')).includes(' dir="rtl"'),
           'the right to left chapter should state its direction');
        // direction is only ever recorded when it is rtl, so taking the book's
        // for a chapter that recorded nothing would reverse this one
        ok(!(await epub.read('OEBPS/pages/en.xhtml')).includes(' dir='),
           'a chapter that said nothing about direction must not inherit the book\'s');

        env = makeSandbox();
        epub = await inspect(env, await build(env, [chapter()]));
        ok(!epub.opf.includes('page-progression-direction'),
           'a book with no right to left chapter should not state a progression direction');
        ok(!(await epub.read('OEBPS/pages/chapter.xhtml')).includes(' dir='),
           'left to right is the default and does not need saying');

        // chapters buffered before extraction read the direction at all
        env = makeSandbox();
        epub = await inspect(env, await build(env, [chapter({metadata: undefined})]));
        ok(!epub.opf.includes('page-progression-direction'),
           'a chapter with no metadata at all should build as left to right');
    });

    console.log(failures === 0 ? '\nepub builder scenarios OK' : '\n' + failures + ' scenario failure(s)');
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
