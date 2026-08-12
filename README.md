# save-as-ebook

Save a web page/selection as an eBook (.epub format) - a Chrome/Firefox Web Extension

<img src="https://github.com/alexadam/save-as-ebook/blob/master/imgs/menu.png?raw=true" width="350">

## How to install it

### From [Chrome Web Store](https://chrome.google.com/webstore/detail/save-as-ebook/haaplkpoiimngbppjihnegfmpejdnffj)

or manually

```
1. Navigate to chrome://extensions/
2. Load unpacked extension ...
3. Select the extension's directory
```

### From [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/saveasebook/)

or manually

```
1. Navigate to about:debugging
2. Load temporary add-on ...
3. Select the extension's directory
```

## How to use Save as Ebook

### The main menu

![alt menu.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/menu.png?raw=true)

| | |
| --- | --- |
| **Keep the page's colours and fonts** | Carries the page's own look into the book (colours, fonts, borders, lists, alignment), so code, tables and pull quotes still look like they did. Off, the book is plain text laid out by the reading system. |
| **Apply Readability.js** | Keeps only the article, dropping navigation, sidebars and comments. Applies to Save Page and Add Page as Chapter only; pages that are not articles are saved whole. |
| **Review Before Saving** | Opens Save Page and Save Selection in the chapter editor instead of downloading straight away, so the book can be previewed, edited and described first. The editor's Generate button saves the file. |
| **Style Library ...** | Opens the library of CSS applied to pages *while they are captured*, so what is saved is the page without its banners and sidebars. The line beneath the button lists the styles the current page would take. |
| **Capture this page first** | Takes a copy of the current page for the library to preview against, which also allows picking an element by clicking it. This is a capture, so it takes as long as saving does. Clear it to open the library straight away on the last page captured. |
| **Save Page** | Saves the whole page as a one-chapter eBook. |
| **Save Selection** | Saves only what is selected on the page as a one-chapter eBook. |
| **Add Page as Chapter** | Appends the whole page to the book being collected, without downloading anything yet. |
| **Add Selection as Chapter** | Appends only the selection to the book being collected. |
| **Edit Chapters ...** | Opens the chapter editor with everything collected so far: reorder, rename, edit and style the chapters, set the book's details, then generate the .epub. |


### Save Page and Save Selection

These two make a book on their own, of one chapter, rather than adding to the
book being collected. Each of them starts a new book, so anything gathered with
**Add Page as Chapter** or **Add Selection as Chapter** and not yet generated is
discarded when one of them runs.

**Save Page** takes the page you are on, in full. If **Apply Readability.js** is
on, only the article is kept and the navigation, sidebars and comments are
dropped; on a page that is not an article the whole page is saved and you are
told that is what happened.

**Save Selection** takes only what is selected on the page, so make the selection
first: with nothing selected the save stops and says the selection is empty.
Readability.js is not applied here, because a selection is already you saying
what the content is.

Both of them capture the page through whatever styles the **Style Library** has
switched on for that address, and both carry the page's own colours and fonts
into the book if **Keep the page's colours and fonts** is ticked.

![alt save-selection.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/save-selection.png?raw=true)

**Without Review Before Saving**, the .epub is built and downloaded as soon as
the page has been read, with no further questions. The file is named after the
page's title, or `eBook.epub` if the page has no title. Nothing is kept
afterwards, so the next save starts from a clean sheet.

**With Review Before Saving**, nothing is downloaded. The chapter is opened in
the chapter editor in a new tab, where you can:

 - see the chapter as the eBook will show it,
 - click anything left over and remove it,
 - edit the text, to fix a typo or reword a caption,
 - fill in the book's details: title, authors, language, publisher, date and
   description, left blank to be taken from the page as before,
 - write a stylesheet for the whole book, and separately CSS for this one
   chapter.

The **Generate** button in the editor is what writes the file. The book is
already named after the page, so a review you make no changes to produces the
same file the immediate save would have. Close the tab without generating and
the chapter stays where it is: **Edit Chapters ...** opens it again, and
**Add Page as Chapter** appends to it.

