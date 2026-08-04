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
            previewButton.innerText = chrome.i18n.getMessage('rawPreview');
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
        var newChapters = saveChanges();
        prepareEbook(newChapters);
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

    var modal = document.createElement('div');
    modal.id = 'chapterEditor-Modal';

    modalContent.appendChild(modalHeader);
    modalContent.appendChild(modalList);
    modalContent.appendChild(modalFooter);
    modal.appendChild(modalContent);

    body.appendChild(modal);

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
            alert(allPagesRef[atIndex].content.trim().replace(/<[^>]+>/gi, '').replace(/\s+/g, ' ').substring(0, 1000) + ' ...');
        };
    }

    function prepareEbook(newChapters) {
        try {
            if (newChapters.length === 0) {
                alert(chrome.i18n.getMessage('emptyBookWarning'));
                return;
            }
            buildEbookFromChapters();
        } catch (e) {
            console.log('Error:', e);
        }
    }

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
            saveEbookPages(newChapters);
            return newChapters;
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
