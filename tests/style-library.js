// The style library: the rule that decides which CSS runs on a url, and the
// migration that turns what v1 stored into the model that rule reads. Both are
// pure functions, so neither needs a browser or a DOM here.
//
//   node style-library.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Evaluated in this realm rather than in a vm sandbox: the file needs nothing a
// browser provides, and a sandbox would give everything it builds a different
// Array and Object prototype - which deepStrictEqual reports as a difference
// between two structures that are identical.
vm.runInThisContext(
    fs.readFileSync(path.join(__dirname, '..', 'web-extension', 'styleLibrary.js'), 'utf8'),
    {filename: 'styleLibrary.js'}
);
const lib = globalThis;

let failures = 0;
function test(name, body) {
    try {
        body();
        console.log('PASS ' + name);
    } catch (error) {
        failures++;
        console.log('FAIL ' + name + ' -- ' + error.message);
    }
}

// A library of {id, css} pairs plus whatever the case is about, run through the
// normalizer so that the tests state only what they are testing.
function library(entries) {
    return lib.normalizeStyleLibrary({
        version: lib.STYLE_LIBRARY_VERSION,
        entries: entries.map((entry, index) => Object.assign(
            {id: entry.id || 'e' + index, css: '.' + (entry.id || 'e' + index) + ' {}'},
            entry))
    });
}

function selected(url, entries) {
    return lib.selectStylesForUrl(url, library(entries)).map((entry) => entry.id);
}

function siteEntry(id, type, pattern, extra) {
    return Object.assign({id: id, scope: 'site', match: {type: type, pattern: pattern}},
                         extra || {});
}

// ---- match types ----------------------------------------------------------

test('a domain matches its host and its subdomains, and nothing else', () => {
    const entries = [siteEntry('d', 'domain', 'example.com')];
    for (const url of ['https://example.com/', 'http://example.com/a/b?c=1',
                       'https://www.example.com/a', 'https://news.example.com/a',
                       'https://a.b.example.com/', 'https://example.com:8443/a',
                       'EXAMPLE.COM/Article']) {
        assert.deepStrictEqual(selected(url, entries), ['d'], url);
    }
    for (const url of ['https://example.com.evil.test/', 'https://notexample.com/',
                       'https://example.org/', 'https://example.com.br/']) {
        assert.deepStrictEqual(selected(url, entries), [], url);
    }
});

test('a whole url pasted into a domain box still names the domain', () => {
    assert.deepStrictEqual(
        selected('https://news.example.com/a',
                 [siteEntry('d', 'domain', 'https://www.example.com/section/')]),
        ['d']);
});

test('a prefix matches from the start of the url, scheme and www aside', () => {
    const entries = [siteEntry('p', 'prefix', 'example.com/docs/')];
    assert.deepStrictEqual(selected('https://www.example.com/docs/intro', entries), ['p']);
    assert.deepStrictEqual(selected('http://example.com/docs/', entries), ['p']);
    assert.deepStrictEqual(selected('https://example.com/blog/docs/', entries), []);
    // the text is a prefix, not a pattern - a * in it is a *
    assert.deepStrictEqual(
        selected('https://example.com/docs/a', [siteEntry('p', 'prefix', 'example.com/*/')]), []);
});

test('a glob is a prefix with * in it, and ? is left as a url character', () => {
    assert.deepStrictEqual(
        selected('https://reddit.com/r/books/comments/abc123/a_title',
                 [siteEntry('g', 'glob', 'reddit.com/r/*/comments')]),
        ['g'], 'a glob is open at the end');
    assert.deepStrictEqual(
        selected('https://reddit.com/r/books/', [siteEntry('g', 'glob', 'reddit.com/r/*/comments')]),
        []);
    assert.deepStrictEqual(
        selected('https://example.com/?page=2', [siteEntry('g', 'glob', 'example.com/?page=2')]),
        ['g'], 'a ? in a glob is a question mark');
    assert.deepStrictEqual(
        selected('https://example.com/xpage=2', [siteEntry('g', 'glob', 'example.com/?page=2')]),
        []);
});

