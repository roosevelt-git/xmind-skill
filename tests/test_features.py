#!/usr/bin/env python3
"""Rich content, sheet extras, password protection, validate / export actions and the preview.

Everything is checked against the file format XMind itself reads; nothing here opens XMind or
reads the screen.
"""
import json, os, shutil, subprocess, sys, tempfile, zipfile

_HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(_HERE, "..", "skills", "xmind", "scripts")
TMP = tempfile.mkdtemp(prefix="xmind-features-test-")
XMIND_ASAR = next((p for p in [os.environ.get("XMIND_APP_ASAR"), "/Applications/Xmind.app/Contents/Resources/app.asar"]
                   if p and os.path.exists(p)), None)

passed, failed = 0, []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed.append(f"{name} {detail}")
        print(f"  FAIL: {name} {str(detail)[:300]}")


def create(data, ok=True):
    p = subprocess.run(["node", f"{SCRIPTS}/create_xmind.mjs"], input=json.dumps(data), capture_output=True, text=True)
    if ok and p.returncode != 0:
        print("CREATE ERROR:", p.stderr)
        sys.exit(1)
    return p


def reader(req, ok=True):
    p = subprocess.run(["node", f"{SCRIPTS}/read_xmind.mjs"], input=json.dumps(req), capture_output=True, text=True)
    if ok:
        assert p.returncode == 0, p.stderr
        return json.loads(p.stdout)
    return p


def content(path):
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("content.json")), z.namelist()


def kid(t, title):
    return next(c for c in t["children"]["attached"] if c["title"] == title)


def ext(t, provider):
    return next((e for e in t.get("extensions", []) if e["provider"] == provider), None)


def one(path, root, **sheet):
    return create({"path": path, "sheets": [{"title": "S", "rootTopic": root, **sheet}]})


def png(path, w=40, h=20, color="#336699"):
    from PIL import Image
    Image.new("RGB", (w, h), color).save(path)
    return path


img = png(f"{TMP}/pic.png", 400, 200)
open(f"{TMP}/note.mp3", "wb").write(b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64)

print("\n--- 1: text & fill styles ---")
f1 = f"{TMP}/styles.xmind"
one(f1, {"title": "R", "children": [
    {"title": "Hand", "handDrawn": True},
    {"title": "Deco", "underline": True, "strike": True, "highlight": "#FFEC99", "textTransform": "uppercase",
     "textAlign": "left", "fillOpacity": 0.4, "borderPattern": "dash", "linePattern": "handdrawn-dash"},
    {"title": "NoFill", "fillPattern": "none"}]})
c, _ = content(f1)
r = c[0]["rootTopic"]
p = kid(r, "Hand")["style"]["properties"]
check("handDrawn sets XMind's hand-drawn patterns", p.get("fill-pattern") == "solid-hand-drawn" and
      p.get("border-line-pattern") == "handdrawn-solid" and p.get("line-pattern") == "handdrawn-solid", p)
p = kid(r, "Deco")["style"]["properties"]
check("underline + strike", p.get("fo:text-decoration") == "underline line-through", p)
check("highlight / transform / align / opacity", p.get("fo:background-color") == "#FFEC99" and
      p.get("fo:text-transform") == "uppercase" and p.get("fo:text-align") == "left" and p.get("svg:opacity") == "0.4", p)
check("border / branch line patterns", p.get("border-line-pattern") == "dash" and p.get("line-pattern") == "handdrawn-dash", p)
check("fillPattern none", kid(r, "NoFill")["style"]["properties"].get("fill-pattern") == "none")
for name, topic, msg in [("bad textTransform", {"title": "x", "textTransform": "shout"}, "unknown textTransform"),
                         ("bad fillOpacity", {"title": "x", "fillOpacity": 3}, "between 0 and 1"),
                         ("bad pattern", {"title": "x", "borderPattern": "zigzag"}, "unknown borderPattern")]:
    p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": topic}]}, ok=False)
    check(name, p.returncode != 0 and msg in p.stderr, p.stderr)

print("\n--- 2: rich-text title, folded branch ---")
f2 = f"{TMP}/rich.xmind"
one(f2, {"titleRuns": [{"text": "Plain "}, {"text": "bold red", "bold": True, "color": "red", "highlight": "yellow"},
                       {"text": " gone", "strike": True}],
         "children": [{"title": "Closed", "folded": True, "children": [{"title": "inside"}]}]})
