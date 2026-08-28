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

    /////////////////////
    // Unsaved work
    //
    // The list holds work just as the preview panel does: the book title, the
    // book stylesheet, the metadata boxes, every rename, the order the rows were
    // dragged into and every row marked removed all live in this page until
    // something writes them. Escape, a click on the grey margin either side of
    // the modal, and the X used to take all of it with no question asked.
    //
    // "Has anything changed" is answered by comparing a serialization of that
    // state against the one taken when the page finished loading - the same way
    // the metadata fieldset answers it, and for the same reason: a dirty flag
    // has to be cleared in every place that saves, and one place missed is a
    // book lost or a question asked about nothing.
    var listStateOriginal = null;
    // Set for a departure the user has already agreed to - or one there is
    // nothing left to ask about - so that beforeunload does not ask a second
    // time on the way out.
    var leaving = false;

    // Read from the page rather than from storage, and without collectChapters()
    // - that one writes the boxes back onto the records it returns, which is not
    // something a question about whether anything changed should do. Each row
    // carries its index as well as its title, so that reordering shows up as a
    // change even in a book whose chapters are all called the same thing.
    function serializeListState() {
        var chapters = [];
        var rows = document.getElementsByClassName('chapterEditor-chapter-item');
        for (var i = 0; i < rows.length; i++) {
            var listIndex = Number(rows[i].id.replace('li', ''));
            var titleInput = rows[i].children.namedItem('text' + listIndex);
            chapters.push({
                index: listIndex,
                title: titleInput ? titleInput.value : '',
                removed: !!(allPagesRef && allPagesRef[listIndex] &&
                            allPagesRef[listIndex].removed)
            });
        }
        return JSON.stringify({
            title: ebookTilte.value,
            bookCss: bookCssArea.value,
            metadata: bookMetaFields.serialize(),
            chapters: chapters
        });
    }

    // What is on screen becomes the new baseline: once when the page has
    // finished loading, and again after every successful write.
    function resetDirtyBaseline() {
        listStateOriginal = serializeListState();
    }

    function isListDirty() {
        return listStateOriginal !== null && serializeListState() !== listStateOriginal;
    }

    // The preview panel's own unsaved work counts too. Escape and the panel's
    // backdrop reach closePreview(), which asks for itself, but the tab can
    // still be closed from the browser with the panel standing open.
    function isPreviewDirty() {
        return (editSession !== null && editSession.isDirty()) ||
               isChapterCssDirty() || isChapterMetaDirty();
    }

    function hasUnsavedWork() {
        return isListDirty() || isPreviewDirty();
    }

    // The four things this page loads are loaded independently and land in any
    // order, and the baseline is only meaningful once all of them are in: taken
    // any earlier it would record an empty box that is about to be filled, and
    // the filling would then read as an edit.
    var pendingLoads = 4;
    function noteLoaded() {
        pendingLoads--;
        if (pendingLoads === 0) {
            resetDirtyBaseline();
        }
    }

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
        noteLoaded();
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
        noteLoaded();
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

    /////////////////////
    // What the book says about itself: dc:creator, dc:language, dc:publisher,
    // dc:date, dc:description. The title is not here - it has had its own box at
    // the top of this page since long before there was a panel to move it into,
    // and moving it would hide the one field every book has.
    //
    // Folded away like the stylesheet above it, and for the same reason: a book
    // whose chapters carry usable metadata needs none of this, and five empty
    // boxes between the title and the chapter list would push the list off the
    // first screen.
    var bookMetaHolder = document.createElement('div');
    bookMetaHolder.id = 'chapterEditor-bookMetaHolder';

    var bookMetaToggle = document.createElement('button');
    bookMetaToggle.id = 'chapterEditor-bookMetaToggle';
    bookMetaToggle.className = 'chapterEditor-text-button';
    bookMetaToggle.onclick = function() {
        setBookMetaOpen(bookMetaFields.element.style.display === 'none');
    };

    var bookMetaHint = document.createElement('span');
    bookMetaHint.id = 'chapterEditor-bookMetaHint';
    bookMetaHint.innerText = chrome.i18n.getMessage('bookMetadataHint');

    var bookMetaFields = createMetadataFieldSet('chapterEditor-bookMeta', {
        emptyHint: chrome.i18n.getMessage('metadataFromChapters')
    });
    getBookMetadata(function (metadata) {
        bookMetaFields.fill(metadata);
        noteLoaded();
    });

    // What the boxes would produce if they were left alone, from the chapters as
    // this page is holding them - so a chapter removed or renamed but not yet
    // saved is already accounted for. Derived by the same functions the build
    // derives it with; a placeholder promising something the archive will not
    // say is worse than an empty box.
    function refreshBookMetaPlaceholders() {
        var derived = deriveBookMetadata(collectChapters());
        bookMetaFields.setPlaceholders({
            lang: derived.lang,
            authors: derived.authors,
            publisher: derived.publisher,
            description: derived.description,
            // A compilation is published on the day it is generated, which is
            // not a date that can be shown in advance - so the box says where it
            // will come from instead of what it will be.
            date: derived.date || chrome.i18n.getMessage('metadataDateGenerated')
        });
    }

    function setBookMetaOpen(open) {
        bookMetaFields.element.style.display = open ? 'block' : 'none';
        bookMetaToggle.innerText = (open ? '▾ ' : '▸ ') +
                                   chrome.i18n.getMessage('bookMetadataLabel');
        if (open) {
            // recomputed on every opening rather than kept up to date: the
            // chapter list is what they are derived from, and it changes while
            // this panel is shut
            refreshBookMetaPlaceholders();
        }
    }
    setBookMetaOpen(false);

    bookMetaHolder.appendChild(bookMetaToggle);
    bookMetaHolder.appendChild(bookMetaHint);
    bookMetaHolder.appendChild(bookMetaFields.element);
    modalList.appendChild(bookMetaHolder);

    function isBookMetaOpen() {
        return bookMetaFields.element.style.display !== 'none';
    }

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
            // straight out rather than through closeModal(): the question has
            // been asked, and asking again about unsaved changes to a book that
            // has just been thrown away is asking about nothing
            leavePage();
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
        // Saving is the end of a visit to this page, so it says what it did and
        // then leaves - otherwise the tab stays open looking exactly as it did
        // before, with nothing to say whether the click landed.
        //
        // The confirmation is also what makes closing safe: saveChanges() writes
        // by messaging the background, and alert() holds the tab open until it
        // is dismissed, which is long enough for those messages to be delivered.
        // Nothing is said and nothing is closed when there was nothing to save.
        if (!saveChanges()) {
            return;
        }
        alert(chrome.i18n.getMessage('changesSaved'));
        closeModal();
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
    // What this chapter's own css and stated metadata were when the panel
    // opened, so that "has it changed" is answered by comparison rather than by
    // a flag that has to be cleared in the right places.
    var chapterCssOriginal = '';
    var chapterMetaOriginal = '';

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
    var chapterMetaButton = toolbarButton('chapterEditor-chapterMetaToggle', 'chapterMetadataLabel',
        function() {
            setChapterMetaOpen(chapterMetaHolder.style.display === 'none');
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
    toolbarGroup('chapterEditor-cssGroup', [chapterCssButton, chapterMetaButton]);
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

    // What this chapter says about itself, as against what the book says. A
    // chapter's language is the one field here a reading system acts on per
    // chapter - it is written onto the chapter's own <html> element and is what
    // hyphenates and speaks it - and the rest is what this chapter contributes
    // to the book's authors, publishers and dates.
    //
    // It is in the preview panel rather than in the chapter list for the same
    // reason the css box is: it is written about a chapter you are looking at,
    // and a row in a list is not one.
    var chapterMetaHolder = document.createElement('div');
    chapterMetaHolder.id = 'chapterEditor-chapterMetaHolder';

    var chapterMetaHint = document.createElement('div');
    chapterMetaHint.id = 'chapterEditor-chapterMetaHint';
    chapterMetaHint.innerText = chrome.i18n.getMessage('chapterMetadataHint');

    var chapterMetaFields = createMetadataFieldSet('chapterEditor-chapterMeta', {
        emptyHint: chrome.i18n.getMessage('metadataFromPage'),
        onInput: function() {
            applyChapterMetaToPreview();
            updateToolbar();
        }
    });

    chapterMetaHolder.appendChild(chapterMetaHint);
    chapterMetaHolder.appendChild(chapterMetaFields.element);

    function setChapterMetaOpen(open) {
        chapterMetaHolder.style.display = open ? 'block' : 'none';
        chapterMetaButton.classList.toggle('chapterEditor-mode-active', open);
    }
    setChapterMetaOpen(false);

    // What the current mode does, and - in remove mode - what a click would take
    // with it. Naming the element that is about to go is the difference between
    // removing a stray advertisement and removing the article around it.
    var previewHint = document.createElement('div');
    previewHint.id = 'chapterEditor-previewHint';

    previewContent.appendChild(previewHeader);
    previewContent.appendChild(previewToolbar);
    previewContent.appendChild(chapterCssHolder);
    previewContent.appendChild(chapterMetaHolder);
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

    // The ways out of this page that are not ours: the tab's own close button,
    // a reload, a navigation. leavePage() is not one of them - it is taken after
    // a question of our own, or after a save, and it says so.
    window.addEventListener('beforeunload', function(event) {
        if (leaving || !hasUnsavedWork()) {
            return;
        }
        event.preventDefault();
        // what browsers that do not act on preventDefault here still act on
        event.returnValue = '';
    });

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
        // Everything this page holds is held only here, so a close is the last
        // chance to keep it. Asked with confirm() rather than left to
        // beforeunload because this path is a click on one of our own buttons:
        // beforeunload is for the ways out the page does not own, and letting
        // both fire would ask the same question twice on the same close.
        if (hasUnsavedWork() &&
            !confirm(chrome.i18n.getMessage('discardChangesConfirm'))) {
            return;
        }
        leavePage();
    }

    // the editor is the whole tab now, so closing it closes the tab
    function leavePage() {
        leaving = true;
        window.close();
        // The suppression lasts as long as the attempt and no longer: a tab the
        // browser declines to close is a tab still holding the book, and one
        // whose guard has been switched off for good would then discard it on
        // the next reload without a word.
        setTimeout(function() {
            leaving = false;
        }, 0);
    }

    function removeListItem(atIndex) {
        return function() {
            // Named by the title the row shows rather than the one storage
            // holds, so an unsaved rename is not asked about under its old name
            var titleInput = document.getElementById('text' + atIndex);
            var title = titleInput && titleInput.value.trim() !== '' ?
                        titleInput.value : allPagesRef[atIndex].title;
            if (!confirm(chrome.i18n.getMessage('removeChapterConfirm') +
                         ' <' + title + '>')) {
                return;
            }
            allPagesRef[atIndex].removed = true;
            var tmpListElem = document.getElementById('li' + atIndex);
            tmpListElem.style.display = 'none';
            if (isBookMetaOpen()) {
                // the removed chapter's author is no longer one of the book's
                refreshBookMetaPlaceholders();
            }
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

        // The boxes hold what was stated about this chapter; what its page said
        // stands behind them as the placeholders, which is the whole of the
        // precedence rule made visible.
        chapterMetaFields.fill(page.metadataOverride);
        chapterMetaOriginal = chapterMetaFields.serialize();
        // an override of nothing, so the fallbacks are what the page stated
        chapterMetaFields.setPlaceholders(getPageMetadata(page, null));
        setChapterMetaOpen(!chapterMetaFields.isEmpty());

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

    // The one thing the metadata panel changes about the rendering: which
    // language the chapter is written in, which is what a reading system
    // hyphenates and speaks by. Set on the open document rather than by
    // rebuilding it - a rebuilt srcdoc reloads the frame, and reloading it would
    // throw away the edit session and every unsaved change in it.
    function applyChapterMetaToPreview() {
        var doc = previewDocument();
        if (!doc || !doc.documentElement || !previewChapter) {
            return;
        }
        doc.documentElement.lang =
            getPageMetadata(previewChapter, chapterMetaFields.read()).lang || 'en';
    }

    function isChapterCssDirty() {
        return previewChapter !== null && chapterCssArea.value !== chapterCssOriginal;
    }

    function isChapterMetaDirty() {
        return previewChapter !== null && chapterMetaFields.serialize() !== chapterMetaOriginal;
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
        chapterMetaFields.fill(null);
        chapterMetaFields.setPlaceholders(null);
        chapterMetaOriginal = chapterMetaFields.serialize();
        while (previewBody.firstChild) {
            previewBody.removeChild(previewBody.firstChild);
        }
    }

    function closePreview() {
        // Edits live in the frame - and the chapter's css and metadata in their
        // boxes - until they are saved, and all of them go when the panel
        // closes. Nothing else in this page warns before discarding work,
        // because nothing else in it holds any.
        if (((editSession && editSession.isDirty()) || isChapterCssDirty() ||
             isChapterMetaDirty()) &&
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
    // The content, this chapter's css and what it states about itself are saved
    // together, by this one button, because they are what the panel holds and a
    // user who has changed several of them would otherwise have to find several
    // ways to keep them. Neither the css nor the metadata needs the edit session
    // - they are fields on the record, not a serialization of a DOM - so a
    // chapter that failed to become editable can still be styled and described.
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
            // stated nothing is stored as nothing, so that a chapter whose panel
            // was opened and closed again is the record it was
            allPagesRef[previewIndex].metadataOverride =
                chapterMetaFields.isEmpty() ? null : chapterMetaFields.read();
            chapterMetaOriginal = chapterMetaFields.serialize();
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
            setChapterMetaOpen(false);
        }

        narrowButton.disabled = !editSession || editSession.getWidenLevel() === 0;
        undoButton.disabled = !editSession || !editSession.canUndo();
        undoButton.style.display = editable ? 'inline' : 'none';
        saveChapterButton.disabled =
            !((editSession && editSession.isDirty()) || isChapterCssDirty() ||
              isChapterMetaDirty());

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
                buildEbook(changes.chapters, {
                    title: changes.title,
                    uuid: uuid,
                    css: changes.bookCss,
                    metadata: changes.metadata
                });
            });
        } catch (e) {
            console.log('Error:', e);
        }
    }

    // The chapters as this page currently shows them: in list order, without the
    // ones marked removed, carrying the titles as they stand in their boxes.
    // What saveChanges() writes, and what the book metadata placeholders are
    // derived from - those two have to be the same book, or the panel describes
    // one nobody asked for.
    function collectChapters() {
        var chapters = [];
        var tmpChaptersList = document.getElementsByClassName('chapterEditor-chapter-item');
        if (!tmpChaptersList || !allPagesRef) {
            return chapters;
        }
        for (var i = 0; i < tmpChaptersList.length; i++) {
            var tmpChapterItem = tmpChaptersList[i];
            var listIndex = Number(tmpChapterItem.id.replace('li', ''));
            if (allPagesRef[listIndex].removed === false) {
                allPagesRef[listIndex].title =
                    tmpChapterItem.children.namedItem('text' + listIndex).value;
                chapters.push(allPagesRef[listIndex]);
            }
        }
        return chapters;
    }

    // Persists what the page currently shows, and hands it back so that a build
    // can use it without waiting for storage.
    function saveChanges() {
        var newEbookTitle = ebookTilte.value;
        if (newEbookTitle.trim() === '') {
            newEbookTitle = 'eBook';
        }

        try {
            if (!allPagesRef) {
                return;
            }
            var newChapters = collectChapters();
            // stated nothing is stored as nothing - the same rule the chapter
            // panel follows, so that a book nobody described has no record
            // saying it was described with five empty strings
            var newMetadata = bookMetaFields.isEmpty() ? null : bookMetaFields.read();

            saveEbookTitle(newEbookTitle);
            saveBookCss(bookCssArea.value);
            saveBookMetadata(newMetadata);
            saveEbookPages(newChapters);
            // what was just written is what the page shows, so nothing here is
            // unsaved any more - and closing after a save asks nothing
            resetDirtyBaseline();
            return {
                chapters: newChapters,
                title: newEbookTitle,
                bookCss: bookCssArea.value,
                metadata: newMetadata
            };
        } catch (e) {
            console.log('Error:', e);
        }
    }

    /////////////////////

    getEbookPages(function (allPages) {
        createChapterList(allPages);
        noteLoaded();
    });
}

