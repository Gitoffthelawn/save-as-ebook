// The chapter outline: heading ids, the title heading, and the tree the nav and
// the ncx are both rendered from.
//
//   node outline.js
//
// check-epub.js already validates the outline as it comes out of a real build,
// but only for the shapes the fixtures have. What is checked here is what a
// scraped page does that a fixture cannot: ids the source already carries and
// the ways they collide with the ones minted here, links into a chapter whose
// target did not survive extraction, headings used as layout, and titles that
// carry a site name the heading does not.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'web-extension');

const sandbox = {
    console: console,
    setInterval: () => 0,
    clearInterval: () => {},
    chrome: {runtime: {onMessage: {addListener: () => {}}, sendMessage: () => {}, lastError: null}}
};
vm.createContext(sandbox);
for (const file of ['utils.js', 'saveEbook.js']) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), sandbox, {filename: file});
}

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : ''));
    if (!ok) failures++;
}
function eq(name, actual, expected) {
    check(name, actual === expected,
          actual === expected ? '' : 'got ' + JSON.stringify(actual) +
                                     ' wanted ' + JSON.stringify(expected));
}

const outlineOf = (title, content, index) =>
    sandbox.buildChapterOutline({title: title, content: content}, index || 0);

// ---- ids --------------------------------------------------------------------

let outline = outlineOf('Chapter', '<h2>One</h2><p>x</p><h3>Two</h3>');
eq('every heading is in the outline', outline.headings.length, 2);
eq('levels are read from the tag', outline.headings.map((h) => h.level).join(','), '2,3');
eq('generated ids are per chapter', outline.headings[0].id, 'sae-c0-h0');
check('the ids are written into the content',
      outline.content.indexOf('<h2 id="sae-c0-h0">One</h2>') > -1, outline.content);

eq('a second chapter cannot collide with the first',
   outlineOf('Chapter', '<h2>One</h2>', 1).headings[0].id, 'sae-c1-h0');

// A heading with no text has nothing to show in the nav, so it is left alone
// rather than given an id nothing points at.
outline = outlineOf('Chapter', '<h2>  </h2><h2>Real</h2>');
eq('an empty heading is not an outline entry', outline.headings.length, 1);
check('an empty heading is left untouched', outline.content.indexOf('<h2>  </h2>') > -1,
      outline.content);

// An id the page already carries is what any link inside that page points at.
outline = outlineOf('Chapter', '<h2 id="results">One</h2>');
eq('an existing id is kept', outline.headings[0].id, 'results');

