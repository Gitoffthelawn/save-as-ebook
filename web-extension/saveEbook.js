var cssFileName = 'ebook.css';
var ebookTitle = null;

// Compression is set per file, never globally: OCF requires 'mimetype' to be
// the first entry and STORE-d, so readers can sniff the magic bytes.
var DEFLATED = {compression: 'DEFLATE'};
var STORED = {compression: 'STORE'};

// getFileExtension() only ever returns png/gif/jpeg/svg/''. Of those, only svg
// is text - the rest are already compressed and deflating them just burns CPU.
// '' means the type could not be determined; those are downloaded rasters.
function getImageZipOptions(filename) {
    return getFileExtension(filename) === 'svg' ? DEFLATED : STORED;
}

chrome.runtime.onMessage.addListener((obj, sender, sendResponse) => {
    if (obj && obj.shortcut === 'build-ebook') {
        buildEbook(obj.response);
        return false;
    }
    if (obj && obj.alert) {
        console.log(obj.alert);
        alert(obj.alert);
        return false;
    }
    // not ours - returning true here would hold the message channel open for
    // every message the other listeners handle
    return false;
})

// Tells the background the job is over, whichever way it ended. Every exit from
// _buildEbook() goes through this: without it a failed build leaves the badge on
// and the extension refusing to start anything else until the job times out.
function finishJob(errorMessage) {
    if (errorMessage) {
        console.log('Error:', errorMessage);
        try {
            alert(errorMessage);
        } catch (e) {
            console.log('Error:', e);
        }
    }
    try {
        chrome.runtime.sendMessage({type: "done"}, () => {
            void chrome.runtime.lastError;
        });
    } catch (e) {
        console.log('Error:', e);
    }
}

function getImagesIndex(allImages) {
    return allImages.reduce(function(prev, elem, index) {
        return prev + '\n' + '<item href="images/' + elem.filename + '" id="img' + elem.filename + '" media-type="image/' + getImageType(elem.filename) + '"/>';
    }, '');
}

function getExternalLinksIndex() { // TODO
    return allExternalLinks.reduce(function(prev, elem, index) {
        return prev + '\n' + '<item href="' + elem + '" />';
    }, '');
}

function buildEbookFromChapters() {
    getEbookTitle(function (title) {
        ebookTitle = title;
        if (!ebookTitle || ebookTitle.trim().length === 0) {
            ebookTitle = 'eBook';
        }
        getEbookPages(_buildEbook);
    })
}

// FIXME remove  - keep one  function
function buildEbook(allPages, fromMenu=false) {
    _buildEbook(allPages, fromMenu);
}

