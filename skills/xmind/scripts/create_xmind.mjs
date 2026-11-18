#!/usr/bin/env node

// XMind file creator - reads JSON from stdin, writes .xmind file
// Usage: echo '{"path":"/tmp/test.xmind","sheets":[...]}' | node create_xmind.mjs
// Or:   node create_xmind.mjs --path /tmp/test.xmind < data.json
// No external dependencies — uses only Node.js built-ins.

import { mkdir, readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, extname, basename, join } from 'path';
import { createHash } from 'crypto';
import { buildZip, readZip } from './lib/zip.mjs';
import { encryptEntry, openZip, PASSWORD_REQUIRED, WRONG_PASSWORD } from './lib/crypto.mjs';
import { libraryAsset } from './lib/asar.mjs';
import { latexToSvg, escapeSvg } from './lib/latex.mjs';
import { buildLegacy, buildLegacyMeta, buildLegacyManifest } from './lib/legacy-writer.mjs';
import { generateId, quoteHint, writeFileAtomicSync } from './lib/util.mjs';
import { validateBuffer } from './lib/validate.mjs';
import * as K from './lib/known.mjs';

const { BRANCH_LINES, ARROW_ALIASES, FILL_PATTERNS, NUMBERING } = K;
const ARROWS = new Set(K.ARROWS);
const LINE_PATTERNS = new Set(K.LINE_PATTERNS);
const STROKE_PATTERNS = new Set(K.STROKE_PATTERNS);
const TEXT_TRANSFORMS = new Set(K.TEXT_TRANSFORMS);
const TEXT_ALIGNS = new Set(K.TEXT_ALIGNS);
const IMAGE_ALIGNS = new Set(K.IMAGE_ALIGNS);
const BOUNDARY_SHAPES = new Set(K.BOUNDARY_SHAPES);
const SUMMARY_SHAPES = new Set(K.SUMMARY_SHAPES);
const TASK_STATUSES = new Set(K.TASK_STATUSES);
export const VERSION = '4.0.0';

// A layout / shape value: the full XMind class, or its short form ("logic.right", "diamond").
// Unknown values are rejected — XMind would silently draw its default instead.
function xmindClass(value, prefix, known, field, where) {
    const full = String(value).startsWith(prefix) ? String(value) : prefix + value;
    if (!known.has(full)) {
        const names = [...known].map(n => n.slice(prefix.length));
        const near = names.filter(n => n.toLowerCase().includes(String(value).replace(prefix, '').toLowerCase().slice(0, 4))).slice(0, 6);
        throw new Error(`${where}: unknown ${field} "${value}"` + (near.length ? ` — did you mean ${near.join(', ')}?` : '') +
            ` (all values are listed in lib/known.mjs).`);
    }
    return full;
}

// ISO 8601 dates ("2026-02-01", "2026-02-01T09:00:00Z") or epoch milliseconds; anything else is an error
// (a silently invalid date would show up in XMind as 1 January 1970).
function taskDate(value, field, where) {
    const t = typeof value === 'number' ? value
        : /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(String(value).trim()) ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) {
        throw new Error(`${where}: ${field} ${JSON.stringify(value)} is not a valid date — use ISO 8601, e.g. "2026-02-01" or "2026-02-01T09:00:00Z".`);
    }
    return t;
}

// Reads an existing .xmind file (if any) at `path` so its per-sheet theme/extensions and
// embedded resources (e.g. Thumbnails/thumbnail.png) can be carried into the regenerated file.
// Returns null if there's nothing to preserve (file doesn't exist, isn't zen-format, or fails to parse) —
// callers must treat that as "nothing to merge", not an error.
// A file that exists but can't be read (damaged, not a zip, over the size limits) is not replaced
// unless "overwrite": true — it may be a protected or valuable file the reader refused.
function unreadable(path, reason, overwrite) {
    if (overwrite) {
        console.error(`Warning: "${path}" could not be read (${reason}); replacing it because "overwrite" is true.`);
        return null;
    }
    throw new Error(`"${path}" exists but could not be read as an XMind file (${reason}). Nothing was written. ` +
        'Pass "overwrite": true to replace it anyway, or choose another "path".');
}

async function loadExistingXMind(path, password = null, { overwrite = false } = {}) {
    if (!existsSync(path)) return null;
    let zip;
    try {
        zip = openZip(await readFile(path), password);
    } catch (err) {
        return unreadable(path, err.message, overwrite);
    }
    try {
        const names = zip.names();
        const legacy = !names.includes('content.json');
        if (legacy && !names.includes('content.xml')) return unreadable(path, 'a ZIP file without a mind map in it', overwrite);
        if (legacy && !/<xmap-content[\s>]/.test(zip.extract('content.xml').toString('utf-8', 0, 4096))) {
            return unreadable(path, 'its content.xml is not an XMind 8 map', overwrite);
        }
        if (legacy) {
            // XMind 8 file: no theme/styles to merge, but its embedded images and attachments can be
            // referenced again (read → create keeps "xap:" sources).
            const resourceEntries = names.filter(n => /^(resources|attachments)\//.test(n) && !n.endsWith('/'))
                .map(name => ({ name, data: zip.extract(name) }));
            return { sheetsByTitle: new Map(), metadataRaw: null, resourceEntries, encrypted: false, legacy: true };
        }

        const parsedContent = JSON.parse(zip.extract('content.json').toString('utf-8'));
        // Accept both array format and {sheets:[...]} object wrapper (read_xmind.mjs does the same).
        const contentJson = Array.isArray(parsedContent) ? parsedContent
            : Array.isArray(parsedContent?.sheets) ? parsedContent.sheets : [];
        const metadataRaw = names.includes('metadata.json')
            ? zip.extract('metadata.json').toString('utf-8')
            : null;

        // Sheets are matched by title; keep a queue per title so a workbook with duplicate
        // sheet titles doesn't collapse them onto a single reused id.
        const sheetsByTitle = new Map();
        for (const sheet of contentJson) {
            if (!sheet.title) continue;
            if (!sheetsByTitle.has(sheet.title)) sheetsByTitle.set(sheet.title, []);
            sheetsByTitle.get(sheet.title).push(sheet);
        }

        const resourceEntries = [];
        for (const name of names) {
            if (['content.json', 'metadata.json', 'manifest.json', 'content.xml', 'meta.xml', 'styles.xml',
                'META-INF/manifest.xml'].includes(name)) continue;
            if (name.endsWith('/')) continue; // directory marker entry, nothing to carry forward
            resourceEntries.push({ name, data: zip.extract(name) });
        }

        return { sheetsByTitle, metadataRaw, resourceEntries, encrypted: zip.encrypted, passwordHint: zip.passwordHint };
    } catch (err) {
        // Never overwrite a protected file we couldn't open: that would silently drop its password
        // (and its styling). The caller stops with this error and leaves the file untouched.
        if (err.code === PASSWORD_REQUIRED || err.code === WRONG_PASSWORD) {
            throw new Error(`${path} is password-protected and ${err.code === WRONG_PASSWORD ? 'the password is wrong' : 'no "password" was given'}` +
                `${quoteHint(zip.passwordHint)}. Nothing was written. Pass its "password" to update it ` +
                '(it stays protected); to save it without protection on purpose, also pass "removePassword": true.');
        }
        return unreadable(path, err.message, overwrite);
    }
}

// ─── Styling: palette, topic / relationship style, themes, images ───
//
// The JSON input describes style with friendly keys; they are translated into XMind's own
// style property names here. A raw `style` object (XMind property names, e.g. "svg:fill")
// is merged last, so anything not covered by the friendly keys is still reachable.

// Named colours: fill + darker border of the same hue + a text colour that reads on that fill.
// Every entry sets `text` explicitly: otherwise a text colour left over from an earlier colour
// (e.g. white text from `navy`, carried over by style preservation) would survive a switch
// to a light colour and become unreadable.
const DARK_TEXT = '#1E1E1E';
const PALETTE = {
    blue:   { fill: '#A5D8FF', border: '#1971C2', text: DARK_TEXT },
    green:  { fill: '#B2F2BB', border: '#2F9E44', text: DARK_TEXT },
    yellow: { fill: '#FFEC99', border: '#F08C00', text: DARK_TEXT },
    orange: { fill: '#FFD8A8', border: '#E8590C', text: DARK_TEXT },
    red:    { fill: '#FFC9C9', border: '#E03131', text: DARK_TEXT },
    purple: { fill: '#D0BFFF', border: '#6741D9', text: DARK_TEXT },
    teal:   { fill: '#96F2D7', border: '#0C8599', text: DARK_TEXT },
    pink:   { fill: '#FCC2D7', border: '#C2255C', text: DARK_TEXT },
    gray:   { fill: '#E9ECEF', border: '#868E96', text: DARK_TEXT },
    navy:   { fill: '#1E3A5F', border: '#1E3A5F', text: '#FFFFFF' },
    white:  { fill: '#FFFFFF', border: '#868E96', text: DARK_TEXT },
};

function toPt(v) {
    if (v === undefined || v === null) return undefined;
    return typeof v === 'number' ? `${v}pt` : String(v);
}

function resolveColor(name, where) {
    const c = PALETTE[name];
    if (!c) throw new Error(`Unknown color "${name}" in ${where}. Use one of: ${Object.keys(PALETTE).join(', ')} — or "fill": "#RRGGBB".`);
    return c;
}

// Explicit colours must be hex (XMind ignores CSS names such as "red"); "none" means no colour.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function hexColor(value, field, where) {
    if (typeof value === 'string' && (value === 'none' || HEX_COLOR.test(value))) return value;
    const hint = PALETTE[value] ? ` For a named colour use "color": "${value}".` : '';
    throw new Error(`${where}: "${field}" must be a hex colour like "#1971C2" (got ${JSON.stringify(value)}).${hint}`);
}

// Relationship `color` accepts a palette name (its border shade) or a hex colour.
function lineColor(value, where) {
    if (PALETTE[value]) return PALETTE[value].border;
    if (typeof value === 'string' && HEX_COLOR.test(value)) return value;
    throw new Error(`${where}: unknown color ${JSON.stringify(value)}. Use a hex colour like "#E03131" ` +
        `or one of: ${Object.keys(PALETTE).join(', ')}.`);
}

function dropNulls(p) {
    for (const k of Object.keys(p)) if (p[k] === null || p[k] === undefined) delete p[k];
    return p;
}

// Properties each friendly key controls. Setting the key to `null` removes them, which is how a
// property carried over from the file being overwritten (see style preservation) is cleared.
const TOPIC_STYLE_PROPS = {
    shape: ['shape-class'],
    color: ['svg:fill', 'border-line-color', 'fo:color'],
    fill: ['svg:fill'],
    borderColor: ['border-line-color'],
    borderWidth: ['border-line-width'],
    textColor: ['fo:color'],
    fontSize: ['fo:font-size'],
    bold: ['fo:font-weight'],
    italic: ['fo:font-style'],
    fontFamily: ['fo:font-family'],
    lineColor: ['line-color'],
    lineWidth: ['line-width'],
    branchLine: ['line-class'],
    linePattern: ['line-pattern'],
    fillOpacity: ['svg:opacity'],
    fillPattern: ['fill-pattern'],
    borderPattern: ['border-line-pattern'],
    highlight: ['fo:background-color'],
    underline: ['fo:text-decoration'],
    strike: ['fo:text-decoration'],
    textTransform: ['fo:text-transform'],
    textAlign: ['fo:text-align'],
    cjkFontFamily: ['cjk-font-family'],
    handDrawn: ['fill-pattern', 'border-line-pattern', 'line-pattern'],
};


