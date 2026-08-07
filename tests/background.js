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

    const uuids = options.uuids || ['uuid-1', 'uuid-2', 'uuid-3'];
    const context = {
        chrome: chrome,
        navigator: {userAgent: 'BackgroundUnitTest'},
        console: {log: (...args) => state.logs.push(args)},
        crypto: {randomUUID: () => uuids[state.uuidIndex++]},
        Date: {now: () => state.now},
        setTimeout: () => 1,
        clearTimeout: () => {}
    };
    vm.createContext(context);
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

function messages(harness, predicate) {
    return harness.state.tabMessages.filter((entry) => predicate(entry.message));
}

function request(harness, value, sender) {
    const responses = [];
    harness.state.listeners.message[0](value, sender || {},
        (response) => responses.push(copy(response)));
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
        h.context.startJob(17);
        assert.deepStrictEqual(h.state.session.job, {
            tabId: 17, startedAt: 2500, lastHeartbeat: 2500, injectedCss: null
        });
        assert.deepStrictEqual(h.state.badgeColors, [{color: 'red'}]);
        assert.deepStrictEqual(h.state.badgeTexts, [{text: 'Busy'}]);
    });

    await test('jobs finish by clearing state, badge, injected CSS, and popup', async () => {
        const h = createHarness();
        h.context.startJob(17);
        h.context.updateJob({injectedCss: '.reader { color: black; }'});
        h.context.endJob();
        await settle();
        assert.strictEqual(h.state.session.job, undefined);
        assert.deepStrictEqual(h.state.badgeTexts.at(-1), {text: ''});
        assert.deepStrictEqual(h.state.removedCss, [{
            target: {tabId: 17}, css: '.reader { color: black; }'
        }]);
        assert.deepStrictEqual(h.state.runtimeMessages.at(-1), {type: 'popup-close'});
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

        h.context.startJob(9);
        h.context.endJob();
        await settle();
        assert.deepStrictEqual(h.state.runtimeMessages.at(-1), {type: 'popup-close'});
    });

    await test('heartbeats extend live jobs and cannot resurrect finished jobs', () => {
        const h = createHarness({now: 1000});
        h.context.startJob(4);
        h.state.now = 29000;
        h.context.touchJob();
        assert.strictEqual(h.state.session.job.lastHeartbeat, 29000);
        h.state.now = 58000;
        let live;
        h.context.getJob((job) => { live = job; });
        assert.strictEqual(live.tabId, 4);
        h.context.endJob();
        h.state.now = 59000;
        h.context.touchJob();
        assert.strictEqual(h.state.session.job, undefined);
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

    await test('concurrent commands claim only one background job', () => {
        const h = createHarness({deferSessionGets: true});
        h.context.executeCommand({type: 'save-page'});
        h.context.executeCommand({type: 'save-selection'});
        assert.strictEqual(messages(h, (m) => m.alert && m.alert.startsWith('Work in progress')).length, 1);
        h.flushSessionGets();
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
            ['libs/jszip.js', 'libs/readability.js', 'utils.js', 'sanitizeHtml.js',
             'extractHtml.js', 'saveEbook.js']);

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
            h.context.startJob(7);
            h.context.applyAction([{id: 7}], 'extract-selection', scenario.justAdd, false, []);
            assert.strictEqual(h.state.session.job, undefined);
            assert.strictEqual(messages(h, (m) => (m.alert || '').startsWith(scenario.text)).length, 1);
        }
    });

    await test('an interrupted extraction ends the job and reports the site failure', () => {
        const h = createHarness({
            extractionResponse: undefined,
            interruptedExtraction: true
        });
        h.context.startJob(7);
        h.context.applyAction([{id: 7}], 'extract-page', false, false, []);
        assert.strictEqual(h.state.session.job, undefined);
        assert.strictEqual(messages(h,
            (m) => m.alert === 'Save as eBook does not work on this web site!').length, 1);
    });

    await test('successful extraction builds an ebook or appends one chapter', () => {
        const response = {title: 'A', content: '<p>chapter</p>'};
        const build = createHarness({extractionResponse: response});
        build.context.startJob(7);
        build.context.applyAction([{id: 7}], 'extract-page', false, false, []);
        assert.deepStrictEqual(messages(build, (m) => m.shortcut === 'build-ebook')[0].message.response,
            [response]);
        assert.strictEqual(build.state.session.job.tabId, 7);

        const add = createHarness({extractionResponse: response, local: {allPages: []}});
        add.context.startJob(7);
        add.context.applyAction([{id: 7}], 'extract-page', true, false, []);
        assert.deepStrictEqual(add.state.local.allPages, [response]);
        assert.strictEqual(add.state.session.job, undefined);
        assert.strictEqual(messages(add, (m) => m.alert === 'Page or selection added as chapter!').length, 1);
    });

    await test('review before saving buffers the one-shot save and opens the editor', async () => {
        const response = {title: 'Article', content: '<p>chapter</p>'};
        for (const action of ['extract-page', 'extract-selection']) {
            const h = createHarness({extractionResponse: response});
            h.context.startJob(7);
            h.context.applyAction([{id: 7}], action, false, false, [], false, true);
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
        untitled.context.startJob(7);
        untitled.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, true);
        assert.strictEqual(untitled.state.local.title, undefined);

        // and with the option off the save still downloads without touching the buffer
        const off = createHarness({extractionResponse: response});
        off.context.startJob(7);
        off.context.applyAction([{id: 7}], 'extract-page', false, false, [], false, false);
        assert.strictEqual(messages(off, (m) => m.shortcut === 'build-ebook').length, 1);
        assert.strictEqual(off.state.local.allPages, undefined);
        assert.deepStrictEqual(off.state.createdTabs, []);
    });

    await test('a reviewed save is a new book, not an addition to the buffered one', () => {
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
        h.context.startJob(7);
        h.context.dispatch([{id: 7, url: 'https://example.com/article'}], 'extract-page', false, []);
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

    await test('reader mode reaches a page extraction and never a selection', () => {
        const extractions = (h) => messages(h,
            (m) => m.type === 'extract-page' || m.type === 'extract-selection');

        for (const action of ['extract-page', 'extract-selection']) {
            const on = createHarness();
            on.context.startJob(7);
            on.context.applyAction([{id: 7}], action, true, false, [], true);
            assert.strictEqual(extractions(on)[0].message.readerMode,
                action === 'extract-page',
                action + ' was sent the wrong reader mode flag');
        }

        // The checkbox being off has to be sent as false rather than left out:
        // the content script reads the flag, it does not default it.
        const off = createHarness();
        off.context.startJob(7);
        off.context.applyAction([{id: 7}], 'extract-page', true, false, [], undefined);
        assert.strictEqual(extractions(off)[0].message.readerMode, false);
    });

    await test('a reader mode fallback is reported and the page still saved', () => {
        const response = {title: 'A', content: '<p>chapter</p>', readerModeFailed: true};
        const h = createHarness({extractionResponse: response, local: {allPages: []}});
        h.context.startJob(7);
        h.context.applyAction([{id: 7}], 'extract-page', true, false, [], true);
        assert.strictEqual(messages(h,
            (m) => (m.alert || '').startsWith('Readability.js found no article')).length, 1);
        // the point of the fallback: telling the user does not cost them the save
        assert.deepStrictEqual(h.state.local.allPages, [response]);

        const succeeded = createHarness({
            extractionResponse: {title: 'A', content: '<p>chapter</p>'},
            local: {allPages: []}
        });
        succeeded.context.startJob(7);
        succeeded.context.applyAction([{id: 7}], 'extract-page', true, false, [], true);
        assert.strictEqual(messages(succeeded,
            (m) => (m.alert || '').indexOf('Readability.js') > -1).length, 0);
    });

    await test('style matching skips invalid regexes and selects the longest match', async () => {
        const styles = [
            {title: 'Invalid', url: '[', style: '.invalid {}'},
            {title: 'General', url: 'example\\.com', style: '.general {}'},
            {title: 'Specific', url: 'example\\.com\\/articles\\/42', style: '.specific {}'}
        ];
        const h = createHarness({local: {styles: styles}, deferSessionGets: true});
        h.context.startJob(12);
        let applied;
        h.context.prepareStyles(
            [{id: 12, url: 'https://www.example.com/articles/42?print=1'}],
            true, [], (value) => { applied = value; });
        await settle();
        assert.strictEqual(applied, undefined,
            'action continued before the CSS cleanup record was persisted');
        h.flushSessionGets();
        assert.strictEqual(applied.length, 1);
        assert.strictEqual(applied[0].title, 'Specific');
        assert.deepStrictEqual(h.state.insertedCss, [{
            target: {tabId: 12}, css: '.specific {}'
        }]);
        assert.strictEqual(h.state.session.job.injectedCss, '.specific {}');
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
        // the per-site styles are a different thing entirely and outlive any book
        request(h, {type: 'set styles', styles: [{title: 'a site'}]});
        request(h, {type: 'remove'});
        assert.deepStrictEqual(h.state.local.styles, [{title: 'a site'}]);
    });

    await test('each runtime message sends at most one response', async () => {
        const cases = [
            {type: 'get'}, {type: 'set', pages: []}, {type: 'remove'},
            {type: 'get uuid'}, {type: 'get title'}, {type: 'set title', title: 'T'},
            {type: 'get book css'}, {type: 'set book css', css: 'p{}'},
            {type: 'get styles'}, {type: 'set styles', styles: []},
            {type: 'get current style'}, {type: 'set current style', currentStyle: 2},
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
            await settle();
            assert.ok(responses.length <= 1,
                value.type + ' sent ' + responses.length + ' responses');
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
