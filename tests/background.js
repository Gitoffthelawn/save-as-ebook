// Background service-worker coverage. The worker is evaluated unchanged in a
// VM with a small callback-compatible Chrome API, which keeps these tests fast
// and makes message-listener mistakes (especially duplicate sendResponse
// calls) visible without launching a browser.
//
//   node background.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'web-extension', 'background.js'), 'utf8');
// What the worker gets from importScripts, which the VM has no equivalent of.
// Kept a separate evaluation rather than concatenated so that a line number in a
// stack trace still points at the file it came from.
const backgroundDependencies = ['cssSanitizer.js', 'styleLibrary.js'].map((file) => ({
    filename: file,
    source: fs.readFileSync(path.join(__dirname, '..', 'web-extension', file), 'utf8')
}));

function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createHarness(options) {
    options = options || {};
    const state = {
        now: options.now === undefined ? 1000 : options.now,
        local: copy(options.local) || {},
        session: copy(options.session) || {},
        badgeColors: [],
        badgeTexts: [],
        tabMessages: [],
        createdTabs: [],
        runtimeMessages: [],
        executeScripts: [],
        insertedCss: [],
        removedCss: [],
        fetches: [],
        logs: [],
        pendingSessionGets: [],
        listeners: {tabUpdated: [], tabRemoved: [], command: [], message: []},
        uuidIndex: 0
    };

    function event(list) {
        return {addListener: (listener) => list.push(listener)};
    }

    function storageResult(store, keys) {
        if (typeof keys === 'string') {
            return Object.prototype.hasOwnProperty.call(store, keys) ?
                {[keys]: copy(store[keys])} : {};
        }
        if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(store, key)) {
                    result[key] = copy(store[key]);
                }
            }
            return result;
        }
        return copy(store);
    }

    function storageArea(name) {
        const store = state[name];
        return {
            get: (keys, callback) => {
                const invoke = () => callback(storageResult(store, keys));
                if (name === 'session' && options.deferSessionGets) {
                    state.pendingSessionGets.push(invoke);
                } else {
                    invoke();
                }
            },
            set: (items, callback) => {
                for (const key of Object.keys(items)) store[key] = copy(items[key]);
                if (callback) callback();
            },
            remove: (keys, callback) => {
                for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
                if (callback) callback();
            }
        };
    }

    const chrome = {
        storage: {local: storageArea('local'), session: storageArea('session')},
        action: {
            setBadgeBackgroundColor: (value) => state.badgeColors.push(copy(value)),
            setBadgeText: (value) => state.badgeTexts.push(copy(value))
        },
        tabs: {
            onUpdated: event(state.listeners.tabUpdated),
            onRemoved: event(state.listeners.tabRemoved),
            query: (query, callback) => callback(copy(options.tabs || [
                {id: 7, url: 'https://example.com/article'}
            ])),
            create: (details) => state.createdTabs.push(copy(details)),
            sendMessage: (tabId, message, callback) => {
                state.tabMessages.push({tabId: tabId, message: copy(message)});
                let response;
                let interrupted = false;
                if (message.type === 'sae-ping') {
                    response = Object.prototype.hasOwnProperty.call(options, 'pingResponse') ?
                        options.pingResponse : {ready: true};
                } else if (message.type === 'extract-page' ||
                           message.type === 'extract-selection') {
                    response = Object.prototype.hasOwnProperty.call(options, 'extractionResponse') ?
                        options.extractionResponse : {title: 'Article', content: '<p>body</p>'};
                    interrupted = !!options.interruptedExtraction;
                }
                if (callback) {
                    chrome.runtime.lastError = interrupted ? {message: 'The tab navigated'} : null;
                    callback(copy(response));
                    chrome.runtime.lastError = null;
                }
            }
        },
        commands: {onCommand: event(state.listeners.command)},
        runtime: {
            lastError: null,
            getURL: (path) => 'chrome-extension://save-as-ebook/' + path,
            onMessage: event(state.listeners.message),
            sendMessage: (message) => {
                state.runtimeMessages.push(copy(message));
                return Promise.resolve();
            }
        },
        scripting: {
            executeScript: (details) => {
                state.executeScripts.push(copy(details));
                return options.executeScriptFailure ?
                    Promise.reject(new Error('injection denied')) : Promise.resolve();
            },
            insertCSS: (details) => {
                state.insertedCss.push(copy(details));
                return options.insertCssFailure ?
                    Promise.reject(new Error('CSS denied')) : Promise.resolve();
            },
            removeCSS: (details) => {
                state.removedCss.push(copy(details));
                return Promise.resolve();
            }
        }
    };

    // styles/catalog.json, which the worker reads with fetch. Empty unless a test
    // says otherwise, so that a test about injection is about the styles it set
    // up rather than about whatever the extension happens to ship.
    const catalog = options.catalog === undefined ? {version: 1, entries: []} : options.catalog;

    const uuids = options.uuids || ['uuid-1', 'uuid-2', 'uuid-3'];
    const context = {
        chrome: chrome,
        fetch: (url) => {
            state.fetches.push(url);
            if (options.catalogFailure) {
                return Promise.reject(new Error('no such resource'));
            }
            return Promise.resolve({json: () => Promise.resolve(copy(catalog))});
        },
        navigator: {userAgent: 'BackgroundUnitTest'},
        console: {log: (...args) => state.logs.push(args)},
        crypto: {randomUUID: () => uuids[state.uuidIndex++]},
        Date: {now: () => state.now},
        setTimeout: () => 1,
        clearTimeout: () => {}
    };
    vm.createContext(context);
    for (const dependency of backgroundDependencies) {
        vm.runInContext(dependency.source, context, {filename: dependency.filename});
    }
    vm.runInContext(source, context, {filename: 'background.js'});

    return {
        context: context,
        state: state,
        flushSessionGets: () => {
            const pending = state.pendingSessionGets.splice(0);
            for (const invoke of pending) invoke();
        }
    };
}

// Claims a job the way a command does and hands back its id. Everything the
// command goes on to do quotes that id, and the background acts on nothing that
// does not - so a test that drives applyAction or prepareStyles by hand has to
// carry it too.
function claimJob(harness, tabId) {
    let jobId = null;
    harness.context.startJob(tabId, (id) => { jobId = id; });
    return jobId;
}

function messages(harness, predicate) {
    return harness.state.tabMessages.filter((entry) => predicate(entry.message));
}