function oneOf(value, allowed, field, where) {
    if (!allowed.has(value)) throw new Error(`${where}: unknown ${field} "${value}". Use: ${[...allowed].join(', ')}`);
    return value;
}

function textDecoration(input) {
    const parts = [];
    if (input.underline) parts.push('underline');
    if (input.strike) parts.push('line-through');
    return parts.length > 0 ? parts.join(' ') : 'none';
}

// Returns the properties the input sets, with `null` for properties it explicitly clears
// (callers that don't merge with an older style drop those with dropNulls), or null if the
// input says nothing about style.
function topicStyleProps(input, where = `topic "${input.title}"`) {
    const p = {};
    for (const [key, props] of Object.entries(TOPIC_STYLE_PROPS)) {
        if (input[key] === null) for (const prop of props) p[prop] = null;
    }
    if (input.shape != null) p['shape-class'] = xmindClass(input.shape, 'org.xmind.topicShape.', K.KNOWN.topicShape, 'shape', where);
    if (input.color != null) {
        const c = resolveColor(input.color, where);
        p['svg:fill'] = c.fill;
        p['border-line-color'] = c.border;
        p['fo:color'] = c.text;
    }
    if (input.fill != null) p['svg:fill'] = hexColor(input.fill, 'fill', where);
    if (input.borderColor != null) p['border-line-color'] = hexColor(input.borderColor, 'borderColor', where);
    if (input.borderWidth != null) p['border-line-width'] = toPt(input.borderWidth);
    if (input.textColor != null) p['fo:color'] = hexColor(input.textColor, 'textColor', where);
    if (input.fontSize != null) p['fo:font-size'] = toPt(input.fontSize);
    if (input.bold != null) p['fo:font-weight'] = input.bold ? 'bold' : 'normal';
    if (input.italic != null) p['fo:font-style'] = input.italic ? 'italic' : 'normal';
    if (input.fontFamily != null) p['fo:font-family'] = input.fontFamily;
    if (input.lineColor != null) p['line-color'] = hexColor(input.lineColor, 'lineColor', where);
    if (input.lineWidth != null) p['line-width'] = toPt(input.lineWidth);
    if (input.branchLine != null) {
        const cls = BRANCH_LINES[input.branchLine] || input.branchLine;
        if (!cls.startsWith('org.xmind.')) {
            throw new Error(`${where}: unknown branchLine "${input.branchLine}". Use: ${Object.keys(BRANCH_LINES).join(', ')}`);
        }
        p['line-class'] = cls;
    }
    if (input.handDrawn != null) {
        p['fill-pattern'] = input.handDrawn ? 'solid-hand-drawn' : 'solid';
        p['border-line-pattern'] = input.handDrawn ? 'handdrawn-solid' : 'solid';
        p['line-pattern'] = input.handDrawn ? 'handdrawn-solid' : 'solid';
    }
    if (input.linePattern != null) p['line-pattern'] = oneOf(input.linePattern, STROKE_PATTERNS, 'linePattern', where);
    if (input.borderPattern != null) p['border-line-pattern'] = oneOf(input.borderPattern, STROKE_PATTERNS, 'borderPattern', where);
    if (input.fillPattern != null) {
        if (!FILL_PATTERNS[input.fillPattern]) throw new Error(`${where}: unknown fillPattern "${input.fillPattern}". Use: solid, none, handDrawn`);
        p['fill-pattern'] = FILL_PATTERNS[input.fillPattern];
    }
    if (input.fillOpacity != null) {
        if (!(typeof input.fillOpacity === 'number' && input.fillOpacity >= 0 && input.fillOpacity <= 1)) {
            throw new Error(`${where}: fillOpacity must be a number between 0 and 1.`);
        }
        p['svg:opacity'] = String(input.fillOpacity);
    }
    if (input.highlight != null) p['fo:background-color'] = hexColor(input.highlight, 'highlight', where);
    if (input.underline != null || input.strike != null) p['fo:text-decoration'] = textDecoration(input);
    if (input.textTransform != null) p['fo:text-transform'] = oneOf(input.textTransform, TEXT_TRANSFORMS, 'textTransform', where);
    if (input.textAlign != null) p['fo:text-align'] = oneOf(input.textAlign, TEXT_ALIGNS, 'textAlign', where);
    if (input.cjkFontFamily != null) p['cjk-font-family'] = input.cjkFontFamily;
    if (input.style && typeof input.style === 'object') Object.assign(p, input.style);
    return Object.keys(p).length > 0 ? p : null;
}

function relationshipStyleProps(rel, where = 'relationship') {
    const p = {};
    if (rel.shape) p['shape-class'] = xmindClass(rel.shape, 'org.xmind.relationshipShape.', K.KNOWN.relationship, 'relationship shape', where);
    if (rel.color != null) p['line-color'] = lineColor(rel.color, where);
    if (rel.width != null) p['line-width'] = toPt(rel.width);
    if (rel.pattern) {
        if (!LINE_PATTERNS.has(rel.pattern)) throw new Error(`Unknown relationship pattern "${rel.pattern}". Use: ${[...LINE_PATTERNS].join(', ')}`);
        p['line-pattern'] = rel.pattern;
    }
    for (const [key, prop] of [['arrowBegin', 'arrow-begin-class'], ['arrowEnd', 'arrow-end-class']]) {
        if (rel[key] == null) continue;
        const arrow = ARROW_ALIASES[rel[key]] || rel[key];
        if (!ARROWS.has(arrow)) throw new Error(`Unknown arrow "${rel[key]}". Use: ${[...ARROWS].join(', ')}`);
        p[prop] = `org.xmind.arrowShape.${arrow}`;
    }
    if (rel.textColor != null) p['fo:color'] = hexColor(rel.textColor, 'textColor', where);
    if (rel.fontSize != null) p['fo:font-size'] = toPt(rel.fontSize);
    if (rel.style && typeof rel.style === 'object') Object.assign(p, rel.style);
    dropNulls(p);
    return Object.keys(p).length > 0 ? p : null;
}


function numberingContent(spec, where) {
    const o = typeof spec === 'string' ? { pattern: spec } : (spec === true ? { pattern: 'arabic' } : spec);
    if (!o || typeof o !== 'object' || !NUMBERING[o.pattern]) {
        throw new Error(`${where}: numberChildren must be one of ${Object.keys(NUMBERING).join(', ')} (or {pattern, tiered}).`);
    }
    // tiered: prefix with the parent's number ("2.1", "2.2" …).
    return { pattern: NUMBERING[o.pattern], tiered: !!o.tiered };
}


// Style of a boundary or summary bracket: {shape?, fill?, lineColor?, lineWidth?, pattern?, style?}.
// `style` may be raw properties or XMind's {properties} object (as read_xmind.mjs returns it).
function outlineStyleProps(spec, kind, where) {
    const p = {};
    if (spec.shape != null) {
        const known = kind === 'boundary' ? BOUNDARY_SHAPES : SUMMARY_SHAPES;
        const prefix = kind === 'boundary' ? 'org.xmind.boundaryShape.' : 'org.xmind.summaryShape.';
        const name = String(spec.shape).replace(prefix, '');
        if (!known.has(name)) throw new Error(`${where}: unknown ${kind} shape "${spec.shape}". Use: ${[...known].join(', ')}`);
        p['shape-class'] = prefix + name;
    }
    if (spec.fill != null) p['svg:fill'] = hexColor(spec.fill, 'fill', where);
    if (spec.lineColor != null) p['line-color'] = hexColor(spec.lineColor, 'lineColor', where);
    if (spec.lineWidth != null) p['line-width'] = toPt(spec.lineWidth);
    if (spec.pattern != null) {
        if (!LINE_PATTERNS.has(spec.pattern)) throw new Error(`${where}: unknown pattern "${spec.pattern}". Use: ${[...LINE_PATTERNS].join(', ')}`);
        p['line-pattern'] = spec.pattern;
    }
    if (spec.style && typeof spec.style === 'object') Object.assign(p, spec.style.properties || spec.style);
    dropNulls(p);
    return Object.keys(p).length > 0 ? p : null;
}

