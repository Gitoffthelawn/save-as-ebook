
// Used to replace <img> src links that don't have a file extension
// If the image src doesn't have a file type:
// 1. Create a dummy link
// 2. Detect image type from the binary data & create new links
// 3. Replace all the dummy links in tmpGlobalContent with the new links
var tmpGlobalContent = null

var allImages = [];
var extractedImages = [];
// Resolved image url (or the data uri itself) -> the filename generated for it.
// A page that shows the same image in several places - a repeated logo, an icon
// in every list row - would otherwise download, store and index it once per
// <img>, at full size each time.
var imageFileNames = new Map();
var allowedTags = [
    'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hgroup', 'nav', 'section', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li',
    'main', 'ol', 'p', 'pre', 'ul', 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data',
    'dfn', 'em', 'i', 'img', 'kbd', 'mark', 'q', 'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'small', 'span',
    'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'caption', 'col', 'colgroup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'math', 'maction', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot',
    'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'msgroup', 'mlongdiv', 'mscarries',
    'mscarry', 'mstack', 'semantics'
    // TODO ? 
    // ,'form', 'button'

    // TODO svg support ?
    // , 'svg', 'g', 'path', 'line', 'circle', 'text'
];
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
    'audio', 'video', 'canvas', 'svg', 'map', 'area'
];
var mathMLTags = [
    'math', 'maction', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot',
    'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'msgroup', 'mlongdiv', 'mscarries',
    'mscarry', 'mstack', 'semantics'
]
// Extraction runs in three phases, and the split matters:
//
//   read  - walk the LIVE dom, measure and compute everything that only exists
//           there (getComputedStyle, offsetWidth, canvas bitmaps, iframe
//           documents) and record the verdict per element
//   clone - copy the nodes to extract
//   write - mutate the CLONE from what the read phase recorded
//
// Doing the mutations on the live page instead - which is what this used to do -
// left the page permanently damaged after a save: collapsed accordions and
// display:none menus deleted, every same-origin iframe replaced by a div.
//
// The correspondence between a live element and its clone is carried by a marker
// attribute written during the read phase and removed before it returns. A
// parallel walk of the two trees would avoid even that, but a selection is cloned
// with Range.cloneContents(), which gives no way to walk in lockstep.
var SAE_MARK_ATTR = 'data-sae-mark';

// generated css class name -> the declarations behind it, and the reverse lookup
// used to give two elements that compute to the same style the same class.
// Reset per job, so a chapter's style file holds only the classes it uses.
var classNameToCss = new Map();
var cssToClassName = new Map();

// src: https://idpf.github.io/a11y-guidelines/content/style/reference.html
var supportedCss = [
    'background-color',
    'border',
    'color', 
    'font',
    'line-height',
    'list-style',
    'padding',
    'text-align', 
];
//////

function getImageSrc(srcTxt) {
    if (!srcTxt) {
        return '';
    }
    srcTxt = srcTxt.trim();
    if (srcTxt === '') {
        return '';
    }

    // TODO move
    srcTxt = srcTxt.replace(/&amp;/g, '&')

    // TODO - convert <imgs> with svg sources to jpeg OR add support for svg

    let isB64Img = isBase64Img(srcTxt);
    // Two <img> tags pointing at the same bytes must resolve to the same key:
    // for remote images that is the absolute url, for inline ones the data uri.
    // "img/a.png" and "./img/a.png" name one file but not one string, so the key
    // is canonicalized - the url actually fetched is left alone.
    let imageKey = isB64Img ? srcTxt : canonicalizeUrl(srcTxt);

    let knownFileName = imageFileNames.get(imageKey);
    if (knownFileName) {
        return '../images/' + knownFileName;
    }

    let fileExtension = getFileExtension(srcTxt);
    if (fileExtension === '') {
       fileExtension = "TODO-EXTRACT"
    }
    let newImgFileName = 'img-' + generateRandomNumber(true) + '.' + fileExtension;
    imageFileNames.set(imageKey, newImgFileName);

    if (isB64Img) {
        extractedImages.push({
            filename: newImgFileName, // TODO name
            data: getBase64ImgData(srcTxt)
        });
    } else {
        allImages.push({
            originalUrl: getImgDownloadUrl(srcTxt),
            filename: newImgFileName,  // TODO name
        });
    }

    return '../images/' + newImgFileName;
}

///// Read phase - everything below reads the live dom and writes nothing to it
///// except the marker attribute, which readLivePage() removes again.

function newReadState() {
    return {
        nextMarkId: 0,
        // marker id -> what the write phase should do with the cloned element
        marks: new Map(),
        // live elements carrying a marker, so it can be taken off again
        markedElements: [],
        css: null
    };
}

