#!/usr/bin/env node

// XMind file reader - reads JSON from stdin, outputs parsed data to stdout
// Usage: echo '{"action":"read","path":"/tmp/file.xmind"}' | node read_xmind.mjs
// No external dependencies — uses only Node.js built-ins.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'fs';
import { resolve, join, basename, normalize, extname } from 'path';
import { inflateRawSync } from 'zlib';
import { pbkdf2Sync, createDecipheriv } from 'crypto';

// Password for protected files (the "password" field of the request).
let PASSWORD = null;

// ─── Minimal ZIP reader (PKZIP APPNOTE 6.3.3) ───

// readZip + transparent decryption of password-protected entries. XMind encrypts each entry with
// AES-CBC; key = PBKDF2-HMAC-SHA512(password, salt, iterations); parameters are in manifest.json.
function openZip(buf) {
    const zip = readZip(buf);
    let entries = {};
    if (zip.names().includes('manifest.json')) {
        try { entries = JSON.parse(zip.extract('manifest.json').toString('utf-8'))['file-entries'] || {}; } catch { /* no manifest */ }
    }
    let hint = null;
    try { hint = JSON.parse(zip.extract('manifest.json')?.toString('utf-8') || '{}')['password-hint'] || null; } catch { /* ignore */ }
    return {
        names: () => zip.names(),
        encrypted: Object.values(entries).some(e => e?.['encryption-data']),
        passwordHint: hint,
        extract(name) {
            const data = zip.extract(name);
            const enc = entries[name]?.['encryption-data'];
            if (!data || !enc) return data;
            if (!PASSWORD) {
                throw new Error(`This file is password-protected${hint ? ` (hint: ${hint})` : ''} — pass "password".`);
            }
            const keyLen = (Number(enc.size) || 128) / 8;
            const key = pbkdf2Sync(Buffer.from(PASSWORD, 'utf-8'), Buffer.from(enc.salt, 'base64'),
                Number(enc['iteration-count']) || 1024, keyLen, 'sha512');
            try {
                const d = createDecipheriv(`aes-${keyLen * 8}-cbc`, key, enc.iv ? Buffer.from(enc.iv, 'base64') : Buffer.alloc(16));
                return Buffer.concat([d.update(data), d.final()]);
            } catch {
                throw new Error('Wrong password.');
            }
        },
    };
}

function readZip(buf) {
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

        files.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset });
        pos += 46 + nameLen + extraLen + commentLen;
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
            if (entry.compression === 8) return inflateRawSync(rawData);
            throw new Error(`Unsupported compression method: ${entry.compression}`);
        },
        names() { return [...files.keys()]; },
    };
}

// ─── Minimal XML parser (for XMind 8 legacy content.xml) ───

