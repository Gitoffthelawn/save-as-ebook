// Runs on chapters.html. It used to be injected into the open web page, where it
// had to disable that page's stylesheets to stop them bleeding into the editor
// and remove an already-injected copy of itself - neither applies on a page of
// our own, and disabling the stylesheets here would strip the editor's own css.
showEditor();

var allPagesRef = null;

function showEditor() {

    var body = document.getElementsByTagName('body')[0];
    var modalContent = document.createElement('div');
    modalContent.id = 'chapterEditor-modalContent';
    var modalHeader = document.createElement('div');
    modalHeader.id = 'chapterEditor-modalHeader';
    var modalList = document.createElement('div');
    modalList.id = 'chapterEditor-modalList';
    var modalFooter = document.createElement('div');
    modalFooter.id = 'chapterEditor-modalFooter';

    ////////
    // Header
    var title = document.createElement('span');
    title.id = "chapterEditor-Title";
    title.innerText = chrome.i18n.getMessage('chapterEditorTitle');
    var upperCloseButton = document.createElement('button');
    modalHeader.appendChild(title);
    upperCloseButton.onclick = closeModal;
    upperCloseButton.innerText = 'X';
    upperCloseButton.className = 'chapterEditor-text-button chapterEditor-float-right';
    modalHeader.appendChild(upperCloseButton);
    /////////////////////
    // Content List

    var titleHolder = document.createElement('div');
    titleHolder.id = 'chapterEditor-ebookTitleHolder';

    var ebookTilteLabel = document.createElement('span');
    ebookTilteLabel.id = 'chapterEditor-ebookTitleLabel';
    ebookTilteLabel.innerText = chrome.i18n.getMessage('ebookTitleLabel');
    titleHolder.appendChild(ebookTilteLabel);

    var ebookTilte = document.createElement('input');
    ebookTilte.id = 'chapterEditor-ebookTitle';
    ebookTilte.type = 'text';
    getEbookTitle(function (title) {
        ebookTilte.value = title;
    });
    titleHolder.appendChild(ebookTilte);
    modalList.appendChild(titleHolder);

    /////////////////////
    // The book-wide stylesheet, written into ebook.css, which every chapter and
    // the table of contents link.
    //
    // This is not the "Custom Styles" editor in the popup, and the labels say so:
    // that one holds a stylesheet per site and is applied to a page while it is
    // being captured, to hide the parts of it that should not be in a book at
    // all. This one is applied to the book that comes out. A user who has met
    // the first has every reason to assume this is more of it.
    //
    // Folded away by default. Most books never have one, and an empty textarea
    // between the title and the chapters would push the list - the thing this
    // page is for - off the first screen.
    var bookCssHolder = document.createElement('div');
    bookCssHolder.id = 'chapterEditor-bookCssHolder';

    var bookCssToggle = document.createElement('button');
    bookCssToggle.id = 'chapterEditor-bookCssToggle';
    bookCssToggle.className = 'chapterEditor-text-button';
    bookCssToggle.onclick = function() {
        setBookCssOpen(bookCssArea.style.display === 'none');
    };

    var bookCssHint = document.createElement('span');
    bookCssHint.id = 'chapterEditor-bookCssHint';
    bookCssHint.innerText = chrome.i18n.getMessage('bookCssHint');

    var bookCssArea = document.createElement('textarea');
    bookCssArea.id = 'chapterEditor-bookCss';
    bookCssArea.spellcheck = false;
    bookCssArea.placeholder = chrome.i18n.getMessage('bookCssPlaceholder');
    getBookCss(function (css) {
        bookCssArea.value = css;
    });
    // The preview reads this box rather than storage, so a rule takes effect as
    // it is typed and without being saved first - which is the only way to write
    // css against content you can see.
    bookCssArea.oninput = function() {
        applyBookCssToPreview();
    };

    function setBookCssOpen(open) {
        bookCssArea.style.display = open ? 'block' : 'none';
        bookCssToggle.innerText = (open ? '▾ ' : '▸ ') +
                                  chrome.i18n.getMessage('bookCssLabel');
    }
    setBookCssOpen(false);

    bookCssHolder.appendChild(bookCssToggle);
    bookCssHolder.appendChild(bookCssHint);
    bookCssHolder.appendChild(bookCssArea);
    modalList.appendChild(bookCssHolder);

    function createChapterList(allPages) {
        allPagesRef = allPages;

        var list = document.createElement('ul');
        list.className = 'chapterEditor-chapters-list';

        for (var i = 0; i < allPagesRef.length; i++) {
            if (!allPagesRef[i]) {
                continue;
            }
            allPagesRef[i].removed = false;

            var listItem = document.createElement('li');
            listItem.id = 'li' + i;
            listItem.className = 'chapterEditor-chapter-item';

            var dragHandler = document.createElement('span');
            dragHandler.className = 'chapterEditor-drag-handler';
            dragHandler.innerText = '\u21f5';

            var label = document.createElement('input');
            label.type = 'text';
            label.id = 'text' + i;
            label.value = allPagesRef[i].title;

            var buttons = document.createElement('span');

            var previewButton = document.createElement('button');
            previewButton.innerText = chrome.i18n.getMessage('preview');
            previewButton.className = 'chapterEditor-text-button';
            previewButton.onclick = previewListItem(i);

            var removeButton = document.createElement('button');
            removeButton.innerText = chrome.i18n.getMessage('remove');
            removeButton.className = 'chapterEditor-text-button chapterEditor-text-red';
            removeButton.onclick = removeListItem(i);

            buttons.appendChild(previewButton);
            buttons.appendChild(removeButton);

            listItem.appendChild(dragHandler);
            listItem.appendChild(label);
            listItem.appendChild(buttons);
            list.appendChild(listItem);
        }
        modalList.appendChild(list);
        makeListSortable(list, '.chapterEditor-drag-handler');
    }

    ////////
    // Footer
    var buttons = document.createElement('div');
    var closeButton = document.createElement('button');
    closeButton.innerText = chrome.i18n.getMessage('cancel');
    closeButton.className = 'chapterEditor-footer-button chapterEditor-float-left chapterEditor-cancel-button';
    closeButton.onclick = closeModal;
    buttons.appendChild(closeButton);

    var removeButton = document.createElement('button');
    removeButton.innerText = chrome.i18n.getMessage('removeChapters');
    removeButton.className = 'chapterEditor-footer-button hapterEditor-float-left';
    removeButton.onclick = function() {
        var result = confirm(chrome.i18n.getMessage('removeChaptersConfirm'));
        if (result) {
            removeEbook();
            closeModal();
        }
    };
    buttons.appendChild(removeButton);

    var saveButton = document.createElement('button');
    saveButton.onclick = function() {
        prepareEbook(saveChanges());
    };
    saveButton.innerText = chrome.i18n.getMessage('generateEbook');
    saveButton.className = 'chapterEditor-footer-button chapterEditor-float-right chapterEditor-generate-button';
    buttons.appendChild(saveButton);

    var saveChangesButton = document.createElement('button');
    saveChangesButton.onclick = function() {
        saveChanges();
    };
    saveChangesButton.innerText = chrome.i18n.getMessage('saveChanges');
    saveChangesButton.className = 'chapterEditor-footer-button chapterEditor-float-right';
    buttons.appendChild(saveChangesButton);

    modalFooter.appendChild(buttons);

    /////////////////////
    // Chapter preview and editor
    //
    // Built when it is asked for and thrown away when it closes. A chapter
    // carries its images as base64 and the preview turns them into data urls, so
    // a book of image-heavy chapters would otherwise end up holding every one of
    // them decoded at once.
    //
    // The frame is where the chapter is edited as well as shown - the rendering
    // is the editing surface, so what is removed is what was seen to be removed.
    // Everything that changes the content lives in chapterContentEditor.js; what
    // is here is the toolbar that drives it and the path from an edit to storage.

    var previewPanel = document.createElement('div');
    previewPanel.id = 'chapterEditor-previewPanel';
    previewPanel.style.display = 'none';

    var previewContent = document.createElement('div');
    previewContent.id = 'chapterEditor-previewContent';

    var previewHeader = document.createElement('div');
    previewHeader.id = 'chapterEditor-previewHeader';

    var previewTitle = document.createElement('span');
    previewTitle.id = 'chapterEditor-previewTitle';

    var previewCloseButton = document.createElement('button');
    previewCloseButton.innerText = 'X';
    previewCloseButton.className = 'chapterEditor-text-button chapterEditor-float-right';
    previewCloseButton.onclick = closePreview;

    previewHeader.appendChild(previewTitle);
    previewHeader.appendChild(previewCloseButton);

    // The one thing an iframe cannot show: pagination, fonts and margins belong
    // to the reading system and differ between devices.
    var previewNote = document.createElement('div');
    previewNote.id = 'chapterEditor-previewNote';
    previewNote.innerText = chrome.i18n.getMessage('previewNote');

    var previewBody = document.createElement('div');
    previewBody.id = 'chapterEditor-previewBody';

    // The chapter being previewed: which record it is, the chapter as the build
    // normalized it, the frame showing it, and the editing session over that
    // frame. All empty while the panel is closed - and editSession alone can be
    // null with a chapter rendered, because a preview that cannot be edited is
    // still worth reading.
    var previewIndex = -1;
    var previewChapter = null;
    var previewFrame = null;
    var editSession = null;
    // What this chapter's own css was when the panel opened, so that "has it
    // changed" is answered by comparison rather than by a flag that has to be
    // cleared in the right places.
    var chapterCssOriginal = '';

    function toolbarButton(id, messageKey, onClick) {
        var button = document.createElement('button');
        button.id = id;
        button.className = 'chapterEditor-text-button chapterEditor-toolbar-button';
        button.innerText = chrome.i18n.getMessage(messageKey);
        button.onclick = onClick;
        return button;
    }

    var previewToolbar = document.createElement('div');
    previewToolbar.id = 'chapterEditor-previewToolbar';

    // The modes are exclusive and the toolbar is the only way into them: an
    // editor where clicking sometimes follows a link and sometimes deletes a
    // paragraph, depending on nothing visible, is one that deletes paragraphs by
    // accident.
    var modeButtons = {
        view: toolbarButton('chapterEditor-modeView', 'editModeView', setMode('view')),
        remove: toolbarButton('chapterEditor-modeRemove', 'editModeRemove', setMode('remove')),
        text: toolbarButton('chapterEditor-modeText', 'editModeText', setMode('text'))
    };

    var widenButton = toolbarButton('chapterEditor-widen', 'selectParent', function() {
        if (editSession) {
            editSession.widen();
        }
    });
    var narrowButton = toolbarButton('chapterEditor-narrow', 'selectChild', function() {
        if (editSession) {
            editSession.narrow();
        }
    });
    var insertBeforeButton = toolbarButton('chapterEditor-insertBefore', 'insertParagraphBefore',
        function() {
            if (editSession) {
                editSession.insertParagraph('before');
            }
        });
    var insertAfterButton = toolbarButton('chapterEditor-insertAfter', 'insertParagraphAfter',
        function() {
            if (editSession) {
                editSession.insertParagraph('after');
            }
        });
    var undoButton = toolbarButton('chapterEditor-undo', 'undoEdit', function() {
        if (editSession) {
            editSession.undo();
        }
    });
    var chapterCssButton = toolbarButton('chapterEditor-chapterCssToggle', 'chapterCssLabel',
        function() {
            setChapterCssOpen(chapterCssHolder.style.display === 'none');
        });
    var saveChapterButton = toolbarButton('chapterEditor-saveChapter', 'saveChapter',
                                          saveChapterEdits);
    saveChapterButton.classList.add('chapterEditor-toolbar-save');

    var previewGroups = {};
    function toolbarGroup(id, buttons) {
        var group = document.createElement('span');
        group.id = id;
        group.className = 'chapterEditor-toolbar-group';
        buttons.forEach(function(button) {
            group.appendChild(button);
        });
        previewToolbar.appendChild(group);
        previewGroups[id] = group;
        return group;
    }

    toolbarGroup('chapterEditor-modeGroup', [modeButtons.view, modeButtons.remove, modeButtons.text]);
    toolbarGroup('chapterEditor-removeGroup', [widenButton, narrowButton]);
    toolbarGroup('chapterEditor-textGroup', [insertBeforeButton, insertAfterButton]);
    toolbarGroup('chapterEditor-cssGroup', [chapterCssButton]);
    toolbarGroup('chapterEditor-editGroup', [undoButton, saveChapterButton]);

    // This chapter's own css, appended to the stylesheet extraction captured for
    // it. Where the book stylesheet says what the book looks like, this is for
    // the one chapter whose source page needs an exception - and it is where it
    // is because it can only be written while looking at that chapter.
    var chapterCssHolder = document.createElement('div');
    chapterCssHolder.id = 'chapterEditor-chapterCssHolder';

    var chapterCssHint = document.createElement('div');
    chapterCssHint.id = 'chapterEditor-chapterCssHint';
    chapterCssHint.innerText = chrome.i18n.getMessage('chapterCssHint');

    var chapterCssArea = document.createElement('textarea');
    chapterCssArea.id = 'chapterEditor-chapterCss';
    chapterCssArea.spellcheck = false;
    chapterCssArea.placeholder = chrome.i18n.getMessage('chapterCssPlaceholder');
    chapterCssArea.oninput = function() {
        applyChapterCssToPreview();
        updateToolbar();
    };

    chapterCssHolder.appendChild(chapterCssHint);
    chapterCssHolder.appendChild(chapterCssArea);

    function setChapterCssOpen(open) {
        chapterCssHolder.style.display = open ? 'block' : 'none';
        chapterCssButton.classList.toggle('chapterEditor-mode-active', open);
    }
    setChapterCssOpen(false);

    // What the current mode does, and - in remove mode - what a click would take
    // with it. Naming the element that is about to go is the difference between
    // removing a stray advertisement and removing the article around it.
    var previewHint = document.createElement('div');
    previewHint.id = 'chapterEditor-previewHint';

    previewContent.appendChild(previewHeader);
    previewContent.appendChild(previewToolbar);
    previewContent.appendChild(chapterCssHolder);
    previewContent.appendChild(previewNote);
    previewContent.appendChild(previewHint);
    previewContent.appendChild(previewBody);
    previewPanel.appendChild(previewContent);

    previewPanel.onclick = function(event) {
        if (event.target === previewPanel) {
            closePreview();
        }
    };

    /////////////////////

    var modal = document.createElement('div');
    modal.id = 'chapterEditor-Modal';

    modalContent.appendChild(modalHeader);
    modalContent.appendChild(modalList);
    modalContent.appendChild(modalFooter);
    modal.appendChild(modalContent);

    body.appendChild(modal);
    // after the modal, and above it - the preview covers the list it was opened
    // from rather than sitting inside it
    body.appendChild(previewPanel);
    // the toolbar of a panel holding no chapter: every editing control hidden
    updateToolbar();

    modal.style.display = "none";
    modal.style.position = 'fixed';
    modal.style.zIndex = '1';
    modal.style.left = '0';
    modal.style.top = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.overflow = 'auto';
    modal.style.backgroundColor = 'rgba(210, 210, 210, 1)';

    modalContent.style.zIndex = '2';
    modalContent.style.backgroundColor = '#fff';
    modalContent.style.margin = '5% auto';
    modalContent.style.padding = '0';
    modalContent.style.width = '70%';

    window.onclick = function(event) {
        if (event.target == modal) {
            closeModal();
        }
    };

    modal.style.display = "block";

    document.onkeydown = function(evt) {
        evt = evt || window.event;
        if (evt.keyCode == 27) {
            // the preview sits on top of the editor, so escape leaves that
            // first - otherwise it would close the whole tab from behind it
            if (isPreviewOpen()) {
                closePreview();
                return;
            }
            closeModal();
        }
    };

    function closeModal() {
        // the editor is the whole tab now, so closing it closes the tab
        window.close();
    }

    function removeListItem(atIndex) {
        return function() {
            allPagesRef[atIndex].removed = true;
            var tmpListElem = document.getElementById('li' + atIndex);
            tmpListElem.style.display = 'none';
        };
    }

    function previewListItem(atIndex) {
        return function() {
            var page = allPagesRef[atIndex];
            // The title as the row shows it now, not as storage still has it: it
            // becomes the chapter's heading when the page has none of its own, so
            // a rename that has not been saved yet has to be visible here.
            var titleInput = document.getElementById('text' + atIndex);
            var title = titleInput && titleInput.value.trim() !== '' ?
                        titleInput.value : page.title;
            openPreview(atIndex, Object.assign({}, page, {title: title}));
        };
    }

    function isPreviewOpen() {
        return previewPanel.style.display !== 'none';
    }

    function openPreview(atIndex, page) {
        // From the box, not from storage: an unsaved rule has to be visible here
        // for the same reason an unsaved rename is.
        var preview = buildChapterPreview(page, {bookCss: bookCssArea.value});

        // whatever the last preview decoded goes now, before the next one is
        // built rather than when the panel is next closed
        clearPreview();
        previewIndex = atIndex;
        previewChapter = preview.chapter;
        previewTitle.innerText = page.title;
        chapterCssOriginal = typeof page.customCss === 'string' ? page.customCss : '';
        chapterCssArea.value = chapterCssOriginal;
        // opened for a chapter that already has one, so it is not a box the user
        // has to remember they filled in
        setChapterCssOpen(chapterCssOriginal.trim() !== '');

        if (preview.html === '') {
            // a record the build would skip as well
            var empty = document.createElement('p');
            empty.id = 'chapterEditor-previewEmpty';
            empty.innerText = chrome.i18n.getMessage('previewEmpty');
            previewBody.appendChild(empty);
        } else {
            var frame = document.createElement('iframe');
            frame.id = 'chapterEditor-previewFrame';
            // No allow-scripts, which is the flag that matters: chapter content
            // is script-free by construction - the sanitizer keeps no script, no
            // event handler and no javascript: url - and the sandbox is what
            // still holds the day one of those stops being true. allow-same-
            // origin is not a hole in that: it grants the frame's content
            // nothing, there being no content that can run, and it is what lets
            // this page reach into the document to edit it.
            frame.setAttribute('sandbox', 'allow-same-origin');
            frame.onload = function() {
                startEditSession(frame, preview);
            };
            frame.srcdoc = preview.html;
            previewBody.appendChild(frame);
            previewFrame = frame;
        }
        updateToolbar();
        previewPanel.style.display = 'block';
    }

    // The two boxes reach the open frame by replacing the <style> the preview
    // document was built with, rather than by rebuilding that document: a rebuilt
    // srcdoc reloads the frame, and reloading it would throw away the edit
    // session and every change in it that has not been saved.
    function previewDocument() {
        try {
            return previewFrame ? previewFrame.contentDocument : null;
        } catch (e) {
            return null;
        }
    }

    function applyBookCssToPreview() {
        setPreviewStyle(previewDocument(), PREVIEW_BOOK_CSS_ID, bookCssArea.value);
    }

    // The chapter's <style> holds the whole stylesheet the build will write for
    // it - what extraction captured and what the user is typing - so it is
    // assembled the same way here.
    function applyChapterCssToPreview() {
        if (!previewChapter) {
            return;
        }
        setPreviewStyle(previewDocument(), PREVIEW_CHAPTER_CSS_ID, chapterStyleContent({
            styleFileContent: previewChapter.styleFileContent,
            customCss: chapterCssArea.value
        }));
    }

    function isChapterCssDirty() {
        return previewChapter !== null && chapterCssArea.value !== chapterCssOriginal;
    }

    function startEditSession(frame, preview) {
        try {
            editSession = createChapterEditSession(frame.contentDocument, preview.chapter, {
                hasTitleHeading: preview.hasTitleHeading,
                paragraphText: chrome.i18n.getMessage('insertedParagraphText'),
                onChange: updateToolbar,
                // escape inside the frame never reaches the page's own handler
                onEscape: closePreview
            });
        } catch (e) {
            // Editing is the part that can fail here - the preview itself is
            // already rendered and is worth keeping without it.
            console.log('Error:', e);
            editSession = null;
        }
        updateToolbar();
    }

    function clearPreview() {
        if (editSession) {
            editSession.destroy();
            editSession = null;
        }
        previewIndex = -1;
        previewChapter = null;
        previewFrame = null;
        chapterCssOriginal = '';
        chapterCssArea.value = '';
        while (previewBody.firstChild) {
            previewBody.removeChild(previewBody.firstChild);
        }
    }

    function closePreview() {
        // Edits live in the frame - and the chapter's css in its box - until they
        // are saved, and both go when the panel closes. Nothing else in this page
        // warns before discarding work, because nothing else in it holds any.
        if (((editSession && editSession.isDirty()) || isChapterCssDirty()) &&
            !confirm(chrome.i18n.getMessage('discardEditsConfirm'))) {
            return;
        }
        previewPanel.style.display = 'none';
        clearPreview();
        updateToolbar();
    }

    // The edited chapter, through the sanitizer and into storage. The record the
    // page is holding is updated first: it is what a build reads, and what the
    // preview would be rebuilt from.
    //
    // The content and this chapter's css are saved together, by this one button,
    // because they are the two things the panel holds and a user who has changed
    // both would otherwise have to find two ways to keep them. The css does not
    // need the edit session - it is a field on the record, not a serialization of
    // a DOM - so a chapter that failed to become editable can still be styled.
    function saveChapterEdits() {
        if (previewIndex < 0 || !allPagesRef[previewIndex]) {
            return;
        }
        try {
            if (editSession) {
                var edited = editSession.serialize();
                allPagesRef[previewIndex].content = edited.content;
                allPagesRef[previewIndex].images = edited.images;
            }
            allPagesRef[previewIndex].customCss = chapterCssArea.value;
            chapterCssOriginal = chapterCssArea.value;
            saveChanges();
            if (editSession) {
                editSession.markSaved();
            }
            // last, because updateToolbar() writes the mode's own hint over it
            updateToolbar();
            setHint(chrome.i18n.getMessage('chapterSaved'));
        } catch (e) {
            console.log('Error:', e);
        }
    }

    function setHint(text) {
        previewHint.innerText = text;
    }

    // The toolbar says what mode the frame is in, what is available in it, and
    // what a click in remove mode would take. Rebuilt from the session rather
    // than tracked alongside it, so the two cannot disagree.
    function updateToolbar() {
        var mode = editSession ? editSession.getMode() : 'view';
        var editable = editSession !== null;
        // Styling a chapter needs the chapter, not the edit session: it writes a
        // field on the record rather than serializing the frame's DOM.
        var hasChapter = previewChapter !== null;

        Object.keys(modeButtons).forEach(function(name) {
            modeButtons[name].classList.toggle('chapterEditor-mode-active',
                                               editable && name === mode);
            modeButtons[name].disabled = !editable;
        });

        // Only the controls the current mode can act on, rather than the whole
        // toolbar greyed differently in each mode
        previewGroups['chapterEditor-removeGroup'].style.display =
            mode === 'remove' ? 'inline' : 'none';
        previewGroups['chapterEditor-textGroup'].style.display =
            mode === 'text' ? 'inline' : 'none';
        previewGroups['chapterEditor-cssGroup'].style.display =
            hasChapter ? 'inline' : 'none';
        previewGroups['chapterEditor-editGroup'].style.display =
            hasChapter ? 'inline' : 'none';
        if (!hasChapter) {
            setChapterCssOpen(false);
        }

        narrowButton.disabled = !editSession || editSession.getWidenLevel() === 0;
        undoButton.disabled = !editSession || !editSession.canUndo();
        undoButton.style.display = editable ? 'inline' : 'none';
        saveChapterButton.disabled =
            !((editSession && editSession.isDirty()) || isChapterCssDirty());

        if (!editable) {
            setHint('');
            return;
        }
        if (mode === 'remove') {
            var label = editSession.hoverLabel();
            setHint(label === '' ? chrome.i18n.getMessage('removeModeHint') :
                    chrome.i18n.getMessage('removeModeTarget') + ' <' + label + '>');
            return;
        }
        setHint(chrome.i18n.getMessage(mode === 'text' ? 'textModeHint' : 'viewModeHint'));
    }

    function setMode(name) {
        return function() {
            if (editSession) {
                editSession.setMode(name);
            }
        };
    }

    // Builds from the chapters this page is holding, not from storage.
    // saveChanges() has only just started writing them, and the write is
    // asynchronous: reading them back here used to be a race with it, and every
    // edit that raises the write frequency makes it more likely to be lost.
    // The identifier is a separate read because nothing on this page writes it.
    function prepareEbook(changes) {
        try {
            if (!changes || changes.chapters.length === 0) {
                alert(chrome.i18n.getMessage('emptyBookWarning'));
                return;
            }
            getEbookUuid(function (uuid) {
                buildEbook(changes.chapters,
                           {title: changes.title, uuid: uuid, css: changes.bookCss});
            });
        } catch (e) {
            console.log('Error:', e);
        }
    }

    // Persists what the page currently shows, and hands it back so that a build
    // can use it without waiting for storage.
    function saveChanges() {
        var newChapters = [];
        var newEbookTitle = ebookTilte.value;
        if (newEbookTitle.trim() === '') {
            newEbookTitle = 'eBook';
        }

        try {
            var tmpChaptersList = document.getElementsByClassName('chapterEditor-chapter-item');
            if (!tmpChaptersList || !allPagesRef) {
                return;
            }

            for (var i = 0; i < tmpChaptersList.length; i++) {
                var tmpChapterItem = tmpChaptersList[i];
                var listIndex = Number(tmpChapterItem.id.replace('li', ''));
                if (allPagesRef[listIndex].removed === false) {
                    var newChapterTitle = tmpChapterItem.children.namedItem('text'+listIndex).value;
                    allPagesRef[listIndex].title = newChapterTitle;
                    newChapters.push(allPagesRef[listIndex]);
                }
            }

            saveEbookTitle(newEbookTitle);
            saveBookCss(bookCssArea.value);
            saveEbookPages(newChapters);
            return {chapters: newChapters, title: newEbookTitle, bookCss: bookCssArea.value};
        } catch (e) {
            console.log('Error:', e);
        }
    }

    /////////////////////

    getEbookPages(createChapterList);
}

