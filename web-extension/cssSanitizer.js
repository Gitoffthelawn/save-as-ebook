// The one thing a stylesheet is not allowed to do: reach off the machine.
//
// Two callers, for two reasons that arrive at the same rule:
//
//   styleLibrary.js  css that came out of a file somebody was given, and that is
//                    injected into real pages as they are captured. A url() or an
//                    @import pointing at a remote host is a request that host
//                    receives, carrying the visitor's address, every time the
//                    style runs - a tracking beacon fired by a file the user was
//                    invited to trust.
//   saveEbook.js     css that goes into the book. An epub has to read offline,
//                    and EPUB requires a manifest item referencing a remote
//                    resource to say so (properties="remote-resources"); this
//                    build makes no such claim about any file it writes, so
//                    rather than have the claim and the content disagree, the
//                    reference goes.
//
// This used to be two regexes, written out twice. Regexes were the wrong tool:
// `url(` is not the only construct that takes an address, `url` is not the only
// spelling of `url` (css escapes are part of the language: `\75 rl(...)` is the
// same token), and a comment may sit anywhere a space may - `url( /**/ "x")`.
// Each of those got past the pattern, and image-set() got past it while being
// perfectly ordinary css that a style author could write by accident.
//
// So it is a tokenizer, following the CSS Syntax Level 3 rules for the four
// things that decide where one token ends and the next begins: comments,
// strings, escapes, and the url token's own grammar. What that buys is that the
// rule below is stated over tokens rather than over text, which is the only way
// to say "this is an address" and mean it.
//
// The rule, in full:
//
//   - a url() or src() token whose target is remote becomes 'none'
//   - a string that is a remote address, anywhere inside any function call,
//     becomes 'none'. This is the part that has no allowlist in it: image-set(),
//     cross-fade(), image(), whatever css grows next - a function taking a bare
//     string that happens to be an http url is taking an address, and there is
//     no legitimate reading of one in a site style or a book.
//   - the same for a custom property's value, because `--x: "https://..."` and
//     `background-image: image-set(var(--x) 1x)` is the same fetch written in
//     two places.
//   - every @import goes, remote or not. A remote one is the fetch above; a
//     local one names a file the archive has no way to contain.
//
// A relative url() is left alone: "../images/photo.jpg" from a chapter
// stylesheet resolves to a picture the book really does contain. data: urls stay
// for the same reason - they are the resource itself, carried in the file,
// rather than an address to go and get it from.
//
// Nothing here touches the DOM or chrome.*: the service worker has neither, and
// a stylesheet parser that can only run where there is a document would be a
// parser this file cannot use.

// What a removed reference becomes. Dropping the token outright would leave
// "background-image: ;", which a parser discards along with any fallback beside
// it; 'none' is a value the properties that take a url actually accept, and
// where it is not one - image-set(none 1x) - the declaration is dropped by css
// error recovery, which is the same outcome reached the other way.
var REMOVED_CSS_URL = 'none';

// An address that leaves the archive, or the page: anything with a scheme, plus
// the scheme-relative "//host/path" form. data: is not one of these.
function isRemoteCssUrl(target) {
    var value = String(target === undefined || target === null ? '' : target).trim();
    if (/^data:/i.test(value)) {
        return false;
    }
    return /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(value);
}

// ---- the four things that decide where a token ends --------------------------

function isCssWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isCssHexDigit(ch) {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

// Non-ascii is an identifier character in css, which is what lets a stylesheet
// name a class in any language - and also what stops a "\w only" reading of
// identifiers from being correct.
function isCssIdentStartChar(ch) {
    return ch !== undefined &&
           (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 0x7f);
}

function isCssIdentChar(ch) {
    return ch !== undefined &&
           (isCssIdentStartChar(ch) || (ch >= '0' && ch <= '9') || ch === '-');
}

// A backslash escape, which is how a stylesheet spells a character it cannot
// write directly - and how one hides the word "url" from a pattern matcher.
// Hex form is up to six digits followed by one optional space, which the space
// is consumed by rather than kept: "\75 rl" is "url", not "u rl".
function readCssEscape(css, index) {
    var next = index + 1;
    if (next >= css.length) {
        return {value: '\uFFFD', next: next};
    }
    if (!isCssHexDigit(css.charAt(next))) {
        return {value: css.charAt(next), next: next + 1};
    }

    var hex = '';
    while (next < css.length && hex.length < 6 && isCssHexDigit(css.charAt(next))) {
        hex += css.charAt(next);
        next++;
    }
    if (next < css.length && isCssWhitespace(css.charAt(next))) {
        if (css.charAt(next) === '\r' && css.charAt(next + 1) === '\n') {
            next++;
        }
        next++;
    }

    var code = parseInt(hex, 16);
    if (!code || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
        return {value: '\uFFFD', next: next};
    }
    return {value: String.fromCodePoint(code), next: next};
}

// Whether an identifier starts here. The awkward cases are both real: a leading
// '-' is an identifier only if what follows it is one (or another '-', which is
// how custom properties are spelled), and a leading backslash is one unless it
// is escaping a newline, which nothing can be.
function startsCssIdent(css, index) {
    var ch = css.charAt(index);
    if (ch === '') {
        return false;
    }
    if (ch === '-') {
        var after = css.charAt(index + 1);
        if (after === '-' || isCssIdentStartChar(after)) {
            return true;
        }
        return after === '\\' && css.charAt(index + 2) !== '\n';
    }
    if (ch === '\\') {
        return css.charAt(index + 1) !== '\n' && index + 1 < css.length;
    }
    return isCssIdentStartChar(ch);
}

// The identifier as the parser sees it - escapes resolved - alongside where it
// ended in the source, since the source text is what gets copied through.
function readCssIdent(css, index) {
    var value = '';
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === '\\' && css.charAt(index + 1) !== '\n') {
            var escaped = readCssEscape(css, index);
            value += escaped.value;
            index = escaped.next;
            continue;
        }
        if (!isCssIdentChar(ch)) {
            break;
        }
        value += ch;
        index++;
    }
    return {value: value, next: index};
}

// A quoted string. An unescaped newline inside one ends it - the token is a
// parse error at that point, and treating the rest of the file as string
// content would hide everything after it from this pass.
function readCssString(css, index) {
    var quote = css.charAt(index);
    var value = '';
    index++;
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === quote) {
            return {value: value, next: index + 1};
        }
        if (ch === '\n') {
            return {value: value, next: index};
        }
        if (ch === '\\') {
            if (css.charAt(index + 1) === '\n') {
                index += 2;
                continue;
            }
            var escaped = readCssEscape(css, index);
            value += escaped.value;
            index = escaped.next;
            continue;
        }
        value += ch;
        index++;
    }
    return {value: value, next: index};
}

function readCssComment(css, index) {
    var end = css.indexOf('*/', index + 2);
    return end < 0 ? css.length : end + 2;
}

// Whitespace and comments, which are the same thing to a parser and the reason
// `url( /*c*/ "x")` was never a url token in the first place: the comment makes
// this the function form of url(), taking a string, which is exactly as fetchable
// as the token form.
function skipCssTrivia(css, index) {
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === '/' && css.charAt(index + 1) === '*') {
            index = readCssComment(css, index);
            continue;
        }
        if (!isCssWhitespace(ch)) {
            break;
        }
        index++;
    }
    return index;
}

// The unquoted form: url(...) with no quotes takes everything up to the closing
// paren as the address, whitespace-trimmed, escapes resolved. Nothing else about
// it is tokenized, which is why a ';' or a '{' in a data: url is harmless here
// and would not be under a line-based scan.
function readCssUrlToken(css, index) {
    var value = '';
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === ')') {
            index++;
            break;
        }
        if (ch === '\\' && css.charAt(index + 1) !== '\n') {
            var escaped = readCssEscape(css, index);
            value += escaped.value;
            index = escaped.next;
            continue;
        }
        value += ch;
        index++;
    }
    return {value: value.trim(), next: index};
}