// Theme presets. Each key is an XMind theme slot; values use the friendly topic-style keys
// (plus `background`, `multiLineColors` for the map slot).
const THEME_PRESETS = {
    // Calm, high-contrast: navy central topic, grey connectors, white canvas. Colour comes
    // from per-topic `color` values rather than from rainbow branches.
    clean: {
        map: { background: '#FBFBFD', multiLineColors: 'none' },
        centralTopic: { fill: '#1E3A5F', textColor: '#FFFFFF', bold: true, fontSize: 28, borderWidth: 0,
            lineColor: '#495057', lineWidth: 3, branchLine: 'curve' },
        mainTopic: { fill: '#E9ECEF', borderColor: '#868E96', borderWidth: 2, textColor: '#1E1E1E', bold: true,
            fontSize: 18, lineColor: '#868E96', lineWidth: 2, branchLine: 'roundedElbow' },
        subTopic: { fill: '#FFFFFF', borderColor: '#ADB5BD', borderWidth: 1, textColor: '#1E1E1E', fontSize: 14,
            lineColor: '#ADB5BD', lineWidth: 1.5, branchLine: 'roundedElbow' },
        floatingTopic: { fill: '#E9ECEF', borderColor: '#868E96', fontSize: 14 },
        calloutTopic: { fill: '#FFF9DB', borderColor: '#F08C00', fontSize: 13 },
        summaryTopic: { fill: '#FFFFFF', borderColor: '#868E96', fontSize: 14 },
        relationship: { lineColor: '#E03131', lineWidth: 2, pattern: 'dash', arrowEnd: 'triangle',
            textColor: '#C92A2A', fontSize: 13 },
        boundary: { fill: '#F1F3F5', lineColor: '#ADB5BD' },
        summary: { lineColor: '#868E96' },
    },
    // White canvas, one colour per main branch (XMind's "multi-branch colour"), tapered lines.
    colorful: {
        map: { background: '#FFFFFF', lineTapered: true,
            multiLineColors: ['#FF6B6B', '#FF9F43', '#FECA57', '#1DD1A1', '#48DBFB', '#5F27CD', '#FF9FF3'] },
        centralTopic: { fill: '#2D3436', textColor: '#FFFFFF', bold: true, fontSize: 28, borderWidth: 0,
            lineWidth: 4, branchLine: 'curve' },
        mainTopic: { fillPattern: 'none', borderWidth: 0, textColor: '#2D3436', bold: true, fontSize: 18,
            lineWidth: 3, branchLine: 'curve', shape: 'org.xmind.topicShape.underline' },
        subTopic: { fillPattern: 'none', borderWidth: 0, textColor: '#2D3436', fontSize: 14, lineWidth: 2,
            branchLine: 'curve', shape: 'org.xmind.topicShape.underline' },
        relationship: { lineColor: '#636E72', lineWidth: 2, pattern: 'dash', arrowEnd: 'triangle', fontSize: 13 },
        boundary: { fill: '#F5F6FA', lineColor: '#B2BEC3' },
        summary: { lineColor: '#636E72' },
    },
    // Sketch look: hand-drawn fills and lines with a handwriting font.
    handDrawn: {
        map: { background: '#FFFDF7', multiLineColors: 'none' },
        centralTopic: { fill: '#FFE8A3', borderColor: '#3D3D3D', borderWidth: 2, textColor: '#2B2B2B', bold: true,
            fontSize: 26, fontFamily: 'NeverMind Hand', handDrawn: true, lineColor: '#3D3D3D', lineWidth: 2 },
        mainTopic: { fill: '#FFFFFF', borderColor: '#3D3D3D', borderWidth: 2, textColor: '#2B2B2B', fontSize: 17,
            fontFamily: 'NeverMind Hand', handDrawn: true, lineColor: '#3D3D3D', lineWidth: 2, branchLine: 'curve' },
        subTopic: { fill: '#FFFFFF', borderColor: '#5C5C5C', borderWidth: 1.5, textColor: '#2B2B2B', fontSize: 14,
            fontFamily: 'NeverMind Hand', handDrawn: true, lineColor: '#5C5C5C', lineWidth: 1.5, branchLine: 'curve' },
        relationship: { lineColor: '#C0392B', lineWidth: 2, pattern: 'handdrawn-dash', arrowEnd: 'triangle',
            textColor: '#C0392B', fontSize: 13 },
        boundary: { fill: '#FFF6D8', lineColor: '#3D3D3D', pattern: 'handdrawn-dash' },
        summary: { lineColor: '#3D3D3D', pattern: 'handdrawn-solid' },
    },
    // Dark canvas, light text.
    dark: {
        map: { background: '#1B1F24', multiLineColors: 'none' },
        centralTopic: { fill: '#4DABF7', textColor: '#0B1A2A', bold: true, fontSize: 28, borderWidth: 0,
            lineColor: '#ADB5BD', lineWidth: 3, branchLine: 'curve' },
        mainTopic: { fill: '#2B3036', borderColor: '#4DABF7', borderWidth: 2, textColor: '#F1F3F5', bold: true,
            fontSize: 18, lineColor: '#868E96', lineWidth: 2, branchLine: 'roundedElbow' },
        subTopic: { fill: '#22262B', borderColor: '#495057', borderWidth: 1, textColor: '#E9ECEF', fontSize: 14,
            lineColor: '#495057', lineWidth: 1.5, branchLine: 'roundedElbow' },
        floatingTopic: { fill: '#2B3036', textColor: '#F1F3F5' },
        calloutTopic: { fill: '#3B2F00', textColor: '#FFE066' },
        summaryTopic: { fill: '#2B3036', textColor: '#F1F3F5' },
        relationship: { lineColor: '#FF8787', lineWidth: 2, pattern: 'dash', arrowEnd: 'triangle',
            textColor: '#FFA8A8', fontSize: 13 },
        boundary: { fill: '#22262B', lineColor: '#495057' },
        summary: { lineColor: '#868E96' },
    },
};

const THEME_SLOTS = ['map', 'centralTopic', 'mainTopic', 'subTopic', 'floatingTopic', 'calloutTopic',
    'summaryTopic', 'importantTopic', 'minorTopic', 'relationship', 'boundary', 'summary'];

function themeSlotProps(slot, spec) {
    if (!spec || typeof spec !== 'object') return {};
    const where = `theme slot "${slot}"`;
    if (slot === 'map') {
        const p = {};
        if (spec.background != null) p['svg:fill'] = hexColor(spec.background, 'background', where);
        if (spec.multiLineColors != null) {
            // Rainbow branches: a list of colours, one per main branch (or "none").
            const v = Array.isArray(spec.multiLineColors)
                ? spec.multiLineColors.map(c => PALETTE[c]?.border || hexColor(c, 'multiLineColors', where)).join(' ')
                : spec.multiLineColors;
            p['multi-line-colors'] = v;
            p['color-list'] = v;
        }
        if (spec.lineTapered != null) {
            p['line-tapered'] = spec.lineTapered === true ? 'tapered' : spec.lineTapered === false ? 'none' : spec.lineTapered;
        }
        if (spec.style) Object.assign(p, spec.style);
        return dropNulls(p);
    }
    if (slot === 'relationship') {
        // Relationship slot accepts either relationship keys or topic-like keys for line/text.
        return relationshipStyleProps({
            ...spec,
            color: spec.color ?? spec.lineColor,
            width: spec.width ?? spec.lineWidth,
        }, where) || {};
    }
    if (slot === 'boundary' || slot === 'summary') {
        const p = {};
        if (spec.fill != null) p['svg:fill'] = hexColor(spec.fill, 'fill', where);
        if (spec.lineColor != null) p['line-color'] = hexColor(spec.lineColor, 'lineColor', where);
        if (spec.lineWidth != null) p['line-width'] = toPt(spec.lineWidth);
        if (spec.pattern != null) p['line-pattern'] = oneOf(spec.pattern, LINE_PATTERNS, 'pattern', where);
        if (spec.style) Object.assign(p, spec.style);
        return dropNulls(p);
    }
    return dropNulls(topicStyleProps({ title: slot, ...spec }, where) || {});
}

// Theme (and skeleton structures) of a sheet in another .xmind file — e.g. one made in XMind with one
// of its built-in themes — so that look can be reused without copying it by hand.
function themeFromFile(path, sheetNumber = 1) {
    const where = `theme.from "${path}"`;
    if (!existsSync(resolve(path))) throw new Error(`${where}: file not found.`);
    const zip = openZip(readFileSync(resolve(path)));
    const raw = zip.extract('content.json');
    if (!raw) throw new Error(`${where}: only modern (zen) .xmind files carry a theme.`);
    const parsed = JSON.parse(raw.toString('utf-8').replace(/^\uFEFF/, ''));
    const sheets = Array.isArray(parsed) ? parsed : parsed.sheets || [];
    const sheet = sheets[sheetNumber - 1];
    if (!sheet?.theme) throw new Error(`${where}: sheet ${sheetNumber} has no theme.`);
    const skeleton = (sheet.extensions || []).find(e => e.provider === 'org.xmind.ui.skeleton.structure.style');
    return { theme: JSON.parse(JSON.stringify(sheet.theme)), skeleton };
}

// `theme` may be a preset name, a slot object, {preset, ...slot overrides} or {from: "file.xmind", sheet?, ...overrides}.
function buildTheme(themeInput) {
    let spec = themeInput;
    if (typeof spec === 'string') spec = { preset: spec };
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error(`Sheet "theme" must be a preset name (${Object.keys(THEME_PRESETS).join(', ')}) or an object.`);
    }
    if (spec.from) {
        const { theme } = themeFromFile(spec.from, spec.sheet || 1);
        for (const slot of THEME_SLOTS) {
            if (!spec[slot]) continue;
            const props = themeSlotProps(slot, spec[slot]);
            theme[slot] = { id: theme[slot]?.id || generateId(), properties: { ...(theme[slot]?.properties || {}), ...props } };
        }
        return theme;
    }
    const base = spec.preset ? THEME_PRESETS[spec.preset] : {};
    if (spec.preset && !base) throw new Error(`Unknown theme preset "${spec.preset}". Use: ${Object.keys(THEME_PRESETS).join(', ')}`);
    const theme = { id: generateId(), title: spec.title || spec.preset || 'custom' };
    for (const slot of THEME_SLOTS) {
        const merged = { ...(base[slot] || {}), ...(spec[slot] || {}) };
        if (Object.keys(merged).length === 0) continue;
        theme[slot] = { id: generateId(), properties: themeSlotProps(slot, merged) };
    }
    return theme;
}

// Natural size of PNG / JPEG / GIF / SVG without decoding the image.
function imageSize(buf, ext) {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504E47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
        let pos = 2;
        while (pos + 9 < buf.length) {
            if (buf[pos] !== 0xFF) { pos++; continue; }
            const marker = buf[pos + 1];
            const len = buf.readUInt16BE(pos + 2);
            // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
            if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
                return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
            }
            pos += 2 + len;
        }
    }
    if (ext === '.svg') return svgSize(buf.toString('utf-8', 0, Math.min(buf.length, 8192)));
    return null;
}

// SVG width/height count only when they are absolute (unitless or px). Relative sizes such as
// "100%" or "10em" say nothing about the drawing's proportions, so the viewBox is used instead.
function svgSize(head) {
    const tag = head.match(/<svg\b[^>]*>/i)?.[0];
    if (!tag) return null;
    const attr = name => {
        const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, 'i'));
        const v = m ? parseFloat(m[1]) : NaN;
        return v > 0 ? v : null;
    };
    const w = attr('width'), h = attr('height');
    const vb = tag.match(/\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i);
    const vw = vb ? parseFloat(vb[1]) : NaN, vh = vb ? parseFloat(vb[2]) : NaN;
    const hasVb = vw > 0 && vh > 0;
    if (w && h) return { width: w, height: h };
    if (w && hasVb) return { width: w, height: w * vh / vw };
    if (h && hasVb) return { width: h * vw / vh, height: h };
    if (hasVb) return { width: vw, height: vh };
    return null;
}


