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

function setIsBusy(isBusy) {
    chrome.runtime.sendMessage({
        type: "set is busy",
        isBusy: isBusy
    }, function(response) {});
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
            tmpFileName = fileName.split('.').pop();
        }

        if (tmpFileName.indexOf('?') > 0) {
            tmpFileName = tmpFileName.split('?')[0];
        }
        tmpFileName = tmpFileName.toLowerCase();
        if (tmpFileName === 'jpg') {
            tmpFileName = 'jpeg';
        } else if (tmpFileName === 'svg+xml') {
            tmpFileName = 'svg';
        } 

        if (['png', 'gif', 'jpeg', 'svg'].indexOf(tmpFileName.trim()) < 0) {
            return ''
        }
        return tmpFileName;
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
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
        let currentUrl = getCurrentUrl();
        let originUrl = getOriginUrl();
        let absoluteUrl = urlStr;

        originUrl = removeEndingSlash(originUrl)
        currentUrl = removeEndingSlash(currentUrl)

        if (urlStr.indexOf('//') === 0) {
            absoluteUrl = window.location.protocol + urlStr;
        } else if (urlStr.indexOf('/') === 0) {
            absoluteUrl = originUrl + urlStr;
        } else if (urlStr.indexOf('#') === 0) {
            absoluteUrl = currentUrl + urlStr;
        } else if (urlStr.indexOf('http') !== 0) {
            absoluteUrl = currentUrl + '/' + urlStr;
        }
        // TODO is this needed?
        // absoluteUrl = escapeXMLChars(absoluteUrl);
        return absoluteUrl;
    } catch (e) {
        console.log('Error:', e);
        return urlStr;
    }
}

function removeEndingSlash(inputStr) {
    if (inputStr.endsWith('/')) {
        return inputStr.substring(0, inputStr.length - 1);
    }
    return inputStr;
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

var _htmlEntityDecoder = null;

// XHTML only predefines &amp; &lt; &gt; &quot; and &apos;, so every other named
// entity (&nbsp;, &mdash;, ...) is a fatal error in an epub. Resolve them all to
// the characters they stand for and let escapeXMLText/escapeXMLChars re-escape
// whatever still needs it. Also repairs bare "&" that no entity follows.
function decodeHtmlEntities(text) {
    if (!text || text.indexOf('&') < 0) {
        return text;
    }
    try {
        if (typeof document !== 'undefined' && document.createElement) {
            if (!_htmlEntityDecoder) {
                _htmlEntityDecoder = document.createElement('textarea');
            }
            // A textarea holds raw text, so nothing in here can become an element
            // or run - but "<" must be hidden to keep "</textarea>" from closing it.
            // The second replace protects every "&" that does not start a complete
            // entity, so that a url like "?a=1&sect=2" doesn't turn into "?a=1§=2".
            _htmlEntityDecoder.innerHTML = text
                .replace(/</g, '&lt;')
                .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&amp;');
            return _htmlEntityDecoder.value;
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
    let holder = document.createElement('div');
    holder.innerHTML = html;
    while (holder.firstChild) {
        parent.insertBefore(holder.firstChild, elem);
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
// A <template> is used because its content is parsed into an inert document:
// no scripts run and, importantly here, no <img> is ever fetched - the images
// are downloaded later from the rewritten urls instead.
//
// Every element reports an end event, including void ones, so callers can pair
// start/end without tracking which tags can have children.
function walkHtmlFragment(html, handler) {
    let template = document.createElement('template');
    template.innerHTML = html;

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

    walk(template.content);
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