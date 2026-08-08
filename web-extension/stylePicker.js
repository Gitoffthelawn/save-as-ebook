// Pointing at a thing on the page instead of writing a selector for it.
//
// The library previews a style against a snapshot - a page captured by the popup
// and rendered in an iframe on the library page. That frame is our own document,
// which is what makes this possible at all: the extension holds activeTab and
// nothing more, so it cannot reach into a live site from a tab of its own, and
// the old selector.js, which tried to, could only ever have run as a script
// injected into the page it was picking in.
//
// Two halves, and only the first has any state:
//
//   selectorForElement() turns an element into a css selector. It is the part
//   that has to be right, because what it returns is stored and then applied to
//   the live page on every capture - a selector that is about the snapshot rather
//   than about the site is a style that quietly stops working.
//
//   createStylePickerSession() is the hovering and clicking, in the frame.
//
// Requires utils.js, for isUsableId() and SNAPSHOT_CLASS_PREFIX.

// On an element in the frame while the pointer is over it. Never serialized -
// nothing reads content back out of this frame, unlike the chapter editor's -
// but it is still kept out of every selector this file generates, or picking an
// element would name it by the fact that it was being pointed at.
var STYLE_PICKER_HOVER_CLASS = 'sae-pick-hover';

// How far up from the element under the pointer a widening can go. A ceiling
// rather than a limit anybody reaches: at the top is <body>, which stops it
// first on any real page.
var STYLE_PICKER_MAX_WIDEN = 12;

// How many ancestors a selector may name before it stops being about the page
// and starts being about this one snapshot of it. A path this long has already
// failed to find anything unique and is unlikely to survive the site changing.
var STYLE_PICKER_MAX_DEPTH = 4;

var STYLE_PICKER_STYLESHEET =
    '.' + STYLE_PICKER_HOVER_CLASS + '{' +
        'outline:2px solid #0a58ca !important;' +
        'outline-offset:-2px !important;' +
        'background-color:rgba(10,88,202,0.12) !important;' +
    '}' +
    'body.sae-picking *{cursor:crosshair !important;}';

// ---- naming an element ------------------------------------------------------

// A class name this file will put in a selector. Three kinds are refused, for
// three different reasons: the generated ones are ours and are minted afresh by
// every capture, the hover class is the picker looking at itself, and a name
// that is not a css identifier cannot be written as ".name" at all.
//
// Identifiers are not escaped instead of being refused on purpose. A class that
// needs escaping is a class the site generated, and a selector built out of one
// is a selector that breaks the next time the site is built.
function isPickableClassName(name) {
    if (typeof name !== 'string' || name === '') {
        return false;
    }
    if (name === STYLE_PICKER_HOVER_CLASS || name.indexOf(SNAPSHOT_CLASS_PREFIX) === 0) {
        return false;
    }
    return /^-?[A-Za-z_][-A-Za-z0-9_]*$/.test(name);
}

// How likely a class name is to still mean the same thing next week, lower being
// better. The distinction that matters is the last one: "sidebar" is what a
// person called a part of their page, "css-1x9fk2" is what a build tool called
// it this morning, and a style pinned to the second one dies on the next deploy.
// It is a guess made from the shape of the name, which is all there is to go on,
// so it orders the candidates rather than throwing any of them away.
function classNameRank(name) {
    // words a person typed: letters, and separators between them
    if (/^[a-z][a-z]*([-_][a-z]+)*$/.test(name) && name.length > 2) {
        return 0;
    }
    // the same, with a number on the end - "col-2", "level3". Still readable,
    // still usually hand written.
    if (/^[a-zA-Z][a-zA-Z]*([-_][a-zA-Z0-9]+)*[0-9]*$/.test(name) && name.length > 2) {
        return 1;
    }
    return 2;
}

// The classes worth naming this element by, best first.
function pickableClassNames(element) {
    let raw = element && element.getAttribute ? (element.getAttribute('class') || '') : '';
    let names = raw.split(/\s+/).filter(isPickableClassName);
    // A stable sort by rank only - the page's own order is kept within a rank,
    // because that order is the one the author wrote and reads as most-general
    // first ("card card-wide").
    return names.map((name, index) => ({name: name, index: index}))
                .sort((a, b) => {
                    let rank = classNameRank(a.name) - classNameRank(b.name);
                    return rank !== 0 ? rank : a.index - b.index;
                })
                .map((entry) => entry.name);
}

function elementTagName(element) {
    return element && element.tagName ? element.tagName.toLowerCase() : '';
}

// How many elements in the frame a selector covers, or -1 when it is not a
// selector the browser will take. The count is what decides whether a selector
// is finished, and -1 is deliberately not 0: a selector that cannot be parsed
// must not read as one that happens to match nothing.
function selectorMatchCount(root, selector) {
    if (!root || selector === '') {
        return -1;
    }
    try {
        return root.querySelectorAll(selector).length;
    } catch (e) {
        return -1;
    }
}