![alt review-before.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/review-before-saving.png?raw=true)

The keyboard shortcuts for saving a page and a selection go the same way, so
they follow this setting too.


### Add Page as Chapter, Add Selection as Chapter and Edit Chapters

These three build a book out of several pages. **Add Page as Chapter** and **Add
Selection as Chapter** put one page, or one selection, at the end of the book
being collected and tell you it went in. Nothing is downloaded and no window
opens, so you can walk through a series of articles, adding each as you go.
Both read the page the same way [Save Page and Save Selection](#save-page-and-save-selection)
do: the styles the **Style Library** has switched on for the address are applied
first, **Keep the page's colours and fonts** decides whether the page's own look
comes with it, and **Apply Readability.js** narrows a page to its article but
leaves a selection alone. Adding with nothing selected stops and says the
selection is empty.

The chapters wait in the extension, not in a file. They survive closing the tab
and closing the browser, and they stay there until you generate the book, remove
them, or run **Save Page** or **Save Selection**, which start a new book and
discard what was collected.

**Edit Chapters ...** opens all of it in a tab of its own. It is the same editor
[Review Before Saving](#save-page-and-save-selection) opens, holding a whole book
rather than one page.

![alt chapter-editor.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/chapter-editor.png?raw=true)

| | |
| --- | --- |
| **eBook Title** | What the book is called, and what the file is named after. Left empty, the book is called `eBook`. |
| **eBook Stylesheet** | Folded away until you open it. CSS for the whole book, every chapter of it. Not the same as the Style Library, which cleans up pages on the way in. |
| **eBook Details** | Also folded away. Authors, language, publisher, date and description for the book. A field left empty shows in grey what would be taken from the chapters instead, which is what will be used. |
| The chapter rows | One per chapter, in the order they will be bound. Drag the handle on the left to reorder them, and type in the box to rename one, which renames it in the table of contents. |
| **Preview** | Opens that chapter on its own, to read it, edit it, style it and describe it. See [The Preview dialog](#the-preview-dialog). |
| **Remove** | Takes one chapter out, after asking. It goes when the changes are saved. |
| **Cancel** | Closes the tab and keeps everything as it was when it opened. |
| **Remove Chapters** | Throws away the whole collection, after asking: the chapters, the title, the stylesheet and the details. |
| **Save changes** | Writes the order, the names, the title, the stylesheet and the details, says so, and closes the tab. The chapters stay where they are, ready to be added to. |
| **Generate eBook ...** | Saves all of that and then builds the .epub and downloads it. An empty book is refused. |

Generating does not empty the collection. The chapters are still there
afterwards, so a book can be generated, read, then corrected and generated
again. Use **Remove Chapters** when you want to start the next one from nothing.

### The Preview dialog

Every chapter row in the editor has a **Preview** button, which opens the chapter
over the list. The page it shows is built by the same code that writes the book,
so what you are looking at is the chapter as it will be packaged. Pagination,
fonts and margins are not in it: those belong to the reading system and differ
between devices.

The dialog is also where a chapter is edited, and the rendering is the editing
surface, so what you remove is the thing you saw. The toolbar shows only the
buttons the current mode can use, and the line under it says what the mode does
and, while removing, names the element a click is about to take.

![alt page-preview.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/page-preview.png?raw=true)

| | |
| --- | --- |
| **X** | Closes the dialog. Content edits, chapter CSS and chapter details all live in the dialog until they are saved, so if any of them are unsaved you are asked before they go. Escape and a click on the background outside the dialog do the same thing. |
| **View** | Reading mode, where nothing can be changed by accident. Clicks on links inside the chapter go nowhere. |
| **Remove elements** | The element under the pointer is outlined, and clicking it takes it out of the chapter. Pictures that nothing points at any more are dropped from the book as well, so removing an image also removes its weight. |
| **Select parent** | Widens what a click would take, one level up at a time, from a paragraph to the figure or the block around it. Arrow Up does the same. It stops at the outermost element that is yours to remove. |
| **Select child** | Narrows it back down one level. Arrow Down does the same. Off until you have widened something. |
| **Edit text** | Makes the chapter editable, so you can click into it and type. Pasting and dropping insert plain text only, because markup from somewhere else would pull in that site's images and would not survive saving anyway. The chapter's title is not edited here, it is edited in the chapter list. |
| **Add paragraph before** | Puts an empty paragraph in front of the block the cursor is in, or at the very start of the chapter if the cursor is nowhere. It arrives holding the words "New paragraph", selected, so typing replaces them. |
| **Add paragraph after** | The same, on the other side of that block, or at the end of the chapter. |
| **Chapter CSS** | Opens a box of CSS for this one chapter, applied after the styles captured from its page. The preview redraws as you type. This is the exception for a single chapter; the stylesheet for the whole book is in the editor behind the dialog. |
| **Chapter details** | Opens what this chapter says about itself: title, authors, language, publisher, date and description. A field left empty shows what the page said in grey, which is what will be used. Language is the one field a reading system acts on chapter by chapter. |
| **Undo** | Steps back one change, up to thirty of them. A run of typing counts as one step rather than one character. Ctrl+Z, or Cmd+Z, does the same. |
| **Save chapter** | Writes the edited content, the chapter CSS and the chapter details onto the chapter. It stays greyed out until there is something to write. Nothing else in the dialog saves anything, so closing without pressing it throws the work away. |


![alt remove-elements.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/remove-elements.png?raw=true)

![alt chapter-details.png](https://github.com/alexadam/save-as-ebook/blob/master/imgs/chapter-details.png?raw=true)

Saving a chapter puts it back in the list. The book itself is still not written
until **Generate** in the editor.


## Style Library

Some pages carry things a book should not: a sidebar, a cookie banner, a sticky
header that reappears in the middle of a chapter. The **Style Library** holds the
CSS that is applied to a page *while it is being captured*, so that what is saved
is the page without them.

It is reached from the extension popup - the button lists the styles the page in
front of you would take, each of which can be switched on or off there - and it
is not the same thing as the eBook Stylesheet in the chapter editor, which styles
the book that comes out.

| | |
| --- | --- |
| **Site style** | Applies to the pages its pattern covers. Matched by domain, by URL prefix, by a `*` glob, or by a regular expression. |
| **Every-page style** | Applies to every capture - a serif face, larger text, no images. Ships switched off. |
| **Built-in** | Bundled with the extension and kept up to date by it. Editing one makes it your own copy, which "Reset to built-in" undoes. |

The library page also holds a preview. Opening it with **Capture this page
first** ticked - the checkbox under the popup's button, ticked by default unless
the page has already been captured - takes a copy of the page you are on and
renders it as the eBook will show it, with your styles applied as you type them.
Pointing at something in that preview and clicking writes the rule that hides it.
Capturing takes as long as saving the page does, so leave the box clear to open
the library straight away on the last page captured.

Styles can be exported to a JSON file - one style or the whole library - and
imported back. An import says what it would add and what it would land on top of
before it writes anything. **Remote `url()` and `@import` references are removed
from imported CSS**: they would fetch a file from another site every time you
saved a page, which tells that site what you are reading.

## Convert .epub to .mobi

```
sudo apt-get install calibre
ebook-convert "book.epub" "book.mobi"
```

## Default Keyboard Shortcuts

**NOTE** These shortcuts are not fixed and the browser will assign a different shortcut if the default one is taken

| Shortcut | Description |
| --- | --- |
| Alt + Shift + 1 | Save current page as eBook |
| Alt + Shift + 2 | Save current selection as eBook |
| Alt + Shift + 3 | Add current page as chapter |
| Alt + Shift + 4 | Add current selection as chapter |

## How to change the default Shortcuts

in Chrome:

```
1. Navigate to chrome://extensions/
2. Scroll down
3. Click on Keyboard shortcuts
```

## Added in 2.2.0

### Style Library

Some pages carry things a book should not: a sidebar, a cookie banner, a header
that reappears in the middle of a chapter. The old custom style editor was a bare
text box where the CSS had to be written by hand. It is a proper library now.

 - **24 styles come built in** - ready-made cleanups for Reddit, Wikipedia,
   Hacker News, Medium and X, plus general-purpose ones that hide consent
   banners, ads, sidebars, comments, share buttons and newsletter prompts on any
   site. There are also whole-book looks: serif reading, large print, compact, no
   images.
 - **A live preview.** Open the library and it shows the page you were just on,
   rendered the way the eBook will show it, updating as you change things.
 - **Point and click instead of writing rules.** Click the sidebar in that
   preview and it disappears - no CSS knowledge needed.
 - **Search and filter** the library by name, by what applies to the page you are
   on, or by what you have switched on.
 - **Styles can say where they apply** in ordinary language now - a whole domain,
   addresses starting with something, or a simple pattern - rather than only as a
   regular expression.
 - **Backup and sharing.** Export one style or the whole library to a file and
   import it back, on another machine or from somebody else. Before an import
   happens you are told what it would add and what it would overwrite. Anything
   in an imported style that would quietly fetch a file from another website is
   removed, so importing a stranger's style cannot tell that site what you are
   reading.
 - **The popup shows which styles apply to the page in front of you**, each with
   an on/off switch.

### Review before saving

A new option in the popup. With it on, Save Page opens the chapter in an editor
instead of downloading straight away, so things can be fixed before the book is
made:

 - **Remove elements** - click anything left over and it is gone.
 - **Edit text** - fix a typo, reword a caption.
 - **Edit the book's details** - title, authors, language, publisher, date and
   description, for the whole book or for one chapter. Left blank, they are taken
   from the pages as before.
 - **Style the book itself** - a stylesheet for the whole eBook and, separately,
   CSS for a single chapter. This is about how the finished book looks, which is
   a different thing from the Style Library above - that one cleans up pages on
   the way in.

### Elsewhere

 - Everything new is translated into all four supported languages - English,
   French, Brazilian Portuguese and Russian.
 - Better handling of mathematical notation, so equations that used to vanish on
   Apple Books, Kobo and similar readers now show up.
 - Substantially more automated testing, including a check that books built from
   hand-edited chapters still pass the official EPUB validator.

## Added in 2.1.0
 - add support for EPUB 3
 - add option to apply Readability.js on Save Page and Save Page as Chapter


## Added in 2.0.0
 - Updated the manifest to v3

## To-Do
 - DONE make the Custom Style Editor more user friendly - it is a searchable
   library now, with built-in styles, a preview and an element picker
 - DONE support backup / restore for Custom Styles - export and import, per
   style or for the whole library
 - DONE fix all 'epubcheck' errors (https://github.com/IDPF/epubcheck)
 - clean & optimize code
 - create tests
 - support other formats (mobi, pdf etc.)
 - show confirmations (ui/ux)
 - display errors (ui/ux)
 - DONE support custom style
 - add 'remove from ebook' right click menu action

## Run Tests (Work in progress...)
 ```
 cd tests
 yarn install  # install puppeteer
 node test/index.js  # should start a chrome instance with Save as eBook loaded

 # it will generate and save the ebook in ./tmp-downloads

 .... 
 ```

## Credits
 - http://ebooks.stackexchange.com/questions/1183/what-is-the-minimum-required-content-for-a-valid-epub
 - https://github.com/blowsie/Pure-JavaScript-HTML5-Parser
 - https://stuk.github.io/jszip/
 - https://github.com/mozilla/readability - the library behind Firefox's Reader View, used by the "Apply Readability.js" option. Apache-2.0.
 - http://johnny.github.io/jquery-sortable/
 - https://github.com/eligrey/FileSaver.js/
 - https://www.iconfinder.com/icons/753890/book_books_education_library_study_icon#size=128
 - Thanks to [pumpk0n](https://github.com/pumpk0n) and [Francois Bocquet](https://github.com/fbocquet) for helping me with the French translation
