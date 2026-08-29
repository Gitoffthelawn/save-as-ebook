
// Used to replace <img> src links that don't have a file extension
// If the image src doesn't have a file type:
// 1. Create a dummy link
// 2. Detect image type from the binary data & create new links
// 3. Replace all the dummy links in tmpGlobalContent with the new links
var tmpGlobalContent = null

var allImages = [];
var extractedImages = [];
// The images that were meant to be in this chapter and are not: one entry per
// <img> whose bytes never arrived. Dropping the tag keeps the book valid (see
// dropImage), but doing it with no trace is the failure the user cannot tell
// apart from a page that simply had no picture there - the most common cause is
// a cross-origin cdn that serves no Access-Control-Allow-Origin header, which
// the page itself renders fine because an <img> load is not a fetch.
var droppedImages = [];
// Resolved image url (or the data uri itself) -> the filename generated for it.
// A page that shows the same image in several places - a repeated logo, an icon
// in every list row - would otherwise download, store and index it once per
// <img>, at full size each time.
var imageFileNames = new Map();

// The tag allowlists, the attribute filters and parseHTML() itself live in
// sanitizeHtml.js, which this file requires: the chapter editor writes content
// through the same sanitizer, and it cannot load a content script.

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

// Stands in for the file extension of an image whose url did not name one, from
// the moment the content is written until the bytes arrive and settle it.
var IMG_TYPE_PLACEHOLDER = 'TODO-EXTRACT';

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

// getComputedStyle answers a shorthand with the empty string whenever it cannot
// serialize one, and two of the shorthands above hit that constantly:
//
//   font    empty as soon as font-feature-settings or font-variation-settings
//           are anything but initial - which is every page using a variable font
//           or turning a ligature off. The element then loses family, size,
//           style and weight in one go, and a paragraph that has quietly lost
//           its italics looks exactly like one that never had any.
//   border  empty whenever the four sides are not identical, so the single rule
//           under a heading - the most common border on the web - is dropped,
//           while the "0px none" of an element with no border at all serializes
//           perfectly well and is kept.
//
// Where the shorthand cannot answer, its longhands are asked instead. The
// shorthand is still asked first, so a page that never hits this gets the css it
// always got.
var cssShorthandLonghands = {
    // In shorthand order, and complete rather than filtered down to what is not
    // initial: these properties inherit, and an element leaving out font-weight
    // because it computes to the initial value would inherit the 700 of an
    // ancestor's generated class instead.
    //
    // font-stretch is deliberately absent. It computes to a percentage, which is
    // css3 syntax an older reading system may not parse, and a page that sets it
    // is rare enough not to be worth that.
    'font': ['font-style', 'font-variant', 'font-weight', 'font-size', 'font-family'],
    'border': ['border-top', 'border-right', 'border-bottom', 'border-left']
};

// A side that computes to the initial value is not a border. Borders do not
// inherit, so unlike the font longhands these can be left out - which is what
// keeps one underlined heading from being written as three declarations saying
// "no border here" and one saying where the border is.
var INITIAL_BORDER_REGEX = /^0(?:px)?\s+none\b/;

function isInitialBorderSide(name, value) {
    return name.indexOf('border-') === 0 && INITIAL_BORDER_REGEX.test(value);
}

