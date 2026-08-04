var cssFileName = 'ebook.css';
var ebookTitle = null;
// Set by buildEbookFromChapters() from storage. Left null on the one-shot
// "save this page" path, which has no stored identity - see getBookId().
var ebookUuid = null;

// Compression is set per file, never globally: OCF requires 'mimetype' to be
// the first entry and STORE-d, so readers can sniff the magic bytes.
var DEFLATED = {compression: 'DEFLATE'};
var STORED = {compression: 'STORE'};

// getFileExtension() only ever returns png/gif/jpeg/svg/webp/''. Of those, only
// svg is text - the rest are already compressed and deflating them just burns
// CPU. '' cannot reach here: dropUntypedImages() removes those first.
function getImageZipOptions(filename) {
    return getFileExtension(filename) === 'svg' ? DEFLATED : STORED;
}

// An image whose type was never resolved has no media type to declare, and a
// manifest item without one is invalid - so the whole book fails over a single
// picture. Extraction drops these at the source now, but chapters buffered by an
// earlier version are still in storage carrying them, so the file and the <img>
// tags pointing at it are removed together here as well. Removing only one of
// the two trades this failure for a dangling reference, which fails just as hard.
function dropUntypedImages(page) {
    var images = page.images || [];
    var usable = images.filter(function(image) {
        return image && typeof image.filename === 'string' &&
               typeof image.data === 'string' && getImageType(image.filename) !== '';
    });
    if (usable.length === images.length) {
        return page;
    }
    var content = String(page.content || '');
    images.forEach(function(image) {
        if (usable.indexOf(image) < 0) {
            var filename = image && image.filename;
            console.log('Dropping an image of unknown type:', filename);
            content = removeImgTags(content, filename);
        }
    });
    // a copy: these pages are the buffered chapters, and rebuilding a book must
    // not quietly edit what is in storage
    return Object.assign({}, page, {images: usable, content: content});
}

// Only complete chapter records can become spine items. A null or partially
// written record can be left behind if the browser is closed while storage is
// being updated; skipping that record is preferable to losing every good
// chapter beside it. Optional fields are normalized for chapters saved by older
// extension versions.
function normalizeChapters(allPages) {
    if (!Array.isArray(allPages)) {
        return [];
    }
    return allPages.filter(function(page) {
        return page && typeof page === 'object' &&
               typeof page.title === 'string' && page.title.trim().length > 0 &&
               typeof page.url === 'string' && page.url.trim().length > 0;
    }).map(function(page, index) {
        return dropUntypedImages(Object.assign({}, page, {
            content: typeof page.content === 'string' ? page.content : '',
            images: Array.isArray(page.images) ? page.images : [],
            styleFileName: typeof page.styleFileName === 'string' && page.styleFileName ?
                           page.styleFileName : 'style' + index + '.css',
            styleFileContent: typeof page.styleFileContent === 'string' ? page.styleFileContent : ''
        }));
    }).map(dropMissingImages);
}

