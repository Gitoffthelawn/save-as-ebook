// Renders one buffered chapter as the packaged book will show it.
//
// The document this builds is assembled by the same functions the build stage
// uses - normalizeChapters(), buildChapterOutline(), getChapterBody() - so what
// the preview shows is the chapter as it will be written, not a second rendering
// of the same content that can drift from it. Only the two things an archive
// resolves for itself are done differently here: the stylesheets a chapter links
// are inlined, and image references into the archive become data urls.
//
// Data urls rather than blob urls, which would be revocable and cheaper: a blob
// url is only readable from the origin that created it, and the frame this feeds
// is sandboxed - it holds that privilege only because the editor reaches into
// it, and content that is script-free by construction can do nothing with it.
//
// Both of those rewrites are reversible, and the reverse is what the editor
// needs: what comes back out of the frame has to be the chapter again, not the
// rendering of it. inlineArchiveImages() and restoreArchiveImageSrc() are that
// pair.
//
// What the preview cannot show is pagination, fonts and margins - those are the
// reading system's, and they differ between devices.

// The reference an <img> in a chapter carries, as extraction's getImageSrc()
// writes it: a file in the archive's images folder, possibly with leading path
// segments. Deliberately the same shape sanitizeHtml.js keeps and saveEbook.js
// checks against the image records.
var PREVIEW_IMAGE_SRC_REGEX = /^(?:\.{1,2}\/)*images\/([^/?#]+)(?:[?#].*)?$/i;

function previewImageDataUrl(image) {
    let type = getImageType(image.filename);
    // normalizeChapters() has already dropped the images this cannot answer for
    // and the <img> tags pointing at them, so this is a guard, not a path.
    return type === '' ? '' : 'data:image/' + type + ';base64,' + image.data;
}

// Which file in the archive a decoded <img> came from, written beside the data
// url that replaced its src. The bytes cannot answer this on their own: two
// files with different names can hold the same picture - the same asset reached
// by two urls is downloaded twice and named twice - and their data urls are then
// identical, so a map from data url back to filename would answer one of them
// for both and quietly move a chapter's reference onto the other file.
//
// The attribute never reaches storage: restoreArchiveImageSrc() takes it off
// again, and sanitizeChapterContent() reads no data attribute off an <img>
// either way.
var ARCHIVE_IMAGE_MARKER_ATTR = 'data-sae-src';

// Every <img> pointing into the archive gets the bytes the archive would hold.
// One that points anywhere else is left alone: it is a remote image, which the
// reading system fetches, and which the preview should therefore try to fetch
// too rather than silently blank out.
function inlineArchiveImages(content, images) {
    let byFilename = Object.create(null);
    (images || []).forEach(function(image) {
        byFilename[image.filename] = image;
    });
    return String(content || '').replace(/<img\b[^>]*>/gi, function(tag) {
        let src = (tag.match(/\ssrc="([^"]*)"/i) || [])[1];
        if (src === undefined) {
            return tag;
        }
        let match = src.match(PREVIEW_IMAGE_SRC_REGEX);
        if (!match) {
            return tag;
        }
        let image = byFilename[match[1]];
        let dataUrl = image ? previewImageDataUrl(image) : '';
        // A reference with no bytes behind it renders as a broken image icon,
        // which reads as a bug in the preview rather than as what it is. The
        // build removes these tags outright; so does this.
        if (dataUrl === '') {
            return '';
        }
        // A marker from an earlier pass would be a second one on the same tag,
        // and the first is not necessarily the one this pass is writing
        let marked = tag.replace(/\s+data-sae-src="[^"]*"/gi, '')
                        .replace(/^<img\b/i, '<img ' + ARCHIVE_IMAGE_MARKER_ATTR + '="' +
                                             escapeXMLChars(image.filename) + '"');
        return marked.replace(/\ssrc="[^"]*"/i, ' src="' + dataUrl + '"');
    });
}

// Where an image reference points from a chapter: chapters are written into
// pages/ and images into images/, both at the root of the archive. Extraction
// writes exactly this prefix, and it is what a reference restored here gets,
// whatever spelling it had before - a chapter buffered by an older version may
// carry "images/x.png", which resolves to nothing from inside pages/.
var ARCHIVE_IMAGE_PREFIX = '../images/';

// The inverse of inlineArchiveImages(): every <img> the preview decoded points
// into the archive again, and loses the marker saying which file it points at.
//
// An <img> without a marker was not decoded here - a remote image the chapter
// always had, or one an editing user brought in - and is left exactly as it
// stands, for sanitizeChapterContent() to accept or drop on its own terms. A
// marker naming an image the chapter no longer carries keeps its data url, which
// the sanitizer then refuses: the reference has nothing behind it either way,
// and dropping the tag is what the build does with those.
function restoreArchiveImageSrc(content, images) {
    let known = Object.create(null);
    (images || []).forEach(function(image) {
        // keyed as the attribute holds it, so that a filename needing escaping
        // is matched without decoding anything back
        known[escapeXMLChars(image.filename)] = image.filename;
    });
    return String(content || '').replace(/<img\b[^>]*>/gi, function(tag) {
        let marker = (tag.match(/\sdata-sae-src="([^"]*)"/i) || [])[1];
        if (marker === undefined) {
            return tag;
        }
        let restored = tag.replace(/\s+data-sae-src="[^"]*"/gi, '');
        let filename = known[marker];
        if (filename === undefined) {
            return restored;
        }
        return restored.replace(/\ssrc="[^"]*"/i,
                                ' src="' + ARCHIVE_IMAGE_PREFIX + escapeXMLChars(filename) + '"');
    });
}

// Chapter css reaches the archive as its own file, where nothing can end it
// early. Inlined into <style>, the first "</style" in it would close the element
// and the rest would be printed as text. Extraction only ever writes declarations
// from its own allowlist, so it could not trigger this - but the css a user types
// in the editor goes through here too, and that is exactly the string this is
// for.
function previewStyleText(css) {
    return String(css || '').replace(/<\/(style)/gi, '<\\/$1');
}

// The stylesheets the preview inlines, named so that a caller editing css can
// replace one of them in the open frame instead of rebuilding the document.
// Rebuilding it would reload the frame, and reloading it would throw away the
// edit session and every unsaved change in it.
var PREVIEW_BOOK_CSS_ID = 'sae-preview-book-css';
var PREVIEW_CHAPTER_CSS_ID = 'sae-preview-chapter-css';
// The site styles the library page is trying out on a snapshot. Empty for the
// chapter editor, which previews a chapter of a book and not a page being
// captured. Last of the three because that is where it lands on a real page:
// scripting.insertCSS puts an author sheet on after everything the page brought
// with it, and a preview that let the captured css win would answer a different
// question from the one being asked.
var PREVIEW_SITE_CSS_ID = 'sae-preview-site-css';

// Live update of one of them. textContent rather than innerHTML, so the string
// cannot become markup and previewStyleText() has nothing to guard against here.
function setPreviewStyle(frameDocument, styleId, css) {
    if (!frameDocument) {
        return;
    }
    let element = frameDocument.getElementById(styleId);
    if (element) {
        element.textContent = sanitizeStylesheet(css);
    }
}

// The chapter as a standalone html document, ready for an iframe's srcdoc, and
// beside it the two things a caller editing that document needs to know: the
// chapter as the build normalized it - which is the image list the rewrites
// above are keyed on - and whether the <h1> the document opens with is the
// page's own or one the build added.
//
// Returns html: '' when there is nothing to render - a record the build skips.
function buildChapterPreview(page, options) {
    options = options || {};
    // The build's own normalization: images whose type never resolved, and
    // references to bytes that never arrived, are dropped from the content here
    // exactly as they will be dropped from the book. A preview showing a picture
    // the reader will not get is worse than one showing the gap.
    let chapter = normalizeChapters([page])[0];
    if (!chapter) {
        return {html: '', chapter: null, hasTitleHeading: false};
    }
    let outline = buildChapterOutline(chapter, 0);
    let body = inlineArchiveImages(getChapterBody(chapter, outline), chapter.images);
    let language = getPageMetadata(chapter).lang || 'en';
    let direction = getPageMetadata(chapter).dir;

    let html = '<!DOCTYPE html>' +
        '<html lang="' + language + '"' + dirAttribute(direction) + '>' +
        '<head>' +
        '<meta charset="utf-8">' +
        '<title>' + escapeXMLChars(chapter.title) + '</title>' +
        // In link order, so the cascade is the archive's: the book-wide
        // stylesheet first, then the chapter's own - which is the captured css
        // and the user's chapter css as one file, exactly as the build writes it.
        '<style id="' + PREVIEW_BOOK_CSS_ID + '">' +
        previewStyleText(sanitizeStylesheet(options.bookCss)) + '</style>' +
        '<style id="' + PREVIEW_CHAPTER_CSS_ID + '">' +
        previewStyleText(chapterStyleContent(chapter)) + '</style>' +
        '<style id="' + PREVIEW_SITE_CSS_ID + '">' +
        previewStyleText(sanitizeStylesheet(options.siteCss)) + '</style>' +
        '</head>' +
        body +
        '</html>';

    return {html: html, chapter: chapter, hasTitleHeading: outline.hasTitleHeading};
}

// The document on its own, for callers that only render it.
function buildChapterPreviewDocument(page, options) {
    return buildChapterPreview(page, options).html;
}