c, _ = content(f2)
r = c[0]["rootTopic"]
check("title is the joined runs", r["title"] == "Plain bold red gone")
at = r.get("attributedTitle", [])
check("attributedTitle runs", len(at) == 3 and at[1].get("fo:font-weight") == "bold" and at[1].get("fo:color") == "#E03131"
      and at[1].get("fo:background-color") == "#FFEC99" and at[2].get("fo:text-decoration") == "line-through", at)
check("folded → branch: folded", kid(r, "Closed").get("branch") == "folded")
rd = reader({"action": "read", "path": f2})[0]
check("reader: titleRuns + folded", len(rd.get("titleRuns", [])) == 3 and rd["titleRuns"][1].get("bold") is True and
      rd["children"][0].get("folded") is True, rd.get("titleRuns"))

print("\n--- 3: equation, video, audio, link preview ---")
f3 = f"{TMP}/rich2.xmind"
one(f3, {"title": "R", "children": [
    {"equation": "\\frac{a}{b} + \\sqrt{x^2} = \\alpha"},
    {"title": "YT", "video": "https://youtu.be/dQw4w9WgXcQ"},
    {"title": "Vimeo", "video": {"url": "https://vimeo.com/123456", "thumbnail": img}},
    {"title": "Voice", "audio": f"{TMP}/note.mp3"},
    {"title": "Site", "href": "https://example.com", "linkPreview": {"title": "Example", "description": "An example"}}]})
c, names = content(f3)
r = c[0]["rootTopic"]["children"]["attached"]
eq = r[0]
check("equation: rendered svg + isMathJaxImage", eq["image"].get("isMathJaxImage") is True and
      eq["image"]["src"][4:] in names and eq["image"]["src"].endswith(".svg"), eq.get("image"))
with zipfile.ZipFile(f3) as z:
    svg = z.read(eq["image"]["src"][4:]).decode()
check("equation svg is well-formed", svg.startswith("<svg") and svg.endswith("</svg>") and "α" in svg and "<line" in svg)
check("equation: LaTeX kept in mathJax extension", ext(eq, "org.xmind.ui.mathJax")["content"]["content"].startswith("\\frac"))
yt = r[1]
v = ext(yt, "org.xmind.ui.webVideo")["content"]
check("video: href, thumbnail = image, embed url", yt["href"] == "https://youtu.be/dQw4w9WgXcQ" and v["thumbnail"] == yt["image"]["src"]
      and v["embedUrl"] == "https://www.youtube.com/embed/dQw4w9WgXcQ", v)
check("vimeo embed + own thumbnail", ext(r[2], "org.xmind.ui.webVideo")["content"]["embedUrl"] == "https://player.vimeo.com/video/123456"
      and r[2]["image"]["src"].endswith(".png"))
au = ext(r[3], "org.xmind.ui.audionotes")
check("audio note resource", au["content"] is None and au["resources"][0][4:] in names and au["resources"][0].endswith(".mp3"))
lp = ext(r[4], "org.xmind.ui.linkPreview")["content"]
check("link preview", lp == {"mode": "preview", "title": "Example", "description": "An example"} and r[4]["href"] == "https://example.com", lp)
rd = reader({"action": "read", "path": f3})[0]["children"]
check("reader: equation / video / audio / linkPreview", rd[0].get("equation", "").startswith("\\frac") and
      rd[1].get("video", {}).get("url") and rd[3].get("audio", "").startswith("xap:") and rd[4].get("linkPreview", {}).get("title") == "Example")
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "audio": f"{TMP}/x.txt"}}]}, ok=False)
check("bad audio type fails", p.returncode != 0 and "unsupported audio type" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "video": "not a url"}}]}, ok=False)
check("bad video url fails", p.returncode != 0 and "http(s)" in p.stderr, p.stderr)

print("\n--- 4: matrix ---")
f4 = f"{TMP}/matrix.xmind"
one(f4, {"title": "Choice", "matrix": {"columns": ["Pros", "Cons"], "rows": [
    {"title": "A", "cells": {"Pros": ["fast", "cheap"], "Cons": "risky"}}, {"title": "B", "cells": {"Pros": "safe"}}]}})
