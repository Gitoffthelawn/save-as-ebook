// Editing a chapter inside the frame that previews it.
//
// The preview frame already holds the chapter as a live DOM, rendered by the
// same functions that write the book. Editing it is therefore editing that DOM
// directly - there is no second copy of the content to keep in step - and the
// only question is how what comes back out becomes a chapter again.
//
// The answer, and the rule the whole file exists to keep: nothing this produces
// reaches storage without going through sanitizeChapterContent() first. An
// innerHTML string off a contentEditable DOM satisfies none of the invariants
// the build stage relies on - unclosed void tags, unquoted attributes, whatever
// the browser's editing commands felt like inserting - and the sanitizer is the
// single place that turns any string into one that does.
//
// Two things make that round trip work:
//
//   The content being edited is wrapped in a container of this module's own.
//   Everything inside it is the chapter; everything outside it - the <section>
//   the build writes, and the <h1> it adds when the page has no heading naming
//   itself - is the build's, not the user's. Serializing is then reading one
//   element's innerHTML rather than reasoning about which children were the
//   page's own, and the generated heading cannot be edited into something the
//   build would only add again underneath it.
//
//   The image rewrites the preview makes are undone before anything is read
//   back. The frame holds data urls; a chapter holds references into the
//   archive.
//
// What saving an edit does bake into the stored chapter, because the frame was
// rendered by the build stage and not only by the preview: the ids minted for
// headings that had none, and the internal links resolved against them. Both are
// stable - a minted id is unique within its chapter and buildChapterOutline()
// keeps an id it finds rather than minting over it - so a chapter that has been
// edited builds to the same thing as one that has not.
//
// Requires utils.js, sanitizeHtml.js, saveEbook.js and chapterPreview.js.

// A class on a content element, so it has to be off again before the content is
// read back - class is an attribute the sanitizer keeps, being the one the
// generated chapter stylesheet is written against.
var EDIT_HOVER_CLASS = 'sae-edit-hover';
// On the frame's <body>, which is never serialized
var EDIT_MODE_CLASS_PREFIX = 'sae-edit-mode-';
// In the frame's <head>, which is never serialized either
var EDIT_STYLE_ID = 'sae-edit-style';

var EDIT_MODES = ['view', 'remove', 'text'];

// A snapshot is the chapter as it would be stored - references into the archive,
// not the base64 the frame renders - so a deep stack costs the length of the
// markup rather than the size of the pictures. Storage is not touched until the
// user saves, so this stack is the only record of the steps in between.
var MAX_UNDO_STEPS = 30;
// A run of typing is one undo step. The snapshot is taken when the run starts;
// this is how long a pause has to be before the next keystroke starts a new one.
var TYPING_BURST_MS = 1200;
// A ceiling on widening, for the case where there is nothing under the pointer
// to tell how far up the content already goes
var MAX_WIDEN_LEVELS = 20;

// Injected into the frame, not into the chapter: it styles what the editor is
// doing to the chapter and leaves the chapter's own rendering alone. !important
// throughout because the chapter stylesheet is generated from a real page's
// computed styles and will have opinions about outlines and cursors.
var EDIT_STYLESHEET =
    '.' + EDIT_HOVER_CLASS + '{' +
        'outline:2px solid #d33 !important;' +
        'outline-offset:-2px !important;' +
        'background-color:rgba(221,51,51,0.12) !important;' +
    '}' +
    'body.' + EDIT_MODE_CLASS_PREFIX + 'remove *{cursor:crosshair !important;}' +
    'body.' + EDIT_MODE_CLASS_PREFIX + 'text [data-sae-edit-root]{' +
        'outline:1px dashed #7aa !important;' +
        'outline-offset:4px !important;' +
    '}';

// The <img src> forms sanitizeChapterContent() lets through, which is what the
// content has been through by the time this reads it. Anchored at the start for
// the same reason dropMissingImages() anchors: a remote url ending in
// "/images/photo.jpg" names a file this archive never contained.
var EDITED_IMAGE_SRC_REGEX = /<img\b[^>]*\ssrc="((?:\.{1,2}\/)*images\/[^"?#]+)"/gi;

