#!/usr/bin/env python3
"""Render an approximate PNG (or PDF) preview of each sheet in a modern (zen) .xmind file.

This is NOT XMind's layout engine. It reproduces XMind's layouts closely enough to check that a
generated map reads well — colours, fonts, box sizes, branch balance, labels, markers, images,
relationships, boundaries, summaries, callouts, numbering, tasks, folded branches, matrices,
watermark, background texture and legend — and it warns about things that look wrong in XMind.
Everything happens offline from the file alone: XMind is never opened and the screen is never read.

Usage:
    python3 preview_xmind.py FILE.xmind [--out-dir DIR] [--scale 0.5] [--sheet N]
                             [--format png|pdf] [--password-file FILE]
                             [--thumbnail]          # also embed sheet 1 as Thumbnails/thumbnail.png

Requires Pillow (pip install pillow); protected files also need Node.js (decryption is done by
read_xmind.mjs). Give their password in a file (--password-file, or XMIND_PASSWORD_FILE) written
with a file tool: other users on the machine can see command lines (ps), and so a --password
argument or an XMIND_PASSWORD=… prefix typed into a shell command (both still work). Prints one line per sheet:
    <png path>  <width>x<height>  <warnings>
"""

import argparse
import io
import json
import math
import os
import re
import subprocess
import sys
import glob
import shutil
import signal
import tempfile
import unicodedata
import zipfile

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("preview_xmind.py needs Pillow: pip install pillow")

PT = 1.333  # XMind sizes are in pt; 1pt ≈ 1.333px

# Limits for files from someone else: a picture or a far-away topic must not need gigabytes.
Image.MAX_IMAGE_PIXELS = 25_000_000      # embedded pictures (Pillow refuses larger ones)
MAX_CANVAS_PIXELS = 25_000_000           # the drawing; bigger maps are drawn at a smaller scale
MAX_CANVAS_SIDE = 16_000                 # … and no side longer than this
MAX_PARTS = 40                           # readable pieces of a very large drawing
MAX_FONT_PX = 400
IMAGE_FORMATS = ["PNG", "JPEG", "GIF", "WEBP", "BMP"]

FONT_CANDIDATES = {
    False: ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial Unicode.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/arial.ttf"],
    True: ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
           "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
           "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
           "C:/Windows/Fonts/arialbd.ttf"],
}
FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"),
             os.path.expanduser("~/.local/share/fonts"), "/Library/Fonts", "/System/Library/Fonts", "C:/Windows/Fonts"]
SYMBOL_FALLBACKS = ["/System/Library/Fonts/Apple Symbols.ttf",
                    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                    "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"]
EMOJI_FONTS = ["/System/Library/Fonts/Apple Color Emoji.ttc",
               "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"]

# Defaults when neither the topic nor the sheet theme sets a property (close to XMind's plain look).
DEFAULTS = {
    0: {"svg:fill": "#FFFFFF", "fo:color": "#1E1E1E", "fo:font-size": "26pt", "fo:font-weight": "bold",
        "border-line-color": "#1E1E1E", "border-line-width": "2pt", "line-color": "#495057", "line-width": "2pt"},
    1: {"svg:fill": "#FFFFFF", "fo:color": "#1E1E1E", "fo:font-size": "18pt", "fo:font-weight": "normal",
        "border-line-color": "#495057", "border-line-width": "1.5pt", "line-color": "#868E96", "line-width": "1.5pt"},
    2: {"svg:fill": "#FFFFFF", "fo:color": "#1E1E1E", "fo:font-size": "14pt", "fo:font-weight": "normal",
        "border-line-color": "#ADB5BD", "border-line-width": "1pt", "line-color": "#ADB5BD", "line-width": "1pt"},
}
SLOTS = {0: "centralTopic", 1: "mainTopic", 2: "subTopic"}

VGAP, HGAP, BRANCH_GAP, ROOT_GAP = 14, 46, 40, 110
LONG_LINE = 40  # characters per title line that start to look wide
MIN_CONTRAST = 3.0  # WCAG ratio for large / bold text; below this a title is hard to read
NUMBERING = {"numeral-arabic": "arabic", "alphabet-uppercase": "upper", "alphabet-lowercase": "lower",
             "numeral-roman": "roman"}

# ─── fonts and text ───

_fonts = {}


def _first(paths):
    return next((p for p in paths if os.path.exists(p)), None)


def _default_font(px):
    # No system font found (e.g. a minimal container): Pillow's bundled font, sized when the
    # Pillow version supports it (>= 10.1), its fixed bitmap size otherwise.
    try:
        return ImageFont.load_default(size=px)
    except TypeError:
        return ImageFont.load_default()


_scanned = {}


def _scan_font(bold):
    """Any installed sans-serif TrueType font (Linux containers rarely have the usual paths)."""
    if bold not in _scanned:
        found = []
        for d in FONT_DIRS:
            if os.path.isdir(d):
                found += glob.glob(os.path.join(d, "**", "*.tt[fc]"), recursive=True)
        def score(path):
            n = os.path.basename(path).lower()
            return (("bold" in n) != bold) * 4 + ("sans" not in n) * 2 + any(k in n for k in ("mono", "italic", "oblique", "serif")) * 3
        _scanned[bold] = min(found, key=score) if found else None
    return _scanned[bold]


def font(px, bold=False):
    key = (min(MAX_FONT_PX, max(6, round(px))), bold)
    if key not in _fonts:
        path = _first(FONT_CANDIDATES[bold]) or _scan_font(bold) or _first(FONT_CANDIDATES[False]) or _scan_font(False)
        f = None
        if path:
            try:
                f = ImageFont.truetype(path, key[0])
            except OSError:
                f = None
        _fonts[key] = f or _default_font(key[0])
    return _fonts[key]


def is_truetype(f):
    return isinstance(f, ImageFont.FreeTypeFont)


def safe_length(f, s):
    try:
        return f.getlength(s)
    except (AttributeError, UnicodeEncodeError):
        box = f.getbbox(_latin1(s)) if hasattr(f, "getbbox") else (0, 0, 6 * len(s), 10)
        return box[2] - box[0]


def _latin1(s):
    """Pillow's bitmap fallback font only has Latin-1: map other letters to their closest form (ş → s)."""
    out = []
    for ch in s:
        try:
            ch.encode("latin-1")
            out.append(ch)
        except UnicodeEncodeError:
            base = unicodedata.normalize("NFKD", ch).encode("latin-1", "ignore").decode("latin-1")
            out.append(base or {"ı": "i", "ł": "l", "đ": "d", "ø": "o", "→": "->", "—": "-", "–": "-", "…": "..."}.get(ch, "?"))
    return "".join(out)


def center_text(d, xy, s, f, fill):
    """Text centred on xy (anchor="mm" is not available for bitmap fonts)."""
    if is_truetype(f):
        d.text(xy, s, fill=fill, font=f, anchor="mm")
    else:
        s = _latin1(s)
        d.text((xy[0] - safe_length(f, s) / 2, xy[1] - font_px(f, 10) / 2), s, fill=fill, font=f)


def font_px(f, fallback=14):
    return getattr(f, "size", fallback)


_missing_mask = {}
_fallback_fonts = {}
_emoji = {"font": None, "tried": False}


def _is_emoji(ch):
    o = ord(ch)
    return 0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or o in (0x2B50, 0x2B55, 0x231B, 0x23F3)


_glyph_cache = {}


def _has_glyph(f, ch):
    key = (id(f), ch)
    hit = _glyph_cache.get(key)
    if hit is None:
        hit = _glyph_cache[key] = _has_glyph_uncached(f, ch)
    return hit


def _has_glyph_uncached(f, ch):
    # A missing glyph renders as the font's .notdef box; compare with a surely-missing codepoint.
    if ch.isspace():
        return True
    if not is_truetype(f):  # bitmap fallback font: Latin-1 only
        try:
            ch.encode("latin-1")
            return True
        except UnicodeEncodeError:
            return False
    k = id(f)
    if k not in _missing_mask:
        _missing_mask[k] = bytes(f.getmask("\U0010FFFD"))
    return bytes(f.getmask(ch)) != _missing_mask[k]


def _fallback(px, ch):
    for path in SYMBOL_FALLBACKS:
        if not os.path.exists(path):
            continue
        key = (path, round(px))
        if key not in _fallback_fonts:
            _fallback_fonts[key] = ImageFont.truetype(path, key[1])
        if _has_glyph(_fallback_fonts[key], ch):
            return _fallback_fonts[key]
    return None


def _emoji_font():
    if not _emoji["tried"]:
        _emoji["tried"] = True
        for path in EMOJI_FONTS:
            if os.path.exists(path):
                for size in (64, 109, 160, 40, 20):  # bitmap emoji fonts only load at fixed sizes
                    try:
                        _emoji["font"] = ImageFont.truetype(path, size)
                        break
                    except OSError:
                        continue
            if _emoji["font"]:
                break
    return _emoji["font"]