test('a regex is tested unanchored against the url without its scheme', () => {
    const entries = [siteEntry('r', 'regex', 'wikipedia\\.org\\/wiki\\/')];
    assert.deepStrictEqual(selected('https://en.wikipedia.org/wiki/Book', entries), ['r']);
    assert.deepStrictEqual(selected('https://en.wikipedia.org/w/index.php', entries), []);
    // the scheme is gone before the pattern sees the url, which is what every
    // style written against v1 was written for
    assert.deepStrictEqual(
        selected('https://example.com/a', [siteEntry('r', 'regex', '^example\\.com')]), ['r']);
});

test('a pattern that does not compile matches nothing', () => {
    // half a regex is what the box holds while it is being typed - it must not
    // mean "every page"
    assert.deepStrictEqual(selected('https://example.com/', [siteEntry('r', 'regex', '[')]), []);
    assert.deepStrictEqual(selected('https://example.com/', [siteEntry('r', 'regex', '')]), []);
    assert.deepStrictEqual(selected('https://example.com/', [siteEntry('d', 'domain', '  ')]), []);
});

test('an unusable url matches no site style but still takes the themes', () => {
    const entries = [siteEntry('s', 'domain', 'example.com'), {id: 't', scope: 'theme'}];
    assert.deepStrictEqual(selected('', entries), ['t']);
    assert.deepStrictEqual(selected(null, entries), ['t']);
});

// ---- what gets selected ---------------------------------------------------

test('styles that are switched off, empty, or for another site are skipped', () => {
    assert.deepStrictEqual(selected('https://example.com/a', [
        siteEntry('off', 'domain', 'example.com', {enabled: false}),
        siteEntry('blank', 'domain', 'example.com', {css: '  \n '}),
        siteEntry('elsewhere', 'domain', 'other.test'),
        siteEntry('on', 'domain', 'example.com'),
        {id: 'themeOff', scope: 'theme', enabled: false}
    ]), ['on']);
});

// ---- ordering -------------------------------------------------------------

test('themes lead and site styles follow, least specific first', () => {
    assert.deepStrictEqual(selected('https://example.com/docs/intro/page', [
        siteEntry('long', 'prefix', 'example.com/docs/intro'),
        siteEntry('host', 'domain', 'example.com'),
        {id: 'theme', scope: 'theme'},
        siteEntry('short', 'prefix', 'example.com/docs')
    ]), ['theme', 'host', 'short', 'long']);
});

test('a domain is broader than a path rule that spells out the same host', () => {
    assert.deepStrictEqual(selected('https://example.com/', [
        siteEntry('prefix', 'prefix', 'example.com'),
        siteEntry('domain', 'domain', 'example.com')
    ]), ['domain', 'prefix']);
});

test('priority breaks a specificity tie, and storage order breaks that', () => {
    assert.deepStrictEqual(selected('https://example.com/a', [
        siteEntry('third', 'domain', 'example.com', {priority: 5}),
        siteEntry('first', 'domain', 'example.com'),
        siteEntry('second', 'domain', 'example.com')
    ]), ['first', 'second', 'third']);
    assert.deepStrictEqual(selected('https://example.com/a', [
        {id: 'late', scope: 'theme', priority: 1},
        {id: 'early', scope: 'theme'}
    ]), ['early', 'late']);
});

// ---- the v1 -> v2 migration -----------------------------------------------

const builtins = [
    {builtinId: 'wiki', title: 'Wikipedia Article', url: 'wikipedia\\.org\\/wiki\\/',
     style: '#mw-panel {display: none}'},
    {builtinId: 'hn', title: 'YCombinator News Comments', url: 'news\\.ycombinator\\.com',
     style: '.votearrow {display: none}'}
];

function migrate(stored, legacy) {
    return lib.migrateStyleLibrary(stored, legacy, builtins);
}

test('an install that never opened the editor starts from the bundled styles', () => {
    const result = migrate(null, undefined);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.library.version, 2);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.builtinId),
                           ['wiki', 'hn']);
    assert.ok(result.library.entries.every((entry) => entry.origin === 'builtin'));
    assert.ok(result.library.entries.every((entry) => entry.enabled === true));
    assert.deepStrictEqual(result.library.removedBuiltins, []);
});

