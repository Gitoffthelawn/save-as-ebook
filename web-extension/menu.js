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

// removeEbook() was declared here as well as in utils.js, which the popup did
// not load. It does now - for the style list below - so the two would be one
// name meaning whichever was loaded last; there is one of them, in utils.js.

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
// fed are gone; selectStylesForUrl in styleLibrary.js is now the only matcher,
// and what this file does with it is show the answer rather than store one.

function createIncludeStyle(data) {
    let includeStyleCheck = document.getElementById('includeStyleCheck');
    includeStyleCheck.checked = data;
    renderCurrentStyles();
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
    // the list below is a list of what will run, and this is the switch that
    // decides whether any of it does
    renderCurrentStyles();
}

/////
// Which site styles this page would take, under the button that opens the
// library. The popup is where a page is saved from, so it is where "what is
// about to be done to this page" belongs - and a style that turns out to be the
// wrong one is switched off here rather than three clicks away.

// The tab the popup was opened on. Asked for once: it is what the list is about
// and what both editor buttons hand over, and an extension page cannot look it
// up for itself afterwards - see openEditor below.
let currentTabUrl = null;
let currentLibrary = null;

chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {
    currentTabUrl = tabs && tabs[0] && tabs[0].url ? tabs[0].url : '';
    getStyleLibrary(function (library) {
        currentLibrary = library;
        renderCurrentStyles();
    });
});

// What this page would take, switched on or not - so that a style written for
// the site can be turned on from here - minus the every-page styles that are
// switched off. Those are not about this page in particular, and a library with
// a few of them in it would push the buttons below off the popup.
function stylesForThisPage() {
    if (!currentLibrary) {
        return [];
    }
    return styleCandidatesForUrl(currentTabUrl, currentLibrary)
        .filter((entry) => entry.scope !== 'theme' || entry.enabled !== false);
}

function renderCurrentStyles() {
    let holder = document.getElementById('currentStyles');
    while (holder.firstChild) {
        holder.removeChild(holder.firstChild);
    }
    // nothing is known yet - an empty list here would read as "no style for this
    // site", which is an answer rather than the absence of one
    if (!currentLibrary) {
        return;
    }

    let includeStyle = document.getElementById('includeStyleCheck').checked;
    let entries = stylesForThisPage();
    holder.className = includeStyle ? '' : 'currentStylesOff';

    for (let entry of entries) {
        let row = document.createElement('div');
        row.className = 'currentStyleRow';

        let check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = entry.enabled !== false;
        check.title = chrome.i18n.getMessage('styleEnabledHint');
        check.onclick = function () {
            setStyleEnabled(entry.id, check.checked);
        };
        row.appendChild(check);

        let name = document.createElement('span');
        name.className = 'currentStyleName';
        name.textContent = entry.title.trim() === '' ?
                           chrome.i18n.getMessage('untitledStyle') : entry.title;
        // which of the two kinds it is, and what it matches, without a second line
        name.title = entry.scope === 'theme' ?
                     chrome.i18n.getMessage('styleAppliesEveryPage') : entry.match.pattern;
        row.appendChild(name);

        holder.appendChild(row);
    }

    // Nothing in the library is written for this site. An every-page style being
    // listed above does not answer that - it is on whatever page the user is
    // looking at - so the offer stands whether or not one is running.
    if (!entries.some((entry) => entry.scope !== 'theme')) {
        let none = document.createElement('button');
        none.id = 'currentStylesNone';
        none.type = 'button';
        none.textContent = chrome.i18n.getMessage('noStyleForThisSite');
        none.onclick = openStyleLibrary;
        holder.appendChild(none);
    }

    if (!includeStyle) {
        let note = document.createElement('div');
        note.id = 'currentStylesNote';
        note.textContent = chrome.i18n.getMessage('stylesOffNote');
        holder.appendChild(note);
    }
}

// Read again before writing rather than written from the copy this popup has
// held since it opened: the library page writes the whole library, and it may
// well be open in another tab. The read is a message to the same service worker
// the write goes to, so the two cannot interleave.
function setStyleEnabled(id, enabled) {
    getStyleLibrary(function (library) {
        let entry = library.entries.find((existing) => existing.id === id);
        if (!entry) {
            // deleted from the library page while this popup was open
            currentLibrary = library;
            renderCurrentStyles();
            return;
        }
        currentLibrary = putStyleEntry(library, Object.assign({}, entry, {enabled: enabled}));
        saveStyleLibrary(currentLibrary, renderCurrentStyles);
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
function openStyleLibrary() {
    let url = currentTabUrl === null ? '' : currentTabUrl;
    openEditor('styles.html' + (url === '' ? '' : '?for=' + encodeURIComponent(url)));
}

document.getElementById("editStyles").onclick = openStyleLibrary;

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
