// Minimal ZIP reader / writer (PKZIP APPNOTE 6.3.3) — Node.js built-ins only.

import { deflateRawSync, inflateRawSync } from 'zlib';
import * as zlib from 'zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

// zlib.crc32 exists from Node 20.15 / 22.2; older versions use the lookup table.
export const crc32 = typeof zlib.crc32 === 'function'
    ? buf => zlib.crc32(buf) >>> 0
    : buf => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };

// Already-compressed formats: deflating them again costs time and gains nothing.
const STORED_EXTS = /\.(png|jpe?g|gif|webp|mp3|m4a|aac|ogg|oga|webm|flac|mp4|mov|zip|xmind|pdf|docx|xlsx|pptx|gz|7z)$/i;

// files: Array<{name, data: Buffer}>. Each entry is deflated unless it is already compressed
// (or deflate would not make it smaller), in which case it is stored.
export function buildZip(files) {
    const entries = [];
    const centralHeaders = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBytes = Buffer.from(name, 'utf-8');
        let method = 0, body = data;
        if (!STORED_EXTS.test(name)) {
            const deflated = deflateRawSync(data);
            if (deflated.length < data.length) { method = 8; body = deflated; }
        }
        const crc = crc32(data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);   // signature
        localHeader.writeUInt16LE(20, 4);             // version needed
        localHeader.writeUInt16LE(0x0800, 6);         // flags: UTF-8 file names
        localHeader.writeUInt16LE(method, 8);         // 0 = stored, 8 = deflate
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(body.length, 18);   // compressed size
        localHeader.writeUInt32LE(data.length, 22);   // uncompressed size
        localHeader.writeUInt16LE(nameBytes.length, 26);
        const entry = Buffer.concat([localHeader, nameBytes, body]);
        entries.push(entry);

        const cdHeader = Buffer.alloc(46);
        cdHeader.writeUInt32LE(0x02014b50, 0);
        cdHeader.writeUInt16LE(20, 4);                // version made by
        cdHeader.writeUInt16LE(20, 6);                // version needed
        cdHeader.writeUInt16LE(0x0800, 8);
        cdHeader.writeUInt16LE(method, 10);
        cdHeader.writeUInt32LE(crc, 16);
        cdHeader.writeUInt32LE(body.length, 20);
        cdHeader.writeUInt32LE(data.length, 24);
        cdHeader.writeUInt16LE(nameBytes.length, 28);
        cdHeader.writeUInt32LE(offset, 42);           // local header offset
        centralHeaders.push(Buffer.concat([cdHeader, nameBytes]));
        offset += entry.length;
    }

    const centralDir = Buffer.concat(centralHeaders);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...entries, centralDir, eocd]);
}

// A hostile file can declare small entries that inflate to gigabytes ("ZIP bomb"). Each entry is
// inflated no further than the size it declares, and all entries together may declare at most
// XMIND_MAX_UNZIPPED_MB (default 1024 MB). An entry over 4 MB that shrank more than 100× is refused
// too — map text compresses about 10×, pictures and media hardly at all, so only a bomb gets there —
// and so are entries that share or overlap their data (one bomb listed many times).
export const MAX_UNZIPPED_BYTES = (Number(process.env.XMIND_MAX_UNZIPPED_MB) || 1024) * 1024 * 1024;
const BOMB_SIZE = 4 * 1024 * 1024, BOMB_RATIO = 100;

function tooBig(what) {
    return new Error(`This .xmind file ${what} — it is not a normal mind map ` +
        '(set XMIND_MAX_UNZIPPED_MB to raise the limit if you trust it).');
}

export function readZip(buf) {
    // Find End of Central Directory record (scan backwards)
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

    const cdEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);

    // Read Central Directory entries
    const files = new Map();
    let pos = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
        if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid ZIP: bad CD entry');
        const compression = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);

        if (files.has(name)) throw new Error(`Invalid ZIP: ${JSON.stringify(name.slice(0, 100))} is listed twice`);
        files.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset, nameLen });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    const spans = [...files.values()].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    for (let i = 1; i < spans.length; i++) {
        const prev = spans[i - 1];
        if (prev.localHeaderOffset + 30 + prev.nameLen + prev.compressedSize > spans[i].localHeaderOffset) {
            throw new Error('Invalid ZIP: entries overlap (damaged or hostile file)');
        }
    }
    let declared = 0;
    const custom = Boolean(process.env.XMIND_MAX_UNZIPPED_MB);
    for (const [name, f] of files) {
        declared += f.uncompressedSize;
        if (!custom && f.compression === 8 && f.uncompressedSize > BOMB_SIZE && f.uncompressedSize > f.compressedSize * BOMB_RATIO) {
            throw tooBig(`has an entry (${JSON.stringify(name.slice(0, 100))}) that unpacks from ${Math.round(f.compressedSize / 1024)} KB to ${Math.round(f.uncompressedSize / 1048576)} MB`);
        }
    }
    if (declared > MAX_UNZIPPED_BYTES) {
        throw tooBig(`would unpack to ${Math.round(declared / 1048576)} MB, more than the ${Math.round(MAX_UNZIPPED_BYTES / 1048576)} MB limit`);
    }

    return {
        extract(name) {
            const entry = files.get(name);
            if (!entry) return null;

            // Read Local File Header to get actual data offset
            const lhOffset = entry.localHeaderOffset;
            if (buf.readUInt32LE(lhOffset) !== 0x04034b50) throw new Error('Invalid ZIP: bad local header');
            const lhNameLen = buf.readUInt16LE(lhOffset + 26);
            const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
            const dataOffset = lhOffset + 30 + lhNameLen + lhExtraLen;
            const rawData = buf.subarray(dataOffset, dataOffset + entry.compressedSize);

            if (entry.compression === 0) return rawData;
            if (entry.compression === 8) {
                try {
                    return inflateRawSync(rawData, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
                } catch (err) {
                    if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
                        throw new Error(`Invalid ZIP: ${JSON.stringify(name.slice(0, 100))} unpacks to more than its declared ${entry.uncompressedSize} bytes (damaged or hostile file).`);
                    }
                    throw err;
                }
            }
            throw new Error(`Unsupported compression method: ${entry.compression}`);
        },
        names() { return [...files.keys()]; },
    };
}