test('a v1 style becomes an enabled site style matched by the regex it always was', () => {
    const result = migrate(null, [
        {title: 'Mine', url: 'my\\.example\\/notes', style: '.ad {display:none}'}
    ]);
    const entry = result.library.entries[0];
    assert.strictEqual(entry.title, 'Mine');
    assert.strictEqual(entry.scope, 'site');
    assert.deepStrictEqual(entry.match, {type: 'regex', pattern: 'my\\.example\\/notes'});
    assert.strictEqual(entry.css, '.ad {display:none}');
    assert.strictEqual(entry.enabled, true);
    assert.strictEqual(entry.origin, 'user');
    assert.ok(entry.id);
    // and it still matches what it matched under v1
    assert.deepStrictEqual(
        lib.selectStylesForUrl('https://my.example/notes/1', result.library)
               .map((style) => style.title),
        ['Mine']);
});

// The v1 defaults were a fallback for a missing key, so the first save wrote
// copies of them into the user's own array. Reading those back as five styles
// the user wrote would leave the catalog with no way to tell what it may
// update - and would show every one of them twice once it merges.
test('stored copies of the bundled styles are recognized as the bundled styles', () => {
    const result = migrate(null, [
        Object.assign({}, builtins[0]),
        {title: 'Mine', url: 'my\\.example', style: 'p{}'}
    ]);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.origin),
                           ['builtin', 'user']);
    assert.strictEqual(result.library.entries[0].builtinId, 'wiki');
    // the one the user has not got is one the user deleted
    assert.deepStrictEqual(result.library.removedBuiltins, ['hn']);
});

test('an edited copy of a bundled style is a fork that can still be reset', () => {
    const result = migrate(null, [
        Object.assign({}, builtins[0], {style: '#mw-panel {display: none} p {color: red}'})
    ]);
    assert.strictEqual(result.library.entries[0].origin, 'user',
        'the user\'s edit would be overwritten by the next catalog update');
    assert.strictEqual(result.library.entries[0].builtinId, 'wiki');
});

test('a second style under a bundled name is the user\'s, not a second built-in', () => {
    const result = migrate(null, [
        Object.assign({}, builtins[0]),
        Object.assign({}, builtins[0], {style: 'p{}'})
    ]);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.builtinId),
                           ['wiki', null]);
});

test('an emptied v1 array migrates to an empty library, not back to the defaults', () => {
    const result = migrate(null, []);
    assert.deepStrictEqual(result.library.entries, []);
    assert.deepStrictEqual(result.library.removedBuiltins, ['wiki', 'hn']);
});

test('an already migrated library is used as it is and not rewritten', () => {
    const stored = library([siteEntry('kept', 'domain', 'example.com')]);
    const result = migrate(stored, [{title: 'stale v1', url: 'a', style: 'p{}'}]);
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.id), ['kept']);
});

test('a library from a later release is read but left alone', () => {
    const result = migrate({version: 99, entries: [
        {id: 'future', scope: 'site', css: 'p{}', match: {type: 'domain', pattern: 'example.com'}}
    ]}, null);
    assert.strictEqual(result.changed, false, 'this version would write its shape over a newer one');
    assert.strictEqual(result.library.version, 99);
    assert.deepStrictEqual(
        lib.selectStylesForUrl('https://example.com/', result.library)
               .map((entry) => entry.id), ['future']);
});

test('junk in storage is replaced field by field rather than trusted', () => {
    const result = migrate({version: 2, entries: [
        null,
        'not an entry',
        {id: 'dup', css: 'p{}'},
        {id: 'dup', css: 'p{}'},
        {id: 'odd', scope: 'nonsense', enabled: 'yes', priority: 'high',
         origin: 'nowhere', match: {type: 'invented', pattern: 7}, tags: 'none'}
    ]}, null);
    const entries = result.library.entries;
    assert.strictEqual(entries.length, 3, 'entries that are not objects are dropped');
    assert.notStrictEqual(entries[0].id, entries[1].id, 'a duplicate id makes an edit ambiguous');
    const odd = entries[2];
    assert.strictEqual(odd.scope, 'site', 'an unreadable scope must not become a theme');
    assert.strictEqual(odd.enabled, true);
    assert.strictEqual(odd.priority, 0);
    assert.strictEqual(odd.origin, 'user');
    assert.deepStrictEqual(odd.match, {type: 'regex', pattern: ''});
    assert.deepStrictEqual(odd.tags, []);
});

// ---- the bundled catalog ---------------------------------------------------
//
// The catalog is a file that ships with the extension and is merged over the
// stored library on every read. What has to be right is that the merge can add
// to a library without being able to lose anything in it: a bundled style the
// user edited, one they deleted, and one they switched off all have to survive a
// release that ships a new catalog.