function parseXml(xml) {
    // Returns a tree of {tag, attrs, children, text}
    let pos = 0;

    // Strip all processing instructions (<?...?>) and DOCTYPE declarations
    xml = xml.replace(/<\?[^?]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').trim();

    function skipWhitespace() {
        while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    }

    function parseAttrs() {
        const attrs = {};
        while (pos < xml.length) {
            skipWhitespace();
            if (xml[pos] === '/' || xml[pos] === '>') break;
            // Read attribute name
            let name = '';
            while (pos < xml.length && xml[pos] !== '=' && xml[pos] !== '/' && xml[pos] !== '>' && !/\s/.test(xml[pos])) {
                name += xml[pos++];
            }
            if (!name) break;
            skipWhitespace();
            if (xml[pos] === '=') {
                pos++; // skip =
                skipWhitespace();
                const quote = xml[pos++]; // " or '
                let val = '';
                while (pos < xml.length && xml[pos] !== quote) {
                    if (xml[pos] === '&') {
                        // Basic entity decode
                        const semi = xml.indexOf(';', pos);
                        if (semi !== -1) {
                            const entity = xml.substring(pos + 1, semi);
                            if (entity === 'amp') val += '&';
                            else if (entity === 'lt') val += '<';
                            else if (entity === 'gt') val += '>';
                            else if (entity === 'quot') val += '"';
                            else if (entity === 'apos') val += "'";
                            else if (entity.startsWith('#x')) val += String.fromCharCode(parseInt(entity.slice(2), 16));
                            else if (entity.startsWith('#')) val += String.fromCharCode(parseInt(entity.slice(1), 10));
                            else val += `&${entity};`;
                            pos = semi + 1;
                        } else {
                            val += xml[pos++];
                        }
                    } else {
                        val += xml[pos++];
                    }
                }
                pos++; // skip closing quote
                attrs[name] = val;
            } else {
                attrs[name] = name; // boolean attribute
            }
        }
        return attrs;
    }

    function parseElement() {
        skipWhitespace();
        if (pos >= xml.length || xml[pos] !== '<') return null;

        // Skip comments
        if (xml.startsWith('<!--', pos)) {
            pos = xml.indexOf('-->', pos) + 3;
            return parseElement();
        }

        pos++; // skip <
        // Read tag name
        let tag = '';
        while (pos < xml.length && xml[pos] !== '/' && xml[pos] !== '>' && !/\s/.test(xml[pos])) {
            tag += xml[pos++];
        }

        const attrs = parseAttrs();
        skipWhitespace();

        // Self-closing
        if (xml[pos] === '/') {
            pos += 2; // skip />
            return { tag, attrs, children: [], text: '' };
        }
        pos++; // skip >

        // Parse children and text content
        // `parts` preserves interleaving order of text and child elements (for mixed content like HTML)
        const children = [];
        const parts = [];
        let text = '';

        while (pos < xml.length) {
            if (xml.startsWith('<![CDATA[', pos)) {
                // CDATA section
                const cdataEnd = xml.indexOf(']]>', pos + 9);
                if (cdataEnd !== -1) {
                    const cd = xml.substring(pos + 9, cdataEnd);
                    text += cd;
                    parts.push({ type: 'text', value: cd });
                    pos = cdataEnd + 3;
                } else {
                    const cd = xml.substring(pos + 9);
                    text += cd;
                    parts.push({ type: 'text', value: cd });
                    pos = xml.length;
                }
            } else if (xml[pos] === '<') {
                if (xml[pos + 1] === '/') {
                    // Closing tag
                    const end = xml.indexOf('>', pos);
                    pos = end + 1;
                    break;
                }
                if (xml.startsWith('<!--', pos)) {
                    pos = xml.indexOf('-->', pos) + 3;
                    continue;
                }
                const child = parseElement();
                if (child) {
                    children.push(child);
                    parts.push({ type: 'element', value: child });
                }
            } else {
                // Text content
                let t = '';
                while (pos < xml.length && xml[pos] !== '<') {
                    t += xml[pos++];
                }
                // Decode entities in text
                t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
                text += t;
                parts.push({ type: 'text', value: t });
            }
        }

        return { tag, attrs, children, text: text.trim(), parts };
    }

    return parseElement();
}

// Helper: find child element(s) by tag name (ignoring namespace prefix)
function xmlFind(el, tagName) {
    if (!el || !el.children) return [];
    return el.children.filter(c => {
        const localTag = c.tag.includes(':') ? c.tag.split(':').pop() : c.tag;
        return localTag === tagName;
    });
}

function xmlFindOne(el, tagName) {
    return xmlFind(el, tagName)[0] || null;
}

function xmlText(el, tagName) {
    const child = xmlFindOne(el, tagName);
    return child ? child.text : '';
}

function xmlAttr(el, name) {
    if (!el || !el.attrs) return '';
    // Try exact match first, then try with common prefixes
    if (el.attrs[name] !== undefined) return el.attrs[name];
    // Try with namespace prefixes
    for (const [k, v] of Object.entries(el.attrs)) {
        const localName = k.includes(':') ? k.split(':').pop() : k;
        if (localName === name) return v;
    }
    return '';
}

// Reconstruct HTML from XMind 8 xhtml:* elements, preserving mixed content order via `parts`
function reconstructHtml(el) {
    let html = '';
    const items = el.parts || [];
    // If no parts (shouldn't happen), fall back to children
    if (items.length === 0 && el.children?.length > 0) {
        for (const child of el.children) items.push({ type: 'element', value: child });
    }
    for (const part of items) {
        if (part.type === 'text') {
            html += part.value;
        } else if (part.type === 'element') {
            const child = part.value;
            const localTag = child.tag.includes(':') ? child.tag.split(':').pop() : child.tag;
            if (['p', 'span', 'strong', 'em', 'u', 'br', 'ul', 'ol', 'li', 'a', 'img', 'b', 'i', 'sub', 'sup', 'del', 's'].includes(localTag)) {
                const styleAttr = child.attrs?.style ? ` style="${child.attrs.style}"` : '';
                const hrefAttr = child.attrs?.['xlink:href'] || child.attrs?.href;
                const hrefStr = hrefAttr ? ` href="${hrefAttr}"` : '';
                if (localTag === 'br' || localTag === 'img') {
                    html += `<${localTag}${styleAttr}/>`;
                } else {
                    html += `<${localTag}${styleAttr}${hrefStr}>`;
                    html += reconstructHtml(child);
                    html += `</${localTag}>`;
                }
            } else {
                // Unknown tag — include content only
                html += reconstructHtml(child);
            }
        }
    }
    return html;
}

// ─── XMind 8 XML format parser ───

// Known <topic> attributes mapped to result field names
const TOPIC_ATTR_MAP = {
    'id':              'id',
    'structure-class': 'structureClass',
    'xlink:href':      'href',
    'style-id':        'styleId',
    'branch':          'branch',
    'timestamp':       'timestamp',
};

function processXmlTopic(topicEl, sheetTitle) {
    const result = {
        title: xmlText(topicEl, 'title') || '',
        id: xmlAttr(topicEl, 'id'),
        sheetTitle: sheetTitle || 'Untitled Map',
    };

    // ── Capture ALL <topic> attributes ──
    // Map known attrs to canonical field names; pass through unknown ones verbatim.
    if (topicEl.attrs) {
        for (const [key, val] of Object.entries(topicEl.attrs)) {
            if (!val) continue;
            const mapped = TOPIC_ATTR_MAP[key];
            if (mapped) {
                if (mapped !== 'id') result[mapped] = val; // id already set
            } else {
                // Skip xmlns declarations
                if (key.startsWith('xmlns')) continue;
                // Store unknown attribute directly (camelCase the key)
                const camel = key.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
                result[camel] = val;
            }
        }
    }

    // ── Position ──
    const posEl = xmlFindOne(topicEl, 'position');
    if (posEl) {
        const x = parseInt(xmlAttr(posEl, 'x') || xmlAttr(posEl, 'svg:x'), 10);
        const y = parseInt(xmlAttr(posEl, 'y') || xmlAttr(posEl, 'svg:y'), 10);
        if (!isNaN(x) && !isNaN(y)) result.position = { x, y };
    }

    // ── Labels ──
    const labelsEl = xmlFindOne(topicEl, 'labels');
    if (labelsEl) {
        const labels = xmlFind(labelsEl, 'label').map(l => l.text).filter(Boolean);
        if (labels.length > 0) result.labels = labels;
    }

    // ── Notes ──
    const notesEl = xmlFindOne(topicEl, 'notes');
    if (notesEl) {
        const plainEl = xmlFindOne(notesEl, 'plain');
        // XMind 8 uses <xhtml:html> or just <html> for rich notes
        const htmlEl = xmlFindOne(notesEl, 'html') ||
            notesEl.children?.find(c => c.tag === 'xhtml:html');
        if (plainEl || htmlEl) {
            result.notes = {};
            if (plainEl) {
                const contentEl = xmlFindOne(plainEl, 'content');
                result.notes.content = contentEl ? contentEl.text : plainEl.text;
            }
            if (htmlEl) {
                if (htmlEl.text) {
                    result.notes.html = htmlEl.text;
                } else if (htmlEl.children?.length > 0) {
                    result.notes.html = reconstructHtml(htmlEl);
                }
            }
        }
    }

    // ── Markers ──
    const markerRefsEl = xmlFindOne(topicEl, 'marker-refs');
    if (markerRefsEl) {
        const markers = xmlFind(markerRefsEl, 'marker-ref')
            .map(m => m.attrs?.['marker-id'] || xmlAttr(m, 'marker-id'))
            .filter(Boolean);
        if (markers.length > 0) result.markers = markers;
    }

    // ── Image ──
    const imageEl = xmlFindOne(topicEl, 'xhtml:img') || xmlFindOne(topicEl, 'img');
    if (imageEl) {
        const src = imageEl.attrs?.['xhtml:src'] || imageEl.attrs?.src ||
                    xmlAttr(imageEl, 'src') || xmlAttr(imageEl, 'xhtml:src');
        if (src) result.image = { src };
        const w = imageEl.attrs?.['svg:width'] || xmlAttr(imageEl, 'width');
        const h = imageEl.attrs?.['svg:height'] || xmlAttr(imageEl, 'height');
        if (w && result.image) result.image.width = w;
        if (h && result.image) result.image.height = h;
    }

    // ── Numbering ──
    const numberingEl = xmlFindOne(topicEl, 'numbering');
    if (numberingEl) {
        result.numbering = { ...numberingEl.attrs };
        const prefix = xmlText(numberingEl, 'prefix');
        const suffix = xmlText(numberingEl, 'suffix');
        if (prefix) result.numbering.prefix = prefix;
        if (suffix) result.numbering.suffix = suffix;
    }

    // ── Children element ──
    const childrenEl = xmlFindOne(topicEl, 'children');

    // ── Callouts ──
    if (childrenEl) {
        const calloutTopics = xmlFind(childrenEl, 'topics').filter(t => t.attrs?.type === 'callout');
        if (calloutTopics.length > 0) {
            const callouts = [];
            for (const ct of calloutTopics) {
                for (const t of xmlFind(ct, 'topic')) {
                    const title = xmlText(t, 'title');
                    if (title) callouts.push({ title });
                }
            }
            if (callouts.length > 0) result.callouts = callouts;
        }
    }

    // ── Boundaries ──
    const boundariesEl = xmlFindOne(topicEl, 'boundaries');
    if (boundariesEl) {
        const boundaries = xmlFind(boundariesEl, 'boundary').map(b => {
            const entry = { id: xmlAttr(b, 'id'), range: xmlAttr(b, 'range') };
            const title = xmlText(b, 'title');
            if (title) entry.title = title;
            return entry;
        }).filter(b => b.range);
        if (boundaries.length > 0) result.boundaries = boundaries;
    }

    // ── Summaries ──
    const summariesEl = xmlFindOne(topicEl, 'summaries');
    if (summariesEl) {
        const summaryTopicTitles = new Map();
        if (childrenEl) {
            const summaryTopicsContainers = xmlFind(childrenEl, 'topics').filter(t => t.attrs?.type === 'summary');
            for (const stc of summaryTopicsContainers) {
                for (const st of xmlFind(stc, 'topic')) {
                    const stId = xmlAttr(st, 'id');
                    const stTitle = xmlText(st, 'title');
                    if (stId && stTitle) summaryTopicTitles.set(stId, stTitle);
                }
            }
        }
        const summaries = xmlFind(summariesEl, 'summary').map(s => {
            const entry = {
                id: xmlAttr(s, 'id'),
                range: xmlAttr(s, 'range'),
                topicId: xmlAttr(s, 'topic-id'),
            };
            const topicTitle = summaryTopicTitles.get(entry.topicId);
            if (topicTitle) entry.topicTitle = topicTitle;
            return entry;
        }).filter(s => s.range);
        if (summaries.length > 0) result.summaries = summaries;
    }

    // ── Extensions (task info + all others) ──
    const extensionsEl = xmlFindOne(topicEl, 'extensions');
    if (extensionsEl) {
        const rawExtensions = [];
        for (const extEl of xmlFind(extensionsEl, 'extension')) {
            const provider = xmlAttr(extEl, 'provider');
            const contentEl = xmlFindOne(extEl, 'content');

            if ((provider === 'org.xmind.ui.taskInfo' || provider === 'org.xmind.ui.task') && contentEl) {
                // Parse task fields
                const status = xmlAttr(contentEl, 'status') || xmlText(contentEl, 'status');
                const progress = xmlAttr(contentEl, 'progress') || xmlText(contentEl, 'progress');
                const priority = xmlAttr(contentEl, 'priority') || xmlText(contentEl, 'priority');
                const start = xmlAttr(contentEl, 'start') || xmlText(contentEl, 'start');
                const due = xmlAttr(contentEl, 'due') || xmlText(contentEl, 'due');
                const duration = xmlAttr(contentEl, 'duration') || xmlText(contentEl, 'duration');

                if (status) result.taskStatus = status;
                if (progress) result.progress = parseFloat(progress);
                if (priority) result.priority = parseInt(priority, 10);
                if (start) result.startDate = new Date(parseInt(start, 10)).toISOString();
                if (due) result.dueDate = new Date(parseInt(due, 10)).toISOString();
                if (duration) result.duration = parseInt(duration, 10);

                const depsEl = xmlFindOne(contentEl, 'dependencies');
                if (depsEl) {
                    const deps = xmlFind(depsEl, 'dependency').map(d => ({
                        id: xmlAttr(d, 'id'),
                        type: xmlAttr(d, 'type'),
                        lag: parseInt(xmlAttr(d, 'lag') || '0', 10),
                    })).filter(d => d.id);
                    if (deps.length > 0) result.dependencies = deps;
                }
            } else {
                // Preserve unknown extensions as-is
                const ext = { provider };
                if (contentEl) {
                    ext.content = {};
                    // Capture all attributes on <content>
                    if (contentEl.attrs) Object.assign(ext.content, contentEl.attrs);
                    // Capture all child element text values
                    for (const child of contentEl.children || []) {
                        const localTag = child.tag.includes(':') ? child.tag.split(':').pop() : child.tag;
                        ext.content[localTag] = child.text || serializeXmlElement(child);
                    }
                    if (contentEl.text) ext.content._text = contentEl.text;
                }
                rawExtensions.push(ext);
            }
        }
        if (rawExtensions.length > 0) result.extensions = rawExtensions;
    }

    // ── Style → shape (inline style or style-id reference) ──
    const styleEl = xmlFindOne(topicEl, 'style');
    if (styleEl) {
        const propsEl = xmlFindOne(styleEl, 'topic-properties') || xmlFindOne(styleEl, 'properties');
        if (propsEl) {
            const shape = xmlAttr(propsEl, 'shape-class') || propsEl.attrs?.['fo:shape-class'];
            if (shape) result.shape = shape;
            // Capture all style properties
            if (propsEl.attrs && Object.keys(propsEl.attrs).length > 0) {
                if (!result.styleProperties) result.styleProperties = {};
                Object.assign(result.styleProperties, propsEl.attrs);
            }
        }
    }
    // shape-class directly on <topic>
    const directShapeClass = topicEl.attrs?.['shape-class'];
    if (directShapeClass) result.shape = directShapeClass;

    // ── Children (attached) ──
    // type="attached" is standard, but older XMind editors may omit the type attribute entirely
    if (childrenEl) {
        const attachedTopics = xmlFind(childrenEl, 'topics').filter(t => {
            const type = t.attrs?.type;
            return type === 'attached' || (!type && type !== 'detached' && type !== 'callout' && type !== 'summary');
        });
        if (attachedTopics.length > 0) {
            const children = [];
            for (const at of attachedTopics) {
                for (const t of xmlFind(at, 'topic')) {
                    children.push(processXmlTopic(t, sheetTitle));
                }
            }
            if (children.length > 0) result.children = children;
        }
    }

    return result;
}

// Serialize an XML element back to string (for unknown/opaque content preservation)
function serializeXmlElement(el) {
    if (!el) return '';
    let s = `<${el.tag}`;
    for (const [k, v] of Object.entries(el.attrs || {})) s += ` ${k}="${v}"`;
    if (!el.children?.length && !el.text) return s + '/>';
    s += '>';
    if (el.text) s += el.text;
    for (const child of el.children || []) s += serializeXmlElement(child);
    s += `</${el.tag}>`;
    return s;
}

// Parse styles.xml into a map of style-id → {properties}
function parseStylesXml(zip) {
    const stylesMap = new Map();
    const stylesRaw = zip.extract('styles.xml');
    if (!stylesRaw) return stylesMap;
    try {
        const root = parseXml(stylesRaw.toString('utf-8'));
        if (!root) return stylesMap;
        // Collect from <styles>, <automatic-styles>, <master-styles>
        for (const container of root.children || []) {
            for (const styleEl of xmlFind(container, 'style')) {
                const id = xmlAttr(styleEl, 'id');
                if (!id) continue;
                const props = {};
                // Gather properties from all child property elements
                for (const child of styleEl.children || []) {
                    const localTag = child.tag.includes(':') ? child.tag.split(':').pop() : child.tag;
                    if (localTag.endsWith('-properties') || localTag === 'properties') {
                        if (child.attrs) Object.assign(props, child.attrs);
                    }
                }
                stylesMap.set(id, props);
            }
        }
    } catch { /* ignore style parse errors */ }
    return stylesMap;
}

// Resolve style-id on a topic result using the styles map
function resolveTopicStyle(result, stylesMap) {
    if (result.styleId && stylesMap.has(result.styleId)) {
        const props = stylesMap.get(result.styleId);
        if (props['shape-class'] && !result.shape) result.shape = props['shape-class'];
        if (!result.styleProperties) result.styleProperties = {};
        Object.assign(result.styleProperties, props);
    }
    // Recurse into children
    if (result.children) {
        for (const child of result.children) resolveTopicStyle(child, stylesMap);
    }
    if (result.detachedTopics) {
        for (const dt of result.detachedTopics) resolveTopicStyle(dt, stylesMap);
    }
}

function parseXMindLegacy(filePath) {
    const buf = readFileSync(resolve(filePath));
    const zip = openZip(buf);
    const contentRaw = zip.extract('content.xml');
    if (!contentRaw) throw new Error('content.xml not found in XMind file');
    const xmlStr = contentRaw.toString('utf-8');
    const root = parseXml(xmlStr);
    // Accept root tag with or without namespace prefix (e.g. <ns:xmap-content>)
    const rootLocalTag = root?.tag?.includes(':') ? root.tag.split(':').pop() : root?.tag;
    if (!root || rootLocalTag !== 'xmap-content') {
        throw new Error('Invalid XMind 8 file: expected <xmap-content> root element');
    }

    // Parse styles.xml for shape/font/color resolution
    const stylesMap = parseStylesXml(zip);

    return xmlFind(root, 'sheet').map(sheetEl => {
        const sheetTitle = xmlText(sheetEl, 'title') || 'Untitled Map';
        const topicEl = xmlFindOne(sheetEl, 'topic');
        if (!topicEl) throw new Error('Sheet has no root topic');

        const rootNode = processXmlTopic(topicEl, sheetTitle);

        // Detached topics
        const childrenEl = xmlFindOne(topicEl, 'children');
        if (childrenEl) {
            const detachedTopics = xmlFind(childrenEl, 'topics').filter(t => t.attrs?.type === 'detached');
            if (detachedTopics.length > 0) {
                const detached = [];
                for (const dt of detachedTopics) {
                    for (const t of xmlFind(dt, 'topic')) {
                        detached.push(processXmlTopic(t, sheetTitle));
                    }
                }
                if (detached.length > 0) rootNode.detachedTopics = detached;
            }
        }

        // Relationships
        const relsEl = xmlFindOne(sheetEl, 'relationships');
        if (relsEl) {
            const relationships = xmlFind(relsEl, 'relationship').map(relEl => {
                const r = {
                    id: xmlAttr(relEl, 'id'),
                    end1Id: xmlAttr(relEl, 'end1'),
                    end2Id: xmlAttr(relEl, 'end2'),
                };
                const title = xmlText(relEl, 'title');
                if (title) r.title = title;
                // Relationship style/shape
                const styleEl = xmlFindOne(relEl, 'style');
                if (styleEl) {
                    const propsEl = xmlFindOne(styleEl, 'relationship-properties') || xmlFindOne(styleEl, 'properties');
                    if (propsEl) {
                        const shape = xmlAttr(propsEl, 'shape-class');
                        if (shape) r.shape = shape;
                    }
                }
                // style-id → styles.xml (how XMind 8 itself stores relationship styles)
                const relStyleId = xmlAttr(relEl, 'style-id');
                if (relStyleId && stylesMap.has(relStyleId)) {
                    const { 'shape-class': shapeClass, ...rest } = stylesMap.get(relStyleId);
                    if (shapeClass && !r.shape) r.shape = shapeClass;
                    if (Object.keys(rest).length > 0) r.style = rest;
                }
                // Control points
                const cpEl = xmlFindOne(relEl, 'control-points');
                if (cpEl) {
                    const points = xmlFind(cpEl, 'control-point').map(cp => {
                        const pt = {};
                        const idx = xmlAttr(cp, 'index'); if (idx) pt.index = parseInt(idx, 10);
                        const amt = xmlAttr(cp, 'amount'); if (amt) pt.amount = parseFloat(amt);
                        const ang = xmlAttr(cp, 'angle'); if (ang) pt.angle = parseFloat(ang);
                        return pt;
                    });
                    if (points.length > 0) r.controlPoints = points;
                }
                return r;
            }).filter(r => r.end1Id && r.end2Id);
            if (relationships.length > 0) rootNode.relationships = relationships;
        }

        // Resolve style-id → shape/properties from styles.xml
        if (stylesMap.size > 0) resolveTopicStyle(rootNode, stylesMap);

        return rootNode;
    });
}

// ─── Format detection ───

function detectFormat(filePath) {
    const buf = readFileSync(resolve(filePath));
    const zip = openZip(buf);
    const names = zip.names();
    if (names.includes('content.json')) return 'zen';
    if (names.includes('content.xml')) return 'legacy';
    throw new Error('Unknown XMind format: neither content.json nor content.xml found');
}

// ─── XMind Parser (new JSON format) ───

function processNode(node, sheetTitle) {
    const result = {
        // XMind allows untitled topics (image-only or colour blocks); report them as "".
        title: node.title ?? '',
        id: node.id,
        sheetTitle: sheetTitle || 'Untitled Map',
    };

    if (node.structureClass) result.structureClass = node.structureClass;
    if (node.style?.properties?.['shape-class']) result.shape = node.style.properties['shape-class'];
    if (node.style?.properties) {
        // Remaining visual properties (fill, border, font…) under XMind's own names.
        const { 'shape-class': _shape, ...rest } = node.style.properties;
        if (Object.keys(rest).length > 0) result.style = rest;
    }
    if (node.image?.src && !node.image.isMathJaxImage) result.image = node.image;
    if (node.position) result.position = node.position;
    if (node.branch === 'folded') result.folded = true;
    // Rich-text title runs, in the friendly shape create_xmind.mjs accepts.
    const runs = node.attributedTitle || [];
    if (runs.length > 1 || runs.some(r => Object.keys(r).length > 1)) {
        result.titleRuns = runs.map(r => {
            const o = { text: r.text ?? '' };
            if (r['fo:font-weight']) o.bold = /bold|[6-9]00/.test(r['fo:font-weight']);
            if (r['fo:font-style']) o.italic = r['fo:font-style'] === 'italic';
            if (r['fo:color']) o.color = r['fo:color'];
            if (r['fo:background-color']) o.highlight = r['fo:background-color'];
            if (r['fo:text-decoration']) {
                o.underline = r['fo:text-decoration'].includes('underline');
                o.strike = r['fo:text-decoration'].includes('line-through');
            }
            if (r['fo:font-size']) o.fontSize = r['fo:font-size'];
            if (r['fo:font-family']) o.fontFamily = r['fo:font-family'];
            return o;
        });
    }
    const ext = provider => (node.extensions || []).find(e => e.provider === provider);
    const eq = ext('org.xmind.ui.mathJax')?.content?.content;
    if (typeof eq === 'string') result.equation = eq;
    const video = ext('org.xmind.ui.webVideo')?.content;
    if (video?.url) result.video = { url: video.url, embedUrl: video.embedUrl };
    const audio = ext('org.xmind.ui.audionotes')?.resources?.[0];
    if (audio) result.audio = audio;
    const preview = ext('org.xmind.ui.linkPreview')?.content;
    if (preview && typeof preview === 'object') {
        const lp = {};
        for (const k of ['mode', 'title', 'description', 'siteName', 'imageUrl', 'faviconUrl']) if (preview[k]) lp[k] = preview[k];
        result.linkPreview = Object.keys(lp).length > 0 ? lp : true;
    }
    const numbering = ext('org.xmind.ui.numbering')?.content;
    if (numbering?.pattern) result.numbering = numbering;
    const columns = ext('org.xmind.ui.spreadsheet')?.content?.find?.(c => c.name === 'columns')?.content;
    if (node.structureClass === 'org.xmind.ui.spreadsheet' && Array.isArray(columns)) {
        result.matrixColumns = columns.map(c => c.content);
    }
    if (node.customWidth) result.customWidth = node.customWidth;
    if (node.href) result.href = node.href;
    if (node.labels) result.labels = node.labels;

    if (node.children?.callout) {
        result.callouts = node.children.callout.map(c => ({ title: c.title }));
    }

    if (node.notes?.plain?.content || node.notes?.realHTML?.content) {
        result.notes = {};
        if (node.notes?.plain?.content) result.notes.content = node.notes.plain.content;
        if (node.notes?.realHTML?.content) result.notes.html = node.notes.realHTML.content;
    }

    if (node.markers?.length > 0) {
        result.markers = node.markers.map(m => m.markerId);
    }

    if (node.boundaries?.length > 0) {
        result.boundaries = node.boundaries;
    }

    if (node.summaries?.length > 0) {
        result.summaries = node.summaries.map(s => {
            const entry = { id: s.id, range: s.range, topicId: s.topicId };
            // XMind stores summary topics in children.summary; files written by older versions
            // of create_xmind.mjs put them in a top-level `summary` key.
            const summaryTopics = node.children?.summary || node.summary;
            if (summaryTopics) {
                const st = summaryTopics.find(t => t.id === s.topicId);
                if (st) entry.topicTitle = st.title;
            }
            return entry;
        });
    }

    if (node.extensions) {
        const taskExt = node.extensions.find(e => e.provider === 'org.xmind.ui.task');
        if (taskExt) {
            const c = taskExt.content;
            if (c.status) result.taskStatus = c.status;
            if (c.progress !== undefined) result.progress = c.progress;
            if (c.priority !== undefined) result.priority = c.priority;
            if (c.duration !== undefined) result.duration = c.duration;
            if (c.start !== undefined) result.startDate = new Date(c.start).toISOString();
            if (c.due !== undefined) result.dueDate = new Date(c.due).toISOString();
            if (c.dependencies?.length > 0) result.dependencies = c.dependencies;
        }
    }

    if (node.children?.attached) {
        result.children = node.children.attached.map(child => processNode(child, sheetTitle));
    }

    return result;
}

// Legend, watermark, background texture and custom markers in the shape create_xmind.mjs accepts.
function sheetExtrasOf(sheet) {
    const out = {};
    if (sheet.legend) {
        const l = { visible: sheet.legend.visibility !== 'hidden' };
        if (sheet.legend.position) l.position = sheet.legend.position;
        if (sheet.legend.markers) l.markers = Object.fromEntries(Object.entries(sheet.legend.markers).map(([k, v]) => [k, v?.name ?? '']));
        out.legend = l;
    }
    const ext = provider => (sheet.extensions || []).find(e => e.provider === provider)?.content;
    const wm = ext('org.xmind.ui.watermark');
    if (wm?.kind) {
        const w = {};
        if (wm.kind === 'image') w.image = { src: wm.src, width: wm.imageWidth, height: wm.imageHeight };
        else w.text = wm.text;
        for (const [k, to] of [['fontFamily', 'fontFamily'], ['fontSize', 'fontSize'], ['color', 'color'],
            ['opacity', 'opacity'], ['rotationDegrees', 'rotation'], ['density', 'density']]) if (wm[k] != null) w[to] = wm[k];
        if (wm.fontWeight != null) w.bold = wm.fontWeight >= 600;
        out.watermark = w;
    }
    const tex = ext('org.xmind.ui.background-texture');
    if (tex?.style) out.backgroundTexture = { ...tex };
    const custom = (sheet.customMarkerGroups || []).flatMap(g => g.markers || []);
    if (custom.length > 0) out.customMarkers = custom.map(m => ({ id: m.id, name: m.name, image: { src: m.resource } }));
    return out;
}

function parseXMindZen(filePath) {
    const buf = readFileSync(resolve(filePath));
    const zip = openZip(buf);
    const contentRaw = zip.extract('content.json');
    if (!contentRaw) return [];
    // Strip UTF-8 BOM if present
    let jsonStr = contentRaw.toString('utf-8');
    if (jsonStr.charCodeAt(0) === 0xFEFF) jsonStr = jsonStr.slice(1);
    const parsed = JSON.parse(jsonStr);
    // Accept both array format and {sheets:[...]} object wrapper
    const content = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sheets) ? parsed.sheets : [];
    if (content.length === 0) return [];

    return content.map(sheet => {
        if (!sheet.rootTopic) return null;
        const rootNode = processNode(sheet.rootTopic, sheet.title || 'Untitled Map');

        // Sheet-level metadata
        Object.assign(rootNode, sheetExtrasOf(sheet));
        if (sheet.topicPositioning) rootNode.topicPositioning = sheet.topicPositioning;
        if (sheet.floatingTopicFlexible) rootNode.floatingTopicFlexible = sheet.floatingTopicFlexible;

        // Detached topics (free-positioned nodes)
        if (sheet.rootTopic.children?.detached?.length > 0) {
            rootNode.detachedTopics = sheet.rootTopic.children.detached.map(
                dt => processNode(dt, sheet.title || 'Untitled Map')
            );
        }

        // Relationships with style (shape-class)
        if (sheet.relationships) {
            rootNode.relationships = sheet.relationships.map(rel => {
                const r = { id: rel.id, end1Id: rel.end1Id, end2Id: rel.end2Id };
                if (rel.title) r.title = rel.title;
                if (rel.style?.properties?.['shape-class']) r.shape = rel.style.properties['shape-class'];
                if (rel.style?.properties) {
                    const { 'shape-class': _shape, ...rest } = rel.style.properties;
                    if (Object.keys(rest).length > 0) r.style = rest;
                }
                if (rel.controlPoints) r.controlPoints = rel.controlPoints;
                return r;
            });
        }

        return rootNode;
    }).filter(Boolean);
}