// From just after an opening paren to just after the paren that closes it.
function endOfCssFunction(css, index) {
    var depth = 1;
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === '/' && css.charAt(index + 1) === '*') {
            index = readCssComment(css, index);
            continue;
        }
        if (ch === '"' || ch === '\'') {
            index = readCssString(css, index).next;
            continue;
        }
        if (ch === '\\') {
            index = readCssEscape(css, index).next;
            continue;
        }
        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
        index++;
    }
    return index;
}

// From '{' to just after the '}' that closes it.
function endOfCssBlock(css, index) {
    var depth = 0;
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === '/' && css.charAt(index + 1) === '*') {
            index = readCssComment(css, index);
            continue;
        }
        if (ch === '"' || ch === '\'') {
            index = readCssString(css, index).next;
            continue;
        }
        if (ch === '\\') {
            index = readCssEscape(css, index).next;
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return index + 1;
            }
        }
        index++;
    }
    return index;
}

// An at-rule runs to the first semicolon outside anything, or to the end of the
// block it carries, or to the end of the block it sits in, or to the end of the
// file - in that order. All four happen: `@import "a;b.css" screen;` holds a
// semicolon that ends nothing, and a file may simply stop mid-rule.
function endOfCssAtRule(css, index) {
    var depth = 0;
    while (index < css.length) {
        var ch = css.charAt(index);
        if (ch === '/' && css.charAt(index + 1) === '*') {
            index = readCssComment(css, index);
            continue;
        }
        if (ch === '"' || ch === '\'') {
            index = readCssString(css, index).next;
            continue;
        }
        if (ch === '\\') {
            index = readCssEscape(css, index).next;
            continue;
        }
        if (ch === '(' || ch === '[') {
            depth++;
            index++;
            continue;
        }
        if (ch === ')' || ch === ']') {
            if (depth > 0) {
                depth--;
            }
            index++;
            continue;
        }
        if (depth === 0) {
            if (ch === ';') {
                return index + 1;
            }
            if (ch === '{') {
                return endOfCssBlock(css, index);
            }
            if (ch === '}') {
                return index;
            }
        }
        index++;
    }
    return index;
}

