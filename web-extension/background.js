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

// MV3: the service worker is evicted when idle, so the record of the job in
// flight lives in chrome.storage.session (in-memory, survives worker restarts,
// cleared when the browser restarts) instead of a module variable. A pending
// setTimeout would not survive eviction either.
//
// The job is considered gone when its heartbeat stops rather than when a fixed
// deadline passes: a big page can spend well over a minute downloading images,
// and a plain deadline declared it finished while it was still running, so a
// second job could start and interleave with it through the content script's
// globals. The content script pings while it works; a tab that was closed or
// navigated away stops pinging and the job is reclaimed.
const JOB_TIMEOUT = 30000

// Injected on demand instead of declared in the manifest. That keeps the
// extension off every page the user visits, and lets it run with activeTab
// alone - a <all_urls> host permission would show a "read and change all your
// data on all websites" warning at install. Order matters: jszip before the
// script that uses it.
const CONTENT_SCRIPTS = ['libs/jszip.js', 'utils.js', 'extractHtml.js', 'saveEbook.js']

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

// job: {tabId, startedAt, lastHeartbeat, injectedCss}
function getJob(callback) {
    chrome.storage.session.get('job', (data) => {
        let job = data && data.job ? data.job : null
        if (job && Date.now() - job.lastHeartbeat >= JOB_TIMEOUT) {
            // stopped reporting - the tab is gone or the extraction died
            job = null
        }
        callback(job)
    })
}

function isBusy(callback) {
    getJob((job) => callback(!!job))
}

function startJob(tabId, callback) {
    let now = Date.now()
    chrome.storage.session.set({
        'job': {tabId: tabId, startedAt: now, lastHeartbeat: now, injectedCss: null}
    }, () => {
        chrome.action.setBadgeBackgroundColor({color: "red"})
        chrome.action.setBadgeText({text: "Busy"})
        if (callback) {
            callback()
        }
    })
}

// Records that the job is still making progress. Only touches an existing job,
// so a stray heartbeat from an abandoned tab cannot resurrect one.
function touchJob() {
    chrome.storage.session.get('job', (data) => {
        if (!data || !data.job) {
            return
        }
        data.job.lastHeartbeat = Date.now()
        chrome.storage.session.set({'job': data.job})
    })
}

// Records what still has to be undone when the job ends
function updateJob(fields) {
    chrome.storage.session.get('job', (data) => {
        if (!data || !data.job) {
            return
        }
        chrome.storage.session.set({'job': Object.assign(data.job, fields)})
    })
}

// The single terminal path - every way a job can end goes through here, so the
// badge, the injected css and the flag cannot survive it.
function endJob() {
    chrome.storage.session.get('job', (data) => {
        let job = data && data.job ? data.job : null

        chrome.storage.session.remove('job')
        chrome.action.setBadgeText({text: ""})

        // the styles the extension injected for this site are the page's problem
        // once the job is over - leaving them applied silently restyles the page
        if (job && job.injectedCss && job.tabId != null) {
            ext.scripting.removeCSS({
                target: {tabId: job.tabId},
                css: job.injectedCss
            }).catch(() => {})
        }

        // a service worker has no window handles - chrome.extension.getViews() does
        // not exist here, so ask the popup to close itself. Most of the time no popup
        // is open, which rejects with "Receiving end does not exist" - ignore it.
        ext.runtime.sendMessage({type: 'popup-close'}).catch(() => {})
    })
}

// A closed tab cannot finish its job or send another heartbeat
chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.get('job', (data) => {
        if (data && data.job && data.job.tabId === tabId) {
            endJob()
        }
    })
})

// Injects the content scripts unless the tab already has them. Re-injecting
// would register a second copy of every message listener, so a tab that answers
// the ping is left alone.
function ensureContentScripts(tabId, callback) {
    chrome.tabs.sendMessage(tabId, {type: 'sae-ping'}, (response) => {
        // no receiver yet - reading lastError keeps it from being logged
        void chrome.runtime.lastError

        if (response && response.ready) {
            callback(true)
            return
        }

        ext.scripting.executeScript({
            target: {tabId: tabId},
            files: CONTENT_SCRIPTS
        }).then(() => {
            callback(true)
        }).catch((error) => {
            // no activeTab grant, a chrome:// page, the web store - all end here
            console.log('Error:', error)
            callback(false)
        })
    })
}