// Returns the record for an element, marking it on first use. One element can
// collect several verdicts - a hidden iframe is both hidden and replaceable.
function getMark(state, elem) {
    let id = elem.getAttribute(SAE_MARK_ATTR);
    if (id !== null && state.marks.has(id)) {
        return state.marks.get(id);
    }
    id = String(state.nextMarkId++);
    elem.setAttribute(SAE_MARK_ATTR, id);
    state.markedElements.push(elem);
    let mark = {};
    state.marks.set(id, mark);
    return mark;
}

// iframes: the content document is only reachable from the live element, and
// only for same-origin frames - a cross-origin access throws
function readIFrames(state) {
    for (let iFrame of document.getElementsByTagName('iframe')) {
        let frameBody = null;
        try {
            frameBody = iFrame.contentDocument && iFrame.contentDocument.body;
        } catch (e) {
            frameBody = null;
        }
        if (!frameBody) {
            continue;
        }
        let bbox = iFrame.getBoundingClientRect();
        getMark(state, iFrame).replaceWithHtml =
            '<div style="width:' + bbox.width + 'px;height:' + bbox.height + 'px">' +
            frameBody.innerHTML + '</div>';
    }
}

// canvas: toDataURL() reads the live bitmap - a cloned canvas is blank. Reading
// a canvas tainted by cross-origin drawing throws SecurityError, in which case
// the canvas is left alone and dropped later with the other stripped tags.
function readCanvases(state) {
    document.body.querySelectorAll('canvas').forEach(function (elem) {
        try {
            let imgUrl = elem.toDataURL('image/jpeg');
            getMark(state, elem).replaceWithHtml = '<img src="' + imgUrl + '" alt="" />';
        } catch (e) {
            console.log('Error:', e);
        }
    });
}

// svg: getBoundingClientRect() needs the live layout - the serialized markup
// alone renders at the wrong size
function readSvgs(state) {
    let serializer = new XMLSerializer();
    document.body.querySelectorAll('svg').forEach(function (elem) {
        try {
            let bbox = elem.getBoundingClientRect();
            let svgXml = serializer.serializeToString(elem);
            let imgSrc = 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(svgXml)));
            getMark(state, elem).replaceWithHtml =
                '<img src="' + imgSrc + '" width="' + bbox.width + '" height="' + bbox.height + '" />';
        } catch (e) {
            console.log('Error:', e);
        }
    });
}

// Returns the class name standing for this computed style, reusing the name of
// an earlier element that computed to exactly the same declarations.
function classNameForComputedStyle(computedStyle) {
    let declarations = {};
    for (let cssTagName of supportedCss) {
        let cssValue = getComputedCssValue(computedStyle, cssTagName);
        if (cssValue && cssValue.length > 0) {
            declarations[cssTagName] = cssValue;
        }
    }

    // Keyed on the declarations, not on the element's class attribute: two
    // elements sharing a class name can compute to completely different styles
    // (the same .title in a sidebar and in an article), and keying on the name
    // gave the second one the first one's css.
    let key = JSON.stringify(declarations);
    let existing = cssToClassName.get(key);
    if (existing) {
        return existing;
    }

    let className = generateRandomTag(2) + classNameToCss.size;
    cssToClassName.set(key, className);
    classNameToCss.set(className, declarations);
    return className;
}

// Records, for every element, whether it survives into the ebook and which
// generated class it gets. Mirrors what extractCss() used to decide inline while
// deleting from the live page.
function readVisibilityAndCss(state, includeStyle, appliedStyles) {
    if (includeStyle) {
        document.body.querySelectorAll('*').forEach((elem) => {
            let tagName = elem.tagName.toLowerCase();
            if (allowedTags.indexOf(tagName) < 0) return;
            if (mathMLTags.indexOf(tagName) > -1) return;

            if (!isElementVisible(elem)) {
                getMark(state, elem).hidden = true;
                return;
            }
            if (tagName === 'svg') return;

            getMark(state, elem).cssClassName =
                classNameForComputedStyle(window.getComputedStyle(elem));
        });
        state.css = jsonToCss(Object.fromEntries(classNameToCss));
        return;
    }

    // no style requested - hidden elements are still dropped, and any style the
    // background injected for this site is shipped as the chapter's stylesheet
    document.body.querySelectorAll('*').forEach((elem) => {
        if (!isElementVisible(elem)) {
            getMark(state, elem).hidden = true;
        }
    });

    if (appliedStyles && appliedStyles.length > 0) {
        state.css = appliedStyles.reduce((all, applied) => all + applied.style, '');
    }
}

