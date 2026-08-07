function setIncludeStyle(includeStyle) {
    chrome.runtime.sendMessage({
        type: "set include style",
        includeStyle: includeStyle
    }, function(response) {
    });
}

function getIncludeStyle(callback) {
    chrome.runtime.sendMessage({
        type: "get include style"
    }, function(response) {
        callback(response.includeStyle);
    });
}

function setCurrentStyle(currentStyle) {
    chrome.runtime.sendMessage({
        type: "set current style",
        currentStyle: currentStyle
    }, function(response) {
    });
}

function getCurrentStyle(callback) {
    chrome.runtime.sendMessage({
        type: "get current style"
    }, function(response) {
        callback(response.currentStyle);
    });
}

function getStyles(callback) {
    chrome.runtime.sendMessage({
        type: "get styles"
    }, function(response) {
        callback(response.styles);
    });
}

function setStyles(styles) {
    chrome.runtime.sendMessage({
        type: "set styles",
        styles: styles
    }, function(response) {
    });
}

function getEbookTitle(callback) {
    chrome.runtime.sendMessage({
        type: "get title"
    }, function(response) {
        callback(response.title);
    });
}

function saveEbookTitle(title) {
    chrome.runtime.sendMessage({
        type: "set title",
        title: title
    }, function(response) {
    });
}

// The book-wide stylesheet, kept beside the title and the identifier because it
// belongs to the book being assembled rather than to any one chapter - and is
// discarded with them. Not to be confused with the per-site styles behind
// getStyles(): those are applied to a page while it is being captured and
// outlive any single book.
function getBookCss(callback) {
    chrome.runtime.sendMessage({
        type: "get book css"
    }, function(response) {
        callback(response && typeof response.css === 'string' ? response.css : '');
    });
}

function saveBookCss(css) {
    chrome.runtime.sendMessage({
        type: "set book css",
        css: css
    }, function(response) {
    });
}

// What the user typed about the book in the chapter editor - authors, language,
// publisher, description, date. Stored beside the title and the stylesheet, as
// one object, because it belongs to the book being assembled and is discarded
// with it. Every field is optional: an empty one is not an empty value, it is
// the book falling back to what the chapters say - see getPageMetadata() and
// getBookLanguage() in saveEbook.js.
//
// Held as the user typed it rather than normalized on the way in, so that
// reopening the editor shows what was written even when it is not usable;
// normalizeMetadataOverride() is where it becomes a value the package can carry.
function getBookMetadata(callback) {
    chrome.runtime.sendMessage({
        type: "get book metadata"
    }, function(response) {
        callback(response && response.metadata ? response.metadata : null);
    });
}

function saveBookMetadata(metadata) {
    chrome.runtime.sendMessage({
        type: "set book metadata",
        metadata: metadata
    }, function(response) {
    });
}

// The identifier of the ebook being assembled from chapters. Minted once by the
// background and kept next to the chapters, because dc:identifier is what a
// library uses to decide whether a file is a new book or a newer copy of one it
// already has - a fresh id on every rebuild turns re-downloads into duplicates.
function getEbookUuid(callback) {
    chrome.runtime.sendMessage({
        type: "get uuid"
    }, function(response) {
        callback(response && response.uuid ? response.uuid : null);
    });
}

// crypto.randomUUID() only exists in a secure context, and a content script on a
// plain http page is not one - so saving from those pages would otherwise have
// no identifier at all. getRandomValues() has no such restriction.
function generateUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    let bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += (bytes[i] + 0x100).toString(16).substring(1);
    }
    return hex.substring(0, 8) + '-' + hex.substring(8, 12) + '-' +
           hex.substring(12, 16) + '-' + hex.substring(16, 20) + '-' + hex.substring(20);
}

function getEbookPages(callback) {
    chrome.runtime.sendMessage({
        type: "get"
    }, function(response) {
        callback(response.allPages);
    });
}

function saveEbookPages(pages) {
    chrome.runtime.sendMessage({
        type: "set",
        pages: pages
    }, function(response) {});
}

function removeEbook() {
    chrome.runtime.sendMessage({
        type: "remove"
    }, function(response) {});
}