const catalog = {
    version: 1,
    entries: [
        // the two that shipped before there was a library
        {builtinId: 'wiki', title: 'Wikipedia Article', description: 'the article only',
         scope: 'site', match: {type: 'regex', pattern: 'wikipedia\\.org\\/wiki\\/'},
         css: '#mw-panel {display: none}', enabled: true, tags: ['site'], v1: true},
        {builtinId: 'hn', title: 'YCombinator News Comments', scope: 'site',
         match: {type: 'regex', pattern: 'news\\.ycombinator\\.com'},
         css: '.votearrow {display: none}', enabled: true, v1: true},
        // added by a later release
        {builtinId: 'gh', title: 'GitHub', scope: 'site',
         match: {type: 'domain', pattern: 'github.com'},
         css: '.AppHeader {display: none}', enabled: true},
        {builtinId: 'serif', title: 'Serif Reading', scope: 'theme',
         match: {type: 'domain', pattern: ''},
         css: 'body {font-family: serif}', enabled: false}
    ]
};

function merge(entries, removedBuiltins) {
    const stored = lib.normalizeStyleLibrary({
        version: lib.STYLE_LIBRARY_VERSION,
        entries: entries,
        removedBuiltins: removedBuiltins || []
    });
    return lib.mergeCatalogIntoLibrary(stored, catalog);
}

function builtinEntry(builtinId, extra) {
    const source = catalog.entries.find((entry) => entry.builtinId === builtinId);
    return Object.assign(lib.entryFromCatalogEntry(source), extra || {});
}

test('the migration is only shown the bundled styles that existed in v1', () => {
    assert.deepStrictEqual(lib.catalogToV1Builtins(catalog), [
        {builtinId: 'wiki', title: 'Wikipedia Article',
         url: 'wikipedia\\.org\\/wiki\\/', style: '#mw-panel {display: none}'},
        {builtinId: 'hn', title: 'YCombinator News Comments',
         url: 'news\\.ycombinator\\.com', style: '.votearrow {display: none}'}
    ], 'a style added after v1 cannot have a v1 copy, and passing it in as one ' +
       'would read every library as having deleted it');
});

test('an entry with no builtinId is not part of the catalog at all', () => {
    const result = lib.mergeCatalogIntoLibrary(lib.normalizeStyleLibrary(null),
        {entries: [{title: 'nameless', scope: 'site', css: 'p{}'}, null, 'junk']});
    assert.deepStrictEqual(result.library.entries, [],
        'nothing identifies it across releases, so it would be added again on every read');
});

test('a fresh library takes the whole catalog, with themes switched off', () => {
    const result = merge([]);
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.builtinId),
                           ['wiki', 'hn', 'gh', 'serif']);
    assert.ok(result.library.entries.every((entry) => entry.origin === 'builtin'));
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.enabled),
                           [true, true, true, false],
        'a style that applies to every capture has to be asked for');
    assert.strictEqual(result.library.entries[0].description, 'the article only');
});

test('the catalog is merged into what the v1 migration left behind', () => {
    // a user who saved a style: their array holds copies of the v1 defaults, one
    // of which they deleted, plus their own
    const migrated = lib.migrateStyleLibrary(null, [
        {title: 'Wikipedia Article', url: 'wikipedia\\.org\\/wiki\\/',
         style: '#mw-panel {display: none}'},
        {title: 'Mine', url: 'my\\.example', style: 'p{}'}
    ], lib.catalogToV1Builtins(catalog));
    const result = lib.mergeCatalogIntoLibrary(migrated.library, catalog);

    assert.deepStrictEqual(result.library.entries.map((entry) => entry.title),
                           ['Wikipedia Article', 'Mine', 'GitHub', 'Serif Reading']);
    assert.deepStrictEqual(result.library.removedBuiltins, ['hn'],
        'the one they deleted stays deleted');
});

test('a style the user deleted is not handed back by the merge', () => {
    const result = merge([], ['gh', 'serif']);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.builtinId),
                           ['wiki', 'hn']);
});