function parseXMind(filePath) {
    const buf = readFileSync(resolve(filePath));
    const zip = openZip(buf);
    const names = zip.names();
    const hasJson = names.includes('content.json');
    const hasXml = names.includes('content.xml');

    // Try zen (JSON) first; fall back to legacy (XML) if result is empty
    if (hasJson) {
        const result = parseXMindZen(filePath);
        if (result.length > 0) return result;
        // Zen was empty/stub — fall through to legacy if available
        if (hasXml) return parseXMindLegacy(filePath);
        return result;
    }
    if (hasXml) return parseXMindLegacy(filePath);
    throw new Error('Unknown XMind format: neither content.json nor content.xml found');
}

// ─── Helper: extract raw content.json text ───

function extractContentText(filePath) {
    try {
        const buf = readFileSync(resolve(filePath));
        const zip = openZip(buf);
        // Try JSON first, then XML
        const rawJson = zip.extract('content.json');
        if (rawJson) return rawJson.toString('utf-8');
        const rawXml = zip.extract('content.xml');
        if (rawXml) return rawXml.toString('utf-8');
        return null;
    } catch { return null; }
}

// ─── Actions ───

function actionRead(input) {
    if (!input.path) throw new Error('Missing "path"');
    return parseXMind(input.path);
}

function actionList(input) {
    const dir = resolve(input.directory || '.');
    const files = [];

    function scan(d) {
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) scan(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.xmind')) files.push(full);
        }
    }

    scan(dir);
    return files;
}

