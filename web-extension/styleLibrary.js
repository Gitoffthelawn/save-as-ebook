// The style library: what the extension knows about the CSS it injects into a
// page while that page is being captured, and the rule that decides which of it
// runs on a given url.
//
// Loaded into the service worker - Chrome imports it from background.js,
// Firefox lists it in background.scripts - so that "what applies to this url"
// has one answer instead of one per caller. Nothing here touches chrome.* or the
// DOM: the matcher and the migration are the two things that have to be right,
// and both are testable on their own.

// Bumped when the stored shape changes. A library written by a later version is
// read as best it can be but never rewritten - see migrateStyleLibrary.
var STYLE_LIBRARY_VERSION = 2;

// How a style says which pages it belongs to:
//   domain - a host and its subdomains
//   prefix - the url starts with this text
//   glob   - prefix, with * standing for any run of characters
//   regex  - the escape hatch, and what every style written before v2 was
var STYLE_MATCH_TYPES = ['domain', 'prefix', 'glob', 'regex'];

var STYLE_ORIGINS = ['builtin', 'user', 'imported'];

// Ids only have to be unique within one user's library, and they are minted one
// at a time by a person clicking a button - crypto is not needed for that, and
// this way the service worker's uuid supply is left for the ebooks that need it.
function newStyleId() {
    return 'sty-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).substring(2, 10);
}