// Adds everything this property contributes to the element's generated class.
function addComputedDeclarations(declarations, computedStyle, name) {
    let value = getComputedCssValue(computedStyle, name);
    if (value && value.length > 0) {
        declarations[name] = value;
        return;
    }
    let longhands = cssShorthandLonghands[name];
    if (!longhands) {
        return;
    }
    for (let longhand of longhands) {
        let longhandValue = getComputedCssValue(computedStyle, longhand);
        if (longhandValue && longhandValue.length > 0 &&
            !isInitialBorderSide(longhand, longhandValue)) {
            declarations[longhand] = longhandValue;
        }
    }
}
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
    // is the resolved url rather than the attribute as it was written.
    let imageKey = isB64Img ? srcTxt : canonicalizeUrl(srcTxt);

    let knownFileName = imageFileNames.get(imageKey);
    if (knownFileName) {
        return '../images/' + knownFileName;
    }

    let fileExtension = getFileExtension(srcTxt);
    if (fileExtension === '') {
        // A data uri already states its type, so there is nothing left to learn
        // about one whose type is unusable - and it is never downloaded, so the
        // sniffing below would not run for it anyway. Dropping the image here is
        // what stops it from reaching the manifest with no media type.
        if (isB64Img) {
            return '';
        }
        // The url named no usable type. The bytes will, once downloaded - see
        // deferredAddZip, which resolves this placeholder or drops the image.
        fileExtension = IMG_TYPE_PLACEHOLDER
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
        css: null,
        // A capture for the style library to preview and pick selectors in,
        // rather than one to put in a book - see SNAPSHOT_CLASS_PREFIX.
        styleSnapshot: false
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

// What the <img> that replaces a canvas or an svg should say about it. A source
// that built the element accessibly already wrote the text down; one that marked
// it decorative said so. Only those two answers exist here - returning null for
// "the page never said" is what keeps the ebook from claiming a description it
// does not have.
function accessibleLabel(elem) {
    if (elem.getAttribute('aria-hidden') === 'true' ||
        elem.getAttribute('role') === 'presentation' ||
        elem.getAttribute('role') === 'none') {
        return '';   // deliberately decorative -> alt=""
    }
    let label = elem.getAttribute('aria-label') || '';
    if (!label) {
        // a direct child only: a <title> deeper inside an svg names one shape,
        // not the drawing as a whole
        for (let child of elem.children) {
            if (child.tagName && child.tagName.toLowerCase() === 'title') {
                label = child.textContent || '';
                break;
            }
        }
    }
    if (!label && elem.tagName.toLowerCase() === 'canvas') {
        // canvas fallback content exists to describe the bitmap
        label = elem.textContent || '';
    }
    if (!label) {
        label = elem.getAttribute('title') || '';
    }
    label = label.replace(/\s+/g, ' ').trim();
    return label || null;
}

function altAttribute(label) {
    return label === null ? '' : ' alt="' + escapeXMLChars(label) + '"';
}

// canvas: toDataURL() reads the live bitmap - a cloned canvas is blank. Reading
// a canvas tainted by cross-origin drawing throws SecurityError, in which case
// the canvas is left alone and dropped later with the other stripped tags.
function readCanvases(state) {
    document.body.querySelectorAll('canvas').forEach(function (elem) {
        try {
            let imgUrl = elem.toDataURL('image/jpeg');
            getMark(state, elem).replaceWithHtml =
                '<img src="' + imgUrl + '"' + altAttribute(accessibleLabel(elem)) + ' />';
        } catch (e) {
            console.log('Error:', e);
        }
    });
}

// A laid-out size is a double, and an <img> in xhtml wants an integer: an icon
// measuring 16.296875px reaches epubcheck as width="16.296875", which is an
// error rather than a rounding difference. A size that is not a usable number -
// a detached or display:none svg measures 0, a broken layout can measure NaN or
// Infinity - drops the attribute instead of writing a nonsense one, and the
// image is then sized by the stylesheet like any other.
function imageDimensionAttribute(name, size) {
    if (typeof size !== 'number' || !isFinite(size) || size <= 0) {
        return '';
    }
    let rounded = Math.round(size);
    return rounded > 0 ? ' ' + name + '="' + rounded + '"' : '';
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
                '<img src="' + imgSrc + '"' +
                imageDimensionAttribute('width', bbox.width) +
                imageDimensionAttribute('height', bbox.height) +
                altAttribute(accessibleLabel(elem)) + ' />';
        } catch (e) {
            console.log('Error:', e);
        }
    });
}

// imgs: a lazily loaded one does not name its picture in the markup - see
// imageSrcCandidates - and the live element is where the missing half of the
// answer is. The browser has already applied srcset and sizes and written the
// candidate it chose into currentSrc, which no later pass can recompute without
// a viewport, and an image that has finished loading knows whether what it got
// is a photograph or a pixel.
//
// The verdict is applied to the clone, so the live page keeps the placeholder it
// was displaying.
function readImages(state) {
    document.body.querySelectorAll('img').forEach(function (elem) {
        try {
            // complete is also true for an image that never had a source, so
            // the size only means anything once there are bytes behind it. Two
            // pixels rather than one because a "1x1" spacer is occasionally 2x2
            // and nothing that small is content.
            let renderedPlaceholder = elem.complete && elem.naturalWidth > 0 &&
                                      elem.naturalWidth <= 2 && elem.naturalHeight <= 2;
            let candidates = imageSrcCandidates(function (name) {
                return elem.getAttribute(name);
            }, elem.currentSrc, renderedPlaceholder);
            // Only the first is written: the rest are the sanitizer's fallbacks
            // if this one turns out not to resolve, and the attributes holding
            // them are still on the clone for it to read.
            if (candidates.length > 0 && candidates[0] !== elem.getAttribute('src')) {
                getMark(state, elem).imageSrc = candidates[0];
            }
        } catch (e) {
            console.log('Error:', e);
        }
    });
}

// The live <math> as markup. XMLSerializer writes the MathML namespace onto the
// root element, and replaceElementWithHTML() parses it back with the HTML
// parser, which puts <math> into that namespace anyway - so the clone ends up
// with real MathML rather than a tree of unknown elements.
function serializeMathMl(math) {
    try {
        return new XMLSerializer().serializeToString(math);
    } catch (e) {
        console.log('Error:', e);
        return '';
    }
}

// Math on the web is almost never shipped as the MathML a reading system wants.
// A typesetter renders it into something the browser can draw and keeps the real
// MathML beside it, hidden - and every one of those wrappers is either a custom
// element or a styled <span>, so parseHTML() unwraps it. What reached the chapter
// was the glyph soup the renderer built, with the math itself dropped.
//
// This has to run in the read phase: a custom element is gone by the time the
// clone is serialized, and there is nothing left to recognize it by.
function readMathMl(state) {
    // MathJax v3 and v4. <mjx-container> holds the rendered output - CHTML spans
    // or an <svg> - and, when assistive MathML is on, which is the default, the
    // source MathML inside <mjx-assistive-mml>.
    document.body.querySelectorAll('mjx-container').forEach(function (elem) {
        let math = elem.querySelector('math');
        if (math) {
            getMark(state, elem).replaceWithHtml = serializeMathMl(math);
        }
        // Configured without assistive MathML there is no math to recover. The
        // SVG output is still a picture of the formula and readSvgs() turns it
        // into one; the CHTML output is not, and unwraps to its glyphs.
    });

    // KaTeX. .katex-mathml is the real MathML, clipped to a pixel, and
    // .katex-html is the same formula rebuilt out of positioned spans for
    // browsers with no MathML of their own. Keeping both - which is what
    // happened, since neither is hidden by a measurable size - printed every
    // formula on the page twice.
    document.body.querySelectorAll('.katex').forEach(function (elem) {
        let math = elem.querySelector('.katex-mathml math') || elem.querySelector('math');
        if (math) {
            getMark(state, elem).replaceWithHtml = serializeMathMl(math);
        }
    });
}