// Drag & drop reordering of the chapter list, replacing jquery-sortable.
// saveChanges() reads the chapters back in DOM order, so moving the <li> around
// is all the reordering that is needed.
function makeListSortable(list, handleSelector) {
    var draggedItem = null;

    // Items are only draggable while the pointer is held down on the handle -
    // otherwise the whole row would be draggable and selecting text in the
    // chapter title input would start a drag instead
    list.addEventListener('mousedown', function(event) {
        var handle = event.target.closest(handleSelector);
        if (!handle || !list.contains(handle)) {
            return;
        }
        var item = handle.closest('li');
        if (item && item.parentNode === list) {
            item.draggable = true;
        }
    });

    function clearDraggable() {
        for (var i = 0; i < list.children.length; i++) {
            list.children[i].draggable = false;
        }
    }

    document.addEventListener('mouseup', clearDraggable);

    list.addEventListener('dragstart', function(event) {
        var item = event.target.closest('li');
        if (!item || !item.draggable) {
            event.preventDefault();
            return;
        }
        draggedItem = item;
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag unless some data is set
        event.dataTransfer.setData('text/plain', item.id);
        // applied late so the drag image is the untouched row
        setTimeout(function() {
            item.classList.add('chapterEditor-dragging');
        }, 0);
    });

    list.addEventListener('dragover', function(event) {
        if (!draggedItem) {
            return;
        }
        // preventDefault marks this a valid drop target
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        var target = event.target.closest('li');
        if (!target || target === draggedItem || target.parentNode !== list) {
            return;
        }
        // past the middle of the row means the item goes after it
        var box = target.getBoundingClientRect();
        var insertAfter = (event.clientY - box.top) > (box.height / 2);
        list.insertBefore(draggedItem, insertAfter ? target.nextSibling : target);
    });

    list.addEventListener('drop', function(event) {
        if (draggedItem) {
            event.preventDefault();
        }
    });

    list.addEventListener('dragend', function() {
        if (draggedItem) {
            draggedItem.classList.remove('chapterEditor-dragging');
        }
        draggedItem = null;
        clearDraggable();
    });
}