// Extraction normally writes every image reference and image byte record as a
// pair. Interrupted downloads and chapters saved by older versions can violate
// that invariant. Remove only local archive references which have no byte
// record; remote-looking sources are left alone for the normal EPUB validation
// path rather than guessed about here.
//
// The reference has to be anchored at the start of the src, not matched
// anywhere in it: a cdn url ending in "/images/photo.jpg" names a file this
// archive was never meant to contain, and stripping that <img> would delete a
// picture rather than repair a dangling reference.
function dropMissingImages(page) {
    var filenames = Object.create(null);
    page.images.forEach(function(image) {
        filenames[image.filename] = true;
    });
    var content = String(page.content || '').replace(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/gi,
        function(tag, src) {
            var match = src.match(/^(?:\.{1,2}\/)*images\/([^/?#]+)(?:[?#].*)?$/i);
            return match && !filenames[match[1]] ? '' : tag;
        });
    return content === page.content ? page : Object.assign({}, page, {content: content});
}

// The archive has one namespace for images even though chapter records each
// carry their own image list. The same downloaded asset can therefore occur in
// several records. Keep one manifest item and one zip member per filename; all
// chapter references continue to resolve to that shared member.
function collectUniqueImages(allPages) {
    var seen = Object.create(null);
    var images = [];
    allPages.forEach(function(page) {
        page.images.forEach(function(image) {
            if (!seen[image.filename]) {
                seen[image.filename] = true;
                images.push(image);
            }
        });
    });
    return images;
}

chrome.runtime.onMessage.addListener((obj, sender, sendResponse) => {
    if (obj && obj.shortcut === 'build-ebook') {
        buildEbook(obj.response);
        return false;
    }
    if (obj && obj.alert) {
        console.log(obj.alert);
        alert(obj.alert);
        return false;
    }
    // not ours - returning true here would hold the message channel open for
    // every message the other listeners handle
    return false;
})

// Tells the background the job is over, whichever way it ended. Every exit from
// _buildEbook() goes through this: without it a failed build leaves the badge on
// and the extension refusing to start anything else until the job times out.
function finishJob(errorMessage) {
    if (errorMessage) {
        console.log('Error:', errorMessage);
        try {
            alert(errorMessage);
        } catch (e) {
            console.log('Error:', e);
        }
    }
    try {
        chrome.runtime.sendMessage({type: "done"}, () => {
            void chrome.runtime.lastError;
        });
    } catch (e) {
        console.log('Error:', e);
    }
}

function getImagesIndex(allImages) {
    return allImages.reduce(function(prev, elem, index) {
        return prev + '\n' + '<item href="images/' + escapeXMLChars(elem.filename) +
               '" id="img' + index + '" media-type="image/' + getImageType(elem.filename) + '"/>';
    }, '');
}

// dc:identifier. A book assembled from chapters keeps the id stored beside them
// so that rebuilding after an edit updates the same book in a library instead of
// adding a second copy. A single page saved straight to disk was never stored
// and is a new book every time, so it gets a fresh id.
function getBookId() {
    return 'urn:uuid:' + (ebookUuid || generateUuid());
}

// dc:source, one per chapter. sourceUrl was added after baseUrl already existed;
// chapters buffered by an older version only carry baseUrl, which points at the
// containing directory rather than the article, but it is the best available
// answer for them and still names the right site.
function getSourceUrl(page) {
    return page.sourceUrl || page.baseUrl || '';
}

// Chapters buffered before the <head> read existed have no metadata at all, and
// a chapter whose page carried none has the key but empty values.
function getPageMetadata(page) {
    let metadata = page.metadata || {};
    return {
        lang: normalizeLanguageTag(metadata.lang),
        authors: Array.isArray(metadata.authors) ? metadata.authors : [],
        publisher: metadata.publisher || '',
        description: metadata.description || '',
        date: metadata.date || ''
    };
}

// dc:language is required, so there is always an answer: the first chapter that
// stated a usable one, else the "en" this used to hardcode. A book whose chapters
// disagree still gets a package language - each chapter overrides it on its own
// <html> element, which is what a reader actually uses for hyphenation.
function getBookLanguage(allPages) {
    for (let i = 0; i < allPages.length; i++) {
        let lang = getPageMetadata(allPages[i]).lang;
        if (lang) {
            return lang;
        }
    }
    return 'en';
}

function collectDistinct(allPages, pick) {
    let values = [];
    allPages.forEach(function(page) {
        let picked = pick(getPageMetadata(page));
        (Array.isArray(picked) ? picked : [picked]).forEach(function(value) {
            if (value && values.indexOf(value) < 0) {
                values.push(value);
            }
        });
    });
    return values;
}

// Two-word organisation names ("BBC News", "Associated Press") invert into
// nonsense, and a blocklist is the cheapest way to catch the common ones.
var ORG_NAME_WORDS = ['inc', 'llc', 'ltd', 'corp', 'co', 'gmbh', 'bv', 'nv', 'sa', 'ag', 'plc',
    'group', 'team', 'staff', 'news', 'times', 'press', 'media', 'post', 'journal', 'magazine',
    'review', 'daily', 'weekly', 'wire', 'agency', 'network', 'studios', 'labs', 'foundation',
    'institute', 'university', 'editors', 'editorial', 'newsroom', 'desk', 'blog'];

// dc:creator carries a name as it is written; file-as is how a library sorts it,
// and a wrong one misfiles the book permanently. Inverting is only safe for a
// plain two-part latin name: a mononym has nothing to invert, three parts may be
// a particle or a middle name, and most of the world does not put the family name
// last. Everything else gets no file-as and the reader sorts on the name itself,
// which is the correct fallback rather than a degraded one.
function getFileAs(name, publishers) {
    // already in some sorted form, or credited to the site rather than a person
    if (name.indexOf(',') > -1 || publishers.indexOf(name) > -1) {
        return '';
    }
    let parts = name.split(' ');
    if (parts.length !== 2) {
        return '';
    }
    for (let i = 0; i < parts.length; i++) {
        if (!/^[\p{Script=Latin}][\p{Script=Latin}'’.-]*$/u.test(parts[i])) {
            return '';
        }
        if (ORG_NAME_WORDS.indexOf(parts[i].toLowerCase().replace(/[.]$/, '')) > -1) {
            return '';
        }
    }
    return parts[1] + ', ' + parts[0];
}

// dc:creator, with the refinements that make it usable: a role, so a reader knows
// these are authors rather than unspecified contributors, and a display-seq, so a
// byline with several names keeps its order instead of being alphabetised.
function getCreatorsIndex(authors, publishers) {
    return authors.reduce(function(prev, name, index) {
        let escaped = escapeXMLChars(name);
        let entry = '\n' + '<dc:creator id="creator' + index + '">' + escaped + '</dc:creator>' +
                    '\n' + '<meta refines="#creator' + index + '" property="role" scheme="marc:relators">aut</meta>';
        let fileAs = getFileAs(name, publishers);
        if (fileAs) {
            entry += '\n' + '<meta refines="#creator' + index + '" property="file-as">' + escapeXMLChars(fileAs) + '</meta>';
        }
        if (authors.length > 1) {
            entry += '\n' + '<meta refines="#creator' + index + '" property="display-seq">' + (index + 1) + '</meta>';
        }
        return prev + entry;
    }, '');
}

// Counted from the markup that is actually written into the file, not from what
// extraction believed it produced. The metadata below is a claim about this
// epub, so the only honest source for it is this epub.
//
// Three states, and the difference between the last two is the whole point:
//   alt="something"  the source described the image
//   alt=""           the source marked it decorative - also an answer
//   no alt           the source never said, and neither can we
function countImages(allPages) {
    var counts = {total: 0, described: 0, undescribed: 0, animatable: 0};
    allPages.forEach(function(page) {
        var tags = String(page.content || '').match(/<img\b[^>]*>/gi) || [];
        tags.forEach(function(tag) {
            counts.total++;
            var alt = tag.match(/\salt="([^"]*)"/);
            if (!alt) {
                counts.undescribed++;
            } else if (alt[1].length > 0) {
                counts.described++;
            }
        });
        (page.images || []).forEach(function(image) {
            var type = getFileExtension(image.filename);
            if (type === 'gif' || type === 'svg' || type === 'webp') {
                counts.animatable++;
            }
        });
    });
    return counts;
}

// A content document holding MathML has to declare it, or EPUBCheck fails the
// book and several readers never invoke their math handling for that file at
// all. Declaring it on a file with no math is the same error the other way
// round, so it is read from the markup rather than asserted about it - for the
// same reason the image counts above are, and with the same benefit: a chapter
// buffered by a version that predates any of this carries no flag but does carry
// the math.
//
// It is also the only manifest property that can ever apply to a chapter this
// extension writes. "svg" cannot: extraction converts every <svg> into an <img>.
// "scripted" cannot: <script> is stripped along with its content. "remote-
// resources" cannot: every image referenced is one that was downloaded into the
// archive.
function hasMathML(content) {
    return /<math[\s/>]/i.test(String(content || ''));
}

function getChapterProperties(content) {
    return hasMathML(content) ? ' properties="mathml"' : '';
}

// alttext is the formula written out - what a reading system with no MathML of
// its own reads instead of the markup. Pages that ship MathML usually supply it,
// and normalizeMathMl() fills it from the TeX the formula was typeset from when
// they do not, so "every formula has one" is a claim worth checking and making.
function countMath(allPages) {
    var counts = {total: 0, described: 0};
    allPages.forEach(function(page) {
        var tags = String(page.content || '').match(/<math\b[^>]*>/gi) || [];
        tags.forEach(function(tag) {
            counts.total++;
            var alttext = tag.match(/\salttext="([^"]*)"/);
            if (alttext && alttext[1].trim().length > 0) {
                counts.described++;
            }
        });
    });
    return counts;
}

// EPUB Accessibility 1.1 discovery metadata. Every line here is derived from the
// file rather than asserted about it - a hardcoded "alternativeText" on a book
// whose images have no alt is worse than no metadata at all, because it stops a
// reader looking for a book that actually is readable without sight.
//
// dcterms:conformsTo is deliberately absent. It would claim WCAG conformance,
// which covers colour contrast and reflow, and the chapter stylesheets are the
// source sites' own computed colours - not something this extension chooses or
// can check. The summary says so in as many words.
function getAccessibilityIndex(allPages, navTree) {
    var counts = countImages(allPages);
    var math = countMath(allPages);
    var hasImages = counts.total > 0;
    // no image is left unexplained - described or explicitly decorative
    var imagesAccountedFor = counts.undescribed === 0;
    var entries = [];

    function meta(property, value) {
        entries.push('<meta property="' + property + '">' + escapeXMLChars(value) + '</meta>');
    }

    meta('schema:accessMode', 'textual');
    if (hasImages) {
        meta('schema:accessMode', 'visual');
    }

    // "the text alone is enough" holds only when nothing visual is unexplained
    if (imagesAccountedFor) {
        meta('schema:accessModeSufficient', 'textual');
    }
    if (hasImages) {
        meta('schema:accessModeSufficient', 'textual,visual');
    }

    if (counts.described > 0 && imagesAccountedFor) {
        meta('schema:accessibilityFeature', 'alternativeText');
    }
    // toc.xhtml is always generated, with an entry per chapter
    meta('schema:accessibilityFeature', 'tableOfContents');
    // Claimed only when the nav actually goes below chapter level: every book
    // gets a section and a heading per chapter, but "structural navigation"
    // means being able to move around inside one, and that only exists when the
    // source pages had headings to build it from.
    var hasSubEntries = (navTree || []).some(function(node) {
        return node.children.length > 0;
    });
    if (hasSubEntries) {
        meta('schema:accessibilityFeature', 'structuralNavigation');
    }

    // MathML is a feature to search for rather than a hazard to warn about: it
    // is the difference between a formula a screen reader can read out term by
    // term and a picture of one. describedMath is the stronger claim - that
    // there is a text alternative to fall back on - and it only holds when every
    // formula has one.
    if (math.total > 0) {
        meta('schema:accessibilityFeature', 'MathML');
        if (math.described === math.total) {
            meta('schema:accessibilityFeature', 'describedMath');
        }
    }

    // audio and video are dropped by strippedContentTags and the only css that
    // survives is the colour and font allowlist in supportedCss - no animation,
    // no transitions, nothing that can move. What can still move is an animated
    // gif, svg or webp, and there is no way to tell one of those from a still
    // image without decoding it.
    meta('schema:accessibilityHazard', 'noSoundHazard');
    if (counts.animatable === 0) {
        meta('schema:accessibilityHazard', 'noFlashingHazard');
        meta('schema:accessibilityHazard', 'noMotionSimulationHazard');
    }

    var summary = 'Generated from web pages. ';
    if (!hasImages) {
        summary += 'It contains no images, so the text is the whole content. ';
    } else if (imagesAccountedFor) {
        summary += 'Every image carries the alternative text from its source page, ' +
                   'or is marked decorative there. ';
    } else {
        summary += counts.undescribed + ' of its ' + counts.total + ' images ' +
                   (counts.undescribed === 1 ? 'has' : 'have') + ' no alternative text, ' +
                   'because the source pages did not provide any. ';
    }
    if (math.total > 0) {
        summary += math.described === math.total ?
            'Its formulas are MathML, each with a text alternative. ' :
            'Its formulas are MathML. ';
    }
    summary += 'Styling is copied from the source pages and has not been checked for ' +
               'colour contrast, so no WCAG conformance is claimed.';
    meta('schema:accessibilitySummary', summary);

    return '\n' + entries.join('\n');
}

// ---- chapter structure and navigation ---------------------------------------
//
// A chapter is written as <body epub:type="bodymatter"> holding a single
// <section epub:type="chapter" role="doc-chapter">, instead of the bare <div> it
// used to be. Both halves are needed and neither substitutes for the other:
// epub:type is what a reading system reads to know where the body of the book
// begins, and the DPUB-ARIA role is what makes VoiceOver and TalkBack announce a
// chapter rather than an unnamed group.
//
// Only these two semantics are asserted. Anything finer - is this section an
// abstract, an epigraph, a bibliography? - would be a guess about pages this
// extension has never seen, epubcheck validates epub:type against the structural
// semantics vocabulary, and a confidently wrong value is worse for a screen
// reader than no value at all.

// A page that uses headings as layout can have hundreds of them; past this many
// the nav stops being a table of contents and becomes a second copy of the
// chapter.
var MAX_HEADINGS_PER_CHAPTER = 200;
var MAX_NAV_LABEL_LENGTH = 200;

// Headings cannot nest in HTML, and the content has been through parseHTML(), so
// the first matching close tag of the same level is the right one.
var HEADING_REGEX = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;

// Every id already written into the chapter content, so that a minted one can
// avoid them. The content has been through parseHTML(), so an id attribute is
// always double quoted and its value is always an XML name - see isUsableId() in
// utils.js, which is what put it there.
var ID_ATTR_REGEX = /\sid="([^"]*)"/gi;

