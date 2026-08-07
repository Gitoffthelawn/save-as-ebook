var allStyles = [];
var currentStyle = null;
var appliedStyles = [];

// create menu labels - the translations are plain text, so textContent both
// renders them correctly and keeps the store's "unsafe innerHTML" check quiet
document.getElementById('menuTitle').textContent = chrome.i18n.getMessage('extName');
document.getElementById('includeStyle').textContent = chrome.i18n.getMessage('includeStyle');
document.getElementById('readerMode').textContent = chrome.i18n.getMessage('readerMode');
// which of the four actions it applies to is not guessable from the label
document.getElementById('readerModeOption').title = chrome.i18n.getMessage('readerModeHint');
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

function removeEbook() {
    chrome.runtime.sendMessage({
        type: "remove"
    }, function(response) {});
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

chrome.runtime.sendMessage({
    type: "get styles"
}, function(response) {
    createStyleList(response.styles);
});

function createStyleList(styles) {
    allStyles = styles;
    chrome.tabs.query({'active': true}, function (tabs) {
        let currentUrl = tabs[0].url;

        if (!styles || styles.length === 0) {
            return;
        }

        let foundMatchingUrl = false;

        // if multiple URL regexes match, select the longest one
        let allMatchingStyles = [];

        for (let i = 0; i < styles.length; i++) {
            let listItem = document.createElement('option');
            listItem.id = 'option_' + i;
            listItem.className = 'cssEditor-chapter-item';
            listItem.value = 'option_' + i;
            listItem.innerText = styles[i].title;

            currentUrl = currentUrl.replace(/(http[s]?:\/\/|www\.)/i, '').toLowerCase();
            let styleUrl = styles[i].url;
            let styleUrlRegex = null;

            try {
                styleUrlRegex =  new RegExp(styleUrl, 'i');
            } catch (e) {
            }

            if (styleUrlRegex && styleUrlRegex.test(currentUrl)) {
                allMatchingStyles.push({
                    index: i,
                    length: styleUrl.length
                });
            }
        }

        if (allMatchingStyles.length >= 1) {
            allMatchingStyles.sort(function (a, b) {
                return b.length - a.length;
            });
            let selStyle = allMatchingStyles[0];
            currentStyle = styles[selStyle.index];

            chrome.runtime.sendMessage({
                type: "set current style",
                currentStyle: currentStyle
            }, function(response) {
            });
        }
    });
}

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

document.getElementById("editStyles").onclick = function() {
    openEditor('styles.html');
};

document.getElementById("editChapters").onclick = function() {
    openEditor('chapters.html');
};

function dispatch(commandType, justAddToBuffer) {
    document.getElementById('busy').style.display = 'block';
    if (!justAddToBuffer) {
        removeEbook();
    }
    chrome.runtime.sendMessage({
        type: commandType
    }, function(response) {
        //FIXME - hidden before done
        document.getElementById('busy').style.display = 'none';
    });
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