r = content(f4)[0][0]["rootTopic"]
cols = ext(r, "org.xmind.ui.spreadsheet")["content"][0]["content"]
check("matrix structure + columns", r["structureClass"] == "org.xmind.ui.spreadsheet" and [c["content"] for c in cols] == ["Pros", "Cons"])
rowA = kid(r, "A")["children"]["attached"]
check("cells are children labelled with their column", [(c["title"], c["labels"]) for c in rowA] ==
      [("fast", ["Pros"]), ("cheap", ["Pros"]), ("risky", ["Cons"])], rowA)
check("reader: matrixColumns", reader({"action": "read", "path": f4})[0].get("matrixColumns") == ["Pros", "Cons"])
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "M", "matrix": {
    "columns": ["X"], "rows": [{"title": "r", "cells": {"Y": "z"}}]}}}]}, ok=False)
check("unknown matrix column fails", p.returncode != 0 and 'unknown column "Y"' in p.stderr, p.stderr)

print("\n--- 5: legend, custom markers, watermark, texture ---")
f5 = f"{TMP}/sheet.xmind"
icon = png(f"{TMP}/icon.png", 32, 32, "#2F9E44")
one(f5, {"title": "R", "markers": ["ok-mark", "priority-1"]},
    legend={"markers": {"priority-1": "Must", "ok-mark": "Approved"}},
    customMarkers=[{"id": "ok-mark", "name": "Approved", "image": icon}],
    watermark={"text": "DRAFT", "opacity": 0.2, "rotation": -30, "density": "dense", "bold": True},
    backgroundTexture={"style": "grid", "density": "sparse"})
sh, names = content(f5)
sh = sh[0]
check("legend", sh.get("legend") == {"visibility": "visible", "markers": {"priority-1": {"name": "Must"}, "ok-mark": {"name": "Approved"}}}, sh.get("legend"))
cm = sh["customMarkerGroups"][0]["markers"][0]
check("custom marker resource", cm["id"] == "ok-mark" and cm["resource"][4:] in names)
wm = next(e for e in sh["extensions"] if e["provider"] == "org.xmind.ui.watermark")["content"]
check("watermark", wm == {"kind": "text", "text": "DRAFT", "fontWeight": 700, "opacity": 0.2, "rotationDegrees": -30, "density": "dense"}, wm)
tx = next(e for e in sh["extensions"] if e["provider"] == "org.xmind.ui.background-texture")["content"]
check("background texture", tx == {"style": "grid", "density": "sparse"}, tx)
rd = reader({"action": "read", "path": f5})[0]
check("reader: sheet extras in create's shape", rd.get("legend", {}).get("markers", {}).get("priority-1") == "Must" and
      rd.get("watermark", {}).get("text") == "DRAFT" and rd.get("backgroundTexture", {}).get("style") == "grid" and
      rd.get("customMarkers", [{}])[0].get("id") == "ok-mark", {k: rd.get(k) for k in ("legend", "watermark")})
p = create({"path": f5, "sheets": [{"title": rd["sheetTitle"], "rootTopic": rd}]}, ok=False)
check("reader output → create (sheet extras on the root)", p.returncode == 0, p.stderr)
sh2 = content(f5)[0][0]
check("sheet extras survive the round trip", sh2.get("legend", {}).get("markers", {}).get("ok-mark") == {"name": "Approved"} and
      any(e["provider"] == "org.xmind.ui.watermark" for e in sh2.get("extensions", [])), sh2.get("legend"))
one(f5, {"title": "R"}, watermark=None, backgroundTexture=False, legend=False)
sh3 = content(f5)[0][0]
check("watermark / texture removed, legend hidden", not any(e["provider"] in ("org.xmind.ui.watermark", "org.xmind.ui.background-texture")
      for e in sh3.get("extensions", [])) and sh3.get("legend") == {"visibility": "hidden"}, sh3.get("extensions"))

print("\n--- 6: themes ---")
f6 = f"{TMP}/theme.xmind"
one(f6, {"title": "R"}, theme="colorful")
th = content(f6)[0][0]["theme"]
check("colorful: multi-branch colours + tapered", len(th["map"]["properties"]["multi-line-colors"].split()) >= 5 and
      th["map"]["properties"].get("line-tapered") == "tapered", th["map"])