function collectIds(content) {
    var ids = Object.create(null);
    var match;
    ID_ATTR_REGEX.lastIndex = 0;
    while ((match = ID_ATTR_REGEX.exec(content)) !== null) {
        ids[match[1]] = true;
    }
    return ids;
}

// The chapter content is already XML, so "<" only ever starts a tag and the text
// of a heading is what is left when the tags are taken out - still escaped, and
// so ready to go straight into the nav without being escaped a second time.
function markupToLabel(markup) {
    var label = String(markup).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (label.length > MAX_NAV_LABEL_LENGTH) {
        // never cut inside an entity - "&am" is not well formed
        label = label.substring(0, MAX_NAV_LABEL_LENGTH).replace(/&[^;]*$/, '').trim() + '…';
    }
    return label;
}

// A heading label and a page title are escaped by different rules - text nodes
// keep their quotes, attribute-safe values do not - so both are decoded before
// they are compared.
function decodeBasicEntities(text) {
    return String(text)
        .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function normalizeForMatch(text) {
    return decodeBasicEntities(text).toLowerCase().replace(/\s+/g, ' ')
        .replace(/^[\s"'“”‘’.,:;!?|-]+/, '').replace(/[\s"'“”‘’.,:;!?|-]+$/, '');
}

// Whether a heading already says what the chapter is called. A page's <title>
// usually carries the site name as well ("Article - Wikipedia") while the
// heading in the page does not, so the first separated segment counts too.
function isTitleHeading(label, title) {
    var heading = normalizeForMatch(label);
    if (!heading) {
        return false;
    }
    if (heading === normalizeForMatch(title)) {
        return true;
    }
    var firstSegment = normalizeForMatch(String(title).split(/\s+[|–—•·:-]\s+/)[0]);
    return firstSegment.length > 0 && heading === firstSegment;
}

// A link the page made to a position inside itself - a footnote marker, a "back
// to top", a cross reference - arrives here as a bare fragment, because that is
// what extraction writes for a same-document href. It only works if the element
// it names is still in the chapter, and plenty are not: the target may have been
// outside the selection, or inside something extraction drops whole.
//
// A fragment pointing at nothing is not a dead link, it is an invalid file -
// epubcheck reports an unresolved fragment as an error - so the href goes and
// the text stays. An <a> with no href is well formed and reads as the words it
// always was.
var FRAGMENT_HREF_REGEX = /<a\s([^>]*?)href="#([^"]*)"([^>]*)>/gi;

function resolveInternalLinks(content, usedIds) {
    return String(content).replace(FRAGMENT_HREF_REGEX,
        function(all, before, id, after) {
            if (usedIds[id]) {
                return all;
            }
            var attrs = (before + after).replace(/\s+/g, ' ').trim();
            return attrs ? '<a ' + attrs + '>' : '<a>';
        });
}

// Gives every heading in a chapter an id and reports what was found, in document
// order. This runs on the content string exactly as it will be written to the
// archive: the ids in the file and the ids the nav points at have to be the same
// ones, and deriving them twice in two places is how those two drift apart.
//
// An id the source already carries is kept - it is what any link inside the page
// points at - unless it is unusable or a duplicate, in which case it is replaced
// rather than left beside a generated one, which would be two id attributes on
// one element and not well-formed XML.
//
// Every id in the chapter is collected before any is minted, not just the ones
// on headings: a page is free to have id="sae-c0-h0" on a paragraph, and a
// minted id landing on top of it would give the chapter two elements with one
// id, which is the one thing an id may not be.
function buildChapterOutline(page, index) {
    var headings = [];
    var content = String(page.content || '');
    var usedIds = collectIds(content);
    // Ids this pass has handed out or confirmed, so that two headings carrying
    // the same id from the page do not both keep it. Extraction already dedupes
    // across the whole chapter, so this only catches content reaching the writer
    // by some other route.
    var claimedIds = Object.create(null);
    // The id says which heading of which chapter it belongs to, which is what
    // makes a nav target readable. A suffix is only added if the page already
    // used that exact name for something else.
    var mintId = function() {
        var base = 'sae-c' + index + '-h' + headings.length;
        var id = base;
        var suffix = 2;
        while (usedIds[id]) {
            id = base + '-' + suffix;
            suffix++;
        }
        return id;
    };

    content = content.replace(HEADING_REGEX,
        function(all, level, attrs, inner) {
            if (headings.length >= MAX_HEADINGS_PER_CHAPTER) {
                return all;
            }
            var label = markupToLabel(inner);
            if (!label) {
                // nothing to show in the nav, so nothing worth linking to
                return all;
            }
            var id = (attrs.match(/\sid="([^"]*)"/i) || [])[1] || '';
            if (id && (!isUsableId(id) || claimedIds[id])) {
                attrs = attrs.replace(/\sid="[^"]*"/i, '');
                id = '';
            }
            if (!id) {
                id = mintId();
                attrs = ' id="' + id + '"' + attrs;
            }
            claimedIds[id] = true;
            usedIds[id] = true;
            headings.push({level: parseInt(level, 10), id: id, label: label});
            return '<h' + level + attrs + '>' + inner + '</h' + level + '>';
        });

    // Links into the chapter are resolved last, against the ids as they finally
    // stand - a heading only just got one, and the target of a link may be an
    // element that never made it out of extraction.
    content = resolveInternalLinks(content, usedIds);

    // A page that opens with a heading naming the page is the common case, and
    // adding our own on top of it prints the title twice and lists it twice in
    // the nav.
    var hasTitleHeading = headings.length > 0 &&
                          isTitleHeading(headings[0].label, page.title || '');
    if (hasTitleHeading) {
        headings = headings.slice(1);
    }

    return {content: content, headings: headings, hasTitleHeading: hasTitleHeading};
}

// The chapter as it is written into the archive. The title used to exist only in
// the package document and the nav - a reader opening the chapter itself saw no
// title anywhere - so it becomes the section's heading when the page does not
// already provide one.
function getChapterBody(page, outline) {
    var heading = outline.hasTitleHeading ? '' :
        '<h1>' + escapeXMLChars(page.title) + '</h1>';
    return '<body epub:type="bodymatter">' +
           '<section epub:type="chapter" role="doc-chapter">' +
           heading +
           outline.content +
           '</section>' +
           '</body>';
}

// Headings, which are a flat list of levels, become the tree they describe. A
// level that skips (h1 then h3) nests rather than being promoted, and a chapter
// that starts at h3 puts those at the top - what matters is relative depth,
// since the absolute levels a page uses are its own layout decision.
function headingsToNavNodes(headings, href) {
    var root = [];
    var stack = [];
    headings.forEach(function(heading) {
        var node = {label: heading.label, href: href + '#' + heading.id, children: []};
        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            stack.pop();
        }
        if (stack.length === 0) {
            root.push(node);
        } else {
            stack[stack.length - 1].node.children.push(node);
        }
        stack.push({level: heading.level, node: node});
    });
    return root;
}