function checkIfBusy(callback) {
    chrome.runtime.sendMessage({
        type: "is busy?"
    }, function(response) {
        callback(response);
    });
}

/////
function getCurrentUrl() {
    let url = window.location.href;
    if (url.indexOf('?') > 0) {
        url = window.location.href.split('?')[0];
    }
    url = url.substring(0, url.lastIndexOf('/') + 1);
    return url;
}

// A BCP 47 well-formedness check, not a registry lookup - enough to reject what
// pages actually put in lang="" while letting through anything a reader could
// use. It matters because dc:language was a hardcoded but always-valid "en":
// replacing it with whatever the page claims is only an improvement if the junk
// ("", "javascript", "{{locale}}") is filtered out first. Underscores are
// repaired rather than rejected - lang="en_US" is invalid html, but its intent
// is not in doubt.
function normalizeLanguageTag(raw) {
    if (!raw || typeof raw !== 'string') {
        return '';
    }
    let subtags = raw.trim().replace(/_/g, '-').split('-');
    // The primary subtag is an ISO 639 code. The 4-8 letter range is reserved or
    // registered and no real page uses it, so excluding it here is what stops
    // "javascript" and "default" from being taken for languages.
    if (!/^[a-zA-Z]{2,3}$/.test(subtags[0])) {
        return '';
    }
    for (let i = 1; i < subtags.length; i++) {
        if (!/^[a-zA-Z0-9]{1,8}$/.test(subtags[i])) {
            return '';
        }
    }
    // Conventional casing - language lower, script title, region upper. Tags are
    // case insensitive, so this is cosmetic, but it keeps en-US out of the file
    // spelled three different ways.
    return subtags.map(function(subtag, index) {
        if (index === 0) {
            return subtag.toLowerCase();
        }
        if (/^[a-zA-Z]{4}$/.test(subtag)) {
            return subtag.charAt(0).toUpperCase() + subtag.substring(1).toLowerCase();
        }
        if (/^[a-zA-Z]{2}$/.test(subtag)) {
            return subtag.toUpperCase();
        }
        return subtag.toLowerCase();
    }).join('-');
}

function yearIsPlausible(year) {
    let value = parseInt(year, 10);
    return value >= 1400 && value <= new Date().getFullYear() + 1;
}

// dc:date must be a W3C-DTF date, and pages supply everything from "2024-03-01"
// to "Fri, 01 Mar 2024 09:00:00 GMT". So does a user typing one into the editor,
// which is the other reason this lives here rather than in extractHtml.js: the
// editor page never loads the content script, and both ends have to agree on
// what a date is.
function normalizeDate(raw) {
    if (!raw || typeof raw !== 'string') {
        return '';
    }
    let text = raw.trim();
    // Already well formed: keep it verbatim rather than round-tripping through
    // Date, which would shift a local timestamp into UTC and invent a time of
    // day for a bare date.
    if (/^\d{4}$/.test(text) ||
        /^\d{4}-\d{2}$/.test(text) ||
        /^\d{4}-\d{2}-\d{2}$/.test(text) ||
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
        return yearIsPlausible(text.substring(0, 4)) ? text : '';
    }
    let parsed = new Date(text);
    if (isNaN(parsed.getTime()) || !yearIsPlausible(parsed.getUTCFullYear())) {
        return '';
    }
    return parsed.toISOString().replace(/\.[0-9]+Z$/, 'Z');
}

// An id has to be an XML name to be addressable at all. Ids only need to be
// unique within one xhtml file, and a chapter is exactly one file, so nothing
// here has to be unique across the book.
//
// Lives in utils.js rather than in either of its two callers because extraction
// and writing have to agree on it exactly: extractHtml.js decides which ids
// survive from the page, saveEbook.js mints the ones the headings need and has
// to avoid colliding with them.
function isUsableId(id) {
    return /^[A-Za-z_][-A-Za-z0-9_.]*$/.test(id);
}