function actionSearchFiles(input) {
    if (!input.pattern && input.pattern !== '') throw new Error('Missing "pattern"');
    const dir = resolve(input.directory || '.');
    const pattern = input.pattern.toLowerCase();
    const filenameMatches = [];
    const contentMatches = [];

    function scan(d) {
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) { scan(full); continue; }
            if (!e.isFile() || !e.name.toLowerCase().endsWith('.xmind')) continue;

            const searchable = [e.name.toLowerCase(), basename(e.name, '.xmind').toLowerCase(), full.toLowerCase()];
            if (pattern === '' || searchable.some(t => t.includes(pattern))) {
                filenameMatches.push(full);
            } else {
                const text = extractContentText(full);
                if (text && text.toLowerCase().includes(pattern)) contentMatches.push(full);
            }
        }
    }

    scan(dir);
    const sortByName = (a, b) => basename(a).localeCompare(basename(b));
    return [...filenameMatches.sort(sortByName), ...contentMatches.sort(sortByName)];
}

function actionReadMultiple(input) {
    if (!input.paths?.length) throw new Error('Missing "paths"');
    return input.paths.map(filePath => {
        try {
            return { filePath, content: parseXMind(filePath) };
        } catch (err) {
            return { filePath, content: [], error: err.message };
        }
    });
}

