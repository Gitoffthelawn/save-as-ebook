// Firefox's `chrome` namespace is callback-only - those calls return undefined,
// so anything promise-based has to go through `browser`. Chrome has no
// `browser`, and there `chrome` is promise-based under MV3.
const ext = typeof browser !== 'undefined' ? browser : chrome;

///////////////////
///////////////////
///////////////////
///////////////////
/// Only for testing

// MV3: every listener must be registered synchronously on every worker
// startup, so this cannot live inside an onInstalled callback.
let TEST_TIMER = null

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (navigator.userAgent !== 'PuppeteerTestingAgent') {
        return
    }

    if (TEST_TIMER) {
        clearTimeout(TEST_TIMER)
    }

    TEST_TIMER = setTimeout(() => {
        executeCommand({type: 'save-page'})
    }, 2000)
});



///////////////////
///////////////////
///////////////////
///////////////////

// MV3: the service worker is evicted when idle, so the busy flag lives in
// chrome.storage.session (in-memory, survives worker restarts, cleared when the
// browser restarts) instead of a module variable. A pending setTimeout would not
// survive eviction either, so instead of a reset timer we store the start time
// and treat the flag as expired on read.
const BUSY_TIMEOUT = 20000

var defaultStyles = [
    {
        title: 'Reddit Comments',
        url: 'reddit\\.com\\/r\\/[^\\/]+\\/comments',
        style: `.side {
display: none;
}
#header {
display: none;
}
.arrow, .expand, .score, .live-timestamp, .flat-list, .buttons, .morecomments, .footer-parent, .icon {
display: none !important;
}
`
    },{
        title: 'Wikipedia Article',
        url: 'wikipedia\\.org\\/wiki\\/',
        style: `#mw-navigation {
display: none;
}
#footer {
display: none;
}
#mw-panel {
display: none;
}
#mw-head {
display: none;
}
`
    },{
        title: 'YCombinator News Comments',
        url: 'news\\.ycombinator\\.com\\/item\\?id=[0-9]+',
        style: `#hnmain > tbody > tr:nth-child(1) > td > table {
display: none;
}
* {
background-color: white;
}
.title, .storylink {
text-align: left;
font-weight: bold;
font-size: 20px;
}
.score {
display: none;
}
.age {
display: none;
}
.hnpast {
display: none;
}
.togg {
display: none;
}
.votelinks, .rank {
display: none;
}
.votearrow {
display: none;
}
.yclinks {
display: none;
}
form {
display: none;
}
a.hnuser {
font-weight: bold;
color: black !important;
padding: 3px;
}
.subtext > span, .subtext > a:not(:nth-child(2)) {
display: none;
}
`
    },{
        title: 'Medium Article',
        url: 'medium\\.com',
        style: `.metabar {
display: none !important;
}
header.container {
display: none;
}
.js-postShareWidget {
display: none;
}
footer, canvas {
display: none !important;
}
.u-fixed, .u-bottom0 {
display: none;
}
`
    },{
        title: 'Twitter',
        url: 'twitter\\.com\\/.+',
        style: `.topbar {
display: none !important;
}
.ProfileCanopy, .ProfileCanopy-inner {
display: none;
}
.ProfileSidebar {
display: none;
}
.ProfileHeading {
display: none !important;
}
.ProfileTweet-actionList {
display: none;
}
`
    }

];

function isBusy(callback) {
    chrome.storage.session.get('busySince', (data) => {
        if (!data || !data.busySince) {
            callback(false)
            return
        }
        callback(Date.now() - data.busySince < BUSY_TIMEOUT)
    })
}

function setBusy(callback) {
    chrome.storage.session.set({'busySince': Date.now()}, () => {
        if (callback) {
            callback()
        }
    })
}

chrome.commands.onCommand.addListener((command) => {
    executeCommand({type: command})
});

function executeCommand(command) {
    isBusy((busy) => {
        if (busy) {
            chrome.tabs.query({
                currentWindow: true,
                active: true
            }, (tab) => {
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Work in progress! Please wait until the current eBook is generated!'}, (r) => {
                  console.log(r);
                });
            })
            return;
        }

        // mark busy before dispatching - dispatch() can call resetBusy() from one
        // of its callbacks, and that must not be overwritten by a later set
        setBusy(() => {
            if (command.type === 'save-page') {
                dispatch('extract-page', false, []);
            } else if (command.type === 'save-selection') {
                dispatch('extract-selection', false, []);
            } else if (command.type === 'add-page') {
                dispatch('extract-page', true, []);
            } else if (command.type === 'add-selection') {
                dispatch('extract-selection', true, []);
            }
        })
    })
}

function dispatch(action, justAddToBuffer, appliedStyles) {
    if (!justAddToBuffer) {
        _execRequest({type: 'remove'});
    }
    chrome.action.setBadgeBackgroundColor({color:"red"});
    chrome.action.setBadgeText({text: "Busy"});

    chrome.tabs.query({
        currentWindow: true,
        active: true
    }, (tab) => {

        isIncludeStyles((result) =>{
            let isIncludeStyle = result.includeStyle
            prepareStyles(tab, isIncludeStyle, appliedStyles, (tmpAppliedStyles) => {
                applyAction(tab, action, justAddToBuffer, isIncludeStyle, tmpAppliedStyles)
            })
        })
    });
}

function isIncludeStyles(callback) {
    chrome.storage.local.get('includeStyle', (data) => {
        if (!data) {
            callback({includeStyle: false});
        } else {
            callback({includeStyle: data.includeStyle});
        }
    });
}