// ...but only if it can be addressed at all. The replacement has to remove the
// old attribute: two id attributes on one element is not well-formed XML.
outline = outlineOf('Chapter', '<h2 id="2 bad">One</h2>');
eq('an id that is not an XML name is replaced', outline.headings[0].id, 'sae-c0-h0');
eq('the unusable id is removed rather than left beside the new one',
   (outline.content.match(/\sid="/g) || []).length, 1);

outline = outlineOf('Chapter', '<h2 id="dup">One</h2><h3 id="dup">Two</h3>');
eq('a duplicate id is replaced', outline.headings[1].id, 'sae-c0-h1');
check('the replacement leaves one id per heading',
      /<h3 id="sae-c0-h1">Two<\/h3>/.test(outline.content), outline.content);

// A page is free to use the name a minted id would have taken. Every id in the
// chapter is collected before any is minted, so the heading gets the next name
// that is free rather than the one already spoken for.
outline = outlineOf('Chapter', '<p id="sae-c0-h0">not a heading</p><h2>One</h2>');
eq('a minted id does not land on one the page already used',
   outline.headings[0].id, 'sae-c0-h0-2');
eq('and the page keeps the id it had',
   (outline.content.match(/id="sae-c0-h0"/g) || []).length, 1);

// ---- links into the chapter -------------------------------------------------

// Extraction writes a same-document link as a bare fragment. It survives only
// if the element it names is still here.
outline = outlineOf('Chapter',
                    '<p id="note-1">a footnote</p><p><a href="#note-1">go</a></p>');
check('a link to a surviving element keeps its href',
      outline.content.indexOf('<a href="#note-1">go</a>') > -1, outline.content);

// The target was outside the selection, or inside something extraction drops
// whole. An unresolved fragment is an epubcheck error, so the href goes.
outline = outlineOf('Chapter', '<p><a href="#gone">go</a></p>');
check('a link to nothing loses its href rather than dangling',
      outline.content.indexOf('<a>go</a>') > -1, outline.content);

outline = outlineOf('Chapter', '<h2>One</h2><p><a href="#sae-c0-h0">up</a></p>');
check('a link to an id minted moments ago resolves',
      outline.content.indexOf('<a href="#sae-c0-h0">up</a>') > -1, outline.content);

outline = outlineOf('Chapter', '<p><a class="x" href="#gone" lang="fr">go</a></p>');
check('only the href goes - the other attributes stay',
      outline.content.indexOf('<a class="x" lang="fr">go</a>') > -1, outline.content);

outline = outlineOf('Chapter', '<p><a href="https://example.com/#gone">go</a></p>');
check('a fragment on another document is not ours to resolve',
      outline.content.indexOf('href="https://example.com/#gone"') > -1, outline.content);

// ---- labels -----------------------------------------------------------------

outline = outlineOf('Chapter', '<h2>A <em>nested</em>   heading</h2>');
eq('markup inside a heading is dropped and whitespace collapsed',
   outline.headings[0].label, 'A nested heading');

// The content is already escaped, so the label goes into the nav as it is - and
// truncating it must not cut an entity in half.
const long = 'x'.repeat(198) + ' &amp; more';
outline = outlineOf('Chapter', '<h2>' + long + '</h2>');
check('a long label is truncated', outline.headings[0].label.length <= 201,
      String(outline.headings[0].label.length));
check('truncation never cuts inside an entity',
      !/&[a-z]*$/.test(outline.headings[0].label.replace(/…$/, '')),
      outline.headings[0].label.slice(-12));

// ---- the title heading ------------------------------------------------------

check('a heading repeating the title is the chapter heading',
      outlineOf('The Article', '<h1>The Article</h1><h2>One</h2>').hasTitleHeading);
check('...and is not listed again inside the chapter',
      outlineOf('The Article', '<h1>The Article</h1><h2>One</h2>').headings.length === 1);

// what document.title almost always looks like next to the page's own <h1>
check('a title carrying the site name still matches the heading',
      outlineOf('The Article - Wikipedia', '<h1>The Article</h1>').hasTitleHeading);
check('...with an em dash separator too',
      outlineOf('The Article — Some Blog', '<h1>The Article</h1>').hasTitleHeading);
check('...and ignoring case and trailing punctuation',
      outlineOf('the article.', '<h1>The Article</h1>').hasTitleHeading);

// escapeXMLText leaves quotes alone, escapeXMLChars does not, so the two sides
// of the comparison are escaped differently
check('an apostrophe does not break the comparison',
      outlineOf("Alex's Article", "<h1>Alex's Article</h1>").hasTitleHeading);
check('an ampersand does not break the comparison',
      outlineOf('Tom & Jerry', '<h1>Tom &amp; Jerry</h1>').hasTitleHeading);

check('an unrelated heading is not taken for the title',
      !outlineOf('The Article', '<h1>Something else entirely</h1>').hasTitleHeading);
// only the first heading can be the chapter's own title
check('a matching heading further down is not the title',
      !outlineOf('The Article', '<h1>Intro</h1><h2>The Article</h2>').hasTitleHeading);

// ---- the tree ---------------------------------------------------------------

const nodesFor = (levels) => sandbox.headingsToNavNodes(
    levels.map((level, i) => ({level: level, id: 'h' + i, label: 'H' + i})), 'p.xhtml');

let nodes = nodesFor([1, 2, 2, 1]);
eq('siblings stay siblings', nodes.length, 2);
eq('deeper headings nest', nodes[0].children.length, 2);
eq('a node knows its target', nodes[0].children[0].href, 'p.xhtml#h1');

// h1 then h3 is a page's layout decision, not a missing level: what the nav
// needs is relative depth
nodes = nodesFor([1, 3, 2]);
eq('a skipped level nests rather than being promoted', nodes[0].children.length, 2);
eq('and the level after it closes back up', nodes.length, 1);

// a chapter whose headings all start deeper than h1 is still a flat list
eq('the shallowest level in the chapter is the top level', nodesFor([3, 3, 3]).length, 3);

eq('depth of a flat list', sandbox.navTreeDepth(nodesFor([2, 2])), 1);
eq('depth of a nested list', sandbox.navTreeDepth(nodesFor([1, 2, 3])), 3);
eq('depth of nothing', sandbox.navTreeDepth([]), 0);

// A page that uses headings as layout would otherwise put a second copy of
// itself in the nav.
const many = Array.from({length: 260}, (unused, i) => '<h2>H' + i + '</h2>').join('');
outline = outlineOf('Chapter', many);
eq('the number of headings per chapter is capped', outline.headings.length, 200);
check('headings past the cap are left as they were',
      outline.content.indexOf('<h2>H259</h2>') > -1);

console.log(failures === 0 ? '\noutline OK' : '\n' + failures + ' outline failure(s)');
process.exit(failures === 0 ? 0 : 1);