function request(harness, value, sender) {
    const responses = [];
    const kept = harness.state.listeners.message[0](value, sender || {},
        (response) => responses.push(copy(response)));
    // what the listener returned, i.e. whether it asked to keep the message
    // channel open - hidden from the deepStrictEqual comparisons on the list
    Object.defineProperty(responses, 'kept', {value: kept});
    return responses;
}

function settle() {
    return new Promise((resolve) => setImmediate(resolve));
}

let failures = 0;
async function test(name, body) {
    try {
        await body();
        console.log('PASS ' + name);
    } catch (error) {
        failures++;
        console.log('FAIL ' + name + ' -- ' + error.message);
    }
}

(async () => {
    await test('jobs start with persisted timestamps and a busy badge', () => {
        const h = createHarness({now: 2500});
        const jobId = claimJob(h, 17);
        assert.deepStrictEqual(h.state.session.job, {
            jobId: jobId, tabId: 17, startedAt: 2500, lastHeartbeat: 2500, injectedCss: []
        });
        assert.deepStrictEqual(h.state.badgeColors, [{color: 'red'}]);
        assert.deepStrictEqual(h.state.badgeTexts, [{text: 'Busy'}]);
        // the clock alone cannot tell two jobs apart when they are claimed in the
        // same millisecond - which, with a stubbed Date.now(), is all of them
        assert.notStrictEqual(claimJob(h, 17), jobId);
    });

    await test('jobs finish by clearing state, badge, every injected sheet, and popup', async () => {
        const h = createHarness();
        const jobId = claimJob(h, 17);
        h.context.updateJob(jobId, {injectedCss: ['.theme { font-family: serif; }',
                                                  '.reader { color: black; }']});
        h.context.endJob(jobId);
        await settle();
        assert.strictEqual(h.state.session.job, undefined);
        assert.deepStrictEqual(h.state.badgeTexts.at(-1), {text: ''});
        // every sheet the job laid down, not just the last one: what is left
        // applied silently restyles the page the user is still looking at
        assert.deepStrictEqual(h.state.removedCss, [
            {target: {tabId: 17}, css: '.theme { font-family: serif; }'},
            {target: {tabId: 17}, css: '.reader { color: black; }'}
        ]);
        assert.deepStrictEqual(h.state.runtimeMessages.at(-1), {type: 'popup-close'});
    });

    // A job started by the previous release can still be in session storage when
    // the update lands, and that one recorded its one sheet as a bare string.
    await test('a job recorded before layered injection is still cleaned up', async () => {
        const h = createHarness({
            session: {job: {
                tabId: 5, startedAt: 1000, lastHeartbeat: 1000, injectedCss: '.old {}'
            }}
        });
        h.context.endJob();
        await settle();
        assert.deepStrictEqual(h.state.removedCss, [{target: {tabId: 5}, css: '.old {}'}]);
    });

    await test('timed-out jobs are reclaimed with the same cleanup as completion', async () => {
        const h = createHarness({
            now: 31000,
            session: {job: {
                tabId: 9, startedAt: 1000, lastHeartbeat: 1000, injectedCss: '.old {}'
            }}
        });
        let result = 'not called';
        h.context.getJob((job) => { result = job; });
        await settle();
        assert.strictEqual(result, null);
        assert.strictEqual(h.state.session.job, undefined);
        assert.deepStrictEqual(h.state.badgeTexts, [{text: ''}]);
        assert.deepStrictEqual(h.state.removedCss[0], {
            target: {tabId: 9}, css: '.old {}'
        });
    });

    // Reclaiming happens while the popup is opening and asking whether the
    // extension is busy: the answer is no, and it must not be followed by a
    // close request that shuts the popup the user has just opened.
    await test('a reclaimed job does not close the popup that reported it', async () => {
        const h = createHarness({
            now: 31000,
            session: {job: {
                tabId: 9, startedAt: 1000, lastHeartbeat: 1000, injectedCss: '.old {}'
            }}
        });
        assert.deepStrictEqual(request(h, {type: 'is busy?'}), [{isBusy: false}]);
        await settle();
        assert.strictEqual(h.state.session.job, undefined);
        assert.deepStrictEqual(
            h.state.runtimeMessages.filter((message) => message.type === 'popup-close'), []);

        h.context.endJob(claimJob(h, 9));
        await settle();
        assert.deepStrictEqual(h.state.runtimeMessages.at(-1), {type: 'popup-close'});
    });

    await test('heartbeats extend live jobs and cannot resurrect finished jobs', () => {
        const h = createHarness({now: 1000});
        const jobId = claimJob(h, 4);
        h.state.now = 29000;
        h.context.touchJob(jobId, {tab: {id: 4}});
        assert.strictEqual(h.state.session.job.lastHeartbeat, 29000);
        h.state.now = 58000;
        let live;
        h.context.getJob((job) => { live = job; });
        assert.strictEqual(live.tabId, 4);
        h.context.endJob(jobId);
        h.state.now = 59000;
        h.context.touchJob(jobId, {tab: {id: 4}});
        assert.strictEqual(h.state.session.job, undefined);
    });

    // The case the job id exists for. A job that stopped reporting is reclaimed
    // and replaced while its page is still working - same tab, so the tab alone
    // cannot tell the two apart - and everything that page says from then on is
    // about a job that is already over.
    await test('a reclaimed job cannot heartbeat, record css for, or finish its successor', async () => {
        const h = createHarness({now: 1000});
        const stale = claimJob(h, 7);

        h.state.now = 40000;
        let started;
        let live;
        h.context.tryStartJob(7, (ok, jobId) => { started = ok; live = jobId; });
        await settle();
        assert.strictEqual(started, true, 'the timed-out job was not reclaimed');
        assert.notStrictEqual(live, stale);
        h.context.updateJob(live, {injectedCss: ['.b {}']});

        // the old extraction is still downloading images and still says so
        h.state.now = 45000;
        request(h, {type: 'job-heartbeat', jobId: stale}, {tab: {id: 7}});
        assert.strictEqual(h.state.session.job.lastHeartbeat, 40000,
            'a reclaimed job extended the timeout of the job that replaced it');

        // and still finishes inserting the sheets it was asked for
        h.context.updateJob(stale, {injectedCss: ['.a {}']});
        assert.deepStrictEqual(h.state.session.job.injectedCss, ['.b {}'],
            'a reclaimed job overwrote the record of what is on the page now');

        // ... and then reports itself done, long after anything was waiting
        request(h, {type: 'done', jobId: stale}, {tab: {id: 7}});
        await settle();
        assert.strictEqual(h.state.session.job.jobId, live, 'a stale done ended the live job');
        assert.strictEqual(h.state.badgeTexts.at(-1).text, 'Busy');
        assert.deepStrictEqual(h.state.removedCss, [],
            'a stale done stripped the live job\'s stylesheet off the page');
        assert.deepStrictEqual(
            h.state.runtimeMessages.filter((message) => message.type === 'popup-close'), [],
            'a stale done closed the popup waiting on the live job');

        // the other half of the check: the right id from the wrong tab
        request(h, {type: 'done', jobId: live}, {tab: {id: 99}});
        await settle();
        assert.strictEqual(h.state.session.job.jobId, live);

        // and the job's own report ends it, with the cleanup it is owed
        request(h, {type: 'done', jobId: live}, {tab: {id: 7}});
        await settle();
        assert.strictEqual(h.state.session.job, undefined);
        assert.deepStrictEqual(h.state.removedCss, [{target: {tabId: 7}, css: '.b {}'}]);
    });

    // The chapter editor builds the same book through the same code, but nothing
    // claimed a job for it: it is an extension page, so its messages carry no tab
    // and no job id, and they are about nobody's job.
    await test('a build with no job behind it does not end a capture in progress', async () => {
        const h = createHarness();
        const jobId = claimJob(h, 7);
        request(h, {type: 'done'}, {});
        await settle();
        assert.strictEqual(h.state.session.job.jobId, jobId);
        assert.strictEqual(h.state.badgeTexts.at(-1).text, 'Busy');
    });

    await test('closing an unrelated tab preserves the job; closing its tab ends it', () => {
        const h = createHarness();
        h.context.startJob(7);
        h.state.listeners.tabRemoved[0](99);
        assert.strictEqual(h.state.session.job.tabId, 7);
        assert.strictEqual(h.state.badgeTexts.at(-1).text, 'Busy');
        h.state.listeners.tabRemoved[0](7);
        assert.strictEqual(h.state.session.job, undefined);
        assert.strictEqual(h.state.badgeTexts.at(-1).text, '');
    });

    await test('concurrent commands claim only one background job', async () => {
        const h = createHarness({deferSessionGets: true});
        h.context.executeCommand({type: 'save-page'});
        h.context.executeCommand({type: 'save-selection'});
        assert.strictEqual(messages(h, (m) => m.alert && m.alert.startsWith('Work in progress')).length, 1);
        h.flushSessionGets();
        // the styles are read before the extraction is asked for, and that read
        // reaches the catalog file
        await settle();
        assert.strictEqual(messages(h, (m) => /^extract-/.test(m.type || '')).length, 1);
        assert.strictEqual(messages(h, (m) => m.shortcut === 'build-ebook').length, 1);
        assert.strictEqual(h.state.session.job.tabId, 7);
    });

    await test('content scripts are pinged, injected when absent, and report injection failure', async () => {
        const ready = createHarness({pingResponse: {ready: true}});
        let readyResult;
        ready.context.ensureContentScripts(3, (ok) => { readyResult = ok; });
        assert.strictEqual(readyResult, true);
        assert.strictEqual(ready.state.executeScripts.length, 0);

        const absent = createHarness({pingResponse: undefined});
        let absentResult;
        absent.context.ensureContentScripts(3, (ok) => { absentResult = ok; });
        await settle();
        assert.strictEqual(absentResult, true);
        // Order is the assertion, not just membership: jszip and readability are
        // globals the scripts after them use at load time, and sanitizeHtml.js
        // defines the tag lists extractHtml.js reads while it loads.
        assert.deepStrictEqual(absent.state.executeScripts[0].files,
            ['libs/jszip.js', 'libs/readability.js', 'utils.js', 'cssSanitizer.js',
             'sanitizeHtml.js', 'extractHtml.js', 'saveEbook.js']);

        const denied = createHarness({pingResponse: undefined, executeScriptFailure: true});
        let deniedResult;
        denied.context.ensureContentScripts(3, (ok) => { deniedResult = ok; });
        await settle();
        assert.strictEqual(deniedResult, false);
    });

    await test('empty and missing extraction content end with the relevant alert', () => {
        for (const scenario of [
            {response: {content: '  \n '}, justAdd: false, text: 'Cannot generate'},
            {response: {title: 'No content'}, justAdd: true, text: 'Cannot add'}
        ]) {
            const h = createHarness({extractionResponse: scenario.response});
            h.context.applyAction([{id: 7}], 'extract-selection', scenario.justAdd, false, [],
                                  false, false, claimJob(h, 7));
            assert.strictEqual(h.state.session.job, undefined);
            assert.strictEqual(messages(h, (m) => (m.alert || '').startsWith(scenario.text)).length, 1);
        }
    });

    await test('an interrupted extraction ends the job and reports the site failure', () => {
        const h = createHarness({
            extractionResponse: undefined,
            interruptedExtraction: true
        });
        h.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, false,
                              claimJob(h, 7));
        assert.strictEqual(h.state.session.job, undefined);
        assert.strictEqual(messages(h,
            (m) => m.alert === 'Save as eBook does not work on this web site!').length, 1);
    });

    await test('successful extraction builds an ebook or appends one chapter', () => {
        const response = {title: 'A', content: '<p>chapter</p>'};
        const build = createHarness({extractionResponse: response});
        const buildJob = claimJob(build, 7);
        build.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, false,
                                  buildJob);
        assert.deepStrictEqual(messages(build, (m) => m.shortcut === 'build-ebook')[0].message.response,
            [response]);
        assert.strictEqual(build.state.session.job.tabId, 7);
        // the build was told which job it is finishing, so that the 'done' it
        // sends back cannot end a later one
        assert.strictEqual(messages(build, (m) => m.shortcut === 'build-ebook')[0].message.jobId,
            buildJob);

        const add = createHarness({extractionResponse: response, local: {allPages: []}});
        add.context.applyAction([{id: 7}], 'extract-page', true, false, [], false, false,
                                claimJob(add, 7));
        assert.deepStrictEqual(add.state.local.allPages, [response]);
        assert.strictEqual(add.state.session.job, undefined);
        assert.strictEqual(messages(add, (m) => m.alert === 'Page or selection added as chapter!').length, 1);
    });

    await test('review before saving buffers the one-shot save and opens the editor', async () => {
        const response = {title: 'Article', content: '<p>chapter</p>'};
        for (const action of ['extract-page', 'extract-selection']) {
            const h = createHarness({extractionResponse: response});
            h.context.applyAction([{id: 7}], action, false, false, [], false, true,
                                  claimJob(h, 7));
            await settle();
            // nothing was built or downloaded - the editor's own button does that
            assert.strictEqual(messages(h, (m) => m.shortcut === 'build-ebook').length, 0,
                action + ' built an ebook instead of stopping at the editor');
            assert.deepStrictEqual(h.state.local.allPages, [response]);
            // the page names the book, as the immediate build would have
            assert.strictEqual(h.state.local.title, 'Article');
            assert.deepStrictEqual(h.state.createdTabs,
                [{url: 'chrome-extension://save-as-ebook/chapters.html'}]);
            // the extraction is over: nothing is waiting on a 'done' that the
            // content script will never send
            assert.strictEqual(h.state.session.job, undefined);
        }

        // an untitled page is left to the editor's own fallback rather than
        // stored as a title of ''
        const untitled = createHarness({extractionResponse: {title: '  ', content: '<p>c</p>'}});
        untitled.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, true,
                                     claimJob(untitled, 7));
        assert.strictEqual(untitled.state.local.title, undefined);

        // and with the option off the save still downloads without touching the buffer
        const off = createHarness({extractionResponse: response});
        off.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, false,
                                claimJob(off, 7));
        assert.strictEqual(messages(off, (m) => m.shortcut === 'build-ebook').length, 1);
        assert.strictEqual(off.state.local.allPages, undefined);
        assert.deepStrictEqual(off.state.createdTabs, []);
    });

    await test('a reviewed save is a new book, not an addition to the buffered one', async () => {
        // The rule getBookId() states: a page saved on its own is a new book
        // every time. Storing it on the way to the editor must not let it
        // inherit the identifier - or the chapters - of the book before it.
        const h = createHarness({
            extractionResponse: {title: 'Article', content: '<p>chapter</p>'},
            local: {
                reviewBeforeSaving: true,
                allPages: [{title: 'an older chapter'}],
                uuid: 'the-previous-book',
                title: 'The Previous Book',
                bookCss: 'p{}',
                bookMetadata: {publisher: 'someone else'}
            },
            uuids: ['a-new-book']
        });
        h.context.dispatch([{id: 7, url: 'https://example.com/article'}], 'extract-page', false, [],
                           claimJob(h, 7));
        await settle();
        assert.deepStrictEqual(h.state.local.allPages,
            [{title: 'Article', content: '<p>chapter</p>'}]);
        assert.strictEqual(h.state.local.title, 'Article');
        assert.strictEqual(h.state.local.bookCss, undefined);
        assert.strictEqual(h.state.local.bookMetadata, undefined);
        assert.strictEqual(h.state.local.uuid, undefined,
            'the reviewed save kept the identifier of the book it replaced');
        assert.deepStrictEqual(request(h, {type: 'get uuid'}), [{uuid: 'a-new-book'}]);
        // the preference itself is not part of the book that was discarded
        assert.strictEqual(h.state.local.reviewBeforeSaving, true);
    });

    // The buffered book is work the user did by hand, one chapter at a time, and
    // a save used to discard it before anyone knew whether the save could even
    // run. Each scenario here is a command that ends without a chapter to put in
    // its place: the book has to still be there afterwards.
    await test('a save that never produces a chapter leaves the buffered book alone', async () => {
        const buffered = () => ({
            allPages: [{title: 'a chapter the user collected'}],
            title: 'The Book So Far',
            uuid: 'the-buffered-book',
            bookCss: 'p{}',
            bookMetadata: {publisher: 'the user'}
        });
        // every key clearEbook() takes, and only those: capturing also merges the
        // shipped style catalog into local storage, which is not part of the book
        const book = (h) => {
            const kept = {};
            for (const key of ['allPages', 'title', 'uuid', 'bookCss', 'bookMetadata']) {
                if (h.state.local[key] !== undefined) kept[key] = h.state.local[key];
            }
            return kept;
        };

        // a capture is already running, so the command is refused outright
        const busy = createHarness({
            local: buffered(),
            session: {job: {tabId: 9, startedAt: 1000, lastHeartbeat: 1000, injectedCss: []}}
        });
        busy.context.executeCommand({type: 'save-page'});
        await settle();
        assert.strictEqual(
            messages(busy, (m) => (m.alert || '').startsWith('Work in progress')).length, 1);
        assert.deepStrictEqual(book(busy), buffered(),
            'a refused command discarded the book the running one is not touching');

        // a chrome:// page, the web store, a pdf viewer: nothing can be injected,
        // so the command returns without ever claiming a job
        const restricted = createHarness({
            local: buffered(),
            pingResponse: undefined,
            executeScriptFailure: true
        });
        restricted.context.executeCommand({type: 'save-page'});
        await settle();
        await settle();
        assert.strictEqual(restricted.state.session.job, undefined);
        assert.strictEqual(messages(restricted, (m) => /^extract-/.test(m.type || '')).length, 0);
        assert.deepStrictEqual(book(restricted), buffered(),
            'a tab that cannot be captured cost the user the book');

        // the tab navigated mid-extraction and the content script went with it
        const interrupted = createHarness({
            local: buffered(),
            extractionResponse: undefined,
            interruptedExtraction: true
        });
        interrupted.context.executeCommand({type: 'save-page'});
        await settle();
        assert.strictEqual(messages(interrupted,
            (m) => m.alert === 'Save as eBook does not work on this web site!').length, 1);
        assert.deepStrictEqual(book(interrupted), buffered(),
            'an interrupted extraction discarded the book it never replaced');

        // nothing was selected - the failure is only discovered after extraction,
        // which is why it has to be the write that replaces the book and not the
        // command that starts it
        const empty = createHarness({
            local: buffered(),
            extractionResponse: {title: 'Article', content: '   \n '}
        });
        empty.context.executeCommand({type: 'save-selection'});
        await settle();
        assert.strictEqual(messages(empty,
            (m) => (m.alert || '').startsWith('Cannot generate')).length, 1);
        assert.deepStrictEqual(book(empty), buffered(),
            'an empty selection discarded the book it produced nothing to replace');

        // and the same empty selection on the way to the editor, where the
        // replacement is a storage write rather than a build
        const emptyReview = createHarness({
            local: Object.assign(buffered(), {reviewBeforeSaving: true}),
            extractionResponse: {title: 'Article', content: ''}
        });
        emptyReview.context.executeCommand({type: 'save-selection'});
        await settle();
        assert.deepStrictEqual(emptyReview.state.createdTabs, []);
        assert.deepStrictEqual(book(emptyReview), buffered());
        // the preference is not part of the book either way
        assert.strictEqual(emptyReview.state.local.reviewBeforeSaving, true);
    });

    // The popup starts spinning on the click and is taken out of it by the
    // background - normally by the popup-close that finishJob sends when the job
    // ends. A command refused before tryStartJob never claims a job, so there is
    // no finishJob to reach: without a message of its own the spinner ran until
    // the user dismissed the popup, over a save that was not happening. The
    // alerts these paths show go through the content script, which on a
    // restricted tab is the thing that is missing.
    await test('a command refused before a job exists tells the popup why', async () => {
        const failures = (h) => h.state.runtimeMessages.filter(
            (message) => message.type === 'popup-failed');

        // a chrome:// page, the web store, a pdf viewer, no activeTab grant
        const restricted = createHarness({pingResponse: undefined, executeScriptFailure: true});
        restricted.context.executeCommand({type: 'save-page'});
        await settle();
        await settle();
        assert.deepStrictEqual(failures(restricted),
            [{type: 'popup-failed', reason: 'restricted-tab'}]);
        assert.strictEqual(restricted.state.session.job, undefined);

        // a capture is already running: the page gets the alert, and the popup
        // waiting on the command that was turned away gets the same verdict -
        // the running job's popup-close is not about this popup
        const busy = createHarness({
            session: {job: {tabId: 9, startedAt: 1000, lastHeartbeat: 1000, injectedCss: []}}
        });
        busy.context.executeCommand({type: 'save-page'});
        await settle();
        assert.strictEqual(
            messages(busy, (m) => (m.alert || '').startsWith('Work in progress')).length, 1);
        assert.deepStrictEqual(failures(busy), [{type: 'popup-failed', reason: 'busy'}]);
        // the job it was refused for is still the one in storage
        assert.strictEqual(busy.state.session.job.tabId, 9);

        // no active tab to read at all
        const noTab = createHarness({tabs: []});
        noTab.context.executeCommand({type: 'save-page'});
        await settle();
        assert.deepStrictEqual(failures(noTab), [{type: 'popup-failed', reason: 'no-tab'}]);
        assert.strictEqual(noTab.state.executeScripts.length, 0);

        // and a command that does start says nothing: popup-close ends that one
        const running = createHarness({extractionResponse: {title: 'A', content: '<p>a</p>'}});
        running.context.executeCommand({type: 'save-page'});
        await settle();
        assert.deepStrictEqual(failures(running), []);
    });

    // The other half of the same rule: a capture that does produce a chapter
    // still starts a new book, so the next command must not find the old one.
    await test('a completed one-shot save replaces the buffered book', async () => {
        const response = {title: 'Article', content: '<p>chapter</p>'};
        const h = createHarness({
            local: {
                allPages: [{title: 'a chapter the user collected'}],
                title: 'The Book So Far',
                uuid: 'the-buffered-book',
                bookCss: 'p{}',
                bookMetadata: {publisher: 'the user'}
            },
            extractionResponse: response
        });
        h.context.executeCommand({type: 'save-page'});
        await settle();
        assert.deepStrictEqual(
            messages(h, (m) => m.shortcut === 'build-ebook')[0].message.response, [response]);
        for (const key of ['allPages', 'title', 'uuid', 'bookCss', 'bookMetadata']) {
            assert.strictEqual(h.state.local[key], undefined,
                'the save left ' + key + ' behind for the next book to inherit');
        }
    });

    await test('reader mode reaches a page extraction and never a selection', () => {
        const extractions = (h) => messages(h,
            (m) => m.type === 'extract-page' || m.type === 'extract-selection');

        for (const action of ['extract-page', 'extract-selection']) {
            const on = createHarness();
            on.context.applyAction([{id: 7}], action, true, false, [], true, false,
                                   claimJob(on, 7));
            assert.strictEqual(extractions(on)[0].message.readerMode,
                action === 'extract-page',
                action + ' was sent the wrong reader mode flag');
        }

        // The checkbox being off has to be sent as false rather than left out:
        // the content script reads the flag, it does not default it.
        const off = createHarness();
        off.context.applyAction([{id: 7}], 'extract-page', true, false, [], undefined, false,
                                claimJob(off, 7));
        assert.strictEqual(extractions(off)[0].message.readerMode, false);
    });

    await test('a reader mode fallback is reported and the page still saved', () => {
        const response = {title: 'A', content: '<p>chapter</p>', readerModeFailed: true};
        const h = createHarness({extractionResponse: response, local: {allPages: []}});
        h.context.applyAction([{id: 7}], 'extract-page', true, false, [], true, false,
                              claimJob(h, 7));
        assert.strictEqual(messages(h,
            (m) => (m.alert || '').startsWith('Readability.js found no article')).length, 1);
        // the point of the fallback: telling the user does not cost them the save
        assert.deepStrictEqual(h.state.local.allPages, [response]);

        const succeeded = createHarness({
            extractionResponse: {title: 'A', content: '<p>chapter</p>'},
            local: {allPages: []}
        });
        succeeded.context.applyAction([{id: 7}], 'extract-page', true, false, [], true, false,
                                      claimJob(succeeded, 7));
        assert.strictEqual(messages(succeeded,
            (m) => (m.alert || '').indexOf('Readability.js') > -1).length, 0);
    });

    // F-03: an image the content script could not download is removed from the
    // chapter, because a reference to a file that is not in the archive fails
    // the whole book. Removing it silently is what makes a capture that is
    // missing a picture indistinguishable from a page that never had one.
    await test('images left out of a capture are reported and the chapter still saved', () => {
        const response = {
            title: 'A', content: '<p>chapter</p>',
            droppedImages: [
                {url: 'https://cdn.example.com/a.png', reason: 'fetch'},
                {url: 'https://cdn.example.com/b.png', reason: 'fetch'}
            ]
        };
        const h = createHarness({extractionResponse: response, local: {allPages: []}});
        h.context.applyAction([{id: 7}], 'extract-page', true, false, [], false, false,
                              claimJob(h, 7));
        const warnings = messages(h, (m) => (m.alert || '').indexOf('could not be downloaded') > -1);
        assert.strictEqual(warnings.length, 1, 'the lost images were not reported');
        assert.ok(warnings[0].message.alert.indexOf('2 images') > -1,
                  'the warning did not say how many were lost: ' + warnings[0].message.alert);
        // same contract as the reader mode fallback: being told costs nothing
        assert.deepStrictEqual(h.state.local.allPages, [response]);

        const intact = createHarness({
            extractionResponse: {title: 'A', content: '<p>chapter</p>'},
            local: {allPages: []}
        });
        intact.context.applyAction([{id: 7}], 'extract-page', true, false, [], false, false,
                                   claimJob(intact, 7));
        assert.strictEqual(messages(intact,
            (m) => (m.alert || '').indexOf('could not be downloaded') > -1).length, 0,
            'a capture that lost nothing still warned');
    });

    // The wording is asserted separately from the plumbing above: it is the
    // whole product of this fix, and the reason a download failed is the part
    // the user can act on - a blocked cdn is not something they can fix, an
    // unsupported format tells them the picture was reachable but unusable.
    await test('the dropped-image warning names the count and the cause', () => {
        const h = createHarness();
        const describe = h.context.describeDroppedImages;
        const blocked = (n) => Array.from({length: n}, () => ({reason: 'fetch'}));

        assert.strictEqual(describe(undefined), null);
        assert.strictEqual(describe([]), null, 'an empty list is not a warning');

        const one = describe(blocked(1));
        assert.ok(one.indexOf('1 image ') > -1 && one.indexOf('was left out') > -1,
                  'a single lost image was described in the plural: ' + one);
        assert.ok(one.indexOf('image server did not allow') > -1, one);

        const many = describe(blocked(3));
        assert.ok(many.indexOf('3 images') > -1 && many.indexOf('were left out') > -1, many);

        const typed = describe([{reason: 'type'}, {reason: 'type'}]);
        assert.ok(typed.indexOf('format this extension cannot store') > -1 &&
                  typed.indexOf('did not allow') < 0,
                  'a format failure was blamed on the server: ' + typed);

        const mixed = describe([{reason: 'type'}, {reason: 'fetch'}]);
        assert.ok(mixed.indexOf('Some were not allowed') > -1, mixed);

        // reason is absent on records written before it existed, and unknown
        // reasons must not be silently counted as format failures
        assert.ok(describe([{url: 'x'}]).indexOf('image server did not allow') > -1);
    });

    // The v1 storage this reads is what every existing install has: the whole
    // path from that array to the sheets on the page is exercised here, because
    // a migration that only works on data written by the same release is a
    // migration that has not been tested.
    await test('matching styles are layered onto the page least specific first', async () => {
        const styles = [
            {title: 'Broken', url: '[', style: '.broken {}'},
            {title: 'Specific', url: 'example\\.com\\/articles\\/42', style: '.specific {}'},
            {title: 'General', url: 'example\\.com', style: '.general {}'},
            {title: 'Elsewhere', url: 'other\\.example\\.net', style: '.elsewhere {}'}
        ];
        const h = createHarness({local: {styles: styles}, deferSessionGets: true});
        const jobId = claimJob(h, 12);
        let applied;
        h.context.prepareStyles(
            [{id: 12, url: 'https://www.example.com/articles/42?print=1'}],
            [], jobId, (value) => { applied = value; });
        await settle();
        assert.strictEqual(applied, undefined,
            'action continued before the CSS cleanup record was persisted');
        h.flushSessionGets();

        // both matches go on, and the broad one first: the sheets are a cascade,
        // so the style written for the article has to be able to override the
        // one written for the site
        assert.deepStrictEqual(h.state.insertedCss, [
            {target: {tabId: 12}, css: '.general {}'},
            {target: {tabId: 12}, css: '.specific {}'}
        ]);
        assert.deepStrictEqual(applied.map((style) => style.title), ['General', 'Specific']);
        assert.deepStrictEqual(h.state.session.job.injectedCss, ['.general {}', '.specific {}']);

        // the v1 array is left where it is - it is the way back to the previous
        // release, and this release never writes it again
        assert.deepStrictEqual(h.state.local.styles, styles);
        assert.strictEqual(h.state.local.styleLibrary.version, 2);
        assert.deepStrictEqual(
            h.state.local.styleLibrary.entries.map((entry) => entry.title),
            ['Broken', 'Specific', 'General', 'Elsewhere']);
    });

    await test('themes lead, and a style that is switched off is not injected', async () => {
        const h = createHarness({
            deferSessionGets: true,
            local: {styleLibrary: {version: 2, entries: [
                {id: 'site-on', scope: 'site', css: '.on {}',
                 match: {type: 'domain', pattern: 'example.com'}},
                {id: 'site-off', scope: 'site', css: '.off {}', enabled: false,
                 match: {type: 'domain', pattern: 'example.com'}},
                {id: 'theme', scope: 'theme', css: '.theme {}'},
                {id: 'empty', scope: 'theme', css: '   '}
            ]}}
        });
        let applied;
        h.context.prepareStyles([{id: 3, url: 'https://example.com/a'}], [], claimJob(h, 3),
                                (value) => { applied = value; });
        await settle();
        h.flushSessionGets();
        assert.deepStrictEqual(h.state.insertedCss, [
            {target: {tabId: 3}, css: '.theme {}'},
            {target: {tabId: 3}, css: '.on {}'}
        ]);
    });

    // Hiding is not styling. An element with no box is not extracted at all, so a
    // preset that takes the banner, the ad slots and the comment thread off a page
    // does its work whether or not the page's own css is carried into the book -
    // and gating the injection on the checkbox made the cleanest capture the
    // extension can make, plain markup with the chrome removed, the one
    // combination it refused.
    await test('styles are injected for a capture made with Include Style off', async () => {
        const h = createHarness({
            local: {
                includeStyle: false,
                allPages: [],
                styleLibrary: {version: 2, entries: [
                    {id: 'cleanup', scope: 'theme', css: '.banner {display: none}'}
                ]}
            }
        });
        h.context.dispatch([{id: 9, url: 'https://example.com/a'}], 'extract-page', true, [],
                           claimJob(h, 9));
        await settle();
        assert.deepStrictEqual(h.state.insertedCss,
            [{target: {tabId: 9}, css: '.banner {display: none}'}]);

        // and the extraction is told which sheets went on: with the page's own css
        // left out, they are the whole of the chapter's stylesheet
        const extraction = messages(h, (m) => m.type === 'extract-page')[0].message;
        assert.strictEqual(extraction.includeStyle, false);
        assert.deepStrictEqual(extraction.appliedStyles.map((style) => style.id), ['cleanup']);
    });

    // The first sheet is refused - an activeTab grant that has lapsed, a tab
    // that navigated to a page the extension cannot touch - and the rest of the
    // capture still has to happen.
    await test('a sheet the tab refuses does not take the rest of the styles with it', async () => {
        const h = createHarness({
            insertCssFailure: true,
            local: {styleLibrary: {version: 2, entries: [
                {id: 'one', scope: 'theme', css: '.one {}'}
            ]}}
        });
        let applied = 'not called';
        h.context.prepareStyles([{id: 3, url: 'https://example.com/a'}], [], claimJob(h, 3),
                                (value) => { applied = value; });
        await settle();
        assert.deepStrictEqual(applied, []);
        assert.deepStrictEqual(h.state.session.job.injectedCss, [],
            'nothing went on the page, so there is nothing to take off it');
    });

    // Losing the job mid-insertion is the case with no second chance: endJob has
    // already run, so whatever went on the page after it is nobody's to remove
    // but this callback's.
    await test('styles inserted into a job that has already ended are taken off again', async () => {
        const h = createHarness({
            local: {styleLibrary: {version: 2, entries: [
                {id: 'one', scope: 'theme', css: '.one {}'},
                {id: 'two', scope: 'theme', css: '.two {}'}
            ]}}
        });
        // no startJob: nothing is in flight, so updateJob has nothing to record
        let applied = 'not called';
        h.context.prepareStyles([{id: 3, url: 'https://example.com/a'}], [], null,
                                (value) => { applied = value; });
        await settle();
        assert.deepStrictEqual(applied, []);
        assert.deepStrictEqual(h.state.removedCss, [
            {target: {tabId: 3}, css: '.one {}'},
            {target: {tabId: 3}, css: '.two {}'}
        ]);
    });

    await test('UUIDs persist for a book and reset when chapters are discarded', () => {
        const h = createHarness({uuids: ['first-id', 'second-id']});
        assert.deepStrictEqual(request(h, {type: 'get uuid'}), [{uuid: 'first-id'}]);
        assert.deepStrictEqual(request(h, {type: 'get uuid'}), [{uuid: 'first-id'}]);
        assert.strictEqual(h.state.uuidIndex, 1);
        request(h, {type: 'remove'});
        assert.strictEqual(h.state.local.uuid, undefined);
        assert.deepStrictEqual(request(h, {type: 'get uuid'}), [{uuid: 'second-id'}]);
    });

    await test('the book stylesheet persists for a book and is discarded with it', () => {
        const h = createHarness();
        assert.deepStrictEqual(request(h, {type: 'get book css'}), [{css: ''}],
            'a book nobody styled has an empty stylesheet, not a missing one');
        request(h, {type: 'set book css', css: 'body{font-family:serif}'});
        assert.deepStrictEqual(request(h, {type: 'get book css'}),
            [{css: 'body{font-family:serif}'}]);
        request(h, {type: 'remove'});
        assert.strictEqual(h.state.local.bookCss, undefined,
            'the stylesheet belongs to the discarded chapters');
        // the site styles are a different thing entirely and outlive any book
        request(h, {type: 'set style library', library: {version: 2, entries: [
            {id: 'a', title: 'a site', scope: 'site', css: 'p{}',
             match: {type: 'domain', pattern: 'a.example'}}
        ]}});
        request(h, {type: 'remove'});
        assert.deepStrictEqual(
            h.state.local.styleLibrary.entries.map((entry) => entry.title), ['a site']);
    });

    // The library page speaks the stored shape now, and is handed the bundled
    // catalog beside it - it needs to know what a fork can be reset to, and this
    // is the same file the read it just made was merged from.
    const testCatalog = {
        version: 1,
        entries: [
            {builtinId: 'wiki', title: 'Wikipedia Article', scope: 'site',
             match: {type: 'regex', pattern: 'wikipedia\\.org\\/wiki\\/'},
             css: '#mw-panel {display: none}', enabled: true, v1: true},
            {builtinId: 'serif', title: 'Serif Reading', scope: 'theme',
             match: {type: 'domain', pattern: ''},
             css: 'body {font-family: serif}', enabled: false}
        ]
    };

    await test('the library page is given the stored library and the catalog', async () => {
        // a v1 install: an untouched copy of the bundled style, and their own
        const h = createHarness({catalog: testCatalog, local: {styles: [
            {title: 'Wikipedia Article', url: 'wikipedia\\.org\\/wiki\\/',
             style: '#mw-panel {display: none}'},
            {title: 'Mine', url: 'my\\.example', style: 'p{}'}
        ]}});
        const responses = request(h, {type: 'get style library'});
        await settle();

        assert.strictEqual(responses.length, 1);
        assert.deepStrictEqual(h.state.fetches, ['chrome-extension://save-as-ebook/styles/catalog.json']);
        assert.deepStrictEqual(responses[0].library.entries.map((entry) => entry.title),
            ['Wikipedia Article', 'Mine', 'Serif Reading'],
            'the migration ran, and the catalog was merged over what it produced');
        assert.deepStrictEqual(responses[0].library.entries.map((entry) => entry.origin),
            ['builtin', 'user', 'builtin']);
        assert.deepStrictEqual(responses[0].catalog, testCatalog,
            'without this the page cannot offer to reset a fork');
        // and the result was stored, so the next read has nothing to migrate
        assert.deepStrictEqual(h.state.local.styleLibrary, responses[0].library);
    });

    await test('the catalog is read once however many times the library is', async () => {
        const h = createHarness({catalog: testCatalog});
        request(h, {type: 'get style library'});
        await settle();
        request(h, {type: 'get style library'});
        await settle();
        assert.strictEqual(h.state.fetches.length, 1,
            'it is a file that ships with the extension - it cannot change while the worker lives');
    });

    // A style the page saves is injected into real pages, so its shape is the
    // worker's business rather than the page's.
    await test('a library written by the page is normalized before it is stored', async () => {
        const h = createHarness();
        request(h, {type: 'set style library', library: {version: 2, entries: [
            null,
            {id: 'odd', scope: 'nonsense', enabled: 'yes', css: 'p{}',
             match: {type: 'invented', pattern: 7}}
        ], removedBuiltins: ['gone', 42]}});
        await settle();

        const stored = h.state.local.styleLibrary;
        assert.strictEqual(stored.entries.length, 1);
        assert.strictEqual(stored.entries[0].scope, 'site');
        assert.strictEqual(stored.entries[0].enabled, true);
        assert.deepStrictEqual(stored.entries[0].match, {type: 'regex', pattern: ''});
        assert.deepStrictEqual(stored.removedBuiltins, ['gone']);
    });

    // The bundled styles are a file on disk; the user's are in storage. A failure
    // to read the first must not be mistaken for a decision about the second.
    await test('a catalog that cannot be read leaves the stored library alone', async () => {
        const h = createHarness({
            catalogFailure: true,
            local: {styleLibrary: {version: 2, entries: [
                {id: 'fork', title: 'My Wikipedia', scope: 'site', css: 'p{}',
                 origin: 'user', builtinId: 'wiki', match: {type: 'domain', pattern: 'wikipedia.org'}}
            ], removedBuiltins: ['serif']}}
        });
        const responses = request(h, {type: 'get style library'});
        await settle();

        assert.deepStrictEqual(responses[0].library.entries.map((entry) => entry.id), ['fork']);
        assert.deepStrictEqual(responses[0].library.removedBuiltins, ['serif'],
            'an empty catalog is not the user deleting anything');
        assert.deepStrictEqual(responses[0].catalog, {entries: []});

        // and it is read again next time, rather than the worker being left
        // without the bundled styles until it restarts
        assert.strictEqual(h.state.fetches.length, 1);
        request(h, {type: 'get style library'});
        await settle();
        assert.strictEqual(h.state.fetches.length, 2);
    });

    // The one test that reads the file the extension actually ships: the path in
    // getURL, the json in it, and the merge all have to agree, and none of that
    // is exercised by a catalog written in this file.
    await test('the catalog the extension ships is read, merged and applied', async () => {
        const shipped = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'web-extension', 'styles', 'catalog.json'), 'utf8'));
        const h = createHarness({catalog: shipped, deferSessionGets: true});
        const responses = request(h, {type: 'get style library'});
        await settle();

        const entries = responses[0].library.entries;
        assert.deepStrictEqual(entries.map((entry) => entry.builtinId),
            h.context.catalogEntries(shipped).map((entry) => entry.builtinId),
            'a fresh install is what the catalog offers, in the order the catalog states');
        assert.ok(entries.length < shipped.entries.length,
            'the retired entries are in the file for the migration to match, not to be installed');
        assert.ok(entries.every((entry) => entry.origin === 'builtin'));
        assert.ok(entries.filter((entry) => entry.scope === 'theme')
                         .every((entry) => entry.enabled === false),
            'a style that applies to every capture cannot arrive switched on');

        async function stylesFor(url) {
            let applied;
            h.context.prepareStyles([{id: 4, url: url}], [], claimJob(h, 4),
                                    (value) => { applied = value; });
            await settle();
            h.flushSessionGets();
            return applied.map((entry) => entry.builtinId);
        }

        // nothing runs on a page by itself any more: the site presets were all
        // retired, and a theme has to be switched on
        assert.deepStrictEqual(await stylesFor('https://en.wikipedia.org/wiki/Book'), []);

        // and once one is, it reaches the page
        const library = responses[0].library;
        library.entries.find((entry) => entry.builtinId === 'theme-large-print').enabled = true;
        request(h, {type: 'set style library', library: library});
        await settle();
        assert.deepStrictEqual(await stylesFor('https://en.wikipedia.org/wiki/Book'),
                               ['theme-large-print']);
    });


    // Chrome tears the channel down when the listener returns, unless it
    // returned true - and then the sender's callback waits for a response that,
    // if the branch never sends one, only arrives as "the message channel closed
    // before a response was received". Both halves are asserted below: every
    // message is answered exactly once, and a branch that keeps the channel open
    // has answered by the time it settles.
    await test('each runtime message sends exactly one response', async () => {
        const cases = [
            {type: 'get'}, {type: 'set', pages: []}, {type: 'remove'},
            {type: 'get uuid'}, {type: 'get title'}, {type: 'set title', title: 'T'},
            {type: 'get book css'}, {type: 'set book css', css: 'p{}'},
            {type: 'get book metadata'}, {type: 'set book metadata', metadata: {}},
            {type: 'get style library'},
            {type: 'set style library', library: {version: 2, entries: []}},
            {type: 'get style snapshot'}, {type: 'clear style snapshot'},
            {type: 'get include style'}, {type: 'set include style', includeStyle: true},
            {type: 'get reader mode'}, {type: 'set reader mode', readerMode: true},
            {type: 'get review before saving'},
            {type: 'set review before saving', reviewBeforeSaving: true},
            {type: 'is busy?'}, {type: 'job-heartbeat'},
            {type: 'save-page'}, {type: 'save-selection'}, {type: 'add-page'},
            {type: 'add-selection'}, {type: 'done'}, {type: 'unknown'}
        ];
        for (const value of cases) {
            const h = createHarness();
            const responses = request(h, value, {tab: {id: 7}});
            const kept = responses.kept;
            const answeredBeforeReturning = responses.length;
            await settle();
            assert.strictEqual(responses.length, 1,
                value.type + ' sent ' + responses.length + ' responses');
            // a branch that lets the channel close must already have answered
            if (kept !== true) {
                assert.strictEqual(answeredBeforeReturning, 1,
                    value.type + ' closed the channel before responding');
            }
        }

        const empty = createHarness();
        assert.deepStrictEqual(request(empty, {type: 'get'}), [{allPages: []}]);
        const populated = createHarness({local: {allPages: [{title: 'one'}]}});
        assert.deepStrictEqual(request(populated, {type: 'get'}), [
            {allPages: [{title: 'one'}]}
        ]);
    });

    if (failures) process.exitCode = 1;
})();
