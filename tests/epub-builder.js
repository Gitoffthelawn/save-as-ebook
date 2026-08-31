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
    const state = {title: 'Scenario Book', uuid: null, css: '', metadata: null, pages: [],
                   downloads: [], messages: [], alerts: []};
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
                    if (message.type === 'get book css') response = {css: state.css};
                    if (message.type === 'get book metadata') response = {metadata: state.metadata};
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
    for (const file of ['libs/jszip.js', 'utils.js', 'cssSanitizer.js', 'saveEbook.js']) {
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
    state.css = options.css || '';
    state.metadata = options.metadata || null;
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
        // 'chapters' is the build that reads the book back out of storage;
        // 'one-shot' is a saved page, which passes no book metadata at all. The
        // default is the editor's call: the chapters in hand, plus what the page
        // knows about the book.
        if (options.path === 'chapters') sandbox.buildEbookFromStorage();
        else if (options.path === 'one-shot') sandbox.buildEbook(pages);
        else sandbox.buildEbook(pages, {title: state.title, uuid: state.uuid, css: state.css,
                                        metadata: state.metadata});
    });
}

// Which file each chapter was written to, in spine order. The builder names
// those files itself rather than using the name on the chapter record - see
// chapterFileName() - so a scenario that wants the second chapter's markup asks
// the package where the second chapter is instead of guessing at a file name.
function manifestPaths(opf, idPrefix) {
    const pattern = new RegExp('<item id="' + idPrefix + '(\\d+)"[^>]*href="([^"]+)"', 'g');
    return [...opf.matchAll(pattern)]
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((match) => 'OEBPS/' + match[2]);
}