// Which of the chapter's images the edited content still refers to. An <img>
// removed with its surrounding element leaves bytes behind that nothing points
// at, and a manifest item for a picture no chapter shows is a file the reader
// downloads and never draws - epubcheck reports it, and it is dead weight in
// every copy of the book.
//
// The pairing is by filename, the same key dropUntypedImages() and
// dropMissingImages() pair on, so a filename referenced anywhere in the chapter
// keeps its record and nothing else does.
function keepReferencedImages(content, images) {
    let referenced = Object.create(null);
    let match;
    EDITED_IMAGE_SRC_REGEX.lastIndex = 0;
    while ((match = EDITED_IMAGE_SRC_REGEX.exec(content)) !== null) {
        referenced[match[1].replace(/^(?:\.{1,2}\/)*images\//i, '')] = true;
    }
    return (images || []).filter(function(image) {
        return referenced[image.filename] === true;
    });
}

// Starts an editing session on a rendered preview frame.
//
// frameDocument  the loaded document inside the preview iframe
// chapter        the normalized chapter it was rendered from, as
//                buildChapterPreview() returns it. Its image list is what the
//                data urls in the frame are keyed on, and it is deliberately
//                never pruned here: an image removed from the content is still
//                needed to render the undo step that brings it back.
// options        hasTitleHeading  whether the frame's first <h1> is the page's
//                                 own (editable) or one the build added (not)
//                paragraphText    the text a newly inserted paragraph carries
//                onChange         called after anything the toolbar reflects
//                onEscape         escape pressed while the frame has focus,
//                                 which the page around it never sees
function createChapterEditSession(frameDocument, chapter, options) {
    options = options || {};

    let section = frameDocument.body ? frameDocument.body.firstElementChild : null;
    if (!section) {
        return null;
    }

    // The heading the build adds when the page has none naming itself. It is
    // regenerated from the chapter title on every build, so editing it here
    // would be editing something that is about to be overwritten - it stays
    // outside the editable container, and the title is edited in the chapter
    // list where it is actually stored.
    // Checked rather than assumed: if it is not there, everything in the section
    // is the page's own and all of it is editable, which is the safe way round -
    // the other would hold back the chapter's first element from being edited.
    let firstElement = section.firstElementChild;
    let titleHeading = (!options.hasTitleHeading && firstElement &&
                        firstElement.tagName === 'H1') ? firstElement : null;

    // Everything the user may change, and nothing else. Given a plain <div>
    // rather than the <section> itself so that the container of the edit and the
    // container the build writes are not the same element - one is ours to
    // replace wholesale on undo, the other is not.
    let editRoot = frameDocument.createElement('div');
    editRoot.setAttribute('data-sae-edit-root', '');
    let child = titleHeading ? titleHeading.nextSibling : section.firstChild;
    while (child) {
        let next = child.nextSibling;
        editRoot.appendChild(child);
        child = next;
    }
    section.appendChild(editRoot);

    let style = frameDocument.createElement('style');
    style.id = EDIT_STYLE_ID;
    style.textContent = EDIT_STYLESHEET;
    (frameDocument.head || frameDocument.body).appendChild(style);

    let mode = 'view';
    let dirty = false;
    let undoStack = [];
    // The element the pointer is actually over, and the one a click would
    // remove, which is that element widened by the level below. Both are kept:
    // widening again has to start from where the pointer is and not from what
    // the last widening arrived at, or one keypress would climb two levels.
    let hoverAnchor = null;
    let hovered = null;
    // How many steps up from the element under the pointer the removal target
    // is. The same idea selector.js uses on a live page: what a reader sees as
    // one thing - a figure, a callout, a nav block - is a wrapper several levels
    // above the element the pointer is actually over. Kept across mousemoves
    // rather than reset by them, so that widening is a decision about what kind
    // of thing is being removed and not something to redo for every pixel.
    let widenLevel = 0;
    let typingBurstTimer = null;

    function notifyChange() {
        if (typeof options.onChange === 'function') {
            options.onChange();
        }
    }

    // ---- what the frame holds, as a chapter would hold it --------------------

    function currentHtml() {
        clearHover();
        return restoreArchiveImageSrc(editRoot.innerHTML, chapter.images);
    }

    // The inverse. Parsed with DOMParser and adopted node by node rather than
    // assigned to innerHTML: the extension stores flag an innerHTML assignment
    // as an unsafe sink, and this one is fed by strings that came out of a
    // contentEditable DOM. What is adopted here has been through the same html
    // parser either way, and the sanitizer still has the last word at save time.
    //
    // Into a <template>, for the reason walkHtmlFragment() parses into one: it
    // puts the parser in "in template" mode, where a fragment that begins inside
    // a table - a <tr> or a <td>, which an edit inside one can leave at the
    // front of the content - is kept rather than dropped.
    function setCurrentHtml(html) {
        let parsed = new DOMParser().parseFromString(
            '<template>' + inlineArchiveImages(html, chapter.images) + '</template>',
            'text/html');
        let template = parsed.querySelector('template');
        while (editRoot.firstChild) {
            editRoot.removeChild(editRoot.firstChild);
        }
        let source = template ? template.content.firstChild : null;
        while (source) {
            editRoot.appendChild(frameDocument.importNode(source, true));
            source = source.nextSibling;
        }
        // whatever was highlighted was in the content that has just been replaced
        hovered = null;
        hoverAnchor = null;
    }

    // ---- undo ----------------------------------------------------------------

    function pushUndo() {
        undoStack.push(currentHtml());
        if (undoStack.length > MAX_UNDO_STEPS) {
            undoStack.shift();
        }
        endTypingBurst();
    }

    function undo() {
        if (undoStack.length === 0) {
            return false;
        }
        setCurrentHtml(undoStack.pop());
        endTypingBurst();
        // Deliberately not cleared when the stack empties: the content is back
        // where it started only if nothing was saved in between, and this flag
        // is what decides whether closing the panel asks before discarding.
        dirty = true;
        notifyChange();
        return true;
    }

    function endTypingBurst() {
        if (typingBurstTimer !== null) {
            clearTimeout(typingBurstTimer);
            typingBurstTimer = null;
        }
    }

    // A run of typing is one step, so that undo does not walk back a character
    // at a time. beforeinput rather than input: the snapshot has to be of the
    // text as it was before the run started.
    function noteTyping() {
        if (typingBurstTimer === null) {
            pushUndo();
        } else {
            clearTimeout(typingBurstTimer);
        }
        typingBurstTimer = setTimeout(function() {
            typingBurstTimer = null;
        }, TYPING_BURST_MS);
        if (!dirty) {
            dirty = true;
            notifyChange();
        }
    }

    // ---- hovering, and what a click would remove -----------------------------

    function clearHover() {
        if (!hovered) {
            return;
        }
        hovered.classList.remove(EDIT_HOVER_CLASS);
        // classList leaves class="" behind on an element that had no class of
        // its own, and the sanitizer keeps class attributes
        if (hovered.getAttribute('class') === '') {
            hovered.removeAttribute('class');
        }
        hovered = null;
    }

    // The element a click removes: the one under the pointer, widened by however
    // many levels have been asked for, and never past the outermost thing that
    // is the user's to remove - a direct child of the editable container.
    function removalTargetFor(node) {
        let element = node;
        while (element && element.nodeType !== 1) {
            element = element.parentNode;
        }
        if (!element || element === editRoot || !editRoot.contains(element)) {
            return null;
        }
        for (let i = 0; i < widenLevel; i++) {
            if (!element.parentNode || element.parentNode === editRoot) {
                break;
            }
            element = element.parentNode;
        }
        return element;
    }

    function setHover(element) {
        if (element === hovered) {
            return;
        }
        clearHover();
        hovered = element;
        if (hovered) {
            hovered.classList.add(EDIT_HOVER_CLASS);
        }
        notifyChange();
    }

    // What the toolbar shows so that a click is not a guess: the tag, and the
    // generated class if it has one, of the element that would go.
    function hoverLabel() {
        if (!hovered) {
            return '';
        }
        let label = hovered.tagName.toLowerCase();
        let className = hovered.getAttribute('class') || '';
        className = className.split(/\s+/).filter(function(name) {
            return name !== '' && name !== EDIT_HOVER_CLASS;
        })[0];
        return className ? label + '.' + className : label;
    }

    function removeHovered() {
        if (mode !== 'remove' || !hovered || !hovered.parentNode) {
            return false;
        }
        let target = hovered;
        // The class comes off before the snapshot, so what is stored is the
        // chapter and not the chapter mid-hover
        clearHover();
        pushUndo();
        target.parentNode.removeChild(target);
        // the element the pointer was over went with it
        hoverAnchor = null;
        // Widening is about one removal. Keeping the level would make the next
        // click, aimed at a sibling paragraph, take the block around it instead.
        widenLevel = 0;
        dirty = true;
        notifyChange();
        return true;
    }

    // ---- events inside the frame ---------------------------------------------

    function onMouseMove(event) {
        if (mode !== 'remove') {
            return;
        }
        hoverAnchor = event.target;
        setHover(removalTargetFor(hoverAnchor));
    }

    function onMouseLeave() {
        if (mode === 'remove') {
            hoverAnchor = null;
            clearHover();
            notifyChange();
        }
    }

    function onClick(event) {
        // A chapter is full of links, and a click on one in either editing mode
        // means the element, not the destination. Navigation is blocked by the
        // sandbox in any case, but a click that visibly does nothing is worse
        // than one that is stopped.
        if (mode === 'view') {
            return;
        }
        if (mode === 'remove') {
            event.preventDefault();
            event.stopPropagation();
            removeHovered();
            return;
        }
        if (event.target && event.target.closest && event.target.closest('a')) {
            event.preventDefault();
        }
    }

    function onBeforeInput() {
        if (mode === 'text') {
            noteTyping();
        }
    }

    // Pasting is the one way arbitrary markup - remote images, scripts, another
    // page's whole layout - gets into a contentEditable. The sanitizer would
    // strip all of it at save time, but not before the frame had fetched the
    // remote images, and not before the user had spent a while arranging content
    // that was never going to survive. Text is what the paste is for.
    function onPaste(event) {
        if (mode !== 'text' || !event.clipboardData) {
            return;
        }
        event.preventDefault();
        let text = event.clipboardData.getData('text/plain');
        if (text === '') {
            return;
        }
        noteTyping();
        frameDocument.execCommand('insertText', false, text);
    }

    // A drop is a paste by another route, and the same answer: text. What is
    // given up is dragging a paragraph from one place in the chapter to another,
    // which remove mode and typing both cover; what is avoided is a drop from
    // another window inserting its markup and its remote images, which the
    // sanitizer would only undo after the browser had already fetched them.
    function onDrop(event) {
        if (mode !== 'text' || !event.dataTransfer) {
            return;
        }
        event.preventDefault();
        let text = event.dataTransfer.getData('text/plain');
        if (text === '') {
            return;
        }
        noteTyping();
        frameDocument.execCommand('insertText', false, text);
    }

    function onKeyDown(event) {
        // Keyboard events raised inside the frame never reach the page around
        // it, so every shortcut the editor has has to be answered here as well.
        if (event.key === 'Escape') {
            if (typeof options.onEscape === 'function') {
                event.preventDefault();
                options.onEscape();
            }
            return;
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
            // The browser's own undo would walk the contentEditable's history,
            // which knows nothing about the elements removed around it. One
            // stack, so that one shortcut means one thing.
            event.preventDefault();
            undo();
            return;
        }
        if (mode === 'remove' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            if (event.key === 'ArrowUp') {
                widen();
            } else {
                narrow();
            }
        }
    }

    frameDocument.addEventListener('mousemove', onMouseMove, true);
    frameDocument.addEventListener('mouseleave', onMouseLeave, true);
    frameDocument.addEventListener('click', onClick, true);
    frameDocument.addEventListener('beforeinput', onBeforeInput, true);
    frameDocument.addEventListener('paste', onPaste, true);
    frameDocument.addEventListener('drop', onDrop, true);
    frameDocument.addEventListener('keydown', onKeyDown, true);

    // ---- widening ------------------------------------------------------------

    // Both directions recompute from the element under the pointer rather than
    // from the highlight, which is a result and not a position: walking up from
    // the widened element would climb twice as fast, and walking back down from
    // it is not defined at all, a parent having many children.
    function reHover() {
        if (hoverAnchor) {
            setHover(removalTargetFor(hoverAnchor));
        }
        notifyChange();
    }

    function widen() {
        if (mode !== 'remove') {
            return;
        }
        // Stops at the outermost element that is the user's to remove. Counting
        // past it would leave a level that does nothing and then has to be
        // pressed back down before narrowing has any visible effect.
        if (hovered && hovered.parentNode === editRoot) {
            return;
        }
        if (widenLevel >= MAX_WIDEN_LEVELS) {
            return;
        }
        widenLevel++;
        reHover();
    }

    function narrow() {
        if (mode !== 'remove' || widenLevel === 0) {
            return;
        }
        widenLevel--;
        reHover();
    }

    // ---- inserting text ------------------------------------------------------

    // The outermost element the caret is inside, so that an inserted paragraph
    // lands between two blocks rather than in the middle of one.
    function selectionBlock() {
        let selection = frameDocument.getSelection ? frameDocument.getSelection() : null;
        if (!selection || selection.rangeCount === 0) {
            return null;
        }
        let node = selection.getRangeAt(0).startContainer;
        while (node && node !== editRoot) {
            if (node.parentNode === editRoot) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    function insertParagraph(where) {
        if (mode !== 'text') {
            return null;
        }
        pushUndo();
        let paragraph = frameDocument.createElement('p');
        paragraph.textContent = options.paragraphText || '';
        let anchor = selectionBlock();
        if (anchor) {
            editRoot.insertBefore(paragraph, where === 'before' ? anchor : anchor.nextSibling);
        } else if (where === 'before') {
            // no caret to insert beside - the ends of the chapter are the two
            // places that need no selection to name
            editRoot.insertBefore(paragraph, editRoot.firstChild);
        } else {
            editRoot.appendChild(paragraph);
        }
        dirty = true;
        // Focus first, then the range: focusing an editable collapses whatever
        // selection is in it. The placeholder is left selected so that typing
        // replaces it.
        editRoot.focus();
        let range = frameDocument.createRange();
        range.selectNodeContents(paragraph);
        let selection = frameDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        paragraph.scrollIntoView({block: 'nearest'});
        notifyChange();
        return paragraph;
    }

    // ---- modes ---------------------------------------------------------------

    function setMode(nextMode) {
        if (EDIT_MODES.indexOf(nextMode) < 0 || nextMode === mode) {
            return;
        }
        clearHover();
        endTypingBurst();
        hoverAnchor = null;
        widenLevel = 0;
        mode = nextMode;

        EDIT_MODES.forEach(function(name) {
            frameDocument.body.classList.toggle(EDIT_MODE_CLASS_PREFIX + name, name === mode);
        });

        if (mode === 'text') {
            editRoot.setAttribute('contenteditable', 'true');
            // Enter inserts a paragraph rather than a div, and bold and italic
            // are written as tags rather than as style attributes - the
            // sanitizer keeps <b> and <i> and drops every style attribute, so
            // without these two the formatting a user applies simply disappears
            // at save time. Wrapped because these are legacy apis and a browser
            // is free to refuse them; the default behaviour is then merely worse
            // rather than broken.
            try {
                frameDocument.execCommand('defaultParagraphSeparator', false, 'p');
                frameDocument.execCommand('styleWithCSS', false, false);
            } catch (e) {
                console.log('Error:', e);
            }
            editRoot.focus();
        } else {
            editRoot.removeAttribute('contenteditable');
        }
        notifyChange();
    }

    // ---- what the chapter becomes --------------------------------------------

    // The one exit. Everything above changes a DOM; this is where that DOM
    // becomes a chapter again, and it is the sanitizer that makes it one.
    function serialize() {
        let content = sanitizeChapterContent(currentHtml());
        return {content: content, images: keepReferencedImages(content, chapter.images)};
    }

    function destroy() {
        endTypingBurst();
        frameDocument.removeEventListener('mousemove', onMouseMove, true);
        frameDocument.removeEventListener('mouseleave', onMouseLeave, true);
        frameDocument.removeEventListener('click', onClick, true);
        frameDocument.removeEventListener('beforeinput', onBeforeInput, true);
        frameDocument.removeEventListener('paste', onPaste, true);
        frameDocument.removeEventListener('drop', onDrop, true);
        frameDocument.removeEventListener('keydown', onKeyDown, true);
    }

    return {
        getMode: function() { return mode; },
        setMode: setMode,
        widen: widen,
        narrow: narrow,
        getWidenLevel: function() { return widenLevel; },
        hoverLabel: hoverLabel,
        insertParagraph: insertParagraph,
        undo: undo,
        canUndo: function() { return undoStack.length > 0; },
        isDirty: function() { return dirty; },
        markSaved: function() { dirty = false; notifyChange(); },
        serialize: serialize,
        destroy: destroy
    };
}
