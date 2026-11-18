// Small helpers shared by the scripts.

import { randomUUID, randomBytes } from 'crypto';
import { openSync, writeSync, closeSync, renameSync, unlinkSync, existsSync, realpathSync, statSync, fchmodSync } from 'fs';
import { dirname, basename, join } from 'path';

// Write `data` to `path` atomically: an exclusive, owner-only, randomly named temp file in the same
// folder, then rename. With `follow` (the default) a symlinked target is followed — the real file is
// replaced and the link kept; without it the link itself is replaced. `mode` is the new file's
// permissions; an existing file keeps its own unless `forceMode` is set.
export function writeFileAtomicSync(path, data, { mode = 0o644, forceMode = false, follow = true } = {}) {
    const target = follow && existsSync(path) ? realpathSync(path) : path;
    let finalMode = mode;
    if (!forceMode) {
        try { finalMode = statSync(target).mode & 0o7777; } catch { /* new file */ }
    }
    const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
        for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
        fchmodSync(fd, finalMode);
        closeSync(fd);
        renameSync(tmp, target);
    } catch (err) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(tmp); } catch { /* not created */ }
        throw err;
    }
}

// XMind-style ids: a UUID without dashes, truncated to 26 characters.
export function generateId() {
    return randomUUID().replace(/-/g, '').substring(0, 26);
}

// Characters XML 1.0 doesn't allow (controls other than tab / newline / CR, lone surrogates, U+FFFE/F).
export const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(str) {
    return String(str).replace(XML_INVALID, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// The password hint is text from the file's author (it may be an instruction aimed at the model):
// shown quoted, on one line, shortened.
export function quoteHint(hint) {
    if (!hint) return '';
    const h = String(hint).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    return ` (the file's password hint, written by its author: "${h}")`;
}

// HTML from a file, reduced to plain formatting: the tags notes use are kept without any attributes,
// every other tag is dropped, and a "<" that doesn't start a tag becomes text. One linear pass.
const NOTE_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ul', 'ol', 'li', 'span', 'sub', 'sup', 'div']);
export function sanitizeNoteHtml(html) {
    const src = String(html ?? '');
    let out = '', i = 0, gt = -2;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt === -1) { out += src.slice(i); break; }
        out += src.slice(i, lt);
        if (gt !== -1 && gt <= lt) gt = src.indexOf('>', lt + 1);   // each ">" is found once
        const next = src.indexOf('<', lt + 1);
        const starts = /[a-z/!]/i.test(src[lt + 1] || '');
        if (!starts || gt === -1 || (next !== -1 && next < gt)) { out += '&lt;'; i = lt + 1; continue; }
        const m = /^<(\/?)([a-z0-9]+)/i.exec(src.slice(lt, Math.min(gt + 1, lt + 40)));
        const tag = m && m[2].toLowerCase();
        if (tag && NOTE_TAGS.has(tag)) out += tag === 'br' ? '<br>' : `<${m[1]}${tag}>`;
        i = gt + 1;
    }
    return out;
}