one(f6, {"title": "R"}, theme="handDrawn")
th = content(f6)[0][0]["theme"]
check("handDrawn preset", th["mainTopic"]["properties"].get("fill-pattern") == "solid-hand-drawn")
src = f"{TMP}/themed-source.xmind"
one(src, {"title": "R"}, theme={"preset": "dark", "map": {"background": "#101820"}})
with zipfile.ZipFile(src) as z:
    files = {n: z.read(n) for n in z.namelist()}
cc = json.loads(files["content.json"])
cc[0]["extensions"] = [{"provider": "org.xmind.ui.skeleton.structure.style", "content": {"centralTopic": "org.xmind.ui.map.clockwise"}}]
files["content.json"] = json.dumps(cc).encode()
with zipfile.ZipFile(src, "w") as z:
    for n, dta in files.items():
        z.writestr(n, dta)
one(f6, {"title": "R"}, theme={"from": src, "mainTopic": {"fontSize": 22}})
s6 = content(f6)[0][0]
check("theme.from copies the theme", s6["theme"]["map"]["properties"]["svg:fill"] == "#101820")
check("theme.from overrides on top", s6["theme"]["mainTopic"]["properties"].get("fo:font-size") == "22pt")
check("theme.from copies skeleton structures", any(e["provider"] == "org.xmind.ui.skeleton.structure.style" for e in s6.get("extensions", [])))

print("\n--- 7: image options, XMind library ---")
f7 = f"{TMP}/imgopts.xmind"
one(f7, {"title": "R", "image": {"path": img, "width": 100, "align": "left", "opacity": 0.5, "borderColor": "#000000",
                                 "borderWidth": 2, "shadow": True}})
im = content(f7)[0][0]["rootTopic"]["image"]
check("image align / opacity / border / shadow", im.get("align") == "left" and im.get("opacity") == 0.5 and
      im.get("borderColor") == "#000000" and im.get("borderWidth") == 2 and im.get("shadowVisible") is True, im)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "image": {"path": img, "align": "middle"}}}]}, ok=False)
check("bad image align fails", p.returncode != 0 and "unknown image align" in p.stderr, p.stderr)
if XMIND_ASAR:
    one(f7, {"title": "R", "children": [{"title": "s", "image": {"sticker": "rocket"}}]})
    st = content(f7)[0][0]["rootTopic"]["children"]["attached"][0]["image"]
    check("sticker from XMind's library", st["src"].endswith(".svg") and st["src"][4:] in content(f7)[1])
    p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "image": {"sticker": "rockett"}}}]}, ok=False)
    check("unknown sticker suggests matches", p.returncode != 0 and "Close matches" in p.stderr and "rocket" in p.stderr, p.stderr)
    ls = reader({"action": "list_stickers", "query": "rocket"})
    check("list_stickers", ls["count"] >= 1 and "rocket" in ls["items"], ls)
    il = reader({"action": "list_illustrations"})
    check("list_illustrations", il["count"] > 10)
else:
    print("  SKIP: XMind not installed (stickers / illustrations)")

print("\n--- 8: password protection ---")
f8 = f"{TMP}/secret.xmind"
create({"path": f8, "password": "pa55", "passwordHint": "the usual", "thumbnail": png(f"{TMP}/t.png"),
        "sheets": [{"title": "S", "rootTopic": {"title": "Top secret", "image": img, "color": "red"}}]})
with zipfile.ZipFile(f8) as z:
    man = json.loads(z.read("manifest.json"))
    raw = z.read("content.json")
    names8 = z.namelist()
check("entries encrypted, manifest readable", all("encryption-data" in v for v in man["file-entries"].values()) and
      b"Top secret" not in raw and man.get("password-hint") == "the usual", list(man["file-entries"]))
enc = man["file-entries"]["content.json"]["encryption-data"]
check("XMind's parameters", enc["iteration-count"] == 1024 and enc["size"] == 128 and enc["key-derivation-name"] == "PBKDF2WithHmacSHA512")
check("thumbnail left out", not any(n.startswith("Thumbnails/") for n in names8))
p = reader({"action": "read", "path": f8}, ok=False)
check("read without password fails with hint", p.returncode != 0 and "the usual" in p.stderr, p.stderr)
p = reader({"action": "read", "path": f8, "password": "wrong"}, ok=False)
check("wrong password", p.returncode != 0 and "Wrong password" in p.stderr, p.stderr)
check("read with password", reader({"action": "read", "path": f8, "password": "pa55"})[0]["title"] == "Top secret")
create({"path": f8, "password": "pa55", "sheets": [{"title": "S", "rootTopic": {"title": "Top secret"}}]})
check("overwrite keeps style of encrypted file", reader({"action": "read", "path": f8, "password": "pa55"})[0]
      .get("style", {}).get("svg:fill") == "#FFC9C9")
