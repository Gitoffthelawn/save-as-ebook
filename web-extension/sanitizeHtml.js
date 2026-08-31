// The sanitizer and serializer, shared by everything that produces chapter
// content. It used to live inside extractHtml.js and could therefore only run as
// a content script, which made a page of our own - the chapter editor - unable
// to write content the build stage would accept.
//
// The contract: any string that comes out of parseHTML() satisfies the
// invariants the build stage relies on, whatever went in.
//
//   - well formed XML: every tag is closed, void tags are self-closed, and tags
//     the input left open or closed twice are balanced here
//   - every attribute value is double quoted and XML-escaped, which is what lets
//     saveEbook.js read the content back with regular expressions (HEADING_REGEX,
//     ID_ATTR_REGEX, HREF_ATTR_REGEX) instead of parsing it again
//   - only allowlisted tags and attributes survive, so nothing scripts, loads a
//     remote resource, or names a vocabulary the package document never declares
//   - text carries no entity but the five XML predefines, and no character XML
//     1.0 forbids
//   - every id is an XML name and unique within the chapter
//
// It is also idempotent: running its own output through it again returns the
// same string. That is what makes an edit round trip - the editor serializes a
// DOM built from content this produced, and hands it straight back.
//
// Requires utils.js.

var MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

// MathML Core is what every WebKit and Chromium reading system implements -
// Apple Books, Thorium, Kobo, anything built on either engine - and it dropped a
// large part of what MathML 3 allowed. Everything Core removed is deliberately
// missing from this list and rewritten by normalizeMathMl() instead, because
// passing one of them through means a reader draws nothing where the element
// was:
//
//   mfenced      expanded into the mrow of <mo> fences the MathML 3 spec defines
//                it to be equivalent to. A Core reader lays out an mfenced's
//                children with no brackets at all, so "f(x)" comes out as "fx" -
//                and older MathJax output is full of it.
//   mlabeledtr   renamed to <mtr>, keeping the label as its first cell.
//                Unwrapping it would put <mtd>s straight into the <mtable>.
//   menclose     unwrapped: the box or strikethrough it draws is lost either
//                way, and its content is the part worth keeping.
//   mstack, msgroup, mlongdiv
//                unwrapped. These lay digits out in a grid for long division;
//                without the layout the digits are all that is left, but they
//                are at least still in reading order.
//   mscarries, mscarry
//                dropped with their content - a carried digit annotates a
//                position in that grid, and outside it it is a stray number in
//                the middle of another number.
//
// mprescripts and none are the other direction: both are required by
// mmultiscripts and neither was ever allowed, so a prescripted symbol lost the
// marker saying where its prescripts begin.
var mathMLTags = [
    'math', 'maction', 'merror', 'mfrac', 'mglyph', 'mi', 'mmultiscripts', 'mn', 'mo',
    'mover', 'mpadded', 'mphantom', 'mprescripts', 'mroot', 'mrow', 'ms', 'mspace',
    'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr',
    'munder', 'munderover', 'none', 'semantics'
];
// blockquote was missing rather than excluded, and it is not a tag whose absence
// shows up as a gap: it is not in strippedContentTags either, so a quotation was
// unwrapped - the tag went, the words stayed - and ran into the paragraph before
// it with nothing to say where the quote started or ended.
var allowedTags = [
    'address', 'article', 'aside', 'blockquote', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hgroup', 'nav', 'section', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li',
    'main', 'ol', 'p', 'pre', 'ul', 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data',
    'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'small', 'span',
    'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'caption', 'col', 'colgroup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'
    // TODO ?
    // ,'form', 'button'

    // TODO svg support ?
    // , 'svg', 'g', 'path', 'line', 'circle', 'text'
].concat(mathMLTags);
// const svgTags = ['svg', 'g', 'path', 'line', 'circle', 'text']
// Allowed tags that have no content and must be written self-closed, otherwise
// the generated page is not well formed XML
var voidTags = ['br', 'col', 'hr', 'img', 'wbr'];
// Tags that are dropped together with everything inside them. Any other tag
// that is not in allowedTags is unwrapped instead - the tag goes, its text stays.
var strippedContentTags = [
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'applet',
    'head', 'title', 'meta', 'link', 'base',
    'textarea', 'select', 'option', 'optgroup', 'input',
    'audio', 'video', 'canvas', 'svg', 'map', 'area',
    // <semantics> keeps its presentation MathML and loses its annotations. An
    // annotation is an alternative encoding of the same formula - almost always
    // the TeX it was typeset from - and a conforming reader renders only the
    // first child of <semantics>, so it is never meant to be seen. But
    // <annotation> was in neither list, so it was unwrapped instead and its raw
    // TeX printed as visible text right beside the rendered formula. That is the
    // single most visible MathML bug on a KaTeX page.
    //
    // The TeX itself is not thrown away: normalizeMathMl() lifts it into the
    // <math alttext> first, where it is a fallback rather than a duplicate.
    'annotation', 'annotation-xml',
    'mscarries', 'mscarry'
];