// Schemes that do something other than address a document. javascript: is the
// one that matters - it is inert in most readers but not all, and epubcheck
// rejects it - and the rest either execute or point outside the archive.
//
// The test is on the href as the page wrote it, before it is resolved: a
// relative link has no scheme, and resolving it first would give everything the
// scheme of the page and hide the ones being looked for. Control characters go
// first because "java\tscript:" is a url browsers still follow.
var deniedUrlSchemes = /^(javascript|data|vbscript|blob|filesystem):/i;

function isSafeLinkUrl(rawHref) {
    return !deniedUrlSchemes.test(String(rawHref).replace(/[\u0000-\u0020]/g, ''));
}

// The address the chapter was taken from, for dc:source. Deliberately not
// getCurrentUrl(): that one drops the query and the last path segment because it
// is a base for resolving relative links, which makes it point at the directory
// rather than the article. Only the fragment goes - it addresses a position
// inside the page, not the page.
function getPageSourceUrl() {
    let url = window.location.href;
    let hash = url.indexOf('#');
    return hash > -1 ? url.substring(0, hash) : url;
}

function getOriginUrl() {
    let originUrl = window.location.origin;
    if (!originUrl) {
        originUrl = window.location.protocol + "//" + window.location.host;
    }
    return originUrl;
}