// Image keys XMind reads from content.json besides src / width / height.
function imageExtras(opts, where) {
    const x = {};
    if (opts.align != null) x.align = oneOf(opts.align, IMAGE_ALIGNS, 'image align', where);
    if (opts.opacity != null) {
        if (!(typeof opts.opacity === 'number' && opts.opacity >= 0 && opts.opacity <= 1)) {
            throw new Error(`${where}: image opacity must be between 0 and 1.`);
        }
        x.opacity = opts.opacity;
    }
    if (opts.borderColor != null) x.borderColor = hexColor(opts.borderColor, 'image borderColor', where);
    if (opts.borderWidth != null) x.borderWidth = Number(opts.borderWidth);
    if (opts.shadow != null) x.shadowVisible = !!opts.shadow;
    if (opts.shadowVisible != null) x.shadowVisible = !!opts.shadowVisible;
    if (opts.lockRatio != null) x.lockRatio = !!opts.lockRatio;
    return x;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg']);
const DEFAULT_IMAGE_WIDTH = 300;

// ─── Matching topics with the file being overwritten ───
//
// When a file is regenerated, each new topic is paired with "the same" topic in the old file so
// its styling (often edited by hand in XMind) can be carried forward. Pairing, in order:
//   1. `id` — read_xmind.mjs returns topic ids, so a read → edit → create round trip pairs exactly;
//   2. path key — chain of titles from the sheet root (the root itself always pairs with the old
//      root, whatever its title), with the sibling occurrence index for duplicate titles;
//   3. title — when the title occurs exactly once in the old sheet and once in the new one, so a
//      topic that was moved or whose parent was renamed keeps its style.
const ROOT_KEY = '\u0001root';
const DETACHED_KEY = '\u0001detached';

function childKey(parentKey, title, seen) {
    const n = seen.get(title) || 0;
    seen.set(title, n + 1);
    return `${parentKey}\u0000${title}#${n}`;
}

function indexExistingTopics(rootTopic) {
    const index = { byKey: new Map(), byId: new Map(), byTitle: new Map(), newTitleCount: new Map() };
    const walk = (t, key) => {
        index.byKey.set(key, t);
        if (t.id) index.byId.set(t.id, t);
        if (typeof t.title === 'string') {
            if (!index.byTitle.has(t.title)) index.byTitle.set(t.title, []);
            index.byTitle.get(t.title).push(t);
        }
        const seen = new Map();
        for (const c of t.children?.attached || []) walk(c, childKey(key, c.title, seen));
    };
    if (rootTopic) {
        walk(rootTopic, ROOT_KEY);
        const seen = new Map();
        for (const d of rootTopic.children?.detached || []) walk(d, childKey(DETACHED_KEY, d.title, seen));
    }
    return index;
}

// Numbers are accepted as titles (e.g. a year) and stored as strings; anything else is an error.
function normalizeTitles(topic, where) {
    if (!topic || typeof topic !== 'object') throw new Error(`${where}: expected a topic object.`);
    if (typeof topic.title === 'number') topic.title = String(topic.title);
    // Rich-text title: the plain title is the runs' text joined.
    if (topic.title === undefined && Array.isArray(topic.titleRuns)) {
        topic.title = topic.titleRuns.map(r => (typeof r === 'string' ? r : r?.text ?? '')).join('');
    }
    if (topic.title === undefined && (topic.equation != null || topic.image)) topic.title = '';
    // Matrix: rows × columns → rows as children, cells as grandchildren labelled with their column
    // (that is how XMind's own matrix structure stores them).
    if (topic.matrix) expandMatrix(topic, where);
    if (typeof topic.title !== 'string') {
        throw new Error(`${where}: every topic needs a "title" string (got ${JSON.stringify(topic.title)}).`);
    }
    (topic.children || []).forEach((c, i) => normalizeTitles(c, `${where} → child ${i + 1} of "${topic.title}"`));
}

function expandMatrix(topic, where) {
    const m = topic.matrix;
    if (!Array.isArray(m.columns) || m.columns.length === 0 || !Array.isArray(m.rows)) {
        throw new Error(`${where}: matrix needs {columns: [..], rows: [{title, cells: {column: ..}}]}.`);
    }
    const columns = m.columns.map(String);
    topic.structureClass = topic.structureClass || 'org.xmind.ui.spreadsheet';
    topic._matrixColumns = columns;
    topic.children = m.rows.map((row, r) => {
        const cells = row.cells || {};
        for (const col of Object.keys(cells)) {
            if (!columns.includes(col)) throw new Error(`${where}: matrix row ${r + 1} has cells for unknown column "${col}".`);
        }
        const children = [];
        for (const col of columns) {
            const v = cells[col];
            for (const cell of v == null ? [] : Array.isArray(v) ? v : [v]) {
                const t = typeof cell === 'object' ? { ...cell } : { title: String(cell) };
                t.labels = [col, ...(t.labels || []).filter(l => l !== col)];
                children.push(t);
            }
        }
        const { cells: _c, ...rest } = row;
        return { ...rest, title: row.title ?? '', children: [...children, ...(row.children || [])] };
    });
    delete topic.matrix;
}

// titleRuns → XMind's attributedTitle (one object per run, style under XMind's property names).
function attributedTitle(runs, where) {
    return runs.map((r, i) => {
        const run = typeof r === 'string' ? { text: r } : r;
        if (typeof run?.text !== 'string') throw new Error(`${where}: titleRuns[${i}] needs a "text" string.`);
        const out = { text: run.text };
        if (run.bold != null) out['fo:font-weight'] = run.bold ? 'bold' : 'normal';
        if (run.italic != null) out['fo:font-style'] = run.italic ? 'italic' : 'normal';
        if (run.color != null) out['fo:color'] = PALETTE[run.color]?.border || hexColor(run.color, 'titleRuns color', where);
        if (run.highlight != null) out['fo:background-color'] = PALETTE[run.highlight]?.fill || hexColor(run.highlight, 'titleRuns highlight', where);
        if (run.underline != null || run.strike != null) out['fo:text-decoration'] = textDecoration(run);
        if (run.fontSize != null) out['fo:font-size'] = toPt(run.fontSize);
        if (run.fontFamily != null) out['fo:font-family'] = run.fontFamily;
        if (run.textTransform != null) out['fo:text-transform'] = oneOf(run.textTransform, TEXT_TRANSFORMS, 'textTransform', where);
        return out;
    });
}

function countTitles(topics, counts = new Map()) {
    for (const t of topics) {
        counts.set(t.title, (counts.get(t.title) || 0) + 1);
        countTitles(t.children || [], counts);
    }
    return counts;
}

// Features XMind 8 files can't hold. Styles, themes (folded into topic styles), images and
// thumbnails are written to legacy files; these are not.
function zenOnlyFeatures(input) {
    const found = new Set();
    if (input.password) found.add('password protection');
    const topic = t => {
        if (!t || typeof t !== 'object') return;
        if (t.equation) found.add('equations (kept as images)');
        if (t.video) found.add('web videos');
        if (t.audio) found.add('audio notes');
        if (t.linkPreview) found.add('link previews');
        if (t.titleRuns) found.add('rich-text titles');
        if (t.numberChildren) found.add('numbering');
        if (t.matrix) found.add('matrix columns');
        (t.children || []).forEach(topic);
    };
    for (const sh of input.sheets || []) {
        topic(sh.rootTopic);
        (sh.detachedTopics || []).forEach(topic);
        for (const [k, label] of [['legend', 'legend'], ['customMarkers', 'custom markers'],
            ['watermark', 'watermark'], ['backgroundTexture', 'background texture']]) if (sh[k]) found.add(label);
    }
    return [...found];
}

// ─── Rich content: equations, video, audio ───

// ── Web video / link preview ──
function videoEmbedUrl(url) {
    const u = String(url);
    const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    if (yt) return { embedUrl: `https://www.youtube.com/embed/${yt[1]}`, site: 'YouTube', id: yt[1] };
    const vm = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vm) return { embedUrl: `https://player.vimeo.com/video/${vm[1]}`, site: 'Vimeo', id: vm[1] };
    const bb = u.match(/bilibili\.com\/video\/(BV[\w]+)/);
    if (bb) return { embedUrl: `https://player.bilibili.com/player.html?bvid=${bb[1]}`, site: 'bilibili', id: bb[1] };
    return { embedUrl: u, site: (u.match(/^https?:\/\/([^/]+)/) || [])[1] || 'video', id: null };
}

function videoPlaceholderSvg(label) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">` +
        `<rect width="480" height="270" rx="12" fill="#1E1E1E"/><circle cx="240" cy="125" r="46" fill="#E03131"/>` +
        `<polygon points="226,102 226,148 266,125" fill="#FFFFFF"/>` +
        `<text x="240" y="225" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#E9ECEF" text-anchor="middle">${escapeSvg(label)}</text></svg>`;
}

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.webm', '.flac']);

// ─── XMind builder ───

class XMindBuilder {
    constructor() {
        this.titleToId = new Map();
        this.titleCount = new Map();
        this.refToId = new Map();
        this.inputIdToId = new Map(); // id carried by an input topic (from the reader) -> new id
        this.topicSheet = new Map(); // topic id -> index of the sheet it is on
        this.customMarkerIds = new Set(); // ids usable in topic markers on the sheet being built
        this.sheetIndex = 0;
        this.pendingDependencies = new Map();
        this.pendingLinks = new Map();
        this.attachments = []; // {sourcePath, resourcePath}
        this.images = new Map(); // resourcePath -> data
        this.existingIndex = null; // see indexExistingTopics(), for the sheet being built
        this.existingResourceNames = new Set(); // entries of the file being overwritten
        this.preserveStyles = true;
    }

    // The old topic this new one replaces (see "Matching topics" above), or null.
    matchPrevious(input, key) {
        const ex = this.existingIndex;
        if (!ex || !this.preserveStyles) return null;
        if (typeof input.id === 'string' && ex.byId.has(input.id)) return ex.byId.get(input.id);
        if (key && ex.byKey.has(key)) return ex.byKey.get(key);
        const same = ex.byTitle.get(input.title);
        if (same?.length === 1 && ex.newTitleCount.get(input.title) === 1) return same[0];
        return null;
    }

    // Resolve a topic reference: `ref` (unique key set on a topic) wins; a title must be
    // unique across the whole workbook, otherwise the reference is ambiguous.
    lookup(ref, title, what, inputId) {
        // `inputId`: a topic id as returned by read_xmind.mjs (relationship end1Id/end2Id,
        // dependency id) — resolved to the id the same topic gets in the new file.
        if (inputId !== undefined && ref === undefined && title === undefined) {
            const id = this.inputIdToId.get(inputId);
            if (!id) throw new Error(`${what} not found: no topic with id "${inputId}" in the input`);
            return id;
        }
        if (ref !== undefined) {
            const id = this.refToId.get(ref);
            if (!id) throw new Error(`${what} not found: ref "${ref}"`);
            return id;
        }
        if (typeof title === 'number') title = String(title);
        const id = this.titleToId.get(title);
        if (!id) throw new Error(`${what} not found: "${title}"`);
        const n = this.titleCount.get(title);
        if (n > 1) {
            throw new Error(`${what} is ambiguous: ${n} topics are titled "${title}". ` +
                'Give the intended topic a unique "ref" and reference it with sourceRef / targetRef / linkToRef.');
        }
        return id;
    }