def runs(text, f):
    """Split text into (kind, string, font) runs: kind is 'text' or 'emoji'."""
    out = []
    for ch in text:
        if ch in "\ufe0e\ufe0f\u200d":  # variation selectors / zero-width joiner: not drawn
            continue
        if _is_emoji(ch) and not _has_glyph(f, ch) and _emoji_font():
            out.append(("emoji", ch, _emoji_font()))
            continue
        use = f
        if not _has_glyph(f, ch):
            use = _fallback(font_px(f), ch) or f
            if not is_truetype(use):
                ch = _latin1(ch)
        if out and out[-1][0] == "text" and out[-1][2] is use:
            out[-1] = ("text", out[-1][1] + ch, use)
        else:
            out.append(("text", ch, use))
    return out


_width_cache = {}


def text_width(text, f):
    if len(text) > 256:  # long strings aren't worth caching (and would fill memory)
        return _text_width(text, f)
    key = (id(f), text)
    if key not in _width_cache:
        _width_cache[key] = _text_width(text, f)
    return _width_cache[key]


def _text_width(text, f):
    w = 0
    for kind, s, use in runs(text, f):
        w += font_px(f) * 1.15 if kind == "emoji" else safe_length(use, s)
    return w


def draw_text(img, d, xy, text, f, color):
    x, y = xy
    for kind, s, use in runs(text, f):
        if kind == "emoji":
            size = max(1, int(font_px(f) * 1.1))
            tmp = Image.new("RGBA", (use.size * 2, use.size * 2), (0, 0, 0, 0))
            ImageDraw.Draw(tmp).text((0, 0), s, font=use, embedded_color=True)
            bbox = tmp.getbbox()
            if bbox:
                tmp = tmp.crop(bbox).resize((size, size), Image.LANCZOS)
                img.paste(tmp, (int(x), int(y + font_px(f) * 0.05)), tmp)
            x += font_px(f) * 1.15
        else:
            d.text((x, y), s, fill=color, font=use)
            x += safe_length(use, s)


MAX_WRAP_CHARS, MAX_WRAP_LINES = 4000, 60


def wrap(text, f, width):
    """Greedy word wrap of one line to `width` px (used for customWidth and boundary titles).

    Widths are added up word by word (linear in the text), and very long text is cut: a preview only
    needs to show that a title is too long."""
    if len(text) > MAX_WRAP_CHARS:
        text = text[:MAX_WRAP_CHARS] + "…"
    space = text_width(" ", f)
    lines, cur, cur_w = [], [], 0.0
    for w in text.split(" "):
        ww = text_width(w, f)
        if cur and cur_w + space + ww > width:
            lines.append(" ".join(cur))
            if len(lines) >= MAX_WRAP_LINES:
                lines[-1] += " …"
                return lines
            cur, cur_w = [w], ww
        else:
            cur_w += (space if cur else 0) + ww
            cur.append(w)
    lines.append(" ".join(cur))
    return lines

# ─── values ───


def pt(v, default):
    if v is None:
        return default
    s = str(v)
    try:
        return float(s[:-2]) * PT if s.endswith("pt") else float(s.rstrip("px"))
    except ValueError:
        return default


def kids(t):
    return [] if t.get("branch") == "folded" else (t.get("children") or {}).get("attached", [])


def all_kids(t):
    return (t.get("children") or {}).get("attached", [])