v = reader({"action": "validate", "path": f8, "password": "pa55"})
check("validate encrypted", v["valid"] is True and v["encrypted"] is True, v)

print("\n--- 9: validate ---")
check("valid file", reader({"action": "validate", "path": f3})["valid"] is True)
bad = f"{TMP}/broken.xmind"
one(bad, {"title": "R", "children": [{"title": "a"}, {"title": "b", "image": img}]})
with zipfile.ZipFile(bad) as z:
    files = {n: z.read(n) for n in z.namelist()}
cc = json.loads(files["content.json"])
root = cc[0]["rootTopic"]
a, b = root["children"]["attached"]
a["summaries"] = [{"id": "s1", "range": "(0,0)", "topicId": "t1"}]
a["summary"] = [{"id": "t1", "title": "old place"}]
a["boundaries"] = [{"id": "b1", "range": "(0,5)"}]
a["style"] = {"id": "st", "properties": {"shape-class": "org.xmind.topicShape.blob", "svg:fill": "red"}}
cc[0]["relationships"] = [{"id": "r1", "end1Id": a["id"], "end2Id": "nope",
                           "style": {"id": "rs", "properties": {"arrow-end-class": "org.xmind.arrowShape.antTriangle"}}}]
resource = b["image"]["src"][4:]
files.pop(resource)
files["content.json"] = json.dumps(cc).encode()
with zipfile.ZipFile(bad, "w") as z:
    for n, dta in files.items():
        z.writestr(n, dta)
v = reader({"action": "validate", "path": bad})
errs = " | ".join(v["errors"])
check("validate: invalid", v["valid"] is False)
for what, needle in [("old summary place", "children.summary"), ("boundary range", "outside"), ("unknown shape", "unknown shape"),
                     ("unknown arrow", "unknown arrow"), ("dangling relationship", "doesn't exist"),
                     ("missing resource", "is not in the file"), ("manifest vs zip", "missing from the zip")]:
    check(f"validate catches {what}", needle in errs, errs)
check("validate warns about non-hex colour", any("not a hex colour" in w for w in v["warnings"]), v["warnings"])

print("\n--- 10: export ---")
ex = reader({"action": "export", "path": f3, "format": "markdown"})["content"]
check("markdown export", ex.startswith("# S") and "[Site](https://example.com)" in ex and "$\\frac" in ex, ex[:200])
f10 = f"{TMP}/tasks.xmind"
one(f10, {"title": "Plan", "notes": "Root note", "children": [{"title": "Done", "taskStatus": "done"}, {"title": "Todo", "taskStatus": "todo"}]})
md = reader({"action": "export", "path": f10})["content"]
check("markdown tasks + notes", "- [x] Done" in md and "- [ ] Todo" in md and "> Root note" in md, md)
op = reader({"action": "export", "path": f10, "format": "opml", "output": f"{TMP}/out.opml"})
check("opml written", os.path.exists(f"{TMP}/out.opml") and "<outline text=\"Done\"" in open(f"{TMP}/out.opml").read(), op)
check("text export", reader({"action": "export", "path": f10, "format": "text"})["content"].splitlines()[1] == "\tDone")

print("\n--- 11: legacy (XMind 8) ---")
f11 = f"{TMP}/legacy.xmind"
p = create({"path": f11, "format": "legacy", "thumbnail": png(f"{TMP}/t2.png"), "sheets": [{"title": "S", "theme": "dark",
            "rootTopic": {"title": "R", "children": [{"title": "pic", "image": {"path": img, "width": 80}}, {"title": "eq", "equation": "x^2"}]}}]})
with zipfile.ZipFile(f11) as z:
    cx, sx, nm = z.read("content.xml").decode(), z.read("styles.xml").decode(), z.namelist()
    mx = z.read("META-INF/manifest.xml").decode()
