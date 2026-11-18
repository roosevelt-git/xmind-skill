#!/usr/bin/env node

// XMind file reader - reads JSON from stdin, outputs parsed data to stdout
// Usage: echo '{"action":"read","path":"/tmp/file.xmind"}' | node read_xmind.mjs
// No external dependencies — uses only Node.js built-ins.

import { readFileSync, readdirSync, statSync, lstatSync } from 'fs';
import { resolve, join, basename, normalize } from 'path';
import { buildZip } from './lib/zip.mjs';
import { openZip } from './lib/crypto.mjs';
import { validateBuffer } from './lib/validate.mjs';
import { listLibrary } from './lib/asar.mjs';
import { TOPIC_INPUT_FIELDS, IMAGE_KEYS } from './lib/known.mjs';
import { writeFileAtomicSync, sanitizeNoteHtml } from './lib/util.mjs';


// ─── Minimal ZIP reader (PKZIP APPNOTE 6.3.3) ───

// ─── Minimal XML parser (for XMind 8 legacy content.xml) ───

// Named and numeric character references (&amp; &#10; &#x4E2D;) — unknown names are kept as written.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
        }
        return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
}

function xmlError(what) {
    return new Error(`Invalid XMind 8 file: ${what} — the file looks damaged or truncated`);
}

function stripDeclarations(xml) {
    let out = '', i = 0;
    const lower = xml.toLowerCase();
    // Each search resumes from its last hit and stops for good once a marker is absent, so the
    // whole scan is linear however many declarations the file holds.
    let pi = -2, dt = -2;
    while (i < xml.length) {
        if (pi !== -1 && pi < i) pi = xml.indexOf('<?', i);
        if (dt !== -1 && dt < i) dt = lower.indexOf('<!doctype', i);
        const next = pi === -1 ? dt : dt === -1 ? pi : Math.min(pi, dt);
        if (next === -1) { out += xml.slice(i); break; }
        out += xml.slice(i, next);
        const end = next === pi ? xml.indexOf('?>', next + 2) : xml.indexOf('>', next + 9);
        if (end === -1) throw xmlError(next === pi ? 'unterminated <?…?> declaration' : 'unterminated <!DOCTYPE');
        i = end + (next === pi ? 2 : 1);
    }
    return out.trim();
}

function parseXml(xml) {
    // Returns a tree of {tag, attrs, children, text}
    let pos = 0;

    // Strip processing instructions (<?...?>) and DOCTYPE declarations — by scanning, not a regex,
    // so a crafted file full of unterminated "<!DOCTYPE" can't make this quadratic. A DTD is never
    // processed (no entity expansion, no external entities).
    xml = stripDeclarations(xml);

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
                const end = xml.indexOf(quote, pos);
                if (end < 0) throw xmlError(`unterminated attribute "${name}"`);
                attrs[name] = decodeEntities(xml.substring(pos, end));
                pos = end + 1; // skip closing quote
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
            const end = xml.indexOf('-->', pos + 4);
            if (end < 0) throw xmlError('unterminated comment');
            pos = end + 3;
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
        if (pos >= xml.length) throw xmlError(`<${tag}> is cut off`);
        pos++; // skip >

        // Parse children and text content
        // `parts` preserves interleaving order of text and child elements (for mixed content like HTML)
        const children = [];
        const parts = [];
        let text = '';
        let closed = false;

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
                    if (end < 0) throw xmlError(`closing tag of <${tag}> is cut off`);
                    pos = end + 1;
                    closed = true;
                    break;
                }
                if (xml.startsWith('<!--', pos)) {
                    const end = xml.indexOf('-->', pos + 4);
                    if (end < 0) throw xmlError('unterminated comment');
                    pos = end + 3;
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
                t = decodeEntities(t);
                text += t;
                parts.push({ type: 'text', value: t });
            }
        }
        if (!closed) throw xmlError(`<${tag}> is never closed`);

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