// ---- the metadata boxes ------------------------------------------------------
//
// The things a user can state about a book, and the same things about one
// chapter of it. One function builds both, because they are the same fields read
// the same way: what differs is only what an empty one falls back to, and that
// is what the placeholders say.
//
// An empty box is not an empty value. It means no override - use what the page
// said - and it has to, because empty is what every box starts as and it cannot
// mean one thing then and another later. The consequence is worth stating: there
// is no way to type a blank publisher over one a page stated. Removing what a
// page said is the one thing this panel does not do.
//
// Nothing here is normalized on the way in. What the user typed is what is
// stored and what they see again on reopening, even when it is not usable;
// normalizeMetadataOverride() in saveEbook.js is where it becomes a value the
// package can carry, or nothing at all. The two fields where "not usable" is
// possible say so as they are typed rather than dropping the text silently.
function createMetadataFieldSet(idPrefix, options) {
    options = options || {};
    var onInput = options.onInput || function() {};
    var emptyHint = options.emptyHint || '';

    var element = document.createElement('div');
    element.id = idPrefix + 'Fields';
    element.className = 'chapterEditor-metaFields';

    var inputs = {};
    var warnings = {};

    // The two fields with a wrong answer as well as a right one. The rest is
    // free text, which escapeXMLChars() makes safe at write time.
    var validators = {
        lang: {normalize: normalizeLanguageTag, message: 'metadataLanguageIgnored'},
        date: {normalize: normalizeDate, message: 'metadataDateIgnored'}
    };

    function validate() {
        Object.keys(validators).forEach(function(name) {
            var typed = inputs[name].value.trim();
            var usable = typed === '' || validators[name].normalize(typed) !== '';
            warnings[name].innerText = usable ? '' :
                chrome.i18n.getMessage(validators[name].message);
            inputs[name].classList.toggle('chapterEditor-metaInvalid', !usable);
        });
    }

    function addField(name, labelKey, multiline, hintKey) {
        var row = document.createElement('div');
        row.className = 'chapterEditor-metaRow';

        var label = document.createElement('label');
        label.className = 'chapterEditor-metaLabel';
        label.htmlFor = idPrefix + '-' + name;
        label.innerText = chrome.i18n.getMessage(labelKey);

        var field = document.createElement(multiline ? 'textarea' : 'input');
        field.id = idPrefix + '-' + name;
        field.className = 'chapterEditor-metaInput';
        field.spellcheck = false;
        if (multiline) {
            field.rows = 2;
        } else {
            field.type = 'text';
        }
        field.oninput = function() {
            validate();
            onInput();
        };

        var note = document.createElement('span');
        note.className = 'chapterEditor-metaNote';
        if (hintKey) {
            note.innerText = chrome.i18n.getMessage(hintKey);
        }

        var warning = document.createElement('span');
        warning.id = idPrefix + '-' + name + 'Warning';
        warning.className = 'chapterEditor-metaWarning';

        var value = document.createElement('div');
        value.className = 'chapterEditor-metaValue';
        value.appendChild(field);
        value.appendChild(note);
        value.appendChild(warning);

        row.appendChild(label);
        row.appendChild(value);
        element.appendChild(row);

        inputs[name] = field;
        warnings[name] = warning;
    }

    // One author per line rather than separated by commas: "Smith, Jane" is a
    // name as libraries write it, and a separator a name can contain is one that
    // turns one author into two.
    addField('authors', 'metadataAuthors', true, 'metadataAuthorsHint');
    addField('lang', 'metadataLanguage', false, 'metadataLanguageHint');
    addField('publisher', 'metadataPublisher', false, null);
    addField('date', 'metadataDate', false, 'metadataDateHint');
    addField('description', 'metadataDescription', true, null);

    function asText(value, separator) {
        if (Array.isArray(value)) {
            return value.join(separator);
        }
        return typeof value === 'string' ? value : '';
    }

    function lines(text) {
        return String(text).split('\n').map(function(line) {
            return line.trim();
        }).filter(function(line) {
            return line !== '';
        });
    }

    function read() {
        return {
            lang: inputs.lang.value.trim(),
            authors: lines(inputs.authors.value),
            publisher: inputs.publisher.value.trim(),
            description: inputs.description.value.trim(),
            date: inputs.date.value.trim()
        };
    }

    return {
        element: element,
        read: read,
        // Whether anything was stated at all. An override of nothing is stored
        // as nothing, so that a chapter somebody opened and closed again is the
        // record it was.
        isEmpty: function() {
            var stated = read();
            return stated.lang === '' && stated.authors.length === 0 &&
                   stated.publisher === '' && stated.description === '' && stated.date === '';
        },
        // for comparing against what was in the boxes when they were filled -
        // "has this changed" answered by the values rather than by a flag that
        // has to be cleared in the right places
        serialize: function() {
            return JSON.stringify(read());
        },
        fill: function(values) {
            var stated = values && typeof values === 'object' ? values : {};
            inputs.lang.value = stated.lang || '';
            inputs.authors.value = Array.isArray(stated.authors) ? stated.authors.join('\n') : '';
            inputs.publisher.value = stated.publisher || '';
            inputs.description.value = stated.description || '';
            inputs.date.value = stated.date || '';
            validate();
        },
        // What the build would use for a box left empty, shown greyed inside it.
        // A box whose fallback is nothing shows where that nothing would come
        // from instead, which is the one thing the user cannot see from here.
        //
        // Takes what getPageMetadata() and deriveBookMetadata() return, and those
        // two disagree about a field's shape: a chapter has one publisher, a book
        // has every publisher its chapters named. Joined here rather than by each
        // caller, because a list that reaches a placeholder unjoined is a list
        // rendered by Array.toString - commas, no spaces, and no way to tell one
        // publisher with a comma in its name from two without.
        setPlaceholders: function(values) {
            var derived = values || {};
            inputs.lang.placeholder = asText(derived.lang, ', ') || emptyHint;
            inputs.authors.placeholder = asText(derived.authors, '\n') || emptyHint;
            inputs.publisher.placeholder = asText(derived.publisher, ', ') || emptyHint;
            inputs.description.placeholder = asText(derived.description, ' ') || emptyHint;
            inputs.date.placeholder = asText(derived.date, ', ') || emptyHint;
        }
    };
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