// ---- attributes -------------------------------------------------------------
//
// MathML carries its meaning in its attributes at least as much as in its tags.
// display="block" alone is the difference between a centred display equation and
// something jammed into the middle of a sentence; stretchy and largeop size the
// brackets and the integral signs; columnalign is what makes a matrix line up;
// linethickness="0" is how a binomial coefficient is written. Only alttext used
// to survive, so all of that was lost on every formula.
//
// MathML's vocabulary is closed, and EPUBCheck validates attributes against the
// element-specific vocabulary rather than against a union of all MathML names.
// Both <mi bogus="x"> and <mi rowspan="2"> are RSC-005 errors: the first name
// does not exist and the second exists only on <mtd>. Keep the sets per element
// so neither kind can make the chapter XHTML invalid.
//
// The shared arrays below mirror the actual groups in the MathML 3 presentation
// schema (common presentation attributes, token attributes, and the attributes
// <mstyle> may set). The table then adds only what each retained MathML element
// accepts. This is intentionally a subset of the schema: leaving out a layout
// hint can cost one formula some styling, while passing an invalid attribute
// costs the validity of the whole EPUB.
//
// Excluded on purpose, though MathML does define them:
//
//   href, src, altimg   MathML's own link and image attributes. href can hold a
//                       javascript: url, and src or altimg would point at a
//                       file that is not in the archive.
//   style, class        the chapter stylesheet is generated from computed
//                       styles, never copied from the page
//   id                  an html id is carried over - it is what a link inside
//                       the page points at - but nothing ever links into a
//                       formula, and an id here would only be one more name the
//                       ids minted while the chapter is written have to avoid
//                       colliding with
//   xmlns, definitionURL, and anything else with a colon or a capital in it.
//                       An xmlns: or xlink: attribute needs a namespace
//                       declaration the chapter documents do not make, and an
//                       undeclared prefix does not make one formula wrong, it
//                       makes the whole xhtml file unparseable. <math> gets its
//                       own xmlns written by the serializer.
//
// Event handlers, data-* names, invented names, and names from another MathML
// element are absent by construction.
var mathMLCommonPresentationAttributes = ['mathbackground', 'mathcolor'];

function mathMLAttributes(extra) {
    return mathMLCommonPresentationAttributes.concat(extra || []);
}

var mathMLTokenAttributes = mathMLAttributes(['dir', 'mathsize', 'mathvariant']);

// MathML 3 lets <mstyle> set the presentation attributes of its descendants;
// <math> accepts the same group. These names are not global attributes.
var mathMLStyleAttributes = [
    'dir', 'displaystyle', 'mathsize', 'mathvariant', 'scriptlevel',
    'form', 'fence', 'separator', 'lspace', 'rspace', 'stretchy', 'symmetric',
    'maxsize', 'minsize', 'largeop', 'movablelimits', 'accent', 'linebreak',
    'lquote', 'rquote', 'valign', 'width', 'height', 'depth',
    'linethickness', 'numalign', 'denomalign', 'bevelled',
    'scriptminsize', 'scriptsizemultiplier', 'infixlinebreakstyle', 'decimalpoint',
    'accentunder', 'align', 'subscriptshift', 'superscriptshift',
    'alignmentscope', 'columnalign', 'columnlines', 'columnspacing', 'columnspan',
    'columnwidth', 'equalcolumns', 'equalrows', 'frame', 'framespacing', 'groupalign',
    'minlabelspacing', 'rowalign', 'rowlines', 'rowspacing', 'rowspan', 'side',
    'selection'
];