// A task date from the file, or null when it isn't a usable timestamp (one bad date must not fail the read).
function isoDate(v) {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_LINK = /^(https?:|mailto:|xmind:#)/i;

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
            // Entities were decoded while parsing; escape again so text can't become markup.
            html += escHtml(part.value);
        } else if (part.type === 'element') {
            const child = part.value;
            const localTag = child.tag.includes(':') ? child.tag.split(':').pop() : child.tag;
            if (['p', 'span', 'strong', 'em', 'u', 'br', 'ul', 'ol', 'li', 'a', 'img', 'b', 'i', 'sub', 'sup', 'del', 's'].includes(localTag)) {
                const styleAttr = child.attrs?.style ? ` style="${escHtml(child.attrs.style)}"` : '';
                const hrefAttr = child.attrs?.['xlink:href'] || child.attrs?.href;
                const hrefStr = hrefAttr && SAFE_LINK.test(hrefAttr) ? ` href="${escHtml(hrefAttr)}"` : '';
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
                // Store unknown attribute directly (camelCase the key) — never as a field create acts on.
                const camel = key.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
                if (!TOPIC_INPUT_FIELDS.has(camel)) result[camel] = val;
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
                // Text directly in <html> (how this skill's writer stores it, as CDATA) is reduced to
                // plain formatting tags; xhtml:* elements are rebuilt with their text escaped again.
                const html = htmlEl.children?.length > 0 ? reconstructHtml(htmlEl) : sanitizeNoteHtml(htmlEl.text || '');
                if (html) result.notes.html = html;
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
        if (src && src.startsWith('xap:')) result.image = { src };  // embedded only, never a disk path
        const w = imageEl.attrs?.['svg:width'] || xmlAttr(imageEl, 'width');
        const h = imageEl.attrs?.['svg:height'] || xmlAttr(imageEl, 'height');
        // Numbers, like the modern format (and what create_xmind.mjs accepts back).
        if (w && result.image && Number(w) > 0) result.image.width = Number(w);
        if (h && result.image && Number(h) > 0) result.image.height = Number(h);
        const align = imageEl.attrs?.align || xmlAttr(imageEl, 'align');
        if (align && result.image) result.image.align = align;
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
                if (start && isoDate(parseInt(start, 10))) result.startDate = isoDate(parseInt(start, 10));
                if (due && isoDate(parseInt(due, 10))) result.dueDate = isoDate(parseInt(due, 10));
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
                result.style = boundedStyle({ ...(result.style || {}), ...propsEl.attrs });
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
// A real XMind style has a few dozen properties. A shared style is copied onto every topic that uses
// it, so its size is bounded: a crafted styles.xml can't turn a small file into a huge read.
const MAX_STYLE_PROPS = 64, MAX_STYLE_VALUE = 256;
function boundedStyle(props) {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(props || {})) {
        if (n++ >= MAX_STYLE_PROPS) break;
        if (k.length <= 64 && String(v).length <= MAX_STYLE_VALUE) out[k] = v;
    }
    return out;
}

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
                stylesMap.set(id, boundedStyle(props));
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
        result.style = { ...props, ...(result.style || {}) };
    }
    // Recurse into children
    if (result.children) {
        for (const child of result.children) resolveTopicStyle(child, stylesMap);
    }
    if (result.detachedTopics) {
        for (const dt of result.detachedTopics) resolveTopicStyle(dt, stylesMap);
    }
}

// Same shape as the modern reader: `style` holds XMind's own property names without the shape
// (which is `shape`), so create_xmind.mjs takes a legacy read verbatim — also when converting to zen.
function finishLegacyStyle(result) {
    if (result.style) {
        const { 'shape-class': _shape, 'fo:shape-class': _foShape, ...rest } = result.style;
        if (Object.keys(rest).length > 0) result.style = rest;
        else delete result.style;
    }
    for (const child of result.children || []) finishLegacyStyle(child);
    for (const dt of result.detachedTopics || []) finishLegacyStyle(dt);
}

function parseXMindLegacy(zip) {
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
        finishLegacyStyle(rootNode);

        return rootNode;
    });
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
    if (typeof node.image?.src === 'string' && node.image.src.startsWith('xap:') && !node.image.isMathJaxImage) {
        result.image = {};
        for (const k of IMAGE_KEYS) if (node.image[k] != null) result.image[k] = node.image[k];
    }
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
    if (typeof audio === 'string' && audio.startsWith('xap:')) result.audio = audio;
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
            if (isoDate(c.start)) result.startDate = isoDate(c.start);
            if (isoDate(c.due)) result.dueDate = isoDate(c.due);
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