// The form every pattern is matched against: no scheme, no leading "www.",
// lowercase. Styles have always been written against this shape - the v1 matcher
// stripped the same two things - so a migrated regex keeps matching what it
// matched before. It also means a pattern cannot anchor on the scheme, which is
// worth knowing before writing one.
function normalizeUrlForMatch(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    return url.trim()
              .replace(/^[a-z][a-z0-9+.\-]*:\/\//i, '')
              .replace(/^www\./i, '')
              .toLowerCase();
}

// The host of an already normalized url. Userinfo and port are dropped so that
// a domain pattern is compared against a hostname and nothing else.
function urlHost(normalizedUrl) {
    let authority = String(normalizedUrl).split(/[\/?#]/)[0];
    let at = authority.lastIndexOf('@');
    if (at > -1) {
        authority = authority.substring(at + 1);
    }
    return authority.split(':')[0];
}

function compileRegExp(source) {
    try {
        // case insensitive because the normalized url is lowercase but the
        // pattern is whatever the user typed
        return new RegExp(source, 'i');
    } catch (e) {
        return null;
    }
}

function escapeRegExpChars(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only "*" is a wildcard. "?" is left alone deliberately: it is the query
// separator, and a pattern like "example.com/?page=2" has to mean what it says.
function globToRegExpSource(pattern) {
    return escapeRegExpChars(pattern).replace(/\\\*/g, '.*');
}

// Whether one match rule covers a url that normalizeUrlForMatch has already been
// through. A pattern that cannot be compiled matches nothing - an unfinished
// regex in the editor should style no page rather than every page.
function styleMatchesUrl(match, normalizedUrl) {
    if (!match || !normalizedUrl) {
        return false;
    }
    let pattern = String(match.pattern === undefined ? '' : match.pattern).trim();
    if (pattern === '') {
        return false;
    }

    if (match.type === 'domain') {
        let host = urlHost(normalizedUrl);
        // tolerates a whole url pasted into the box, which is what people have
        // to hand when they mean "this site"
        let domain = urlHost(normalizeUrlForMatch(pattern));
        if (!host || !domain) {
            return false;
        }
        return host === domain || host.endsWith('.' + domain);
    }

    if (match.type === 'prefix') {
        return normalizedUrl.indexOf(normalizeUrlForMatch(pattern)) === 0;
    }

    // Anchored at the start and open at the end, so "reddit.com/r/*/comments"
    // covers the whole thread url rather than only the shortest form of it.
    if (match.type === 'glob') {
        let globRegex = compileRegExp('^' + globToRegExpSource(normalizeUrlForMatch(pattern)));
        return !!globRegex && globRegex.test(normalizedUrl);
    }

    // regex, unanchored - which is how v1 tested them
    let regex = compileRegExp(pattern);
    return !!regex && regex.test(normalizedUrl);
}

// How narrow a match rule is, as the pair the ordering compares: a rule that
// names a host and nothing else is the broadest thing a site style can be, and
// past that a longer pattern says more about the page than a shorter one.
function styleSpecificity(match) {
    let pattern = match && match.pattern ? String(match.pattern) : '';
    return {
        tier: match && match.type === 'domain' ? 0 : 1,
        length: pattern.trim().length
    };
}

// Whether a style is about this url at all, leaving aside whether it is switched
// on: a theme is about every page, and a site style is about the ones its
// pattern covers. Being off is not the same as not applying - the popup and the
// library's "applies here" filter both list what a page could take and let the
// user switch it on there.
function styleAppliesToUrl(entry, normalizedUrl) {
    if (!entry) {
        return false;
    }
    if (entry.scope === 'theme') {
        return true;
    }
    return !!normalizedUrl && styleMatchesUrl(entry.match, normalizedUrl);
}

// The styles to inject for one url, in the order they must be inserted.
//
// A stylesheet later in the document wins over an earlier one at equal
// specificity, so the order here is "broadest first": themes, which apply to
// every capture, then the site styles that matched, least specific first - a
// style for the whole domain is laid down before the one written for the section
// of it the user is on. priority breaks the tie when two rules are equally
// specific, and the order they were stored in breaks it after that, so the
// result never depends on how the entries happened to be enumerated.
//
// A style with no CSS in it is skipped: injecting an empty sheet only gives
// endJob something to take off the page again.
function selectStylesForUrl(url, library) {
    return orderStylesForUrl(url, library, false);
}

// The same list, plus the styles that are switched off or still empty. This is
// what a page *could* apply, in the order it would apply it - which is what the
// popup lists under "Site Styles" and what the library's "applies here" filter
// shows. Only the injection path wants the shorter answer.
function styleCandidatesForUrl(url, library) {
    return orderStylesForUrl(url, library, true);
}

function orderStylesForUrl(url, library, includeInactive) {
    let entries = library && Array.isArray(library.entries) ? library.entries : [];
    let normalizedUrl = normalizeUrlForMatch(url);
    let themes = [];
    let sites = [];

    for (let index = 0; index < entries.length; index++) {
        let entry = entries[index];
        if (!entry) {
            continue;
        }
        if (!includeInactive) {
            if (entry.enabled === false) {
                continue;
            }
            if (typeof entry.css !== 'string' || entry.css.trim() === '') {
                continue;
            }
        }
        if (entry.scope === 'theme') {
            themes.push({entry: entry, index: index});
            continue;
        }
        if (styleAppliesToUrl(entry, normalizedUrl)) {
            sites.push({entry: entry, index: index});
        }
    }

    let byPriority = (a, b) => {
        let priority = (a.entry.priority || 0) - (b.entry.priority || 0);
        return priority !== 0 ? priority : a.index - b.index;
    };

    themes.sort(byPriority);
    sites.sort((a, b) => {
        let left = styleSpecificity(a.entry.match);
        let right = styleSpecificity(b.entry.match);
        if (left.tier !== right.tier) {
            return left.tier - right.tier;
        }
        if (left.length !== right.length) {
            return left.length - right.length;
        }
        return byPriority(a, b);
    });

    return themes.concat(sites).map((item) => item.entry);
}

// One stored entry, with every field present and of the type the rest of the
// code expects. Anything unrecognized is replaced rather than repaired: this
// reads storage a user, an import file, or an older release wrote.
function normalizeStyleEntry(raw) {
    let source = raw && typeof raw === 'object' ? raw : {};
    let match = source.match && typeof source.match === 'object' ? source.match : {};
    let pattern = typeof match.pattern === 'string' ? match.pattern : '';
    let isNumber = (value) => typeof value === 'number' && isFinite(value);
    let isText = (value) => typeof value === 'string' && value !== '';

    return {
        id: isText(source.id) ? source.id : newStyleId(),
        title: typeof source.title === 'string' ? source.title : '',
        description: typeof source.description === 'string' ? source.description : '',
        // 'site' unless it says otherwise: a style that lost its scope applying
        // to one site is a smaller mistake than one applying to every capture
        scope: source.scope === 'theme' ? 'theme' : 'site',
        match: {
            type: STYLE_MATCH_TYPES.indexOf(match.type) > -1 ? match.type : 'regex',
            pattern: pattern
        },
        css: typeof source.css === 'string' ? source.css : '',
        enabled: source.enabled !== false,
        priority: isNumber(source.priority) ? source.priority : 0,
        origin: STYLE_ORIGINS.indexOf(source.origin) > -1 ? source.origin : 'user',
        // which bundled style this one is, or was forked from
        builtinId: isText(source.builtinId) ? source.builtinId : null,
        updatedAt: isNumber(source.updatedAt) ? source.updatedAt : 0,
        tags: Array.isArray(source.tags) ?
              source.tags.filter((tag) => typeof tag === 'string') : []
    };
}

function normalizeStyleLibrary(raw) {
    let source = raw && typeof raw === 'object' ? raw : {};
    let stored = Array.isArray(source.entries) ? source.entries : [];
    let entries = [];
    let seenIds = {};

    for (let index = 0; index < stored.length; index++) {
        // Not a style at all - a null left by a half-written save, a string from
        // a hand-edited import. Repairing it would mean inventing an empty style
        // for the user to wonder about.
        if (!stored[index] || typeof stored[index] !== 'object') {
            continue;
        }
        let entry = normalizeStyleEntry(stored[index]);
        // Two entries under one id would make an edit or a delete land on
        // whichever of them was found first.
        if (Object.prototype.hasOwnProperty.call(seenIds, entry.id)) {
            entry.id = newStyleId();
        }
        seenIds[entry.id] = true;
        entries.push(entry);
    }

    return {
        version: typeof source.version === 'number' && isFinite(source.version) ?
                 source.version : STYLE_LIBRARY_VERSION,
        entries: entries,
        // bundled styles this user has deleted. Kept by id so that shipping the
        // catalog again does not put them back.
        removedBuiltins: Array.isArray(source.removedBuiltins) ?
                         source.removedBuiltins.filter((id) => typeof id === 'string' && id !== '') : []
    };
}

function legacyTitleKey(title) {
    return String(title === undefined || title === null ? '' : title).trim().toLowerCase();
}

// A v1 style: {title, url, style}, where url is a bare regex source.
function entryFromLegacyStyle(legacy) {
    return normalizeStyleEntry({
        id: typeof legacy.id === 'string' ? legacy.id : null,
        title: legacy.title,
        scope: 'site',
        match: {type: 'regex', pattern: typeof legacy.url === 'string' ? legacy.url : ''},
        css: typeof legacy.style === 'string' ? legacy.style : '',
        origin: 'user'
    });
}

function entryFromBuiltinStyle(builtin) {
    let entry = entryFromLegacyStyle(builtin);
    entry.origin = 'builtin';
    entry.builtinId = typeof builtin.builtinId === 'string' ? builtin.builtinId : null;
    if (entry.builtinId) {
        entry.id = builtinStyleId(entry.builtinId);
    }
    return entry;
}

// Builds the v2 library out of what v1 left behind.
//
// The v1 defaults were a fallback for a missing 'styles' key, so the moment
// anybody saved a style they were written into it as ordinary entries - which is
// why a stored style is matched back to the bundled one it came from rather than
// assumed to be the user's own. An untouched copy becomes the built-in again; an
// edited one becomes the user's fork of it, and keeps the builtinId so that it
// can still be reset. A bundled style that is not in the stored list at all was
// deleted, and is recorded as such so that the catalog does not reinstate it.
function libraryFromLegacyStyles(legacyStyles, builtinStyles) {
    let builtins = Array.isArray(builtinStyles) ? builtinStyles : [];
    let entries = [];
    let claimed = {};

    if (!Array.isArray(legacyStyles)) {
        // the editor was never opened - the bundle is the whole library
        return normalizeStyleLibrary({
            version: STYLE_LIBRARY_VERSION,
            entries: builtins.map(entryFromBuiltinStyle),
            removedBuiltins: []
        });
    }

    let builtinsByTitle = {};
    for (let builtin of builtins) {
        let key = legacyTitleKey(builtin.title);
        if (!Object.prototype.hasOwnProperty.call(builtinsByTitle, key)) {
            builtinsByTitle[key] = builtin;
        }
    }

    for (let legacy of legacyStyles) {
        if (!legacy || typeof legacy !== 'object') {
            continue;
        }
        let entry = entryFromLegacyStyle(legacy);
        let builtin = builtinsByTitle[legacyTitleKey(legacy.title)];
        // only the first entry under a title is the bundled style; a second copy
        // of the name is the user's, whatever it holds
        if (builtin && builtin.builtinId && !claimed[builtin.builtinId]) {
            claimed[builtin.builtinId] = true;
            entry.builtinId = builtin.builtinId;
            if (String(legacy.url || '') === String(builtin.url || '') &&
                String(legacy.style || '') === String(builtin.style || '')) {
                entry.origin = 'builtin';
                // untouched, so it is the bundled style rather than a copy of
                // it, and carries the id every install gives that style
                entry.id = builtinStyleId(entry.builtinId);
            }
        }
        entries.push(entry);
    }

    return normalizeStyleLibrary({
        version: STYLE_LIBRARY_VERSION,
        entries: entries,
        removedBuiltins: builtins
            .filter((builtin) => builtin.builtinId && !claimed[builtin.builtinId])
            .map((builtin) => builtin.builtinId)
    });
}

// Reads the library out of storage, converting a v1 'styles' array the first
// time. `changed` says whether the result has to be written back: a library from
// a later release is used as well as it can be but left alone on disk, because
// writing it back would be writing this version's shape over a newer one.
function migrateStyleLibrary(storedLibrary, legacyStyles, builtinStyles) {
    if (storedLibrary && typeof storedLibrary === 'object' &&
        Array.isArray(storedLibrary.entries) &&
        typeof storedLibrary.version === 'number' &&
        storedLibrary.version >= STYLE_LIBRARY_VERSION) {
        return {library: normalizeStyleLibrary(storedLibrary), changed: false};
    }
    return {library: libraryFromLegacyStyles(legacyStyles, builtinStyles), changed: true};
}

// ---- the bundled catalog --------------------------------------------------
//
// styles/catalog.json holds the styles the extension ships with, in the v2
// shape plus two fields of its own: builtinId, which is what identifies one of
// them across releases, and v1, which marks the five that shipped before there
// was a library at all.
//
// The catalog is not stored. It is merged over the stored library every time
// that library is read, which is what lets a release add styles to it without
// touching - or being able to lose - anything the user has done.

function catalogEntries(catalog) {
    let entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
    // an entry with no builtinId cannot be tracked across releases: it would be
    // added again, under a new id, on every read
    return entries.filter((entry) => entry && typeof entry === 'object' &&
                                     typeof entry.builtinId === 'string' &&
                                     entry.builtinId !== '');
}

function catalogEntryById(catalog, builtinId) {
    let entries = catalogEntries(catalog);
    for (let entry of entries) {
        if (entry.builtinId === builtinId) {
            return entry;
        }
    }
    return null;
}

// The v1 shape the migration compares stored styles against: only the entries
// that actually shipped in v1, because only those can have a copy in a v1
// 'styles' array. Handing it the whole catalog would make every style added
// since look like one the user had deleted.
function catalogToV1Builtins(catalog) {
    return catalogEntries(catalog)
        .filter((entry) => entry.v1 === true)
        .map((entry) => ({
            builtinId: entry.builtinId,
            title: entry.title,
            url: entry.match && typeof entry.match.pattern === 'string' ? entry.match.pattern : '',
            style: typeof entry.css === 'string' ? entry.css : ''
        }));
}

// Ids for bundled styles are derived from the builtinId rather than minted, so
// that a style the catalog owns has the same id in every install and across the
// migration - a user's fork of one is the thing with an id of its own.
//
// The prefix is what makes such an id recognizable on its own, which import
// needs: an id every install shares is the one id a style arriving from outside
// must not be allowed to keep. See readStyleImport.
var BUILTIN_STYLE_ID_PREFIX = 'builtin-';

function builtinStyleId(builtinId) {
    return BUILTIN_STYLE_ID_PREFIX + builtinId;
}

function isBuiltinStyleId(id) {
    return typeof id === 'string' && id.indexOf(BUILTIN_STYLE_ID_PREFIX) === 0;
}

function entryFromCatalogEntry(catalogEntry) {
    let entry = normalizeStyleEntry(catalogEntry);
    entry.id = builtinStyleId(catalogEntry.builtinId);
    entry.origin = 'builtin';
    entry.builtinId = catalogEntry.builtinId;
    return entry;
}

// The fields the catalog owns. An entry still marked 'builtin' is one nobody has
// edited, so these are taken from the catalog on every read - that is how a
// bundled style gets fixed when a site changes its markup. enabled and priority
// are the user's, and the id is what the rest of the library points at.
function applyCatalogEntry(entry, catalogEntry) {
    let fresh = entryFromCatalogEntry(catalogEntry);
    fresh.id = entry.id;
    fresh.enabled = entry.enabled;
    fresh.priority = entry.priority;
    fresh.updatedAt = entry.updatedAt;
    return fresh;
}

function sameStoredEntry(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

// The stored library with the catalog laid over it. `changed` says whether that
// produced something worth writing back.
//
// Three cases, and the middle one is the point of the whole tier:
//   no entry for this builtinId  - a style this release adds, unless the user
//                                  has deleted it before (removedBuiltins)
//   an entry still marked builtin - untouched, so refreshed from the catalog
//   anything else                 - the user's fork, which shadows the catalog
//                                   until they reset it
function mergeCatalogIntoLibrary(library, catalog) {
    let merged = normalizeStyleLibrary(library);

    // A library from a later release has already decided what its catalog holds;
    // adding this release's entries to it could put back a style it retired.
    if (merged.version > STYLE_LIBRARY_VERSION) {
        return {library: merged, changed: false};
    }

    let removed = {};
    for (let builtinId of merged.removedBuiltins) {
        removed[builtinId] = true;
    }

    let indexByBuiltinId = {};
    for (let index = 0; index < merged.entries.length; index++) {
        let builtinId = merged.entries[index].builtinId;
        // the first entry claiming a builtinId is the one the catalog speaks to;
        // a second copy of it is the user's own
        if (builtinId && !Object.prototype.hasOwnProperty.call(indexByBuiltinId, builtinId)) {
            indexByBuiltinId[builtinId] = index;
        }
    }

    let changed = false;
    for (let catalogEntry of catalogEntries(catalog)) {
        if (removed[catalogEntry.builtinId]) {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(indexByBuiltinId, catalogEntry.builtinId)) {
            merged.entries.push(entryFromCatalogEntry(catalogEntry));
            changed = true;
            continue;
        }
        let index = indexByBuiltinId[catalogEntry.builtinId];
        if (merged.entries[index].origin !== 'builtin') {
            continue;
        }
        let refreshed = applyCatalogEntry(merged.entries[index], catalogEntry);
        if (!sameStoredEntry(merged.entries[index], refreshed)) {
            merged.entries[index] = refreshed;
            changed = true;
        }
    }

    return {library: merged, changed: changed};
}

// Undoes a fork: the bundled style again, keeping where it sits in the library
// and whether it is switched on. Null when there is nothing to go back to -
// a style the user wrote themselves, or one whose builtin has since been
// dropped from the catalog.
function resetEntryToBuiltin(entry, catalog) {
    if (!entry || !entry.builtinId) {
        return null;
    }
    let catalogEntry = catalogEntryById(catalog, entry.builtinId);
    if (!catalogEntry) {
        return null;
    }
    return applyCatalogEntry(normalizeStyleEntry(entry), catalogEntry);
}

// A copy of a style, as the user's own. The builtinId is deliberately dropped:
// the copy is a new style that happens to have started as a bundled one, and
// leaving the id on it would give two entries a claim to the same catalog slot.
function duplicateStyleEntry(entry, title) {
    let copy = normalizeStyleEntry(entry);
    copy.id = newStyleId();
    copy.title = typeof title === 'string' ? title : copy.title;
    copy.origin = 'user';
    copy.builtinId = null;
    copy.updatedAt = Date.now();
    return copy;
}

// A style the user has just asked for, before they have typed anything into it.
// A new style is on: it was made to be used, and the one thing it cannot do yet
// is match anything, since it has no pattern.
function newStyleEntry(scope) {
    let entry = normalizeStyleEntry({
        scope: scope === 'theme' ? 'theme' : 'site',
        match: {type: 'domain', pattern: ''},
        origin: 'user'
    });
    entry.updatedAt = Date.now();
    return entry;
}

// Storing an edited entry: it replaces the one it came from, and a bundled style
// that has been changed becomes the user's fork of it. Called by the library
// page for every save, which is the only place entries are written.
function putStyleEntry(library, entry) {
    let updated = normalizeStyleLibrary(library);
    let fresh = normalizeStyleEntry(entry);
    let index = updated.entries.findIndex((existing) => existing.id === fresh.id);

    if (index < 0) {
        updated.entries.push(fresh);
        return updated;
    }

    let previous = updated.entries[index];
    // What the catalog owns - see applyCatalogEntry. An edit to any of it means
    // this is no longer the bundled style, but it stays linked to it so that
    // "reset" has something to go back to.
    if (previous.origin === 'builtin' &&
        (fresh.title !== previous.title || fresh.description !== previous.description ||
         fresh.css !== previous.css || fresh.scope !== previous.scope ||
         fresh.match.type !== previous.match.type ||
         fresh.match.pattern !== previous.match.pattern)) {
        fresh.origin = 'user';
    }
    if (!sameStoredEntry(previous, fresh)) {
        fresh.updatedAt = Date.now();
    }
    updated.entries[index] = fresh;
    return updated;
}

// Deleting one. A bundled style is remembered as deleted, or the catalog merge
// would hand it straight back on the next read.
function removeStyleEntry(library, id) {
    let updated = normalizeStyleLibrary(library);
    let entry = updated.entries.find((existing) => existing.id === id);
    if (!entry) {
        return updated;
    }
    updated.entries = updated.entries.filter((existing) => existing.id !== id);
    if (entry.builtinId && updated.removedBuiltins.indexOf(entry.builtinId) < 0) {
        updated.removedBuiltins.push(entry.builtinId);
    }
    return updated;
}

// ---- sharing a style ------------------------------------------------------
//
// A style is a few fields and a block of css, so a file holding some is the
// obvious way to move one between two installs or hand it to somebody else. Both
// ends of that live here rather than on the library page, because what may cross
// the boundary is a question about the model: what a style file is allowed to
// say, and what it is not allowed to say about *this* library.

var STYLE_EXPORT_KIND = 'save-as-ebook-styles';

// What is written out is what a style is, not what this install has done with
// it. origin, builtinId and updatedAt are all facts about the library the style
// came out of - see readStyleImport for why carrying them would be worse than
// dropping them.
function exportableStyleEntry(entry) {
    let normalized = normalizeStyleEntry(entry);
    return {
        id: normalized.id,
        title: normalized.title,
        description: normalized.description,
        scope: normalized.scope,
        match: {type: normalized.match.type, pattern: normalized.match.pattern},
        css: normalized.css,
        enabled: normalized.enabled,
        priority: normalized.priority,
        tags: normalized.tags
    };
}

// One style or a whole library, in the same envelope: a file holding one is a
// file holding a list of one, so import has a single shape to read.
function styleExportDocument(entries) {
    return {
        kind: STYLE_EXPORT_KIND,
        version: STYLE_LIBRARY_VERSION,
        exportedAt: Date.now(),
        entries: (Array.isArray(entries) ? entries : [entries]).map(exportableStyleEntry)
    };
}

// A filename from the style's own name, so a folder of exports can be read
// without opening them. Anything that is not a plain word becomes a dash, since
// this string reaches a filesystem the extension knows nothing about.
function styleExportFileName(title) {
    let slug = String(title === undefined || title === null ? '' : title)
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
    return 'save-as-ebook-style' + (slug === '' ? 's' : '-' + slug) + '.json';
}

// ---- what an imported stylesheet is not allowed to do ----------------------
//
// Imported css is somebody else's, and it is injected into real pages as they
// are captured - so a url() or an @import pointing at a remote host is a request
// that host receives, carrying the visitor's address, every time the style runs.
// That is a tracking beacon fired by a file the user was invited to trust, and
// there is nothing a site style needs a remote resource for.
//
// saveEbook.js removes the same two constructs from the stylesheets that go into
// a book, for reasons of its own (an epub has to read offline, and a remote
// reference has to be declared). The rules are deliberately spelled out again
// here rather than shared: that file writes ebooks and is not loaded by the
// service worker, and this one has to report what it took out so that the user
// is told rather than quietly protected.

var STYLE_IMPORT_REGEX = /@import\b(?:[^;{}'"]|'[^']*'|"[^"]*")*(?:;|(?=\})|$)/gi;
var STYLE_URL_REGEX = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

// Anything with a scheme, plus the scheme-relative "//host/path" form. A data:
// url is the resource itself rather than an address to fetch it from, and a
// relative one cannot leave the page the style is running on.
function isRemoteStyleUrl(target) {
    let value = String(target === undefined || target === null ? '' : target).trim();
    if (/^data:/i.test(value)) {
        return false;
    }
    return /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(value);
}

// The css with those references gone, and the list of what went - the second
// half being the point: a style that quietly does less than the file said is
// worse than one that says what was dropped from it.
//
// A removed url() becomes 'none' rather than nothing, for the reason saveEbook.js
// gives: an empty value takes the whole declaration - and any fallback beside it
// - down with it.
function stripRemoteCssReferences(css) {
    let removed = [];
    let note = (reference) => {
        let text = String(reference).replace(/\s+/g, ' ').trim();
        if (text !== '' && removed.indexOf(text) < 0) {
            removed.push(text);
        }
    };

    let cleaned = String(css === undefined || css === null ? '' : css)
        .replace(STYLE_IMPORT_REGEX, (rule) => {
            note(rule);
            return '';
        })
        .replace(STYLE_URL_REGEX, (rule, quoted, single, bare) => {
            let target = quoted !== undefined ? quoted :
                         single !== undefined ? single : bare;
            if (!isRemoteStyleUrl(target)) {
                return rule;
            }
            note(target);
            return 'none';
        });

    return {css: cleaned, removed: removed};
}

// The styles in a file somebody was given, or in text they pasted.
//
// Four shapes are accepted, because all four are things a person will reasonably
// paste: what styleExportDocument writes, a whole stored library, a bare array of
// styles, and a single style on its own.
//
// Two things are taken away from every entry on the way in:
//
//   builtinId, and any id the catalog owns. Those name a slot in *this*
//   install's library that the bundled catalog fills and refreshes. A style
//   arriving from outside that claimed one would either be overwritten by the
//   next catalog read or leave the built-in with nowhere to go - so an imported
//   style is always the user's own, exactly as a duplicate is.
//
//   remote url() and @import - see stripRemoteCssReferences.
//
// The id is otherwise kept, which is what makes importing a newer copy of a
// style an update to the one already here rather than a second copy of it.
//
// `error` is a code rather than a sentence: this file has no messages in it.
function readStyleImport(text) {
    let parsed = null;
    try {
        parsed = JSON.parse(String(text === undefined || text === null ? '' : text));
    } catch (e) {
        return {error: 'unreadable', entries: [], stripped: []};
    }

    let source = null;
    if (Array.isArray(parsed)) {
        source = parsed;
    } else if (parsed && typeof parsed === 'object') {
        source = Array.isArray(parsed.entries) ? parsed.entries : [parsed];
    } else {
        // a number, a string, a bare null - json, but not a style
        return {error: 'unreadable', entries: [], stripped: []};
    }

    let entries = [];
    let stripped = [];
    for (let raw of source) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        let entry = normalizeStyleEntry(raw);
        let clean = stripRemoteCssReferences(entry.css);

        entry.css = clean.css;
        entry.origin = 'imported';
        entry.builtinId = null;
        entry.updatedAt = Date.now();
        if (isBuiltinStyleId(entry.id)) {
            entry.id = newStyleId();
        }
        entries.push(entry);

        if (clean.removed.length > 0) {
            stripped.push({title: entry.title, references: clean.removed});
        }
    }

    if (entries.length === 0) {
        return {error: 'empty', entries: [], stripped: []};
    }
    return {error: '', entries: entries, stripped: stripped};
}

// What importing these would do to this library, so that it can be said before
// it is done. A collision is a style already here under the same id - the same
// style, from an earlier copy of the same file - and it is the only thing an
// import can take away, so it is the only thing worth asking about.
function planStyleImport(library, entries) {
    let existing = normalizeStyleLibrary(library).entries;
    let byId = {};
    for (let entry of existing) {
        byId[entry.id] = entry;
    }

    let additions = [];
    let collisions = [];
    for (let entry of entries) {
        if (Object.prototype.hasOwnProperty.call(byId, entry.id)) {
            collisions.push({incoming: entry, existing: byId[entry.id]});
        } else {
            additions.push(entry);
        }
    }
    return {additions: additions, collisions: collisions};
}

// Writes them in. `replaceExisting` is the answer to the collisions above: the
// imported style takes the place of the one already here, or is added beside it
// as a style in its own right. Anything that is not a collision is simply added
// either way.
//
// The styles come back as they were stored - a copy has an id of its own by
// then - so that the caller can point at what it just wrote.
function applyStyleImport(library, entries, replaceExisting) {
    let updated = normalizeStyleLibrary(library);
    let stored = [];
    for (let entry of entries) {
        let collides = updated.entries.some((existing) => existing.id === entry.id);
        let written = collides && !replaceExisting ?
                      Object.assign({}, entry, {id: newStyleId()}) : entry;
        updated = putStyleEntry(updated, written);
        stored.push(written);
    }
    return {library: updated, entries: stored};
}
