
// Used to replace <img> src links that don't have a file extension
// If the image src doesn't have a file type:
// 1. Create a dummy link
// 2. Detect image type from the binary data & create new links
// 3. Replace all the dummy links in tmpGlobalContent with the new links
var tmpGlobalContent = null

var allImages = [];
var extractedImages = [];
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
var cssClassesToTmpIds = {};
var tmpIdsToNewCss = {};
var tmpIdsToNewCssSTRING = {};

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

    let fileExtension = getFileExtension(srcTxt);
    if (fileExtension === '') {
       fileExtension = "TODO-EXTRACT"
    }
    let newImgFileName = 'img-' + generateRandomNumber(true) + '.' + fileExtension;

    let isB64Img = isBase64Img(srcTxt);
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

// tested
function extractMathMl(htmlObject) {
    htmlObject.querySelectorAll('span[id^="MathJax-Element-"]').forEach(function (el) {
        replaceElementWithHTML(el, '<span>' + el.getAttribute('data-mathml') + '</span>');
    });
}

// tested
function extractCanvasToImg(htmlObject) {
    htmlObject.querySelectorAll('canvas').forEach(function (elem) {
        try {
            // FIXME - docEl is not defined, so this throws for every canvas and
            // no canvas is ever converted. Left as is to keep this change a pure
            // library swap; the fix is to read from elem.
            let imgUrl = docEl.toDataURL('image/jpeg');
            replaceElementWithHTML(elem, '<img src="' + imgUrl + '" alt=""></img>');
        } catch (e) {
            console.log(e)
        }
    });
}

// tested
function extractSvgToImg(htmlObject) {
    let serializer = new XMLSerializer();
    htmlObject.querySelectorAll('svg').forEach(function (elem) {
        // add width & height because the result image was too big
        let bbox = elem.getBoundingClientRect()
        let newWidth = bbox.width
        let newHeight = bbox.height
        let svgXml = serializer.serializeToString(elem);
        let imgSrc = 'data:image/svg+xml;base64,' + window.btoa(svgXml);
        replaceElementWithHTML(elem, '<img src="' + imgSrc + '" width="'+newWidth+'" height="'+newHeight+'">' + '</img>');
    });
}

// replaces all iframes by divs with the same innerHTML content
function extractIFrames() {
    let allIframes = document.getElementsByTagName('iframe')
    let changeIFrames = []
    let newDivs = []
    for (let iFrame of allIframes) {
        if (!iFrame.contentDocument || !iFrame.contentDocument.body) {
            continue
        }
        let bodyContent = iFrame.contentDocument.body.innerHTML        
        let bbox = iFrame.getBoundingClientRect()
        let newDiv = document.createElement('div')
        newDiv.style.width = bbox.width
        newDiv.style.height = bbox.height
        newDiv.innerHTML = bodyContent
        changeIFrames.push(iFrame)
        newDivs.push(newDiv)
    }
    for (let i = 0; i < newDivs.length; i++) {
        let newDiv = newDivs[i]
        let iFrame = changeIFrames[i]
        let iframeParent = iFrame.parentNode
        iframeParent.replaceChild(newDiv, iFrame)
    }
}

function preProcess(htmlObject) {
    // TODO
    // htmlObject.querySelectorAll('script, style, noscript, iframe').forEach(el => el.remove());
    // document.body.querySelectorAll('iframe').forEach(el => el.remove());
    // remove empty elements other than img/br/hr
    // formatPreCodeElements(document.body);

    extractMathMl(htmlObject);
    extractCanvasToImg(htmlObject);
    extractSvgToImg(htmlObject);
}

function parseHTML(rawContentString) {
    allImages = [];
    extractedImages = [];
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

function getContent(htmlContent) {
    try {
        // TODO - move; called multiple times on selection
        preProcess(document.body)
        let tmp = document.createElement('div');
        tmp.appendChild(htmlContent.cloneNode(true));
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

function extractCss(includeStyle, appliedStyles) {
    if (includeStyle) {
        document.body.querySelectorAll('*').forEach((pre, i) => {
            if (allowedTags.indexOf(pre.tagName.toLowerCase()) < 0) return;
            if (mathMLTags.indexOf(pre.tagName.toLowerCase()) > -1) return;

            if (!isElementVisible(pre)) {
                pre.remove();
            } else {
                if (pre.tagName.toLowerCase() === 'svg') return;

                let classNames = pre.getAttribute('class');
                if (!classNames) {
                    classNames = pre.getAttribute('id');
                    if (!classNames) {
                        classNames = pre.tagName + '-' + generateRandomNumber();
                    }
                }
                let tmpName = cssClassesToTmpIds[classNames];
                let tmpNewCss = tmpIdsToNewCss[tmpName];
                if (!tmpName) {
                    // TODO - collision  between class names when multiple pages
                    tmpName = generateRandomTag(2) + i
                    cssClassesToTmpIds[classNames] = tmpName;
                }
                if (!tmpNewCss) {
                    tmpNewCss = {};

                    let computedStyle = window.getComputedStyle(pre);
                    for (let cssTagName of supportedCss) {
                        let cssValue = getComputedCssValue(computedStyle, cssTagName);
                        if (cssValue && cssValue.length > 0) {
                            tmpNewCss[cssTagName] = cssValue;
                        }
                    }

                    // Reuse CSS - if the same css code was generated for another element, reuse it's class name

                    let tcss = JSON.stringify(tmpNewCss)
                    let found = false

                    if (Object.keys(tmpIdsToNewCssSTRING).length === 0) {
                        tmpIdsToNewCssSTRING[tmpName] = tcss;
                        tmpIdsToNewCss[tmpName] = tmpNewCss;
                    } else {
                        for (const key in tmpIdsToNewCssSTRING) {
                            if (tmpIdsToNewCssSTRING[key] === tcss) {
                                tmpName = key
                                found = true
                                break
                            }
                        }
                        if (!found) {
                            tmpIdsToNewCssSTRING[tmpName] = tcss;
                            tmpIdsToNewCss[tmpName] = tmpNewCss;
                        }
                    }
                }
                pre.setAttribute('data-class', tmpName);
            }
        });
        return jsonToCss(tmpIdsToNewCss);
    } else {
        // remove hidden elements when style is not included
        document.body.querySelectorAll('*').forEach((pre) => {
            if (!isElementVisible(pre)) {
                pre.remove()
            }
        })
        let mergedCss = '';
        if (appliedStyles && appliedStyles.length > 0) {
            for (let i = 0; i < appliedStyles.length; i++) {
                mergedCss += appliedStyles[i].style;
            }
            return mergedCss;
        }
    }
    return null
}

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
            tmpGlobalContent = tmpGlobalContent.replace(oldFilename, filename)
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    let imgsPromises = [];
    let result = {};
    let pageSrc = '';
    let tmpContent = '';
    let styleFile = null;

    extractIFrames()

    if (request.type === 'extract-page') {
        styleFile = extractCss(request.includeStyle, request.appliedStyles)
        pageSrc = document.getElementsByTagName('body')[0];
        tmpContent = getContent(pageSrc);
    } else if (request.type === 'extract-selection') {
        styleFile = extractCss(request.includeStyle, request.appliedStyles)
        pageSrc = getSelectedNodes();
        pageSrc.forEach((page) => {
            tmpContent += getContent(page);
        });
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
    });

    return true;
});