// Returns the class name standing for this computed style, reusing the name of
// an earlier element that computed to exactly the same declarations.
function classNameForComputedStyle(computedStyle, prefix) {
    let declarations = {};
    for (let cssTagName of supportedCss) {
        addComputedDeclarations(declarations, computedStyle, cssTagName);
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

    let className = (prefix || '') + generateRandomTag(2) + classNameToCss.size;
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
            if (mathMLTags.indexOf(tagName) > -1) return;

            // An svg and a canvas leave as an <img> - see readSvgs and
            // readCanvases - so they have to be measured even though neither tag
            // is one the ebook allows. Filtered out before the check instead,
            // a hidden one is never marked, and is substituted anyway: the
            // picture a style just took off the page arrives in the book as an
            // image of zero by zero.
            let replacedByImage = tagName === 'svg' || tagName === 'canvas';
            if (!replacedByImage && allowedTags.indexOf(tagName) < 0) return;

            if (!isElementVisible(elem)) {
                getMark(state, elem).hidden = true;
                return;
            }
            // the class would be written onto an element that no longer exists
            if (replacedByImage) return;

            getMark(state, elem).cssClassName =
                classNameForComputedStyle(window.getComputedStyle(elem),
                                          state.styleSnapshot ? SNAPSHOT_CLASS_PREFIX : '');
        });
        state.css = jsonToCss(Object.fromEntries(classNameToCss));
        return;
    }

    // no style requested - hidden elements are still dropped, and any style the
    // background injected for this site is shipped as the chapter's stylesheet
    document.body.querySelectorAll('*').forEach((elem) => {
        // A formula is laid out by the browser as one thing, and its parts are
        // not separately visible: an <mspace> is whitespace, an <mphantom>
        // reserves room without drawing, and a script or a limit can round to
        // nothing. Measuring them individually takes the formula apart, which is
        // why the styled branch above skips them too.
        if (mathMLTags.indexOf(elem.tagName.toLowerCase()) > -1) {
            return;
        }
        if (!isElementVisible(elem)) {
            getMark(state, elem).hidden = true;
        }
    });

    if (appliedStyles && appliedStyles.length > 0) {
        state.css = appliedStyles.reduce((all, applied) => all + applied.css, '');
    }
}