// ─── Node search helpers ───

function getNodePath(node, parents = []) {
    return parents.length > 0 ? `${parents.join(' > ')} > ${node.title}` : node.title;
}

function actionExtractNode(input) {
    if (!input.path || !input.searchQuery) throw new Error('Missing "path" or "searchQuery"');
    const sheets = parseXMind(input.path);

    function calculateRelevance(nodePath, query) {
        const pathLower = nodePath.toLowerCase();
        const queryLower = query.toLowerCase();
        if (pathLower.includes(queryLower)) return 1.0;
        const pathWords = pathLower.split(/[\s>]+/);
        const queryWords = queryLower.split(/[\s>]+/);
        const matching = queryWords.filter(w => pathWords.some(pw => pw.includes(w)));
        return matching.length / queryWords.length;
    }

    function findFuzzy(node, query, parents = []) {
        const results = [];
        const currentPath = getNodePath(node, parents);
        const confidence = calculateRelevance(currentPath, query);
        if (confidence > 0.5) results.push({ node, matchConfidence: confidence, path: currentPath });
        const newParents = [...parents, node.title];
        if (node.children) {
            for (const child of node.children) results.push(...findFuzzy(child, query, newParents));
        }
        if (node.detachedTopics) {
            for (const dt of node.detachedTopics) results.push(...findFuzzy(dt, query, newParents));
        }
        return results;
    }

    const allMatches = sheets.flatMap(sheet => findFuzzy(sheet, input.searchQuery));
    allMatches.sort((a, b) => b.matchConfidence - a.matchConfidence);

    return {
        matches: allMatches.slice(0, 5),
        totalMatches: allMatches.length,
        query: input.searchQuery,
    };
}