function readLivePage(includeStyle, appliedStyles) {
    let state = newReadState();
    try {
        readIFrames(state);
        readCanvases(state);
        readSvgs(state);
        readVisibilityAndCss(state, includeStyle, appliedStyles);
    } catch (e) {
        console.log('Error:', e);
    }
    return state;
}

// Takes the markers back off the live page. Must run after the nodes are cloned
// - the clones keep their copy of the attribute, which is what the write phase
// looks up - and must run even when extraction fails, or the page is left
// carrying our attributes.
function clearLiveMarks(state) {
    for (let elem of state.markedElements) {
        try {
            elem.removeAttribute(SAE_MARK_ATTR);
        } catch (e) {
            console.log('Error:', e);
        }
    }
    state.markedElements = [];
}

///// Write phase - operates only on the cloned tree

// tested
function extractMathMl(htmlObject) {
    htmlObject.querySelectorAll('span[id^="MathJax-Element-"]').forEach(function (el) {
        replaceElementWithHTML(el, '<span>' + el.getAttribute('data-mathml') + '</span>');
    });
}

// Applies the read phase's verdicts to the clone. Runs before the clone is
// serialized: svg and canvas are in strippedContentTags, so anything still
// carrying those tags at parse time is dropped along with its content.
function applyReadState(cloneRoot, state) {
    cloneRoot.querySelectorAll('[' + SAE_MARK_ATTR + ']').forEach(function (elem) {
        let mark = state.marks.get(elem.getAttribute(SAE_MARK_ATTR));
        elem.removeAttribute(SAE_MARK_ATTR);
        if (!mark) {
            return;
        }
        if (mark.hidden) {
            elem.remove();
            return;
        }
        if (mark.cssClassName) {
            elem.setAttribute('data-class', mark.cssClassName);
        }
        if (mark.replaceWithHtml) {
            // no-op when the element was already dropped with an ancestor
            replaceElementWithHTML(elem, mark.replaceWithHtml);
        }
    });

    extractMathMl(cloneRoot);
}

// Appends to allImages / extractedImages - the caller owns resetting them, so
// that a multi-range selection accumulates the images of every range instead of
// each range discarding the ones collected before it.
function parseHTML(rawContentString) {
    let results = '';
    let lastFragment = '';
    // Tags written to the output that still need a closing tag. Kept here rather
    // than trusting the input to be balanced: a page can close tags it never
    // opened, or leave tags open, and the epub still has to be valid XML.
    let openTags = [];
    // Tags whose content is being dropped, innermost last
    let skippedTags = [];

    let isVoidTag = (tag) => voidTags.indexOf(tag) > -1;

    // walkHtmlFragment hands over values the HTML parser has already decoded, so
    // they only need escaping - decoding here as well would turn a literal
    // "&amp;lt;" on the page into a "<" in the epub
    let attrValue = (value) => escapeXMLChars(value == null ? '' : String(value));

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
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'src') {
                            tmpSrc = getImageSrc(attrs[i].value)
                            tmpAttrsTxt += ' src="' + attrValue(tmpSrc) + '"';
                        } else if (attrs[i].name === 'data-class') {
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
                    tmpAttrsTxt += ' alt=""';
                } else if (tag === 'a') {
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'href') {
                            tmpAttrsTxt += ' href="' + attrValue(getHref(attrs[i].value)) + '"';
                        } else if (attrs[i].name === 'data-class') {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                } else if (tag === 'math') {
                    tmpAttrsTxt += ' xmlns="http://www.w3.org/1998/Math/MathML"';
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'alttext') {
                            tmpAttrsTxt += ' alttext="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                } else {
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'data-class') {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        }
                    }
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

// htmlContent is already detached: either a clone of the body or the contents of
// a selection range. Nothing here touches the live page.
function getContent(htmlContent, state) {
    try {
        let tmp = document.createElement('div');
        tmp.appendChild(htmlContent);
        applyReadState(tmp, state);
        // The wrapping <div> is added to the result rather than to the parser
        // input on purpose: a fragment parsed inside a <div> is parsed "in body",
        // where a stray <td> or <tr> - what a selection inside a table produces -
        // is dropped. Parsed on its own it is parsed "in template", which keeps
        // table cells intact.
        return '<div>' + parseHTML(tmp.innerHTML) + '</div>';
    } catch (e) {
        console.log('Error:', e);
        // Never hand back the node itself - it ends up spliced into the xhtml page
        // as "[object HTMLBodyElement]". Fall back to the plain text of the content.
        try {
            return '<div>' + escapeXMLText(htmlContent.textContent || '') + '</div>';
        } catch (e2) {
            console.log('Error:', e2);
            return '';
        }
    }
}

/////