    build(sheets, existingSheetsByTitle = null, { preserveStyles = true, existingResourceNames = [] } = {}) {
        this.titleToId.clear();
        this.titleCount.clear();
        this.refToId.clear();
        this.inputIdToId.clear();
        this.pendingDependencies.clear();
        this.pendingLinks.clear();
        this.attachments = [];
        this.images = new Map();
        this.preserveStyles = preserveStyles;
        this.existingResourceNames = new Set(existingResourceNames);

        if (!Array.isArray(sheets) || sheets.length === 0) {
            throw new Error('"sheets" must be a non-empty array of {title, rootTopic}.');
        }
        sheets.forEach((sheet, i) => {
            const where = `sheet ${i + 1}${typeof sheet?.title === 'string' ? ` ("${sheet.title}")` : ''}`;
            if (!sheet?.rootTopic) throw new Error(`${where}: missing "rootTopic".`);
            // read_xmind.mjs returns sheet-level data on the root topic; accept that shape too.
            const root = sheet.rootTopic;
            if (root.detachedTopics && !sheet.detachedTopics) sheet.detachedTopics = root.detachedTopics;
            if (root.relationships && !sheet.relationships) sheet.relationships = root.relationships;
            if (root.topicPositioning === 'free' && sheet.freePositioning === undefined) sheet.freePositioning = true;
            for (const k of ['legend', 'watermark', 'backgroundTexture', 'customMarkers']) {
                if (root[k] !== undefined && sheet[k] === undefined) sheet[k] = root[k];
                delete root[k];
            }
            delete root.detachedTopics;
            delete root.relationships;
            normalizeTitles(sheet.rootTopic, `${where} root topic`);
            (sheet.detachedTopics || []).forEach((t, j) => normalizeTitles(t, `${where} detached topic ${j + 1}`));
        });

        const builtSheets = [];
        for (const [sheetIndex, sheet] of sheets.entries()) {
            this.sheetIndex = sheetIndex;
            this.customMarkerIds = new Set([...(sheet.customMarkers || sheet.rootTopic?.customMarkers || []).map(m => String(m.id)),
                ...(existingSheetsByTitle?.get(sheet.title)?.[0]?.customMarkerGroups || []).flatMap(g => (g.markers || []).map(m => m.id))]);
            // Sheets with duplicate titles are matched in order (first existing sheet with this
            // title pairs with the first rebuilt sheet with this title, etc.) rather than all
            // reusing the same existing sheet.
            const existingSheet = existingSheetsByTitle?.get(sheet.title)?.shift();
            this.existingIndex = existingSheet ? indexExistingTopics(existingSheet.rootTopic) : null;
            if (this.existingIndex) {
                this.existingIndex.newTitleCount = countTitles([sheet.rootTopic, ...(sheet.detachedTopics || [])]);
            }
            const rootTopic = this.buildTopic(sheet.rootTopic, { key: ROOT_KEY });
            const seen = new Map();
            const detached = sheet.detachedTopics?.map(t => this.buildTopic(t, {
                detached: true, key: childKey(DETACHED_KEY, t.title, seen),
            }));
            this.existingIndex = null;
            builtSheets.push({ rootTopic, detached, sheet, existingSheet });
        }

        // References are resolved after every sheet is built so that duplicate titles anywhere
        // in the workbook are detected and cross-sheet links work in both directions.
        for (const { rootTopic, detached } of builtSheets) {
            this.resolveDependencies(rootTopic);
            this.resolveLinks(rootTopic);
            for (const t of detached || []) {
                this.resolveDependencies(t);
                this.resolveLinks(t);
            }
        }

        const contentJson = builtSheets.map(({ rootTopic, detached, sheet, existingSheet }, sheetIndex) => {
            // An explicit `theme` wins. Otherwise preserve the previous sheet's visual theme when
            // a sheet with the same title already existed — without this, every regeneration
            // resets styling to XMind's bare default.
            const sheetTheme = sheet.theme ? buildTheme(sheet.theme)
                : existingSheet?.theme ? existingSheet.theme : {};
            const hasPlanned = this.hasPlannedTasks(sheet.rootTopic);
            if (detached?.length > 0) {
                if (!rootTopic.children) rootTopic.children = {};
                rootTopic.children.detached = detached;
            }
            const sheetId = existingSheet?.id || generateId();
            const sheetObj = {
                id: sheetId,
                class: "sheet",
                title: sheet.title,
                rootTopic,
                topicOverlapping: existingSheet?.topicOverlapping || "overlap",
                theme: sheetTheme,
            };
            // Sheet-level style (e.g. a background colour set in XMind, which overrides the theme's
            // map background) and the marker legend don't reference topic ids — keep them.
            if (existingSheet?.style && !sheet.theme) sheetObj.style = existingSheet.style;
            if (existingSheet?.legend) sheetObj.legend = existingSheet.legend;
            if (existingSheet?.customMarkerGroups) sheetObj.customMarkerGroups = existingSheet.customMarkerGroups;
            // Layout behaviour toggles set in XMind (free positioning, compact layout).
            for (const k of ['topicPositioning', 'floatingTopicFlexible', 'compactLayoutModeLevel']) {
                if (existingSheet?.[k] !== undefined) sheetObj[k] = existingSheet[k];
            }
            // Note: `zones` and `arrangeableLayerOrder` are intentionally NOT carried forward —
            // both reference topic/zone ids, and buildTopic() always mints fresh ids, so copying
            // them verbatim would leave dangling references into a workbook that no longer has
            // those ids.
            if (sheet.freePositioning) {
                sheetObj.topicPositioning = "free";
                sheetObj.floatingTopicFlexible = true;
            }
            // Preserve non-task extensions from the old sheet (e.g. layout/structure style),
            // then layer the planned-task extension on top if this build introduces one —
            // otherwise regenerating a sheet with tasks would drop its prior layout extensions.
            const preservedExtensions = (existingSheet?.extensions || [])
                .filter(e => e.provider !== 'org.xmind.ui.working-day-settings');
            if (hasPlanned) {
                preservedExtensions.push({
                    provider: "org.xmind.ui.working-day-settings",
                    content: {
                        id: "YmFzaWMtY2FsZW5kYXI=",
                        name: "Basic calendar",
                        defaultWorkingDays: [1, 2, 3, 4, 5],
                        rules: [],
                    },
                });
            }
            this.sheetExtras(sheet, sheetObj, preservedExtensions);
            if (preservedExtensions.length > 0) sheetObj.extensions = preservedExtensions;
            if (sheet.relationships?.length > 0) {
                sheetObj.relationships = sheet.relationships.map((rel, i) => {
                    const end1Id = this.lookup(rel.sourceRef, rel.sourceTitle, 'Relationship source', rel.end1Id);
                    const end2Id = this.lookup(rel.targetRef, rel.targetTitle, 'Relationship target', rel.end2Id);
                    // XMind draws relationships only between topics on the same sheet.
                    for (const [end, label] of [[end1Id, 'source'], [end2Id, 'target']]) {
                        if (this.topicSheet.get(end) !== sheetIndex) {
                            throw new Error(`Sheet "${sheet.title}" relationship ${i + 1}${rel.title ? ` ("${rel.title}")` : ''}: ` +
                                `its ${label} is on another sheet — relationships must connect topics on the same sheet ` +
                                '(use "linkToTopic" / "linkToRef" to link across sheets).');
                        }
                    }
                    const r = { id: generateId(), end1Id, end2Id };
                    if (rel.title) r.title = rel.title;
                    const relProps = relationshipStyleProps(rel,
                        `sheet "${sheet.title}" relationship ${i + 1}${rel.title ? ` ("${rel.title}")` : ''}`);
                    if (relProps) r.style = { id: generateId(), properties: relProps };
                    if (rel.controlPoints) r.controlPoints = rel.controlPoints;
                    return r;
                });
            }
            return sheetObj;
        });

        return {
            contentJson,
            attachments: this.attachments,
        };
    }

    async finalize(contentJson, attachments, existingResourceEntries = [], existingMetadataRaw = null, thumbnailPath = null) {
        const fileEntries = { "content.json": {}, "metadata.json": {} };
        const resourceFilesByName = new Map();

        // Images shown inside topics (see embedImage) — content-addressed, so duplicates collapse.
        for (const [resourcePath, data] of this.images) {
            fileEntries[resourcePath] = {};
            resourceFilesByName.set(resourcePath, data);
        }

        // Explicit thumbnail (shown by Finder / XMind's recent-files list). Must be PNG.
        if (thumbnailPath) {
            const data = await readFile(noteLocalFile(thumbnailPath));
            if (data.length < 8 || data.readUInt32BE(0) !== 0x89504E47) {
                throw new Error(`thumbnail must be a PNG file: ${thumbnailPath}`);
            }
            fileEntries['Thumbnails/thumbnail.png'] = {};
            resourceFilesByName.set('Thumbnails/thumbnail.png', data);
        }

        for (const att of attachments) {
            const data = await readFile(noteLocalFile(att.sourcePath));
            const hash = createHash('sha256').update(data).digest('hex');
            const ext = extname(att.sourcePath);
            const resourcePath = `resources/${hash}${ext}`;
            fileEntries[resourcePath] = {};
            resourceFilesByName.set(resourcePath, data);
            // Set href on the topic
            this.setHrefById(contentJson, att.topicId, `xap:${resourcePath}`);
        }

        // Carry forward resources embedded in the previous file (e.g. Thumbnails/thumbnail.png)
        // that this build doesn't already regenerate — otherwise XMind falls back to a blank
        // thumbnail/theme-less render for files that previously had one. Skip any name already
        // written by a freshly-attached resource above so regenerated attachments always win.
        // Files under resources/ that nothing references any more (an image that was replaced or
        // removed, an attachment on a deleted topic) are dropped instead of piling up.
        const referenced = JSON.stringify(contentJson) + (existingMetadataRaw || '');
        const dropped = [];
        let staleThumbnail = false;
        for (const res of existingResourceEntries) {
            if (resourceFilesByName.has(res.name)) continue;
            if (res.name.startsWith('resources/') && !referenced.includes(res.name)) {
                dropped.push(res.name);
                continue;
            }
            if (res.name === 'Thumbnails/thumbnail.png') staleThumbnail = true;
            fileEntries[res.name] = {};
            resourceFilesByName.set(res.name, res.data);
        }
        if (dropped.length > 0) {
            console.error(`Note: dropped ${dropped.length} resource file(s) no longer referenced by any topic.`);
        }
        if (staleThumbnail) {
            console.error('Note: the existing thumbnail was carried over and may no longer match the map — ' +
                'refresh it with preview_xmind.py --thumbnail.');
        }

        const resourceFiles = [...resourceFilesByName].map(([name, data]) => ({ name, data }));

        return {
            content: JSON.stringify(contentJson),
            metadata: existingMetadataRaw || JSON.stringify({
                dataStructureVersion: "3",
                creator: { name: "xmind-skill", version: VERSION },
                layoutEngineVersion: "5",
            }),
            manifest: JSON.stringify({ "file-entries": fileEntries }),
            resourceFiles,
        };
    }

    setHrefById(sheets, topicId, href) {
        for (const sheet of sheets) {
            if (this._setHref(sheet.rootTopic, topicId, href)) return;
        }
    }

    _setHref(topic, topicId, href) {
        if (topic.id === topicId) { topic.href = href; return true; }
        for (const child of topic.children?.attached || []) if (this._setHref(child, topicId, href)) return true;
        for (const child of topic.children?.callout || []) if (this._setHref(child, topicId, href)) return true;
        for (const child of topic.children?.detached || []) if (this._setHref(child, topicId, href)) return true;
        return false;
    }

    resolveLinks(topic) {
        const target = this.pendingLinks.get(topic.id);
        if (target) {
            const targetId = this.lookup(target.ref, target.title, 'Link target');
            topic.href = `xmind:#${targetId}`;
        }
        for (const child of topic.children?.attached || []) this.resolveLinks(child);
        for (const child of topic.children?.callout || []) this.resolveLinks(child);
    }