// One tree, rendered twice below - as the EPUB 3 nav document and as the EPUB 2
// ncx. Building each from its own walk of the chapters is what lets a reader
// following the ncx see a different book from one following the nav.
function buildNavTree(allPages, outlines) {
    return allPages.map(function(page, index) {
        var href = 'pages/' + page.url;
        return {
            label: escapeXMLChars(page.title),
            href: href,
            children: headingsToNavNodes(outlines[index].headings, href)
        };
    });
}

// Labels are already escaped - see markupToLabel()
function navTreeToList(nodes) {
    if (nodes.length === 0) {
        return '';
    }
    return '<ol>' + nodes.reduce(function(prev, node) {
        return prev + '\n' + '<li><a href="' + node.href + '">' + node.label + '</a>' +
               navTreeToList(node.children) + '</li>';
    }, '') + '</ol>';
}

// playOrder is a single sequence over the whole document, not a per-level one,
// so the counter is threaded through the walk.
function navTreeToNavPoints(nodes, counter) {
    return nodes.reduce(function(prev, node) {
        var order = ++counter.value;
        return prev + '\n' +
            '<navPoint id="navPoint' + order + '" playOrder="' + order + '">' +
            '<navLabel><text>' + node.label + '</text></navLabel>' +
            '<content src="' + node.href + '"/>' +
            navTreeToNavPoints(node.children, counter) +
            '</navPoint>';
    }, '');
}