function getSelectedNodes() {
    // if (document.selection) {
        // return document.selection.createRange().parentElement();
        // return document.selection.createRange();
    // }
    let selection = window.getSelection();
    let docfrag = [];
    for (let i = 0; i < selection.rangeCount; i++) {
        docfrag.push(selection.getRangeAt(i).cloneContents());
    }
    return docfrag;
}

/////

/////

// Always resolves - one image that cannot be downloaded must not stop the rest
// of the ebook from being built
function deferredAddZip(url, filename) {
    return fetchBinaryContent(url).then((data) => {
        // TODO - move to utils.js
        if (filename.endsWith("TODO-EXTRACT")) {
            let oldFilename = filename
            let arr = (new Uint8Array(data)).subarray(0, 4);
            let header = "";
            for(let i = 0; i < arr.length; i++) {
                header += arr[i].toString(16);
            }
            if (header.startsWith("89504e47")) {
                filename = filename.replace("TODO-EXTRACT", "png")
            } else if (header.startsWith("47494638")) {
                filename = filename.replace("TODO-EXTRACT", "gif")
            } else if (header.startsWith("ffd8ff")) {
                filename = filename.replace("TODO-EXTRACT", "jpg")
            } else {
                // ERROR
                console.log("Error! Unable to extract the image type!");
            }
            // replaceAll, not replace: a deduped image resolves to one filename
            // that can be referenced by any number of <img> tags in the content
            tmpGlobalContent = tmpGlobalContent.replaceAll(oldFilename, filename)
        }

        extractedImages.push({
            filename: filename,
            // TODO - must be JSON serializable
            data: base64ArrayBuffer(data)
        });
    }).catch((err) => {
        console.log('Error:', err);
    });
}

// Extraction can outlive the background's job timeout, mostly in the image
// downloads. A job that is still making progress keeps saying so; one whose tab
// was closed or navigated away stops, and the background reclaims it.
var HEARTBEAT_INTERVAL = 5000;

function startHeartbeat() {
    let send = () => {
        try {
            chrome.runtime.sendMessage({type: 'job-heartbeat'}, () => {
                // the background may be asleep or gone - nothing to do
                void chrome.runtime.lastError;
            });
        } catch (e) {
            console.log('Error:', e);
        }
    };
    send();
    return setInterval(send, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(handle) {
    if (handle) {
        clearInterval(handle);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Injection probe - answering it is how the background tells that this tab
    // already has the content scripts and must not get a second copy
    if (request && request.type === 'sae-ping') {
        sendResponse({ready: true});
        return false;
    }

    // Other listeners handle 'alert' / 'shortcut' messages. Bail out before
    // touching the page - the extraction below is expensive and, for an
    // 'extract-*' request, sends its own response.
    if (!request || (request.type !== 'extract-page' && request.type !== 'extract-selection')) {
        return false;
    }

    let imgsPromises = [];
    let result = {};
    let tmpContent = '';
    let styleFile = null;

    // Reset once per job, not once per parsed fragment: a selection spanning
    // several ranges calls getContent() for each one.
    allImages = [];
    extractedImages = [];
    imageFileNames.clear();
    classNameToCss.clear();
    cssToClassName.clear();

    // Downloading the images can take far longer than the background's job
    // timeout, so tell it we are still alive while they run.
    let heartbeat = startHeartbeat();

    let state = readLivePage(request.includeStyle, request.appliedStyles);
    try {
        // clone while the markers are still on the live elements
        let clones = [];
        if (request.type === 'extract-page') {
            clones.push(document.body.cloneNode(true));
        } else {
            clones = getSelectedNodes();
        }
        // ... and take them off again before anything can throw further down
        clearLiveMarks(state);

        styleFile = state.css;
        clones.forEach((clone) => {
            tmpContent += getContent(clone, state);
        });
    } catch (e) {
        console.log('Error:', e);
    } finally {
        // clearLiveMarks is idempotent - this is the path where cloning threw
        clearLiveMarks(state);
    }

    tmpGlobalContent = tmpContent

    allImages.forEach((tmpImg) => {
        imgsPromises.push(deferredAddZip(tmpImg.originalUrl, tmpImg.filename));
    });

    Promise.all(imgsPromises).then(() => {
        let tmpTitle = getPageTitle(document.title);
        result = {
            url: getPageUrl(tmpTitle),
            title: tmpTitle,
            baseUrl: getCurrentUrl(),
            styleFileContent: styleFile,
            styleFileName: 'style' + generateRandomNumber() + '.css',
            images: extractedImages,
            content: tmpGlobalContent
        };
        sendResponse(result);
    }).catch((e) => {
        console.log('Error:', e);
        sendResponse(null)
    }).finally(() => {
        stopHeartbeat(heartbeat);
    });

    return true;
});
