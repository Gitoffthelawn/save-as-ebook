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

    // dc:identifier must be a real identifier and must be the same value the ncx
    // claims, otherwise a reader that trusts the ncx sees a different book
    const uniqueId = (opf.match(/unique-identifier="([^"]+)"/) || [])[1];
    const identifier = (opf.match(new RegExp('<dc:identifier[^>]*id="' + uniqueId + '"[^>]*>([^<]*)<')) || [])[1];
    check('dc:identifier is a urn:uuid',
          /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identifier || ''),
          identifier);

    const ncxName = names.find((n) => n.endsWith('.ncx'));
    if (ncxName) {
        const ncx = await zip.file(ncxName).async('string');
        const dtbUid = (ncx.match(/name="dtb:uid"\s+content="([^"]*)"/) || [])[1];
        check('ncx dtb:uid matches dc:identifier', dtbUid === identifier,
              'ncx=' + dtbUid + ' opf=' + identifier);
    }

    // dc:source is the only record of where a chapter came from; nothing else in
    // the package keeps the original address
    const sources = [...opf.matchAll(/<dc:source>([^<]*)<\/dc:source>/g)].map((m) => m[1]);
    check('every chapter contributes a dc:source', sources.length > 0, sources.join(', '));

    // dc:language is read from the page, so a page with lang="javascript" must
    // not be able to put that in the package document. The grammar is spelled
    // out here rather than borrowed from utils.js: this file is the independent
    // reader of the built book, and a check that reuses the code that wrote the
    // value can only ever agree with it. Subtags are positional - "en-1" is
    // alphanumeric and still not a tag, which is what epubcheck says with
    // OPF-092.
    const LANGTAG = new RegExp(
        '^[a-z]{2,3}' +                          // language
        '(-[a-z]{3}){0,3}' +                     // extlang
        '(-[a-z]{4})?' +                         // script
        '(-([a-z]{2}|[0-9]{3}))?' +              // region
        '(-([a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*' + // variant
        '(-[a-wy-z0-9](-[a-z0-9]{2,8})+)*' +     // extension
        '(-x(-[a-z0-9]{1,8})+)?$',               // private use
        'i');
    const language = (opf.match(/<dc:language>([^<]*)<\/dc:language>/) || [])[1];
    check('dc:language is a well-formed language tag',
          LANGTAG.test(language || ''), language);

    // an empty element is how a metadata field that was scraped as '' reaches
    // the file - readers show it as a blank author or publisher
    const empty = [...opf.matchAll(/<(dc:[a-z]+)[^>]*>\s*<\/\1>/g)].map((m) => m[1]);
    check('no empty metadata elements', empty.length === 0, empty.join(', '));

    // a creator with no role is an unspecified contributor as far as a reader is
    // concerned, which is what this metadata exists to avoid
    const creatorIds = [...opf.matchAll(/<dc:creator[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    const roleless = creatorIds.filter((id) =>
        !new RegExp('refines="#' + id + '"\\s+property="role"').test(opf));
    check('every dc:creator has a role', roleless.length === 0, roleless.join(', '));

    // dc:date and dcterms:created must be W3C-DTF or a reader shows no date
    const dates = [...opf.matchAll(/<dc:date>([^<]*)<\/dc:date>/g)].map((m) => m[1])
        .concat([...opf.matchAll(/property="dcterms:(?:created|modified)">([^<]*)</g)].map((m) => m[1]));
    // The shape and then the fields, because a shape test alone passes
    // "2024-02-31" and "2024-01-01T29:70Z" - both of which epubcheck reports on
    // dc:date as OPF-053.
    const badDates = dates.filter((d) => {
        if (!/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.test(d)) {
            return true;
        }
        // Not new Date(): it rolls a day over rather than rejecting it, so
        // "2024-02-31" parses as March 2nd and the bug this is here to catch
        // reads as a pass.
        const [, year, month, day, hour, minute, second] =
            /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?)?)?/.exec(d);
        const leap = (+year % 4 === 0 && +year % 100 !== 0) || +year % 400 === 0;
        const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (month !== undefined && (+month < 1 || +month > 12)) return true;
        if (day !== undefined && (+day < 1 || +day > lengths[+month - 1])) return true;
        return hour !== undefined &&
               (+hour > 23 || +minute > 59 || (second !== undefined && +second > 59));
    });
    check('every date is a real moment in W3C-DTF', badDates.length === 0,
          badDates.join(', '));

    // every manifest item must have a file behind it, and a unique id
    const items = [...opf.matchAll(/<item\s+([^>]*)\/>/g)].map((m) => ({
        attrs: m[1],
        id: (m[1].match(/id="([^"]+)"/) || [])[1],
        href: (m[1].match(/href="([^"]+)"/) || [])[1],
        mediaType: (m[1].match(/media-type="([^"]+)"/) || [])[1]
    }));
    check('manifest is not empty', items.length > 0, items.length + ' items');

    const missing = items.filter((i) => names.indexOf(path.posix.join(opfDir, i.href)) < 0);
    check('every manifest href exists in the archive', missing.length === 0,
          missing.map((i) => i.href).join(', '));

    const ids = items.map((i) => i.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    check('manifest ids are unique', dupes.length === 0, dupes.join(', '));

    // Two items naming one file is what a chapter overwritten by the chapter
    // after it looks like from outside: the archive holds the later one, the
    // package claims both, and the reader is told about a chapter that is not
    // in the book. epubcheck reports it as OPF-074.
    const hrefs = items.map((i) => i.href);
    const sharedHrefs = hrefs.filter((href, i) => hrefs.indexOf(href) !== i);
    check('no two manifest items name the same file', sharedHrefs.length === 0,
          sharedHrefs.join(', '));

    // An item whose type could not be worked out used to be declared anyway, as
    // media-type="image/" - one unrecognized picture invalidating the whole
    // package. Whatever cannot be typed has to be left out entirely instead.
    const untyped = items.filter((i) => !/media-type="[^"]+\/[^"]+"/.test(i.attrs));
    check('every manifest item declares a real media type', untyped.length === 0,
          untyped.map((i) => i.href).join(', '));

    // A syntactically valid media type can still tell a reader to use the wrong
    // decoder. These are all of the file types the writer currently emits.
    const mediaTypes = {
        '.xhtml': 'application/xhtml+xml',
        '.css': 'text/css',
        '.ncx': 'application/x-dtbncx+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
    };
    const mistyped = items.filter((i) => {
        const expected = mediaTypes[path.posix.extname(i.href || '').toLowerCase()];
        return expected && i.mediaType !== expected;
    });
    check('manifest media types match their files', mistyped.length === 0,
          mistyped.map((i) => i.href + ' is ' + i.mediaType).join(', '));

    // webp is a core image type in epub 3.3, so it is embedded as it arrived.
    // Vacuously true for a book with no webp in it - this runs over books of
    // several shapes now, and a text-only one has no images to declare at all.
    // That a webp survives the build at all is asserted in epub-builder.js.
    const webp = items.filter((i) => /\.webp$/i.test(i.href || ''));
    check('webp images are declared image/webp',
          webp.every((i) => /media-type="image\/webp"/.test(i.attrs)),
          webp.length === 0 ? 'no webp in this book' : webp.map((i) => i.attrs).join(' | '));

    // refines targets are built from the chapter index, so a change to how
    // manifest ids are named silently detaches all of the per-chapter metadata
    const knownIds = ids.concat([...opf.matchAll(/<dc:[a-z]+[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
    const badRefines = [...opf.matchAll(/refines="#([^"]+)"/g)].map((m) => m[1])
                                                               .filter((r) => knownIds.indexOf(r) < 0);
    check('every refines target exists', badRefines.length === 0, badRefines.join(', '));

    // every spine itemref must name a manifest item
    const idrefs = [...opf.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => m[1]);
    const danglingRefs = idrefs.filter((r) => ids.indexOf(r) < 0);
    check('every spine itemref resolves', danglingRefs.length === 0, danglingRefs.join(', '));

    // the failure mode that dedupe and the TODO-EXTRACT rewrite can produce:
    // content referencing an image file that is not in the archive
    const dangling = [];
    const contentPlaceholders = [];
    const langless = [];
    const alts = {total: 0, described: 0, undescribed: 0};
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');

        for (const tag of xhtml.match(/<img\b[^>]*>/gi) || []) {
            alts.total++;
            const alt = tag.match(/\salt="([^"]*)"/);
            if (!alt) {
                alts.undescribed++;
            } else if (alt[1].length > 0) {
                alts.described++;
            }
        }


        // xml:lang is authoritative in xhtml and lang is what a reader treating
        // the file as html reads, so a document carrying only one of them, or
        // two that disagree, is ambiguous
        const htmlTag = (xhtml.match(/<html[^>]*>/) || [''])[0];
        const xmlLang = (htmlTag.match(/\sxml:lang="([^"]*)"/) || [])[1];
        const htmlLang = (htmlTag.match(/\slang="([^"]*)"/) || [])[1];
        if (!xmlLang || xmlLang !== htmlLang) {
            langless.push(name + ' (xml:lang=' + xmlLang + ' lang=' + htmlLang + ')');
        }

        for (const m of xhtml.matchAll(/<img[^>]+src="([^"]+)"/g)) {
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]));
            if (names.indexOf(resolved) < 0) {
                dangling.push(name + ' -> ' + m[1]);
            }
            if (m[1].indexOf('TODO-EXTRACT') > -1) {
                contentPlaceholders.push(name + ' -> ' + m[1]);
            }
        }
    }
    check('every <img> in the content resolves to a file in the archive',
          dangling.length === 0, dangling.join(', '));

    // The same rule for the stylesheets, which reference files too and are the
    // easier place to forget it: a url() naming something the archive does not
    // hold is RSC-007, and one background image fails the whole package. The two
    // depths are the trap - OEBPS/ebook.css sits beside images/, OEBPS/style/*
    // is a folder below - so the check is resolution against the file doing the
    // referencing rather than a look at the text.
    //
    // Scanned here rather than parsed through cssSanitizer.js: a checker that
    // borrows the code which wrote the value can only ever agree with it.
    const danglingCss = [];
    const remoteCss = [];
    for (const name of names.filter((n) => n.endsWith('.css'))) {
        const css = await zip.file(name).async('string');
        for (const m of css.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi)) {
            const target = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim();
            // the resource carried in the file, and a reference into the
            // document using it: neither names a file in this archive
            if (target === '' || target.charAt(0) === '#' || /^data:/i.test(target)) {
                continue;
            }
            if (/^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(target)) {
                remoteCss.push(name + ' -> ' + target);
                continue;
            }
            const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(name), target));
            if (names.indexOf(resolved) < 0) {
                danglingCss.push(name + ' -> ' + target);
            }
        }
    }
    check('every url() in a stylesheet resolves to a file in the archive',
          danglingCss.length === 0, danglingCss.join(', '));
    // and no manifest item claims properties="remote-resources", so a surviving
    // one would be a package contradicting itself as well as a book that needs
    // the network to look right
    check('no stylesheet reaches off the archive',
          remoteCss.length === 0, remoteCss.join(', '));

    check('every content document declares a matching xml:lang and lang',
          langless.length === 0, langless.join(', '));

    // ---- structure and navigation -------------------------------------------
    //
    // The nav document, the ncx and the chapter files each state where things
    // are, and a reader believes whichever one it reads. So the checks here are
    // about agreement: the two navs against each other, and both of them against
    // the ids that actually exist in the chapters.

    const navItem = (opf.match(/<item\s+[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*\/>/) || [])[0] || '';
    const navHref = (navItem.match(/href="([^"]+)"/) || [])[1];
    check('the manifest declares a nav document', !!navHref, navItem);

    const navName = path.posix.join(opfDir, navHref || '');
    const navDoc = navHref ? await zip.file(navName).async('string') : '';
    const navDir = path.posix.dirname(navName);

    const navTitle = (navDoc.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    check('the nav document has a real title',
          navTitle.trim().length > 0 && !/\.x?html$/i.test(navTitle.trim()), navTitle);

    // epub:type is what a reading system reads; the DPUB-ARIA role is what a
    // screen reader announces. Neither substitutes for the other.
    check('the toc nav carries epub:type and its DPUB-ARIA role',
          /<nav[^>]*epub:type="toc"[^>]*>/.test(navDoc) &&
          /<nav[^>]*epub:type="toc"[^>]*role="doc-toc"[^>]*>/.test(navDoc));

    const navSections = navDoc.split('</nav>');
    const tocSection = navSections.find((s) => /<nav[^>]*epub:type="toc"/.test(s)) || '';
    const landmarksSection = navSections.find((s) => /<nav[^>]*epub:type="landmarks"/.test(s)) || '';

    check('the nav document declares landmarks', !!landmarksSection);
    // a landmark without an epub:type names a location without saying what it is
    const landmarkLinks = [...landmarksSection.matchAll(/<a\s+([^>]*)>/g)].map((m) => m[1]);
    check('every landmark says what it points at',
          landmarkLinks.length > 0 && landmarkLinks.every((a) => /epub:type="[^"]+"/.test(a)),
          landmarkLinks.join(' | '));
    check('the landmarks name where the body of the book starts',
          /epub:type="bodymatter"/.test(landmarksSection));

    // A landmark may only point into the spine - the nav document itself is the
    // tempting and invalid target (EPUBCheck RSC-011)
    const spineHrefs = idrefs.map((id) => (items.find((i) => i.id === id) || {}).href);
    const offSpine = [...landmarksSection.matchAll(/<a\s+[^>]*href="([^"#]+)/g)]
        .map((m) => m[1]).filter((href) => spineHrefs.indexOf(href) < 0);
    check('every landmark points at a spine item', offSpine.length === 0, offSpine.join(', '));

    // Ordered, because the nav and the ncx have to agree on the order too - it
    // is the order a reader steps through the book in.
    const navEntries = [...tocSection.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => ({href: m[1], label: m[2].trim()}));
    check('the nav lists every chapter', navEntries.length >= idrefs.length,
          navEntries.length + ' entries for ' + idrefs.length + ' spine items');

    // The point of the nested list: a flat one entry per chapter is what this
    // replaced, and it is indistinguishable from a broken outline without this.
    const navDepth = (() => {
        let depth = 0, deepest = 0;
        for (const tag of tocSection.match(/<\/?ol\b[^>]*>/g) || []) {
            depth += tag.startsWith('</') ? -1 : 1;
            deepest = Math.max(deepest, depth);
        }
        return deepest;
    })();
    check('the nav nests, rather than listing one flat entry per chapter',
          navDepth > 1, 'deepest <ol> nesting: ' + navDepth);

    const ncxFile = names.find((n) => n.endsWith('.ncx'));
    const ncx = ncxFile ? await zip.file(ncxFile).async('string') : '';
    const ncxEntries = [...ncx.matchAll(
        /<navPoint[^>]*playOrder="(\d+)"[^>]*>\s*<navLabel><text>([\s\S]*?)<\/text><\/navLabel><content src="([^"]+)"/g)]
        .map((m) => ({order: parseInt(m[1], 10), label: m[2].trim(), href: m[3]}));

    // Both are generated from one tree; if they ever stop matching, a reader
    // following the ncx is reading a different book from one following the nav.
    const navKeys = navEntries.map((e) => e.href + ' :: ' + e.label);
    const ncxKeys = ncxEntries.map((e) => e.href + ' :: ' + e.label);
    const disagreements = navKeys.filter((k, i) => ncxKeys[i] !== k);
    check('the ncx and the nav document describe the same book',
          navKeys.length === ncxKeys.length && disagreements.length === 0,
          disagreements.slice(0, 3).join(' | ') || (navKeys.length + ' vs ' + ncxKeys.length));

    // playOrder is one sequence over the whole navMap, not one per nesting level
    const badOrder = ncxEntries.filter((e, i) => e.order !== i + 1);
    check('ncx playOrder is a single sequence starting at 1', badOrder.length === 0,
          ncxEntries.map((e) => e.order).join(','));

    const ncxDepth = (() => {
        let depth = 0, deepest = 0;
        for (const tag of ncx.match(/<\/?navPoint\b[^>]*>/g) || []) {
            depth += tag.startsWith('</') ? -1 : 1;
            deepest = Math.max(deepest, depth);
        }
        return deepest;
    })();
    const declaredDepth = parseInt((ncx.match(/name="dtb:depth"\s+content="(\d+)"/) || [])[1], 10);
    check('ncx dtb:depth is the depth the navMap actually reaches',
          declaredDepth === Math.max(1, ncxDepth),
          'declared ' + declaredDepth + ', actual ' + ncxDepth);

    // A nav entry pointing at an id that no longer exists is the failure this
    // whole design risks: the ids are minted while the chapter is written, and
    // the nav is written from the same pass.
    const brokenTargets = [];
    for (const entry of navEntries.concat(ncxEntries)) {
        const [file, fragment] = entry.href.split('#');
        const resolved = path.posix.normalize(path.posix.join(navDir, file));
        if (names.indexOf(resolved) < 0) {
            brokenTargets.push(entry.href + ' (no such file)');
            continue;
        }
        if (fragment) {
            const target = await zip.file(resolved).async('string');
            if (target.indexOf('id="' + fragment + '"') < 0) {
                brokenTargets.push(entry.href + ' (no such id)');
            }
        }
    }
    check('every navigation target resolves to a file and an id in it',
          brokenTargets.length === 0, brokenTargets.slice(0, 5).join(', '));

    // The same invariant, for the links the page made rather than the ones the
    // nav makes. A footnote marker arrives as a bare fragment, and its target
    // may be an element that never left extraction - outside the selection, or
    // inside something dropped whole. EPUBCheck reports an unresolved fragment
    // as an error, so those hrefs have to have been taken off before the file
    // was written; only the ones that resolve may still be there.
    const brokenLinks = [];
    let internalLinkCount = 0;
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');
        const ids = new Set([...xhtml.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
        for (const match of xhtml.matchAll(/<a\b[^>]*\shref="#([^"]*)"/g)) {
            internalLinkCount++;
            if (!ids.has(match[1])) {
                brokenLinks.push(name + ' #' + match[1]);
            }
        }
    }
    check('every link into a chapter resolves to an id in that same chapter',
          brokenLinks.length === 0,
          brokenLinks.length ? brokenLinks.slice(0, 5).join(', ')
                             : internalLinkCount + ' internal links');

    // A link from one chapter to another is written by the same pass, against the
    // ids as they finally stand, and it fails the same way: a relative href
    // naming a file the archive does not hold, or a fragment that chapter does
    // not have, is an EPUBCheck error rather than a dead link. Only relative
    // hrefs are examined - an absolute one addresses the web, which is where a
    // link to a page nobody saved belongs.
    const brokenCrossLinks = [];
    let crossLinkCount = 0;
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');
        for (const match of xhtml.matchAll(/<a\b[^>]*\shref="([^"#][^"]*)"/g)) {
            const href = match[1];
            if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf('//') === 0) {
                continue;
            }
            crossLinkCount++;
            const [file, fragment] = href.split('#');
            const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(name), file));
            if (names.indexOf(resolved) < 0) {
                brokenCrossLinks.push(name + ' -> ' + href + ' (no such file)');
                continue;
            }
            const target = await zip.file(resolved).async('string');
            if (fragment && target.indexOf('id="' + fragment + '"') < 0) {
                brokenCrossLinks.push(name + ' -> ' + href + ' (no such id)');
            }
        }
    }
    check('every link between chapters resolves to a file in the book and an id in it',
          brokenCrossLinks.length === 0,
          brokenCrossLinks.length ? brokenCrossLinks.slice(0, 5).join(', ')
                                  : crossLinkCount + ' links between chapters');

    // Which way the book reads has to be stated in both places or neither. dir on
    // a chapter is what makes its text run right to left; page-progression-direction
    // is what makes the reader turn the pages that way, and a book that says one
    // without the other reads correctly while paging backwards.
    const rtlChapters = [];
    for (const name of names.filter((n) => n.endsWith('.xhtml') && n !== navName)) {
        const xhtml = await zip.file(name).async('string');
        if (/<html[^>]*\sdir="rtl"/.test(xhtml)) {
            rtlChapters.push(name);
        }
    }
    check('page progression direction agrees with the chapters that read right to left',
          /page-progression-direction="rtl"/.test(opf) === (rtlChapters.length > 0),
          rtlChapters.length + ' rtl chapter(s)');
    // ltr is the default everywhere, so writing it would put an attribute on
    // every chapter of every book to say what was already true
    const statedLtr = [];
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');
        if (/<html[^>]*\sdir="(?!rtl)/.test(xhtml)) {
            statedLtr.push(name);
        }
    }
    check('no document states a direction other than rtl', statedLtr.length === 0,
          statedLtr.join(', '));

    // The chapter documents themselves: bodymatter is how a reading system knows
    // where the book proper starts, doc-chapter is what a screen reader
    // announces, and the title has to be in the chapter rather than only in the
    // package document - but exactly once.
    const structureless = [];
    const duplicateTitles = [];
    for (const name of names.filter((n) => n.endsWith('.xhtml') && n !== navName)) {
        const xhtml = await zip.file(name).async('string');
        if (!/<body[^>]*epub:type="bodymatter"[^>]*>/.test(xhtml) ||
            !/<section[^>]*epub:type="chapter"[^>]*role="doc-chapter"[^>]*>/.test(xhtml)) {
            structureless.push(name);
        }

        const title = ((xhtml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
        const h1s = [...xhtml.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
            .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
            .filter((text) => text === title);
        if (h1s.length > 1) {
            duplicateTitles.push(name + ' (' + h1s.length + 'x "' + title + '")');
        }
    }
    check('every chapter is a bodymatter document holding a doc-chapter section',
          structureless.length === 0, structureless.join(', '));
    check('no chapter prints its own title twice',
          duplicateTitles.length === 0, duplicateTitles.join(', '));

    // structuralNavigation is a claim that the reader can move around inside a
    // chapter, which is only true when the nav goes below chapter level
    const claimsStructural = /property="schema:accessibilityFeature">structuralNavigation</.test(opf);
    check('structuralNavigation is claimed exactly when the nav goes below chapter level',
          claimsStructural === (navDepth > 1), 'nesting ' + navDepth);

    // The accessibility metadata is a claim about the content documents, and a
    // false one is worse than none: it makes the book turn up in a search for
    // something readable without sight. So check the claim against the file
    // rather than checking that the claim was emitted.
    const claimsAltText = /property="schema:accessibilityFeature">alternativeText</.test(opf);
    const claimsTextualSufficient = /property="schema:accessModeSufficient">textual</.test(opf);
    const altDetail = alts.total + ' images, ' + alts.described + ' described, ' +
                      alts.undescribed + ' with no alt';

    check('alternativeText is claimed only when every image is accounted for',
          !claimsAltText || alts.undescribed === 0, altDetail);
    check('alternativeText is claimed when it is true',
          claimsAltText === (alts.undescribed === 0 && alts.described > 0), altDetail);
    check('"textual alone is sufficient" matches whether images are all described',
          claimsTextualSufficient === (alts.undescribed === 0), altDetail);
    // a book with pictures is not a textual-only publication
    check('visual accessMode is declared when the book has images',
          /property="schema:accessMode">visual</.test(opf) === (alts.total > 0), altDetail);

    // claimed only when nothing in the archive can animate - webp counts, an
    // animated one is as common as an animated gif and as invisible from here
    const animatable = names.filter((n) => /\.(gif|svg|webp)$/i.test(n));
    check('no-flashing is claimed only when nothing in the book can animate',
          /property="schema:accessibilityHazard">noFlashingHazard</.test(opf) === (animatable.length === 0),
          animatable.join(', '));

    // conformance covers contrast and reflow, and the chapter css is whatever
    // the source site computed - see getAccessibilityIndex()
    check('no WCAG conformance is asserted', opf.indexOf('dcterms:conformsTo') < 0);

    // ---- MathML -------------------------------------------------------------
    //
    // Two separate things have to hold. The manifest has to agree with the files
    // about which of them contain math, in both directions - EPUBCheck fails a
    // file whose math is undeclared and a declaration with no math behind it.
    // And the math itself has to be what MathML Core implements, since Core is
    // what every WebKit and Chromium reading system has.

    // everything Core removed. Each of these renders as nothing, or as its
    // content with the brackets silently gone, which is worse.
    const CORE_REMOVED = /<(mfenced|menclose|mlabeledtr|mstack|mlongdiv|msgroup|mscarries|mscarry)\b/i;

    const mathFiles = [];
    const legacyMathml = [];
    const unnamespacedMath = [];
    const leakedAnnotations = [];
    for (const name of names.filter((n) => n.endsWith('.xhtml'))) {
        const xhtml = await zip.file(name).async('string');
        if (!/<math[\s/>]/i.test(xhtml)) {
            continue;
        }
        mathFiles.push(name);

        const removed = xhtml.match(CORE_REMOVED);
        if (removed) {
            legacyMathml.push(name + ' -> <' + removed[1] + '>');
        }
        // in xhtml the namespace declaration is the only thing that makes this
        // MathML rather than a tree of unknown elements
        for (const tag of xhtml.match(/<math\b[^>]*>/gi) || []) {
            if (tag.indexOf('xmlns="http://www.w3.org/1998/Math/MathML"') < 0) {
                unnamespacedMath.push(name + ' -> ' + tag.slice(0, 60));
            }
        }
        // an <annotation> that survived is the TeX of the formula printed as
        // visible text right next to the formula
        if (/<annotation(-xml)?\b/i.test(xhtml)) {
            leakedAnnotations.push(name);
        }
    }

    const mathProperty = items.filter((i) => {
        const declared = /properties="[^"]*\bmathml\b[^"]*"/.test(i.attrs);
        return declared !== (mathFiles.indexOf(path.posix.join(opfDir, i.href)) > -1);
    }).map((i) => i.href + (mathFiles.indexOf(path.posix.join(opfDir, i.href)) > -1 ?
                           ' (has math, undeclared)' : ' (declared, no math)'));
    check('properties="mathml" is declared for exactly the files that contain MathML',
          mathProperty.length === 0, mathProperty.join(', '));

    check('no MathML element that MathML Core removed reaches the output',
          legacyMathml.length === 0, legacyMathml.join(', '));
    check('every <math> declares the MathML namespace',
          unnamespacedMath.length === 0, unnamespacedMath.join(', '));
    check('no <annotation> survives to be printed beside its formula',
          leakedAnnotations.length === 0, leakedAnnotations.join(', '));

    // Both are claims about the content documents, checkable the same way the
    // image ones are.
    const mathTags = [];
    for (const name of mathFiles) {
        const xhtml = await zip.file(name).async('string');
        mathTags.push(...(xhtml.match(/<math\b[^>]*>/gi) || []));
    }
    const described = mathTags.filter((t) => /\salttext="[^"]*[^"\s][^"]*"/.test(t));
    const mathDetail = mathTags.length + ' formulas, ' + described.length + ' with alttext';
    check('MathML is declared as a feature exactly when the book has MathML',
          /property="schema:accessibilityFeature">MathML</.test(opf) === (mathTags.length > 0),
          mathDetail);
    check('describedMath is claimed only when every formula has a text alternative',
          /property="schema:accessibilityFeature">describedMath</.test(opf) ===
              (mathTags.length > 0 && described.length === mathTags.length),
          mathDetail);

    // Both halves matter: the file and the <img> pointing at it are dropped
    // together, and either one surviving on its own is an invalid book.
    const placeholders = names.filter((n) => n.indexOf('TODO-EXTRACT') > -1);
    check('no unresolved image-type placeholders', placeholders.length === 0,
          placeholders.join(', '));
    check('no content document still points at an unresolved image',
          contentPlaceholders.length === 0, contentPlaceholders.join(', '));

    console.log(failures === 0 ? '\nepub structure OK' : '\n' + failures + ' structural failure(s)');
    process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
    console.error('FAILED to read the epub:', e);
    process.exit(1);
});