    resolveDependencies(topic) {
        const deps = this.pendingDependencies.get(topic.id);
        if (deps && topic.extensions) {
            const taskExt = topic.extensions.find(e => e.provider === 'org.xmind.ui.task');
            if (taskExt) {
                taskExt.content.dependencies = deps.map(d => {
                    const targetId = this.lookup(d.targetRef, d.targetTitle, 'Dependency target', d.id);
                    return { id: targetId, type: d.type, lag: d.lag ?? 0 };
                });
            }
        }
        for (const child of topic.children?.attached || []) this.resolveDependencies(child);
    }

    // Content-addressed resource inside the .xmind (duplicates collapse). Returns "resources/<sha>.ext".
    storeResource(data, ext) {
        const hash = createHash('sha256').update(data).digest('hex');
        const resourcePath = `resources/${hash}${ext === '.jpeg' ? '.jpg' : ext}`;
        this.images.set(resourcePath, data);
        return resourcePath;
    }

    // image: "/abs/path.png" | {path} — a local PNG/JPG/GIF/SVG file
    //        {sticker: "rocket"} | {illustration: "Minimalist/Travel/…"} — from XMind's own library
    //        {src: "xap:resources/…"} — an image already embedded in the file being overwritten
    //        (the shape read_xmind.mjs returns, so read → create works).
    // Options: width / height (one keeps the aspect ratio), align (top | bottom | left | right —
    // where the image sits relative to the title), opacity (0–1), borderColor, borderWidth, shadow.
    embedImage(spec, title, previous = null) {
        const where = `Topic "${title}"`;
        const opts = typeof spec === 'string' ? { path: spec } : spec;
        if (!opts || typeof opts !== 'object') throw new Error(`${where}: image must be a path or {path, width?, height?}.`);
        for (const dim of ['width', 'height']) {
            if (opts[dim] != null && !(typeof opts[dim] === 'number' && opts[dim] > 0)) {
                throw new Error(`${where}: image ${dim} must be a positive number (got ${JSON.stringify(opts[dim])}).`);
            }
        }
        const extras = imageExtras(opts, where);

        if (!opts.path && !opts.sticker && !opts.illustration && opts.src) {
            const name = String(opts.src).replace(/^xap:/, '');
            if (!this.existingResourceNames.has(name) && !this.images.has(name)) {
                throw new Error(`${where}: image "${opts.src}" is not in the file being overwritten. ` +
                    'Saving a map you read to a new path? Add "sourcePath": "<the file you read>". ' +
                    'Otherwise drop this image — only embed a picture file the user asked for.');
            }
            // Same image as before: keep its size unless the input changes it.
            const base = previous?.image?.src === `xap:${name}` ? previous.image : {};
            let width = opts.width ?? base.width;
            let height = opts.height ?? base.height;
            if (opts.width != null && opts.height == null && base.width && base.height) {
                height = Math.round(opts.width * base.height / base.width);
            } else if (opts.height != null && opts.width == null && base.width && base.height) {
                width = Math.round(opts.height * base.width / base.height);
            }
            const image = { ...base, ...extras, src: `xap:${name}` };
            if (width != null) image.width = width;
            if (height != null) image.height = height;
            return image;
        }

        let data, ext;
        if (opts.sticker || opts.illustration) {
            const kind = opts.sticker ? 'sticker' : 'illustration';
            ({ data, ext } = libraryAsset(kind, opts.sticker || opts.illustration, where));
        } else if (opts.data) {
            ({ data, ext } = opts);
        } else {
            if (!opts.path) throw new Error(`${where}: image needs a "path" (or "sticker" / "illustration").`);
            ext = extname(opts.path).toLowerCase();
            if (!IMAGE_EXTS.has(ext)) throw new Error(`${where}: unsupported image type "${ext}" (use png, jpg, gif or svg).`);
            if (!existsSync(resolve(opts.path))) throw new Error(`${where}: image file not found: ${opts.path}`);
            data = readFileSync(noteLocalFile(opts.path));
        }
        let natural = imageSize(data, ext);
        if (!(natural?.width > 0 && natural?.height > 0)) {
            natural = { width: DEFAULT_IMAGE_WIDTH, height: DEFAULT_IMAGE_WIDTH };
        }
        const defaultWidth = opts.sticker ? 96 : DEFAULT_IMAGE_WIDTH;
        let { width, height } = opts;
        if (width && !height) height = Math.round(width * natural.height / natural.width);
        else if (height && !width) width = Math.round(height * natural.width / natural.height);
        else if (!width && !height) {
            width = Math.round(Math.min(natural.width, defaultWidth));
            height = Math.round(width * natural.height / natural.width);
        }
        return { src: `xap:${this.storeResource(data, ext)}`, width, height, ...extras };
    }

    // Sheet-level extras: theme skeleton from another file, legend, custom markers, watermark,
    // background texture. `exts` is the sheet's extension list (modified in place).
    sheetExtras(sheet, sheetObj, exts) {
        const where = `Sheet "${sheet.title}"`;
        const setExt = (provider, ext) => {
            const i = exts.findIndex(e => e.provider === provider);
            if (i >= 0) exts.splice(i, 1);
            if (ext) exts.push({ provider, ...ext });
        };
        if (sheet.theme?.from) {
            const { skeleton } = themeFromFile(sheet.theme.from, sheet.theme.sheet || 1);
            if (skeleton) setExt(skeleton.provider, { content: skeleton.content });
        }
        if (sheet.legend !== undefined) {
            if (sheet.legend === false || sheet.legend === null) {
                sheetObj.legend = { visibility: 'hidden' };
            } else {
                const l = sheet.legend === true ? {} : sheet.legend;
                sheetObj.legend = { visibility: l.visible === false ? 'hidden' : 'visible' };
                if (l.position) sheetObj.legend.position = { x: Number(l.position.x), y: Number(l.position.y) };
                // markers: {"priority-1": "Must have"} — the names shown in the legend.
                if (l.markers) {
                    sheetObj.legend.markers = Object.fromEntries(Object.entries(l.markers)
                        .map(([id, name]) => [id, { name: String(typeof name === 'object' ? name.name : name) }]));
                }
            }
        }
        if (sheet.customMarkers) {
            // [{id, name, image}] — markers drawn from your own icons; use the ids in topic "markers".
            const markers = sheet.customMarkers.map((m, i) => {
                if (!m.id || !m.image) throw new Error(`${where}: customMarkers[${i}] needs "id" and "image".`);
                const img = this.embedImage(typeof m.image === 'string' ? { path: m.image } : m.image, m.name || m.id);
                return { id: String(m.id), name: String(m.name || m.id), resource: img.src };
            });
            sheetObj.customMarkerGroups = [{ id: `custom-${generateId().slice(0, 8)}`, markers }];
        }
        if (sheet.watermark !== undefined) {
            if (!sheet.watermark) setExt('org.xmind.ui.watermark', null);
            else {
                const w = typeof sheet.watermark === 'string' ? { text: sheet.watermark } : sheet.watermark;
                const content = {};
                let resources;
                if (w.image) {
                    const img = this.embedImage(typeof w.image === 'string' ? { path: w.image } : w.image, 'watermark');
                    Object.assign(content, { kind: 'image', src: img.src, imageWidth: img.width, imageHeight: img.height });
                    resources = [img.src];
                } else if (w.text) {
                    Object.assign(content, { kind: 'text', text: String(w.text) });
                    if (w.fontFamily) content.fontFamily = w.fontFamily;
                    if (w.fontSize != null) content.fontSize = Number(w.fontSize);
                    if (w.bold != null) content.fontWeight = w.bold ? 700 : 400;
                    if (w.color) content.color = hexColor(w.color, 'watermark color', where);
                } else {
                    throw new Error(`${where}: watermark needs "text" or "image".`);
                }
                if (w.opacity != null) content.opacity = Number(w.opacity);
                if (w.rotation != null) content.rotationDegrees = Number(w.rotation);
                if (w.density != null) content.density = oneOf(w.density, new Set(['sparse', 'normal', 'dense']), 'watermark density', where);
                setExt('org.xmind.ui.watermark', { content, ...(resources ? { resources } : {}) });
            }
        }
        if (sheet.backgroundTexture !== undefined) {
            if (!sheet.backgroundTexture) setExt('org.xmind.ui.background-texture', null);
            else {
                const b = typeof sheet.backgroundTexture === 'string' ? { style: sheet.backgroundTexture } : sheet.backgroundTexture;
                const content = { style: oneOf(b.style, new Set(['grid', 'dots']), 'backgroundTexture style', where) };
                if (b.color) content.color = hexColor(b.color, 'backgroundTexture color', where);
                if (b.opacity != null) content.opacity = Number(b.opacity);
                if (b.density != null) content.density = oneOf(b.density, new Set(['sparse', 'normal', 'dense']), 'backgroundTexture density', where);
                setExt('org.xmind.ui.background-texture', { content });
            }
        }
    }