function actionExtractNodeById(input) {
    if (!input.path || !input.nodeId) throw new Error('Missing "path" or "nodeId"');
    const sheets = parseXMind(input.path);

    function findById(node, id) {
        if (node.id === id) return node;
        if (node.children) {
            for (const child of node.children) {
                const r = findById(child, id);
                if (r) return r;
            }
        }
        if (node.detachedTopics) {
            for (const dt of node.detachedTopics) {
                const r = findById(dt, id);
                if (r) return r;
            }
        }
        return null;
    }

    for (const sheet of sheets) {
        const found = findById(sheet, input.nodeId);
        if (found) return { found: true, node: found };
    }
    return { found: false, error: `Node not found: ${input.nodeId}` };
}

function actionSearchNodes(input) {
    if (!input.path || (input.query == null && !input.taskStatus)) throw new Error('Missing "path" and "query" or "taskStatus"');
    const sheets = parseXMind(input.path);
    const searchFields = input.searchIn || ['title', 'notes', 'labels', 'callouts', 'tasks'];
    const caseSensitive = input.caseSensitive || false;
    const searchQuery = input.query != null ? (caseSensitive ? input.query : input.query.toLowerCase()) : '';

    function matchesText(text) {
        if (!text) return false;
        const t = caseSensitive ? text : text.toLowerCase();
        return t.includes(searchQuery);
    }

    function search(node, parents = []) {
        const matches = [];

        const matchedIn = [];
        if (searchFields.includes('title') && matchesText(node.title)) matchedIn.push('title');
        if (searchFields.includes('notes') && node.notes?.content && matchesText(node.notes.content)) matchedIn.push('notes');
        if (searchFields.includes('labels') && node.labels?.some(l => matchesText(l))) matchedIn.push('labels');
        if (searchFields.includes('callouts') && node.callouts?.some(c => matchesText(c.title))) matchedIn.push('callouts');
        if (searchFields.includes('tasks') && node.taskStatus) matchedIn.push('tasks');

        const textMatched = searchQuery !== '' && matchedIn.length > 0;
        const taskMatched = input.taskStatus && node.taskStatus === input.taskStatus;
        // Task status filter: only include nodes that match, but always recurse into children
        const taskExcluded = input.taskStatus && node.taskStatus && node.taskStatus !== input.taskStatus;
        const shouldInclude = (textMatched || taskMatched) && !taskExcluded;

        if (shouldInclude && node.id) {
            const match = {
                id: node.id,
                title: node.title,
                path: getNodePath(node, parents),
                sheet: node.sheetTitle || 'Untitled Map',
                matchedIn,
            };
            if (node.notes?.content) match.notes = node.notes.content;
            if (node.labels) match.labels = node.labels;
            if (node.callouts) match.callouts = node.callouts;
            if (node.taskStatus) match.taskStatus = node.taskStatus;
            matches.push(match);
        }

        const newParents = [...parents, node.title];
        if (node.children) {
            for (const child of node.children) matches.push(...search(child, newParents));
        }
        if (node.detachedTopics) {
            for (const dt of node.detachedTopics) matches.push(...search(dt, newParents));
        }
        return matches;
    }

    const allMatches = sheets.flatMap(sheet => search(sheet));
    return {
        query: input.query,
        matches: allMatches,
        totalMatches: allMatches.length,
        searchedIn: searchFields,
    };
}

function actionFormatInfo(input) {
    if (!input.path) throw new Error('Missing "path"');
    const buf = readFileSync(resolve(input.path));
    const zip = openZip(buf);
    const names = zip.names();
    const hasJson = names.includes('content.json');
    const hasXml = names.includes('content.xml');

    let format, version, description;
    if (hasJson) {
        format = 'zen';
        version = 'XMind Zen / 2020+';
        description = 'Modern JSON-based format (content.json)';
    } else if (hasXml) {
        format = 'legacy';
        version = 'XMind 8 or earlier';
        description = 'Legacy XML-based format (content.xml)';
    } else {
        format = 'unknown';
        version = 'unknown';
        description = 'Could not determine format';
    }

    return {
        path: resolve(input.path),
        format,
        version,
        description,
        files: names,
    };
}

// ─── validate: structural check against what XMind itself reads ───
// Value lists below come from XMind 27's own renderer. No app is opened — the file is only parsed.
const KNOWN = {
    structure: new Set(['map', 'map.clockwise', 'map.anticlockwise', 'map.unbalanced', 'map.unbalanced.symmetric',
        'map.floating', 'map.floating.clockwise', 'map.floating.anticlockwise', 'logic.right', 'logic.left',
        'logic-chart.right', 'logic-chart.left', 'org-chart.down', 'org-chart.up', 'tree.right', 'tree.left',
        'tree.right.btt', 'tree.left.btt', 'tree.branch-aligned.right', 'tree.branch-aligned.left',
        'tree.branch-aligned.right.btt', 'tree.branch-aligned.left.btt', 'fishbone.leftHeaded', 'fishbone.rightHeaded',
        'fishbone.leftHeaded.top', 'fishbone.leftHeaded.bottom', 'fishbone.rightHeaded.top', 'fishbone.rightHeaded.bottom',
        'brace.right', 'brace.left', 'treetable', 'treetable.toptitle', 'treetable.righttitle', 'treetable.bottomtitle',
        'spreadsheet', 'spreadsheet.column', 'grid', 'timeline.horizontal', 'timeline.horizontal.up',
        'timeline.horizontal.down', 'timeline.horizontal.rtl', 'timeline.vertical', 'timeline.vertical.btt',
        'timeline.sided.horizontal', 'timeline.sided.horizontal.rtl', 'timeline.through.vertical',
        'timeline.through.vertical.btt', 'timeline.through.symmetric.vertical', 'timeline.through.symmetric.vertical.btt']
        .map(x => `org.xmind.ui.${x}`)),
    topicShape: new Set(['bookmark', 'callout', 'card', 'circle', 'cloud', 'curlyBracket', 'cutdiamond', 'data', 'database',
        'decision', 'delay', 'diamond', 'document', 'doubleBookQuote', 'doubleQuote', 'doubleroundedangle', 'doubleunderline',
        'ellipse', 'ellipserect', 'ellipticrectangle', 'fatLeftArrow', 'fatRightArrow', 'flag', 'handDrawnEllipse',
        'handDrawnRect', 'handDrawnRoundedRect', 'handDrawnUnderline', 'heart', 'hexagon', 'label', 'leaf', 'manualInput',
        'manualOperation', 'matrixMain', 'multiDocument', 'newcloud', 'noBorder', 'offPageReference', 'onPageReference',
        'parallelogram', 'predefinedProcess', 'rect', 'roundBracket', 'roundedhexagon', 'roundedRect', 'shadowCard', 'shield',
        'simpleCloud', 'singleBookQuote', 'singlebreakangle', 'singlebreakanglewithline', 'squareBracket', 'squareQuote',
        'stack', 'star', 'trapezoid', 'treetable', 'underline', 'waterdrop'].map(x => `org.xmind.topicShape.${x}`)),
    arrow: new Set(['antiTriangle', 'attached', 'diamond', 'dot', 'doublearrow', 'eye', 'herringbone', 'hook', 'none',
        'normal', 'ring', 'spearhead', 'square', 'squarering', 'triangle'].map(x => `org.xmind.arrowShape.${x}`)),
    branch: new Set(['arrowedCurve', 'bight', 'brace', 'curve', 'elbow', 'fold', 'none', 'roundedElbow', 'roundedfold',
        'straight', 'timeline'].map(x => `org.xmind.branchConnection.${x}`)),
    relationship: new Set(['angled', 'curved', 'flexible', 'quad', 'straight', 'threePoint', 'zigzag']
        .map(x => `org.xmind.relationshipShape.${x}`)),
    boundary: new Set(['cross', 'focus', 'newboundary', 'polygon', 'rect', 'roundedPolygon', 'roundedRect', 'scallops',
        'tension', 'waves'].map(x => `org.xmind.boundaryShape.${x}`)),
    summary: new Set(['angle', 'bracket', 'curly', 'fold', 'round', 'sharp', 'square', 'straight']
        .map(x => `org.xmind.summaryShape.${x}`)),
    markerPrefix: /^(task|priority|flag|star|half-star|people|smiley|arrow|month|week|tag|symbol|c_simbol|c_symbol|academic|social|celebration|other)[-_]/,
};
const COLOR_PROPS = ['svg:fill', 'fo:color', 'border-line-color', 'line-color', 'fo:background-color'];

