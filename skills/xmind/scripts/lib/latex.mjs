// LaTeX → SVG: a small dependency-free typesetter for the usual LaTeX subset (fractions, scripts,
// roots, Greek, operators, \text). XMind stores an equation as an image plus its LaTeX source; when the
// equation is edited in XMind, its own MathJax renders it again.
import { XML_INVALID } from './util.mjs';

const TEX_SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    varpi: 'ϖ', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
    omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠',
    ne: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
    sum: '∑', prod: '∏', int: '∫', oint: '∮', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
    supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧',
    lor: '∨', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
    leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', ldots: '…', cdots: '⋯', dots: '…',
    circ: '∘', degree: '°', prime: '′', angle: '∠', perp: '⊥', parallel: '∥', hbar: 'ℏ', ell: 'ℓ',
    Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈',
    rceil: '⌉', quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ',
    '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', _: '_', lbrace: '{', rbrace: '}',
    vert: '|', mid: '|', backslash: '\\', star: '⋆', ast: '∗', bullet: '•', oplus: '⊕', otimes: '⊗',
};
const TEX_FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min',
    'det', 'arg', 'sup', 'inf', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'gcd', 'mod']);

function parseTex(src) {
    let i = 0;
    const group = stop => {
        const items = [];
        while (i < src.length) {
            const c = src[i];
            if (c === stop) { i++; break; }
            if (c === '}' && stop !== '}') { i++; continue; }
            items.push(atom());
        }
        return { type: 'row', items };
    };
    const arg = () => {
        while (src[i] === ' ') i++;
        if (i >= src.length) return { type: 'row', items: [] };
        if (src[i] === '{') { i++; return group('}'); }
        return atom();
    };
    let depth = 0;
    const atom = () => {
        if (i >= src.length) return { type: 'text', text: '', upright: true };
        if (++depth > 200) throw new Error('equation is nested too deeply');
        try { return atomInner(); } finally { depth--; }
    };
    const atomInner = () => {
        const c = src[i];
        if (c === '{') { i++; return group('}'); }
        if (c === '^' || c === '_') {
            i++;
            return { type: c === '^' ? 'sup' : 'sub', body: arg() };
        }
        if (c === '\\') {
            i++;
            let name = '';
            if (/[a-zA-Z]/.test(src[i] || '')) while (/[a-zA-Z]/.test(src[i] || '')) name += src[i++];
            else name = src[i++] || '';
            if (name === 'frac' || name === 'dfrac' || name === 'tfrac') return { type: 'frac', num: arg(), den: arg() };
            if (name === 'sqrt') {
                let index = null;
                if (src[i] === '[') {
                    // An unclosed \sqrt[ takes the rest of the input as its index.
                    let j = src.indexOf(']', i);
                    if (j < 0) j = src.length;
                    index = { type: 'text', text: src.slice(i + 1, j) };
                    i = Math.min(j + 1, src.length);
                }
                return { type: 'sqrt', body: arg(), index };
            }
            if (['text', 'mathrm', 'textrm', 'operatorname', 'mathbf', 'textbf', 'mathit', 'mathsf', 'mathtt'].includes(name)) {
                const body = arg();
                const flat = n => n.type === 'text' ? n.text : n.type === 'row' ? n.items.map(flat).join('') : '';
                return { type: 'text', text: flat(body), upright: !/it$/.test(name), bold: /bf$/.test(name) };
            }
            if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg') {
                return atom();
            }
            if (name === 'overline' || name === 'bar' || name === 'hat' || name === 'vec' || name === 'tilde' || name === 'dot') {
                return { type: 'accent', accent: { overline: '‾', bar: '¯', hat: 'ˆ', vec: '→', tilde: '˜', dot: '˙' }[name], body: arg() };
            }
            if (TEX_FUNCS.has(name)) return { type: 'text', text: name, upright: true };
            if (TEX_SYMBOLS[name] !== undefined) return { type: 'text', text: TEX_SYMBOLS[name], upright: true };
            return { type: 'text', text: name, upright: true };
        }
        i++;
        if (c === ' ') return { type: 'text', text: '', upright: true };
        const ch = { '-': '−', '*': '∗', "'": '′' }[c] || c;
        return { type: 'text', text: ch, upright: !/[a-zA-Z]/.test(c) };
    };
    return group(null);
}