    // Equation, web video, audio note, link preview → image / href / extensions on the topic.
    richContent(input, topic, where, previous) {
        const ext = [];
        if (input.equation != null && input.equation !== false) {
            const spec = typeof input.equation === 'string' ? { latex: input.equation } : input.equation;
            if (!spec.latex) throw new Error(`${where}: equation needs LaTeX, e.g. "equation": "E = mc^2".`);
            const { svg, width, height } = latexToSvg(spec.latex, { fontSize: spec.fontSize || 28, color: spec.color || '#1E1E1E' });
            const src = `xap:${this.storeResource(Buffer.from(svg, 'utf-8'), '.svg')}`;
            topic.image = { src, width, height, isMathJaxImage: true };
            ext.push({ provider: 'org.xmind.ui.mathJax', content: { content: spec.latex } });
        }
        if (input.video) {
            const spec = typeof input.video === 'string' ? { url: input.video } : input.video;
            if (!/^https?:\/\//.test(spec.url || '')) throw new Error(`${where}: video needs an http(s) "url".`);
            const info = videoEmbedUrl(spec.url);
            const thumb = spec.thumbnail
                ? this.embedImage({ path: spec.thumbnail, width: spec.width || 320 }, input.title)
                : this.embedImage({ data: Buffer.from(videoPlaceholderSvg(spec.label || info.site), 'utf-8'),
                    ext: '.svg', width: spec.width || 320 }, input.title);
            topic.image = thumb;
            topic.href = spec.url;
            // XMind shows the video player only while href and image still match these values.
            ext.push({ provider: 'org.xmind.ui.webVideo',
                content: { url: spec.url, thumbnail: thumb.src, embedUrl: spec.embedUrl || info.embedUrl } });
        }
        if (input.audio) {
            let src = typeof input.audio === 'string' ? input.audio : input.audio.path || input.audio.src;
            if (String(src).startsWith('xap:')) {
                if (!this.existingResourceNames.has(src.slice(4)) && !this.images.has(src.slice(4))) {
                    throw new Error(`${where}: audio "${src}" is not in the file being overwritten. ` +
                        'Saving a map you read to a new path? Add "sourcePath": "<the file you read>".');
                }
            } else {
                const e = extname(src).toLowerCase();
                if (!AUDIO_EXTS.has(e)) throw new Error(`${where}: unsupported audio type "${e}" (${[...AUDIO_EXTS].join(', ')}).`);
                if (!existsSync(resolve(src))) throw new Error(`${where}: audio file not found: ${src}`);
                src = `xap:${this.storeResource(readFileSync(noteLocalFile(src)), e)}`;
            }
            ext.push({ provider: 'org.xmind.ui.audionotes', content: null, resources: [src] });
        }
        if (input.linkPreview) {
            const spec = input.linkPreview === true ? {} : input.linkPreview;
            const url = spec.url || input.href || topic.href;
            if (!url) throw new Error(`${where}: linkPreview needs a "url" (or the topic's "href").`);
            topic.href = url;
            const content = { mode: spec.mode === 'embed' ? 'embed' : 'preview' };
            for (const k of ['title', 'description', 'siteName', 'imageUrl', 'faviconUrl']) {
                if (typeof spec[k] === 'string') content[k] = spec[k];
            }
            ext.push({ provider: 'org.xmind.ui.linkPreview', content });
        }
        return ext;
    }

    hasPlannedTasks(input) {
        if (input.startDate || input.dueDate || input.progress !== undefined || input.durationDays !== undefined ||
            input.duration !== undefined) return true;
        return (input.children || []).some(c => this.hasPlannedTasks(c));
    }

    buildTopic(input, { detached = false, key = null } = {}) {
        const id = generateId();
        this.topicSheet.set(id, this.sheetIndex);
        if (!this.titleToId.has(input.title)) this.titleToId.set(input.title, id);
        this.titleCount.set(input.title, (this.titleCount.get(input.title) || 0) + 1);
        if (input.ref !== undefined) {
            if (this.refToId.has(input.ref)) throw new Error(`Duplicate topic ref "${input.ref}" — refs must be unique.`);
            this.refToId.set(input.ref, id);
        }
        if (typeof input.id === 'string') this.inputIdToId.set(input.id, id);
        const topic = { id, class: "topic", title: input.title };

        // Same topic in the file being overwritten (see matchPrevious), used to carry its
        // styling forward when the input doesn't restate it.
        const previous = this.matchPrevious(input, key);

        // Rich-text title runs only stay valid while the plain title is unchanged.
        if (previous?.attributedTitle?.length > 0 &&
            previous.attributedTitle.map(r => r.text ?? '').join('') === input.title) {
            topic.attributedTitle = previous.attributedTitle;
        }

        if (input.structureClass) {
            topic.structureClass = xmindClass(input.structureClass, 'org.xmind.ui.', K.KNOWN.structure, 'layout (structureClass)', `Topic "${input.title}"`);
        }
        else if (input.structureClass === undefined && previous?.structureClass) {
            topic.structureClass = previous.structureClass;
        }
        if (input.position) topic.position = input.position;

        // Fixed text-wrap width (XMind's customWidth, set by dragging a topic's edge).
        const width = input.width ?? input.customWidth;
        if (width != null) {
            if (!(typeof width === 'number' && width > 0)) {
                throw new Error(`Topic "${input.title}": width must be a positive number (got ${JSON.stringify(width)}).`);
            }
            topic.customWidth = width;
        } else if (width === undefined && previous?.customWidth) {
            topic.customWidth = previous.customWidth;
        }

        // Input style is layered over the previous file's style for the same topic, so an
        // edit made in XMind (e.g. a colour) survives unless the input sets that property.
        // A friendly key set to null clears its properties; `"style": null` drops the old style.
        const oldProps = input.style === null ? {} : (previous?.style?.properties || {});
        const styleProps = dropNulls({ ...oldProps, ...(topicStyleProps(input) || {}) });
        if (Object.keys(styleProps).length > 0) {
            topic.style = { id: generateId(), properties: styleProps };
        }

        if (input.image) {
            topic.image = this.embedImage(input.image, input.title, previous);
        } else if (input.image === undefined && previous?.image) {
            // Its resource file is carried forward with the other existing resources.
            topic.image = { ...previous.image };
        }

        const where = `Topic "${input.title}"`;
        // Rich-text title: [{text, bold?, italic?, color?, highlight?, underline?, strike?, fontSize?, fontFamily?}]
        if (Array.isArray(input.titleRuns)) topic.attributedTitle = attributedTitle(input.titleRuns, where);
        if (input.folded != null) {
            if (input.folded) topic.branch = 'folded';
        } else if (previous?.branch) {
            topic.branch = previous.branch;
        }
        const richExtensions = this.richContent(input, topic, where, previous);

        if (input.notes) {
            if (typeof input.notes === 'string') {
                topic.notes = { plain: { content: input.notes } };
            } else {
                topic.notes = {};
                // `content` is the key read_xmind.mjs uses for the plain-text part.
                const plain = input.notes.plain ?? input.notes.content;
                if (plain) topic.notes.plain = { content: plain };
                if (input.notes.html) topic.notes.realHTML = { content: input.notes.html };
            }
        }
        if (input.attachment) {
            this.attachments.push({ sourcePath: input.attachment, topicId: id });
        } else if (input.href) {
            topic.href = input.href;
        }
        if (input.linkToRef !== undefined || input.linkToTopic) {
            this.pendingLinks.set(id, { ref: input.linkToRef, title: input.linkToTopic });
        }
        if (input.labels) topic.labels = input.labels;
        if (input.markers?.length > 0) {
            for (const m of input.markers) {
                if (!K.MARKER_PREFIX.test(m) && !this.customMarkerIds.has(m)) {
                    console.error(`Warning: Topic "${input.title}": marker "${m}" is neither a built-in marker nor one of the sheet's customMarkers — XMind shows nothing for it.`);
                }
            }
            topic.markers = input.markers.map(m => ({ markerId: m }));
        }

        const hasTaskProps = input.taskStatus || input.progress !== undefined ||
            input.priority !== undefined || input.startDate || input.dueDate ||
            input.durationDays !== undefined || input.duration !== undefined || input.dependencies;
        if (hasTaskProps) {
            const tc = {};
            if (input.taskStatus) tc.status = oneOf(input.taskStatus, TASK_STATUSES, 'taskStatus', where);
            if (input.progress !== undefined) {
                if (!(typeof input.progress === 'number' && Number.isFinite(input.progress))) {
                    throw new Error(`${where}: progress must be a number from 0 to 1 (got ${JSON.stringify(input.progress)}).`);
                }
                tc.progress = Math.min(1, Math.max(0, input.progress));
                if (tc.progress !== input.progress) console.error(`Warning: ${where}: progress ${input.progress} clamped to ${tc.progress} (0 = not started, 1 = done).`);
            }
            if (input.priority !== undefined) {
                if (!(Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 9)) {
                    throw new Error(`${where}: priority must be a whole number from 1 (highest) to 9 (got ${JSON.stringify(input.priority)}).`);
                }
                tc.priority = input.priority;
            }
            const start = input.startDate != null ? taskDate(input.startDate, 'startDate', where) : undefined;
            const due = input.dueDate != null ? taskDate(input.dueDate, 'dueDate', where) : undefined;
            let days;
            if (input.durationDays !== undefined) {
                if (!(typeof input.durationDays === 'number' && input.durationDays >= 0)) {
                    throw new Error(`${where}: durationDays must be a number of days ≥ 0.`);
                }
                days = input.durationDays * 86400000;
            }
            if (start !== undefined) tc.start = start;
            if (start !== undefined && due !== undefined) {
                if (due < start) throw new Error(`${where}: dueDate is before startDate.`);
                tc.due = due;
                tc.duration = due - start;
                if (days !== undefined && days !== tc.duration) {
                    console.error(`Warning: ${where}: durationDays doesn't match startDate → dueDate; the dates win.`);
                }
            } else if (start !== undefined && days !== undefined) {
                tc.due = start + days; // start + length → due date
                tc.duration = days;
            } else if (due !== undefined) {
                tc.due = due;
                if (days !== undefined) { tc.duration = days; tc.start = due - days; }
            } else if (days !== undefined) {
                tc.duration = days; // relative planning: XMind places it after its dependencies
            } else if (input.duration !== undefined && tc.duration === undefined) {
                tc.duration = input.duration; // milliseconds — what read_xmind.mjs returns
            }
            if (input.dependencies?.length > 0) this.pendingDependencies.set(id, input.dependencies);
            topic.extensions = [{ provider: 'org.xmind.ui.task', content: tc }];
        }
        if (richExtensions.length > 0) {
            topic.extensions = [...(topic.extensions || []), ...richExtensions];
        }
        // `numbering` ({pattern, tiered}) on the topic itself — the shape read_xmind.mjs returns.
        if (input.numbering?.pattern) {
            const pattern = Object.values(NUMBERING).includes(input.numbering.pattern) ? input.numbering.pattern
                : NUMBERING[input.numbering.pattern];
            if (!pattern) throw new Error(`${where}: unknown numbering pattern "${input.numbering.pattern}".`);
            topic.extensions = [...(topic.extensions || []).filter(e => e.provider !== 'org.xmind.ui.numbering'),
                { provider: 'org.xmind.ui.numbering', content: { pattern, tiered: !!input.numbering.tiered } }];
        }
        if (input.matrixColumns && !input._matrixColumns) {
            input._matrixColumns = input.matrixColumns.map(String);
            topic.structureClass = topic.structureClass || 'org.xmind.ui.spreadsheet';
        }
        if (input._matrixColumns) {
            topic.extensions = [...(topic.extensions || []).filter(e => e.provider !== 'org.xmind.ui.spreadsheet'), {
                provider: 'org.xmind.ui.spreadsheet',
                content: [{ name: 'columns', content: input._matrixColumns.map(c => ({ name: 'column', content: c })) }],
            }];
        }
        // Other topic extensions from the existing file (numbering, audio notes, …) are kept.
        const keptExtensions = (previous?.extensions || []).filter(e => e.provider !== 'org.xmind.ui.task' &&
            !(topic.extensions || []).some(x => x.provider === e.provider));
        if (keptExtensions.length > 0) topic.extensions = [...(topic.extensions || []), ...keptExtensions];

        if (input.boundaries?.length > 0) {
            topic.boundaries = input.boundaries.map((b, i) => {
                const out = { id: generateId(), range: b.range };
                if (b.title) out.title = b.title;
                const props = outlineStyleProps(b, 'boundary', `topic "${input.title}" boundary ${i + 1}`);
                if (props) out.style = { id: generateId(), properties: props };
                return out;
            });
        }
        // `summaries` + `topicTitle` is the shape read_xmind.mjs returns.
        const summaryInput = input.summaryTopics ??
            input.summaries?.map(s => ({ ...s, title: s.title ?? s.topicTitle ?? '' }));
        let summaryTopics = null;
        if (summaryInput?.length > 0) {
            summaryTopics = [];
            topic.summaries = summaryInput.map((s, i) => {
                const topicId = generateId();
                summaryTopics.push({ id: topicId, class: 'topic', title: s.title ?? '' });
                const out = { id: generateId(), range: s.range, topicId };
                const props = outlineStyleProps(s, 'summary', `topic "${input.title}" summary ${i + 1}`);
                if (props) out.style = { id: generateId(), properties: props };
                return out;
            });
            // XMind reads summary topics from children.summary (a top-level `summary` key is ignored).
        }

        const seen = new Map();
        const attached = input.children?.length > 0
            ? input.children.map(c => this.buildTopic(c, { key: key ? childKey(key, c.title, seen) : null }))
            : undefined;
        if (input.numberChildren === false && attached) {
            // Remove numbering carried over from the existing file.
            for (const child of attached) {
                child.extensions = (child.extensions || []).filter(e => e.provider !== 'org.xmind.ui.numbering');
                if (child.extensions.length === 0) delete child.extensions;
            }
        } else if (input.numberChildren != null && attached) {
            const numbering = numberingContent(input.numberChildren, `Topic "${input.title}"`);
            for (const child of attached) {
                const others = (child.extensions || []).filter(e => e.provider !== 'org.xmind.ui.numbering');
                child.extensions = [...others, { provider: 'org.xmind.ui.numbering', content: numbering }];
            }
        }

        // Callouts: strings, or {title} objects as returned by read_xmind.mjs.
        const callout = input.callouts?.length > 0
            ? input.callouts.map(c => ({ id: generateId(), title: typeof c === 'string' ? c : String(c?.title ?? '') }))
            : undefined;
        if (attached || callout || summaryTopics) {
            topic.children = {};
            if (attached) topic.children.attached = attached;
            if (callout) topic.children.callout = callout;
            if (summaryTopics) topic.children.summary = summaryTopics;
        }

        return topic;
    }
}

// Write to a temporary file next to the target, then rename over it: an interrupted write never
// leaves a half-written file in place of the original.
// Every file from the user's disk that goes into the output is listed after writing, so a map
// that asks for an unexpected file (e.g. one copied from a file someone else sent) is noticed.
const LOCAL_FILES = new Set();
function noteLocalFile(p) {
    const abs = resolve(p);
    LOCAL_FILES.add(abs);
    return abs;
}

// A symlinked target is followed (the real file is updated, the link stays a link) and the existing
// file's permissions are kept.
// The temp file is created exclusively and owner-only, so nobody can read the map while it is written.
async function writeAtomic(path, data) {
    writeFileAtomicSync(path, data);
}

// Validate first, then write. A file with validation errors never replaces an existing file (that
// would lose a good original): nothing is written and the exit code is 2. A new file is written and
// also exits with 2, so the problems get fixed.
async function writeChecked(path, buf, password, createdMessage) {
    const v = validateBuffer(buf, { password });
    const warn = v.warnings || [];
    if (v.errors?.length) {
        const keep = existsSync(path);
        console.error(`Validation: ${v.errors.length} error(s) — XMind will not show this as intended:`);
        for (const e of v.errors) console.error(`  - ${e}`);
        for (const w of warn) console.error(`  warning: ${w}`);
        process.exitCode = 2;
        if (keep) {
            console.error(`Nothing was written: ${path} keeps its previous content. Fix the errors and run again.`);
            return;
        }
        await writeAtomic(path, buf);
        console.log(createdMessage);
        return;
    }
    await writeAtomic(path, buf);
    console.log(createdMessage);
    if (LOCAL_FILES.size) console.log(`Embedded files from disk: ${[...LOCAL_FILES].join(', ')}`);
    console.log(`Validation: ok${warn.length ? ` (${warn.length} warning(s))` : ''}`);
    for (const w of warn) console.error(`  warning: ${w}`);
}

// Output format: "legacy" / "xml" / "old", XMind 3–8 or years up to 2019 → XMind 8 XML; "zen" / "json" /
// "modern" / "latest" / "new", XMind 10+ or 2020+ → modern JSON (the default). Prefixes like "xmind" or
// "pro" and separators are ignored ("XMind 2024", "xmind-8", "pro8").
function resolveFormat(value) {
    const raw = String(value ?? 'zen').toLowerCase().replace(/[\s_-]+/g, '');
    if (['legacy', 'xml', 'old'].includes(raw)) return 'legacy';
    if (['zen', 'json', 'new', 'latest', 'modern', 'xmindzen'].includes(raw)) return 'zen';
    const num = parseInt(raw.replace(/^(xmind|pro)/, ''), 10);
    if (Number.isFinite(num)) return num <= 9 || (num >= 100 && num <= 2019) ? 'legacy' : 'zen';
    console.error(`Warning: unknown format "${value}", writing the modern format. ` +
        'Use "legacy" (XMind 8, e.g. "xmind8", "2013") or "zen" (XMind 2020+, e.g. "latest", "2024").');
    return 'zen';
}

// Main
async function main() {
    let rawInput = '';
    for await (const chunk of process.stdin) rawInput += chunk;

    const input = JSON.parse(rawInput);
    const outputPath = input.path || process.argv.find((a, i) => process.argv[i - 1] === '--path');
    if (!outputPath) {
        console.error('Error: no output path. Provide "path" in JSON or --path argument.');
        process.exit(1);
    }
    if (!outputPath.toLowerCase().endsWith('.xmind')) {
        console.error('Error: path must end with .xmind');
        process.exit(1);
    }

    const resolvedFormat = resolveFormat(input.format);

    const builder = new XMindBuilder();

    const resolvedPath = resolve(outputPath);
    await mkdir(dirname(resolvedPath), { recursive: true });

    // If a zen-format .xmind already exists at this path, preserve its per-sheet theme/layout
    // extensions and embedded resources (thumbnail, attachments) when regenerating — see
    // loadExistingXMind(). Legacy-format rebuilds don't carry theme state the same way, so this
    // only applies when producing zen output.
    if (resolvedFormat === 'legacy' && existsSync(resolvedPath)) {
        // A legacy rewrite would drop the protection of an existing protected file — refuse unless told to.
        let enc = false;
        try { enc = openZip(readFileSync(resolvedPath)).encrypted; } catch { /* not a zip */ }
        if (enc && !input.removePassword) {
            throw new Error(`${resolvedPath} is password-protected; XMind 8 files can't be. Nothing was written. ` +
                'Pass "removePassword": true to replace it with an unprotected XMind 8 file.');
        }
    }
    let existing = await loadExistingXMind(resolvedPath, input.password, { overwrite: input.overwrite === true });
    // "Save as": sourcePath is the file the input was read from. Its embedded images / attachments are
    // available to "xap:" references, and when the target is new it is the base for style preservation
    // exactly as if it were being overwritten.
    if (input.sourcePath) {
        const src = resolve(input.sourcePath);
        if (!existsSync(src)) throw new Error(`sourcePath not found: ${input.sourcePath}`);
        const source = await loadExistingXMind(src, input.sourcePassword ?? input.password);
        if (!source) throw new Error(`sourcePath is not a readable .xmind file: ${input.sourcePath}`);
        if (!existing) {
            existing = { ...source, resourceEntries: source.resourceEntries, encrypted: false, passwordHint: null };
        } else {
            const have = new Set(existing.resourceEntries.map(r => r.name));
            existing.resourceEntries.push(...source.resourceEntries.filter(r => /^(resources|attachments)\//.test(r.name) && !have.has(r.name)));
        }
    }
    if (existing?.encrypted && input.removePassword) {
        console.error('Note: "removePassword" — the file is now saved without password protection.');
    }
    // An updated protected file stays protected (with its hint) unless removePassword is set.
    const password = input.removePassword ? null : input.password;
    const passwordHint = input.passwordHint ?? existing?.passwordHint ?? null;
    if (existing) {
        console.error(`Note: preserving theme/layout/resources from existing file at ${resolvedPath}`);
    }

    const { contentJson, attachments } = builder.build(input.sheets, existing?.sheetsByTitle, {
        preserveStyles: input.preserveStyles !== false,
        existingResourceNames: existing?.resourceEntries.map(r => r.name) || [],
    });

    const zenOnly = resolvedFormat === 'legacy' ? zenOnlyFeatures(input) : [];
    if (zenOnly.length > 0) {
        console.error(`Warning: XMind 8 (legacy) files can't hold ${zenOnly.join(', ')} — use the modern format ` +
            'to keep them. Structure, styles, themes, images and thumbnails are written.');
    }
    if (resolvedFormat === 'legacy' && input.password) throw new Error('Password protection needs the modern (zen) format.');

    if (resolvedFormat === 'legacy') {
        // Legacy XML format (XMind 3–8 compatible)
        // Only resources the new content references are carried over (finalize drops the rest).
        const { resourceFiles } = await builder.finalize(contentJson, attachments,
            (existing?.resourceEntries || []).filter(r => /^(resources|attachments)\//.test(r.name)), null, input.thumbnail);
        const { contentXml, stylesXml } = buildLegacy(contentJson);
        const metaXml = buildLegacyMeta();
        const fileEntries = { 'content.xml': {}, 'meta.xml': {}, 'META-INF/manifest.xml': {} };
        if (stylesXml) fileEntries['styles.xml'] = {};
        for (const rf of resourceFiles) fileEntries[rf.name] = {};
        const manifestXml = buildLegacyManifest(fileEntries);

        const zipBuffer = buildZip([
            { name: 'content.xml', data: Buffer.from(contentXml, 'utf-8') },
            { name: 'meta.xml', data: Buffer.from(metaXml, 'utf-8') },
            { name: 'META-INF/manifest.xml', data: Buffer.from(manifestXml, 'utf-8') },
            ...(stylesXml ? [{ name: 'styles.xml', data: Buffer.from(stylesXml, 'utf-8') }] : []),
            ...resourceFiles,
        ]);
        await writeChecked(resolvedPath, zipBuffer, null, `Created (XMind 8 / legacy XML format): ${resolvedPath}`);
    } else {
        // Modern JSON format (XMind Zen / 2020+)
        const { content, metadata, manifest, resourceFiles } = await builder.finalize(
            contentJson, attachments, existing?.resourceEntries, existing?.metadataRaw, input.thumbnail,
        );
        let entries = [
            { name: 'content.json', data: Buffer.from(content, 'utf-8') },
            { name: 'metadata.json', data: Buffer.from(metadata, 'utf-8') },
            ...resourceFiles,
        ];
        let manifestOut = manifest;
        if (password) {
            if (typeof password !== 'string') throw new Error('"password" must be a string.');
            // A thumbnail would show the map to anyone without the password — leave it out.
            entries = entries.filter(e => !e.name.startsWith('Thumbnails/'));
            const fileEntries = {};
            entries = entries.map(e => {
                const { data, meta } = encryptEntry(e.data, password);
                fileEntries[e.name] = meta;
                return { name: e.name, data };
            });
            manifestOut = JSON.stringify({ 'file-entries': fileEntries,
                ...(passwordHint ? { 'password-hint': String(passwordHint) } : {}) });
        }
        const zipBuffer = buildZip([
            entries[0], entries[1],
            { name: 'manifest.json', data: Buffer.from(manifestOut, 'utf-8') },
            ...entries.slice(2),
        ]);
        await writeChecked(resolvedPath, zipBuffer, password,
            `Created (XMind Zen / modern JSON format${password ? ', password-protected' : ''}): ${resolvedPath}`);
    }
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