function actionValidate(input) {
    if (!input.path) throw new Error('Missing "path"');
    const errors = [], warnings = [];
    const buf = readFileSync(resolve(input.path));
    const zip = openZip(buf);
    const names = new Set(zip.names());
    const err = m => errors.push(m), warn = m => warnings.push(m);

    if (!names.has('content.json')) {
        if (!names.has('content.xml')) return { valid: false, format: 'unknown', errors: ['neither content.json nor content.xml found'], warnings };
        validateLegacy(zip, names, err, warn);
        return { valid: errors.length === 0, format: 'legacy', errors, warnings };
    }
    if (zip.encrypted && !PASSWORD) return { valid: null, format: 'zen', encrypted: true, passwordHint: zip.passwordHint,
        errors: [], warnings: ['password-protected — pass "password" to validate the content'] };

    let manifest = {};
    try { manifest = JSON.parse(zip.extract('manifest.json')?.toString('utf-8') || '{}'); } catch { err('manifest.json is not valid JSON'); }
    const listed = new Set(Object.keys(manifest['file-entries'] || {}));
    for (const n of names) if (!n.endsWith('/') && !n.startsWith('__MACOSX/') && n !== 'manifest.json' && !listed.has(n) && n !== 'content.xml') warn(`${n} is in the zip but not in manifest.json`);
    for (const n of listed) if (!names.has(n)) err(`manifest.json lists ${n}, which is missing from the zip`);

    let sheets;
    try {
        const parsed = JSON.parse(zip.extract('content.json').toString('utf-8').replace(/^\uFEFF/, ''));
        sheets = Array.isArray(parsed) ? parsed : parsed.sheets;
    } catch (e) { return { valid: false, format: 'zen', errors: [`content.json: ${e.message}`], warnings }; }
    if (!Array.isArray(sheets) || sheets.length === 0) err('content.json has no sheets');

    const ids = new Set();
    const checkXap = (v, where) => {
        if (typeof v === 'string' && v.startsWith('xap:') && !names.has(v.slice(4))) err(`${where}: ${v} is not in the file`);
    };
    const checkStyle = (props, kind, where) => {
        for (const [k, v] of Object.entries(props || {})) {
            if (COLOR_PROPS.includes(k) && typeof v === 'string' && v !== 'none' && v !== 'inherited' && !/^#[0-9a-f]{3,8}$/i.test(v)) {
                warn(`${where}: ${k} "${v}" is not a hex colour`);
            }
            if (k === 'shape-class') {
                const set = kind === 'relationship' ? KNOWN.relationship : kind === 'boundary' ? KNOWN.boundary
                    : kind === 'summary' ? KNOWN.summary : KNOWN.topicShape;
                if (!set.has(v)) err(`${where}: unknown shape "${v}" (XMind draws its default instead)`);
            }
            if ((k === 'arrow-begin-class' || k === 'arrow-end-class') && v !== 'inherited' && !KNOWN.arrow.has(v)) err(`${where}: unknown arrow "${v}" (no arrow head is drawn)`);
            if (k === 'line-class' && v !== 'inherited' && !KNOWN.branch.has(v)) err(`${where}: unknown branch line "${v}"`);
        }
    };

    (sheets || []).forEach((sheet, si) => {
        const sw = `sheet ${si + 1} "${sheet.title ?? ''}"`;
        if (sheet.class !== 'sheet') warn(`${sw}: class should be "sheet"`);
        if (!sheet.theme) warn(`${sw}: no theme object (XMind expects at least {})`);
        const customMarkers = new Set((sheet.customMarkerGroups || []).flatMap(g => (g.markers || []).map(m => m.id)));
        for (const g of sheet.customMarkerGroups || []) for (const m of g.markers || []) checkXap(m.resource, `${sw} custom marker ${m.id}`);
        for (const e of sheet.extensions || []) for (const r of e.resources || []) checkXap(r, `${sw} ${e.provider}`);
        const topicIds = new Set();
        const walk = (t, path) => {
            const w = `${sw} › ${path}`;
            if (!t.id) err(`${w}: topic without id`);
            else if (ids.has(t.id)) err(`${w}: duplicate id ${t.id}`);
            ids.add(t.id); topicIds.add(t.id);
            if (t.summary && !t.children?.summary) err(`${w}: summary topics are under "summary" — XMind only reads children.summary (they won't show)`);
            if (t.structureClass && !KNOWN.structure.has(t.structureClass)) err(`${w}: unknown layout "${t.structureClass}"`);
            checkStyle(t.style?.properties, 'topic', w);
            checkXap(t.href, `${w} link`);
            checkXap(t.image?.src, `${w} image`);
            for (const m of t.markers || []) {
                if (!KNOWN.markerPrefix.test(m.markerId) && !customMarkers.has(m.markerId)) warn(`${w}: marker "${m.markerId}" is neither a built-in nor a custom marker`);
            }
            const n = t.children?.attached?.length || 0;
            for (const b of t.boundaries || []) {
                const m = String(b.range).match(/^\((\d+),(\d+)\)$/);
                if (b.range === 'master') { /* the whole branch */ } else if (!m) err(`${w}: boundary range "${b.range}" must look like "(0,2)" or "master"`);
                else if (+m[2] >= n || +m[1] > +m[2]) err(`${w}: boundary range ${b.range} is outside its ${n} children`);
                checkStyle(b.style?.properties, 'boundary', `${w} boundary`);
            }
            for (const sm of t.summaries || []) {
                if (!(t.children?.summary || []).some(x => x.id === sm.topicId)) err(`${w}: summary ${sm.id} points to a missing summary topic`);
                checkStyle(sm.style?.properties, 'summary', `${w} summary`);
            }
            for (const e of t.extensions || []) {
                for (const r of e.resources || []) checkXap(r, `${w} ${e.provider}`);
                if (e.provider === 'org.xmind.ui.webVideo' && (e.content?.url !== t.href || e.content?.thumbnail !== t.image?.src)) {
                    warn(`${w}: web video url/thumbnail no longer match the topic's link/image — XMind won't show the player`);
                }
                if (e.provider === 'org.xmind.ui.mathJax' && !t.image?.isMathJaxImage) warn(`${w}: equation without its rendered image`);
            }
            for (const [kind, list] of Object.entries(t.children || {})) list.forEach((c, i) => walk(c, `${path} › ${c.title ?? `(${kind} ${i + 1})`}`));
        };
        if (!sheet.rootTopic) err(`${sw}: no rootTopic`); else walk(sheet.rootTopic, sheet.rootTopic.title ?? '(root)');
        for (const r of sheet.relationships || []) {
            if (!topicIds.has(r.end1Id) || !topicIds.has(r.end2Id)) err(`${sw}: relationship ${r.id} points to a topic that doesn't exist`);
            checkStyle(r.style?.properties, 'relationship', `${sw} relationship "${r.title ?? r.id}"`);
        }
    });
    // Second pass: dependency / internal-link targets across the whole workbook.
    const walkAll = t => {
        for (const e of t.extensions || []) for (const d of e.content?.dependencies || []) if (!ids.has(d.id)) err(`task "${t.title}": dependency on missing topic ${d.id}`);
        if (typeof t.href === 'string' && t.href.startsWith('xmind:#') && !ids.has(t.href.slice(7))) warn(`"${t.title}": internal link to a missing topic`);
        for (const list of Object.values(t.children || {})) list.forEach(walkAll);
    };
    (sheets || []).forEach(sh => sh.rootTopic && walkAll(sh.rootTopic));
    return { valid: errors.length === 0, format: 'zen', encrypted: zip.encrypted, sheets: sheets?.length || 0, topics: ids.size, errors, warnings };
}