var allowedMathMLAttributesByTag = {
    math: mathMLAttributes(['display', 'alttext'].concat(mathMLStyleAttributes)),
    mstyle: mathMLAttributes(mathMLStyleAttributes),

    mi: mathMLTokenAttributes,
    mn: mathMLTokenAttributes,
    mtext: mathMLTokenAttributes,
    mo: mathMLTokenAttributes.concat([
        'form', 'fence', 'separator', 'lspace', 'rspace', 'stretchy', 'symmetric',
        'maxsize', 'minsize', 'largeop', 'movablelimits', 'accent', 'linebreak'
    ]),
    ms: mathMLTokenAttributes.concat(['lquote', 'rquote']),
    mspace: mathMLTokenAttributes.concat(['width', 'height', 'depth', 'linebreak']),
    mglyph: mathMLAttributes(['mathsize', 'mathvariant', 'width', 'height', 'valign', 'alt']),

    mrow: mathMLAttributes(['dir']),
    mfrac: mathMLAttributes(['linethickness', 'numalign', 'denomalign', 'bevelled']),
    mpadded: mathMLAttributes(['width', 'height', 'depth', 'lspace', 'voffset']),
    msub: mathMLAttributes(['subscriptshift']),
    msup: mathMLAttributes(['superscriptshift']),
    msubsup: mathMLAttributes(['subscriptshift', 'superscriptshift']),
    mmultiscripts: mathMLAttributes(['subscriptshift', 'superscriptshift']),
    munder: mathMLAttributes(['accentunder', 'align']),
    mover: mathMLAttributes(['accent', 'align']),
    munderover: mathMLAttributes(['accent', 'accentunder', 'align']),

    mtable: mathMLAttributes([
        'align', 'rowalign', 'columnalign', 'groupalign', 'alignmentscope',
        'columnwidth', 'width', 'rowspacing', 'columnspacing', 'rowlines',
        'columnlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns',
        'displaystyle', 'side', 'minlabelspacing'
    ]),
    mtr: mathMLAttributes(['rowalign', 'columnalign', 'groupalign']),
    mtd: mathMLAttributes(['rowspan', 'columnspan', 'rowalign', 'columnalign', 'groupalign']),

    maction: mathMLAttributes(['actiontype', 'selection']),
    merror: mathMLAttributes(),
    mphantom: mathMLAttributes(),
    mprescripts: mathMLAttributes(),
    mroot: mathMLAttributes(),
    msqrt: mathMLAttributes(),
    none: mathMLAttributes(),

    // <semantics> is not a presentation element and does not take the common
    // mathcolor/mathbackground pair.
    semantics: ['encoding']
};

function isAllowedMathMLAttribute(tag, name) {
    var allowed = allowedMathMLAttributesByTag[tag] || [];
    return allowed.indexOf(name) > -1;
}

// HTML attributes are enumerated too, but the list is chosen the other way
// round. MathML's above is a large safe subset for each element; HTML's is a
// small subset of a huge vocabulary, because most of HTML's attributes are about
// behaviour rather than meaning and either do nothing in a reader (onclick,
// target, srcset) or actively break the file (style and class, which the
// generated stylesheet owns). Completeness is the goal there and would be a
// mistake here.
//
// What is here is the subset that changes what the chapter says. Everything on
// this list was previously dropped, and dropping it was not a loss of polish:
//
//   colspan, rowspan   a merged cell renders as an unmerged one, so every row
//                      after it is short and the columns stop lining up. This
//                      is a wrong table, not a less navigable one.
//   span               same, for a column group
//   start, reversed    a list that should read 7, 8, 9 renders 1, 2, 3
//   value              same, for one item in it
//   scope              the only cheap way to say which cells a header heads
//   lang               a chapter is tagged with one language; a quotation in
//                      another is what a nested lang is for, and a speech
//                      synthesiser reads it in the wrong voice without it
//   dir                bdo is on the allowed tag list and does nothing at all
//                      without dir, so an RTL run inside an LTR paragraph came
//                      out reversed
//   datetime, value    what <time> and <data> are for - without them both tags
//                      are a span
//   cite, title        the source of a quotation, the expansion of an
//                      abbreviation
//
// Deliberately still absent: the ARIA attributes and headers. role has to be
// valid against the vocabulary epubcheck knows or the file fails to validate,
// and a page's roles are written for a browser, not a reading system; headers
// and aria-labelledby name other ids, and an id whose element extraction
// dropped turns a helpful attribute into an unresolved reference, which is an
// error rather than a missing nicety.
//
// A value that does not check out is dropped rather than corrected. The chapter
// is XHTML read by a validator: colspan="two" is not a small blemish there.
function attrEnum(allowed) {
    return function(value) {
        var normalized = value.trim().toLowerCase();
        return allowed.indexOf(normalized) > -1 ? normalized : '';
    };
}

// Bounded on purpose: colspan="100000" is a page bug or an attack on the
// reader's layout engine, never a table.
function attrCount(min) {
    return function(value) {
        var normalized = value.trim();
        if (!/^[0-9]{1,4}$/.test(normalized)) {
            return '';
        }
        var number = parseInt(normalized, 10);
        return number >= min ? String(number) : '';
    };
}

// <img width> and <img height> are a count of pixels, and epubcheck rejects
// anything else: "100%" from a page, "16.296875" from a laid-out svg. Bounded
// like a count, since an image measured in five digits is a bug either way.
var attrDimension = attrCount(1);

// <ol start> and <li value> are the two that may be negative or zero
function attrInteger(value) {
    var normalized = value.trim();
    return /^-?[0-9]{1,9}$/.test(normalized) ? String(parseInt(normalized, 10)) : '';
}

function attrText(value) {
    return value.replace(/\s+/g, ' ').trim();
}

