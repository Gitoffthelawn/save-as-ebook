// Runs on styles.html - see the note at the top of chapterEditor.js
//
// The site style library. Every style the extension knows about is in one list
// here, whether it is bundled or the user's, on or off, for one site or for every
// capture - which is the whole difference from the editor this replaced, where a
// <select> showed one style at a time and the only way to switch one off was to
// delete it.
//
// Two things are worth knowing before reading on:
//
// The list is the library, not a draft of it. A checkbox, a delete, a duplicate
// and a reset are written to storage as they happen. Only the fields in the
// detail pane are a draft, and only until Save Style - that is the one place
// where "what is on screen" and "what is stored" differ, and the one place that
// asks before throwing an edit away.
//
// Everything about what a style *is* lives in styleLibrary.js: what matches a
// url, what the bundled catalog says, what happens to a built-in that gets
// edited. This file decides what to show and what to ask, and calls that.
//
// The third pane is the preview, and what it renders needs saying plainly: not
// the site, but a page captured from it - see dispatchStyleSnapshot() - put
// through the same functions that write a chapter, with the styles that would
// apply laid over it. The extension holds activeTab and nothing else, so a tab of
// its own cannot reach a live site at all; and even if it could, the site is the
// wrong thing to show. Extraction drops what is invisible, keeps what it can
// carry, and rewrites the rest, so the page in the frame is the one the style is
// actually for. What it cannot show is a style that changes what capture sees:
// the snapshot was read once, and a rule that hides an element in the frame would
// have kept it out of the capture altogether.

let styleLibrary = null;
let styleCatalog = null;
// The page captured for the preview, or null when nobody has taken one. Its url
// is not necessarily styleTargetUrl below: the library can be opened on one page
// while holding a snapshot of another.
let styleSnapshot = null;
// The page the popup was opened on. An extension page cannot ask which tab was
// in front of it - see the note in menu.js - so this is what the popup passed.
let styleTargetUrl = readStyleTargetUrl();
let selectedStyleId = null;
let unsavedStyleEdits = false;

// One-click starting points for the css box. Every one of them is a rule about
// the kind of thing a page has rather than about any one site - which is what
// makes them worth shipping, and also what makes them a first draft: the picker
// beside them is how a recipe becomes a selector that names the actual element.
//
// Appended rather than substituted, so that using two of them gives a style that
// does both.
var STYLE_RECIPES = [
    {id: 'hideImages', label: 'styleRecipeHideImages',
     css: 'img, picture, figure, svg, video, canvas {\n' +
          '    display: none !important;\n}\n'},
    {id: 'hideSidebars', label: 'styleRecipeHideSidebars',
     css: 'aside,\n[class*="sidebar"],\n[id*="sidebar"] {\n' +
          '    display: none !important;\n}\n'},
    {id: 'unstickHeaders', label: 'styleRecipeUnstickHeaders',
     css: 'header, nav, [class*="sticky"], [class*="fixed"] {\n' +
          '    position: static !important;\n}\n'},
    {id: 'hideComments', label: 'styleRecipeHideComments',
     css: '#comments,\n[class*="comment"],\n[id*="comment"] {\n' +
          '    display: none !important;\n}\n'},
    {id: 'singleColumn', label: 'styleRecipeSingleColumn',
     css: 'body, main, article {\n' +
          '    display: block !important;\n' +
          '    float: none !important;\n' +
          '    width: auto !important;\n' +
          '    max-width: 40em !important;\n' +
          '    margin: 0 auto !important;\n}\n'},
    {id: 'biggerText', label: 'styleRecipeBiggerText',
     css: 'body, p, li, td, blockquote {\n' +
          '    font-size: 20px !important;\n' +
          '    line-height: 1.7 !important;\n}\n'}
];

function readStyleTargetUrl() {
    try {
        let value = new URL(window.location.href).searchParams.get('for');
        return typeof value === 'string' ? value : '';
    } catch (e) {
        return '';
    }
}

showEditor();