function validateLegacy(zip, names, err, warn) {
    const xml = zip.extract('content.xml').toString('utf-8');
    if (/<topic[^>]*>\s*<title>[^<]*<\/title>\s*(<position[^>]*\/>\s*)?<style>/.test(xml)) {
        err('topic styles are inline <style> elements — XMind 8 only reads styles.xml via style-id (they are ignored)');
    }
    const styleIds = [...xml.matchAll(/style-id="([^"]+)"/g)].map(m => m[1]);
    if (styleIds.length > 0) {
        if (!names.has('styles.xml')) err('style-id is used but styles.xml is missing');
        else {
            const sx = zip.extract('styles.xml').toString('utf-8');
            for (const id of styleIds) if (!sx.includes(`id="${id}"`)) err(`style-id ${id} is not defined in styles.xml`);
        }
    }
    for (const m of xml.matchAll(/xap:([^"]+)"/g)) if (!names.has(m[1])) err(`${m[1]} is referenced but missing`);
    return {};
}

// ─── export: Markdown / OPML / plain-text outline ───
function actionExport(input) {
    if (!input.path) throw new Error('Missing "path"');
    const format = (input.format || 'markdown').toLowerCase();
    const roots = parseXMind(input.path);
    const sheetsWanted = input.sheet ? [roots[input.sheet - 1]].filter(Boolean) : roots;
    let out;
    if (format === 'markdown' || format === 'md') out = sheetsWanted.map(exportMarkdown).join('\n\n');
    else if (format === 'opml') out = exportOpml(sheetsWanted, basename(input.path, '.xmind'));
    else if (format === 'text' || format === 'txt') out = sheetsWanted.map(r => exportText(r, 0)).join('\n');
    else throw new Error(`Unknown export format "${input.format}". Use markdown, opml or text.`);
    if (input.output) {
        writeFileSync(resolve(input.output), out);
        return { written: resolve(input.output), format, bytes: Buffer.byteLength(out) };
    }
    return { format, content: out };
}

const plainNote = t => (t.notes?.content || (t.notes?.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
const mdTitle = t => {
    let s = (t.title || (t.equation ? `$${t.equation}$` : '')).replace(/\n/g, ' ');
    if (t.href && !t.href.startsWith('xap:') && !t.href.startsWith('xmind:')) s = `[${s || t.href}](${t.href})`;
    if (t.labels?.length) s += ` *(${t.labels.join(', ')})*`;
    return s;
};

function exportMarkdown(root) {
    const lines = [`# ${root.sheetTitle}`, '', `## ${mdTitle(root)}`];
    const note = plainNote(root);
    if (note) lines.push('', ...note.split('\n').map(l => `> ${l}`));
    const walk = (t, depth) => {
        const box = t.taskStatus === 'done' ? '[x] ' : t.taskStatus === 'todo' ? '[ ] ' : '';
        lines.push(`${'  '.repeat(depth)}- ${box}${mdTitle(t)}`);
        const n = plainNote(t);
        if (n) lines.push(...n.split('\n').map(l => `${'  '.repeat(depth + 1)}> ${l}`));
        for (const c of t.children || []) walk(c, depth + 1);
    };
    lines.push('');
    for (const c of root.children || []) walk(c, 0);
    for (const d of root.detachedTopics || []) walk(d, 0);
    return lines.join('\n');
}

function exportOpml(roots, name) {
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
    const node = (t, ind) => {
        const note = plainNote(t);
        const attrs = `text="${esc(t.title)}"${note ? ` _note="${esc(note)}"` : ''}`;
        const kids = [...(t.children || []), ...(t.detachedTopics || [])];
        if (kids.length === 0) return `${ind}<outline ${attrs}/>`;
        return `${ind}<outline ${attrs}>\n${kids.map(c => node(c, ind + '  ')).join('\n')}\n${ind}</outline>`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${esc(name)}</title></head>\n  <body>\n` +
        roots.map(r => node(r, '    ')).join('\n') + '\n  </body>\n</opml>\n';
}

function exportText(t, depth) {
    const lines = [`${'\t'.repeat(depth)}${(t.title || '').replace(/\n/g, ' ')}`];
    for (const c of t.children || []) lines.push(exportText(c, depth + 1));
    for (const d of t.detachedTopics || []) lines.push(exportText(d, depth + 1));
    return lines.join('\n');
}

// ─── decrypt: write an unprotected copy (used by preview_xmind.py --password) ───
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function storedZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf-8'), crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
        locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

function actionDecrypt(input) {
    if (!input.path || !input.output) throw new Error('Missing "path" or "output"');
    const zip = openZip(readFileSync(resolve(input.path)));
    if (!zip.encrypted) throw new Error('The file is not password-protected.');
    const entries = [];
    const manifest = { 'file-entries': {} };
    for (const name of zip.names()) {
        if (name.endsWith('/') || name === 'manifest.json') continue;
        entries.push({ name, data: zip.extract(name) });
        manifest['file-entries'][name] = {};
    }
    entries.splice(Math.min(2, entries.length), 0, { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
    writeFileSync(resolve(input.output), storedZip(entries));
    return { written: resolve(input.output), entries: entries.length };
}

// ─── XMind's sticker / illustration library (read from the installed app, never started) ───
function xmindAsarPath() {
    return [process.env.XMIND_APP_ASAR, '/Applications/Xmind.app/Contents/Resources/app.asar',
        `${process.env.HOME || ''}/Applications/Xmind.app/Contents/Resources/app.asar`,
        `${process.env.LOCALAPPDATA || ''}/Programs/Xmind/resources/app.asar`, 'C:/Program Files/Xmind/resources/app.asar',
        '/opt/Xmind/resources/app.asar', '/usr/lib/xmind/resources/app.asar'].filter(Boolean).find(p => existsSync(p));
}

function listLibrary(dir, filter) {
    const path = xmindAsarPath();
    if (!path) throw new Error('No XMind installation found (set XMIND_APP_ASAR to its app.asar). Stickers and illustrations come from XMind\'s own library.');
    const buf = readFileSync(path);
    const header = JSON.parse(buf.toString('utf-8', 16, 16 + buf.readUInt32LE(12)));
    let node = header;
    for (const part of dir.split('/')) node = node?.files?.[part];
    const out = [];
    const walk = (n, prefix) => {
        for (const [name, child] of Object.entries(n?.files || {})) {
            if (child.files) walk(child, `${prefix}${name}/`);
            else if (/\.(svg|png)$/i.test(name)) out.push((prefix + name).replace(/\.(svg|png)$/i, ''));
        }
    };
    walk(node, '');
    const q = (filter || '').toLowerCase();
    const items = q ? out.filter(n => n.toLowerCase().includes(q)) : out;
    return { source: path, count: items.length, items };
}

const actionListStickers = input => listLibrary('static/snowbird/resource/stickers', input.query);
const actionListIllustrations = input => listLibrary('static/snowbird/resource/illustrations', input.query);

// ─── Main ───

const actions = {
    read: actionRead,
    list: actionList,
    search_files: actionSearchFiles,
    read_multiple: actionReadMultiple,
    extract_node: actionExtractNode,
    extract_node_by_id: actionExtractNodeById,
    search_nodes: actionSearchNodes,
    format_info: actionFormatInfo,
    validate: actionValidate,
    decrypt: actionDecrypt,
    export: actionExport,
    list_stickers: actionListStickers,
    list_illustrations: actionListIllustrations,
};

async function main() {
    let rawInput = '';
    for await (const chunk of process.stdin) rawInput += chunk;

    const input = JSON.parse(rawInput);
    if (!input.action) throw new Error('Missing "action" field');
    if (typeof input.password === 'string') PASSWORD = input.password;

    const handler = actions[input.action];
    if (!handler) throw new Error(`Unknown action: "${input.action}". Valid: ${Object.keys(actions).join(', ')}`);

    const result = handler(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
});