function getFileExtension(fileName) {
    try {
        let tmpFileName = '';

        if (isBase64Img(fileName)) {
            tmpFileName = getBase64ImgType(fileName);
        } else {
            // Strip URL-only components before looking for the last dot. Doing
            // this afterwards mistakes /image?format=.png for a PNG filename.
            tmpFileName = fileName.split(/[?#]/)[0].split('.').pop();
        }

        // A data URI type cannot normally contain either delimiter, but keeping
        // this here makes the normalization common to both input forms.
        tmpFileName = tmpFileName.split(/[?#]/)[0];
        tmpFileName = tmpFileName.toLowerCase();
        if (tmpFileName === 'jpg') {
            tmpFileName = 'jpeg';
        } else if (tmpFileName === 'svg+xml') {
            tmpFileName = 'svg';
        } 

        // The epub 3.3 core image types. A reading system must support all of
        // these, so any of them can be embedded as-is with no fallback; anything
        // outside the list is a foreign resource, which needs one. webp joined
        // the list in 3.3 - avif deliberately did not.
        if (['png', 'gif', 'jpeg', 'svg', 'webp'].indexOf(tmpFileName.trim()) < 0) {
            return ''
        }
        return tmpFileName;
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
}

// The first `count` bytes as lowercase hex. Every byte is two characters:
// unpadded, a 0x04 would read as "4" and shift every byte after it along.
function magicBytes(data, count) {
    let arr = (new Uint8Array(data)).subarray(0, count);
    let header = '';
    for (let i = 0; i < arr.length; i++) {
        header += arr[i].toString(16).padStart(2, '0');
    }
    return header;
}

// The file extension for downloaded bytes whose url did not name one. Returns ''
// when the bytes are not an image this build can declare a media type for -
// see getFileExtension for what that is. jpg rather than jpeg because this names
// a file; getFileExtension normalizes it back when the media type is written.
function sniffImageExtension(data) {
    try {
        let header = magicBytes(data, 12);
        if (header.startsWith('89504e470d0a1a0a')) {
            return 'png';
        }
        if (header.startsWith('474946383761') || header.startsWith('474946383961')) {
            return 'gif';
        }
        if (header.startsWith('ffd8ff')) {
            return 'jpg';
        }
        // RIFF....WEBP: the four bytes the check skips are the file size, so
        // this cannot be read as one run the way the others are.
        if (header.startsWith('52494646') && header.substring(16, 24) === '57454250') {
            return 'webp';
        }
        return '';
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Drops every <img> pointing at one generated filename. Used when the bytes
// behind it never made it into the archive: content referencing a file that is
// not there fails the whole book, where a missing picture costs one image.
function removeImgTags(content, filename) {
    if (!content || !filename) {
        return content;
    }
    return String(content).replace(
        new RegExp('<img\\b[^>]*\\bsrc="[^"]*' + escapeRegExp(filename) + '"[^>]*>', 'gi'),
        '');
}

function getImageType(fileName) {
    let imageType = getFileExtension(fileName);
    if (imageType === 'svg') {
        imageType = 'svg+xml';
    }
    return imageType;
}

function getHref(hrefTxt) {
    return getAbsoluteUrl(hrefTxt);
}

function getImgDownloadUrl(imgSrc) {
    return getAbsoluteUrl(imgSrc);
}

// Resolves a url the way the browser does, so that the several spellings of one
// location - "a.png", "./a.png", "/dir/a.png" - collapse to a single string.
// Used for cache keys; getAbsoluteUrl stays the resolver for everything else.
function canonicalizeUrl(url) {
    try {
        return new URL(url, document.baseURI).href;
    } catch (e) {
        return getAbsoluteUrl(url);
    }
}

function getAbsoluteUrl(urlStr) {    
    if (!urlStr) {
        return '';
    }
    if (urlStr.length === 0) {
        return '';
    }
    try {
        urlStr = decodeHtmlEntity(urlStr);
        // The platform resolver handles <base>, query-only and fragment-only
        // references, parent segments, protocol-relative URLs, and absolute
        // non-HTTP schemes. Reimplementing those branches by hand inevitably
        // turns at least one of them into a path below the current directory.
        return new URL(urlStr, document.baseURI || window.location.href).href;
    } catch (e) {
        console.log('Error:', e);
        return urlStr;
    }
}

// https://gist.github.com/jonleighton/958841
function base64ArrayBuffer(arrayBuffer) {
    let base64 = '';
    let encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    let bytes = new Uint8Array(arrayBuffer);
    let byteLength = bytes.byteLength;
    let byteRemainder = byteLength % 3;
    let mainLength = byteLength - byteRemainder;

    let a, b, c, d;
    let chunk;

    for (let i = 0; i < mainLength; i = i + 3) {
        chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        a = (chunk & 16515072) >> 18;
        b = (chunk & 258048) >> 12;
        c = (chunk & 4032) >> 6;
        d = chunk & 63;
        base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d];
    }

    if (byteRemainder === 1) {
        chunk = bytes[mainLength];
        a = (chunk & 252) >> 2;
        b = (chunk & 3) << 4;
        base64 += encodings[a] + encodings[b] + '==';
    } else if (byteRemainder === 2) {
        chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];
        a = (chunk & 64512) >> 10;
        b = (chunk & 1008) >> 4;
        c = (chunk & 15) << 2;
        base64 += encodings[a] + encodings[b] + encodings[c] + '=';
    }

    return base64;
}

// http://stackoverflow.com/questions/7394748/whats-the-right-way-to-decode-a-string-that-has-special-html-entities-in-it
function decodeHtmlEntity(str) {
  return str.replace(/&#(\d+);/g, function(match, dec) {
    return String.fromCharCode(dec);
  });
}

function isBase64Img(srcTxt) {
    return srcTxt.indexOf('data:image/') === 0 && srcTxt.indexOf(';base64,') > 0;
}

function getBase64ImgType(srcTxt) {
    try {
        return srcTxt.split(';')[0].split('/')[1];
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
}

function getBase64ImgData(srcTxt) {
    try {
        return srcTxt.split(';base64,')[1];
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
}

function getXPath(elm) {
    if (!elm) return ''

    let allNodes = document.getElementsByTagName('*');
    for (let segs = []; elm && elm.nodeType === 1; elm = elm.parentNode) {
        if (elm.hasAttribute('id')) {
            let uniqueIdCount = 0;
            for (let n = 0; n < allNodes.length; n++) {
                if (allNodes[n].hasAttribute('id') && allNodes[n].id === elm.id) {
                    uniqueIdCount++;
                }
                if (uniqueIdCount > 1) {
                    break;
                }
            }
            if (uniqueIdCount === 1) {
                segs.unshift('id("' + elm.getAttribute('id') + '")');
                return segs.join('/');
            } else {
                segs.unshift(elm.localName.toLowerCase() + '[@id="' + elm.getAttribute('id') + '"]');
            }
        } else if (elm.hasAttribute('class')) {
            segs.unshift(elm.localName.toLowerCase() + '[@class="' + elm.getAttribute('class') + '"]');
        } else {
            for (i = 1, sib = elm.previousSibling; sib; sib = sib.previousSibling) {
                if (sib.localName === elm.localName) {
                    i++;
                }
            }
            segs.unshift(elm.localName.toLowerCase() + '[' + i + ']');
        }
    }
    return segs.length ? '/' + segs.join('/') : null;
}

function lookupElementByXPath(path) {
    let evaluator = new XPathEvaluator();
    let result = evaluator.evaluate(path, document.documentElement, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return  result.singleNodeValue;
}

function generateRandomTag(tagLen) {
    tagLen = tagLen || 5;
    let text = '';
    let possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for(let i = 0; i < tagLen; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function generateRandomNumber(bigNr) {
    if (bigNr) {
        return Math.floor(Math.random()*1000000*Math.random()*1000000)        
    }
    return Math.floor(Math.random()*1000000)
}

function removeSpecialChars(text) {
    // FIXME remove white spaces ?
    return text.replace(/\//g, '-')
}

// Control characters that are not allowed anywhere in an XML 1.0 document.
// A single one of them makes an epub reader reject the whole page.
function removeInvalidXMLChars(text) {
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function escapeXMLChars(text) {
    return removeInvalidXMLChars(text)
                   .replace(/&/g, '&amp;')
                   .replace(/>/g, '&gt;')
                   .replace(/</g, '&lt;')
                   .replace(/"/g, '&quot;')
                   .replace(/'/g, '&apos;');
}

// For text nodes - quotes are legal as-is there, and leaving them alone keeps
// the generated markup readable
function escapeXMLText(text) {
    return removeInvalidXMLChars(text)
                   .replace(/&/g, '&amp;')
                   .replace(/>/g, '&gt;')
                   .replace(/</g, '&lt;');
}

var _htmlParser = null;

function getHtmlParser() {
    if (!_htmlParser) {
        _htmlParser = new DOMParser();
    }
    return _htmlParser;
}

// XHTML only predefines &amp; &lt; &gt; &quot; and &apos;, so every other named
// entity (&nbsp;, &mdash;, ...) is a fatal error in an epub. Resolve them all to
// the characters they stand for and let escapeXMLText/escapeXMLChars re-escape
// whatever still needs it. Also repairs bare "&" that no entity follows.
function decodeHtmlEntities(text) {
    if (!text || text.indexOf('&') < 0) {
        return text;
    }
    try {
        if (typeof DOMParser !== 'undefined') {
            // Every "<" is hidden first, so the parser sees one long run of text
            // and the whole result is the decoded string - nothing in here can
            // become an element or run. The second replace protects every "&"
            // that does not start a complete entity, so that a url like
            // "?a=1&sect=2" doesn't turn into "?a=1§=2".
            let escaped = text
                .replace(/</g, '&lt;')
                .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&amp;');
            // Wrapped in a <span> so that leading whitespace survives: the parser
            // throws away whitespace that appears before it has opened <body>.
            let doc = getHtmlParser().parseFromString('<span>' + escaped + '</span>', 'text/html');
            return doc.body.textContent;
        }
    } catch (e) {
        console.log('Error:', e);
    }
    return decodeHtmlEntity(text);
}

function getEbookFileName(name) {
    return name.replace(/&amp;/ig, '&')
                   .replace(/&gt;/ig, '')
                   .replace(/&lt;/ig, '')
                   .replace(/&quot;/ig, '')
                   .replace(/&apos;/ig, '');
}

function getPageUrl(url) {
    return url.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') + Math.floor(Math.random() * 10000) + '.xhtml';
}

function getPageTitle(title) {
    if (title.trim().length === 0) {
        return 'ebook';
    }
    return title;
}

function jsonToCss(jsonObj) {
    let keys = Object.keys(jsonObj);
    let result = '';
    for (let i = 0; i < keys.length; i++) {
        let tmpJsonObj = jsonObj[keys[i]];
        let tmpKeys = Object.keys(tmpJsonObj);
        result += '.' + keys[i] + ' {';
        for (let j = 0; j < tmpKeys.length; j++) {
            result += tmpKeys[j] + ':' + tmpJsonObj[tmpKeys[j]] + ';';
        }
        result += '} ';
    }
    return result;
}

/////
// DOM helpers - these replace the handful of jQuery calls the extension used to
// make. They deliberately keep jQuery's exact semantics, which are not always
// the same as the similarly named native methods.

// Element.replaceWith() inserts a string as *text*, so it cannot stand in for
// jQuery's .replaceWith(html). Parse the markup first, then swap it in.
function replaceElementWithHTML(elem, html) {
    if (!elem || !elem.parentNode) {
        return;
    }
    let parent = elem.parentNode;
    // Parsed in a separate inert document rather than by assigning innerHTML:
    // same result, minus the "unsafe assignment to innerHTML" the add-on stores
    // flag. Nothing loads or runs while it is parsed there.
    let holder = getHtmlParser().parseFromString(html, 'text/html').body;
    for (let node of Array.from(holder.childNodes)) {
        parent.insertBefore(document.importNode(node, true), elem);
    }
    parent.removeChild(elem);
}

// jQuery's :visible - an element counts as visible when it takes up space in
// the layout. Note that visibility:hidden and opacity:0 are *not* hidden by
// this definition, which is what the css extraction has always relied on.
function isElementVisible(elem) {
    return !!(elem.offsetWidth || elem.offsetHeight || elem.getClientRects().length);
}

function cssPropertyToCamelCase(name) {
    return name.replace(/-([a-z])/g, (all, letter) => letter.toUpperCase());
}

// jQuery's .css(name) reads the resolved value and falls back to the indexed
// property, which is what makes shorthands like "font" and "border" resolve on
// browsers that leave getPropertyValue() empty for them.
function getComputedCssValue(computedStyle, name) {
    let value = computedStyle.getPropertyValue(name);
    if (!value) {
        value = computedStyle[cssPropertyToCamelCase(name)];
    }
    return value;
}

/////

// Reports an HTML fragment as the same stream of start/end/chars/comment events
// that pure-parser used to emit, so the callers are unchanged. The difference is
// that the browser's own HTML5 parser does the parsing, which gets malformed
// markup and implied tags right where a regex parser guesses.
//
// The markup is wrapped in a <template> and handed to DOMParser rather than
// assigned to innerHTML, which the add-on stores flag as an unsafe assignment.
// Both parts matter:
//   - DOMParser builds a document with no browsing context, so nothing runs and
//     no <img> is ever fetched - the images are downloaded later from the
//     rewritten urls instead.
//   - the <template> wrapper puts the parser in "in template" mode, which is
//     what keeps a stray <td> or <tr> - what a selection inside a table
//     produces - from being dropped. Parsed straight into <body> they are.
//
// Every element reports an end event, including void ones, so callers can pair
// start/end without tracking which tags can have children.
function walkHtmlFragment(html, handler) {
    let doc = getHtmlParser().parseFromString('<template>' + html + '</template>', 'text/html');
    let template = doc.querySelector('template');

    let walk = (parent) => {
        for (let node = parent.firstChild; node; node = node.nextSibling) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                let tag = node.localName;
                let attrs = [];
                for (let i = 0; i < node.attributes.length; i++) {
                    attrs.push({
                        name: node.attributes[i].name.toLowerCase(),
                        // already entity-decoded by the parser
                        value: node.attributes[i].value
                    });
                }
                handler.start(tag, attrs, false);
                walk(node);
                handler.end(tag);
            } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
                handler.chars(node.nodeValue);
            } else if (node.nodeType === Node.COMMENT_NODE) {
                handler.comment(node.nodeValue);
            }
        }
    };

    if (template) {
        walk(template.content);
    }
}

/////

function fetchBinaryContent(url) {
    return fetch(url).then((response) => {
        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ' for ' + url);
        }
        return response.arrayBuffer();
    });
}

function downloadBlob(blob, fileName) {
    let objectUrl = URL.createObjectURL(blob);
    let link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    // the download reads from the url after the click returns, so it can only be
    // released later - same delay FileSaver.js used
    setTimeout(() => URL.revokeObjectURL(objectUrl), 40000);
}