async function inspect(env, result) {
    const zip = await env.sandbox.JSZip.loadAsync(result.raw);
    const read = async (name) => zip.file(name).async('string');
    const opf = await read('OEBPS/content.opf');
    const pages = manifestPaths(opf, 'ebook');
    const styles = manifestPaths(opf, 'style');
    return {
        zip,
        names: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
        opf,
        nav: await read('OEBPS/toc.xhtml'),
        ncx: await read('OEBPS/toc.ncx'),
        pages,
        styles,
        page: (index) => read(pages[index]),
        style: (index) => read(styles[index]),
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
            empty.sandbox.buildEbook(value, {title: 'Scenario Book'});
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

    // Chapter files used to be named by whatever the chapter record carried: a
    // slug of the title, keeping only [a-z0-9_], plus four random digits. A
    // title in a non-Latin script slugged away to nothing, so the name was the
    // four digits alone, and two chapters drawing the same digits - or two
    // chapters with the same title - were written to one file. JSZip's file()
    // overwrites, so the first chapter's content left the book without a word
    // being said about it, and the manifest declared the survivor twice.
    await scenario('chapters with non-Latin, repeated, or colliding stored names get separate files', async () => {
        const env = makeSandbox();
        const pages = [
            chapter({title: 'Русская глава', url: '_9753.xhtml', styleFileName: 'style9753.css',
                     content: '<p>first</p>'}),
            chapter({title: '中文章节', url: '_9753.xhtml', styleFileName: 'style9753.css',
                     content: '<p>second</p>'}),
            // the same page added to the book twice: one title, one stored name,
            // and no slug rule that could tell the two records apart
            chapter({title: 'Repeated', url: 'repeated4616.xhtml', content: '<p>third</p>'}),
            chapter({title: 'Repeated', url: 'repeated4616.xhtml', content: '<p>fourth</p>'})
        ];
        const epub = await inspect(env, await build(env, pages));

        equal(epub.pages.length, 4, 'every chapter should be declared in the manifest');
        equal(new Set(epub.pages).size, 4, 'no two chapters may be written to one file');
        equal(new Set(epub.styles).size, 4, 'no two chapters may share a stylesheet');
        for (const name of epub.pages.concat(epub.styles)) {
            ok(epub.names.includes(name), name + ' is in the manifest and not in the archive');
        }
        equal((epub.opf.match(/<itemref /g) || []).length, 4, 'every chapter should reach the spine');

        // the content is the point: a name collision was never a naming problem
        const bodies = await Promise.all(epub.pages.map((name, index) => epub.page(index)));
        ['first', 'second', 'third', 'fourth'].forEach((text, index) => {
            ok(bodies[index].includes('<p>' + text + '</p>'),
               'chapter ' + index + ' should hold its own content');
        });
        // the landmarks nav names the first chapter too, so this is the table of
        // contents alone: four chapters, four entries, no chapter listed twice
        const toc = (epub.nav.match(/<nav id="toc"[\s\S]*?<\/nav>/) || [''])[0];
        epub.pages.forEach((name) => {
            const href = name.replace('OEBPS/', '');
            equal((toc.match(new RegExp('href="' + href + '"', 'g')) || []).length, 1,
                  'the table of contents should point at ' + href + ' exactly once');
        });
    });

    // The four-chapter case above mixes scripts; this is the book the finding
    // actually described. Every title is in a script the slug keeps nothing of,
    // so every name is its index and nothing else - which is the one arrangement
    // where the index has to carry the whole burden of being unique, and the one
    // where a chapter list long enough to reach two digits can put 'ch1' and
    // 'ch11' in the same folder. Twelve chapters is past that boundary; a
    // fifty-chapter book of same-script titles was the finding's own example of
    // where the old four random digits collided about one time in nine.
    await scenario('a whole book of titles with no ascii in them still names every chapter apart', async () => {
        const env = makeSandbox();
        const titles = ['Русская глава', '中文章节', '日本語の章', '한국어 章',
                        'Ελληνικό κεφάλαιο', 'فصل عربي', 'פרק עברי', 'Глава вторая',
                        '中文章节二', 'हिन्दी अध्याय', 'ไทยบท', 'Українська глава'];
        const pages = titles.map((title, index) => chapter({
            title: title,
            // one stored name for the whole book: the slug rule kept nothing of
            // any of these titles, so the old name was the four random digits
            // alone and every chapter here drew the same four
            url: '_9753.xhtml',
            styleFileName: 'style9753.css',
            sourceUrl: 'https://example.test/p' + index,
            content: '<p>body ' + index + '</p>'
        }));
        const epub = await inspect(env, await build(env, pages));

        equal(epub.pages.length, titles.length, 'every chapter should be declared in the manifest');
        equal(new Set(epub.pages).size, titles.length, 'no two chapters may be written to one file');
        equal(new Set(epub.styles).size, titles.length, 'no two chapters may share a stylesheet');
        // the names are the indices, so this is also the assertion that a
        // one-digit index is not a prefix of a two-digit one
        equal(epub.pages[1], 'OEBPS/pages/ch1.xhtml', 'a title with no ascii should name a file by index alone');
        equal(epub.pages[11], 'OEBPS/pages/ch11.xhtml', 'the twelfth chapter must not land on the second');

        // and the content, because a collision was never a naming problem: it
        // was chapters leaving the book without a word being said about it
        const bodies = await Promise.all(epub.pages.map((name, index) => epub.page(index)));
        titles.forEach((title, index) => {
            ok(bodies[index].includes('<p>body ' + index + '</p>'),
               'chapter ' + index + ' should hold its own content');
            ok(bodies[index].includes(title),
               'chapter ' + index + ' should be titled ' + title);
        });
    });

    // A blank title used to be filtered out with the malformed records, so a
    // chapter whose title was cleared in the editor - to retype it, or by a
    // stray select-all - was dropped from the archive with the row still sitting
    // in the list and nothing said about it. The label was missing; the chapter
    // was not.
    await scenario('a chapter with no title keeps its content and is named in the navigation', async () => {
        const env = makeSandbox();
        const pages = [
            chapter({title: 'Named', content: '<p>first</p>'}),
            chapter({title: '   ', content: '<p>second</p>'}),
            chapter({title: undefined, content: '<p>third</p>'})
        ];
        const epub = await inspect(env, await build(env, pages));

        equal(epub.pages.length, 3, 'a blank title must not cost the chapter');
        equal((epub.opf.match(/<itemref /g) || []).length, 3, 'every chapter should reach the spine');
        const bodies = await Promise.all(epub.pages.map((name, index) => epub.page(index)));
        ['first', 'second', 'third'].forEach((text, index) => {
            ok(bodies[index].includes('<p>' + text + '</p>'),
               'chapter ' + index + ' should hold its own content');
        });

        // a reader has to have something to click on, so the fallback is a name
        // and not an empty entry
        ok(epub.nav.includes('>Untitled chapter 2<'),
           'the untitled chapter should be listed under a fallback name: ' + epub.nav);
        ok(epub.nav.includes('>Untitled chapter 3<'),
           'a chapter with no title field at all should be listed too: ' + epub.nav);
        ok(bodies[1].includes('<title>Untitled chapter 2</title>'),
           'the chapter document should carry the fallback title too');
        equal(epub.pages[1], 'OEBPS/pages/ch1.xhtml',
              'a fallback title should not be slugged into the file name');
    });

    await scenario('chapter file names are derived from the book, and the same book builds the same names', async () => {
        const pages = [
            chapter({title: 'Café Society — Part 1'}),
            chapter({title: 'Ω'}),
            chapter({title: 'A title long enough that nobody would want the whole of it in a path'})
        ];
        let env = makeSandbox();
        const first = await inspect(env, await build(env, pages));
        env = makeSandbox();
        const second = await inspect(env, await build(env, pages));

        equal(first.pages.join('|'), second.pages.join('|'),
              'the same chapters should build to the same file names');
        equal(first.pages[0], 'OEBPS/pages/ch0-cafe_society_part_1.xhtml',
              'an accent should fold onto the letter it is drawn over');
        equal(first.pages[1], 'OEBPS/pages/ch1.xhtml',
              'a title with no ascii in it should still name a file of its own');
        ok(first.pages[2].length <= 'OEBPS/pages/ch2-'.length + 40 + '.xhtml'.length,
           'a long title should be cut down rather than written out: ' + first.pages[2]);
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
        const content = await epub.page(0);
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
        const content = await epub.page(0);
        ok(content.includes('kept.jpg'), 'supported image was removed');
        ok(!/(unsupported\.bmp|missing\.png|no-data\.png)/.test(content), 'dangling image reference survived');
        equal(epub.names.filter((name) => name === 'OEBPS/images/kept.jpg').length, 1,
              'duplicate supported image should be stored once');
        ok(!/(unsupported\.bmp|missing\.png|no-data\.png)/.test(epub.opf), 'invalid image reached the manifest');
    });

    // EPUBCheck warns about an empty directory (PKG-014), and a text-only book
    // is the common save: every reader-mode article without pictures, and every
    // plain save of a page that has none.
    await scenario('a book with no images carries no images directory at all', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter({content: '<p>Only text</p>'})]));
        const entries = Object.keys(epub.zip.files);
        ok(!entries.some((name) => name.startsWith('OEBPS/images')),
           'a text-only book should not contain OEBPS/images/: ' + entries.join(', '));
        ok(entries.includes('OEBPS/pages/') || entries.some((name) => name.startsWith('OEBPS/pages/')),
           'the chapter itself should still be written');
    });

    // Same requirement one step later: the images were there in storage, and
    // every one of them was dropped for having no resolvable media type, so
    // nothing is written and the directory must not appear either.
    await scenario('a book whose only images were dropped carries no images directory', async () => {
        const env = makeSandbox();
        const page = chapter({
            images: [{filename: 'unsupported.bmp', data: IMAGE_BYTES},
                     {filename: 'untyped.TODO-EXTRACT', data: IMAGE_BYTES}],
            content: '<img src="../images/unsupported.bmp" alt="bad" />' +
                     '<img src="../images/untyped.TODO-EXTRACT" alt="worse" />'
        });
        const epub = await inspect(env, await build(env, [page]));
        ok(!Object.keys(epub.zip.files).some((name) => name.startsWith('OEBPS/images')),
           'dropping every image should drop the directory with them');
    });

    await scenario('a book with an image still gets the images directory', async () => {
        const env = makeSandbox();
        const page = chapter({
            images: [{filename: 'photo.png', data: IMAGE_BYTES}],
            content: '<img src="../images/photo.png" alt="photo" />'
        });
        const epub = await inspect(env, await build(env, [page]));
        ok(epub.names.includes('OEBPS/images/photo.png'), 'the image should be written');
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
        const content = await (await inspect(env, await build(env, [page]))).page(0);
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
        ok((await epub.page(0)).includes(' dir="rtl"'),
           'the right to left chapter should state its direction');
        // direction is only ever recorded when it is rtl, so taking the book's
        // for a chapter that recorded nothing would reverse this one
        ok(!(await epub.page(1)).includes(' dir='),
           'a chapter that said nothing about direction must not inherit the book\'s');

        env = makeSandbox();
        epub = await inspect(env, await build(env, [chapter()]));
        ok(!epub.opf.includes('page-progression-direction'),
           'a book with no right to left chapter should not state a progression direction');
        ok(!(await epub.page(0)).includes(' dir='),
           'left to right is the default and does not need saying');

        // chapters buffered before extraction read the direction at all
        env = makeSandbox();
        epub = await inspect(env, await build(env, [chapter({metadata: undefined})]));
        ok(!epub.opf.includes('page-progression-direction'),
           'a chapter with no metadata at all should build as left to right');
    });

    await scenario('the book stylesheet is written, linked, and cascades under the chapter\'s own', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter({
            styleFileContent: '.captured{color:#111}',
            customCss: 'p{text-align:justify}'
        })], {css: 'body{font-family:serif}'}));

        equal(await epub.read('OEBPS/' + 'ebook.css'), 'body{font-family:serif}',
              'the book css should be written into ebook.css');

        const page = await epub.page(0);
        ok(page.includes('<link href="../ebook.css" rel="stylesheet" type="text/css" />'),
           'every chapter should link the book stylesheet');
        // order is the cascade: the chapter's own is the more specific answer
        ok(page.indexOf('../ebook.css') < page.indexOf('../' + epub.styles[0].replace('OEBPS/', '')),
           'the book stylesheet should be linked before the chapter\'s own');
        ok(epub.nav.includes('<link href="ebook.css"'),
           'the table of contents should link it too, from the root it sits in');

        equal(await epub.style(0),
              '.captured{color:#111}\np{text-align:justify}',
              'a chapter\'s own css should be appended to what extraction captured');
    });

    await scenario('a book nobody styled is byte for byte what it was before there was a box to style it in', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter()]));
        equal(await epub.read('OEBPS/ebook.css'), '',
              'no book css means an empty ebook.css, as it always was');
        equal(await epub.style(0), '',
              'no chapter css means the captured stylesheet unchanged');
    });

    await scenario('a stylesheet cannot reach outside the archive', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter({
            // captured css reaches this too: 'list-style' serializes an absolute
            // url whenever the source page gave its bullets a picture
            styleFileContent: 'ul{list-style:outside none url("https://cdn.test/bullet.png")}',
            images: [{filename: 'local.png', data: IMAGE_BYTES}],
            customCss: [
                '@import url("https://fonts.test/face.css");',
                "@import 'local.css';",
                '.remote{background-image:url(https://cdn.test/bg.png)}',
                '.schemeless{background-image:url(//cdn.test/bg.png)}',
                '.local{background-image:url("../images/local.png")}',
                '.inline{background-image:url(data:image/gif;base64,R0lGOD)}',
                '.kept{color:red}'
            ].join('\n')
        })], {css: '@import "https://cdn.test/book.css";\nbody{background-image:url(http://cdn.test/paper.png)}'}));

        const book = await epub.read('OEBPS/ebook.css');
        ok(!book.includes('@import'), 'the book css should carry no @import');
        ok(!book.includes('cdn.test'), 'the book css should fetch nothing off the network');
        ok(book.includes('background-image:none'),
           'a removed url should leave a value the property accepts: ' + book);

        const style = await epub.style(0);
        ok(!style.includes('@import'), 'no @import survives, quoted or in a url()');
        ok(!style.includes('cdn.test') && !style.includes('fonts.test'),
           'nothing remote survives: ' + style);
        ok(!style.includes('local.css'),
           'a local @import names a file the archive cannot contain either');
        // EPUB requires an item referencing a remote resource to say so, and
        // this build makes no such claim about any file it writes
        ok(!epub.opf.includes('remote-resources'),
           'and so no manifest item has to claim remote resources');

        ok(style.includes('url("../images/local.png")'),
           'a reference to a picture the book really contains is kept: ' + style);
        ok(epub.names.includes('OEBPS/images/local.png'),
           'and the picture it names is a file this archive holds');
        ok(style.includes('url(data:image/gif;base64,R0lGOD)'),
           'a data url is carried in the file rather than fetched, and is kept');
        ok(style.includes('.kept{color:red}'), 'and everything else is left alone');
    });

    // A url that is not remote used to be kept on the strength of not being
    // remote, which is a different question from whether it is there. EPUBCheck
    // answers the second one with RSC-007 and takes the whole package down with
    // it, so the build has to answer it first.
    await scenario('a stylesheet url that names no file in the archive is removed', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter({
            images: [{filename: 'photo.png', data: IMAGE_BYTES}],
            content: '<p>Text <img src="../images/photo.png" alt="" /></p>',
            customCss: [
                // the audit's own reproduction: a background nobody downloaded
                '.gap{background-image:url(missing.png)}',
                // a font, which this build never writes and so never has
                '@font-face{font-family:x;src:url("fonts/x.woff2")}',
                // a path out of the archive entirely
                '.up{background-image:url("../../outside.png")}',
                // an image record that exists, named the way the editor's box
                // invites: from the chapter, which is not where the file lands
                '.repaired{background-image:url(images/photo.png)}',
                // and one already written the way the archive reads
                '.right{background-image:url(../images/photo.png)}',
                // a fragment is a reference into this document, not to a file
                '.filtered{filter:url(#blur)}'
            ].join('\n')
        })], {css: 'body{background-image:url(images/photo.png)}\n' +
                   'p{background-image:url(nothing-here.png)}'}));

        const style = await epub.style(0);
        ok(!/missing\.png|x\.woff2|outside\.png/.test(style),
           'a reference to a file the archive does not contain survived: ' + style);
        ok((style.match(/background-image:none/g) || []).length === 2,
           'and each one leaves a value the property accepts: ' + style);
        ok(style.includes('.repaired{background-image:url("../images/photo.png")}'),
           'a real picture named from the wrong folder should be repaired, not dropped: ' + style);
        ok(style.includes('.right{background-image:url(../images/photo.png)}'),
           'and one already correct should be left exactly as written: ' + style);
        ok(style.includes('url(#blur)'),
           'a fragment names no file and is not this rule\'s business: ' + style);

        // Same rule, different depth: ebook.css sits beside images/, so the
        // prefix that is right for a chapter stylesheet is wrong here.
        const book = await epub.read('OEBPS/ebook.css');
        ok(book.includes('body{background-image:url(images/photo.png)}'),
           'the book stylesheet reaches images/ without going up a folder: ' + book);
        ok(!book.includes('nothing-here.png') && book.includes('p{background-image:none}'),
           'and it is held to the same archive as the chapters: ' + book);
    });

    // The other direction: what a stylesheet may name is what the archive holds,
    // which is every chapter's images and not only the chapter it belongs to -
    // OEBPS/images/ is one namespace for the whole book.
    await scenario('a stylesheet may name a picture that arrived with another chapter', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [
            chapter({url: 'one.xhtml', title: 'One',
                     images: [{filename: 'shared.png', data: IMAGE_BYTES}],
                     content: '<p>One <img src="../images/shared.png" alt="" /></p>'}),
            chapter({url: 'two.xhtml', title: 'Two',
                     customCss: '.b{background-image:url(../images/shared.png)}'})
        ]));
        ok((await epub.style(1)).includes('url(../images/shared.png)'),
           'the second chapter may style itself with the first chapter\'s picture');
    });

    // ---- what the user said about the book ------------------------------------
    //
    // The whole of this feature is a precedence rule - what a user typed, else
    // what the page stated, else what the build always did - so what is checked
    // is the order, in the package document, which is the only place it shows.

    await scenario('what the user stated about the book wins over what the chapters said', async () => {
        const env = makeSandbox();
        const pages = [
            chapter({url: 'one.xhtml',
                     metadata: {lang: 'fr', authors: ['Scraped Byline'], publisher: 'Scraped Press',
                                description: 'scraped blurb', date: '2020-01-01'}}),
            chapter({title: 'Two', url: 'two.xhtml', styleFileName: 'two.css',
                     metadata: {lang: 'fr', authors: ['Another Byline'], publisher: 'Other Press',
                                description: '', date: '2021-02-02'}})
        ];
        const epub = await inspect(env, await build(env, pages, {metadata: {
            lang: 'pt-BR',
            authors: ['Ada Lovelace', 'Grace Hopper'],
            publisher: 'The Publisher',
            description: 'A book about several things.',
            date: '2024-06-01'
        }}));

        ok(epub.opf.includes('<dc:language>pt-BR</dc:language>'), 'the stated language should be the book\'s');
        ok(epub.opf.includes('<dc:publisher>The Publisher</dc:publisher>'), 'the stated publisher is missing');
        ok(!epub.opf.includes('Scraped Press') && !epub.opf.includes('Other Press'),
           'a stated publisher replaces the scraped ones rather than joining them');
        ok(epub.opf.includes('>Ada Lovelace</dc:creator>') && epub.opf.includes('>Grace Hopper</dc:creator>'),
           'the stated authors are missing');
        ok(!epub.opf.includes('Byline'), 'stated authors replace the scraped ones');
        ok(epub.opf.includes('<dc:date>2024-06-01</dc:date>'),
           'a compilation may be given the date its author says it has');
        ok(epub.opf.includes('<dc:description>A book about several things.</dc:description>'),
           'a compilation may be given a description, which it can never derive');

        // the chapters keep their own - a book-level answer is about the book
        ok((await epub.page(0)).includes('xml:lang="fr"'),
           'a stated book language must not restate every chapter');
        equal((epub.opf.match(/property="dcterms:created"/g) || []).length, 2,
              'each chapter still carries its own date');
    });

    await scenario('a field nobody filled in falls back to the chapters, field by field', async () => {
        const env = makeSandbox();
        const page = chapter({
            metadata: {lang: 'de', authors: ['Scraped Byline'], publisher: 'Scraped Press',
                       description: 'scraped blurb', date: '2020-01-01'}
        });
        // only the publisher is stated, and everything beside it is untouched
        const epub = await inspect(env, await build(env, [page],
            {metadata: {lang: '', authors: [], publisher: 'The Publisher', description: '', date: ''}}));
        ok(epub.opf.includes('<dc:publisher>The Publisher</dc:publisher>'), 'the stated publisher is missing');
        ok(epub.opf.includes('<dc:language>de</dc:language>'), 'an empty language must not override');
        ok(epub.opf.includes('>Scraped Byline</dc:creator>'), 'an empty author list must not override');
        ok(epub.opf.includes('<dc:date>2020-01-01</dc:date>'), 'an empty date must not override');
        ok(epub.opf.includes('<dc:description>scraped blurb</dc:description>'),
           'an empty description must not override');
    });

    await scenario('a stated language or date that is not one is dropped rather than written', async () => {
        const env = makeSandbox();
        const page = chapter({metadata: {lang: 'de', authors: [], publisher: '', description: '',
                                         date: '2020-01-01'}});
        const epub = await inspect(env, await build(env, [page],
            {metadata: {lang: '{{locale}}', date: 'sometime last spring'}}));
        ok(epub.opf.includes('<dc:language>de</dc:language>'),
           'junk in the language box must not reach dc:language');
        ok(epub.opf.includes('<dc:date>2020-01-01</dc:date>'),
           'junk in the date box must not reach dc:date');

        // a year outside any range a saved web page can plausibly have parses
        // fine and means nothing - the same rule that filtered the pages' dates
        const ancient = makeSandbox();
        ok((await inspect(ancient, await build(ancient, [page], {metadata: {date: '1008'}})))
               .opf.includes('<dc:date>2020-01-01</dc:date>'),
           'an implausible year is dropped here as it is at extraction');

        // and a date that is a date, in a spelling dc:date does not use
        const other = makeSandbox();
        const rewritten = await inspect(other, await build(other, [chapter()],
            {metadata: {date: 'Fri, 01 Mar 2024 09:00:00 GMT'}}));
        ok(rewritten.opf.includes('<dc:date>2024-03-01T09:00:00Z</dc:date>'),
           'a date a user can write should be written the way dc:date wants it');
    });

    await scenario('what the user stated about one chapter is what that chapter says', async () => {
        const env = makeSandbox();
        const pages = [
            chapter({url: 'one.xhtml',
                     metadata: {lang: 'en', authors: ['Scraped Byline'], publisher: 'Scraped Press',
                                description: '', date: '2020-01-01'},
                     metadataOverride: {lang: 'ja', authors: ['Murasaki Shikibu'],
                                        publisher: 'Heian Press', description: '', date: '1925'}}),
            chapter({title: 'Two', url: 'two.xhtml', styleFileName: 'two.css'})
        ];
        const epub = await inspect(env, await build(env, pages));

        ok((await epub.page(0)).includes('xml:lang="ja"'),
           'the chapter should be written in the language stated for it');
        ok(!(await epub.page(1)).includes('xml:lang="ja"'),
           'and the chapter beside it should not be');
        ok(epub.opf.includes('<dc:language>ja</dc:language>'),
           'the first chapter to state a language names the book\'s, override or not');
        // a chapter's people are the book's people
        ok(epub.opf.includes('>Murasaki Shikibu</dc:creator>') && !epub.opf.includes('Scraped Byline'),
           'a stated chapter author replaces the scraped one everywhere it is used');
        ok(epub.opf.includes('<dc:publisher>Heian Press</dc:publisher>') &&
           !epub.opf.includes('Scraped Press'), 'and so does a stated chapter publisher');
        ok(epub.opf.includes('<meta refines="#ebook0" property="dcterms:created">1925</meta>'),
           'the chapter should carry the date stated for it');
    });

    await scenario('the book has the last word over the chapter that disagrees with it', async () => {
        const env = makeSandbox();
        const page = chapter({
            metadata: {lang: 'en', authors: [], publisher: '', description: '', date: ''},
            metadataOverride: {publisher: 'Chapter Press', authors: ['Chapter Author']}
        });
        const epub = await inspect(env, await build(env, [page],
            {metadata: {publisher: 'Book Press'}}));
        ok(epub.opf.includes('<dc:publisher>Book Press</dc:publisher>') &&
           !epub.opf.includes('Chapter Press'),
           'dc:publisher is a claim about the book, so the book\'s answer is the one written');
        ok(epub.opf.includes('>Chapter Author</dc:creator>'),
           'a field the book left empty is still gathered from the chapters');
    });

    await scenario('metadata read back out of storage reaches the same package', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter()], {
            path: 'chapters',
            metadata: {publisher: 'Stored Press', lang: 'nl'}
        }));
        ok(epub.opf.includes('<dc:publisher>Stored Press</dc:publisher>'),
           'the editor\'s build reads what it stored, and so must the one that has no chapters in hand');
        ok(epub.opf.includes('<dc:language>nl</dc:language>'), 'the stored language is missing');
    });

    await scenario('a book nobody described is byte for byte what it was before there were boxes to describe it in', async () => {
        const env = makeSandbox();
        const page = chapter({
            metadata: {lang: 'en', authors: ['Jane Smith'], publisher: 'Example Press',
                       description: 'A blurb', date: '2024-05-06'}
        });
        // every shape of "nothing was stated" the editor and storage can produce
        for (const metadata of [undefined, null, {}, {lang: '', authors: [], publisher: '',
                                                      description: '', date: ''}]) {
            const epub = await inspect(env, await build(env, [page], {metadata}));
            ok(epub.opf.includes('<dc:language>en</dc:language>') &&
               epub.opf.includes('>Jane Smith</dc:creator>') &&
               epub.opf.includes('<dc:publisher>Example Press</dc:publisher>') &&
               epub.opf.includes('<dc:description>A blurb</dc:description>') &&
               epub.opf.includes('<dc:date>2024-05-06</dc:date>'),
               'a book with no override should be exactly what the chapters make it: ' +
               JSON.stringify(metadata));
        }
    });

    await scenario('stated metadata is XML escaped like everything else in the package', async () => {
        const env = makeSandbox();
        const epub = await inspect(env, await build(env, [chapter()], {metadata: {
            authors: ['A & B <Authors>'],
            publisher: 'P & P <Press>',
            description: 'D & D "quoted"'
        }}));
        ok(epub.opf.includes('A &amp; B &lt;Authors&gt;'), 'stated author was not escaped');
        ok(epub.opf.includes('P &amp; P &lt;Press&gt;'), 'stated publisher was not escaped');
        ok(epub.opf.includes('D &amp; D &quot;quoted&quot;'), 'stated description was not escaped');
    });

    // The boxes in the editor show these as their placeholders. They have to be
    // what the build would write, or the panel describes a different book.
    await scenario('the values the editor shows as fallbacks are the values the build derives', async () => {
        const {sandbox} = makeSandbox();
        const one = chapter({
            metadata: {lang: 'fr', authors: ['Jane Smith'], publisher: 'Example Press',
                       description: 'A blurb', date: '2024-05-06'}
        });
        let derived = sandbox.deriveBookMetadata([one]);
        equal(derived.lang, 'fr', 'derived language');
        equal(derived.authors.join('|'), 'Jane Smith', 'derived authors');
        equal(derived.publisher.join('|'), 'Example Press', 'derived publisher');
        equal(derived.description, 'A blurb', 'a one-chapter book is described by its chapter');
        equal(derived.date, '2024-05-06', 'and dated by it');

        const two = chapter({title: 'Two', url: 'two.xhtml',
                             metadata: {lang: 'de', authors: ['Alan Turing'], publisher: 'Other Press',
                                        description: 'Not the book', date: '2025-01-01'}});
        derived = sandbox.deriveBookMetadata([one, two]);
        equal(derived.authors.join('|'), 'Jane Smith|Alan Turing', 'a compilation gathers its authors');
        equal(derived.publisher.join('|'), 'Example Press|Other Press', 'and its publishers');
        equal(derived.description, '', 'but borrows neither a description');
        equal(derived.date, '', 'nor a date');
        equal(sandbox.deriveBookMetadata([]).lang, 'en', 'and a book with no chapters still has a language');

        // a chapter override is part of what the chapter says, here as everywhere
        equal(sandbox.deriveBookMetadata([Object.assign({}, one,
                  {metadataOverride: {authors: ['Ada Lovelace']}})]).authors.join('|'),
              'Ada Lovelace', 'the boxes account for what was stated about a chapter');
    });

    console.log(failures === 0 ? '\nepub builder scenarios OK' : '\n' + failures + ' scenario failure(s)');
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