// datetime is a format, not free text, and epubcheck validates it: letting a
// page's junk through would turn a tag that carries a date into an error in the
// file. The subset here - a year, a month, a date, any of them with a time and
// an offset, or a bare time - is what pages actually write. The exotic
// remainder of the html grammar (weeks, durations, yearless dates) is dropped
// rather than guessed at, which costs the attribute and keeps the element.
//
// The shape is only half the test. dateTimeFieldsAreValid() from utils.js is
// the other half, and the split is deliberate: this regex says what spellings
// are accepted here, which is a different question from whether "2024-02-31"
// and "29:70" name a moment - and that second question has the same answer for
// dc:date, which asks it with a different spelling.
var DATETIME_REGEX = new RegExp(
    '^(' +
        '[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?' +
        '([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,3})?)?' +
            '(Z|[+-][0-9]{2}:?[0-9]{2})?)?' +
    '|' +
        '[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,3})?)?' +
    ')$');

function attrDateTime(value) {
    var normalized = value.trim();
    return DATETIME_REGEX.test(normalized) && dateTimeFieldsAreValid(normalized) ?
        normalized : '';
}

// A url attribute that is not the one being followed for content - <blockquote
// cite> and <del cite> point at a source, and nothing in the archive depends on
// them resolving, but they are still urls a reader may open.
function attrUrl(value, options) {
    return options.resolveUrl(value.trim());
}

// Valid on every element, so they are checked before the per-tag table
var globalHtmlAttributes = {
    lang: normalizeLanguageTag,
    dir: attrEnum(['ltr', 'rtl', 'auto'])
};

var htmlAttributes = {
    a: {},
    abbr: {title: attrText},
    blockquote: {cite: attrUrl},
    q: {cite: attrUrl},
    del: {cite: attrUrl, datetime: attrDateTime},
    ins: {cite: attrUrl, datetime: attrDateTime},
    time: {datetime: attrDateTime},
    data: {value: attrText},
    // A boolean attribute is true because it is there, whatever it says - and
    // XHTML has no bare form, so it is written back out in the long one
    ol: {start: attrInteger, reversed: function() { return 'reversed'; }},
    li: {value: attrInteger},
    col: {span: attrCount(1)},
    colgroup: {span: attrCount(1)},
    // rowspan="0" is legal and means "to the end of the section"; colspan="0" is
    // not, which is why the two have different floors
    td: {colspan: attrCount(1), rowspan: attrCount(0)},
    th: {colspan: attrCount(1), rowspan: attrCount(0), scope: attrEnum(['row', 'col', 'rowgroup', 'colgroup'])}
};

// walkHtmlFragment hands over values the HTML parser has already decoded, so
// they only need escaping - decoding here as well would turn a literal
// "&amp;lt;" on the page into a "<" in the epub
function attrValue(value) {
    return escapeXMLChars(value == null ? '' : String(value));
}

// The id, the globals and whatever the tag itself allows. Attributes the caller
// has already written - src, alt, href, class and the img dimensions - are not
// in any of these tables and cannot be duplicated from here.
function extraHtmlAttributes(tag, attrs, options) {
    let result = '';
    let perTag = htmlAttributes[tag] || {};
    // A page is free to write the same attribute twice. The parser hands both
    // over, and writing both would make the chapter unparseable.
    let written = new Set();

    for (let i = 0; i < attrs.length; i++) {
        let name = String(attrs[i].name).toLowerCase();
        let rawValue = attrs[i].value == null ? '' : String(attrs[i].value);

        if (written.has(name)) {
            continue;
        }

        if (name === 'id') {
            if (!isUsableId(rawValue) || options.usedIds.has(rawValue)) {
                continue;
            }
            options.usedIds.add(rawValue);
            written.add(name);
            result += ' id="' + attrValue(rawValue) + '"';
            continue;
        }

        let filter = globalHtmlAttributes[name] || perTag[name];
        if (!filter) {
            continue;
        }
        let value = filter(rawValue, options);
        if (value === '') {
            continue;
        }
        written.add(name);
        result += ' ' + name + '="' + attrValue(value) + '"';
    }

    return result;
}

// ---- which source an <img> actually names -----------------------------------
//
// A lazy loader ships an <img> that does not name its own picture: the real url
// waits in a data attribute until a script decides the image is close enough to
// the viewport, and src holds either nothing or a placeholder - very often a 1x1
// gif, which is the same file the page's tracking pixels are. Reading src alone
// is why a lazily loaded page arrived in the book with the photographs missing
// and the 1x1s embedded in their place, which is worse than a gap because
// nothing in the book says anything is absent.
//
// There is no standard here - every loader picked its own attribute name - so
// this is the list of the ones in wide use rather than a specification.
var LAZY_IMAGE_SRC_ATTRIBUTES = [
    'data-src', 'data-original', 'data-original-src', 'data-lazy-src',
    'data-lazy', 'data-echo', 'data-full-src', 'data-hi-res-src',
    'data-image-src', 'data-actualsrc', 'data-url'
];

// The same idea for responsive images: a set of candidates parked out of the
// browser's reach until the loader moves it into srcset.
var LAZY_IMAGE_SRCSET_ATTRIBUTES = [
    'data-srcset', 'data-lazy-srcset', 'data-original-set'
];