test('a bundled style nobody has edited is refreshed from the catalog', () => {
    // what a previous release stored, switched off and moved down the library
    const result = merge([
        {id: 'own', scope: 'site', css: '.own {}', match: {type: 'domain', pattern: 'a.test'}},
        builtinEntry('gh', {title: 'GitHub (old)', css: '.old-header {display: none}',
                            enabled: false, priority: 5})
    ]);
    const refreshed = result.library.entries.find((entry) => entry.builtinId === 'gh');

    assert.strictEqual(result.changed, true);
    assert.strictEqual(refreshed.css, '.AppHeader {display: none}',
        'a bundled style is how the extension fixes one when a site changes');
    assert.strictEqual(refreshed.title, 'GitHub');
    assert.strictEqual(refreshed.enabled, false, 'switching it off is the user\'s answer, not the catalog\'s');
    assert.strictEqual(refreshed.priority, 5);
    assert.deepStrictEqual(result.library.entries.map((entry) => entry.id),
                           ['own', 'builtin-gh', 'builtin-wiki', 'builtin-hn', 'builtin-serif'],
        'it stays where it was, and what points at it still does');
});

test('a fork of a bundled style shadows the catalog instead of being overwritten', () => {
    const result = merge([
        builtinEntry('gh', {origin: 'user', css: '.mine {display: none}', title: 'My GitHub'})
    ]);
    const forks = result.library.entries.filter((entry) => entry.builtinId === 'gh');
    assert.strictEqual(forks.length, 1, 'the catalog copy would be a second GitHub style');
    assert.strictEqual(forks[0].css, '.mine {display: none}');
    assert.strictEqual(forks[0].title, 'My GitHub');
});

test('merging the same catalog again changes nothing', () => {
    const once = merge([]);
    const twice = lib.mergeCatalogIntoLibrary(once.library, catalog);
    assert.strictEqual(twice.changed, false,
        'every read merges, so a merge that always changed something would write on every read');
    assert.deepStrictEqual(twice.library, once.library);
});

test('a library from a later release is not merged into', () => {
    const stored = lib.normalizeStyleLibrary({version: 99, entries: [], removedBuiltins: []});
    const result = lib.mergeCatalogIntoLibrary(stored, catalog);
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.library.entries, [],
        'a newer release may have retired a style this one still ships');
});

// ---- resetting, duplicating, saving and deleting ---------------------------

test('resetting a fork gives back the bundled style, where it was and as it was set', () => {
    const fork = lib.normalizeStyleEntry(builtinEntry('gh', {
        origin: 'user', css: '.mine {}', title: 'My GitHub', enabled: false, priority: 2
    }));
    const restored = lib.resetEntryToBuiltin(fork, catalog);

    assert.strictEqual(restored.origin, 'builtin');
    assert.strictEqual(restored.css, '.AppHeader {display: none}');
    assert.strictEqual(restored.title, 'GitHub');
    assert.strictEqual(restored.id, fork.id);
    assert.strictEqual(restored.enabled, false);
    assert.strictEqual(restored.priority, 2);
});

test('a style with nothing to go back to cannot be reset', () => {
    assert.strictEqual(lib.resetEntryToBuiltin(
        lib.normalizeStyleEntry({id: 'a', css: 'p{}'}), catalog), null,
        'the user wrote it themselves');
    assert.strictEqual(lib.resetEntryToBuiltin(
        lib.normalizeStyleEntry({id: 'a', css: 'p{}', builtinId: 'retired'}), catalog), null,
        'the catalog no longer ships it');
});

test('a duplicate is the user\'s own style, not a second claim on a built-in', () => {
    const copy = lib.duplicateStyleEntry(builtinEntry('gh'), 'GitHub (copy)');
    assert.strictEqual(copy.origin, 'user');
    assert.strictEqual(copy.builtinId, null,
        'two entries able to reset to one built-in would both be refreshed by the merge');
    assert.strictEqual(copy.title, 'GitHub (copy)');
    assert.notStrictEqual(copy.id, 'builtin-gh');
    assert.strictEqual(copy.css, '.AppHeader {display: none}');
});

test('a new style is the user\'s, is on, and matches nothing yet', () => {
    const entry = lib.newStyleEntry('site');
    assert.strictEqual(entry.scope, 'site');
    assert.strictEqual(entry.origin, 'user');
    assert.strictEqual(entry.enabled, true);
    assert.deepStrictEqual(entry.match, {type: 'domain', pattern: ''});
    assert.deepStrictEqual(lib.selectStylesForUrl('https://example.com/',
        lib.normalizeStyleLibrary({entries: [entry]})), [],
        'an empty pattern must not be an empty style applied everywhere');
    assert.strictEqual(lib.newStyleEntry('theme').scope, 'theme');
});