// ---- the pass itself ---------------------------------------------------------
//
// The css with every remote reference gone, and the list of what went - the
// second half being the point at the style-library call site: a style that
// quietly does less than the file said is worse than one that says what was
// dropped from it.
//
// Everything not removed is copied through as it was written, byte for byte.
// This is a filter, not a formatter: css a reading system does not understand is
// css it ignores, and re-serializing a stylesheet to remove two constructs from
// it would put this file in the business of having an opinion about the rest.
function sanitizeCssResources(css) {
    var source = String(css === undefined || css === null ? '' : css);
    var out = '';
    var copied = 0;
    var removed = [];

    // How deep inside function calls we are, which is what makes a string an
    // argument rather than prose; the block nesting, so a declaration can be
    // told from a selector; and the block a custom property was opened in, if
    // one is open.
    var functionDepth = 0;
    var blockDepth = 0;
    var customPropertyDepth = -1;
    var atDeclarationStart = true;
    var index = 0;

    function note(reference) {
        var text = String(reference).replace(/\s+/g, ' ').trim();
        if (text !== '' && removed.indexOf(text) < 0) {
            removed.push(text);
        }
    }

    function replaceSpan(start, end, text) {
        out += source.substring(copied, start) + text;
        copied = end;
    }

    // url(...) and src(...), in both the token form and the function-with-a-
    // string form. `start` is where the identifier began, so that the whole
    // construct is what gets replaced.
    function readResourceFunction(start, afterParen, name) {
        var at = skipCssTrivia(source, afterParen);
        var quote = source.charAt(at);
        var target;
        var end;

        if (quote === '"' || quote === '\'') {
            var string = readCssString(source, at);
            target = string.value;
            end = endOfCssFunction(source, string.next);
        } else if (name === 'url') {
            var token = readCssUrlToken(source, at);
            target = token.value;
            end = token.next;
        } else {
            // src() with something that is not a string - var(), or nonsense.
            // Nothing addressable to judge, so it is left as an open function
            // call and its insides are walked by the rules below rather than
            // skipped.
            functionDepth++;
            return afterParen;
        }

        if (isRemoteCssUrl(target)) {
            note(target);
            replaceSpan(start, end, REMOVED_CSS_URL);
        }
        return end;
    }

    while (index < source.length) {
        var ch = source.charAt(index);

        if (ch === '/' && source.charAt(index + 1) === '*') {
            index = readCssComment(source, index);
            continue;
        }

        if (isCssWhitespace(ch)) {
            index++;
            continue;
        }

        if (ch === '"' || ch === '\'') {
            var string = readCssString(source, index);
            if ((functionDepth > 0 || customPropertyDepth >= 0) &&
                    isRemoteCssUrl(string.value)) {
                note(string.value);
                replaceSpan(index, string.next, REMOVED_CSS_URL);
            }
            index = string.next;
            atDeclarationStart = false;
            continue;
        }

        if (ch === '@' && startsCssIdent(source, index + 1)) {
            var atKeyword = readCssIdent(source, index + 1);
            if (atKeyword.value.toLowerCase() === 'import') {
                var ruleEnd = endOfCssAtRule(source, atKeyword.next);
                note(source.substring(index, ruleEnd));
                replaceSpan(index, ruleEnd, '');
                index = ruleEnd;
                atDeclarationStart = true;
                continue;
            }
            index = atKeyword.next;
            atDeclarationStart = false;
            continue;
        }

        if (startsCssIdent(source, index)) {
            var ident = readCssIdent(source, index);
            var name = ident.value.toLowerCase();

            if (source.charAt(ident.next) === '(') {
                if (name === 'url' || name === 'src') {
                    index = readResourceFunction(index, ident.next + 1, name);
                    atDeclarationStart = false;
                    continue;
                }
                functionDepth++;
                index = ident.next + 1;
                atDeclarationStart = false;
                continue;
            }

            if (atDeclarationStart && blockDepth > 0 &&
                    ident.value.substring(0, 2) === '--') {
                customPropertyDepth = blockDepth;
            }
            index = ident.next;
            atDeclarationStart = false;
            continue;
        }

        if (ch === '(') {
            functionDepth++;
            index++;
            atDeclarationStart = false;
            continue;
        }
        if (ch === ')') {
            if (functionDepth > 0) {
                functionDepth--;
            }
            index++;
            continue;
        }

        // Structure is only structure outside a function call: a stray brace or
        // semicolon between parens is malformed css, and reading it as nesting
        // would lose track of where the declarations are.
        if (functionDepth === 0) {
            if (ch === '{') {
                blockDepth++;
                atDeclarationStart = true;
                index++;
                continue;
            }
            if (ch === '}') {
                if (customPropertyDepth >= blockDepth) {
                    customPropertyDepth = -1;
                }
                if (blockDepth > 0) {
                    blockDepth--;
                }
                atDeclarationStart = true;
                index++;
                continue;
            }
            if (ch === ';') {
                customPropertyDepth = -1;
                atDeclarationStart = true;
                index++;
                continue;
            }
        }

        if (ch === '\\') {
            index = readCssEscape(source, index).next;
            atDeclarationStart = false;
            continue;
        }

        atDeclarationStart = false;
        index++;
    }

    return {css: out + source.substring(copied), removed: removed};
}