def hexc(s, default="#FFFFFF"):
    if not s or s in ("none", "transparent", "inherited"):
        return None
    s = s.lstrip("#")
    if len(s) in (4, 8):  # #RGBA / #RRGGBBAA: alpha is ignored in the preview
        s = s[:len(s) * 3 // 4]
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return hexc(default)


def contrast(a, b):
    """WCAG contrast ratio of two RGB tuples."""
    def lum(c):
        ch = [v / 255 for v in c]
        ch = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in ch]
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def roman(n):
    out = ""
    for v, s in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"),
                 (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out, n = out + s, n - v
    return out


def number_text(pattern, i):
    kind = NUMBERING.get(pattern, "arabic")
    if kind == "upper":
        return chr(65 + i % 26)
    if kind == "lower":
        return chr(97 + i % 26)
    if kind == "roman":
        return roman(i + 1)
    return str(i + 1)


def ext(t, provider):
    return next((e for e in t.get("extensions") or [] if e.get("provider") == provider), None)


def bezier(p0, c, p1, n=40):
    return [((1 - u) ** 2 * p0[0] + 2 * u * (1 - u) * c[0] + u * u * p1[0],
             (1 - u) ** 2 * p0[1] + 2 * u * (1 - u) * c[1] + u * u * p1[1]) for u in [i / n for i in range(n + 1)]]


def dashed(d, pts, col, lw, pattern="dash"):
    step = 1 if pattern in (None, "solid", "handdrawn-solid") else 2
    for i in range(0, len(pts) - 1, step):
        d.line([pts[i], pts[i + 1]], fill=col, width=lw)


class Sheet:
    def __init__(self, sheet, zf):
        self.sheet = sheet
        self.zf = zf
        self.theme = sheet.get("theme") or {}
        self.warnings = []
        self.summaries = []   # (parent, summary obj, summary topic)
        self.boundaries = []  # (parent, boundary obj)
        self.used_markers = []

    def warn(self, msg):
        self.warnings.append(msg)

    # ── measuring ──

    def props(self, t, depth, slot_name=None):
        base = dict(DEFAULTS[min(depth, 2)])
        slot = self.theme.get(slot_name or SLOTS[min(depth, 2)]) or {}
        base.update(slot.get("properties") or {})
        base.update((t.get("style") or {}).get("properties") or {})
        return base

    def measure(self, t, depth, slot_name=None, prefix=""):
        p = self.props(t, depth, slot_name)
        t["_p"] = p
        px = pt(p.get("fo:font-size"), 14 * PT)
        bold = p.get("fo:font-weight") in ("bold", "600", "700", "800", "900")
        f = font(px, bold)
        t["_bold"] = bold
        title = t.get("title") or ""
        task = (ext(t, "org.xmind.ui.task") or {}).get("content") or {}
        if task.get("status") in ("done", "todo"):
            prefix = ("☑ " if task["status"] == "done" else "☐ ") + prefix
        if p.get("fo:text-transform") == "uppercase":
            title = title.upper()
        elif p.get("fo:text-transform") == "lowercase":
            title = title.lower()
        elif p.get("fo:text-transform") == "capitalize":
            title = title.title()
        lines = (prefix + title).split("\n")
        if t.get("customWidth"):
            cw = float(t["customWidth"])
            lines = [w for line in lines for w in wrap(line, f, cw)]
        for line in lines:
            if len(line) > LONG_LINE and not t.get("customWidth"):
                self.warn(f"long title line ({len(line)} chars): {line[:50]}…")
        fill, text = hexc(p.get("svg:fill")), hexc(p.get("fo:color"), "#1E1E1E")
        if fill and text and p.get("fill-pattern") != "none" and contrast(fill, text) < MIN_CONTRAST:
            self.warn(f"low text contrast ({contrast(fill, text):.1f}:1): {(t.get('title') or '')[:30]!r}")
        eq = (ext(t, "org.xmind.ui.mathJax") or {}).get("content") or {}
        if not title.strip() and not t.get("image") and not eq.get("content") and depth > 0:
            self.warn("empty topic (no title, no image)")
        lh = px * 1.3
        padx, pady = px * 0.9, px * 0.55
        w = max([text_width(l, f) for l in lines] or [0]) + 2 * padx
        h = (lh * len(lines) if any(lines) else 0) + 2 * pady
        t.update(_f=f, _lines=lines, _lh=lh, _padx=padx, _pady=pady)
        extra = 0
        if t.get("labels"):
            extra += 22
            w = max(w, sum(safe_length(font(12), l) + 22 for l in t["labels"]) + 2 * padx)
        if t.get("markers"):
            w += 22 * len(t["markers"])
            self.used_markers.extend(m.get("markerId") for m in t["markers"] if isinstance(m, dict))
        if ext(t, "org.xmind.ui.audionotes"):
            w += 22
        img = t.get("image")
        if isinstance(img, dict) and img.get("src"):
            # One size for measuring and drawing, bounded (a picture in XMind is at most a few
            # thousand px): a missing or absurd width / height can't make the drawing huge.
            def dim(v):
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    return 100.0
                return min(max(v, 8.0), 2000.0) if math.isfinite(v) else 100.0
            img = t["image"] = {**img, "width": dim(img.get("width")), "height": dim(img.get("height"))}
        if img and img.get("width"):
            align = img.get("align", "top")
            if align in ("left", "right"):
                w += img["width"] + padx
                h = max(h, img.get("height", 0) + 2 * pady)
            else:
                w = max(w, img["width"] + 2 * padx)
                extra += img.get("height", 0) + pady
        t["_w"], t["_h"] = w, h + extra
        if t.get("branch") == "folded" and all_kids(t):
            t["_w"] += 26
            self.warn(f"folded branch hides {self.count(t) - 1} topic(s): {(t.get('title') or '')[:30]!r}")
        for c in (t.get("children") or {}).get("callout", []):
            c["_f"] = font(12)
            c["_cw"] = text_width(c.get("title") or "", c["_f"]) + 16
        numbering = None
        ks = kids(t)
        for i, c in enumerate(ks):
            num = (ext(c, "org.xmind.ui.numbering") or {}).get("content") or {}
            cp = ""
            if num.get("pattern"):
                cp = number_text(num["pattern"], i)
                if num.get("tiered") and prefix:
                    cp = prefix.strip().rstrip(".") + "." + cp
                cp += ". "
            self.measure(c, depth + 1, prefix=cp)
        for b in t.get("boundaries") or []:
            self.boundaries.append((t, b))
        for s in t.get("summaries") or []:
            st = next((x for x in (t.get("children") or {}).get("summary", []) if x.get("id") == s.get("topicId")), None)
            if st is None:
                self.warn(f"summary on {(t.get('title') or '')[:30]!r} has no summary topic (XMind won't show it)")
                continue
            self.measure(st, 2, "summaryTopic")
            self.summaries.append((t, s, st))
        return numbering

    def count(self, t):
        return 1 + sum(self.count(c) for c in all_kids(t))

    def sub_h(self, t):
        ks = kids(t)
        tot = sum(self.sub_h(c) for c in ks) + VGAP * (len(ks) - 1) if ks else 0
        t["_sh"] = max(t["_h"], tot)
        return t["_sh"]

    def sub_w(self, t, gap=24):
        ks = kids(t)
        tot = sum(self.sub_w(c, gap) for c in ks) + gap * (len(ks) - 1) if ks else 0
        t["_sw"] = max(t["_w"], tot)
        return t["_sw"]

    # ── layouts ──

    def place_logic(self, t, x, ytop, side):
        t["_y"] = ytop + (t["_sh"] - t["_h"]) / 2
        t["_x"] = x if side > 0 else x - t["_w"]
        t["_side"] = side
        ks = kids(t)
        if ks:
            tot = sum(c["_sh"] for c in ks) + VGAP * (len(ks) - 1)
            y = ytop + (t["_sh"] - tot) / 2
            nx = t["_x"] + t["_w"] + HGAP if side > 0 else t["_x"] - HGAP
            for c in ks:
                self.place_logic(c, nx, y, side)
                y += c["_sh"] + VGAP

    def place_org(self, t, cx, y, direction, gap=24, vgap=56):
        t["_x"], t["_y"], t["_side"], t["_dir"] = cx - t["_w"] / 2, y, 1, direction
        ks = kids(t)
        if ks:
            tot = sum(c["_sw"] for c in ks) + gap * (len(ks) - 1)
            x = cx - tot / 2
            ny = y + (t["_h"] + vgap if direction > 0 else -vgap)
            for c in ks:
                cy = ny if direction > 0 else ny - c["_h"]
                self.place_org(c, x + c["_sw"] / 2, cy, direction, gap, vgap)
                x += c["_sw"] + gap

    def place_tree(self, t, x, y, side, indent=34):
        t["_x"] = x if side > 0 else x - t["_w"]
        t["_y"], t["_side"], t["_tree"] = y, side, True
        y += t["_h"] + VGAP
        for c in kids(t):
            y = self.place_tree(c, x + indent * side, y, side)
        return y

    def place_table(self, t, x, y, colw, depth=0):
        """Tree table: a column per depth; a topic's cell spans its children's rows."""
        ks = kids(t)
        if not ks:
            t["_x"], t["_y"], t["_cell"] = x, y, (colw[depth], t["_h"] + 12)
            return t["_h"] + 12
        hy = y
        for c in ks:
            hy += self.place_table(c, x + colw[depth], hy, colw, depth + 1)
        t["_x"], t["_y"], t["_cell"] = x, y, (colw[depth], hy - y)
        return hy - y

    def layout(self):
        root = self.sheet["rootTopic"]
        self.measure(root, 0)
        sc = root.get("structureClass") or "org.xmind.ui.map.unbalanced"
        kind = sc.replace("org.xmind.ui.", "")
        self.kind = kind
        ks = kids(root)
        for c in ks:
            self.sub_h(c)
        root["_x"], root["_y"] = -root["_w"] / 2, -root["_h"] / 2
        if kind.startswith("map"):
            nr = math.ceil(len(ks) / 2)
            groups = [(1, ks[:nr]), (-1, list(reversed(ks[nr:])))]
            if "anticlockwise" in kind:
                groups = [(-1, ks[:nr]), (1, list(reversed(ks[nr:])))]
            self._side_groups(root, groups)
        elif kind.startswith(("logic", "brace")) or kind in ("grid",):
            self._side_groups(root, [(-1 if kind.endswith("left") else 1, ks)])
        elif kind.startswith("org-chart"):
            direction = -1 if kind.endswith("up") else 1
            self.sub_w(root)
            self.place_org(root, 0, -root["_h"] / 2, direction)
        elif kind.startswith("tree") and not kind.startswith("treetable"):
            side = -1 if ".left" in kind else 1
            self.place_tree(root, -root["_w"] / 2 if side > 0 else root["_w"] / 2, -root["_h"] / 2, side)
        elif kind.startswith("timeline"):
            self._timeline(root, ks, vertical="vertical" in kind)
        elif kind.startswith("fishbone"):
            self._fishbone(root, ks, head_left="leftHeaded" in kind)
        elif kind.startswith("treetable") or kind.startswith("spreadsheet"):
            if kind.startswith("spreadsheet"):
                self._matrix(root)
            else:
                depth_w = {}

                def widths(t, dpt):
                    depth_w[dpt] = max(depth_w.get(dpt, 0), t["_w"] + 16)
                    for c in kids(t):
                        widths(c, dpt + 1)
                widths(root, 0)
                colw = [depth_w[i] for i in range(len(depth_w))]
                self.place_table(root, -sum(colw) / 2, -root["_h"], colw)
        else:
            self.warn(f"layout {kind} drawn as logic.right")
            self._side_groups(root, [(1, ks)])
        # Matrices inside the map (a topic with the spreadsheet structure below the root)
        nodes = []

        def collect(t):
            if "_x" not in t:  # e.g. children of matrix cells, which the preview doesn't draw
                return
            nodes.append(t)
            for c in kids(t):
                collect(c)
        collect(root)
        for i, dt in enumerate((root.get("children") or {}).get("detached", [])):
            self.measure(dt, 1, "floatingTopic")
            self.sub_h(dt)
            pos = dt.get("position") or {"x": 0, "y": 200 + 80 * i}
            self.place_logic(dt, pos["x"] - dt["_w"] / 2, pos["y"] - dt["_sh"] / 2, 1)
            collect(dt)
        # summaries: bracket beside the summarised children, summary topic beyond it
        for parent, s, st in self.summaries:
            box = self.range_box(parent, s.get("range"))
            if not box:
                continue
            side = parent.get("_side", 1)
            x0, y0, x1, y1 = box
            bx = x1 + 12 if side > 0 else x0 - 12
            st["_bracket"] = (bx, y0, y1, side)
            st["_x"] = bx + 26 if side > 0 else bx - 26 - st["_w"]
            st["_y"] = (y0 + y1) / 2 - st["_h"] / 2
            st["_side"] = side
            nodes.append(st)
        return root, nodes

    def _side_groups(self, root, groups):
        for side, group in groups:
            if not group:
                continue
            H = sum(c["_sh"] for c in group) + BRANCH_GAP * (len(group) - 1)
            y = -H / 2
            x = (root["_w"] / 2 + ROOT_GAP) * side
            for c in group:
                self.place_logic(c, x, y, side)
                y += c["_sh"] + BRANCH_GAP

    def _timeline(self, root, ks, vertical):
        if vertical:
            self.warn("vertical timeline drawn as a horizontal one")
        x = root["_w"] / 2 + 60
        root["_spine"] = True
        for i, c in enumerate(ks):
            up = i % 2 == 0
            c["_x"], c["_y"], c["_side"] = x, -c["_h"] / 2, 1
            y = -c["_h"] / 2 - 30 if up else c["_h"] / 2 + 30
            sub = kids(c)
            if up:
                y -= sum(s["_sh"] for s in sub) + VGAP * max(0, len(sub) - 1)
            for s in sub:
                self.place_logic(s, x + 24, y, 1)
                y += s["_sh"] + VGAP
            c["_timeline_up"] = up
            x += max([c["_w"]] + [s["_w"] + 24 for s in sub]) + 40

    def _fishbone(self, root, ks, head_left):
        self.warn("fishbone drawn approximately (bones as straight branches)")
        side = 1 if head_left else -1
        root["_x"] = -root["_w"] / 2
        root["_fish"] = side
        x = (root["_w"] / 2 + 80) * side
        for i, c in enumerate(ks):
            up = i % 2 == 0
            sub = kids(c)
            span = sum(s["_sh"] for s in sub) + VGAP * max(0, len(sub) - 1)
            cy = -150 - c["_h"] if up else 150
            c["_x"] = x if side > 0 else x - c["_w"]
            c["_y"], c["_side"], c["_bone"] = cy, side, (x + 60 * side, 0)
            y = cy + c["_h"] + 10 if up else cy - span - 10 if sub else cy
            if not up:
                y = cy + c["_h"] + 10
            for s in sub:
                self.place_logic(s, c["_x"] + 20 if side > 0 else c["_x"] + c["_w"] - 20, y, side)
                y += s["_sh"] + VGAP
            x += (max([c["_w"]] + [s["_w"] + 20 for s in sub]) + 50) * (1 if i % 2 else 0) * side
        root["_spine_end"] = x + 120 * side

    def _matrix(self, root):
        cols_ext = (ext(root, "org.xmind.ui.spreadsheet") or {}).get("content") or []
        cols = next((c.get("content") for c in cols_ext if c.get("name") == "columns"), None) or []
        columns = [c.get("content") for c in cols]
        rows = kids(root)
        if not columns:
            self.warn("matrix without columns drawn as logic.right")
            self._side_groups(root, [(1, rows)])
            return
        if any(not set(k.get("labels") or []) & set(columns) for r in rows for k in kids(r)):
            self.warn("matrix cells without a column label are shown in a \"—\" column")
            columns = columns + ["—"]
            for r in rows:
                for k in kids(r):
                    if not set(k.get("labels") or []) & set(columns):
                        k["labels"] = list(k.get("labels") or []) + ["—"]
        f = font(14, True)
        colw = {c: text_width(c, f) + 30 for c in columns}
        rowh, rowtitle_w = [], max([r["_w"] for r in rows] + [80]) + 16
        grid = []
        for r in rows:
            cells = {c: [k for k in kids(r) if c in (k.get("labels") or [])] for c in columns}
            for c, lst in cells.items():
                for k in lst:
                    colw[c] = max(colw[c], k["_w"] + 20)
            hgt = max([r["_h"]] + [sum(k["_h"] + 6 for k in lst) for lst in cells.values()]) + 16
            rowh.append(hgt)
            grid.append((r, cells))
        total_w = rowtitle_w + sum(colw.values())
        root["_x"], root["_y"] = -total_w / 2, -root["_h"] - 50
        x0, y = -total_w / 2, -10
        self.matrix = {"x": x0, "y": y, "colw": colw, "columns": columns, "rowtitle_w": rowtitle_w, "rows": []}
        for (r, cells), hgt in zip(grid, rowh):
            r["_x"], r["_y"], r["_side"], r["_cellonly"] = x0 + 8, y + (hgt - r["_h"]) / 2, 1, True
            cx = x0 + rowtitle_w
            for c in columns:
                cy = y + 8
                for k in cells[c]:
                    k["_x"], k["_y"], k["_side"], k["_cellonly"] = cx + 10, cy, 1, True
                    k["_p"] = dict(k["_p"])
                    cy += k["_h"] + 6
                cx += colw[c]
            self.matrix["rows"].append((y, hgt))
            y += hgt
        self.matrix["h"] = y - self.matrix["y"]

    def range_box(self, parent, rng):
        ks = kids(parent)
        if not ks:
            return None
        if rng == "master":
            members, include_parent = ks, True
        else:
            m = re.match(r"^\((\d+),(\d+)\)$", str(rng or ""))
            if not m:
                return None
            members, include_parent = ks[int(m.group(1)):int(m.group(2)) + 1], False
        pts = []

        def add(t):
            if "_x" in t:
                pts.append((t["_x"], t["_y"], t["_x"] + t["_w"], t["_y"] + t["_h"]))
            for c in kids(t):
                add(c)
        for t in members:
            add(t)
        if include_parent and "_x" in parent:
            pts.append((parent["_x"], parent["_y"], parent["_x"] + parent["_w"], parent["_y"] + parent["_h"]))
        if not pts:
            return None
        return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[2] for p in pts), max(p[3] for p in pts))

    def resource(self, src):
        name = src[4:] if src.startswith("xap:") else src
        try:
            data = self.zf.read(name)
        except KeyError:
            self.warn(f"image resource missing: {name}")
            return None
        if name.lower().endswith(".svg"):
            return "svg"
        try:
            return Image.open(io.BytesIO(data), formats=IMAGE_FORMATS).convert("RGBA")
        except Image.DecompressionBombError:
            self.warn(f"image too large to draw: {name}")
            return None
        except (OSError, ValueError):
            self.warn(f"image can't be decoded: {name}")
            return None

    # ── drawing ──

    def render(self, scale):
        root, nodes = self.layout()
        rects = [(n["_x"], n["_y"], n["_x"] + (n["_cell"][0] if "_cell" in n else n["_w"]),
                  n["_y"] + (n["_cell"][1] if "_cell" in n else n["_h"])) for n in nodes]
        for parent, b in self.boundaries:
            bx = self.range_box(parent, b.get("range"))
            if bx:
                rects.append((bx[0] - 14, bx[1] - 40, bx[2] + 14, bx[3] + 14))
        if getattr(self, "matrix", None):
            m = self.matrix
            rects.append((m["x"], m["y"], m["x"] + m["rowtitle_w"] + sum(m["colw"].values()), m["y"] + m["h"]))
        minx = min(r[0] for r in rects) - 60
        maxx = max(r[2] for r in rects) + 60
        miny = min(r[1] for r in rects) - 100
        maxy = max(r[3] for r in rects) + 80
        S = scale
        W, H = int((maxx - minx) * S), int((maxy - miny) * S)
        # Bounded in area and on each side (a topic far off in one direction would otherwise make a
        # drawing millions of pixels wide and one pixel high).
        side = max(W, H, 1)
        if W * H > MAX_CANVAS_PIXELS or side > MAX_CANVAS_SIDE:
            S *= min(math.sqrt(MAX_CANVAS_PIXELS / max(W * H, 1)), MAX_CANVAS_SIDE / side)
            W, H = int((maxx - minx) * S), int((maxy - miny) * S)
            self.warn("map is very large (or a topic is placed far away) — drawn at a reduced scale")
        W, H = min(max(W, 1), MAX_CANVAS_SIDE), min(max(H, 1), MAX_CANVAS_SIDE)
        map_props = (self.theme.get("map") or {}).get("properties") or {}
        sheet_fill = ((self.sheet.get("style") or {}).get("properties") or {}).get("svg:fill")
        bg = hexc(sheet_fill or map_props.get("svg:fill"), "#FFFFFF") or (255, 255, 255)
        img = Image.new("RGB", (max(W, 1), max(H, 1)), bg)
        d = ImageDraw.Draw(img)
        dark_bg = sum(bg) < 382
        ink = (173, 181, 189) if dark_bg else (134, 142, 150)

        def P(x, y):
            return ((x - minx) * S, (y - miny) * S)

        self._texture(d, img, bg, dark_bg)
        draw_text(img, d, P(minx + 70, miny + 25), self.sheet.get("title", ""), font(30 * S, True),
                  "#ADB5BD" if dark_bg else "#868E96")

        branch_colors = [hexc(c) for c in (map_props.get("multi-line-colors") or "").split() if hexc(c)]

        # boundaries (behind everything)
        for parent, b in self.boundaries:
            bx = self.range_box(parent, b.get("range"))
            if not bx:
                continue
            bp = {**((self.theme.get("boundary") or {}).get("properties") or {}),
                  **((b.get("style") or {}).get("properties") or {})}
            col = hexc(bp.get("line-color"), "#868E96") or ink
            fill = hexc(bp.get("svg:fill"), "#F1F3F5")
            x0, y0 = P(bx[0] - 10, bx[1] - 10)
            x1, y1 = P(bx[2] + 10, bx[3] + 10)
            d.rounded_rectangle([x0, y0, x1, y1], radius=10 * S, fill=fill, outline=None)
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
            seg = []
            for (ax, ay), (cx, cy) in zip(pts, pts[1:]):
                n = max(2, int(math.hypot(cx - ax, cy - ay) / (6 * S)))
                seg += [(ax + (cx - ax) * k / n, ay + (cy - ay) * k / n) for k in range(n + 1)]
            dashed(d, seg, col, max(1, int(1.5 * S)), "dash")
            if b.get("title"):
                tf = font(12 * S, True)
                tw = text_width(b["title"], tf) / S
                inner = bx[2] - bx[0] + 20
                if tw > inner:
                    self.warn(f"boundary title {b['title'][:25]!r} is wider than its boundary — XMind wraps it "
                              "to the boundary width (one letter per line on narrow groups)")
                d.rounded_rectangle([x0, y0 - 18 * S, x0 + (tw + 12) * S, y0], radius=4 * S, fill=col)
                draw_text(img, d, (x0 + 6 * S, y0 - 16 * S), b["title"], tf, "#FFFFFF")

        if getattr(self, "matrix", None):
            self._draw_matrix(d, img, P, S, ink)

        # connectors
        def color_for(c, t):
            if branch_colors and t is root:
                idx = kids(root).index(c) if c in kids(root) else 0
                return branch_colors[idx % len(branch_colors)]
            if branch_colors and "_bc" in t:
                return t["_bc"]
            return hexc(t["_p"].get("line-color"), "#868E96") or ink

        def edges(t):
            for c in kids(t):
                if c.get("_cellonly") or "_cell" in t or "_timeline_up" in t:
                    edges(c)
                    continue
                col = color_for(c, t)
                if branch_colors:
                    c["_bc"] = col
                p = t["_p"]
                lw = max(1, int(pt(p.get("line-width"), 1.5 * PT) * S))
                if t.get("_dir"):  # org chart
                    down = t["_dir"] > 0
                    x1, y1 = t["_x"] + t["_w"] / 2, t["_y"] + (t["_h"] if down else 0)
                    x2, y2 = c["_x"] + c["_w"] / 2, c["_y"] + (0 if down else c["_h"])
                    my = (y1 + y2) / 2
                    d.line([P(x1, y1), P(x1, my), P(x2, my), P(x2, y2)], fill=col, width=lw, joint="curve")
                elif c.get("_tree") or t.get("_tree"):
                    side = c["_side"]
                    x1 = t["_x"] + (14 if side > 0 else t["_w"] - 14)
                    y1 = t["_y"] + t["_h"]
                    x2, y2 = (c["_x"] if side > 0 else c["_x"] + c["_w"]), c["_y"] + c["_h"] / 2
                    d.line([P(x1, y1), P(x1, y2), P(x2, y2)], fill=col, width=lw)
                elif t.get("_spine"):  # timeline main topics hang off the spine
                    pass
                elif "_bone" in c:
                    bx, by = c["_bone"]
                    up = c["_y"] < 0
                    cx = c["_x"] + c["_w"] / 2
                    d.line([P(cx, c["_y"] + (c["_h"] if up else 0)), P(bx, by)], fill=col, width=lw)
                else:
                    side = c["_side"]
                    x2 = c["_x"] if side > 0 else c["_x"] + c["_w"]
                    y2 = c["_y"] + c["_h"] / 2
                    if t is root and not root.get("_fish"):
                        x1, y1 = (t["_x"] + t["_w"] if side > 0 else t["_x"]), 0
                        pts = [P(x1 + (x2 - x1) * u, y1 + (y2 - y1) * (3 * u * u - 2 * u * u * u))
                               for u in [i / 24 for i in range(25)]]
                        d.line(pts, fill=col, width=lw, joint="curve")
                    else:
                        x1 = t["_x"] + t["_w"] if side > 0 else t["_x"]
                        y1 = t["_y"] + t["_h"] / 2
                        if self.kind.startswith("brace") and t is not root:
                            pass
                        mx = x1 + (HGAP / 2) * side
                        if self.kind.startswith("brace"):
                            ks2 = kids(t)
                            top = ks2[0]["_y"] + ks2[0]["_h"] / 2
                            bot = ks2[-1]["_y"] + ks2[-1]["_h"] / 2
                            if c is ks2[0]:
                                self._brace(d, P, mx, top, bot, (x1, y1), side, col, lw)
                            d.line([P(mx + 6 * side, y2), P(x2, y2)], fill=col, width=lw)
                        else:
                            d.line([P(x1, y1), P(mx, y1), P(mx, y2), P(x2, y2)], fill=col, width=lw, joint="curve")
                edges(c)
        edges(root)
        if root.get("_spine"):
            ks = kids(root)
            if ks:
                lw = max(1, int(3 * S))
                end = max(c["_x"] + c["_w"] for c in ks) + 40
                d.line([P(root["_x"] + root["_w"], 0), P(end, 0)], fill=ink, width=lw)
                for c in ks:
                    for s in kids(c):
                        sx = c["_x"] + 12
                        d.line([P(sx, c["_y"] + (0 if c["_timeline_up"] else c["_h"])),
                                P(sx, s["_y"] + s["_h"] / 2), P(s["_x"], s["_y"] + s["_h"] / 2)], fill=ink,
                               width=max(1, int(1.5 * S)))
        if root.get("_fish"):
            side = root["_fish"]
            start = root["_x"] + root["_w"] if side > 0 else root["_x"]
            d.line([P(start, 0), P(root["_spine_end"], 0)], fill=ink, width=max(1, int(4 * S)))

        # summary brackets
        for parent, s, st in self.summaries:
            if "_bracket" not in st:
                continue
            bx, y0, y1, side = st["_bracket"]
            sp = {**((self.theme.get("summary") or {}).get("properties") or {}),
                  **((s.get("style") or {}).get("properties") or {})}
            col = hexc(sp.get("line-color"), "#868E96") or ink
            lw = max(1, int(1.5 * S))
            mid = (y0 + y1) / 2
            pts = bezier(P(bx, y0), P(bx + 14 * side, y0), P(bx + 14 * side, mid), 12) + \
                bezier(P(bx + 14 * side, mid), P(bx + 14 * side, y1), P(bx, y1), 12)
            d.line(pts, fill=col, width=lw)
            d.line([P(bx + 14 * side, mid), P(st["_x"] if side > 0 else st["_x"] + st["_w"], mid)], fill=col, width=lw)

        for n in nodes:
            self._node(d, img, n, P, S)

        self._relationships(d, img, root, nodes, P, S, bg)
        self._watermark(img, S)
        self._legend(d, img, P, S, maxx, maxy, dark_bg)

        boxes = [(n["_x"], n["_y"], n["_x"] + n["_w"], n["_y"] + n["_h"], n.get("title", "")) for n in nodes
                 if not n.get("_cellonly") and "_cell" not in n]
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] < b[2] - 2 and b[0] < a[2] - 2 and a[1] < b[3] - 2 and b[1] < a[3] - 2:
                    self.warn(f"overlap: {(a[4] or '')[:30]!r} × {(b[4] or '')[:30]!r}")
        return img

    def _brace(self, d, P, x, top, bot, origin, side, col, lw):
        mid = (top + bot) / 2
        pts = bezier(P(x + 6 * side, top), P(x, top), P(x, mid - 8), 10) + [P(x - 6 * side, mid)] + \
            bezier(P(x, mid + 8), P(x, bot), P(x + 6 * side, bot), 10)
        d.line(pts, fill=col, width=lw)
        d.line([P(*origin), P(x - 6 * side, mid)], fill=col, width=lw)

    def _node(self, d, img, n, P, S):
        p = n["_p"]
        if "_cell" in n:  # tree table: the topic is a table cell spanning its children's rows
            cw, chh = n["_cell"]
            x0, y0 = P(n["_x"], n["_y"])
            fill = hexc(p.get("svg:fill"), "#FFFFFF") or (255, 255, 255)
            d.rectangle([x0, y0, x0 + cw * S, y0 + chh * S], fill=fill, outline="#495057", width=max(1, int(S)))
            f = font(font_px(n["_f"]) * S, n["_bold"])
            color = p.get("fo:color") if p.get("fo:color") not in (None, "inherited") else "#1E1E1E"
            ty = n["_y"] + (chh - n["_lh"] * len(n["_lines"])) / 2
            for line in n["_lines"]:
                draw_text(img, d, P(n["_x"] + (cw - text_width(line, n["_f"])) / 2, ty), line, f, color)
                ty += n["_lh"]
            return
        fill = hexc(p.get("svg:fill"))
        if p.get("fill-pattern") == "none":
            fill = None
        border = hexc(p.get("border-line-color"), "#868E96")
        bw = pt(p.get("border-line-width"), 1)
        x0, y0 = P(n["_x"], n["_y"])
        x1, y1 = P(n["_x"] + n["_w"], n["_y"] + n["_h"])
        shape = p.get("shape-class", "")
        if "diamond" in shape:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            d.polygon([(cx, y0), (x1, cy), (cx, y1), (x0, cy)], fill=fill, outline=border)
        elif "ellipse" in shape or "circle" in shape:
            d.ellipse([x0, y0, x1, y1], fill=fill, outline=border, width=max(1, int(bw * S)))
        elif "underline" in shape:
            if fill and p.get("fill-pattern") != "none" and "svg:fill" in ((n.get("style") or {}).get("properties") or {}):
                d.rectangle([x0, y0, x1, y1], fill=fill)
            d.line([(x0, y1), (x1, y1)], fill=n.get("_bc") or border or (73, 80, 87), width=max(1, int(2 * S)))
        elif "parallelogram" in shape:
            k = (y1 - y0) * 0.3
            d.polygon([(x0 + k, y0), (x1, y0), (x1 - k, y1), (x0, y1)], fill=fill, outline=border)
        elif "hexagon" in shape:
            k = (y1 - y0) * 0.35
            d.polygon([(x0 + k, y0), (x1 - k, y0), (x1, (y0 + y1) / 2), (x1 - k, y1), (x0 + k, y1), (x0, (y0 + y1) / 2)],
                      fill=fill, outline=border)
        elif "rect" == shape.split(".")[-1]:
            d.rectangle([x0, y0, x1, y1], fill=fill, outline=border if bw > 0 else None,
                        width=max(1, int(bw * S)) if bw > 0 else 0)
        else:
            d.rounded_rectangle([x0, y0, x1, y1], radius=8 * S, fill=fill,
                                outline=border if bw > 0 else None,
                                width=max(1, int(bw * S)) if bw > 0 else 0)
        f = n["_f"]
        fs = font(font_px(f) * S, n["_bold"])
        color = p.get("fo:color") if p.get("fo:color") not in (None, "inherited") else "#1E1E1E"
        img_spec = n.get("image") or {}
        align = img_spec.get("align", "top")
        mk = 22 * len(n.get("markers") or []) + (22 if ext(n, "org.xmind.ui.audionotes") else 0)
        left_img = img_spec.get("width", 0) + n["_padx"] if img_spec.get("src") and align == "left" else 0
        ty = n["_y"] + n["_pady"]
        if img_spec.get("src") and align == "top":
            ty += img_spec.get("height", 0) + n["_pady"]
        text_w = n["_w"] - mk - (img_spec.get("width", 0) + n["_padx"] if img_spec.get("src") and align in ("left", "right") else 0)
        for line in n["_lines"]:
            lw = text_width(line, f)
            tx = n["_x"] + mk + left_img + (text_w - lw) / 2
            draw_text(img, d, P(tx, ty), line, fs, color)
            deco = p.get("fo:text-decoration") or ""
            if "underline" in deco:
                d.line([P(tx, ty + n["_lh"] * 0.85), P(tx + lw, ty + n["_lh"] * 0.85)], fill=color, width=max(1, int(S)))
            if "line-through" in deco:
                d.line([P(tx, ty + n["_lh"] * 0.45), P(tx + lw, ty + n["_lh"] * 0.45)], fill=color, width=max(1, int(S)))
            ty += n["_lh"]
        for i, m in enumerate(n.get("markers") or []):
            mid = m.get("markerId", "") if isinstance(m, dict) else str(m)
            c = {"task": "#2F9E44", "priority": "#E03131", "flag": "#F08C00", "star": "#FAB005"}.get(mid.split("-")[0], "#1971C2")
            mx0, my0 = P(n["_x"] + n["_padx"] / 2 + i * 22, n["_y"] + n["_h"] / 2 - 9)
            d.ellipse([mx0, my0, mx0 + 18 * S, my0 + 18 * S], fill=c)
            center_text(d, (mx0 + 9 * S, my0 + 9 * S), mid.split("-")[-1][:2], font(10 * S, True), "#FFFFFF")
        if ext(n, "org.xmind.ui.audionotes"):
            ax, ay = P(n["_x"] + n["_padx"] / 2 + len(n.get("markers") or []) * 22, n["_y"] + n["_h"] / 2 - 9)
            d.polygon([(ax, ay + 6 * S), (ax + 6 * S, ay + 6 * S), (ax + 12 * S, ay), (ax + 12 * S, ay + 18 * S),
                       (ax + 6 * S, ay + 12 * S), (ax, ay + 12 * S)], fill="#7048E8")
        if n.get("labels"):
            lx = n["_x"] + n["_padx"]
            lf = font(12 * S)
            for lab in n["labels"]:
                lw = safe_length(font(12), lab)
                d.rounded_rectangle([*P(lx, ty + 1), *P(lx + lw + 14, ty + 19)], radius=8 * S, fill="#FFFFFF", outline="#868E96")
                draw_text(img, d, P(lx + 7, ty + 3), lab, lf, "#495057")
                lx += lw + 22
        if img_spec.get("src"):
            iw, ih = img_spec.get("width", 100), img_spec.get("height", 100)
            if align == "left":
                px0, py0 = n["_x"] + n["_padx"] / 2 + mk, n["_y"] + (n["_h"] - ih) / 2
            elif align == "right":
                px0, py0 = n["_x"] + n["_w"] - iw - n["_padx"] / 2, n["_y"] + (n["_h"] - ih) / 2
            elif align == "bottom":
                px0, py0 = n["_x"] + (n["_w"] - iw) / 2, ty + n["_pady"] / 2
            else:
                px0, py0 = n["_x"] + (n["_w"] - iw) / 2, n["_y"] + n["_pady"]
            self._image(d, img, n, img_spec, P(px0, py0), iw * S, ih * S, S)
        if n.get("notes"):
            ix, iy = P(n["_x"] + n["_w"] - 13, n["_y"] + 4)
            d.rectangle([ix, iy, ix + 8 * S, iy + 8 * S], fill="#868E96")
        if n.get("href"):
            ix, iy = P(n["_x"] + 4, n["_y"] + 4)
            d.ellipse([ix, iy, ix + 8 * S, iy + 8 * S], fill="#1971C2")
        if n.get("branch") == "folded" and all_kids(n):
            cnt = self.count(n) - 1
            side = n.get("_side", 1)
            bx = n["_x"] + n["_w"] - 22 if side > 0 else n["_x"] + 4
            cx, cy = P(bx + 9, n["_y"] + n["_h"] / 2)
            d.ellipse([cx - 9 * S, cy - 9 * S, cx + 9 * S, cy + 9 * S], fill="#FFFFFF", outline="#868E96")
            center_text(d, (cx, cy), f"+{cnt}" if cnt < 100 else "+", font(9 * S, True), "#495057")
        for c in (n.get("children") or {}).get("callout", []):
            cw = c["_cw"]
            bx0, by0 = P(n["_x"] + n["_w"] / 2 - cw / 2, n["_y"] - 30)
            d.rounded_rectangle([bx0, by0, bx0 + cw * S, by0 + 22 * S], radius=6 * S, fill="#2B8A3E")
            tipx = bx0 + cw * S / 2
            d.polygon([(tipx - 5 * S, by0 + 22 * S), (tipx + 5 * S, by0 + 22 * S), (tipx, by0 + 28 * S)], fill="#2B8A3E")
            draw_text(img, d, (bx0 + 8 * S, by0 + 3 * S), c.get("title") or "", font(12 * S), "#FFFFFF")

    def _image(self, d, img, n, spec, xy, w, h, S):
        x, y = xy
        eq = (ext(n, "org.xmind.ui.mathJax") or {}).get("content") or {}
        video = ext(n, "org.xmind.ui.webVideo")
        pic = self.resource(spec["src"])
        if spec.get("isMathJaxImage") or eq.get("content"):
            d.rounded_rectangle([x, y, x + w, y + h], radius=4 * S, fill="#F8F9FA", outline="#DEE2E6")
            draw_text(img, d, (x + 6 * S, y + h / 2 - 8 * S), (eq.get("content") or "equation")[:60], font(12 * S), "#495057")
            self.warn("equation shown as its LaTeX source (XMind renders it)")
            return
        if pic == "svg" or pic is None:
            d.rounded_rectangle([x, y, x + w, y + h], radius=6 * S, fill="#E7F5FF" if pic else "#FFF5F5",
                                outline="#74C0FC" if pic else "#FF8787")
            label = "SVG image" if pic else "missing image"
            center_text(d, (x + w / 2, y + h / 2), label, font(11 * S), "#1864AB" if pic else "#C92A2A")
        else:
            w, h = min(w, img.width), min(h, img.height)  # never larger than the drawing itself
            pic = pic.resize((max(1, int(w)), max(1, int(h))), Image.LANCZOS)
            try:
                op = float(spec["opacity"]) if spec.get("opacity") is not None else None
            except (TypeError, ValueError):
                op = None
            if op is not None and math.isfinite(op):
                op = min(max(op, 0.0), 1.0)
                pic.putalpha(pic.getchannel("A").point(lambda v: int(v * op)))
            img.paste(pic, (int(x), int(y)), pic)
        if video:
            cx, cy, r = x + w / 2, y + h / 2, min(w, h) * 0.18
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#E03131")
            d.polygon([(cx - r * 0.35, cy - r * 0.5), (cx - r * 0.35, cy + r * 0.5), (cx + r * 0.55, cy)], fill="#FFFFFF")

    def _relationships(self, d, img, root, nodes, P, S, bg):
        byid = {n["id"]: n for n in nodes if "id" in n}
        rel_theme = (self.theme.get("relationship") or {}).get("properties") or {}
        free = self.sheet.get("topicPositioning") == "free"
        for r in self.sheet.get("relationships") or []:
            a, b = byid.get(r.get("end1Id")), byid.get(r.get("end2Id"))
            if not a or not b:
                self.warn(f"relationship end missing or folded away: {r.get('title', r.get('id'))}")
                continue
            own = (r.get("style") or {}).get("properties") or {}
            rp = {**rel_theme, **own}
            if free and "line-pattern" not in rp:
                self.warn("free-positioning (flowchart) sheet: relationships without a pattern are drawn dashed by "
                          "XMind's default theme — set \"pattern\": \"solid\"")
                free = False
            col = hexc(rp.get("line-color"), "#E03131") or (224, 49, 49)
            lw = max(1, int(pt(rp.get("line-width"), 2 * PT) * S))
            side = a.get("_side", 1)
            ay, by = a["_y"] + a["_h"] / 2, b["_y"] + b["_h"] / 2
            ax = a["_x"] + a["_w"] if side > 0 else a["_x"]
            bx = b["_x"] + b["_w"] if b.get("_side", 1) > 0 else b["_x"]
            straight = "straight" in rp.get("shape-class", "")
            if straight:
                ax, ay = a["_x"] + a["_w"] / 2, a["_y"] + a["_h"] / 2
                bx, by = b["_x"] + b["_w"] / 2, b["_y"] + b["_h"] / 2
                cx, cy = (ax + bx) / 2, (ay + by) / 2
            elif a.get("_side", 1) != b.get("_side", 1):
                ax, ay = a["_x"] + a["_w"] / 2, a["_y"]
                bx, by = b["_x"] + b["_w"] / 2, b["_y"]
                cx, cy = (ax + bx) / 2, min(ay, by, root["_y"]) - 160
            else:
                cx = max(ax, bx) + 160 if side > 0 else min(ax, bx) - 160
                cy = (ay + by) / 2
            pts = [P(*q) for q in bezier((ax, ay), (cx, cy), (bx, by))]
            dashed(d, pts, col, lw, rp.get("line-pattern", "dash" if not own else "solid"))
            if rp.get("arrow-end-class", "org.xmind.arrowShape.triangle") not in ("org.xmind.arrowShape.none", "inherited"):
                (x1, y1), (x2, y2) = pts[-3], pts[-1]
                ang = math.atan2(y2 - y1, x2 - x1)
                L = 12 * S
                d.polygon([(x2, y2), (x2 - L * math.cos(ang - 0.4), y2 - L * math.sin(ang - 0.4)),
                           (x2 - L * math.cos(ang + 0.4), y2 - L * math.sin(ang + 0.4))], fill=col)
            if r.get("title"):
                mx, my = pts[20]
                tf = font(pt(rp.get("fo:font-size"), 13 * PT) * S)
                tc = rp.get("fo:color") if rp.get("fo:color") not in (None, "inherited") else "#C92A2A"
                tw = text_width(r["title"], tf)
                d.rectangle([mx - tw / 2 - 4, my - font_px(tf) * 0.7, mx + tw / 2 + 4, my + font_px(tf) * 0.7], fill=bg)
                draw_text(img, d, (mx - tw / 2, my - font_px(tf) * 0.6), r["title"], tf, tc)

    def _draw_matrix(self, d, img, P, S, ink):
        m = self.matrix
        x0, y0 = m["x"], m["y"]
        total_w = m["rowtitle_w"] + sum(m["colw"].values())
        hf = font(13 * S, True)
        hx = x0 + m["rowtitle_w"]
        d.rectangle([*P(x0, y0 - 30), *P(x0 + total_w, y0)], fill="#E9ECEF", outline=ink)
        for c in m["columns"]:
            draw_text(img, d, P(hx + 10, y0 - 24), c, hf, "#212529")
            hx += m["colw"][c]
        for (ry, rh) in m["rows"]:
            d.rectangle([*P(x0, ry), *P(x0 + total_w, ry + rh)], outline=ink)
        cx = x0 + m["rowtitle_w"]
        for c in m["columns"]:
            d.line([P(cx, y0 - 30), P(cx, y0 + m["h"])], fill=ink, width=max(1, int(S)))
            cx += m["colw"][c]

    def _texture(self, d, img, bg, dark):
        tex = (ext(self.sheet, "org.xmind.ui.background-texture") or {}).get("content") or {}
        if tex.get("style") not in ("grid", "dots"):
            return
        step = {"sparse": 48, "dense": 16}.get(tex.get("density"), 28)
        col = hexc(tex.get("color")) or ((70, 76, 84) if dark else (222, 226, 230))
        w, h = img.size
        if tex["style"] == "grid":
            for x in range(0, w, step):
                d.line([(x, 0), (x, h)], fill=col)
            for y in range(0, h, step):
                d.line([(0, y), (w, y)], fill=col)
        else:
            for x in range(0, w, step):
                for y in range(0, h, step):
                    d.ellipse([x - 1, y - 1, x + 1, y + 1], fill=col)

    def _watermark(self, img, S):
        wm = (ext(self.sheet, "org.xmind.ui.watermark") or {}).get("content") or {}
        if wm.get("kind") != "text" or not wm.get("text"):
            if wm.get("kind") == "image":
                self.warn("image watermark not drawn in the preview")
            return
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        f = font((wm.get("fontSize") or 36) * S, (wm.get("fontWeight") or 400) >= 600)
        col = hexc(wm.get("color"), "#868E96") or (134, 142, 150)
        try:
            alpha = int(255 * min(max(float(wm.get("opacity", 0.15)), 0.0), 1.0))
        except (TypeError, ValueError):
            alpha = 38
        text = str(wm["text"])[:120]  # a watermark is a short line; the tile is at most the drawing's size
        tw = min(int(text_width(text, f) + 40), max(img.width, 64))
        tile = Image.new("RGBA", (tw, min(int(font_px(f) * 1.6), max(img.height, 64))), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((20, 0), text if is_truetype(f) else _latin1(text), font=f, fill=(*col, alpha))
        tile = tile.rotate(-float(wm.get("rotationDegrees", -30)) * -1, expand=True)
        step = {"sparse": 2.2, "dense": 1.1}.get(wm.get("density"), 1.6)
        for x in range(0, img.size[0], max(1, int(tile.size[0] * step))):
            for y in range(0, img.size[1], max(1, int(tile.size[1] * step))):
                layer.alpha_composite(tile, (x, y))
        img.paste(layer, (0, 0), layer)

    def _legend(self, d, img, P, S, maxx, maxy, dark):
        legend = self.sheet.get("legend") or {}
        if legend.get("visibility") != "visible":
            return
        names = legend.get("markers") or {}
        ids = list(dict.fromkeys([m for m in self.used_markers if m] + list(names)))
        if not ids:
            return
        f = font(12 * S)
        rows = [(i, (names.get(i) or {}).get("name") or i) for i in ids]
        w = max(text_width(t, f) for _, t in rows) / S + 50
        h = 24 * len(rows) + 30
        x0, y0 = P(maxx - w - 10, maxy - h - 10)
        d.rounded_rectangle([x0, y0, x0 + w * S, y0 + h * S], radius=8 * S, fill=(40, 44, 52) if dark else (248, 249, 250),
                            outline="#ADB5BD")
        draw_text(img, d, (x0 + 10 * S, y0 + 6 * S), "Legend", font(12 * S, True), "#868E96")
        for k, (mid, text) in enumerate(rows):
            yy = y0 + (26 + 24 * k) * S
            c = {"task": "#2F9E44", "priority": "#E03131", "flag": "#F08C00", "star": "#FAB005"}.get(mid.split("-")[0], "#1971C2")
            d.ellipse([x0 + 10 * S, yy, x0 + 26 * S, yy + 16 * S], fill=c)
            draw_text(img, d, (x0 + 34 * S, yy), text, f, "#E9ECEF" if dark else "#343A40")


PART_MAX = 2400  # px; a model sees larger images shrunk until text is unreadable


# Outputs are written to an exclusive temp file and renamed into place: a symlink planted at the
# output name is replaced, never followed. Previews of a protected map are owner-only.
OUTPUT_MODE = 0o644


def save_image(im, path, **kw):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".preview-", suffix=os.path.splitext(path)[1], dir=d)
    try:
        with os.fdopen(fd, "wb") as fh:
            im.save(fh, format="PDF" if path.lower().endswith(".pdf") else "PNG", **kw)
            os.fchmod(fh.fileno(), OUTPUT_MODE)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def save_parts(img, base):
    """Split a very large preview into overlapping readable parts (<base>-partN.png)."""
    if img.width <= PART_MAX * 1.25 and img.height <= PART_MAX * 1.25:
        return []
    out, k, overlap = [], 1, 120
    for y in range(0, img.height, PART_MAX - overlap):
        for x in range(0, img.width, PART_MAX - overlap):
            box = (x, y, min(x + PART_MAX, img.width), min(y + PART_MAX, img.height))
            if k > MAX_PARTS:
                return out
            path = f"{base}-part{k}.png"
            save_image(img.crop(box), path)
            out.append(path)
            k += 1
            if box[2] >= img.width:
                break
        if y + PART_MAX >= img.height:
            break
    return out