function parseXMindZen(zip) {
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

// The file is read and unzipped once; the parsers get the open archive.
function parseXMind(filePath, password = null) {
    const zip = openZip(readFileSync(resolve(filePath)), password);
    const names = zip.names();
    const hasJson = names.includes('content.json');
    const hasXml = names.includes('content.xml');

    // Try zen (JSON) first; fall back to legacy (XML) if result is empty
    if (hasJson) {
        const result = parseXMindZen(zip);
        if (result.length > 0) return result;
        // Zen was empty/stub — fall through to legacy if available
        if (hasXml) return parseXMindLegacy(zip);
        return result;
    }
    if (hasXml) return parseXMindLegacy(zip);
    throw new Error('Unknown XMind format: neither content.json nor content.xml found');
}

// sheetTitle is kept on the sheet's root topic only — repeating it on every node only costs tokens.
function stripSheetTitles(node, keep = true) {
    if (!node || typeof node !== 'object') return node;
    if (!keep) delete node.sheetTitle;
    for (const c of node.children || []) stripSheetTitles(c, false);
    for (const d of node.detachedTopics || []) stripSheetTitles(d, false);
    return node;
}

// ─── Helper: the words a person sees in a map (not its JSON / XML markup) ───

// Sheet and topic titles, notes, labels, callouts, summaries, boundaries and relationship titles — so a
// search for "topic" or "class" doesn't match every file through its markup. null if unreadable
// (e.g. password-protected without a password).
function extractContentText(filePath, password = null) {
    let roots;
    try { roots = parseXMind(filePath, password); } catch { return null; }
    const out = [];
    const strip = h => String(h || '').replace(/<[^<>]*>/g, ' ');
    const walk = t => {
        out.push(t.title, t.notes?.content, strip(t.notes?.html), ...(t.labels || []),
            ...(t.callouts || []).map(c => c.title), ...(t.summaries || []).map(x => x.topicTitle),
            ...(t.boundaries || []).map(b => b.title), ...(t.relationships || []).map(r => r.title));
        for (const c of t.children || []) walk(c);
        for (const d of t.detachedTopics || []) walk(d);
    };
    for (const r of roots) { out.push(r.sheetTitle); walk(r); }
    return out.filter(Boolean).join('\n');
}

// ─── Actions ───

// maxDepth: keep topics down to that depth (root = 0); deeper ones are replaced by childCount.
function limitDepth(node, maxDepth, depth = 0) {
    if (maxDepth == null) return node;
    for (const key of ['children', 'detachedTopics']) {
        if (!node[key]) continue;
        if (depth >= maxDepth) {
            node.childCount = (node.childCount || 0) + node[key].length;
            delete node[key];
        } else {
            node[key].forEach(c => limitDepth(c, maxDepth, depth + 1));
        }
    }
    return node;
}

function actionRead(input) {
    if (!input.path) throw new Error('Missing "path"');
    return parseXMind(input.path, input.password).map(r => limitDepth(stripSheetTitles(r), input.maxDepth));
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

            // The file name or its path below the searched directory (not the directory itself, which
            // every file shares).
            const searchable = [e.name.toLowerCase(), full.slice(dir.length + 1).toLowerCase()];
            if (pattern === '' || searchable.some(t => t.includes(pattern))) {
                filenameMatches.push(full);
            } else {
                const text = extractContentText(full, input.password);
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
            return { filePath, content: parseXMind(filePath, input.password).map(r => limitDepth(stripSheetTitles(r), input.maxDepth)) };
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
    const sheets = parseXMind(input.path, input.password);

    // The topic's own title counts most; a word found only in an ancestor counts half, so searching a
    // parent's name no longer matches every descendant. Words of 1–2 characters must match exactly.
    const words = t => String(t || '').toLowerCase().split(/[\s>/,.;:()\[\]"'!?-]+/).filter(Boolean);
    const wordHit = (w, list) => list.some(x => (w.length >= 3 ? x.includes(w) : x === w));
    function calculateRelevance(title, parents, query) {
        const t = String(title || '').toLowerCase(), q = query.toLowerCase().trim();
        if (!q) return 0;
        if (t === q) return 1.0;
        // Substring match only for queries of 3+ characters; a short query must be a whole word.
        if (q.length >= 3 ? t.includes(q) : words(t).includes(q)) return 0.9;
        const qw = words(q), tw = words(t), aw = parents.flatMap(words);
        if (qw.length === 0) return 0;
        const score = qw.reduce((sum, w) => sum + (wordHit(w, tw) ? 1 : wordHit(w, aw) ? 0.5 : 0), 0);
        return Math.round((score / qw.length) * 0.85 * 100) / 100;
    }

    // The matched topic without its subtree (childCount says how much is below); includeChildren: true
    // returns the whole subtree.
    const summarize = node => {
        if (input.includeChildren) return stripSheetTitles({ ...node }, false);
        const { children, detachedTopics, ...rest } = node;
        delete rest.sheetTitle;
        const childCount = (children?.length || 0) + (detachedTopics?.length || 0);
        return childCount ? { ...rest, childCount } : rest;
    };

    function findFuzzy(node, query, parents = []) {
        const results = [];
        const currentPath = getNodePath(node, parents);
        const confidence = calculateRelevance(node.title, parents, query);
        if (confidence > 0.5) {
            results.push({ node: summarize(node), matchConfidence: confidence, path: currentPath, sheet: node.sheetTitle });
        }
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
        matches: allMatches.slice(0, input.limit || 5),
        totalMatches: allMatches.length,
        query: input.searchQuery,
    };
}

function actionExtractNodeById(input) {
    if (!input.path || !input.nodeId) throw new Error('Missing "path" or "nodeId"');
    const sheets = parseXMind(input.path, input.password);

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
        if (found) return { found: true, sheet: found.sheetTitle, node: stripSheetTitles({ ...found }, false) };
    }
    return { found: false, error: `Node not found: ${input.nodeId}` };
}

function actionSearchNodes(input) {
    if (!input.path) throw new Error('Missing "path"');
    if (input.query == null && !input.taskStatus && !(input.searchIn || []).includes('tasks')) {
        throw new Error('Give "query", "taskStatus", or "searchIn": ["tasks"]');
    }
    const sheets = parseXMind(input.path, input.password);
    // query is matched in searchIn (default: title, notes, labels, callouts); "tasks" in searchIn matches
    // the task status text, or — without a query — every topic that has a task. taskStatus is a filter
    // combined with the query (AND), never an alternative to it.
    const searchFields = input.searchIn || ['title', 'notes', 'labels', 'callouts'];
    const caseSensitive = input.caseSensitive || false;
    const searchQuery = input.query != null ? (caseSensitive ? String(input.query) : String(input.query).toLowerCase()) : '';
    const htmlText = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^<>]*>/g, '');

    function matchesText(text) {
        if (!text) return false;
        const t = caseSensitive ? text : text.toLowerCase();
        return t.includes(searchQuery);
    }

    function search(node, parents = []) {
        const matches = [];

        const matchedIn = [];
        if (searchQuery !== '') {
            if (searchFields.includes('title') && matchesText(node.title)) matchedIn.push('title');
            if (searchFields.includes('notes') && (matchesText(node.notes?.content) || matchesText(htmlText(node.notes?.html)))) matchedIn.push('notes');
            if (searchFields.includes('labels') && node.labels?.some(l => matchesText(l))) matchedIn.push('labels');
            if (searchFields.includes('callouts') && node.callouts?.some(c => matchesText(c.title))) matchedIn.push('callouts');
            if (searchFields.includes('tasks') && matchesText(node.taskStatus)) matchedIn.push('tasks');
        } else if (searchFields.includes('tasks') && node.taskStatus) {
            matchedIn.push('tasks');
        }

        const textOk = searchQuery !== '' ? matchedIn.length > 0
            : (input.taskStatus ? true : matchedIn.includes('tasks'));
        const statusOk = !input.taskStatus || node.taskStatus === input.taskStatus;
        const shouldInclude = textOk && statusOk;

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
    const zip = openZip(readFileSync(resolve(input.path)), input.password);
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

// ─── validate (lib/validate.mjs — also run by create_xmind.mjs after writing) ───
function actionValidate(input) {
    if (!input.path) throw new Error('Missing "path"');
    return validateBuffer(readFileSync(resolve(input.path)), { password: input.password });
}

// ─── XMind's sticker / illustration library (read from the installed app, never started) ───
const actionListStickers = input => listLibrary('sticker', input.query);
const actionListIllustrations = input => listLibrary('illustration', input.query);

// `output` of export / decrypt: an existing file is only replaced with "overwrite": true, and a
// symlink there is replaced itself, never followed.
function writeOutput(input, data, opts) {
    const out = resolve(input.output);
    let exists = false;
    try { lstatSync(out); exists = true; } catch { /* new file */ }
    if (exists && input.overwrite !== true) {
        throw new Error(`"${input.output}" already exists. Nothing was written. Pass "overwrite": true to replace it, or choose another "output".`);
    }
    writeFileAtomicSync(out, data, { ...opts, follow: false });
}

// ─── export: Markdown / OPML / plain-text outline ───
function actionExport(input) {
    if (!input.path) throw new Error('Missing "path"');
    const format = (input.format || 'markdown').toLowerCase();
    const roots = parseXMind(input.path, input.password);
    const sheetsWanted = input.sheet ? [roots[input.sheet - 1]].filter(Boolean) : roots;
    let out;
    if (format === 'markdown' || format === 'md') out = sheetsWanted.map(exportMarkdown).join('\n\n');
    else if (format === 'opml') out = exportOpml(sheetsWanted, basename(input.path, '.xmind'));
    else if (format === 'text' || format === 'txt') out = sheetsWanted.map(r => exportText(r, 0)).join('\n');
    else throw new Error(`Unknown export format "${input.format}". Use markdown, opml or text.`);
    if (input.output) {
        // A protected map's outline is owner-only, like the decrypted copy.
        writeOutput(input, out, input.password ? { mode: 0o600, forceMode: true } : {});
        return { written: resolve(input.output), format, bytes: Buffer.byteLength(out) };
    }
    return { format, content: out };
}

const plainNote = t => (t.notes?.content || (t.notes?.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div)>/gi, '\n').replace(/<[^<>]*>/g, '')).trim();
// Map text is someone else's: in Markdown it stays text (no raw HTML, images, fake links or extra
// lines), and only http(s) / mailto links are made clickable.
const mdText = s => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1').replace(/!(?=\\\[)/g, '\\!')
    .replace(/^(\s*)([#>+=~-]|\d+[.)])/, '$1\\$2');  // no heading / quote / list started by the text itself
const mdUrl = u => String(u).replace(/[\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const mdTitle = t => {
    // An equation stays LaTeX, inside a code span (nothing in it is rendered as Markdown or HTML).
    let s = t.title ? mdText(t.title)
        : t.equation ? `\`$${String(t.equation).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/`/g, "'")}$\`` : '';
    if (t.href && /^(https?:|mailto:)/i.test(t.href)) s = `[${s || mdText(t.href)}](${mdUrl(t.href)})`;
    if (t.labels?.length) s += ` *(${t.labels.map(mdText).join(', ')})*`;
    return s;
};

function exportMarkdown(root) {
    const lines = [`# ${mdText(root.sheetTitle)}`, '', `## ${mdTitle(root)}`];
    const note = plainNote(root);
    if (note) lines.push('', ...note.split(/\r?\n|\r/).map(l => `> ${mdText(l)}`));
    const walk = (t, depth) => {
        const box = t.taskStatus === 'done' ? '[x] ' : t.taskStatus === 'todo' ? '[ ] ' : '';
        lines.push(`${'  '.repeat(depth)}- ${box}${mdTitle(t)}`);
        const n = plainNote(t);
        if (n) lines.push(...n.split(/\r?\n|\r/).map(l => `${'  '.repeat(depth + 1)}> ${mdText(l)}`));
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
function actionDecrypt(input) {
    if (!input.path || !input.output) throw new Error('Missing "path" or "output"');
    const zip = openZip(readFileSync(resolve(input.path)), input.password);
    if (!zip.encrypted) throw new Error('The file is not password-protected.');
    const entries = [];
    const manifest = { 'file-entries': {} };
    for (const name of zip.names()) {
        if (name.endsWith('/') || name === 'manifest.json') continue;
        entries.push({ name, data: zip.extract(name) });
        manifest['file-entries'][name] = {};
    }
    entries.splice(Math.min(2, entries.length), 0, { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
    // The decrypted copy is readable by its owner only.
    writeOutput(input, buildZip(entries), { mode: 0o600, forceMode: true });
    return { written: resolve(input.output), entries: entries.length };
}

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

    const handler = actions[input.action];
    if (!handler) throw new Error(`Unknown action: "${input.action}". Valid: ${Object.keys(actions).join(', ')}`);

    const result = handler(input);
    // Compact by default (half the tokens of pretty-printed JSON); "pretty": true for humans.
    process.stdout.write(JSON.stringify(result, null, input.pretty ? 2 : 0) + '\n');
}

main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
});
