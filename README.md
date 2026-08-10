# save-as-ebook

Save a web page/selection as an eBook (.epub format) - a Chrome/Firefox/Opera Web Extension

<img src="https://github.com/alexadam/save-as-ebook/blob/master/ex11.png?raw=true" width="350">

![alt ex2.png](https://github.com/alexadam/save-as-ebook/blob/master/ex2.png?raw=true)

![alt ex3.png](https://github.com/alexadam/save-as-ebook/blob/master/ex3.png?raw=true)

## How to install it

### From [Chrome Web Store](https://chrome.google.com/webstore/detail/save-as-ebook/haaplkpoiimngbppjihnegfmpejdnffj)

or manually (tested on v. 52.0.2743.116)

```
1. Navigate to chrome://extensions/
2. Load unpacked extension ...
3. Select the extension's directory
```

### From [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/saveasebook/)

or manually (tested on v. 50.0a2)

```
1. Navigate to about:debugging
2. Load temporary add-on ...
3. Select the extension's directory
```

### Opera (tested on v. 39.0.2256.48)

```
1. Navigate to opera:extensions
2. Load unpacked extension ...
3. Select the extension's directory
```

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