// What a placeholder looks like when its url is all there is to go on. Both
// tests are guesses - a short data uri can be a real picture, and a file really
// can be called spacer.png - so a match only ever demotes a source below a
// better candidate. Nothing here drops an image on its own: an unreplaced
// placeholder is still shipped, exactly as before, because guessing wrong in
// that direction would lose content the page really did have.
var PLACEHOLDER_IMAGE_NAME_REGEX =
    /(^|[/_.-])(blank|spacer|placeholder|transparent|pixel|dummy|empty|loading|loader|lazy)([_.-]|$)/i;
// A 1x1 gif is 62 characters as a data uri and an inline "loading" svg is not
// much more; a photograph is thousands.
var MAX_PLACEHOLDER_DATA_URI_LENGTH = 512;

function isPlaceholderImageSrc(value) {
    let text = String(value == null ? '' : value).trim();
    if (text === '') {
        return true;
    }
    if (/^data:/i.test(text)) {
        return text.length <= MAX_PLACEHOLDER_DATA_URI_LENGTH;
    }
    let path = text.split(/[?#]/)[0];
    let fileName = path.substring(path.lastIndexOf('/') + 1);
    // "1x1.gif", "2x2.png" - the other way the file is usually named
    if (/^[0-9]{1,3}x[0-9]{1,3}\.[a-z0-9]+$/i.test(fileName)) {
        return true;
    }
    return PLACEHOLDER_IMAGE_NAME_REGEX.test(fileName);
}

// The url a srcset names, at the largest size it offers. A book has no viewport
// to select against, and of the sizes on offer the largest is the only one that
// cannot have thrown detail away.
//
// Splitting the list on every comma is what a srcset parser must not do: a data
// uri carries commas inside the url itself, and html reads a candidate's url as
// a run of non-whitespace before it looks for a separator at all. Splitting
// naively hands back the tail of the base64 as if it were a filename.
function parseSrcset(value) {
    let text = String(value == null ? '' : value).trim();
    let candidates = [];
    let at = 0;
    while (at < text.length) {
        while (at < text.length && /[\s,]/.test(text.charAt(at))) {
            at++;
        }
        let urlStart = at;
        while (at < text.length && !/\s/.test(text.charAt(at))) {
            at++;
        }
        let url = text.substring(urlStart, at);
        if (url === '') {
            continue;
        }
        let descriptor = '';
        let trimmed = url.replace(/,+$/, '');
        if (trimmed === url) {
            // no comma ended the url, so what follows it up to the next comma
            // is this candidate's descriptor
            let descriptorStart = at;
            while (at < text.length && text.charAt(at) !== ',') {
                at++;
            }
            descriptor = text.substring(descriptorStart, at).trim().split(/\s+/)[0] || '';
        }
        if (trimmed !== '') {
            candidates.push({url: trimmed, descriptor: descriptor});
        }
    }
    return candidates;
}

function pickFromSrcset(value) {
    let candidates = parseSrcset(value);
    if (candidates.length === 0) {
        return '';
    }
    // A set that offers a real picture and a placeholder is offering one image.
    let real = candidates.filter(function (candidate) {
        return !isPlaceholderImageSrc(candidate.url);
    });
    let usable = real.length > 0 ? real : candidates;
    let best = '';
    let bestWeight = -1;
    usable.forEach(function (candidate) {
        // "800w" and "2x" - a srcset may not mix the two, so comparing the bare
        // numbers is enough. An absent descriptor means 1x.
        let weight = /^[0-9.]+[wx]$/i.test(candidate.descriptor) ?
                     parseFloat(candidate.descriptor) : 1;
        if (weight > bestWeight) {
            bestWeight = weight;
            best = candidate.url;
        }
    });
    return best;
}

// The image types an epub 3.3 reading system must support. The same set
// getFileExtension() accepts, written as media types rather than as extensions
// because that is how a <source> states its format - avif is the one that
// matters, and it is absent from both lists for the same reason.
var EMBEDDABLE_IMAGE_MEDIA_TYPES = [
    'image/png', 'image/gif', 'image/jpeg', 'image/svg+xml', 'image/webp'
];

// The urls a <picture>'s <source> elements name, best first.
//
// A <picture> is one image written several ways: every <source> above the <img>
// is a better encoding for a browser that can decode it, and the <img> itself is
// the fallback that every browser can. Which one was chosen is a question only
// the live page can answer - that is currentSrc - so this is what is left when
// the markup is all there is: the inside of a same-origin iframe, a chapter
// re-sanitized after the page is gone.
//
// Document order, except that a source naming a format the book cannot hold
// sorts last. An avif written first is the ordinary shape of a <picture> today,
// and taking it because it came first loses the image at the download stage,
// where the jpeg underneath it would have arrived intact.
function pictureSourceUrls(sources) {
    let embeddable = [];
    let foreign = [];
    (sources || []).forEach(function (source) {
        let url = pickFromSrcset(source && source.srcset);
        if (url === '') {
            return;
        }
        // "image/jpeg; charset=..." is not a thing a <source> should say, but a
        // parameter is legal in the attribute and must not hide the type.
        let type = String(source.type == null ? '' : source.type)
                   .split(';')[0].trim().toLowerCase();
        if (type !== '' && EMBEDDABLE_IMAGE_MEDIA_TYPES.indexOf(type) < 0) {
            foreign.push(url);
        } else {
            embeddable.push(url);
        }
    });
    return embeddable.concat(foreign);
}

// A tag's attributes as a lookup. No prototype: an attribute the page called
// "constructor" must read as absent, not as a function. First wins, which is
// what the html parser does with a repeated attribute.
function attributeMap(attrs) {
    let map = Object.create(null);
    for (let i = 0; i < attrs.length; i++) {
        if (!(attrs[i].name in map)) {
            map[attrs[i].name] = attrs[i].value;
        }
    }
    return map;
}

// Every source an <img> offers, best first, for the caller to try in order until
// one of them resolves. Reading them in a fixed order rather than taking the
// first that exists is what keeps a placeholder from beating the picture it
// stands in for.
//
// getAttribute is the element's, or a lookup into the parsed attributes - this
// runs on both a live element and a tag in a string. currentSrc is the live
// browser's own answer to "which candidate did this element pick", which nothing
// downstream can work out for itself, and is null off the live page.
// renderedPlaceholder says the element finished loading a 1x1, which is a fact
// about the bytes rather than a guess about the url, and the strongest signal
// there is that src is standing in for something. pictureSources are the
// <source> elements of the <picture> this <img> is inside, in document order,
// and matter for the same reason: off the live page they are the only place its
// real image is named.
function imageSrcCandidates(getAttribute, currentSrc, renderedPlaceholder, pictureSources) {
    let attr = function (name) {
        let value = getAttribute(name);
        return String(value == null ? '' : value).trim();
    };
    let src = attr('src');
    // The source that produced a 1x1 bitmap is that placeholder's own, whatever
    // its url looks like.
    let current = renderedPlaceholder ? '' : String(currentSrc == null ? '' : currentSrc).trim();
    let usingPlaceholder = src === '' || renderedPlaceholder || isPlaceholderImageSrc(src);

    let candidates = [];
    let add = function (value) {
        if (value !== '' && candidates.indexOf(value) < 0) {
            candidates.push(value);
        }
    };
    let addSelected = function () {
        // A responsive image states a fallback in src and the real choice in
        // srcset; currentSrc is that choice, already resolved.
        if (!isPlaceholderImageSrc(current)) {
            add(current);
        }
    };

    if (!usingPlaceholder) {
        addSelected();
        add(src);
    }
    LAZY_IMAGE_SRC_ATTRIBUTES.forEach(function (name) { add(attr(name)); });
    LAZY_IMAGE_SRCSET_ATTRIBUTES.forEach(function (name) { add(pickFromSrcset(attr(name))); });
    let pictureUrls = pictureSourceUrls(pictureSources);
    if (usingPlaceholder) {
        addSelected();
        // srcset with no src at all, which the browser resolves and an offline
        // reader cannot
        add(pickFromSrcset(attr('srcset')));
        // ...and the same set one element up, for a responsive <picture> whose
        // <img> carries nothing but the alt text
        pictureUrls.forEach(add);
        // Last, and only because dropping an image the page did ship is the
        // worse mistake: everything above this line is a guess.
        add(src);
    }
    // Behind src for an image that named a real one: the other encodings of a
    // <picture> are the same picture, so they are worth trying if that src turns
    // out not to resolve, but never ahead of it. The <img> is the encoding the
    // page guaranteed every reader can open, which is the book's position too.
    pictureUrls.forEach(add);
    return candidates;
}

// ---- where urls and images resolve ------------------------------------------
//
// The only part of sanitizing that depends on where the content came from.
// Extraction has a live page to resolve relative references against and images
// it is about to download; the editor page has neither - what it hands back is
// content this module already wrote once, edited in place. So the defaults below
// are the editor's: keep what is already resolved, drop what cannot be.

// An image reference that names a file in the archive, as getImageSrc() writes
// it. Anything else - a url the user pasted in, a leftover reference from a
// chapter buffered by an older version - would point at a resource the book does
// not contain, which fails the whole book rather than one picture.
var ARCHIVE_IMAGE_SRC_REGEX = /^(?:\.{1,2}\/)*images\/[^/?#]+$/i;

function keepArchiveImageSrc(value) {
    let text = String(value == null ? '' : value).trim();
    return ARCHIVE_IMAGE_SRC_REGEX.test(text) ? text : '';
}

// A url that is already absolute is kept as it stands. A relative one has
// nothing to resolve against here - the editor page's own address is certainly
// not it - so it loses its href and keeps its text.
function keepAbsoluteUrl(value) {
    let text = String(value == null ? '' : value).trim();
    if (text === '' || !isSafeLinkUrl(text)) {
        return '';
    }
    try {
        return new URL(text).href;
    } catch (e) {
        return '';
    }
}

// ...and a link into the chapter itself stays one. resolveInternalLinks() drops
// the ones whose target did not survive, at build time, when the ids are final.
function keepKnownHref(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.indexOf('#') === 0) {
        return isUsableId(text.substring(1)) ? text : '';
    }
    return keepAbsoluteUrl(text);
}

function sanitizeOptions(overrides) {
    let options = {
        // an <img src> as the page wrote it -> the src to write, or '' to drop
        // the image along with its tag
        resolveImageSrc: keepArchiveImageSrc,
        // an <a href> -> the href to write, or '' to keep the text and drop the
        // link
        resolveLinkHref: keepKnownHref,
        // every other url-valued attribute - see attrUrl
        resolveUrl: keepAbsoluteUrl,
        // Which attribute carries the generated css class name. Extraction marks
        // the clone with data-class, because a class attribute at that point is
        // still the page's own and must not survive; by the time the content is
        // written the generated name is what the class attribute holds, so
        // re-sanitizing reads it from there.
        classAttribute: 'class',
        // Ids already written into this chapter, so that a page repeating one -
        // invalid html, but common - does not repeat it here. Shared across
        // calls by a caller producing one chapter from several fragments.
        usedIds: new Set()
    };
    if (overrides) {
        Object.keys(overrides).forEach(function(key) {
            if (overrides[key] !== undefined && overrides[key] !== null) {
                options[key] = overrides[key];
            }
        });
    }
    return options;
}

// ---- the sanitizer ----------------------------------------------------------

function parseHTML(rawContentString, options) {
    options = options || sanitizeOptions();
    let results = '';
    let lastFragment = '';
    // Tags written to the output that still need a closing tag. Kept here rather
    // than trusting the input to be balanced: a page can close tags it never
    // opened, or leave tags open, and the epub still has to be valid XML.
    let openTags = [];
    // Tags whose content is being dropped, innermost last
    let skippedTags = [];
    // The <source> elements of the <picture> currently open, in document order.
    // <picture> is not an allowed tag, so it is unwrapped and its sources are
    // dropped - but they are where the image is named when there is no live
    // element to ask for currentSrc, so they are held until the <img> they
    // belong to is written. See imageSrcCandidates.
    let pictureSources = [];
    let inPicture = false;

    let isVoidTag = (tag) => voidTags.indexOf(tag) > -1;

    let closeTagsDownTo = (index) => {
        for (let i = openTags.length - 1; i >= index; i--) {
            results += '</' + openTags[i] + '>';
        }
        openTags.length = index;
    };

    try {
        walkHtmlFragment(rawContentString, {
            start: function(tag, attrs, unary) {
                if (skippedTags.length > 0) {
                    // Inside dropped content - track nesting so that the matching
                    // end tag, and only it, ends the skip
                    if (!unary && !isVoidTag(tag)) {
                        skippedTags.push(tag);
                    }
                    return;
                }

                if (tag === 'picture') {
                    inPicture = true;
                    pictureSources = [];
                } else if (tag === 'source' && inPicture) {
                    let sourceAttrs = attributeMap(attrs);
                    let srcset = '';
                    ['srcset'].concat(LAZY_IMAGE_SRCSET_ATTRIBUTES).forEach(function (name) {
                        if (srcset === '') {
                            srcset = String(sourceAttrs[name] == null ? '' : sourceAttrs[name]).trim();
                        }
                    });
                    if (srcset !== '') {
                        pictureSources.push({srcset: srcset, type: sourceAttrs['type']});
                    }
                }

                if (allowedTags.indexOf(tag) < 0) {
                    if (strippedContentTags.indexOf(tag) > -1 && !unary && !isVoidTag(tag)) {
                        skippedTags.push(tag);
                    }
                    return;
                }

                let tmpAttrsTxt = '';

                if (tag === 'img') {
                    // The source is written first because choosing it needs
                    // every attribute of the tag at once - see
                    // imageSrcCandidates - rather than the one named src.
                    let tagAttrs = attributeMap(attrs);
                    // Consumed here rather than at </picture>: a page that never
                    // closes the element can then mislead at most this one <img>,
                    // and a <picture> holds exactly one anyway.
                    let sources = pictureSources;
                    pictureSources = [];
                    let tmpSrc = '';
                    // Off the live page there is no currentSrc and no loaded
                    // bitmap to measure: extraction has already resolved those
                    // into src by the time the markup gets here, and content
                    // that never had a live element - the inside of a same-origin
                    // iframe, a chapter being re-sanitized - never had them at all.
                    let srcCandidates = imageSrcCandidates(function (name) {
                        return tagAttrs[name];
                    }, null, false, sources);
                    for (let i = 0; i < srcCandidates.length; i++) {
                        tmpSrc = options.resolveImageSrc(srcCandidates[i]);
                        if (tmpSrc !== '') {
                            break;
                        }
                    }
                    if (tmpSrc === '') {
                        // ignore imgs without source
                        return;
                    }
                    tmpAttrsTxt += ' src="' + attrValue(tmpSrc) + '"';
                    // null and '' are different answers: null is a source that
                    // never said anything about this image, '' is one that
                    // deliberately marked it decorative. Collapsing them - which
                    // is what writing alt="" on everything did - turns every
                    // undescribed image into a false claim that it needs no
                    // description, and the accessibility metadata is computed
                    // from exactly this distinction.
                    let tmpAlt = null;
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'alt') {
                            tmpAlt = attrs[i].value == null ? '' : String(attrs[i].value);
                        } else if (attrs[i].name === options.classAttribute) {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        } else if (attrs[i].name === 'width' || attrs[i].name === 'height') {
                            // used when converting svg to img - the result image was too big.
                            // Whatever wrote it, the value has to be an integer
                            // number of pixels here: a page writing width="100%"
                            // and a laid-out svg measuring 16.296875 are both
                            // errors in the chapter, not sizes.
                            let dimension = attrDimension(attrs[i].value);
                            if (dimension !== '') {
                                tmpAttrsTxt += ' ' + attrs[i].name + '="' + dimension + '"';
                            }
                        }
                    }
                    if (tmpAlt !== null) {
                        tmpAttrsTxt += ' alt="' + attrValue(tmpAlt.replace(/\s+/g, ' ').trim()) + '"';
                    }
                } else if (tag === 'a') {
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'href') {
                            let href = options.resolveLinkHref(attrs[i].value);
                            if (href !== '') {
                                tmpAttrsTxt += ' href="' + attrValue(href) + '"';
                            }
                        } else if (attrs[i].name === options.classAttribute) {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                } else if (mathMLTags.indexOf(tag) > -1) {
                    if (tag === 'math') {
                        // in xhtml, MathML is only MathML because of this
                        tmpAttrsTxt += ' xmlns="' + MATHML_NS + '"';
                    }
                    for (let i = 0; i < attrs.length; i++) {
                        if (isAllowedMathMLAttribute(tag, attrs[i].name)) {
                            tmpAttrsTxt += ' ' + attrs[i].name + '="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                } else {
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === options.classAttribute) {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                }

                // MathML has been through its own allowlist just above, which
                // is the complete answer for a MathML element: the html list
                // holds names MathML either does not define (lang, colspan,
                // datetime) or defines itself and is written above (dir), plus
                // ids, which are denied inside a formula on purpose. Running
                // both would only put back what the MathML list left out.
                if (mathMLTags.indexOf(tag) < 0) {
                    tmpAttrsTxt += extraHtmlAttributes(tag, attrs, options);
                }

                // A void tag, or a tag the page self-closed ("<span/>"), never gets
                // an end callback - close it here or the output is unbalanced
                if (isVoidTag(tag) || unary) {
                    lastFragment = '<' + tag + tmpAttrsTxt + '/>';
                } else {
                    lastFragment = '<' + tag + tmpAttrsTxt + '>';
                    openTags.push(tag);
                }

                results += lastFragment;
                lastFragment = '';
            },
            end: function(tag) {
                if (skippedTags.length > 0) {
                    for (let i = skippedTags.length - 1; i >= 0; i--) {
                        if (skippedTags[i] === tag) {
                            skippedTags.length = i;
                            return;
                        }
                    }
                    // End tag for something never opened inside the dropped content
                    return;
                }

                if (tag === 'picture') {
                    inPicture = false;
                    pictureSources = [];
                }

                if (allowedTags.indexOf(tag) < 0 || isVoidTag(tag)) {
                    return;
                }

                for (let i = openTags.length - 1; i >= 0; i--) {
                    if (openTags[i] === tag) {
                        // Anything still open inside it was never closed by the page
                        closeTagsDownTo(i);
                        return;
                    }
                }
                // End tag without a matching start tag - dropped
            },
            chars: function(text) {
                if (skippedTags.length > 0) {
                    return;
                }
                // already decoded by the parser - see attrValue above
                results += escapeXMLText(text);
            },
            comment: function(text) {
                // results += "<!--" + text + "-->";
            }
        });

        // Whatever the page left open
        closeTagsDownTo(0);

        return results;

    } catch (e) {
        console.log('Error:', e);
        // Keep the part that was parsed before the error rather than losing the
        // whole page, but close it first so the epub stays valid
        try {
            closeTagsDownTo(0);
        } catch (e2) {
            console.log('Error:', e2);
        }
        return results;
    }

}

// The entry point for a caller holding a chapter that has already been through
// extraction - the editor, after the user has changed something. The result is
// safe to store as page.content and to hand to the build stage.
function sanitizeChapterContent(content) {
    return parseHTML(String(content == null ? '' : content), sanitizeOptions());
}