// Ways to name this element without reference to where it sits, from the one
// that says least to the one that says most: the tag with its best class, then
// with a second class, then the bare tag. An id short-circuits the lot.
//
// Least first, and never more than two classes, because the shortest selector
// that names the right thing is the one most likely to still name it after the
// site is redesigned. A selector carrying every class an element happens to have
// is a description of this one element in this one snapshot.
function ownSelectorCandidates(element) {
    let tag = elementTagName(element);
    if (tag === '') {
        return [];
    }
    let id = element.getAttribute ? element.getAttribute('id') : '';
    if (id && isUsableId(id)) {
        return ['#' + id];
    }
    let classes = pickableClassNames(element).slice(0, 2);
    let candidates = [];
    for (let count = 1; count <= classes.length; count++) {
        candidates.push(tag + classes.slice(0, count).map((name) => '.' + name).join(''));
    }
    candidates.push(tag);
    return candidates;
}

// The one to fall back to when nothing is unique, and the one an ancestor
// contributes to a longer selector: the least it can say and still say
// something.
function ownSelector(element) {
    let candidates = ownSelectorCandidates(element);
    return candidates.length === 0 ? '' : candidates[0];
}

// The selector to write for an element, as the picker will insert it.
//
// Built outwards until it names one thing: the element itself, then the element
// under an ancestor, and so on. Descendant combinators rather than child ones,
// and no :nth-child anywhere - both would be claims about the structure around
// the element, and the structure in the snapshot is not the page's. Extraction
// has already dropped everything invisible and everything it does not carry into
// a book, so the second paragraph here is rarely the second paragraph there.
//
// May return a selector that covers more than one element, when nothing above it
// is named well enough to narrow it down. That is reported rather than papered
// over - see the count the session hands to onPick - and the preview shows what
// it takes with it either way.
function selectorForElement(element, root) {
    let candidates = ownSelectorCandidates(element);
    if (candidates.length === 0) {
        return '';
    }
    // An id is unique by definition where it is usable at all, and a page that
    // repeats one has already been through a sanitizer that kept only the first.
    if (candidates[0].charAt(0) === '#') {
        return candidates[0];
    }
    for (let candidate of candidates) {
        if (selectorMatchCount(root, candidate) === 1) {
            return candidate;
        }
    }

    let selector = candidates[0];
    let ancestor = element.parentNode;
    for (let depth = 0; depth < STYLE_PICKER_MAX_DEPTH; depth++) {
        if (!ancestor || ancestor.nodeType !== 1) {
            break;
        }
        let tag = elementTagName(ancestor);
        if (tag === 'body' || tag === 'html') {
            break;
        }
        let above = ownSelector(ancestor);
        // A bare tag adds nothing a descendant combinator does not already say
        // about the element - "div p" covers what "p" covers on any page that has
        // a div in it - so it is skipped rather than lengthening the selector.
        if (above !== '' && above !== tag) {
            selector = above + ' ' + selector;
            if (selectorMatchCount(root, selector) === 1) {
                return selector;
            }
            if (above.charAt(0) === '#') {
                break;
            }
        }
        ancestor = ancestor.parentNode;
    }
    return selector;
}

// The rule a picked element becomes. The one thing a picker is for: everything
// else a style does is typed, and hiding a thing is the one that needs pointing.
function hideRuleFor(selector) {
    return selector + ' {\n    display: none !important;\n}\n';
}

// ---- picking, in the frame --------------------------------------------------

