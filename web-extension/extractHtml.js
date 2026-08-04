
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
                '<img src="' + imgSrc + '" width="' + bbox.width + '" height="' + bbox.height + '"' +
                altAttribute(accessibleLabel(elem)) + ' />';
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
        state.css = appliedStyles.reduce((all, applied) => all + applied.style, '');
    }
}

function readLivePage(includeStyle, appliedStyles) {
    let state = newReadState();
    try {
        readIFrames(state);
        readCanvases(state);
        // before readSvgs: MathJax's SVG output is inside an <mjx-container>
        // that also holds the real MathML, and the math is the better answer.
        // A mark on the container replaces the svg's own mark along with the
        // rest of the subtree.
        readMathMl(state);
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
            elem.setAttribute('data-class', mark.cssClassName);
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

// MathML carries its meaning in its attributes at least as much as in its tags.
// display="block" alone is the difference between a centred display equation and
// something jammed into the middle of a sentence; stretchy and largeop size the
// brackets and the integral signs; columnalign is what makes a matrix line up;
// linethickness="0" is how a binomial coefficient is written. Only alttext used
// to survive, so all of that was lost on every formula.
//
// The vocabulary is allowed wholesale rather than enumerated, which is the
// opposite of how the HTML attributes above are handled and deliberately so:
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
function attrUrl(value) {
    var normalized = value.trim();
    if (normalized === '' || !isSafeLinkUrl(normalized)) {
        return '';
    }
    return getHref(normalized);
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

// Ids already written into this chapter. An id is only addressable if it is
// unique in the file it lives in, and a page that repeats one - which is invalid
// html but common - would otherwise repeat it here too.
//
// Reset per job rather than per fragment, like the image and class state: a
// selection spanning several ranges is one chapter, and the second range must
// not hand out an id the first already used.
var usedElementIds = new Set();

// walkHtmlFragment hands over values the HTML parser has already decoded, so
// they only need escaping - decoding here as well would turn a literal
// "&amp;lt;" on the page into a "<" in the epub
function attrValue(value) {
    return escapeXMLChars(value == null ? '' : String(value));
}

// The id, the globals and whatever the tag itself allows. Attributes the caller
// has already written - src, alt, href, class and the img dimensions - are not
// in any of these tables and cannot be duplicated from here.
function extraHtmlAttributes(tag, attrs) {
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
            if (!isUsableId(rawValue) || usedElementIds.has(rawValue)) {
                continue;
            }
            usedElementIds.add(rawValue);
            written.add(name);
            result += ' id="' + attrValue(rawValue) + '"';
            continue;
        }

        let filter = globalHtmlAttributes[name] || perTag[name];
        if (!filter) {
            continue;
        }
        let value = filter(rawValue);
        if (value === '') {
            continue;
        }
        written.add(name);
        result += ' ' + name + '="' + attrValue(value) + '"';
    }

    return result;
}

// Where an <a href> ends up. A link the page made to a position inside itself
// stays a link to a position inside the chapter, and everything else is
// resolved against the page so that it still works away from it.
//
// Absolutising a fragment was the old behaviour and it broke both halves at
// once: getAbsoluteUrl() appends "#note-3" to the *directory* the page is in, so
// a footnote marker became a link to a different address entirely, and following
// it left the book.
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
                            tmpSrc = getImageSrc(attrs[i].value)
                            tmpAttrsTxt += ' src="' + attrValue(tmpSrc) + '"';
                        } else if (attrs[i].name === 'alt') {
                            tmpAlt = attrs[i].value == null ? '' : String(attrs[i].value);
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
                    if (tmpAlt !== null) {
                        tmpAttrsTxt += ' alt="' + attrValue(tmpAlt.replace(/\s+/g, ' ').trim()) + '"';
                    }
                } else if (tag === 'a') {
                    for (let i = 0; i < attrs.length; i++) {
                        if (attrs[i].name === 'href') {
                            let href = linkHref(attrs[i].value);
                            if (href !== '') {
                                tmpAttrsTxt += ' href="' + attrValue(href) + '"';
                            }
                        } else if (attrs[i].name === 'data-class') {
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
                        if (attrs[i].name === 'data-class') {
                            tmpAttrsTxt += ' class="' + attrValue(attrs[i].value) + '"';
                        }
                    }
                }

                // MathML has been through its own allowlist just above, and the
                // two vocabularies do not share attributes - lang and dir mean
                // nothing on an <mrow>, and an id there is denied on purpose.
                if (mathMLTags.indexOf(tag) < 0) {
                    tmpAttrsTxt += extraHtmlAttributes(tag, attrs);
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

// An image that never reaches the archive takes its <img> tags with it. Leaving
// them behind points the content at a file that is not in the book, which fails
// validation for the whole thing - a strictly worse outcome than one missing
// picture, and the reason both exits below call this rather than only logging.
function dropImage(filename) {
    tmpGlobalContent = removeImgTags(tmpGlobalContent, filename);
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
                dropImage(filename);
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
        dropImage(filename);
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

function yearIsPlausible(year) {
    let value = parseInt(year, 10);
    return value >= 1400 && value <= new Date().getFullYear() + 1;
}

// dc:date must be a W3C-DTF date, and pages supply everything from "2024-03-01"
// to "Fri, 01 Mar 2024 09:00:00 GMT".
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
            authors: extractAuthors(schema),
            publisher: extractPublisher(schema),
            description: extractDescription(schema),
            date: extractDate(schema)
        };
    } catch (e) {
        // metadata is a bonus - a page that breaks this must still be saveable
        console.log('Error:', e);
        return {lang: '', authors: [], publisher: '', description: '', date: ''};
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
    usedElementIds.clear();

    // Downloading the images can take far longer than the background's job
    // timeout, so tell it we are still alive while they run.
    let heartbeat = startHeartbeat();

    // read phase: <head> is gone from the clone, and a single-page app can
    // rewrite it while the images download
    let pageMetadata = readPageMetadata();

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
            sourceUrl: getPageSourceUrl(),
            metadata: pageMetadata,
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