check("legacy image", "<xhtml:img" in cx and 'svg:width="80"' in cx)
check("legacy thumbnail", "Thumbnails/thumbnail.png" in nm and "Thumbnails/thumbnail.png" in mx)
check("legacy theme folded (map + topics)", "map-properties" in sx and "#1B1F24" in sx and "#4DABF7" in sx, sx[:200])
check("legacy warns about equations only", "can't hold equations" in p.stderr and "theme" not in p.stderr.split("can't hold")[1].split("—")[0], p.stderr)
check("legacy validates", reader({"action": "validate", "path": f11})["valid"] is True)
p = create({"path": f"{TMP}/bad.xmind", "format": "legacy", "password": "x", "sheets": [{"title": "S", "rootTopic": {"title": "R"}}]}, ok=False)
check("legacy + password refused", p.returncode != 0 and "modern" in p.stderr, p.stderr)

print("\n--- 12: preview ---")
try:
    import PIL  # noqa: F401
    pv = f"{TMP}/pv"
    run = lambda *a: subprocess.run([sys.executable, f"{SCRIPTS}/preview_xmind.py", *a, "--out-dir", pv], capture_output=True, text=True)
    for layout in ["org-chart.down", "org-chart.up", "tree.right", "tree.left", "timeline.horizontal", "fishbone.leftHeaded",
                   "treetable", "brace.right", "logic.left", "map.clockwise", "spreadsheet"]:
        fl = f"{TMP}/lay-{layout}.xmind"
        root = {"title": layout, "structureClass": f"org.xmind.ui.{layout}",
                "children": [{"title": f"B{i}", "children": [{"title": f"{i}.1"}]} for i in range(3)]}
        one(fl, root)
        p = run(fl)
        check(f"preview layout {layout}", p.returncode == 0 and os.path.exists(f"{pv}/lay-{layout}-sheet1.png"), p.stderr[-300:])
    fo = f"{TMP}/outline.xmind"
    one(fo, {"title": "R", "children": [{"title": "P", "children": [{"title": "a"}, {"title": "b"}],
             "boundaries": [{"range": "(0,1)", "title": "A really long boundary title"}],
             "summaryTopics": [{"range": "(0,1)", "title": "Sum"}], "callouts": ["note"]},
            {"title": "F", "folded": True, "children": [{"title": "x"}]}]})
    p = run(fo)
    check("preview warns: narrow boundary title", "wider than its boundary" in p.stdout, p.stdout)
    check("preview warns: folded branch", "folded branch hides 1" in p.stdout, p.stdout)
    ff = f"{TMP}/flow.xmind"
    create({"path": ff, "sheets": [{"title": "F", "freePositioning": True, "rootTopic": {"title": "A"},
            "detachedTopics": [{"title": "B", "position": {"x": 0, "y": 150}}],
            "relationships": [{"sourceTitle": "A", "targetTitle": "B"}]}]})
    check("preview warns: dashed flowchart connectors", "drawn dashed" in run(ff).stdout)
    ft = f"{TMP}/turkish.xmind"
    one(ft, {"title": "Şirket İçi Ağ Güvenliği", "children": [{"title": "Işık · ğüşöç → İzmir", "labels": ["öncelik"],
             "markers": ["priority-1"]}, {"title": "Ünlü — “tırnak”", "callouts": ["ılık çay"]}]},
        watermark="TASLAK ŞİRKET")
    p = run(ft)
    check("preview handles non-Latin-1 text (Turkish)", p.returncode == 0 and os.path.exists(f"{pv}/turkish-sheet1.png"), p.stderr[-400:])
    p = run(f3, "--format", "pdf")
    check("preview pdf", p.returncode == 0 and os.path.exists(f"{pv}/rich2.pdf"), p.stderr)
    p = run(f8, "--password", "pa55")
    check("preview encrypted with password", p.returncode == 0 and os.path.exists(f"{pv}/secret-sheet1.png"), p.stderr)
    check("preview encrypted without password refuses", run(f8).returncode != 0)
    p = run(f5)
    check("preview with watermark / texture / legend", p.returncode == 0, p.stderr)
except ImportError:
    print("  SKIP: Pillow not installed")

shutil.rmtree(TMP, ignore_errors=True)
print("\n" + "=" * 60)
print(f"Results: {passed} passed, {len(failed)} failed")
for f in failed:
    print("  -", f)
sys.exit(1 if failed else 0)