// Starts a picking session on a rendered snapshot frame. It is inert until
// setActive(true): a preview is for reading as well as for pointing at.
//
// frameDocument  the loaded document inside the preview iframe
// options        onPick    (selector, matchCount, label) for a clicked element
//                onHover   called whenever what a click would take changes, so
//                          the toolbar outside the frame can say what it is
//                onEscape  escape pressed while the frame has focus, which the
//                          page around it never sees
function createStylePickerSession(frameDocument, options) {
    options = options || {};

    let active = false;
    let hovered = null;
    // The element the pointer is actually over, kept beside the widened one for
    // the reason the chapter editor keeps both: widening again has to start from
    // where the pointer is, or one keypress would climb two levels.
    let hoverAnchor = null;
    let widenLevel = 0;

    let style = frameDocument.createElement('style');
    style.id = 'sae-pick-style';
    style.textContent = STYLE_PICKER_STYLESHEET;
    (frameDocument.head || frameDocument.body).appendChild(style);

    function notifyHover() {
        if (typeof options.onHover === 'function') {
            options.onHover(hoverLabel());
        }
    }

    function clearHover() {
        if (!hovered) {
            return;
        }
        hovered.classList.remove(STYLE_PICKER_HOVER_CLASS);
        // classList leaves class="" behind on an element that had none of its
        // own, and an empty class attribute is one more thing for ownSelector()
        // to have an opinion about
        if (hovered.getAttribute('class') === '') {
            hovered.removeAttribute('class');
        }
        hovered = null;
    }

    function setHover(element) {
        if (element === hovered) {
            return;
        }
        clearHover();
        hovered = element;
        if (hovered) {
            hovered.classList.add(STYLE_PICKER_HOVER_CLASS);
        }
        notifyHover();
    }

    // The element a click would name: the one under the pointer, widened by
    // however many levels have been asked for, and never <body> itself - a style
    // hiding the body hides the chapter.
    function pickTargetFor(node) {
        let element = node;
        while (element && element.nodeType !== 1) {
            element = element.parentNode;
        }
        let stop = frameDocument.body;
        if (!element || element === stop || !stop || !stop.contains(element)) {
            return null;
        }
        for (let i = 0; i < widenLevel; i++) {
            if (!element.parentNode || element.parentNode === stop) {
                break;
            }
            element = element.parentNode;
        }
        return element;
    }

    // What the toolbar says, so that a click is not a guess: the selector that
    // would be written, and how much of the page it covers.
    function hoverLabel() {
        if (!hovered) {
            return null;
        }
        let selector = selectorForElement(hovered, frameDocument);
        return {
            selector: selector,
            matches: selectorMatchCount(frameDocument, selector)
        };
    }

    function onMouseMove(event) {
        if (!active) {
            return;
        }
        hoverAnchor = event.target;
        setHover(pickTargetFor(hoverAnchor));
    }

    function onMouseLeave() {
        if (!active) {
            return;
        }
        hoverAnchor = null;
        clearHover();
        notifyHover();
    }

    function onClick(event) {
        if (!active) {
            return;
        }
        // A captured page is full of links, and a click on one here means the
        // element and not the destination. The sandbox blocks the navigation in
        // any case, but a click that visibly does nothing is worse than one that
        // is stopped.
        event.preventDefault();
        event.stopPropagation();

        let label = hoverLabel();
        if (!label || label.selector === '') {
            return;
        }
        // The highlight comes off first: what is picked is the element, not the
        // element while it is being pointed at, and the class is in the document
        // selectorMatchCount() is about to count against.
        let target = hovered;
        clearHover();
        let selector = selectorForElement(target, frameDocument);
        if (typeof options.onPick === 'function') {
            options.onPick(selector, selectorMatchCount(frameDocument, selector));
        }
        // Widening is about one pick. Keeping the level would make the next
        // click, aimed at a paragraph, take the block around it instead.
        widenLevel = 0;
        setHover(pickTargetFor(hoverAnchor));
    }

    function onKeyDown(event) {
        // Keyboard events raised inside the frame never reach the page around it,
        // so every shortcut this has has to be answered here.
        if (event.key === 'Escape') {
            if (typeof options.onEscape === 'function') {
                event.preventDefault();
                options.onEscape();
            }
            return;
        }
        if (!active || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
            return;
        }
        event.preventDefault();
        if (event.key === 'ArrowUp') {
            widen();
        } else {
            narrow();
        }
    }

    // Both directions recompute from the element under the pointer rather than
    // from the highlight, which is a result and not a position.
    function widen() {
        if (!hoverAnchor || widenLevel >= STYLE_PICKER_MAX_WIDEN) {
            return;
        }
        let before = hovered;
        widenLevel++;
        setHover(pickTargetFor(hoverAnchor));
        // already at the outermost thing that can be picked
        if (hovered === before) {
            widenLevel--;
        }
    }

    function narrow() {
        if (widenLevel === 0) {
            return;
        }
        widenLevel--;
        setHover(pickTargetFor(hoverAnchor));
    }

    frameDocument.addEventListener('mousemove', onMouseMove, true);
    frameDocument.addEventListener('mouseleave', onMouseLeave, true);
    frameDocument.addEventListener('click', onClick, true);
    frameDocument.addEventListener('keydown', onKeyDown, true);

    return {
        isActive: function() {
            return active;
        },
        setActive: function(value) {
            active = !!value;
            widenLevel = 0;
            if (!active) {
                hoverAnchor = null;
                clearHover();
            }
            if (frameDocument.body) {
                frameDocument.body.classList.toggle('sae-picking', active);
            }
            notifyHover();
        },
        widen: widen,
        narrow: narrow,
        hoverLabel: hoverLabel,
        destroy: function() {
            clearHover();
            frameDocument.removeEventListener('mousemove', onMouseMove, true);
            frameDocument.removeEventListener('mouseleave', onMouseLeave, true);
            frameDocument.removeEventListener('click', onClick, true);
            frameDocument.removeEventListener('keydown', onKeyDown, true);
            if (style.parentNode) {
                style.parentNode.removeChild(style);
            }
        }
    };
}