// http://ebooks.stackexchange.com/questions/1183/what-is-the-minimum-required-content-for-a-valid-epub
function _buildEbook(allPages, fromMenu=false) {
    allPages = allPages.filter(function(page) {
        return page !== null;
    });

    console.log('Prepare Content...');

    var ebookFileName = 'eBook.epub';

    if (ebookTitle) {
        // ~TODO a pre-processing function to apply escapeXMLChars to all page.titles
        ebookName = escapeXMLChars(ebookTitle);
        ebookFileName = getEbookFileName(removeSpecialChars(ebookTitle)) + '.epub';
    } else {
        ebookName = escapeXMLChars(allPages[0].title);
        ebookFileName = getEbookFileName(removeSpecialChars(allPages[0].title)) + '.epub';
    }

    var zip = new JSZip();
    // Must stay first in the archive and uncompressed - do not add DEFLATE here.
    zip.file('mimetype', 'application/epub+zip', STORED);

    var metaInfFolder = zip.folder("META-INF");
    metaInfFolder.file('container.xml',
        '<?xml version="1.0"?>' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
        '</rootfiles>' +
        '</container>',
        DEFLATED
    );


    var oebps = zip.folder("OEBPS");
    oebps.file('toc.xhtml',
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        '<head>' +
        '<title>toc.xhtml</title>' +
        '<link href="' + cssFileName + '" rel="stylesheet" type="text/css" />' +
        '</head>' +
        '<body>' +
        '<nav id="toc" epub:type="toc">' +
        '<h1 class="frontmatter">Table of Contents</h1>' +
        '<ol class="contents">' +
        allPages.reduce(function(prev, page) {
            var tmpPageTitle = escapeXMLChars(page.title);
            return prev + '\n' + '<li><a href="pages/' + page.url + '">' + tmpPageTitle + '</a></li>';
        }, '') +
        '</ol>' +
        '</nav>' +
        '</body>' +
        '</html>',
        DEFLATED
    );

    oebps.file('toc.ncx',
        '<?xml version="1.0" encoding="UTF-8" ?>' +
        '<ncx version="2005-1" xml:lang="en" xmlns="http://www.daisy.org/z3986/2005/ncx/">' +
        '<head>' +
        '<meta name="dtb:uid" content="isbn"/>' +
        '<meta name="dtb:depth" content="1"/>' +
        '</head>' +
        '<docTitle>' +
        '<text>' + ebookName + '</text>' +
        '</docTitle>' +
        '<navMap>' +
        allPages.reduce(function(prev, page, index) {
            var tmpPageTitle = escapeXMLChars(page.title);
            return prev + '\n' +
                '<navPoint id="ebook' + index + '" playOrder="' + (index + 1) + '">' +
                '<navLabel><text>' + tmpPageTitle + '</text></navLabel>' +
                '<content src="pages/' + page.url + '" />' +
                '</navPoint>';
        }, '') +
        '</navMap>' +
        '</ncx>',
        DEFLATED
    );

    oebps.file(cssFileName, '', DEFLATED); //TODO
    var styleFolder = oebps.folder('style');
    allPages.forEach(function(page) {
        styleFolder.file(page.styleFileName, page.styleFileContent, DEFLATED);
    });

    var pagesFolder = oebps.folder('pages');
    allPages.forEach(function(page) {
        var tmpPageTitle = escapeXMLChars(page.title);
        pagesFolder.file(page.url,
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
            '<head>' +
            '<title>' + tmpPageTitle+ '</title>' +
            '<link href="../style/' + page.styleFileName + '" rel="stylesheet" type="text/css" />' +
            '</head><body>' +
            page.content +
            '</body></html>',
            DEFLATED
        );
    });

    oebps.file('content.opf',
        '<?xml version="1.0" encoding="UTF-8" ?>' +
        '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="db-id" version="3.0">' +
        '<metadata>' +
        '<dc:title id="t1">'+ ebookName + '</dc:title>' +
        '<dc:identifier id="db-id">isbn</dc:identifier>' +
        '<meta property="dcterms:modified">' + new Date().toISOString().replace(/\.[0-9]+Z/i, 'Z') + '</meta>' +
        '<dc:language>en</dc:language>' +
        '</metadata>' +
        '<manifest>' +
        '<item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml" />' +
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />' +
        '<item id="template_css" href="' + cssFileName + '" media-type="text/css" />' +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<item id="ebook' + index + '" href="pages/' + page.url + '" media-type="application/xhtml+xml" />';
        }, '') +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<item id="style' + index + '" href="style/' + page.styleFileName + '" media-type="text/css" />';
        }, '') +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + getImagesIndex(page.images);
        }, '') +
        '</manifest>' +
        '<spine toc="ncx">' +
        allPages.reduce(function(prev, page, index) {
            return prev + '\n' + '<itemref idref="ebook' + index + '" />';
        }, '') +
        '</spine>' +
        '</package>',
        DEFLATED
    );

    ///////////////
    try {
        let imgsFolder = oebps.folder("images");
        allPages.forEach(function(page) {
            for (let i = 0; i < page.images.length; i++) {
                let tmpImg = page.images[i]
                // TODO - Must be JSON serializable - see the same comment in extractHtml.js
                let imgOptions = getImageZipOptions(tmpImg.filename)
                // if (tmpImg.isBinary) {
                //     imgsFolder.file(tmpImg.filename, tmpImg.data, {binary: true, compression: imgOptions.compression})
                // } else {
                    imgsFolder.file(tmpImg.filename, tmpImg.data, {base64: true, compression: imgOptions.compression})
                // }
            }
        });
    } catch (error) {
        console.log(error);
    }
    

    // Compressing a large book takes long enough to outlive the job timeout, so
    // keep reporting progress until the file is handed to the download
    let heartbeat = setInterval(function () {
        try {
            chrome.runtime.sendMessage({type: 'job-heartbeat'}, () => {
                void chrome.runtime.lastError;
            });
        } catch (e) {
            console.log('Error:', e);
        }
    }, 5000);

    zip.generateAsync({
            type: "blob",
            mimeType: "application/epub+zip"
        })
        .then(function(content) {
            clearInterval(heartbeat);
            downloadBlob(content, ebookFileName);
            finishJob(null);
        })
        .catch(function(error) {
            // out of memory on a very large book, a corrupt image, a revoked
            // blob url - all of them used to leave the job open forever
            clearInterval(heartbeat);
            finishJob('Could not generate the eBook: ' + error);
        });

}