export function escapeSvg(t) {
    return String(t).replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lay out a parsed node at font size `fs`; returns {w, asc, desc, draw(x, y) → svg}.
function layoutTex(node, fs) {
    const cw = (t, upright) => [...t].reduce((w, ch) => w + fs * (/[ilj.,;:!'|]/.test(ch) ? 0.3
        : /[mwMW∑∏]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.62 : upright ? 0.55 : 0.5), 0);
    switch (node.type) {
    case 'text': {
        const w = cw(node.text, node.upright) + (node.text && /[=+\-−×·÷±<>≤≥≠≈→⇒∈]/.test(node.text) ? fs * 0.3 : 0);
        return {
            w, asc: fs * 0.75, desc: fs * 0.25,
            draw: (x, y) => node.text ? `<text x="${(x + (w - cw(node.text, node.upright)) / 2).toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(1)}"` +
                `${node.upright ? '' : ' font-style="italic"'}${node.bold ? ' font-weight="bold"' : ''}>${escapeSvg(node.text)}</text>` : '',
        };
    }
    case 'row': {
        const parts = [];
        let w = 0, asc = fs * 0.75, desc = fs * 0.25;
        for (let k = 0; k < node.items.length; k++) {
            const it = node.items[k];
            if (it.type === 'sup' || it.type === 'sub') {
                const b = layoutTex(it.body, fs * 0.7);
                const shift = it.type === 'sup' ? -fs * 0.42 : fs * 0.25;
                parts.push({ x: w, dy: shift, box: b });
                asc = Math.max(asc, b.asc - shift); desc = Math.max(desc, b.desc + shift);
                // a ^ directly followed by _ (or the reverse) stacks on the same x
                const nx = node.items[k + 1];
                if (nx && (nx.type === 'sup' || nx.type === 'sub') && nx.type !== it.type) {
                    const b2 = layoutTex(nx.body, fs * 0.7);
                    const s2 = nx.type === 'sup' ? -fs * 0.42 : fs * 0.25;
                    parts.push({ x: w, dy: s2, box: b2 });
                    asc = Math.max(asc, b2.asc - s2); desc = Math.max(desc, b2.desc + s2);
                    w += Math.max(b.w, b2.w); k++;
                } else w += b.w;
                continue;
            }
            const b = layoutTex(it, fs);
            parts.push({ x: w, dy: 0, box: b });
            w += b.w; asc = Math.max(asc, b.asc); desc = Math.max(desc, b.desc);
        }
        return { w, asc, desc, draw: (x, y) => parts.map(p => p.box.draw(x + p.x, y + p.dy)).join('') };
    }
    case 'frac': {
        const n = layoutTex(node.num, fs * 0.85), d = layoutTex(node.den, fs * 0.85);
        const w = Math.max(n.w, d.w) + fs * 0.3, axis = fs * 0.3;
        return {
            w, asc: axis + n.asc + n.desc + fs * 0.12, desc: d.asc + d.desc + fs * 0.12 - axis,
            draw: (x, y) => n.draw(x + (w - n.w) / 2, y - axis - n.desc - fs * 0.12) +
                `<line x1="${(x + fs * 0.05).toFixed(1)}" x2="${(x + w - fs * 0.05).toFixed(1)}" y1="${(y - axis).toFixed(1)}" y2="${(y - axis).toFixed(1)}" stroke="currentColor" stroke-width="${(fs * 0.06).toFixed(2)}"/>` +
                d.draw(x + (w - d.w) / 2, y - axis + d.asc + fs * 0.12),
        };
    }
    case 'sqrt': {
        const b = layoutTex(node.body, fs), pad = fs * 0.55;
        const idx = node.index ? layoutTex(node.index, fs * 0.55) : null;
        const lead = idx ? Math.max(0, idx.w - pad * 0.4) : 0;
        return {
            w: lead + pad + b.w + fs * 0.1, asc: b.asc + fs * 0.15, desc: b.desc,
            draw: (x, y) => {
                const x0 = x + lead, top = y - b.asc - fs * 0.1, bottom = y + b.desc;
                return (idx ? idx.draw(x, y - b.asc * 0.55) : '') +
                    `<polyline fill="none" stroke="currentColor" stroke-width="${(fs * 0.06).toFixed(2)}" points="${(x0 + fs * 0.05).toFixed(1)},${(y - fs * 0.25).toFixed(1)} ${(x0 + pad * 0.35).toFixed(1)},${bottom.toFixed(1)} ${(x0 + pad * 0.8).toFixed(1)},${top.toFixed(1)} ${(x0 + pad + b.w + fs * 0.1).toFixed(1)},${top.toFixed(1)}"/>` +
                    b.draw(x0 + pad, y);
            },
        };
    }
    case 'accent': {
        const b = layoutTex(node.body, fs);
        return { w: b.w, asc: b.asc + fs * 0.3, desc: b.desc,
            draw: (x, y) => b.draw(x, y) + `<text x="${(x + b.w / 2).toFixed(1)}" y="${(y - b.asc + fs * 0.05).toFixed(1)}" font-size="${(fs * 0.8).toFixed(1)}" text-anchor="middle">${node.accent}</text>` };
    }
    default:
        return { w: 0, asc: 0, desc: 0, draw: () => '' };
    }
}

export function latexToSvg(latex, { fontSize = 28, color = '#1E1E1E' } = {}) {
    // Only a hex colour reaches the SVG markup (anything else could inject elements).
    if (!/^#[0-9a-f]{3,8}$/i.test(String(color))) color = '#1E1E1E';
    fontSize = Math.min(Math.max(Number(fontSize) || 28, 4), 400);
    const box = layoutTex(parseTex(String(latex).trim().replace(/^\$+|\$+$/g, '')), fontSize);
    const padX = fontSize * 0.3, padY = fontSize * 0.25;
    const w = Math.ceil(box.w + 2 * padX), h = Math.ceil(box.asc + box.desc + 2 * padY);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" color="${color}">` +
        `<g fill="${color}" font-family="'Latin Modern Math','Cambria Math','STIX Two Math','Times New Roman',serif">` +
        box.draw(padX, padY + box.asc) + '</g></svg>';
    return { svg, width: w, height: h };
}