test('saving an edit to a bundled style forks it; switching it off does not', () => {
    const before = lib.normalizeStyleLibrary({entries: [builtinEntry('gh')]});

    const toggled = lib.putStyleEntry(before,
        Object.assign({}, before.entries[0], {enabled: false}));
    assert.strictEqual(toggled.entries[0].origin, 'builtin',
        'a style switched off is still the bundled style, and still gets fixed by an update');

    const edited = lib.putStyleEntry(before,
        Object.assign({}, before.entries[0], {css: '.mine {}'}));
    assert.strictEqual(edited.entries[0].origin, 'user');
    assert.strictEqual(edited.entries[0].builtinId, 'gh', 'and can still be reset');
    assert.ok(edited.entries[0].updatedAt > 0);
    assert.strictEqual(edited.entries.length, 1, 'an edit replaces the style, it does not add one');
});

test('saving a style that is not in the library adds it', () => {
    const entry = lib.newStyleEntry('site');
    const after = lib.putStyleEntry(lib.normalizeStyleLibrary(null), entry);
    assert.deepStrictEqual(after.entries.map((existing) => existing.id), [entry.id]);
});

test('deleting a bundled style remembers it; deleting your own does not', () => {
    const before = lib.normalizeStyleLibrary({
        entries: [builtinEntry('gh'), {id: 'own', css: 'p{}'}]
    });

    const withoutBuiltin = lib.removeStyleEntry(before, 'builtin-gh');
    assert.deepStrictEqual(withoutBuiltin.entries.map((entry) => entry.id), ['own']);
    assert.deepStrictEqual(withoutBuiltin.removedBuiltins, ['gh'],
        'the merge would hand it back on the next read');

    const withoutOwn = lib.removeStyleEntry(before, 'own');
    assert.deepStrictEqual(withoutOwn.entries.map((entry) => entry.id), ['builtin-gh']);
    assert.deepStrictEqual(withoutOwn.removedBuiltins, []);

    assert.deepStrictEqual(lib.removeStyleEntry(before, 'no such id').entries.length, 2);
});

// ---- the catalog that actually ships --------------------------------------

test('styles/catalog.json says what the merge and the library UI expect of it', () => {
    const shipped = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'web-extension', 'styles', 'catalog.json'), 'utf8'));
    const entries = lib.catalogEntries(shipped);

    assert.strictEqual(entries.length, shipped.entries.length,
        'an entry without a builtinId is silently ignored by the merge');
    assert.strictEqual(new Set(entries.map((entry) => entry.builtinId)).size, entries.length,
        'two entries under one builtinId would fight over the same library slot');

    for (const entry of entries) {
        const where = entry.builtinId;
        assert.ok(entry.title && entry.title.trim() !== '', where + ' has no title');
        assert.ok(entry.description && entry.description.trim() !== '',
            where + ' has no description - the library shows one for every style');
        assert.ok(entry.css && entry.css.trim() !== '', where + ' has no css, so it would never be injected');
        assert.ok(['site', 'theme'].indexOf(entry.scope) > -1, where + ' has an odd scope');
        assert.ok(lib.STYLE_MATCH_TYPES.indexOf(entry.match.type) > -1, where + ' has an odd match type');

        if (entry.scope === 'site') {
            assert.ok(entry.match.pattern.trim() !== '', where + ' is a site style with no pattern');
            assert.strictEqual(entry.enabled, true, where + ' ships off, so nobody would find it');
            if (entry.match.type === 'regex') {
                assert.ok(new RegExp(entry.match.pattern), where + ' has a pattern that does not compile');
            }
        } else {
            assert.strictEqual(entry.enabled, false,
                where + ' applies to every capture, so it cannot ship switched on');
        }
    }

    // The five v1 styles are recognized by their text, so this is the guard on
    // editing them: change one and every untouched copy in the wild becomes a
    // fork that no update can ever fix.
    assert.deepStrictEqual(entries.filter((entry) => entry.v1).map((entry) => entry.builtinId),
        ['reddit-comments', 'wikipedia-article', 'hn-comments', 'medium-article', 'twitter']);
});

console.log(failures === 0 ? '\nstyle library OK' : '\n' + failures + ' style library failure(s)');
process.exit(failures === 0 ? 0 : 1);
