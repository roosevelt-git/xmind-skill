// Password protection with XMind's own scheme — Node.js built-ins only.
//
// Each entry (content.json, metadata.json, every resource) is encrypted on its own with AES-CBC; the
// key is PBKDF2-HMAC-SHA512(password, salt, iterations). manifest.json stays readable and records the
// parameters per entry. (XMind labels the two algorithms the other way round in the manifest — kept as
// is, because that is what XMind reads.)

import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'crypto';
import { readZip } from './zip.mjs';
import { quoteHint } from './util.mjs';

export const PASSWORD_REQUIRED = 'XMIND_PASSWORD_REQUIRED';
export const WRONG_PASSWORD = 'XMIND_WRONG_PASSWORD';

function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

export function encryptEntry(data, password) {
    const salt = randomBytes(8), iv = randomBytes(16);
    const key = pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, 1024, 16, 'sha512');
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    return {
        data: Buffer.concat([cipher.update(data), cipher.final()]),
        meta: {
            'encryption-data': {
                size: 128, 'iteration-count': 1024, 'algorithm-name': 'AES/CBC/PKCS5Padding',
                'key-derivation-name': 'PBKDF2WithHmacSHA512', salt: salt.toString('base64'), iv: iv.toString('base64'),
            },
        },
    };
}

// XMind writes 1024 iterations per entry. Each entry carries its own parameters, so both the
// per-entry count and the file's total are bounded (a file with thousands of slow entries would
// otherwise keep the CPU busy for hours).
const MAX_ITERATIONS = 100_000;
const MAX_TOTAL_ITERATIONS = 4_000_000;

// Returns `data` unchanged when the manifest entry isn't encrypted.
export function decryptEntry(data, meta, password, hint = null) {
    const enc = meta?.['encryption-data'];
    if (!enc) return data;
    if (!password) {
        throw fail(PASSWORD_REQUIRED, `This file is password-protected${quoteHint(hint)} — pass "password".`);
    }
    // The file chooses these; bound them so a hostile file can't make key derivation take minutes
    // (XMind itself writes 128-bit keys and 1024 iterations).
    const bits = Number(enc.size) || 128;
    const iterations = Number(enc['iteration-count']) || 1024;
    if (![128, 192, 256].includes(bits)) throw new Error(`Unsupported encryption key size ${enc.size} in this file.`);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
        throw new Error(`Unsupported encryption iteration count ${enc['iteration-count']} in this file.`);
    }
    const keyLen = bits / 8;
    const key = pbkdf2Sync(Buffer.from(password, 'utf-8'), Buffer.from(enc.salt, 'base64'), iterations, keyLen, 'sha512');
    const iv = enc.iv ? Buffer.from(enc.iv, 'base64') : Buffer.alloc(16);
    try {
        const d = createDecipheriv(`aes-${keyLen * 8}-cbc`, key, iv);
        return Buffer.concat([d.update(data), d.final()]);
    } catch {
        throw fail(WRONG_PASSWORD, 'Wrong password.');
    }
}

// readZip + transparent decryption of password-protected entries.
export function openZip(buf, password = null) {
    const zip = readZip(buf);
    let manifest = {};
    if (zip.names().includes('manifest.json')) {
        try { manifest = JSON.parse(zip.extract('manifest.json').toString('utf-8')); } catch { /* no usable manifest */ }
    }
    const entries = manifest['file-entries'] || {};
    let total = 0;
    for (const e of Object.values(entries)) total += Number(e?.['encryption-data']?.['iteration-count']) || 0;
    if (total > MAX_TOTAL_ITERATIONS) throw new Error('Unsupported encryption settings in this file (key derivation would take too long).');
    const hint = manifest['password-hint'] || null;
    return {
        names: () => zip.names(),
        encrypted: Object.values(entries).some(e => e?.['encryption-data']),
        passwordHint: hint,
        extract(name) {
            const data = zip.extract(name);
            return data && decryptEntry(data, entries[name], password, hint);
        },
    };
}