function prepareStyles(tab, includeStyle, appliedStyles, callback) {
    if (!includeStyle) {
        callback(appliedStyles)
        return
    }

    chrome.storage.local.get('styles', (data) => {
        let styles = defaultStyles;
        if (data && data.styles) {
            styles = data.styles;
        }
        let currentUrl = tab[0].url;
        let currentStyle = null;

        if (!styles) {
            callback(appliedStyles)
            return
        }

        if (styles.length === 0) {
            callback(appliedStyles)
            return
        }

        let allMatchingStyles = [];

        for (let i = 0; i < styles.length; i++) {
            currentUrl = currentUrl.replace(/(http[s]?:\/\/|www\.)/i, '').toLowerCase();
            let styleUrl = styles[i].url;
            let styleUrlRegex = null;

            try {
                styleUrlRegex = new RegExp(styleUrl, 'i');
            } catch (e) {
            }

            if (styleUrlRegex && styleUrlRegex.test(currentUrl)) {
                allMatchingStyles.push({
                    index: i,
                    length: styleUrl.length
                });
            }
        }

        if (allMatchingStyles.length === 0) {
            callback(appliedStyles)
            return
        }
    
        allMatchingStyles.sort((a, b) => b.length - a.length);
        let selStyle = allMatchingStyles[0];

        if (!selStyle) {
            callback(appliedStyles)
            return
        }

        currentStyle = styles[selStyle.index];

        if (!currentStyle) {
            callback(appliedStyles)
            return
        }

        if (!currentStyle.style) {
            callback(appliedStyles)
            return
        }

        ext.scripting.insertCSS({
            target: {tabId: tab[0].id},
            css: currentStyle.style
        }).then(() => {
            appliedStyles.push(currentStyle);
            callback(appliedStyles)
        }).catch(() => {
            callback(appliedStyles)
        });
    });
}

function applyAction(tab, action, justAddToBuffer, includeStyle, appliedStyles) {
    chrome.tabs.sendMessage(tab[0].id, {
        type: action,
        includeStyle: includeStyle,
        appliedStyles: appliedStyles
    }, (response) => {

        if (!response) {
            resetBusy()
            chrome.tabs.sendMessage(tab[0].id, {'alert': 'Save as eBook does not work on this web site!'}, (r) => {});
            return;
        }

        if (response.content.trim() === '') {
            resetBusy()
            if (justAddToBuffer) {
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Cannot add an empty selection as chapter!'}, (r) => {});
            } else {
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Cannot generate the eBook from an empty selection!'}, (r) => {});
            }
            return;
        }
        if (!justAddToBuffer) {
            chrome.tabs.sendMessage(tab[0].id, {'shortcut': 'build-ebook', response: [response]}, (r) => {});
        } else {
            chrome.storage.local.get('allPages', (data) => {
                if (!data || !data.allPages) {
                    data.allPages = [];
                }
                data.allPages.push(response);
                chrome.storage.local.set({'allPages': data.allPages});
                resetBusy()
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Page or selection added as chapter!'}, (r) => {});
            })
        }
    });
}

function resetBusy() {
    chrome.storage.session.remove('busySince')

    chrome.action.setBadgeText({text: ""})

    // a service worker has no window handles - chrome.extension.getViews() does
    // not exist here, so ask the popup to close itself. Most of the time no popup
    // is open, which rejects with "Receiving end does not exist" - ignore it.
    ext.runtime.sendMessage({type: 'popup-close'}).catch(() => {})
}

chrome.runtime.onMessage.addListener(_execRequest);

function _execRequest(request, sender, sendResponse) {
    if (request.type === 'get') {
        chrome.storage.local.get('allPages', function (data) {
            if (!data || !data.allPages) {
                sendResponse({allPages: []});
            }
            sendResponse({allPages: data.allPages});
        })
    }
    if (request.type === 'set') {
        chrome.storage.local.set({'allPages': request.pages});
    }
    if (request.type === 'remove') {
        chrome.storage.local.remove('allPages');
        chrome.storage.local.remove('title');
    }
    if (request.type === 'get title') {
        chrome.storage.local.get('title', function (data) {
            if (!data || !data.title || data.title.trim().length === 0) {
                sendResponse({title: 'eBook'});
            } else {
                sendResponse({title: data.title});
            }
        })
    }
    if (request.type === 'set title') {
        chrome.storage.local.set({'title': request.title});
    }
    if (request.type === 'get styles') {
        chrome.storage.local.get('styles', function (data) {
            if (!data || !data.styles) {
                sendResponse({styles: defaultStyles});
            } else {
                sendResponse({styles: data.styles});
            }
        });
    }
    if (request.type === 'set styles') {
        chrome.storage.local.set({'styles': request.styles});
    }
    if (request.type === 'get current style') {
        chrome.storage.local.get('currentStyle', function (data) {
            if (!data || !data.currentStyle) {
                sendResponse({currentStyle: 0});
            } else {
                sendResponse({currentStyle: data.currentStyle});
            }
        });
    }
    if (request.type === 'set current style') {
        chrome.storage.local.set({'currentStyle': request.currentStyle});
    }
    if (request.type === 'get include style') {
        chrome.storage.local.get('includeStyle', function (data) {
            if (!data) {
                sendResponse({includeStyle: false});
            } else {
                sendResponse({includeStyle: data.includeStyle});
            }
        });
    }
    if (request.type === 'set include style') {
        chrome.storage.local.set({'includeStyle': request.includeStyle});
    }
    if (request.type === 'is busy?') {
        isBusy((busy) => {
            sendResponse({isBusy: busy})
        })
    }
    if (request.type === 'set is busy') {
        if (request.isBusy) {
            setBusy()
        } else {
            resetBusy()
        }
    }
    if (request.type === 'save-page' || request.type === 'save-selection' ||
        request.type === 'add-page' || request.type === 'add-selection') {
        executeCommand({type: request.type})
    }
    if (request.type === 'done') {
        resetBusy()
    }
    return true;
}