// dtb:depth must state the deepest level the navMap actually reaches. It was
// hardcoded to 1, which was true only while the nav was one flat entry per page.
function navTreeDepth(nodes) {
    return nodes.reduce(function(deepest, node) {
        return Math.max(deepest, 1 + navTreeDepth(node.children));
    }, 0);
}

function getExternalLinksIndex() { // TODO
    return allExternalLinks.reduce(function(prev, elem, index) {
        return prev + '\n' + '<item href="' + elem + '" />';
    }, '');
}

function buildEbookFromChapters() {
    getEbookTitle(function (title) {
        ebookTitle = title;
        if (!ebookTitle || ebookTitle.trim().length === 0) {
            ebookTitle = 'eBook';
        }
        getEbookUuid(function (uuid) {
            ebookUuid = uuid;
            getEbookPages(_buildEbook);
        })
    })
}

// FIXME remove  - keep one  function
function buildEbook(allPages, fromMenu=false) {
    // the one-shot "save this page" path: nothing about it was stored, so it is
    // a new book every time and must not inherit an id from a chapter build
    ebookUuid = null;
    _buildEbook(allPages, fromMenu);
}

// http://ebooks.stackexchange.com/questions/1183/what-is-the-minimum-required-content-for-a-valid-epub
function _buildEbook(allPages, fromMenu=false) {
    allPages = normalizeChapters(allPages);
    if (allPages.length === 0) {
        finishJob('There are no valid chapters to save.');
        return;
    }
    var allImages = collectUniqueImages(allPages);

    console.log('Prepare Content...');

    var ebookFileName = 'eBook.epub';

    if (ebookTitle) {
        // ~TODO a pre-processing function to apply escapeXMLChars to all page.titles
        ebookName = escapeXMLChars(ebookTitle);
        ebookFileName = getEbookFileName(removeSpecialChars(ebookTitle)) + '.epub';
    } else {
        ebookName = escapeXMLChars(allPages[0].title);
        ebookFileName = getEbookFileName(removeSpecialChars(allPages[0].title)) + '.epub';
    }

    // One instant for the whole package: dc:date (when this file was made) and
    // dcterms:modified disagreeing by a second reads as two separate events.
    var buildDate = new Date().toISOString().replace(/\.[0-9]+Z/i, 'Z');
    var bookId = getBookId();
    var bookLanguage = getBookLanguage(allPages);
    var publishers = collectDistinct(allPages, function(m) { return m.publisher; });
    var authors = collectDistinct(allPages, function(m) { return m.authors; }).slice(0, 12);
    // dc:date is the date of publication of this file. For a single saved page
    // that is the article's own date, which is what a library should sort on; a
    // book assembled from several pages was published when it was assembled, and
    // picking one chapter's date to stand for the whole would be a guess. Every
    // chapter keeps its own date below regardless.
    var bookDate = (allPages.length === 1 && getPageMetadata(allPages[0]).date) || buildDate;
    // Likewise: one page's blurb describes the book. Several pages' first blurb
    // describes one chapter, and claiming otherwise is worse than saying nothing.
    var bookDescription = allPages.length === 1 ? getPageMetadata(allPages[0]).description : '';

    // The content as it will be written, with an id on every heading, and the
    // one navigation tree that the nav document, the ncx and the chapter files
    // are all rendered from.
    var outlines = allPages.map(function(page, index) {
        return buildChapterOutline(page, index);
    });
    var navTree = buildNavTree(allPages, outlines);

    var zip = new JSZip();
    // Must stay first in the archive and uncompressed - do not add DEFLATE here.
    zip.file('mimetype', 'application/epub+zip', STORED);

    var metaInfFolder = zip.folder("META-INF");
    metaInfFolder.file('container.xml',
        '<?xml version="1.0"?>' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
        '</rootfiles>' +
        '</container>',
        DEFLATED
    );


    var oebps = zip.folder("OEBPS");
    oebps.file('toc.xhtml',
        '<?xml version="1.0" encoding="utf-8"?>' +
        // xml:lang is what counts in xhtml, lang is what an epub reader that
        // treats the file as html reads - epub wants both, and both must agree
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"' +
        ' xml:lang="' + bookLanguage + '" lang="' + bookLanguage + '">' +
        '<head>' +
        // was the literal string "toc.xhtml", which is what a reader shows in
        // its own table of contents view and in the page's title bar
        '<title>Table of Contents</title>' +
        '<link href="' + cssFileName + '" rel="stylesheet" type="text/css" />' +
        '</head>' +
        // the nav document is not part of the reading order - it is what comes
        // before it
        '<body epub:type="frontmatter">' +
        '<nav id="toc" epub:type="toc" role="doc-toc">' +
        '<h1 class="frontmatter">Table of Contents</h1>' +
        // the nested list the headings describe, not one flat entry per page
        navTreeToList(navTree).replace('<ol>', '<ol class="contents">') +
        '</nav>' +
        // Where the parts of the book are, for the readers that offer "go to the
        // start of the book" and for assistive technology. hidden, because it is
        // machine-readable structure rather than a second table of contents to
        // scroll past.
        //
        // One entry, because a landmark may only point at a spine item and the
        // only structural claim that is certainly true of every book built here
        // is where its body starts. A "toc" landmark pointing at this document
        // is what most books carry, but the nav is not in the spine, and
        // epubcheck rejects it (RSC-011); readers find it through the manifest's
        // nav property instead.
        (navTree.length > 0 ?
            '<nav epub:type="landmarks" hidden="hidden" aria-label="Landmarks">' +
            '<h2>Guide</h2>' +
            '<ol>' +
            '<li><a epub:type="bodymatter" href="' + navTree[0].href + '">Start of Content</a></li>' +
            '</ol>' +
            '</nav>' : '') +
        '</body>' +
        '</html>',
        DEFLATED
    );

    oebps.file('toc.ncx',
        '<?xml version="1.0" encoding="UTF-8" ?>' +
        '<ncx version="2005-1" xml:lang="' + bookLanguage + '" xmlns="http://www.daisy.org/z3986/2005/ncx/">' +
        '<head>' +
        // must be the same value as dc:identifier in the package document
        '<meta name="dtb:uid" content="' + bookId + '"/>' +
        '<meta name="dtb:depth" content="' + Math.max(1, navTreeDepth(navTree)) + '"/>' +
        '</head>' +
        '<docTitle>' +
        '<text>' + ebookName + '</text>' +
        '</docTitle>' +
        // Kept for ADE and Kindle Previewer, which ignore the nav document, and
        // rendered from the same tree so the two cannot disagree.
        '<navMap>' +
        navTreeToNavPoints(navTree, {value: 0}) +
        '</navMap>' +
        '</ncx>',
        DEFLATED
    );

    oebps.file(cssFileName, '', DEFLATED); //TODO
    var styleFolder = oebps.folder('style');
    allPages.forEach(function(page) {
        styleFolder.file(page.styleFileName, page.styleFileContent, DEFLATED);
    });

    var pagesFolder = oebps.folder('pages');
    allPages.forEach(function(page, index) {
        var tmpPageTitle = escapeXMLChars(page.title);
        // the chapter's own language when its page stated one, so a book mixing
        // languages hyphenates and speaks each chapter correctly
        var pageLanguage = getPageMetadata(page).lang || bookLanguage;
        pagesFolder.file(page.url,
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"' +
            ' xml:lang="' + pageLanguage + '" lang="' + pageLanguage + '">' +
            '<head>' +
            '<title>' + tmpPageTitle+ '</title>' +
            '<link href="../style/' + page.styleFileName + '" rel="stylesheet" type="text/css" />' +
            '</head>' +
            getChapterBody(page, outlines[index]) +
            '</html>',
            DEFLATED
        );
    });

    oebps.file('content.opf',
        '<?xml version="1.0" encoding="UTF-8" ?>' +
        // No prefix attribute: every vocabulary used below - dc:, dcterms:,
        // marc:, schema: - is reserved in EPUB 3.3 and redeclaring one is an
        // error. The a11y: vocabulary is the exception that would need declaring,
        // but all four of its properties are certification and exemption claims,
        // which getAccessibilityIndex() deliberately does not make.
        '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        'unique-identifier="db-id" version="3.0">' +
        // dcterms: needs no xmlns here - it is an EPUB reserved prefix, resolved
        // against the package vocabulary, not an XML namespace
        '<metadata>' +
        '<dc:title id="t1">'+ ebookName + '</dc:title>' +
        '<meta refines="#t1" property="title-type">main</meta>' +
        '<dc:identifier id="db-id">' + bookId + '</dc:identifier>' +
        '<meta property="dcterms:modified">' + buildDate + '</meta>' +
        '<dc:date>' + bookDate + '</dc:date>' +
        '<dc:language>' + bookLanguage + '</dc:language>' +
        getCreatorsIndex(authors, publishers) +
        publishers.reduce(function(prev, publisher) {
            return prev + '\n' + '<dc:publisher>' + escapeXMLChars(publisher) + '</dc:publisher>';
        }, '') +
        (bookDescription ? '\n' + '<dc:description>' + escapeXMLChars(bookDescription) + '</dc:description>' : '') +
        getAccessibilityIndex(allPages, navTree) +
        // the pages this was made from. Repeated rather than joined: dc:source
        // is repeatable, and one line per chapter survives being read by a tool
        // that only looks at the first.
        allPages.reduce(function(prev, page) {
            var src = getSourceUrl(page);
            return src ? prev + '\n' + '<dc:source>' + escapeXMLChars(src) + '</dc:source>' : prev;
        }, '') +
        // ...and which chapter came from which, since dc:source above is
        // unordered as far as a reader is concerned
        allPages.reduce(function(prev, page, index) {
            var src = getSourceUrl(page);
            return src ? prev + '\n' +
                '<link rel="dcterms:source" refines="#ebook' + index + '" href="' + escapeXMLChars(src) + '"/>' : prev;
        }, '') +
        // when each chapter was published, which the package-level dc:date can
        // only ever state for a one-chapter book
        allPages.reduce(function(prev, page, index) {
            var date = getPageMetadata(page).date;
            return date ? prev + '\n' +
                '<meta refines="#ebook' + index + '" property="dcterms:created">' + date + '</meta>' : prev;
        }, '') +
        '</metadata>' +
        '<manifest>' +
        '<item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml" />' +
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />' +
        '<item id="template_css" href="' + cssFileName + '" media-type="text/css" />' +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<item id="ebook' + index + '" href="pages/' + page.url + '"' +
                   // from the content as it is written, not as it arrived - see
                   // getChapterProperties()
                   getChapterProperties(outlines[index].content) +
                   ' media-type="application/xhtml+xml" />';
        }, '') +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<item id="style' + index + '" href="style/' + page.styleFileName + '" media-type="text/css" />';
        }, '') +
        getImagesIndex(allImages) +
        '</manifest>' +
        '<spine toc="ncx">' +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<itemref idref="ebook' + index + '" />';
        }, '') +
        '</spine>' +
        '</package>',
        DEFLATED
    );

    ///////////////
    try {
        let imgsFolder = oebps.folder("images");
        allImages.forEach(function(tmpImg) {
            // TODO - Must be JSON serializable - see the same comment in extractHtml.js
            let imgOptions = getImageZipOptions(tmpImg.filename)
            // if (tmpImg.isBinary) {
            //     imgsFolder.file(tmpImg.filename, tmpImg.data, {binary: true, compression: imgOptions.compression})
            // } else {
                imgsFolder.file(tmpImg.filename, tmpImg.data, {base64: true, compression: imgOptions.compression})
            // }
        });
    } catch (error) {
        console.log(error);
    }
    

    // Compressing a large book takes long enough to outlive the job timeout, so
    // keep reporting progress until the file is handed to the download
    let heartbeat = setInterval(function () {
        try {
            chrome.runtime.sendMessage({type: 'job-heartbeat'}, () => {
                void chrome.runtime.lastError;
            });
        } catch (e) {
            console.log('Error:', e);
        }
    }, 5000);

    zip.generateAsync({
            type: "blob",
            mimeType: "application/epub+zip"
        })
        .then(function(content) {
            clearInterval(heartbeat);
            downloadBlob(content, ebookFileName);
            finishJob(null);
        })
        .catch(function(error) {
            // out of memory on a very large book, a corrupt image, a revoked
            // blob url - all of them used to leave the job open forever
            clearInterval(heartbeat);
            finishJob('Could not generate the eBook: ' + error);
        });

}
