// XMind's sticker / illustration library, read from the installed app's app.asar.
// Only files are read — the app is never started. The archive is ~250 MB, so only its header and the
// requested entry are read (by offset), never the whole file.

import { existsSync, openSync, readSync, closeSync } from 'fs';
import { extname } from 'path';

export const STICKER_DIR = 'static/snowbird/resource/stickers';
export const ILLUSTRATION_DIR = 'static/snowbird/resource/illustrations';

export function asarCandidates() {
    return [
        process.env.XMIND_APP_ASAR,
        '/Applications/Xmind.app/Contents/Resources/app.asar',
        `${process.env.HOME || ''}/Applications/Xmind.app/Contents/Resources/app.asar`,
        `${process.env.LOCALAPPDATA || ''}/Programs/Xmind/resources/app.asar`,
        'C:/Program Files/Xmind/resources/app.asar',
        '/opt/Xmind/resources/app.asar',
        '/usr/lib/xmind/resources/app.asar',
    ].filter(Boolean);
}

function readAt(fd, position, length) {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const n = readSync(fd, buf, done, length - done, position + done);
        if (n === 0) break;
        done += n;
    }
    return buf.subarray(0, done);
}

let cached;
// {path, header, base} for the first readable app.asar, or null.
export function openAsar() {
    if (cached !== undefined) return cached;
    cached = null;
    for (const path of asarCandidates()) {
        if (!existsSync(path)) continue;
        let fd;
        try {
            fd = openSync(path, 'r');
            const head = readAt(fd, 0, 16);
            const headerSize = head.readUInt32LE(12);
            const header = JSON.parse(readAt(fd, 16, headerSize).toString('utf-8'));
            cached = { path, header, base: 8 + head.readUInt32LE(4) };
            break;
        } catch {
            /* not a readable asar — try the next candidate */
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
    }
    return cached;
}

function node(asar, path) {
    let n = asar.header;
    for (const part of path.split('/').filter(Boolean)) {
        n = n?.files?.[part];
        if (!n) return null;
    }
    return n;
}

// All file paths under `dir`, relative to it.
export function asarList(asar, dir) {
    const out = [];
    const walk = (n, prefix) => {
        for (const [name, child] of Object.entries(n?.files || {})) {
            if (child.files) walk(child, `${prefix}${name}/`);
            else out.push(prefix + name);
        }
    };
    walk(node(asar, dir), '');
    return out;
}

export function asarRead(asar, innerPath) {
    const entry = node(asar, innerPath);
    if (!entry || entry.files || entry.unpacked) return null;
    const fd = openSync(asar.path, 'r');
    try {
        return readAt(fd, asar.base + Number(entry.offset), entry.size);
    } finally {
        closeSync(fd);
    }
}

const MISSING = 'No XMind installation was found (set XMIND_APP_ASAR to its app.asar).';

// Names (without extension) in the sticker or illustration library, optionally filtered.
export function listLibrary(kind, query = '') {
    const asar = openAsar();
    if (!asar) throw new Error(`${MISSING} Stickers and illustrations come from XMind's own library.`);
    const names = asarList(asar, kind === 'sticker' ? STICKER_DIR : ILLUSTRATION_DIR)
        .filter(n => /\.(svg|png)$/i.test(n)).map(n => n.replace(/\.(svg|png)$/i, ''));
    const q = String(query || '').toLowerCase();
    const items = q ? names.filter(n => n.toLowerCase().includes(q)) : names;
    return { source: asar.path, count: items.length, items };
}

// {data, ext} of one sticker / illustration; throws with close matches when the name is unknown.
export function libraryAsset(kind, name, where) {
    const asar = openAsar();
    if (!asar) {
        throw new Error(`${where}: ${kind}s come from XMind's own library. ${MISSING} ` +
            'Use an image file instead: "image": "/abs/picture.png".');
    }
    const dir = kind === 'sticker' ? STICKER_DIR : ILLUSTRATION_DIR;
    const names = asarList(asar, dir).filter(n => /\.(svg|png)$/i.test(n));
    const wanted = String(name).toLowerCase().replace(/\.(svg|png)$/, '');
    const hit = names.find(n => n.toLowerCase().replace(/\.(svg|png)$/, '') === wanted);
    if (!hit) {
        const base = wanted.split('/').pop();
        const near = names.filter(x => {
            const nm = x.toLowerCase().replace(/\.(svg|png)$/, '').split('/').pop();
            return nm.includes(base) || base.includes(nm) || nm.startsWith(base.slice(0, 4));
        }).slice(0, 8);
        throw new Error(`${where}: no ${kind} "${name}" in XMind's library.` +
            (near.length ? ` Close matches: ${near.map(n => n.replace(/\.(svg|png)$/, '')).join(', ')}.` : '') +
            ` List them with read_xmind.mjs {"action": "list_${kind}s"}.`);
    }
    return { data: asarRead(asar, `${dir}/${hit}`), ext: extname(hit).toLowerCase() };
}
