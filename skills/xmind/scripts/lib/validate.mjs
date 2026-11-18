// validate: a structural check of a .xmind file against what XMind itself reads (shapes, arrows, layouts,
// summary placement, ids, resources, manifest, legacy styles). Nothing is opened — the file is only parsed.

import { openZip } from './crypto.mjs';
import { KNOWN } from './known.mjs';

const COLOR_PROPS = ['svg:fill', 'fo:color', 'border-line-color', 'line-color', 'fo:background-color'];

// Structural check of a .xmind file (Buffer) against what XMind itself reads → {valid, errors, warnings, …}.
// At most this many errors / warnings are listed (the rest are counted): a damaged or hostile file
// must not flood the output with thousands of lines.
const MAX_REPORTED = 30;

// Titles, paths and entry names come from the file: shortened and kept on one line in messages, so a
// huge or multi-line title can't blow up the output or pose as instructions.
const short = (v, n = 40) => {
    const t = String(v ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ');
    return t.length > n ? `${t.slice(0, n)}…` : t;
};
const joinPath = (path, title) => {
    const p = `${path} › ${short(title)}`;
    return p.length > 160 ? `…${p.slice(-160)}` : p;
};
const quoted = v => JSON.stringify(short(v, 100));

export function validateBuffer(buf, { password = null } = {}) {
    const errors = [], warnings = [];
    const seen = new Set();
    let moreErrors = 0, moreWarnings = 0;
    const add = (list, m) => {
        if (list.length >= MAX_REPORTED) return 1;   // over the limit: only counted
        m = short(m, 400);
        if (seen.has(m)) return 0;
        seen.add(m);
        list.push(m);
        return 0;
    };
    const err = m => { moreErrors += add(errors, m); };
    const warn = m => { moreWarnings += add(warnings, m); };
    const result = validateInner(buf, password, errors, warnings, err, warn);
    if (moreErrors) result.errors.push(`… and ${moreErrors} more error(s)`);
    if (moreWarnings) result.warnings.push(`… and ${moreWarnings} more warning(s)`);
    return result;
}

function validateInner(buf, password, errors, warnings, err, warn) {
    const PASSWORD = password;
    const zip = openZip(buf, password);
    const names = new Set(zip.names());

    if (!names.has('content.json')) {
        if (!names.has('content.xml')) return { valid: false, format: 'unknown', errors: ['neither content.json nor content.xml found'], warnings };
        validateLegacy(zip, names, err, warn);
        return { valid: errors.length === 0, format: 'legacy', errors, warnings };
    }
    if (zip.encrypted && !PASSWORD) return { valid: null, format: 'zen', encrypted: true, passwordHint: zip.passwordHint ? short(zip.passwordHint, 120) : null,
        errors: [], warnings: ['password-protected — pass "password" to validate the content'] };

    let manifest = {};
    try { manifest = JSON.parse(zip.extract('manifest.json')?.toString('utf-8') || '{}'); } catch { err('manifest.json is not valid JSON'); }
    const listed = new Set(Object.keys(manifest['file-entries'] || {}));
    for (const n of names) if (!n.endsWith('/') && !n.startsWith('__MACOSX/') && n !== 'manifest.json' && !listed.has(n) && n !== 'content.xml') warn(`${quoted(n)} is in the zip but not in manifest.json`);
    for (const n of listed) if (!names.has(n)) err(`manifest.json lists ${quoted(n)}, which is missing from the zip`);

    let sheets;
    try {
        const parsed = JSON.parse(zip.extract('content.json').toString('utf-8').replace(/^\uFEFF/, ''));
        sheets = Array.isArray(parsed) ? parsed : parsed.sheets;
    } catch (e) { return { valid: false, format: 'zen', errors: [`content.json: ${e.message}`], warnings }; }
    if (!Array.isArray(sheets) || sheets.length === 0) err('content.json has no sheets');

    const ids = new Set();
    const checkXap = (v, where) => {
        if (typeof v === 'string' && v.startsWith('xap:') && !names.has(v.slice(4))) err(`${where}: ${quoted(v)} is not in the file`);
    };
    const checkStyle = (props, kind, where) => {
        for (const [k, v] of Object.entries(props || {})) {
            if (COLOR_PROPS.includes(k) && typeof v === 'string' && v !== 'none' && v !== 'inherited' && !/^#[0-9a-f]{3,8}$/i.test(v)) {
                warn(`${where}: ${k} ${quoted(v)} is not a hex colour`);
            }
            if (k === 'shape-class') {
                const set = kind === 'relationship' ? KNOWN.relationship : kind === 'boundary' ? KNOWN.boundary
                    : kind === 'summary' ? KNOWN.summary : KNOWN.topicShape;
                if (!set.has(v)) err(`${where}: unknown shape ${quoted(v)} (XMind draws its default instead)`);
            }
            if ((k === 'arrow-begin-class' || k === 'arrow-end-class') && v !== 'inherited' && !KNOWN.arrow.has(v)) err(`${where}: unknown arrow ${quoted(v)} (no arrow head is drawn)`);
            if (k === 'line-class' && v !== 'inherited' && !KNOWN.branch.has(v)) err(`${where}: unknown branch line ${quoted(v)}`);
        }
    };

    (sheets || []).forEach((sheet, si) => {
        const sw = `sheet ${si + 1} "${short(sheet.title)}"`;
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
            if (t.structureClass && !KNOWN.structure.has(t.structureClass)) err(`${w}: unknown layout ${quoted(t.structureClass)}`);
            checkStyle(t.style?.properties, 'topic', w);
            checkXap(t.href, `${w} link`);
            checkXap(t.image?.src, `${w} image`);
            if (/<code[\s>]/i.test(t.notes?.realHTML?.content || '')) warn(`${w}: HTML note uses <code>, which XMind doesn't support (shown as plain text)`);
            for (const m of t.markers || []) {
                if (!KNOWN.markerPrefix.test(m.markerId) && !customMarkers.has(m.markerId)) warn(`${w}: marker ${quoted(m.markerId)} is neither a built-in nor a custom marker`);
            }
            const n = t.children?.attached?.length || 0;
            for (const b of t.boundaries || []) {
                const m = String(b.range).match(/^\((\d+),(\d+)\)$/);
                if (b.range === 'master') { /* the whole branch */ } else if (!m) err(`${w}: boundary range ${quoted(b.range)} must look like "(0,2)" or "master"`);
                else if (+m[2] >= n || +m[1] > +m[2]) err(`${w}: boundary range ${quoted(b.range)} is outside its ${n} children`);
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
            for (const [kind, list] of Object.entries(t.children || {})) list.forEach((c, i) => walk(c, joinPath(path, c.title ?? `(${kind} ${i + 1})`)));
        };
        if (!sheet.rootTopic) err(`${sw}: no rootTopic`); else walk(sheet.rootTopic, short(sheet.rootTopic.title ?? '(root)'));
        for (const r of sheet.relationships || []) {
            if (!topicIds.has(r.end1Id) || !topicIds.has(r.end2Id)) err(`${sw}: relationship ${r.id} points to a topic that doesn't exist`);
            checkStyle(r.style?.properties, 'relationship', `${sw} relationship "${short(r.title ?? r.id)}"`);
        }
    });
    // Second pass: dependency / internal-link targets across the whole workbook.
    const walkAll = t => {
        for (const e of t.extensions || []) for (const d of e.content?.dependencies || []) if (!ids.has(d.id)) err(`task ${quoted(t.title)}: dependency on missing topic ${d.id}`);
        if (typeof t.href === 'string' && t.href.startsWith('xmind:#') && !ids.has(t.href.slice(7))) warn(`${quoted(t.title)}: internal link to a missing topic`);
        for (const list of Object.values(t.children || {})) list.forEach(walkAll);
    };
    (sheets || []).forEach(sh => sh.rootTopic && walkAll(sh.rootTopic));
    return { valid: errors.length === 0, format: 'zen', encrypted: zip.encrypted, sheets: sheets?.length || 0, topics: ids.size, errors, warnings };
}

function validateLegacy(zip, names, err, warn) {
    const xml = zip.extract('content.xml').toString('utf-8');
    // All patterns below are bounded, so a crafted file can't make them backtrack for minutes.
    // content.xml has no <style> of its own in a file XMind 8 reads correctly (styles live in styles.xml).
    if (/<style[\s>]/.test(xml)) {
        err('topic styles are inline <style> elements — XMind 8 only reads styles.xml via style-id (they are ignored)');
    }
    const styleIds = new Set([...xml.matchAll(/style-id="([^"<>]{1,256})"/g)].map(m => m[1]));
    if (styleIds.size > 0) {
        if (!names.has('styles.xml')) err('style-id is used but styles.xml is missing');
        else {
            const sx = zip.extract('styles.xml').toString('utf-8');
            const defined = new Set([...sx.matchAll(/\bid="([^"<>]{1,256})"/g)].map(m => m[1]));
            for (const id of styleIds) if (!defined.has(id)) err(`style-id ${id} is not defined in styles.xml`);
        }
    }
    const refs = new Set([...xml.matchAll(/xap:([^"<>\s]{1,512})"/g)].map(m => m[1]));
    for (const r of refs) if (!names.has(r)) err(`${r} is referenced but missing`);
    return {};
}