chrome.commands.onCommand.addListener((command) => {
    executeCommand({type: command})
});

function executeCommand(command) {
    chrome.tabs.query({
        currentWindow: true,
        active: true
    }, (tab) => {
        if (!tab || !tab[0]) {
            return;
        }
        let tabId = tab[0].id;

        // Injected before the busy check rather than after it: the messages this
        // extension shows the user go through the content script, so a tab
        // without one swallows them. Nothing is injected until the user asks for
        // something, which is the point of dropping the declared content script,
        // and injecting is cheap enough to do for a message.
        ensureContentScripts(tabId, (injected) => {
            if (!injected) {
                // a chrome:// page, the web store, a pdf viewer, or no activeTab
                // grant - there is nowhere to show a message either
                console.log('Save as eBook cannot run in this tab');
                return;
            }

            getJob((job) => {
                if (job) {
                    chrome.tabs.sendMessage(tabId, {'alert': 'Work in progress! Please wait until the current eBook is generated!'}, (r) => {
                        void chrome.runtime.lastError;
                    });
                    return;
                }

                startJob(tabId, () => {
                    if (command.type === 'save-page') {
                        dispatch(tab, 'extract-page', false, []);
                    } else if (command.type === 'save-selection') {
                        dispatch(tab, 'extract-selection', false, []);
                    } else if (command.type === 'add-page') {
                        dispatch(tab, 'extract-page', true, []);
                    } else if (command.type === 'add-selection') {
                        dispatch(tab, 'extract-selection', true, []);
                    } else {
                        endJob();
                    }
                })
            })
        })
    });
}

function dispatch(tab, action, justAddToBuffer, appliedStyles) {
    if (!justAddToBuffer) {
        _execRequest({type: 'remove'});
    }

    isIncludeStyles((result) => {
        let isIncludeStyle = result.includeStyle
        prepareStyles(tab, isIncludeStyle, appliedStyles, (tmpAppliedStyles) => {
            applyAction(tab, action, justAddToBuffer, isIncludeStyle, tmpAppliedStyles)
        })
    })
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
            // remembered so endJob() can take it off the page again
            updateJob({injectedCss: currentStyle.style});
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
        // the content script can go away mid-extraction - a navigation tears it
        // down and the callback fires with no response and lastError set
        void chrome.runtime.lastError;

        if (!response) {
            endJob()
            chrome.tabs.sendMessage(tab[0].id, {'alert': 'Save as eBook does not work on this web site!'}, (r) => {
                void chrome.runtime.lastError;
            });
            return;
        }

        if (!response.content || response.content.trim() === '') {
            endJob()
            if (justAddToBuffer) {
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Cannot add an empty selection as chapter!'}, (r) => {});
            } else {
                chrome.tabs.sendMessage(tab[0].id, {'alert': 'Cannot generate the eBook from an empty selection!'}, (r) => {});
            }
            return;
        }
        if (!justAddToBuffer) {
            // the job stays open until the content script reports 'done' - it
            // still has to build and download the zip
            chrome.tabs.sendMessage(tab[0].id, {'shortcut': 'build-ebook', response: [response]}, (r) => {
                void chrome.runtime.lastError;
            });
        } else {
            chrome.storage.local.get('allPages', (data) => {
                if (!data || !data.allPages) {
                    data.allPages = [];
                }
                data.allPages.push(response);
                chrome.storage.local.set({'allPages': data.allPages}, () => {
                    endJob()
                    chrome.tabs.sendMessage(tab[0].id, {'alert': 'Page or selection added as chapter!'}, (r) => {
                        void chrome.runtime.lastError;
                    });
                });
            })
        }
    });
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
            // the tab is only known for jobs the background started itself
            startJob(sender && sender.tab ? sender.tab.id : null)
        } else {
            endJob()
        }
    }
    // the extraction is still running - see JOB_TIMEOUT
    if (request.type === 'job-heartbeat') {
        touchJob()
    }
    if (request.type === 'save-page' || request.type === 'save-selection' ||
        request.type === 'add-page' || request.type === 'add-selection') {
        executeCommand({type: request.type})
    }
    if (request.type === 'done') {
        endJob()
    }
    return true;
}