def embed_thumbnail(path, png_bytes):
    path = os.path.realpath(path)  # update the real file behind a symlink, keep the link
    mode = os.stat(path).st_mode & 0o7777
    with open_zip(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    manifest = json.loads(files.get("manifest.json", b'{"file-entries":{}}'))
    manifest.setdefault("file-entries", {})["Thumbnails/thumbnail.png"] = {}
    files["Thumbnails/thumbnail.png"] = png_bytes
    files["manifest.json"] = json.dumps(manifest).encode()
    order = ["content.json", "metadata.json", "manifest.json"]
    # Exclusive, randomly named temp file next to the target: a planted "<file>.tmp" symlink can't
    # redirect the write. Removed if anything fails.
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "wb") as fh:
            with zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED) as z:
                for name in order + sorted(n for n in files if n not in order):
                    if name in files:
                        z.writestr(name, files[name])
            os.fchmod(fh.fileno(), mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


# Same limit as lib/zip.mjs: a hostile file can declare entries that inflate to gigabytes. zipfile
# never inflates an entry past its declared size, so checking the declared total is enough.
MAX_UNZIPPED_BYTES = (int(os.environ.get("XMIND_MAX_UNZIPPED_MB") or 0) or 1024) * 1024 * 1024
BOMB_SIZE, BOMB_RATIO = 4 * 1024 * 1024, 100


class SafeZipFile(zipfile.ZipFile):
    """zipfile inflates an entry as far as its data goes, whatever size it declares; this one stops
    one byte past the declared size, so a forged entry can't fill memory."""

    def read(self, name, pwd=None):
        info = name if isinstance(name, zipfile.ZipInfo) else self.getinfo(name)
        out = bytearray()
        with self.open(info, pwd=pwd) as f:
            while True:
                chunk = f.read(min(1 << 20, info.file_size + 1 - len(out)))
                if not chunk:
                    break
                out += chunk
                if len(out) > info.file_size:
                    sys.exit(f'Invalid .xmind file: "{info.filename}" unpacks to more than its declared '
                             f"{info.file_size} bytes (damaged or hostile file).")
        return bytes(out)


def open_zip(path):
    zf = SafeZipFile(path)
    custom = bool(os.environ.get("XMIND_MAX_UNZIPPED_MB"))
    problem = None
    for i in zf.infolist():
        if i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            # XMind writes stored / deflated entries only; others (bzip2, LZMA, zstd) would also slip
            # past the ratio rule below.
            problem = f"uses an unsupported compression method ({i.compress_type}) for {json.dumps(i.filename[:100])}"
            break
        if (not custom and i.compress_type == zipfile.ZIP_DEFLATED and i.file_size > BOMB_SIZE
                and i.file_size > i.compress_size * BOMB_RATIO):
            problem = (f'has an entry ("{i.filename}") that unpacks from {i.compress_size // 1024} KB '
                       f"to {i.file_size // 1048576} MB")
            break
    spans = sorted(zf.infolist(), key=lambda i: i.header_offset)
    for a, b in zip(spans, spans[1:]):
        if a.header_offset + 30 + len(a.filename.encode()) + a.compress_size > b.header_offset:
            problem = "has entries that overlap (damaged or hostile file)"
    if len({i.filename for i in spans}) != len(spans):
        problem = "lists the same entry twice (damaged or hostile file)"
    total = sum(i.file_size for i in zf.infolist())
    if not problem and total > MAX_UNZIPPED_BYTES:
        problem = f"would unpack to {total // 1048576} MB, more than the {MAX_UNZIPPED_BYTES // 1048576} MB limit"
    if problem:
        zf.close()
        sys.exit(f"This .xmind file {problem} — it is not a normal mind map "
                 "(set XMIND_MAX_UNZIPPED_MB to raise the limit if you trust it).")
    return zf


def is_encrypted(zf):
    try:
        manifest = json.loads(zf.read("manifest.json"))
    except (KeyError, ValueError):
        return False
    return any((e or {}).get("encryption-data") for e in (manifest.get("file-entries") or {}).values())


def decrypted_copy(path, password, tmpdir):
    """Decrypt via read_xmind.mjs (Python's standard library has no AES) into `tmpdir`, which the
    caller deletes — the plaintext copy must never outlive the preview."""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "read_xmind.mjs")
    out = os.path.join(tmpdir, "decrypted.xmind")
    req = json.dumps({"action": "decrypt", "path": os.path.abspath(path), "password": password, "output": out})
    p = subprocess.run(["node", script], input=req, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(p.stderr.strip() or "could not decrypt the file")
    return out


def main():
    # A kill (SIGTERM / SIGHUP) unwinds through the finally below, so the decrypted copy is removed.
    for sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
        if sig is not None:
            signal.signal(sig, lambda *_: sys.exit(1))
    tmpdir = tempfile.mkdtemp(prefix="xmind-preview-")  # private (0700); removed in every case
    try:
        run(tmpdir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def run(tmpdir):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--out-dir", default=None, help="where previews go (default: next to the file)")
    ap.add_argument("--scale", type=float, default=0.5)
    ap.add_argument("--sheet", type=int, default=None, help="1-based sheet number (default: all)")
    ap.add_argument("--format", choices=["png", "pdf"], default="png", help="pdf = one page per sheet")
    ap.add_argument("--password-file", default=None,
                    help="file holding the password of a protected file (first line); safest")
    ap.add_argument("--password", default=None,
                    help="password of a protected file (visible to other users in ps — prefer --password-file)")
    ap.add_argument("--thumbnail", action="store_true", help="embed sheet 1 preview as the file thumbnail")
    a = ap.parse_args()

    scale = a.scale
    font_note = None
    if not is_truetype(font(14)):
        # Pillow's built-in bitmap font has one fixed size, so the drawing can't be scaled down
        # around it — draw at full size instead.
        scale = 1.0
        font_note = "no TrueType font found — text drawn with Pillow's basic font (install e.g. fonts-dejavu)"
    source = a.file
    pw_file = a.password_file or os.environ.get("XMIND_PASSWORD_FILE")
    if pw_file:
        with open(pw_file, encoding="utf-8") as fh:
            password = fh.readline().rstrip("\r\n") or None
    else:
        password = a.password or os.environ.get("XMIND_PASSWORD") or None
    zf = open_zip(source)
    if "content.json" not in zf.namelist():
        sys.exit("Only modern (zen) .xmind files can be previewed (no content.json found).")
    if is_encrypted(zf):
        if not password:
            sys.exit("This file is password-protected — pass --password-file (a file holding the password).")
        if a.thumbnail:
            sys.exit("--thumbnail is not available for password-protected files (it would reveal the map).")
        global OUTPUT_MODE
        OUTPUT_MODE = 0o600  # previews show the protected map in clear: owner-only
        zf.close()
        source = decrypted_copy(a.file, password, tmpdir)
        zf = open_zip(source)
    content = json.loads(zf.read("content.json").decode("utf-8-sig"))
    sheets = content if isinstance(content, list) else content.get("sheets", [])
    if len(sheets) > 50 and not a.sheet:
        print(f"note: {len(sheets)} sheets — only the first 50 are drawn (use --sheet N for others)")
        sheets = sheets[:50]
    out_dir = a.out_dir or os.path.dirname(os.path.abspath(a.file))
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(a.file))[0]
    thumb, pages = None, []
    for i, sh in enumerate(sheets, 1):
        if a.sheet and i != a.sheet:
            continue
        s = Sheet(sh, zf)
        if font_note:
            s.warn(font_note)
        img = s.render(scale)
        warn = "; ".join(dict.fromkeys(s.warnings)) or "ok"
        if a.format == "png":
            out = os.path.join(out_dir, f"{stem}-sheet{i}.png")
            save_image(img, out)
            parts = save_parts(img, os.path.join(out_dir, f"{stem}-sheet{i}"))
            if parts:
                warn = (warn + "; " if warn != "ok" else "") + \
                    f"map is {img.width}x{img.height}px — too big to read as one image; look at the {len(parts)} parts"
            print(f"{out}  {img.width}x{img.height}  {warn}")
            for part in parts:
                print(f"  part: {part}")
        else:
            pages.append(img)
            print(f"sheet {i}  {img.width}x{img.height}  {warn}")
        if i == 1:
            t = img.copy()
            t.thumbnail((800, 800))
            buf = io.BytesIO()
            t.save(buf, "PNG")
            thumb = buf.getvalue()
    zf.close()
    if pages:
        out = os.path.join(out_dir, f"{stem}.pdf")
        save_image(pages[0], out, save_all=True, append_images=pages[1:], resolution=96)
        print(f"{out}  {len(pages)} page(s)")
    if a.thumbnail:
        if thumb is None:
            sys.exit("--thumbnail needs sheet 1 to be rendered")
        embed_thumbnail(a.file, thumb)
        print(f"thumbnail embedded into {a.file}")


if __name__ == "__main__":
    try:
        main()
    except zipfile.BadZipFile as err:
        sys.exit(f"Invalid .xmind file (damaged ZIP): {err}")
    except Image.DecompressionBombError:
        sys.exit("This map would need a drawing too large to render safely — it is not a normal mind map.")
