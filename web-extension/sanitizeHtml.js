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
// The vocabulary is allowed wholesale rather than enumerated, which is the
// opposite of how the HTML attributes below are handled and deliberately so:
// MathML's is a closed vocabulary defined by a spec, an attribute this extension
// has not heard of is far more likely to be one MathML has than one an attacker
// invented, and a list of thirty names would go out of date silently. What is
// excluded is what is dangerous, or what would break the file:
//
//   on*             event handlers
//   href, src       MathML's own link and image attributes. href can hold a
//                   javascript: url, and src would point at a file that is not
//                   in the archive.
//   style, class    the chapter stylesheet is generated from computed styles,
//                   never copied from the page
//   id, data-*      an html id is carried over - it is what a link inside the
//                   page points at - but nothing ever links into a formula, and
//                   an id here would only be one more name the ids minted while
//                   the chapter is written have to avoid colliding with
//   anything with a colon, or that is not a plain lowercase name. An xmlns: or
//   xlink: attribute needs a namespace declaration the chapter documents do not
//   make, and an undeclared prefix does not make one formula wrong, it makes the
//   whole xhtml file unparseable.
var deniedMathMLAttributes = ['href', 'src', 'style', 'class', 'id', 'xmlns'];

function isAllowedMathMLAttribute(name) {
    return /^[a-z][a-z0-9-]*$/.test(name) &&
           name.indexOf('on') !== 0 &&
           name.indexOf('data-') !== 0 &&
           deniedMathMLAttributes.indexOf(name) < 0;
}

// HTML attributes are enumerated, where MathML's are allowed wholesale. The
// vocabularies differ in the way that matters: HTML's is huge, mostly about
// behaviour rather than meaning, and full of names that either do nothing in a
// reader (onclick, target, srcset) or actively break the file (style and class,
// which the generated stylesheet owns).
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
    return DATETIME_REGEX.test(normalized) ? normalized : '';
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

                if (allowedTags.indexOf(tag) < 0) {
                    if (strippedContentTags.indexOf(tag) > -1 && !unary && !isVoidTag(tag)) {
                        skippedTags.push(tag);
                    }
                    return;
                }

                let tmpAttrsTxt = '';

                if (tag === 'img') {
                    let tmpSrc = ''
                    // null and '' are different answers: null is a source that
                    // never said anything about this image, '' is one that
                    // deliberately marked it decorative. Collapsing them - which
                    // is what writing alt="" on everything did - turns every
                    // undescribed image into a false claim that it needs no
                    // description, and the accessibility metadata is computed
                    // from exactly this distinction.
                    let tmpAlt = null;
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'src') {
                            tmpSrc = options.resolveImageSrc(attrs[i].value)
                            tmpAttrsTxt += ' src="' + attrValue(tmpSrc) + '"';
                        } else if (attrs[i].name === 'alt') {
                            tmpAlt = attrs[i].value == null ? '' : String(attrs[i].value);
                        } else if (attrs[i].name === options.classAttribute) {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        } else if (attrs[i].name === 'width') {
                            // used when converting svg to img - the result image was too big
                            tmpAttrsTxt += ' width="' + attrValue(attrs[i].value) + '"';
                        } else if (attrs[i].name === 'height') {
                            // used when converting svg to img - the result image was too big
                            tmpAttrsTxt += ' height="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                    if (tmpSrc === '') {
                        // ignore imgs without source
                        return;
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
                        if (isAllowedMathMLAttribute(attrs[i].name)) {
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

                // MathML has been through its own allowlist just above, and the
                // two vocabularies do not share attributes - lang and dir mean
                // nothing on an <mrow>, and an id there is denied on purpose.
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