function showEditor() {

    var body = document.getElementsByTagName('body')[0];
    var modalContent = document.createElement('div');
    modalContent.id = 'cssEditor-modalContent';
    var modalHeader = document.createElement('div');
    modalHeader.id = 'cssEditor-modalHeader';
    var modalList = document.createElement('div');
    modalList.id = 'cssEditor-modalList';
    var modalFooter = document.createElement('div');
    modalFooter.id = 'cssEditor-modalFooter';

    ////////
    // Header
    var title = document.createElement('span');
    title.id = "cssEditor-Title";
    title.innerText = chrome.i18n.getMessage('styleEditor');
    var upperCloseButton = document.createElement('button');
    modalHeader.appendChild(title);
    upperCloseButton.onclick = closeModal;
    upperCloseButton.innerText = 'X';
    upperCloseButton.className = 'cssEditor-text-button cssEditor-float-right';
    modalHeader.appendChild(upperCloseButton);

    /////////////////////
    // Left - the library itself: what to look for, what to look at, and the list.

    var libraryPanel = document.createElement('div');
    libraryPanel.id = 'cssEditor-libraryPanel';

    var searchInput = document.createElement('input');
    searchInput.id = 'cssEditor-search';
    searchInput.type = 'search';
    searchInput.placeholder = chrome.i18n.getMessage('styleSearchPlaceholder');
    // The css body is searched as well as the name and the pattern: "which of my
    // styles hides .sidebar" is a question about the css, and by the time a
    // library is worth searching that is the question being asked.
    searchInput.oninput = function () {
        renderStyleList();
    };
    libraryPanel.appendChild(searchInput);

    // Kept in the same order they are declared in: All first, then what a style
    // is, then who it belongs to. 'matches' is only offered when the popup said
    // which page we are talking about.
    var filters = [
        {id: 'all', label: 'styleFilterAll'},
        {id: 'matches', label: 'styleFilterMatches'},
        {id: 'site', label: 'styleFilterSite'},
        {id: 'theme', label: 'styleFilterTheme'},
        {id: 'enabled', label: 'styleFilterEnabled'},
        {id: 'mine', label: 'styleFilterMine'},
        {id: 'builtin', label: 'styleFilterBuiltin'}
    ];
    var activeFilter = 'all';

    var filterHolder = document.createElement('div');
    filterHolder.id = 'cssEditor-filters';
    var filterButtons = {};

    for (let filter of filters) {
        if (filter.id === 'matches' && styleTargetUrl === '') {
            continue;
        }
        let chip = document.createElement('button');
        chip.className = 'cssEditor-chip';
        chip.id = 'cssEditor-filter-' + filter.id;
        chip.innerText = chrome.i18n.getMessage(filter.label);
        chip.onclick = function () {
            activeFilter = filter.id;
            renderFilters();
            renderStyleList();
        };
        filterButtons[filter.id] = chip;
        filterHolder.appendChild(chip);
    }
    libraryPanel.appendChild(filterHolder);

    function renderFilters() {
        for (let id of Object.keys(filterButtons)) {
            filterButtons[id].className = 'cssEditor-chip' +
                (id === activeFilter ? ' cssEditor-chip-on' : '');
        }
    }
    renderFilters();

    var styleList = document.createElement('div');
    styleList.id = 'cssEditor-styleList';
    libraryPanel.appendChild(styleList);

    var newButtons = document.createElement('div');
    newButtons.id = 'cssEditor-newButtons';

    var newSiteButton = document.createElement('button');
    newSiteButton.id = 'cssEditor-newSiteStyle';
    newSiteButton.className = 'cssEditor-chip';
    newSiteButton.innerText = chrome.i18n.getMessage('newSiteStyle');
    newSiteButton.onclick = function () {
        createStyle('site');
    };
    newButtons.appendChild(newSiteButton);

    var newThemeButton = document.createElement('button');
    newThemeButton.id = 'cssEditor-newThemeStyle';
    newThemeButton.className = 'cssEditor-chip';
    newThemeButton.innerText = chrome.i18n.getMessage('newThemeStyle');
    newThemeButton.onclick = function () {
        createStyle('theme');
    };
    newButtons.appendChild(newThemeButton);

    libraryPanel.appendChild(newButtons);

    // Moving styles in and out of the library as a whole, kept apart from the
    // two buttons that make one: these are about the library, and the file they
    // read and write holds however many styles it holds.
    var transferButtons = document.createElement('div');
    transferButtons.id = 'cssEditor-transferButtons';

    var importButton = document.createElement('button');
    importButton.id = 'cssEditor-importStyles';
    importButton.className = 'cssEditor-chip';
    importButton.innerText = chrome.i18n.getMessage('styleImport');
    importButton.onclick = openImport;
    transferButtons.appendChild(importButton);

    var exportAllButton = document.createElement('button');
    exportAllButton.id = 'cssEditor-exportAllStyles';
    exportAllButton.className = 'cssEditor-chip';
    exportAllButton.innerText = chrome.i18n.getMessage('styleExportAll');
    exportAllButton.onclick = exportLibrary;
    transferButtons.appendChild(exportAllButton);

    libraryPanel.appendChild(transferButtons);

    /////////////////////
    // Right - one style in full.

    var detailPanel = document.createElement('div');
    detailPanel.id = 'cssEditor-detailPanel';

    var emptyDetail = document.createElement('div');
    emptyDetail.id = 'cssEditor-noSelection';
    emptyDetail.innerText = chrome.i18n.getMessage('styleNoSelection');
    detailPanel.appendChild(emptyDetail);

    var detailForm = document.createElement('div');
    detailForm.id = 'cssEditor-styleEditor';
    detailPanel.appendChild(detailForm);

    // What this style is, and what can be done to it as a whole.
    var originRow = document.createElement('div');
    originRow.id = 'cssEditor-originRow';

    var originBadge = document.createElement('span');
    originBadge.id = 'cssEditor-originBadge';
    originRow.appendChild(originBadge);

    var duplicateButton = document.createElement('button');
    duplicateButton.id = 'cssEditor-duplicateStyle';
    duplicateButton.className = 'cssEditor-text-button';
    duplicateButton.innerText = chrome.i18n.getMessage('styleDuplicate');
    duplicateButton.onclick = duplicateSelected;
    originRow.appendChild(duplicateButton);

    var exportButton = document.createElement('button');
    exportButton.id = 'cssEditor-exportStyle';
    exportButton.className = 'cssEditor-text-button';
    exportButton.innerText = chrome.i18n.getMessage('styleExport');
    exportButton.title = chrome.i18n.getMessage('styleExportHint');
    exportButton.onclick = exportSelected;
    originRow.appendChild(exportButton);

    // Only shown for a style that has something to go back to: the user's fork
    // of a bundled one, while the catalog still ships it.
    var resetButton = document.createElement('button');
    resetButton.id = 'cssEditor-resetStyle';
    resetButton.className = 'cssEditor-text-button';
    resetButton.innerText = chrome.i18n.getMessage('styleResetToBuiltin');
    resetButton.onclick = resetSelected;
    originRow.appendChild(resetButton);

    detailForm.appendChild(originRow);

    function fieldLabel(text, hint) {
        let holder = document.createElement('div');
        holder.className = 'cssEditor-field-label-holder';
        let label = document.createElement('label');
        label.className = 'cssEditor-field-label';
        label.innerText = text;
        holder.appendChild(label);
        if (hint) {
            let note = document.createElement('span');
            note.className = 'cssEditor-field-hint';
            note.innerText = hint;
            holder.appendChild(note);
        }
        return holder;
    }

    function fieldHolder(field) {
        let holder = document.createElement('div');
        holder.className = 'cssEditor-field-holder';
        holder.appendChild(field);
        return holder;
    }

    // Every field marks the draft dirty the same way, so that closing the page or
    // selecting another style has one question to ask.
    function markEdited() {
        unsavedStyleEdits = true;
    }

    detailForm.appendChild(fieldLabel(chrome.i18n.getMessage('styleNameLabel')));
    var nameInput = document.createElement('input');
    nameInput.id = 'cssEditor-styleName';
    nameInput.type = 'text';
    nameInput.oninput = markEdited;
    detailForm.appendChild(fieldHolder(nameInput));

    detailForm.appendChild(fieldLabel(chrome.i18n.getMessage('styleDescriptionLabel')));
    var descriptionInput = document.createElement('input');
    descriptionInput.id = 'cssEditor-styleDescription';
    descriptionInput.type = 'text';
    descriptionInput.placeholder = chrome.i18n.getMessage('styleDescriptionPlaceholder');
    descriptionInput.oninput = markEdited;
    detailForm.appendChild(fieldHolder(descriptionInput));

    // scope. The stored values are 'site' and 'theme'; the labels say what that
    // means, because "theme" is only half of what the second one is used for -
    // a look, or a cleanup that is not about any one site.
    detailForm.appendChild(fieldLabel(chrome.i18n.getMessage('styleScopeLabel')));
    var scopeSelect = document.createElement('select');
    scopeSelect.id = 'cssEditor-styleScope';
    for (let scope of [{value: 'site', label: 'styleScopeSite'},
                       {value: 'theme', label: 'styleScopeTheme'}]) {
        let option = document.createElement('option');
        option.value = scope.value;
        option.innerText = chrome.i18n.getMessage(scope.label);
        scopeSelect.appendChild(option);
    }
    scopeSelect.onchange = function () {
        markEdited();
        // the match fields are not a draft of anything while the style applies to
        // every page, so they go away rather than sit there being ignored
        renderMatchFields();
    };
    detailForm.appendChild(fieldHolder(scopeSelect));

    var matchHolder = document.createElement('div');
    matchHolder.id = 'cssEditor-matchHolder';

    matchHolder.appendChild(fieldLabel(chrome.i18n.getMessage('styleMatchTypeLabel')));
    var matchTypeSelect = document.createElement('select');
    matchTypeSelect.id = 'cssEditor-matchType';
    for (let type of [{value: 'domain', label: 'styleMatchDomain'},
                      {value: 'prefix', label: 'styleMatchPrefix'},
                      {value: 'glob', label: 'styleMatchGlob'},
                      {value: 'regex', label: 'styleMatchRegex'}]) {
        let option = document.createElement('option');
        option.value = type.value;
        option.innerText = chrome.i18n.getMessage(type.label);
        matchTypeSelect.appendChild(option);
    }
    matchTypeSelect.onchange = function () {
        markEdited();
        renderPatternHint();
        renderMatchResult();
    };
    matchHolder.appendChild(fieldHolder(matchTypeSelect));

    matchHolder.appendChild(fieldLabel(chrome.i18n.getMessage('stylePatternLabel')));
    var patternInput = document.createElement('input');
    patternInput.id = 'cssEditor-matchUrl';
    patternInput.type = 'text';
    patternInput.oninput = function () {
        markEdited();
        renderMatchResult();
    };
    matchHolder.appendChild(fieldHolder(patternInput));

    // The question the old "How to write a regular expression pattern" link could
    // not answer: does this pattern match the page I want it for. Prefilled with
    // the page the popup was opened on, which is the answer wanted nine times in
    // ten.
    matchHolder.appendChild(fieldLabel(chrome.i18n.getMessage('styleTestUrlLabel')));
    var testUrlInput = document.createElement('input');
    testUrlInput.id = 'cssEditor-testUrl';
    testUrlInput.type = 'text';
    testUrlInput.value = styleTargetUrl;
    testUrlInput.placeholder = chrome.i18n.getMessage('styleTestUrlPlaceholder');
    // not an edit to the style - this box is a question, not a field
    testUrlInput.oninput = renderMatchResult;
    matchHolder.appendChild(fieldHolder(testUrlInput));

    var matchResult = document.createElement('div');
    matchResult.id = 'cssEditor-matchResult';
    matchHolder.appendChild(matchResult);

    detailForm.appendChild(matchHolder);

    detailForm.appendChild(fieldLabel('CSS', chrome.i18n.getMessage('styleCssHint')));

    // The recipes sit above the box rather than beside it: they write into it,
    // and what they write is meant to be edited afterwards.
    var recipeHolder = document.createElement('div');
    recipeHolder.id = 'cssEditor-recipes';
    for (let recipe of STYLE_RECIPES) {
        let chip = document.createElement('button');
        chip.className = 'cssEditor-chip';
        chip.id = 'cssEditor-recipe-' + recipe.id;
        chip.innerText = chrome.i18n.getMessage(recipe.label);
        chip.onclick = function () {
            appendCss(recipe.css);
        };
        recipeHolder.appendChild(chip);
    }
    detailForm.appendChild(recipeHolder);

    var cssInput = document.createElement('textarea');
    cssInput.id = 'cssEditor-styleContent';
    cssInput.setAttribute('data', 'language: css');
    cssInput.spellcheck = false;
    cssInput.oninput = function () {
        markEdited();
        // The whole reason the preview is a frame this page reaches into rather
        // than one it rebuilds: a rebuilt srcdoc reloads, and a preview that
        // flickered on every keystroke would be unusable.
        applyPreviewCss();
    };
    detailForm.appendChild(fieldHolder(cssInput));

    /////////////////////
    // Third - the page the styles are being tried on.

    var previewPanel = document.createElement('div');
    previewPanel.id = 'cssEditor-previewPanel';

    var previewHeader = document.createElement('div');
    previewHeader.id = 'cssEditor-previewHeader';

    var previewTitle = document.createElement('span');
    previewTitle.id = 'cssEditor-previewTitle';
    previewTitle.innerText = chrome.i18n.getMessage('stylePreviewTitle');
    previewHeader.appendChild(previewTitle);

    var previewClear = document.createElement('button');
    previewClear.id = 'cssEditor-previewClear';
    previewClear.className = 'cssEditor-text-button';
    previewClear.innerText = chrome.i18n.getMessage('stylePreviewClear');
    previewClear.onclick = discardSnapshot;
    previewHeader.appendChild(previewClear);
    previewPanel.appendChild(previewHeader);

    // Which page it is, since it need not be the one the library was opened on.
    var previewSource = document.createElement('div');
    previewSource.id = 'cssEditor-previewSource';
    previewPanel.appendChild(previewSource);

    // The styles the frame is showing, by name. The preview is a composition -
    // themes, then whatever matched, then the style being edited - and without
    // this the user is looking at the result of a rule they cannot see.
    var previewApplied = document.createElement('div');
    previewApplied.id = 'cssEditor-previewApplied';
    previewPanel.appendChild(previewApplied);

    var pickerBar = document.createElement('div');
    pickerBar.id = 'cssEditor-pickerBar';

    var pickButton = document.createElement('button');
    pickButton.id = 'cssEditor-pickElement';
    pickButton.className = 'cssEditor-chip';
    pickButton.innerText = chrome.i18n.getMessage('stylePickElement');
    pickButton.onclick = function () {
        setPicking(!(pickerSession && pickerSession.isActive()));
    };
    pickerBar.appendChild(pickButton);

    var widenButton = document.createElement('button');
    widenButton.id = 'cssEditor-pickWiden';
    widenButton.className = 'cssEditor-chip';
    widenButton.innerText = chrome.i18n.getMessage('selectParent');
    widenButton.onclick = function () {
        if (pickerSession) {
            pickerSession.widen();
        }
    };
    pickerBar.appendChild(widenButton);

    var narrowButton = document.createElement('button');
    narrowButton.id = 'cssEditor-pickNarrow';
    narrowButton.className = 'cssEditor-chip';
    narrowButton.innerText = chrome.i18n.getMessage('selectChild');
    narrowButton.onclick = function () {
        if (pickerSession) {
            pickerSession.narrow();
        }
    };
    pickerBar.appendChild(narrowButton);

    previewPanel.appendChild(pickerBar);

    // What a click would write, before it writes it. A selector covering more
    // than one element is not an error - it is often what was meant - but it is
    // the one thing about a pick that cannot be seen by looking at the highlight.
    var pickTarget = document.createElement('div');
    pickTarget.id = 'cssEditor-pickTarget';
    previewPanel.appendChild(pickTarget);

    var previewBody = document.createElement('div');
    previewBody.id = 'cssEditor-previewBody';
    previewPanel.appendChild(previewBody);

    var previewNote = document.createElement('div');
    previewNote.id = 'cssEditor-previewNote';
    previewNote.innerText = chrome.i18n.getMessage('stylePreviewNote');
    previewPanel.appendChild(previewNote);

    var panels = document.createElement('div');
    panels.id = 'cssEditor-panels';
    panels.appendChild(libraryPanel);
    panels.appendChild(detailPanel);
    panels.appendChild(previewPanel);
    modalList.appendChild(panels);

    /////////////////////
    // Footer

    var saveButtonsHolder = document.createElement('div');

    var removeCssButton = document.createElement('button');
    removeCssButton.id = 'cssEditor-removeStyle';
    removeCssButton.innerText = chrome.i18n.getMessage('removeStyle');
    removeCssButton.className = 'cssEditor-footer-button cssEditor-float-left cssEditor-cancel-button';
    removeCssButton.onclick = removeStyle;
    saveButtonsHolder.appendChild(removeCssButton);

    var saveCssButton = document.createElement('button');
    saveCssButton.id = 'cssEditor-saveStyle';
    saveCssButton.innerText = chrome.i18n.getMessage('saveStyle');
    saveCssButton.className = 'cssEditor-footer-button cssEditor-float-right cssEditor-save-button';
    saveCssButton.onclick = saveStyle;
    saveButtonsHolder.appendChild(saveCssButton);

    modalFooter.appendChild(saveButtonsHolder);

    /////////////////////
    // Import, over the top of everything else.
    //
    // Two steps in one panel, because they are two halves of one question. The
    // first takes the file or the pasted text; the second says what importing it
    // would do to the library - what would be added, and what is already here
    // under the same id - before anything is written. An import is the only way
    // a style the user did not touch can change, so it is the one thing on this
    // page that says what it is about to do rather than asking after the fact.

    var importOverlay = document.createElement('div');
    importOverlay.id = 'cssEditor-importOverlay';

    var importDialog = document.createElement('div');
    importDialog.id = 'cssEditor-importDialog';
    importOverlay.appendChild(importDialog);

    var importTitle = document.createElement('div');
    importTitle.id = 'cssEditor-importTitle';
    importTitle.innerText = chrome.i18n.getMessage('styleImportTitle');
    importDialog.appendChild(importTitle);

    var importPickStep = document.createElement('div');
    importPickStep.id = 'cssEditor-importPickStep';

    var importHint = document.createElement('div');
    importHint.className = 'cssEditor-import-note';
    importHint.innerText = chrome.i18n.getMessage('styleImportHint');
    importPickStep.appendChild(importHint);

    // A hidden file input the button opens, rather than a bare file field: the
    // file and the textarea are two ways of handing over the same text, and one
    // of them should not look like the main one.
    var importFileInput = document.createElement('input');
    importFileInput.id = 'cssEditor-importFileInput';
    importFileInput.type = 'file';
    importFileInput.accept = 'application/json,.json';
    importFileInput.style.display = 'none';
    importFileInput.onchange = function () {
        readImportFile(importFileInput.files ? importFileInput.files[0] : null);
    };
    importPickStep.appendChild(importFileInput);

    var importFileButton = document.createElement('button');
    importFileButton.id = 'cssEditor-importFile';
    importFileButton.className = 'cssEditor-chip';
    importFileButton.innerText = chrome.i18n.getMessage('styleImportFromFile');
    importFileButton.onclick = function () {
        // choosing the same file twice in a row is still a change of mind
        importFileInput.value = '';
        importFileInput.click();
    };
    importPickStep.appendChild(importFileButton);

    var importText = document.createElement('textarea');
    importText.id = 'cssEditor-importText';
    importText.spellcheck = false;
    importText.placeholder = chrome.i18n.getMessage('styleImportPastePlaceholder');
    importPickStep.appendChild(importText);

    var importError = document.createElement('div');
    importError.id = 'cssEditor-importError';
    importPickStep.appendChild(importError);

    importDialog.appendChild(importPickStep);

    var importSummary = document.createElement('div');
    importSummary.id = 'cssEditor-importSummary';
    importDialog.appendChild(importSummary);

    var importButtons = document.createElement('div');
    importButtons.id = 'cssEditor-importButtons';

    var importCancelButton = document.createElement('button');
    importCancelButton.id = 'cssEditor-importCancel';
    importCancelButton.className = 'cssEditor-chip';
    importCancelButton.innerText = chrome.i18n.getMessage('cancel');
    importCancelButton.onclick = closeImport;
    importButtons.appendChild(importCancelButton);

    var importReadButton = document.createElement('button');
    importReadButton.id = 'cssEditor-importRead';
    importReadButton.className = 'cssEditor-chip';
    importReadButton.innerText = chrome.i18n.getMessage('styleImportRead');
    importReadButton.onclick = function () {
        readImportText(importText.value);
    };
    importButtons.appendChild(importReadButton);

    // Shown only when something already here would be replaced - the one case
    // where an import can take something away.
    var importReplaceButton = document.createElement('button');
    importReplaceButton.id = 'cssEditor-importReplace';
    importReplaceButton.className = 'cssEditor-chip';
    importReplaceButton.innerText = chrome.i18n.getMessage('styleImportReplace');
    importReplaceButton.onclick = function () {
        applyImport(true);
    };
    importButtons.appendChild(importReplaceButton);

    var importApplyButton = document.createElement('button');
    importApplyButton.id = 'cssEditor-importApply';
    importApplyButton.className = 'cssEditor-chip cssEditor-chip-on';
    importApplyButton.onclick = function () {
        applyImport(false);
    };
    importButtons.appendChild(importApplyButton);

    importDialog.appendChild(importButtons);

    //////////////////////////
    // What is in the list, and in what order.
    //
    // The order is the library's own, which is the order the cascade is worked
    // out from - see selectStylesForUrl. Sorting the list by name would hide the
    // one thing the order means.

    function matchesSearch(entry, text) {
        if (text === '') {
            return true;
        }
        return (entry.title + ' ' + entry.description + ' ' +
                entry.match.pattern + ' ' + entry.css).toLowerCase().indexOf(text) > -1;
    }

    // Whether this style would run on the page the popup was opened on, if it
    // were switched on. Being off is not the same as not applying, and the filter
    // for "off" is the Enabled chip.
    function appliesToTarget(entry) {
        if (styleTargetUrl === '') {
            return false;
        }
        if (entry.scope === 'theme') {
            return true;
        }
        return styleMatchesUrl(entry.match, normalizeUrlForMatch(styleTargetUrl));
    }

    function matchesFilter(entry) {
        if (activeFilter === 'site') {
            return entry.scope === 'site';
        }
        if (activeFilter === 'theme') {
            return entry.scope === 'theme';
        }
        if (activeFilter === 'enabled') {
            return entry.enabled !== false;
        }
        // A fork of a bundled style is the user's: they wrote what it now says.
        // The other chip holds the ones nobody has touched.
        if (activeFilter === 'mine') {
            return entry.origin !== 'builtin';
        }
        if (activeFilter === 'builtin') {
            return entry.origin === 'builtin';
        }
        if (activeFilter === 'matches') {
            return appliesToTarget(entry);
        }
        return true;
    }

    function visibleEntries() {
        let text = searchInput.value.trim().toLowerCase();
        return styleLibrary.entries.filter((entry) => matchesFilter(entry) &&
                                                     matchesSearch(entry, text));
    }

    // The pattern in words. A pattern is a rule about urls, and four kinds of
    // rule that all look like "some text" in a list is exactly the confusion the
    // single regex box used to cause.
    function describeMatch(entry) {
        if (entry.scope === 'theme') {
            return chrome.i18n.getMessage('styleAppliesEveryPage');
        }
        let pattern = entry.match.pattern.trim();
        if (pattern === '') {
            return chrome.i18n.getMessage('stylePatternMissing');
        }
        let keys = {
            domain: 'styleMatchDescDomain',
            prefix: 'styleMatchDescPrefix',
            glob: 'styleMatchDescGlob',
            regex: 'styleMatchDescRegex'
        };
        return chrome.i18n.getMessage(keys[entry.match.type] || keys.regex, [pattern]);
    }

    function describeOrigin(entry) {
        if (entry.origin === 'builtin') {
            return chrome.i18n.getMessage('styleOriginBuiltin');
        }
        // it once was a bundled style, and can be one again
        if (entry.builtinId) {
            return chrome.i18n.getMessage('styleOriginForked');
        }
        if (entry.origin === 'imported') {
            return chrome.i18n.getMessage('styleOriginImported');
        }
        return chrome.i18n.getMessage('styleOriginUser');
    }

    function renderStyleList() {
        // The service worker can take a moment to start, and until it has
        // answered there is no library: an empty list would be a lie, and any
        // change made to it would be written over the real one.
        if (!styleLibrary) {
            return;
        }
        while (styleList.firstChild) {
            styleList.removeChild(styleList.firstChild);
        }

        let entries = visibleEntries();
        if (entries.length === 0) {
            let empty = document.createElement('div');
            empty.id = 'cssEditor-listEmpty';
            empty.innerText = chrome.i18n.getMessage(
                styleLibrary.entries.length === 0 ? 'styleLibraryEmpty' : 'styleListEmpty');
            styleList.appendChild(empty);
            return;
        }

        for (let entry of entries) {
            let row = document.createElement('div');
            // the class the DOM tests count, and what the css lays out
            row.className = 'cssEditor-style-row' +
                            (entry.id === selectedStyleId ? ' cssEditor-style-row-on' : '');
            row.id = 'cssEditor-row-' + entry.id;

            let toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'cssEditor-style-toggle';
            toggle.checked = entry.enabled !== false;
            toggle.title = chrome.i18n.getMessage('styleEnabledHint');
            // A checkbox is not an edit to be saved later: it is the answer to
            // "is this style on", and it is written now.
            toggle.onclick = function (event) {
                event.stopPropagation();
                setStyleEnabled(entry.id, toggle.checked);
            };
            row.appendChild(toggle);

            let text = document.createElement('div');
            text.className = 'cssEditor-style-row-text';

            let name = document.createElement('div');
            name.className = 'cssEditor-style-row-name';
            name.innerText = entry.title.trim() === '' ?
                             chrome.i18n.getMessage('untitledStyle') : entry.title;
            text.appendChild(name);

            let where = document.createElement('div');
            where.className = 'cssEditor-style-row-where';
            where.innerText = describeMatch(entry);
            text.appendChild(where);

            row.appendChild(text);

            let badge = document.createElement('span');
            badge.className = 'cssEditor-badge';
            badge.innerText = describeOrigin(entry);
            row.appendChild(badge);

            row.onclick = function () {
                selectStyle(entry.id);
            };
            styleList.appendChild(row);
        }
    }

    //////////////////////////
    // The detail pane.

    function selectedEntry() {
        if (selectedStyleId === null) {
            return null;
        }
        return styleLibrary.entries.find((entry) => entry.id === selectedStyleId) || null;
    }

    function renderPatternHint() {
        let hints = {
            domain: 'stylePatternHintDomain',
            prefix: 'stylePatternHintPrefix',
            glob: 'stylePatternHintGlob',
            regex: 'stylePatternHintRegex'
        };
        patternInput.placeholder = chrome.i18n.getMessage(
            hints[matchTypeSelect.value] || hints.domain);
    }

    function renderMatchFields() {
        matchHolder.style.display = scopeSelect.value === 'theme' ? 'none' : 'block';
        renderMatchResult();
    }

    // Whether the pattern being typed covers the url in the box. Three answers,
    // not two: a pattern that does not compile matches nothing, and saying "does
    // not match" about a half-typed regex would read as a fact about the url.
    function renderMatchResult() {
        let pattern = patternInput.value.trim();
        let url = testUrlInput.value.trim();
        let state = 'cssEditor-match-none';
        let text = '';

        if (pattern === '') {
            text = chrome.i18n.getMessage('stylePatternMissing');
        } else if (matchTypeSelect.value === 'regex' && !compileRegExp(pattern)) {
            text = chrome.i18n.getMessage('styleTestInvalid');
            state = 'cssEditor-match-bad';
        } else if (url === '') {
            text = chrome.i18n.getMessage('styleTestNoUrl');
        } else {
            let match = {type: matchTypeSelect.value, pattern: pattern};
            let matched = styleMatchesUrl(match, normalizeUrlForMatch(url));
            text = chrome.i18n.getMessage(matched ? 'styleTestMatches' : 'styleTestNoMatch');
            state = matched ? 'cssEditor-match-yes' : 'cssEditor-match-no';
        }

        matchResult.className = state;
        matchResult.innerText = text;
    }

    function renderDetail() {
        let entry = selectedEntry();
        emptyDetail.style.display = entry ? 'none' : 'block';
        detailForm.style.display = entry ? 'flex' : 'none';
        removeCssButton.style.display = entry ? 'inline-block' : 'none';
        saveCssButton.style.display = entry ? 'inline-block' : 'none';

        if (!entry) {
            return;
        }

        nameInput.value = entry.title;
        descriptionInput.value = entry.description;
        scopeSelect.value = entry.scope;
        matchTypeSelect.value = entry.match.type;
        patternInput.value = entry.match.pattern;
        cssInput.value = entry.css;

        originBadge.innerText = describeOrigin(entry);
        // Only where there is something to undo: an untouched bundled style is
        // already what a reset would make it, and the merge keeps it that way.
        resetButton.style.display =
            (entry.origin !== 'builtin' && resetEntryToBuiltin(entry, styleCatalog)) ?
            'inline-block' : 'none';

        renderPatternHint();
        renderMatchFields();
    }

    // renderDetail() is what every path that changes the selection or the boxes
    // ends at, so the preview is brought up to date from here rather than from
    // each of them.
    function renderDetailAndPreview() {
        renderDetail();
        applyPreviewCss();
        renderPickerState();
    }

    function selectStyle(id) {
        if (id !== selectedStyleId && !confirmDiscard()) {
            return;
        }
        selectedStyleId = id;
        unsavedStyleEdits = false;
        renderStyleList();
        renderDetailAndPreview();
    }

    function confirmDiscard() {
        if (!unsavedStyleEdits) {
            return true;
        }
        return confirm(chrome.i18n.getMessage('styleDiscardEditsConfirm'));
    }

    //////////////////////////
    // The preview, and picking in it.

    var previewFrame = null;
    var pickerSession = null;

    // Everything the recipes and the picker write goes through here, so that a
    // style being built by clicking is dirty and previewed on exactly the same
    // terms as one being typed.
    function appendCss(css) {
        if (!selectedEntry()) {
            return;
        }
        let current = cssInput.value;
        cssInput.value = current === '' || /\n\s*$/.test(current) ?
                         current + css : current + '\n' + css;
        markEdited();
        applyPreviewCss();
    }

    // The style being edited as it stands in the boxes, rather than as it was
    // stored. It is what the preview has to show - the point of the pane is to
    // answer "what does this do" before it is saved - and what an export writes,
    // for the same reason.
    function draftEntry() {
        let entry = selectedEntry();
        if (!entry) {
            return null;
        }
        return Object.assign({}, entry, {
            title: nameInput.value,
            description: descriptionInput.value,
            scope: scopeSelect.value,
            match: {type: matchTypeSelect.value, pattern: patternInput.value},
            css: cssInput.value
        });
    }

    // The styles the frame should be showing, in the order they would be injected
    // - selectStylesForUrl decides that, here as during a capture, so that the
    // preview cannot disagree with the cascade about which style wins.
    //
    // The style being edited is added even when it matches nothing and even when
    // it is switched off, because it is the one the user is looking at; that it
    // would not run yet is what the pattern's own match indicator is for.
    function previewStyles() {
        if (!styleSnapshot || !styleLibrary) {
            return [];
        }
        let draft = draftEntry();
        let library = draft ? putStyleEntry(styleLibrary, draft) : styleLibrary;
        let selected = selectStylesForUrl(styleSnapshot.url, library);
        if (draft && draft.css.trim() !== '' &&
            !selected.some((entry) => entry.id === draft.id)) {
            selected = selected.concat([draft]);
        }
        return selected;
    }

    function previewCss() {
        return previewStyles().map((entry) => entry.css).join('\n');
    }

    function renderAppliedStyles() {
        let names = previewStyles().map((entry) => entry.title.trim() === '' ?
                                                   chrome.i18n.getMessage('untitledStyle') :
                                                   entry.title);
        previewApplied.innerText = names.length === 0 ?
            chrome.i18n.getMessage('stylePreviewNothingApplies') :
            chrome.i18n.getMessage('stylePreviewApplied', [names.join(' + ')]);
    }

    function previewDocument() {
        try {
            return previewFrame ? previewFrame.contentDocument : null;
        } catch (e) {
            return null;
        }
    }

    // Replaces the sheet in the open frame rather than rebuilding the document:
    // rebuilding reloads the frame, which would lose the scroll position and the
    // picking session on every keystroke.
    function applyPreviewCss() {
        setPreviewStyle(previewDocument(), PREVIEW_SITE_CSS_ID, previewCss());
        renderAppliedStyles();
    }

    function clearPreviewFrame() {
        if (pickerSession) {
            pickerSession.destroy();
            pickerSession = null;
        }
        previewFrame = null;
        while (previewBody.firstChild) {
            previewBody.removeChild(previewBody.firstChild);
        }
    }

    function renderPreview() {
        clearPreviewFrame();

        let hasSnapshot = !!(styleSnapshot && styleSnapshot.page);
        previewSource.innerText = hasSnapshot ?
            chrome.i18n.getMessage('stylePreviewOf', [styleSnapshot.url || '']) : '';
        previewClear.style.display = hasSnapshot ? 'inline-block' : 'none';
        pickerBar.style.display = hasSnapshot ? 'flex' : 'none';
        previewNote.style.display = hasSnapshot ? 'block' : 'none';

        if (!hasSnapshot) {
            let empty = document.createElement('div');
            empty.id = 'cssEditor-previewEmpty';
            empty.innerText = chrome.i18n.getMessage('stylePreviewHowTo');
            previewBody.appendChild(empty);
            previewApplied.innerText = '';
            renderPickerState();
            return;
        }

        let preview = buildChapterPreview(styleSnapshot.page, {siteCss: previewCss()});
        renderAppliedStyles();

        if (preview.html === '') {
            let empty = document.createElement('div');
            empty.id = 'cssEditor-previewEmpty';
            empty.innerText = chrome.i18n.getMessage('previewEmpty');
            previewBody.appendChild(empty);
            renderPickerState();
            return;
        }

        let frame = document.createElement('iframe');
        frame.id = 'cssEditor-previewFrame';
        // No allow-scripts, which is the flag that matters: the snapshot has been
        // through the same sanitizer a chapter has, so it carries no script, no
        // event handler and no javascript: url - and the sandbox is what still
        // holds the day one of those stops being true. allow-same-origin grants
        // the frame's content nothing, there being no content that can run, and
        // it is what lets this page hover and click inside it.
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.onload = function () {
            startPicker(frame);
        };
        frame.srcdoc = preview.html;
        previewBody.appendChild(frame);
        previewFrame = frame;
        renderPickerState();
    }

    function startPicker(frame) {
        try {
            pickerSession = createStylePickerSession(frame.contentDocument, {
                onPick: onElementPicked,
                onHover: renderPickTarget,
                // escape inside the frame never reaches the page's own handler,
                // and while picking it means "stop picking" rather than "close"
                onEscape: function () {
                    if (pickerSession && pickerSession.isActive()) {
                        setPicking(false);
                    } else {
                        closeModal();
                    }
                }
            });
        } catch (e) {
            // The preview is worth keeping without the picker - it is the half
            // that answers a question on its own.
            console.log('Error:', e);
            pickerSession = null;
        }
        renderPickerState();
    }

    function onElementPicked(selector, matches) {
        if (!selectedEntry()) {
            alert(chrome.i18n.getMessage('stylePickNeedsStyle'));
            setPicking(false);
            return;
        }
        appendCss(hideRuleFor(selector));
    }

    function renderPickTarget(label) {
        if (!label || !label.selector) {
            pickTarget.innerText = pickerSession && pickerSession.isActive() ?
                chrome.i18n.getMessage('stylePickHint') : '';
            pickTarget.className = '';
            return;
        }
        pickTarget.innerText = label.matches > 1 ?
            chrome.i18n.getMessage('stylePickTargetShared',
                                   [label.selector, String(label.matches)]) :
            chrome.i18n.getMessage('stylePickTarget', [label.selector]);
        pickTarget.className = label.matches > 1 ? 'cssEditor-pick-shared' : '';
    }

    function setPicking(on) {
        if (!pickerSession) {
            return;
        }
        pickerSession.setActive(on);
        renderPickerState();
    }

    // Picking writes into the css box, so it needs a style to write into. The
    // button says so rather than being silently inert.
    function renderPickerState() {
        let picking = !!(pickerSession && pickerSession.isActive());
        let usable = !!pickerSession && !!selectedEntry();
        pickButton.className = 'cssEditor-chip' + (picking ? ' cssEditor-chip-on' : '');
        pickButton.disabled = !usable;
        pickButton.title = selectedEntry() ? '' : chrome.i18n.getMessage('stylePickNeedsStyle');
        widenButton.disabled = !picking;
        narrowButton.disabled = !picking;
        renderPickTarget(pickerSession ? pickerSession.hoverLabel() : null);
    }

    function discardSnapshot() {
        if (!confirm(chrome.i18n.getMessage('stylePreviewClearConfirm'))) {
            return;
        }
        styleSnapshot = null;
        clearStyleSnapshot();
        renderPreview();
    }

    //////////////////////////
    // Changing the library. Every one of these writes.

    function persist(callback) {
        saveStyleLibrary(styleLibrary, callback);
    }

    // Every write goes through here, which is also every way the set of styles
    // the preview is composing can change - a checkbox turned off is a sheet that
    // has to come out of the frame.
    //
    // The boxes are only refilled when there is nothing in them to lose. A
    // checkbox in the list writes immediately, and it is not an answer to "throw
    // away what you have typed" - the callers that do mean that (save, reset,
    // duplicate, delete, new) clear the flag before they get here.
    function replaceLibrary(library) {
        styleLibrary = library;
        persist();
        renderStyleList();
        if (unsavedStyleEdits) {
            applyPreviewCss();
            renderPickerState();
            return;
        }
        renderDetailAndPreview();
    }

    function setStyleEnabled(id, enabled) {
        let entry = styleLibrary.entries.find((existing) => existing.id === id);
        if (!entry) {
            return;
        }
        replaceLibrary(putStyleEntry(styleLibrary,
                                    Object.assign({}, entry, {enabled: enabled})));
    }

    // A new style exists as soon as it is asked for, rather than being a draft
    // that only appears in the list once saved: the list is the library, and a
    // style being written that is not in it is a fourth state to explain. It can
    // do nothing until it is saved anyway - a site style with no pattern matches
    // nothing, and a style with no css is skipped.
    function createStyle(scope) {
        if (!styleLibrary || !confirmDiscard()) {
            return;
        }
        let entry = newStyleEntry(scope);
        entry.title = chrome.i18n.getMessage('newStyleTitle');
        // the domain of the page the popup was opened on, which is what a site
        // style is nearly always being written for
        if (scope === 'site' && styleTargetUrl !== '') {
            entry.match = {type: 'domain', pattern: urlHost(normalizeUrlForMatch(styleTargetUrl))};
        }
        selectedStyleId = entry.id;
        unsavedStyleEdits = false;
        replaceLibrary(putStyleEntry(styleLibrary, entry));
    }

    function duplicateSelected() {
        let entry = selectedEntry();
        if (!entry) {
            return;
        }
        let copy = duplicateStyleEntry(entry, chrome.i18n.getMessage(
            'styleCopyTitle', [entry.title.trim() === '' ?
                               chrome.i18n.getMessage('untitledStyle') : entry.title]));
        // next to the style it came from: a copy at the end of the library would
        // also be a copy that lands after everything in the cascade
        let entries = styleLibrary.entries.slice();
        entries.splice(entries.indexOf(entry) + 1, 0, copy);
        selectedStyleId = copy.id;
        unsavedStyleEdits = false;
        replaceLibrary(normalizeStyleLibrary({
            version: styleLibrary.version,
            entries: entries,
            removedBuiltins: styleLibrary.removedBuiltins
        }));
    }

    function resetSelected() {
        let entry = selectedEntry();
        if (!entry) {
            return;
        }
        let restored = resetEntryToBuiltin(entry, styleCatalog);
        if (!restored) {
            return;
        }
        if (!confirm(chrome.i18n.getMessage('styleResetConfirm'))) {
            return;
        }
        unsavedStyleEdits = false;
        replaceLibrary(putStyleEntry(styleLibrary, restored));
    }

    function saveStyle() {
        let entry = selectedEntry();
        if (!entry) {
            return;
        }

        let scope = scopeSelect.value;
        let pattern = patternInput.value.trim();

        // Two ways to write a style that can never run, both worth stopping at
        // the point where the user still has the pattern in front of them.
        if (scope === 'site' && pattern === '') {
            alert(chrome.i18n.getMessage('styleNeedsPattern'));
            return;
        }
        if (scope === 'site' && matchTypeSelect.value === 'regex' && !compileRegExp(pattern)) {
            alert(chrome.i18n.getMessage('invalidRegex'));
            return;
        }

        let edited = Object.assign({}, entry, {
            title: nameInput.value,
            description: descriptionInput.value,
            scope: scope,
            // the pattern is kept as typed for a theme rather than cleared: a
            // style flipped to every-page and back should still know what site it
            // was written for
            match: {type: matchTypeSelect.value, pattern: patternInput.value},
            css: cssInput.value
        });

        unsavedStyleEdits = false;
        replaceLibrary(putStyleEntry(styleLibrary, edited));
        alert(chrome.i18n.getMessage('styleSaved'));
    }

    function removeStyle() {
        let entry = selectedEntry();
        if (!entry) {
            return;
        }
        if (confirm(chrome.i18n.getMessage('confirmDeleteStyle')) !== true) {
            return;
        }
        selectedStyleId = null;
        unsavedStyleEdits = false;
        replaceLibrary(removeStyleEntry(styleLibrary, entry.id));
    }

    //////////////////////////
    // Out of the library and back into it.

    function downloadStyles(entries, fileName) {
        // Indented, because a style file is meant to be opened and read: it is
        // css with a few fields around it, and somebody handed one is entitled
        // to see what it says before importing it.
        downloadBlob(new Blob([JSON.stringify(styleExportDocument(entries), null, 4)],
                              {type: 'application/json'}), fileName);
    }

    // What is on screen rather than what is stored, so that exporting a style
    // the user has just changed writes the style they are looking at. Same
    // reasoning as the preview, which composes the draft for the same reason.
    function exportSelected() {
        let draft = draftEntry();
        if (!draft) {
            return;
        }
        downloadStyles([draft], styleExportFileName(draft.title));
    }

    function exportLibrary() {
        if (!styleLibrary || styleLibrary.entries.length === 0) {
            alert(chrome.i18n.getMessage('styleExportNothing'));
            return;
        }
        downloadStyles(styleLibrary.entries, styleExportFileName(''));
    }

    // What has been read and not yet written, or null while the panel is asking
    // for a file. The two buttons at the bottom are the two answers to it.
    var importPlan = null;

    function openImport() {
        // Same guard as making a style: until the service worker has answered
        // there is no library to import into, and writing one now would write
        // over whatever it is about to hand back.
        if (!styleLibrary) {
            return;
        }
        importPlan = null;
        importText.value = '';
        importError.innerText = '';
        importOverlay.style.display = 'flex';
        renderImportStep();
        importText.focus();
    }

    function closeImport() {
        importOverlay.style.display = 'none';
        importPlan = null;
    }

    function importIsOpen() {
        return importOverlay.style.display === 'flex';
    }

    function renderImportStep() {
        let reading = importPlan === null;
        importPickStep.style.display = reading ? 'block' : 'none';
        importSummary.style.display = reading ? 'none' : 'block';
        importReadButton.style.display = reading ? 'inline-block' : 'none';
        importApplyButton.style.display = reading ? 'none' : 'inline-block';
        importReplaceButton.style.display =
            !reading && importPlan.collisions.length > 0 ? 'inline-block' : 'none';

        if (!reading) {
            // With something to replace, the plain button is the other answer to
            // that - "keep both" - rather than an unqualified "import".
            importApplyButton.innerText = chrome.i18n.getMessage(
                importPlan.collisions.length > 0 ? 'styleImportKeepBoth' : 'styleImportApply');
        }
    }

    function readImportFile(file) {
        if (!file) {
            return;
        }
        let reader = new FileReader();
        reader.onload = function () {
            importText.value = typeof reader.result === 'string' ? reader.result : '';
            // Choosing a file is not an ambiguous act - there is nothing to
            // confirm about it, so it goes straight to what the file would do.
            readImportText(importText.value);
        };
        reader.onerror = function () {
            importError.innerText = chrome.i18n.getMessage('styleImportUnreadableFile');
        };
        reader.readAsText(file);
    }

    function readImportText(text) {
        if (String(text).trim() === '') {
            importError.innerText = chrome.i18n.getMessage('styleImportNothingPasted');
            return;
        }

        let result = readStyleImport(text);
        if (result.error !== '') {
            importError.innerText = chrome.i18n.getMessage(
                result.error === 'empty' ? 'styleImportNoStyles' : 'styleImportNotAStyleFile');
            return;
        }

        importError.innerText = '';
        let plan = planStyleImport(styleLibrary, result.entries);
        importPlan = {
            entries: result.entries,
            additions: plan.additions,
            collisions: plan.collisions,
            stripped: result.stripped
        };
        renderImportSummary();
        renderImportStep();
    }

    function importStyleName(entry) {
        return entry.title.trim() === '' ?
               chrome.i18n.getMessage('untitledStyle') : entry.title;
    }

    // The panel's second half: what would be added, what would be replaced and
    // by what, and what was taken out of the css on the way in.
    function renderImportSummary() {
        while (importSummary.firstChild) {
            importSummary.removeChild(importSummary.firstChild);
        }

        let section = (titleText, className) => {
            let holder = document.createElement('div');
            holder.className = 'cssEditor-import-section' + (className ? ' ' + className : '');
            let heading = document.createElement('div');
            heading.className = 'cssEditor-import-heading';
            heading.innerText = titleText;
            holder.appendChild(heading);
            importSummary.appendChild(holder);
            return holder;
        };

        let line = (holder, text, className) => {
            let row = document.createElement('div');
            row.className = 'cssEditor-import-line' + (className ? ' ' + className : '');
            row.innerText = text;
            holder.appendChild(row);
        };

        if (importPlan.additions.length > 0) {
            let holder = section(chrome.i18n.getMessage('styleImportAdding',
                                                       [String(importPlan.additions.length)]));
            for (let entry of importPlan.additions) {
                line(holder, importStyleName(entry) + ' - ' + describeMatch(entry));
            }
        }

        if (importPlan.collisions.length > 0) {
            let holder = section(chrome.i18n.getMessage('styleImportCollisions',
                                                       [String(importPlan.collisions.length)]),
                                 'cssEditor-import-warn');
            for (let collision of importPlan.collisions) {
                line(holder, importStyleName(collision.incoming));
                // The two sides of it, so that "replace" is a choice between two
                // things the user can see rather than a leap.
                line(holder, chrome.i18n.getMessage('styleImportHere',
                        [importStyleName(collision.existing), describeMatch(collision.existing)]),
                     'cssEditor-import-side');
                line(holder, chrome.i18n.getMessage('styleImportIncoming',
                        [describeMatch(collision.incoming),
                         collision.incoming.css === collision.existing.css ?
                             chrome.i18n.getMessage('styleImportSameCss') :
                             chrome.i18n.getMessage('styleImportDifferentCss')]),
                     'cssEditor-import-side');
            }
        }

        // Not a footnote: this is css the file asked to run on the user's pages
        // and did not get to. See stripRemoteCssReferences.
        if (importPlan.stripped.length > 0) {
            let holder = section(chrome.i18n.getMessage('styleImportStripped'),
                                 'cssEditor-import-warn');
            line(holder, chrome.i18n.getMessage('styleImportStrippedWhy'),
                 'cssEditor-import-side');
            for (let entry of importPlan.stripped) {
                for (let reference of entry.references) {
                    line(holder, importStyleName(entry) + ': ' + reference,
                         'cssEditor-import-side');
                }
            }
        }
    }

    function applyImport(replaceExisting) {
        if (!importPlan) {
            return;
        }
        // An import writes several styles at once, so the pane is refilled from
        // what was written rather than from what was being typed into it.
        if (!confirmDiscard()) {
            return;
        }

        let imported = applyStyleImport(styleLibrary, importPlan.entries, replaceExisting);
        closeImport();
        unsavedStyleEdits = false;
        // the first of them as it was actually stored, so that an import is
        // followed by looking at what arrived rather than at an empty pane
        selectedStyleId = imported.entries[0].id;
        replaceLibrary(imported.library);
        alert(chrome.i18n.getMessage('styleImported', [String(imported.entries.length)]));
    }

    /////////////////////

    var modal = document.createElement('div');
    modal.id = 'cssEditor-Modal';

    modalContent.appendChild(modalHeader);
    modalContent.appendChild(modalList);
    modalContent.appendChild(modalFooter);
    modal.appendChild(modalContent);
    modal.appendChild(importOverlay);

    body.appendChild(modal);

    window.onclick = function(event) {
        // the backdrop of whichever is on top
        if (event.target == importOverlay) {
            closeImport();
            return;
        }
        if (event.target == modal) {
            closeModal();
        }
    };

    document.onkeydown = function(evt) {
        evt = evt || window.event;
        if (evt.keyCode != 27) {
            return;
        }
        // escape means "close the thing in front of me", and the import panel is
        // in front of the page whenever it is open
        if (importIsOpen()) {
            closeImport();
            return;
        }
        closeModal();
    };

    function closeModal() {
        // the editor is the whole tab now, so closing it closes the tab
        if (!confirmDiscard()) {
            return;
        }
        window.close();
    }

    /////////////////////
    // Nothing above has a library to draw until this comes back, so the panes
    // start empty and are rendered once.
    //
    // The snapshot is fetched inside the library's callback rather than beside
    // it: the preview composes the styles that would apply, so it cannot be built
    // before there are styles to compose. It is the larger of the two reads by
    // far - a captured page, with its images - and this is the only place that
    // waits on it.

    getStyleLibrary(function (library, catalog) {
        styleLibrary = library || normalizeStyleLibrary(null);
        styleCatalog = catalog || {entries: []};
        renderStyleList();
        renderDetail();

        getStyleSnapshot(function (snapshot) {
            styleSnapshot = snapshot;
            // Opened from "Style this page ...", so the style being written is
            // the one for the page in the frame: prefilling the box from the
            // snapshot saves the one step the whole flow exists to remove.
            if (styleTargetUrl === '' && snapshot && snapshot.url) {
                styleTargetUrl = snapshot.url;
                testUrlInput.value = snapshot.url;
                renderMatchResult();
            }
            renderPreview();
        });
    });
}
