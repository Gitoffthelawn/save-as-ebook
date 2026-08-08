// create menu labels - the translations are plain text, so textContent both
// renders them correctly and keeps the store's "unsafe innerHTML" check quiet
document.getElementById('menuTitle').textContent = chrome.i18n.getMessage('extName');
document.getElementById('includeStyle').textContent = chrome.i18n.getMessage('includeStyle');
document.getElementById('readerMode').textContent = chrome.i18n.getMessage('readerMode');
// which of the four actions it applies to is not guessable from the label
document.getElementById('readerModeOption').title = chrome.i18n.getMessage('readerModeHint');
document.getElementById('reviewBeforeSaving').textContent = chrome.i18n.getMessage('reviewBeforeSaving');
// what "review" means here - which two actions change, and where they stop -
// does not fit on the line
document.getElementById('reviewBeforeSavingOption').title = chrome.i18n.getMessage('reviewBeforeSavingHint');
document.getElementById('styleThisPage').textContent = chrome.i18n.getMessage('styleThisPage');
// what it does that "Edit Site Styles" does not - it captures the page first
document.getElementById('styleThisPage').title = chrome.i18n.getMessage('styleThisPageHint');
document.getElementById('editStyles').textContent = chrome.i18n.getMessage('editStyles');
document.getElementById('savePageLabel').textContent = chrome.i18n.getMessage('savePage');
document.getElementById('saveSelectionLabel').textContent = chrome.i18n.getMessage('saveSelection');
document.getElementById('pageChapterLabel').textContent = chrome.i18n.getMessage('pageChapter');
document.getElementById('selectionChapterLabel').textContent = chrome.i18n.getMessage('selectionChapter');
document.getElementById('editChapters').textContent = chrome.i18n.getMessage('editChapters');
document.getElementById('waitMessage').textContent = chrome.i18n.getMessage('waitMessage');

// the service worker cannot close the popup directly, it asks for it
chrome.runtime.onMessage.addListener((request) => {
    if (request && request.type === 'popup-close') {
        window.close();
    }
});

function removeEbook(callback) {
    chrome.runtime.sendMessage({
        type: "remove"
    }, function(response) {
        if (callback) {
            callback();
        }
    });
}

chrome.runtime.sendMessage({
    type: "is busy?"
}, function(response) {
    if (response.isBusy) {
        document.getElementById('busy').style.display = 'block';
    } else {
        document.getElementById('busy').style.display = 'none';
    }
});

// The popup used to run its own copy of the URL matching here, to write the
// style it picked into storage under 'currentStyle'. Nothing ever read it - the
// capture path works the match out for itself - so both the copy and the key it
// fed are gone; selectStylesForUrl in styleLibrary.js is now the only matcher.

function createIncludeStyle(data) {
    let includeStyleCheck = document.getElementById('includeStyleCheck');
    includeStyleCheck.checked = data;
}

chrome.runtime.sendMessage({
    type: "get include style"
}, function(response) {
    createIncludeStyle(response.includeStyle);
});

document.getElementById('includeStyleCheck').onclick = function () {
    let includeStyleCheck = document.getElementById('includeStyleCheck');
    chrome.runtime.sendMessage({
        type: "set include style",
        includeStyle: includeStyleCheck.checked
    }, function(response) {
    });
}

function createReaderMode(data) {
    let readerModeCheck = document.getElementById('readerModeCheck');
    readerModeCheck.checked = data;
}

chrome.runtime.sendMessage({
    type: "get reader mode"
}, function(response) {
    createReaderMode(response.readerMode);
});

document.getElementById('readerModeCheck').onclick = function () {
    let readerModeCheck = document.getElementById('readerModeCheck');
    chrome.runtime.sendMessage({
        type: "set reader mode",
        readerMode: readerModeCheck.checked
    }, function(response) {
    });
}

function createReviewBeforeSaving(data) {
    let reviewCheck = document.getElementById('reviewBeforeSavingCheck');
    reviewCheck.checked = data;
}

chrome.runtime.sendMessage({
    type: "get review before saving"
}, function(response) {
    createReviewBeforeSaving(response.reviewBeforeSaving);
});

document.getElementById('reviewBeforeSavingCheck').onclick = function () {
    let reviewCheck = document.getElementById('reviewBeforeSavingCheck');
    chrome.runtime.sendMessage({
        type: "set review before saving",
        reviewBeforeSaving: reviewCheck.checked
    }, function(response) {
    });
}

// Both editors are extension pages now rather than scripts injected into
// whatever site is open: they need no access to the page, and on their own page
// they cannot be read or interfered with by it.
//
// Reusing an already open editor tab would mean querying tabs by url, which
// needs the "tabs" permission - not worth re-adding a permission this change set
// is trying to shed.
function openEditor(page) {
    chrome.tabs.create({url: chrome.runtime.getURL(page)});
    window.close();
}

// The library is asked "which of these apply here, and does this pattern match?"
// about the page the user was looking at - and once it is a tab of its own, it is
// the page the user is looking at. So the popup hands the url over, while it
// still has activeTab for the tab it was opened on: an extension page cannot ask
// which tab was in front of it, and being able to would need the tabs permission.
document.getElementById("editStyles").onclick = function() {
    chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
        let url = tabs && tabs[0] && tabs[0].url ? tabs[0].url : '';
        openEditor('styles.html' + (url === '' ? '' : '?for=' + encodeURIComponent(url)));
    });
};

document.getElementById("editChapters").onclick = function() {
    openEditor('chapters.html');
};

// Captures this page and opens the library on it, so that a style can be written
// against something visible instead of against a guess. It is a capture, so it
// takes as long as saving the page does and goes through the same busy state -
// and the background is the one that opens the library, once it has a page to
// show there.
document.getElementById("styleThisPage").onclick = function() {
    dispatch('style-snapshot', true);
};

// The wait message stays up for as long as this popup lives: the background
// answers as soon as the command has started, not when the ebook is finished,
// and it is the one that closes the popup once the job ends (see finishJob).
//
// A save starts a new book, so the old chapters go first - and only once the
// removal is confirmed, or the command would race the storage write.
function dispatch(commandType, justAddToBuffer) {
    document.getElementById('busy').style.display = 'block';
    let start = function () {
        chrome.runtime.sendMessage({
            type: commandType
        }, function(response) {
        });
    };
    if (justAddToBuffer) {
        start();
    } else {
        removeEbook(start);
    }
}

document.getElementById('savePage').onclick = function() {
    dispatch('save-page', false);
};

document.getElementById('saveSelection').onclick = function() {
    dispatch('save-selection', false);
};

document.getElementById('pageChapter').onclick = function() {
    dispatch('add-page', true);
};

document.getElementById('selectionChapter').onclick = function() {
    dispatch('add-selection', true);
};

// get all shortcuts and display them in the menuTitle
chrome.commands.getAll((commands) => {
    for (let command of commands) {
        if (command.name === 'save-page') {
            document.getElementById('savePageShortcut').appendChild(document.createTextNode(command.shortcut));
        } else if (command.name === 'save-selection') {
            document.getElementById('saveSelectionShortcut').appendChild(document.createTextNode(command.shortcut));
        } else if (command.name === 'add-page') {
            document.getElementById('pageChapterShortcut').appendChild(document.createTextNode(command.shortcut));
        } else if (command.name === 'add-selection') {
            document.getElementById('selectionChapterShortcut').appendChild(document.createTextNode(command.shortcut));
        }
    }
})