function readLivePage(includeStyle, appliedStyles, styleSnapshot) {
    let state = newReadState();
    state.styleSnapshot = !!styleSnapshot;
    try {
        readIFrames(state);
        readCanvases(state);
        // before readSvgs: MathJax's SVG output is inside an <mjx-container>
        // that also holds the real MathML, and the math is the better answer.
        // A mark on the container replaces the svg's own mark along with the
        // rest of the subtree.
        readMathMl(state);
        readSvgs(state);
        readImages(state);
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

///// Reader mode - an optional step between the clone and the write phase

// Writes the read phase's answer onto a cloned <img>. srcset goes with it: the
// candidates it lists are the ones this src was chosen from, and leaving it
// behind lets the browser pick a different one again while the clone is still
// loading. Applied twice on the reader-mode path, which is why it is written to
// be idempotent.
function setResolvedImageSrc(elem, imageSrc) {
    try {
        if (elem.getAttribute('src') !== imageSrc) {
            elem.setAttribute('src', imageSrc);
        }
        elem.removeAttribute('srcset');
    } catch (e) {
        console.log('Error:', e);
    }
}

// Applies to the clone the verdicts that change the shape of the tree, in the
// same precedence applyReadState() uses. Only reader mode needs this: it is the
// write phase running early, on the nodes Readability is about to score.
//
// It has to happen first because every element the read phase promised to
// replace scores badly on its own. A rendered MathJax formula is an
// <mjx-container> holding an svg and no text, a chart is a <canvas> holding
// nothing at all, and Readability deletes an <iframe> outright unless it looks
// like a video. Substituting them first means what gets scored is the content
// they stand for - a <math>, an <img>, the frame's own markup - instead of an
// empty wrapper.
//
// A substituted element takes its marker with it, and a hidden one is gone, so
// applyReadState() finds nothing here to apply a second time.
function applyStructuralMarks(cloneRoot, state) {
    cloneRoot.querySelectorAll('[' + SAE_MARK_ATTR + ']').forEach(function (elem) {
        let mark = state.marks.get(elem.getAttribute(SAE_MARK_ATTR));
        if (!mark) {
            return;
        }
        if (mark.hidden) {
            elem.remove();
            return;
        }
        if (mark.imageSrc) {
            // Readability scores an image by what it points at and promotes
            // lazy attributes of its own, so the resolved source has to be in
            // place before it runs rather than after it.
            setResolvedImageSrc(elem, mark.imageSrc);
        }
        if (mark.replaceWithHtml) {
            elem.removeAttribute(SAE_MARK_ATTR);
            replaceElementWithHTML(elem, mark.replaceWithHtml);
        }
    });
}

// Distills the page down to its article, the way Firefox's Reader View does.
// Returns the article's root element, or null when there was nothing to find.
//
// Null is rarer than it sounds, and that is the useful part: when the best
// candidate comes out under Readability's character threshold - a forum thread,
// a search results page, an api reference, anything that is not prose - it
// retries with its heuristics progressively disabled and finally returns the
// longest attempt, which on such a page is close to the whole body. So the
// failure mode of pointing reader mode at the wrong page is a save that looks
// like a normal one, not a gutted chapter. Only a page it can find no text in at
// all comes back null.
//
// The marks are still on the live page when this runs, so it must be called
// before clearLiveMarks(), exactly like the plain clone it stands in for.
function extractReadableContent(state) {
    // the library is bundled, so this only fails if the injection did
    if (typeof Readability === 'undefined') {
        console.log('Error: Readability is not available');
        return null;
    }
    try {
        // Readability rewrites, unwraps and deletes as it scores, so it must only
        // ever see a clone. Handing it the live document would reintroduce
        // exactly the damage the read/clone/write split was built to eliminate.
        //
        // The whole document is cloned rather than <body> alone because the
        // constructor wants a Document: it reads <head> for the metadata and
        // resolves the article's urls against the document's base.
        let docClone = document.cloneNode(true);

        // Every relative url in the article is resolved against that base, and an
        // image whose src resolved against the wrong origin is one that never
        // downloads. A cloned document is specified to keep the original's url,
        // but stating the base outright costs one element and does not depend on
        // that. A page with a <base> of its own already answers correctly.
        let head = docClone.head || docClone.documentElement;
        if (head && !docClone.querySelector('base[href]')) {
            let base = docClone.createElement('base');
            base.setAttribute('href', document.baseURI);
            head.insertBefore(base, head.firstChild);
        }

        applyStructuralMarks(docClone, state);

        let article = new Readability(docClone, {
            // Without this parse() hands back a string, which would have to be
            // parsed again to reach getContent(). getContent() wants a node, and
            // this is the node it wants.
            serializer: (elem) => elem
        }).parse();

        if (!article || !article.content) {
            return null;
        }
        // A page with a plausible-looking container and nothing in it gets an
        // empty shell rather than the null above.
        if (!article.content.textContent || article.content.textContent.trim() === '') {
            return null;
        }
        return article.content;
    } catch (e) {
        console.log('Error:', e);
        return null;
    }
}

///// Write phase - operates only on the cloned tree

// Anything past this and the alttext is no longer a text alternative, it is a
// second copy of the document in an attribute.
var MAX_ALTTEXT_LENGTH = 1000;

// MathJax v2 keeps the source MathML in a data attribute on the frame it wraps
// its rendered output in. Unlike v3 that frame is a <span>, which survives into
// the clone, so it can be replaced here rather than in the read phase.
function extractMathMl(htmlObject) {
    htmlObject.querySelectorAll('span[id^="MathJax-Element-"]').forEach(function (el) {
        // v2 only writes data-mathml when the page asked it to. Without it there
        // is nothing to put in the frame's place, and the string "null" is
        // certainly not it - which is what this used to insert.
        let mathml = el.getAttribute('data-mathml');
        if (mathml) {
            replaceElementWithHTML(el, mathml);
        }
    });
}

// MathML Core dropped <mfenced>, and a reader that implements Core lays out its
// children with no brackets around them - so "(x, y)" is rendered "xy". The
// MathML 3 spec defines it as equivalent to an mrow of fence and separator
// operators, which is exactly what is written here.
function expandMFenced(elem) {
    let doc = elem.ownerDocument;
    // the spec's defaults, and "no attribute" is different from "empty
    // attribute": open="" means this side has no bracket at all
    let open = elem.hasAttribute('open') ? elem.getAttribute('open') : '(';
    let close = elem.hasAttribute('close') ? elem.getAttribute('close') : ')';
    let separators = (elem.hasAttribute('separators') ? elem.getAttribute('separators') : ',')
                     .replace(/\s+/g, '');

    let operator = function (text, role) {
        let mo = doc.createElementNS(MATHML_NS, 'mo');
        mo.setAttribute(role, 'true');
        mo.textContent = text;
        return mo;
    };

    let mrow = doc.createElementNS(MATHML_NS, 'mrow');
    if (open) {
        mrow.appendChild(operator(open, 'fence'));
    }
    // a snapshot: appending to the mrow moves each child out of elem
    Array.from(elem.children).forEach(function (child, index) {
        if (index > 0 && separators.length > 0) {
            // fewer separators than gaps means the last one repeats
            mrow.appendChild(operator(
                separators.charAt(Math.min(index - 1, separators.length - 1)), 'separator'));
        }
        mrow.appendChild(child);
    });
    if (close) {
        mrow.appendChild(operator(close, 'fence'));
    }
    elem.parentNode.replaceChild(mrow, elem);
}

// Same element, different name, same children and attributes.
function renameMathMlElement(elem, name) {
    let replacement = elem.ownerDocument.createElementNS(MATHML_NS, name);
    for (let i = 0; i < elem.attributes.length; i++) {
        try {
            replacement.setAttribute(elem.attributes[i].name, elem.attributes[i].value);
        } catch (e) {
            // an attribute name the source page made up that is not settable
            console.log('Error:', e);
        }
    }
    while (elem.firstChild) {
        replacement.appendChild(elem.firstChild);
    }
    elem.parentNode.replaceChild(replacement, elem);
}

// The TeX the formula was typeset from, promoted out of the <annotation> that is
// about to be dropped with the rest of the stripped content.
//
// This is the whole of the answer to "what about readers with no MathML at all".
// alttext is what such a reading system, and a screen reader in front of one,
// reads instead of the markup, and filling it from an annotation the page
// already carries costs one attribute. A real rendered fallback - an SVG of
// every formula, sized and baseline-aligned - is a different project.
function setMathAlttext(math) {
    if ((math.getAttribute('alttext') || '').trim()) {
        return;   // the page already said it better than we can
    }
    let annotations = math.querySelectorAll('annotation');
    for (let annotation of annotations) {
        // "application/x-tex", "text/x-tex", "TeX", "LaTeX" - but not
        // "text/plain", which contains those three letters by accident
        if (!/(^|[/+-])(la)?tex$/i.test(annotation.getAttribute('encoding') || '')) {
            continue;
        }
        let tex = (annotation.textContent || '').replace(/\s+/g, ' ').trim();
        if (!tex) {
            continue;
        }
        if (tex.length > MAX_ALTTEXT_LENGTH) {
            tex = tex.substring(0, MAX_ALTTEXT_LENGTH - 1) + '…';
        }
        math.setAttribute('alttext', tex);
        return;
    }
}

// Rewrites what MathML Core removed into what Core has. Runs on the clone,
// before the tag allowlist ever sees any of it - by then an <mfenced> is an
// unknown tag and its brackets have gone with it.
function normalizeMathMl(root) {
    root.querySelectorAll('math').forEach(function (math) {
        try {
            setMathAlttext(math);
            // Outermost first, which is the order querySelectorAll returns:
            // replacing an mfenced keeps its descendants, so a nested one is
            // still in this list and still in the tree when its turn comes.
            math.querySelectorAll('mfenced').forEach(expandMFenced);
            math.querySelectorAll('mlabeledtr').forEach(function (row) {
                renameMathMlElement(row, 'mtr');
            });
        } catch (e) {
            console.log('Error:', e);
        }
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
            // A snapshot keeps both: the page's own class names, which are what a
            // site style is written against, and the generated one carrying the
            // computed style, which is what makes the preview look like the page
            // rather than like bare markup. Everywhere else the page's class
            // attribute must not survive, so the generated name goes somewhere
            // the sanitizer reads it from instead.
            if (state.styleSnapshot) {
                let own = elem.getAttribute('class');
                elem.setAttribute('class', own && own.trim() !== '' ?
                                           own + ' ' + mark.cssClassName : mark.cssClassName);
            } else {
                elem.setAttribute('data-class', mark.cssClassName);
            }
        }
        if (mark.imageSrc) {
            setResolvedImageSrc(elem, mark.imageSrc);
        }
        if (mark.replaceWithHtml) {
            // no-op when the element was already dropped with an ancestor
            replaceElementWithHTML(elem, mark.replaceWithHtml);
        }
    });

    // after the marks, which is what puts the MathJax v3 and KaTeX formulas into
    // the clone in the first place
    extractMathMl(cloneRoot);
    normalizeMathMl(cloneRoot);
}

// Ids already written into this chapter. An id is only addressable if it is
// unique in the file it lives in, and a page that repeats one - which is invalid
// html but common - would otherwise repeat it here too.
//
// Reset per job rather than per fragment, like the image and class state: a
// selection spanning several ranges is one chapter, and the second range must
// not hand out an id the first already used.
var usedElementIds = new Set();

// Where an <a href> ends up. A link the page made to a position inside itself
// stays a link to a position inside the chapter, and everything else is
// resolved against the page so that it still works away from it.
//
// Absolutising a fragment was the old behaviour: even when it resolves to the
// correct source page, following that absolute URL leaves the book instead of
// jumping to the matching id in this chapter.
function linkHref(rawHref) {
    let value = rawHref == null ? '' : String(rawHref).trim();
    if (value === '' || !isSafeLinkUrl(value)) {
        return '';
    }

    let fragment = sameDocumentFragment(value);
    if (fragment !== null) {
        // "#" on its own, or a fragment that is not a name an id can have, names
        // nothing this chapter can point at. Absolutising it would send the
        // reader out of the book to find it, so the link becomes plain text.
        return isUsableId(fragment) ? '#' + fragment : '';
    }

    return getHref(value);
}

// Where a url-valued attribute that is not an <a href> ends up - <blockquote
// cite>, <del cite>. Nothing in the archive depends on these resolving and none
// of them addresses a position in the chapter, so unlike linkHref() a fragment
// is absolutised with everything else. What still matters is the scheme: a
// javascript: cite is inert in most readers, but not all, and epubcheck rejects
// it outright.
function citeUrl(rawValue) {
    let value = rawValue == null ? '' : String(rawValue).trim();
    if (value === '' || !isSafeLinkUrl(value)) {
        return '';
    }
    return getHref(value);
}

// The fragment of an href that addresses this same document, or null if the href
// goes somewhere else. Both spellings count: the bare "#note-3", and the fully
// written out form a template engine emits, which resolves to this page.
function sameDocumentFragment(href) {
    if (href.indexOf('#') === 0) {
        return href.substring(1);
    }
    if (href.indexOf('#') < 0) {
        return null;
    }
    try {
        let resolved = new URL(href, document.baseURI);
        let hash = resolved.hash;
        if (hash === '' || hash === '#') {
            return null;
        }
        resolved.hash = '';
        // getPageSourceUrl() is the page's own address with the fragment taken
        // off, which is exactly what this has to be compared against
        return resolved.href.replace(/#$/, '') === getPageSourceUrl() ?
               hash.substring(1) : null;
    } catch (e) {
        return null;
    }
}

// How the shared sanitizer resolves what only a live page can answer: where a
// url points, and which images are being downloaded. What these read and append
// to - imageFileNames, allImages, usedElementIds - is job-wide rather than
// per fragment, which is what lets a selection spanning several ranges come out
// as one chapter with one set of images and no id handed out twice.
//
// The editor answers the same questions without a page - see sanitizeOptions()
// in sanitizeHtml.js, whose defaults are exactly that.
function extractionSanitizeOptions(state) {
    return sanitizeOptions({
        resolveImageSrc: getImageSrc,
        resolveLinkHref: linkHref,
        resolveUrl: citeUrl,
        // the class attribute on a clone is still the page's own; the generated
        // name is what applyReadState() wrote into data-class.
        //
        // A style snapshot is the exception, and the reason it is a mode rather
        // than an ordinary capture: the page's class names are what the styles
        // being previewed select on, so there they are read from where they
        // already are - with the generated name appended to them.
        classAttribute: state && state.styleSnapshot ? 'class' : 'data-class',
        usedIds: usedElementIds
    });
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
        return '<div>' + parseHTML(tmp.innerHTML, extractionSanitizeOptions(state)) + '</div>';
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

// An image that never reaches the archive takes its <img> tags with it. Leaving
// them behind points the content at a file that is not in the book, which fails
// validation for the whole thing - a strictly worse outcome than one missing
// picture, and the reason both exits below call this rather than only logging.
//
// The url, not the filename, is what gets recorded: the filename is generated
// here and means nothing outside the archive, and in the placeholder case it has
// already been rewritten by the time the drop happens. The url is what the user
// can go and look at.
function dropImage(filename, url, reason) {
    tmpGlobalContent = removeImgTags(tmpGlobalContent, filename);
    droppedImages.push({url: url || '', reason: reason});
}

// Always resolves - one image that cannot be downloaded must not stop the rest
// of the ebook from being built
function deferredAddZip(url, filename) {
    return fetchBinaryContent(url).then((data) => {
        if (filename.endsWith(IMG_TYPE_PLACEHOLDER)) {
            let extension = sniffImageExtension(data);
            if (extension === '') {
                // A format no reading system is required to render - or not an
                // image at all. Either way there is no media type to declare.
                console.log("Error! Unable to extract the image type!");
                dropImage(filename, url, 'type');
                return;
            }
            let oldFilename = filename
            filename = filename.replace(IMG_TYPE_PLACEHOLDER, extension)
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
        // filename is whatever it was rewritten to above, if it got that far
        dropImage(filename, url, 'fetch');
    });
}

// Extraction can outlive the background's job timeout, mostly in the image
// downloads. A job that is still making progress keeps saying so; one whose tab
// was closed or navigated away stops, and the background reclaims it.
var HEARTBEAT_INTERVAL = 5000;

// The job id is the one the background sent with the extraction request, so a
// heartbeat from an extraction that outlived its job cannot extend the job that
// replaced it.
function startHeartbeat(jobId) {
    let send = () => {
        try {
            chrome.runtime.sendMessage({type: 'job-heartbeat', jobId: jobId}, () => {
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

// ---- page metadata ---------------------------------------------------------
//
// Everything below reads <head>, which never reaches getContent(): head, title,
// meta, link and script are all in strippedContentTags, so the sanitized body
// carries none of it. This is a separate, deliberate read of the live document,
// and it belongs in the read phase for the same reason the rest does - by the
// time the clone exists, none of this is in it.
//
// Nothing here is trusted. Every value ends up in a package document that an
// epub reader must be able to parse, and the pages supplying it are arbitrary.

// json-ld @type values worth reading article metadata from, most specific first:
// a page with both a WebPage node and an Article node means the Article.
var SCHEMA_ARTICLE_TYPES = ['Article', 'NewsArticle', 'BlogPosting', 'ScholarlyArticle',
                            'TechArticle', 'Report', 'ReportageNewsArticle'];
var SCHEMA_FALLBACK_TYPES = ['WebPage', 'CreativeWork'];
// Anything past this is a page dumping its article body into a description tag
var MAX_DESCRIPTION_LENGTH = 1000;
var MAX_NAME_LENGTH = 200;
var MAX_AUTHORS = 12;
// Some sites ship a whole product catalog as json-ld; parsing it costs far more
// than the byline it might contain is worth
var MAX_JSON_LD_LENGTH = 512 * 1024;
var MAX_SCHEMA_NODES = 200;

function metaValues(selector) {
    let values = [];
    let nodes = document.querySelectorAll(selector);
    for (let i = 0; i < nodes.length; i++) {
        let value = (nodes[i].getAttribute('content') || '').trim();
        if (value) {
            values.push(value);
        }
    }
    return values;
}

function firstMetaValue(selector) {
    let values = metaValues(selector);
    return values.length > 0 ? values[0] : '';
}

// schema.org lets any of these positions hold a string, an object with a name,
// or an array of either, so every read of one goes through here.
function schemaNames(value) {
    if (!value) {
        return [];
    }
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.reduce(function(names, item) {
            return names.concat(schemaNames(item));
        }, []);
    }
    if (typeof value === 'object') {
        return schemaNames(value.name);
    }
    return [];
}

function schemaTypes(node) {
    let type = node ? node['@type'] : null;
    if (typeof type === 'string') {
        return [type];
    }
    if (Array.isArray(type)) {
        return type.filter(function(entry) {
            return typeof entry === 'string';
        });
    }
    return [];
}

// Flattens the shapes a page can wrap its json-ld in: a bare object, an array of
// them, or a @graph holding the real nodes beside boilerplate ones.
function collectSchemaNodes(parsed, nodes) {
    if (!parsed || nodes.length >= MAX_SCHEMA_NODES) {
        return nodes;
    }
    if (Array.isArray(parsed)) {
        parsed.forEach(function(entry) {
            collectSchemaNodes(entry, nodes);
        });
        return nodes;
    }
    if (typeof parsed !== 'object') {
        return nodes;
    }
    nodes.push(parsed);
    if (parsed['@graph']) {
        collectSchemaNodes(parsed['@graph'], nodes);
    }
    return nodes;
}

function findSchemaNode(nodes, wantedTypes) {
    for (let i = 0; i < nodes.length; i++) {
        let types = schemaTypes(nodes[i]);
        for (let j = 0; j < types.length; j++) {
            if (wantedTypes.indexOf(types[j]) > -1) {
                return nodes[i];
            }
        }
    }
    return null;
}

function findArticleSchema() {
    let nodes = [];
    let scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        let text = scripts[i].textContent || '';
        if (!text || text.length > MAX_JSON_LD_LENGTH) {
            continue;
        }
        try {
            collectSchemaNodes(JSON.parse(text), nodes);
        } catch (e) {
            // malformed json-ld is common and not worth failing over - the meta
            // tags are still there
        }
    }
    return findSchemaNode(nodes, SCHEMA_ARTICLE_TYPES) ||
           findSchemaNode(nodes, SCHEMA_FALLBACK_TYPES);
}

// article:author is a link to a profile page at least as often as it is a name,
// and an href in dc:creator is worse than no creator at all.
function looksLikeUrl(text) {
    return /^(https?|ftp|mailto|urn|tel):/i.test(text) || /^\/\//.test(text) || /^www\./i.test(text);
}

function cleanName(raw) {
    if (typeof raw !== 'string') {
        return '';
    }
    let name = raw.replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_NAME_LENGTH || looksLikeUrl(name)) {
        return '';
    }
    return name;
}

// normalizeDate() and normalizeLanguageTag() live in utils.js: the chapter
// editor validates what a user types into the metadata panel by the same rules
// that decide what survives a page's <head>, and it never loads this file.

function extractLanguage() {
    let lang = normalizeLanguageTag(document.documentElement ?
                                    document.documentElement.getAttribute('lang') : '');
    if (!lang) {
        lang = normalizeLanguageTag(firstMetaValue('meta[property="og:locale" i], meta[name="og:locale" i]'));
    }
    if (!lang) {
        lang = normalizeLanguageTag(firstMetaValue('meta[http-equiv="content-language" i]'));
    }
    return lang;
}

// A page states which way it reads on <html>, either as a dir attribute or in
// css, and neither reached the chapter on its own: extraction starts at
// document.body, so the attribute is never in the content, and `direction` is not
// one of the properties in supportedCss. An Arabic or Hebrew page therefore came
// out as a left to right book by both routes.
//
// The computed style is what is read, because it is the one answer that covers
// both spellings - and dir="auto" as well, which resolves to whichever direction
// the text turned out to be.
//
// Only rtl is reported. Left to right is the default in every reading system, so
// recording it would put an attribute on every chapter of every book to say what
// was already true.
function extractDirection() {
    let element = document.body || document.documentElement;
    if (!element) {
        return '';
    }
    let direction = '';
    try {
        direction = window.getComputedStyle(element).direction || '';
    } catch (e) {
        // no layout to read - fall back to what the document says about itself
        direction = (document.documentElement &&
                     document.documentElement.getAttribute('dir')) || '';
    }
    return direction.toLowerCase() === 'rtl' ? 'rtl' : '';
}

// One source wins outright instead of the sources being merged: the same person
// spelled two ways across json-ld and a meta tag is a much more common outcome
// than a second author only one of them knows about.
function extractAuthors(schema) {
    let candidates = [];
    if (schema) {
        candidates = schemaNames(schema.author);
        if (candidates.length === 0) {
            candidates = schemaNames(schema.creator);
        }
    }
    if (candidates.length === 0) {
        candidates = metaValues('meta[name="author" i]');
    }
    if (candidates.length === 0) {
        candidates = metaValues('meta[name="citation_author" i]');
    }
    if (candidates.length === 0) {
        candidates = metaValues('meta[property="article:author" i], meta[name="article:author" i]');
    }

    let authors = [];
    for (let i = 0; i < candidates.length && authors.length < MAX_AUTHORS; i++) {
        let name = cleanName(candidates[i]);
        if (name && authors.indexOf(name) < 0) {
            authors.push(name);
        }
    }
    return authors;
}

function extractPublisher(schema) {
    let fromSchema = schema ? schemaNames(schema.publisher) : [];
    let publisher = cleanName(fromSchema.length > 0 ? fromSchema[0] : '');
    if (!publisher) {
        publisher = cleanName(firstMetaValue('meta[property="og:site_name" i], meta[name="og:site_name" i]'));
    }
    if (!publisher) {
        publisher = cleanName(firstMetaValue('meta[name="publisher" i]'));
    }
    if (!publisher) {
        publisher = cleanName(firstMetaValue('meta[name="application-name" i]'));
    }
    return publisher;
}

function extractDescription(schema) {
    let description = firstMetaValue('meta[property="og:description" i], meta[name="og:description" i]');
    if (!description) {
        description = firstMetaValue('meta[name="description" i]');
    }
    if (!description && schema && typeof schema.description === 'string') {
        description = schema.description;
    }
    description = (description || '').replace(/\s+/g, ' ').trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        // cut at a word boundary so the result does not end mid-word
        description = description.substring(0, MAX_DESCRIPTION_LENGTH - 1)
                                 .replace(/\s+\S*$/, '') + '…';
    }
    return description;
}

function extractDate(schema) {
    let date = '';
    if (schema && typeof schema.datePublished === 'string') {
        date = normalizeDate(schema.datePublished);
    }
    if (!date) {
        date = normalizeDate(firstMetaValue('meta[property="article:published_time" i], meta[name="article:published_time" i]'));
    }
    if (!date) {
        date = normalizeDate(firstMetaValue('meta[name="citation_publication_date" i]'));
    }
    if (!date) {
        date = normalizeDate(firstMetaValue('meta[itemprop="datePublished" i]'));
    }
    if (!date) {
        date = normalizeDate(firstMetaValue('meta[name="date" i]'));
    }
    return date;
}

function readPageMetadata() {
    try {
        let schema = findArticleSchema();
        return {
            lang: extractLanguage(),
            dir: extractDirection(),
            authors: extractAuthors(schema),
            publisher: extractPublisher(schema),
            description: extractDescription(schema),
            date: extractDate(schema)
        };
    } catch (e) {
        // metadata is a bonus - a page that breaks this must still be saveable
        console.log('Error:', e);
        return {lang: '', dir: '', authors: [], publisher: '', description: '', date: ''};
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
    let readerModeFailed = false;

    // Reset once per job, not once per parsed fragment: a selection spanning
    // several ranges calls getContent() for each one.
    allImages = [];
    extractedImages = [];
    droppedImages = [];
    imageFileNames.clear();
    classNameToCss.clear();
    cssToClassName.clear();
    usedElementIds.clear();

    // Downloading the images can take far longer than the background's job
    // timeout, so tell it we are still alive while they run.
    let heartbeat = startHeartbeat(request.jobId);

    // read phase: <head> is gone from the clone, and a single-page app can
    // rewrite it while the images download
    let pageMetadata = readPageMetadata();

    let state = readLivePage(request.includeStyle, request.appliedStyles, request.styleSnapshot);
    try {
        // clone while the markers are still on the live elements
        let clones = [];
        if (request.type === 'extract-page') {
            // Reader mode never reaches a selection: the user picking the nodes
            // has already said what the content is, and Range.cloneContents()
            // yields a fragment rather than the document Readability needs.
            // The background only ever sets the flag for an 'extract-page'.
            let readable = request.readerMode ? extractReadableContent(state) : null;
            // Falling back is right - refusing to save the page because it is not
            // an article would be worse - but doing it silently would make the
            // checkbox look like it does nothing.
            readerModeFailed = !!request.readerMode && !readable;
            clones.push(readable || document.body.cloneNode(true));
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
            sourceUrl: getPageSourceUrl(),
            metadata: pageMetadata,
            styleFileContent: styleFile,
            // as with url above: a label on the stored record, not the name the
            // stylesheet is written into the archive under. buildEbook() derives
            // that from the chapter's position, because a random number is not
            // unique and one stylesheet overwriting another is silent.
            styleFileName: 'style' + generateRandomNumber() + '.css',
            images: extractedImages,
            content: tmpGlobalContent
        };
        // Set only when it happened. This object is stored as the chapter record,
        // and how a chapter was extracted is not part of what a chapter is.
        if (readerModeFailed) {
            result.readerModeFailed = true;
        }
        // Same rule, same reason: absent unless something was actually lost. The
        // urls travel with the chapter rather than only being logged, so that a
        // user who reads the warning after the editor has already opened still
        // has a way to find out which pictures are missing.
        if (droppedImages.length > 0) {
            result.droppedImages = droppedImages.slice();
        }
        sendResponse(result);
    }).catch((e) => {
        console.log('Error:', e);
        sendResponse(null)
    }).finally(() => {
        stopHeartbeat(heartbeat);
    });

    return true;
});
