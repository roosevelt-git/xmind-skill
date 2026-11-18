#!/usr/bin/env python3
"""Styling, themes, images, thumbnails, refs, style preservation and the preview script."""
import json, os, shutil, struct, subprocess, sys, tempfile, zipfile, zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(_HERE, "..", "skills", "xmind", "scripts")
TMP = tempfile.mkdtemp(prefix="xmind-styling-test-")

passed, failed = 0, []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed.append(f"{name} {detail}")
        print(f"  FAIL: {name} {detail}")


def create(data, expect_ok=True):
    p = subprocess.run(["node", f"{SCRIPTS}/create_xmind.mjs"], input=json.dumps(data),
                       capture_output=True, text=True)
    if expect_ok and p.returncode != 0:
        print("CREATE ERROR:", p.stderr)
        sys.exit(1)
    return p


def read(path):
    p = subprocess.run(["node", f"{SCRIPTS}/read_xmind.mjs"],
                       input=json.dumps({"action": "read", "path": path}), capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def content(path):
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("content.json")), json.loads(z.read("manifest.json")), z.namelist()


def png(path, w, h):
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)
    return path


def topic(sheet, *titles):
    t = sheet["rootTopic"]
    for title in titles:
        t = next(c for c in t["children"]["attached"] if c["title"] == title)
    return t


img = png(f"{TMP}/pic.png", 400, 200)
thumb = png(f"{TMP}/thumb.png", 80, 60)

print("\n--- 1: topic styles ---")
f1 = f"{TMP}/style.xmind"
create({"path": f1, "thumbnail": thumb, "sheets": [{
    "title": "S", "theme": "clean",
    "rootTopic": {"title": "Root", "children": [
        {"title": "Palette", "color": "blue", "bold": True, "fontSize": 18, "branchLine": "elbow"},
        {"title": "Override", "color": "red", "fill": "#123456", "textColor": "#FFFFFF", "borderWidth": 0,
         "shape": "org.xmind.topicShape.diamond", "style": {"fo:font-style": "italic"}},
        {"title": "Pic", "image": {"path": img, "width": 200}},
        {"title": "A", "children": [{"title": "Dup", "ref": "dup-a"}]},
        {"title": "B", "children": [{"title": "Dup", "ref": "dup-b"}]},
    ]},
    "relationships": [{"sourceRef": "dup-a", "targetRef": "dup-b", "title": "r",
                       "color": "#E03131", "pattern": "dash", "arrowEnd": "triangle", "width": 2}],
}]})
c, man, names = content(f1)
s = c[0]
p = topic(s, "Palette")["style"]["properties"]
check("palette fill + border", p.get("svg:fill") == "#A5D8FF" and p.get("border-line-color") == "#1971C2", p)
check("fontSize number → pt", p.get("fo:font-size") == "18pt", p)
check("bold", p.get("fo:font-weight") == "bold")
check("branchLine alias", p.get("line-class") == "org.xmind.branchConnection.elbow")
p = topic(s, "Override")["style"]["properties"]
check("fill overrides palette", p.get("svg:fill") == "#123456" and p.get("border-line-color") == "#E03131", p)
check("shape kept with style", p.get("shape-class") == "org.xmind.topicShape.diamond")
check("raw style passthrough", p.get("fo:font-style") == "italic")
check("borderWidth 0", p.get("border-line-width") == "0pt")

print("\n--- 2: theme ---")
th = s["theme"]
check("preset central fill", th["centralTopic"]["properties"].get("svg:fill") == "#1E3A5F", th.get("centralTopic"))
check("preset map background", th["map"]["properties"].get("svg:fill") == "#FBFBFD")
check("preset relationship dash", th["relationship"]["properties"].get("line-pattern") == "dash")

print("\n--- 3: image + thumbnail ---")
im = topic(s, "Pic")["image"]
check("image height keeps aspect", im["width"] == 200 and im["height"] == 100, im)
res = im["src"][4:]
check("image resource in zip", res in names and res in man["file-entries"], res)
check("thumbnail in zip + manifest", "Thumbnails/thumbnail.png" in names and
      "Thumbnails/thumbnail.png" in man["file-entries"])

print("\n--- 4: refs + relationship style ---")
r = s["relationships"][0]
a, b = topic(s, "A", "Dup"), topic(s, "B", "Dup")
check("sourceRef/targetRef resolve to different topics", r["end1Id"] == a["id"] and r["end2Id"] == b["id"])
rp = r["style"]["properties"]
check("relationship style", rp.get("line-pattern") == "dash" and rp.get("arrow-end-class") ==
      "org.xmind.arrowShape.triangle" and rp.get("line-width") == "2pt", rp)

p = create({"path": f"{TMP}/amb.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "X"}, {"title": "X"}, {"title": "Y"}]},
    "relationships": [{"sourceTitle": "X", "targetTitle": "Y"}]}]}, expect_ok=False)
check("ambiguous title reference fails", p.returncode != 0 and "ambiguous" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/dupref.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "X", "ref": "k"}, {"title": "Y", "ref": "k"}]}}]}, expect_ok=False)
check("duplicate ref fails", p.returncode != 0 and "Duplicate topic ref" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/okdup.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "X"}, {"title": "X"}, {"title": "Y", "linkToTopic": "R"}]}}]}, expect_ok=False)
check("duplicate titles fine when not referenced", p.returncode == 0, p.stderr)
f5 = f"{TMP}/xlink.xmind"
create({"path": f5, "sheets": [
    {"title": "One", "rootTopic": {"title": "R1", "children": [{"title": "Go", "linkToRef": "two"}]}},
    {"title": "Two", "rootTopic": {"title": "R2", "ref": "two"}}]})
c5, _, _ = content(f5)
check("linkToRef across sheets", topic(c5[0], "Go")["href"] == f"xmind:#{c5[1]['rootTopic']['id']}")

print("\n--- 5: validation errors ---")
for name, data, msg in [
    ("unknown color", {"title": "R", "color": "chartreuse"}, "Unknown color"),
    ("unknown image type", {"title": "R", "image": f"{TMP}/x.bmp"}, "unsupported image type"),
]:
    p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": data}]}, expect_ok=False)
    check(name, p.returncode != 0 and msg in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "theme": "neon", "rootTopic": {"title": "R"}}]},
           expect_ok=False)
check("unknown theme preset", p.returncode != 0 and "Unknown theme preset" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "a"}, {"title": "b"}]}, "relationships": [{"sourceTitle": "a", "targetTitle": "b", "arrowEnd": "boom"}]}]},
    expect_ok=False)
check("unknown arrow", p.returncode != 0 and "Unknown arrow" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "thumbnail": img.replace(".png", ".txt"),
            "sheets": [{"title": "S", "rootTopic": {"title": "R"}}]}, expect_ok=False)
check("missing thumbnail fails", p.returncode != 0)

print("\n--- 6: style preservation on regenerate ---")
f6 = f"{TMP}/keep.xmind"
create({"path": f6, "sheets": [{"title": "S", "rootTopic": {"title": "R", "structureClass": "org.xmind.ui.logic.right",
        "children": [{"title": "K", "color": "green", "children": [{"title": "Leaf", "image": img}]},
                     {"title": "Dup", "color": "red"}, {"title": "Dup", "color": "blue"}]}}]})
create({"path": f6, "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "K", "shape": "org.xmind.topicShape.rect", "children": [{"title": "Leaf"}]},
    {"title": "Dup"}, {"title": "Dup"}]}}]})
c6, _, names6 = content(f6)
root6 = c6[0]["rootTopic"]
k = topic(c6[0], "K")["style"]["properties"]
check("colour kept, new shape merged", k.get("svg:fill") == "#B2F2BB" and k.get("shape-class") ==
      "org.xmind.topicShape.rect", k)
check("structureClass kept", root6.get("structureClass") == "org.xmind.ui.logic.right")
leaf = root6["children"]["attached"][0]["children"]["attached"][0]
check("image kept + resource carried", leaf.get("image") and leaf["image"]["src"][4:] in names6)
dups = [t["style"]["properties"]["svg:fill"] for t in root6["children"]["attached"] if t["title"] == "Dup"]
check("duplicate siblings matched by position", dups == ["#FFC9C9", "#A5D8FF"], dups)
create({"path": f6, "preserveStyles": False, "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "K"}]}}]})
c6b, _, _ = content(f6)
check("preserveStyles:false resets", "style" not in topic(c6b[0], "K"))

print("\n--- 7: legacy warning ---")
p = create({"path": f"{TMP}/legacy.xmind", "format": "legacy", "sheets": [{"title": "S", "theme": "clean",
            "rootTopic": {"title": "R", "color": "blue"}}]})
check("legacy: theme + colour no longer warn", "can't hold" not in p.stderr, p.stderr)
with zipfile.ZipFile(f"{TMP}/legacy.xmind") as z:
    sx = z.read("styles.xml").decode()
check("legacy: theme folded into topic style", 'svg:fill="#A5D8FF"' in sx and "map-properties" in sx, sx[:300])
p = create({"path": f"{TMP}/legacy-eq.xmind", "format": "legacy", "sheets": [{"title": "S",
            "rootTopic": {"title": "R", "children": [{"title": "", "equation": "a^2"}]}}]})
check("legacy: zen-only feature warns", "can't hold equations" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/legacy2.xmind", "format": "legacy", "sheets": [{"title": "S",
            "rootTopic": {"title": "R", "shape": "org.xmind.topicShape.diamond"}}]})
check("legacy shape-only does not warn", "only written" not in p.stderr, p.stderr)

print("\n--- 8: reader exposes style / image ---")
rd = read(f1)[0]
pal = next(t for t in rd["children"] if t["title"] == "Palette")
pic = next(t for t in rd["children"] if t["title"] == "Pic")
check("reader style", pal.get("style", {}).get("svg:fill") == "#A5D8FF", pal.get("style"))
check("reader image", pic.get("image", {}).get("width") == 200)
check("reader relationship style", rd["relationships"][0].get("style", {}).get("line-pattern") == "dash")
create({"path": f"{TMP}/shape.xmind", "sheets": [{"title": "S",
        "rootTopic": {"title": "R", "shape": "org.xmind.topicShape.diamond"}}]})
rs = read(f"{TMP}/shape.xmind")[0]
check("reader omits style when shape only", "style" not in rs and rs.get("shape") ==
      "org.xmind.topicShape.diamond", rs)

print("\n--- 9: preview script ---")
try:
    import PIL  # noqa: F401
    have_pil = True
except ImportError:
    have_pil = False
if have_pil:
    p = subprocess.run([sys.executable, f"{SCRIPTS}/preview_xmind.py", f1, "--out-dir", f"{TMP}/prev",
                        "--thumbnail"], capture_output=True, text=True)
    check("preview runs", p.returncode == 0, p.stderr)
    check("preview png written", os.path.exists(f"{TMP}/prev/style-sheet1.png"))
    with zipfile.ZipFile(f1) as z:
        tb = z.read("Thumbnails/thumbnail.png")
    check("preview thumbnail replaced", tb != open(thumb, "rb").read())
    check("file still readable after thumbnail", read(f1)[0]["title"] == "Root")
else:
    print("  SKIP: Pillow not installed")


def props_of(t):
    return (t.get("style") or {}).get("properties") or {}


def regen(path, root, expect_ok=True, **top):
    """Create twice-style helper: write `root` as the single sheet "S" at `path`."""
    return create({"path": path, **top, "sheets": [{"title": "S", "rootTopic": root}]}, expect_ok=expect_ok)


print("\n--- 10: palette text colour does not leak between colours ---")
f10 = f"{TMP}/navy.xmind"
regen(f10, {"title": "R", "children": [{"title": "K", "color": "navy"}]})
regen(f10, {"title": "R", "children": [{"title": "K", "color": "blue"}]})
p = props_of(topic(content(f10)[0][0], "K"))
check("navy → blue resets text to dark", p.get("fo:color") == "#1E1E1E" and p.get("svg:fill") == "#A5D8FF", p)
regen(f10, {"title": "R", "children": [{"title": "K", "color": "blue", "textColor": "#FFFFFF"}]})
check("textColor still overrides palette", props_of(topic(content(f10)[0][0], "K")).get("fo:color") == "#FFFFFF")

print("\n--- 11: null clears preserved properties ---")
f11 = f"{TMP}/unset.xmind"
regen(f11, {"title": "R", "structureClass": "org.xmind.ui.logic.right", "children": [
    {"title": "K", "color": "red", "shape": "org.xmind.topicShape.diamond", "bold": True},
    {"title": "L", "color": "green", "fontSize": 20}]})
regen(f11, {"title": "R", "structureClass": None, "children": [
    {"title": "K", "color": None}, {"title": "L", "style": None, "italic": True}]})
s11 = content(f11)[0][0]
k = props_of(topic(s11, "K"))
check("color:null removes fill/border/text", not any(x in k for x in ("svg:fill", "border-line-color", "fo:color")), k)
check("color:null keeps other preserved props", k.get("shape-class") == "org.xmind.topicShape.diamond" and
      k.get("fo:font-weight") == "bold", k)
check("style:null drops old style, keeps new keys", props_of(topic(s11, "L")) == {"fo:font-style": "italic"},
      props_of(topic(s11, "L")))
check("structureClass:null drops preserved layout", "structureClass" not in s11["rootTopic"])
regen(f11, {"title": "R", "children": [{"title": "K", "style": {"shape-class": None}}]})
check("raw style null removes one property", "shape-class" not in props_of(topic(content(f11)[0][0], "K")))

print("\n--- 12: matching moved / renamed topics ---")
f12 = f"{TMP}/move.xmind"
regen(f12, {"title": "Root", "children": [{"title": "Old", "children": [{"title": "Leaf", "color": "green"}]},
                                          {"title": "Same", "color": "purple"}]})
regen(f12, {"title": "Renamed root", "children": [{"title": "New", "children": [{"title": "Leaf"}]},
                                                  {"title": "Same"}]})
s12 = content(f12)[0][0]
check("renamed parent: child keeps style (unique title)",
      props_of(topic(s12, "New", "Leaf")).get("svg:fill") == "#B2F2BB", props_of(topic(s12, "New", "Leaf")))
check("renamed root: children still matched by path", props_of(topic(s12, "Same")).get("svg:fill") == "#D0BFFF")
regen(f12, {"title": "R", "children": [{"title": "A", "children": [{"title": "X", "color": "red"}]},
                                       {"title": "B", "children": [{"title": "X", "color": "blue"}]}]})
regen(f12, {"title": "R", "children": [{"title": "A2", "children": [{"title": "X"}]},
                                       {"title": "B2", "children": [{"title": "X"}]}]})
s12 = content(f12)[0][0]
check("ambiguous title is not guessed", "style" not in topic(s12, "A2", "X") and "style" not in topic(s12, "B2", "X"))

print("\n--- 13: read → edit → create round trip ---")
f13 = f"{TMP}/round.xmind"
regen(f13, {"title": "R", "children": [{"title": "Pic", "image": {"path": img, "width": 120}},
                                       {"title": "A", "children": [{"title": "Twin", "color": "red"}]},
                                       {"title": "B", "children": [{"title": "Twin", "color": "blue"}]}]})
rd = read(f13)[0]


def strip_style(t):  # drop the raw style copy so only id matching can restore it
    t.pop("style", None)
    for c in t.get("children", []):
        strip_style(c)


for c in rd["children"]:  # rename both parents — only ids can tell the twins apart now
    c["title"] += " (edited)"
    strip_style(c)
p = create({"path": f13, "sheets": [{"title": rd["sheetTitle"], "rootTopic": {"title": "R", "children": rd["children"]}}]},
           expect_ok=False)
check("reader output accepted by create (image src)", p.returncode == 0, p.stderr)
s13, _, names13 = content(f13)
pic = topic(s13[0], "Pic (edited)")["image"]
check("image kept with its size", pic["src"][4:] in names13 and pic["width"] == 120 and pic["height"] == 60, pic)
twins = [props_of(topic(s13[0], f"{x} (edited)", "Twin")).get("svg:fill") for x in "AB"]
check("ids pair duplicate titles exactly", twins == ["#FFC9C9", "#A5D8FF"], twins)
p = regen(f"{TMP}/fresh.xmind", {"title": "R", "image": {"src": "xap:resources/nope.png"}}, expect_ok=False)
check("unknown image src fails clearly", p.returncode != 0 and "not in the file being overwritten" in p.stderr, p.stderr)

print("\n--- 14: unreferenced resources are dropped ---")
img2 = png(f"{TMP}/pic2.png", 30, 30)
att = f"{TMP}/doc.txt"
open(att, "w").write("hello")
f14 = f"{TMP}/orphans.xmind"
regen(f14, {"title": "R", "children": [{"title": "K", "image": img}, {"title": "Doc", "attachment": att}]})
regen(f14, {"title": "R", "children": [{"title": "K", "image": img2}, {"title": "Doc", "attachment": att}]})
p = regen(f14, {"title": "R", "children": [{"title": "K", "image": False}, {"title": "Doc", "attachment": att}]})
_, man14, names14 = content(f14)
res14 = [n for n in names14 if n.startswith("resources/")]
check("only the attachment is left", len(res14) == 1 and res14[0].endswith(".txt"), res14)
check("manifest matches zip", sorted(n for n in man14["file-entries"] if n.startswith("resources/")) == res14)
check("drop is reported", "no longer referenced" in p.stderr, p.stderr)

print("\n--- 15: colour validation ---")
for name, root, rels, msg in [
    ("relationship colour name", {"title": "R", "children": [{"title": "a"}, {"title": "b"}]},
     [{"sourceTitle": "a", "targetTitle": "b", "color": "chartreuse"}], "unknown color"),
    ("fill must be hex", {"title": "R", "fill": "red"}, None, 'use "color": "red"'),
    ("lineColor must be hex", {"title": "R", "lineColor": "blue-ish"}, None, "must be a hex colour"),
    ("unknown branchLine", {"title": "R", "branchLine": "zigzag"}, None, "unknown branchLine"),
]:
    sheet = {"title": "S", "rootTopic": root}
    if rels:
        sheet["relationships"] = rels
    p = create({"path": f"{TMP}/bad.xmind", "sheets": [sheet]}, expect_ok=False)
    check(name, p.returncode != 0 and msg in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "theme": {"map": {"background": "white"}},
            "rootTopic": {"title": "R"}}]}, expect_ok=False)
check("theme colours validated", p.returncode != 0 and "background" in p.stderr, p.stderr)
f15 = f"{TMP}/relpal.xmind"
create({"path": f15, "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [{"title": "a"}, {"title": "b"}]},
        "relationships": [{"sourceTitle": "a", "targetTitle": "b", "color": "teal"}]}]})
check("relationship palette name → border shade",
      content(f15)[0][0]["relationships"][0]["style"]["properties"]["line-color"] == "#0C8599")

print("\n--- 16: SVG sizes ---")
for fname, svg, want in [
    ("pct.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 800 400"/>', (300, 150)),
    ("px.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='120px' height='60px'/>", (120, 60)),
    ("wonly.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0,0,100,50"/>', (200, 100)),
]:
    path = f"{TMP}/{fname}"
    open(path, "w").write(svg)
    fo = f"{TMP}/svg.xmind"
    regen(fo, {"title": "R", "image": path}, preserveStyles=False)
    im = content(fo)[0][0]["rootTopic"]["image"]
    check(f"svg {fname} → {want}", (im["width"], im["height"]) == want, im)
p = regen(f"{TMP}/bad.xmind", {"title": "R", "image": {"path": img, "width": -5}}, expect_ok=False)
check("negative image width fails", p.returncode != 0 and "positive number" in p.stderr, p.stderr)
p = regen(f"{TMP}/bad.xmind", {"title": "R", "image": f"{TMP}/missing.png"}, expect_ok=False)
check("missing image file fails clearly", p.returncode != 0 and "image file not found" in p.stderr, p.stderr)

print("\n--- 17: detached topics keep their style ---")
f17 = f"{TMP}/flow.xmind"
flow = lambda extra: create({"path": f17, "sheets": [{"title": "Flow", "freePositioning": True,
    "rootTopic": {"title": "Start"}, "detachedTopics": [{"title": "Step", "position": {"x": 0, "y": 200}, **extra}]}]})
flow({"color": "orange"})
flow({})
dt = content(f17)[0][0]["rootTopic"]["children"]["detached"][0]
check("detached style preserved", props_of(dt).get("svg:fill") == "#FFD8A8", props_of(dt))

print("\n--- 18: input validation ---")
p = regen(f"{TMP}/num.xmind", {"title": 2024, "children": [{"title": 1}, {"title": "x", "linkToTopic": 1}]},
          expect_ok=False)
check("numeric titles accepted (incl. link by number)", p.returncode == 0, p.stderr)
p = regen(f"{TMP}/bad.xmind", {"title": "R", "children": [{"name": "oops"}]}, expect_ok=False)
check("missing title names its location", p.returncode != 0 and 'child 1 of "R"' in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": []}, expect_ok=False)
check("empty sheets fails", p.returncode != 0 and "non-empty array" in p.stderr, p.stderr)
p = create({"path": f"{TMP}/bad.xmind", "sheets": [{"title": "S", "theme": 5, "rootTopic": {"title": "R"}}]},
           expect_ok=False)
check("bad theme type fails", p.returncode != 0 and "preset name" in p.stderr, p.stderr)
p = create({"path": f1, "sheets": [{"title": "S", "rootTopic": {"title": "Root"}}]})
check("carried thumbnail flagged as possibly stale", "may no longer match" in p.stderr, p.stderr)

print("\n--- 19: preview robustness ---")
if have_pil:
    f19 = f"{TMP}/contrast.xmind"
    create({"path": f19, "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
        {"title": "Unreadable", "fill": "#A5D8FF", "textColor": "#FFFFFF"}, {"title": "Fine", "color": "blue"}]}}]})
    p = subprocess.run([sys.executable, f"{SCRIPTS}/preview_xmind.py", f19, "--out-dir", f"{TMP}/prev"],
                       capture_output=True, text=True)
    check("low contrast warned", "low text contrast" in p.stdout and "Unreadable" in p.stdout, p.stdout)
    check("readable palette not warned", "'Fine'" not in p.stdout, p.stdout)
    code = ("import sys; sys.path.insert(0, sys.argv[1]); import preview_xmind as p; "
            "p.FONT_CANDIDATES = {False: [], True: []}; p.SYMBOL_FALLBACKS = []; "
            "sys.argv = ['preview', sys.argv[2], '--out-dir', sys.argv[3]]; p.main()")
    p = subprocess.run([sys.executable, "-B", "-c", code, SCRIPTS, f1, f"{TMP}/prev-nofont"],
                       capture_output=True, text=True)
    check("preview works without system fonts", p.returncode == 0, p.stderr[-300:])
else:
    print("  SKIP: Pillow not installed")

print("\n--- 20: XMind-format fixes (found by opening files in XMind 27) ---")
f20 = f"{TMP}/summary.xmind"
regen(f20, {"title": "R", "children": [{"title": "P", "children": [{"title": "a"}, {"title": "b"}],
     "summaryTopics": [{"range": "(0,1)", "title": "Sum", "shape": "curly", "lineColor": "#1971C2"}],
     "boundaries": [{"range": "(0,1)", "title": "Box", "shape": "waves", "fill": "#FFF5F5"}]}]})
pt = topic(content(f20)[0][0], "P")
check("summary topic lives in children.summary", [t["title"] for t in pt["children"].get("summary", [])] == ["Sum"]
      and "summary" not in pt, pt.keys())
check("summary → children.summary id matches", pt["summaries"][0]["topicId"] == pt["children"]["summary"][0]["id"])
check("summary / boundary styles", pt["summaries"][0]["style"]["properties"]["shape-class"] == "org.xmind.summaryShape.curly"
      and pt["boundaries"][0]["style"]["properties"]["shape-class"] == "org.xmind.boundaryShape.waves")
check("reader finds summary title", read(f20)[0]["children"][0]["summaries"][0].get("topicTitle") == "Sum")
f20b = f"{TMP}/arrow.xmind"
create({"path": f20b, "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [{"title": "a"}, {"title": "b"}]},
        "relationships": [{"sourceTitle": "a", "targetTitle": "b", "arrowEnd": "antTriangle"}]}]})
check("antTriangle alias → antiTriangle", content(f20b)[0][0]["relationships"][0]["style"]["properties"]
      ["arrow-end-class"] == "org.xmind.arrowShape.antiTriangle")
f20c = f"{TMP}/legacy-styles.xmind"
p = create({"path": f20c, "format": "legacy", "sheets": [{"title": "S", "rootTopic": {"title": "R", "children": [
    {"title": "D", "shape": "org.xmind.topicShape.diamond", "color": "red"}, {"title": "E"}]},
    "relationships": [{"sourceTitle": "D", "targetTitle": "E", "pattern": "dash"}]}]})
with zipfile.ZipFile(f20c) as z:
    cx, sx = z.read("content.xml").decode(), z.read("styles.xml").decode()
    mx = z.read("META-INF/manifest.xml").decode()
check("legacy: style-id refs, no inline <style>", "style-id=" in cx and "<style>" not in cx)
check("legacy: styles.xml has shape + fill", 'shape-class="org.xmind.topicShape.diamond"' in sx and 'svg:fill="#FFC9C9"' in sx)
check("legacy: styles.xml in manifest", "styles.xml" in mx)
check("legacy: colour no longer warns", "only written" not in p.stderr, p.stderr)
rl = read(f20c)[0]
check("legacy reader resolves shape + rel style", rl["children"][0].get("shape") == "org.xmind.topicShape.diamond"
      and rl["relationships"][0].get("style", {}).get("line-pattern") == "dash", rl)

print("\n--- 21: reader output accepted verbatim ---")
f21 = f"{TMP}/verbatim.xmind"
create({"path": f21, "sheets": [{"title": "S", "freePositioning": True, "rootTopic": {"title": "R", "children": [
    {"title": "Plain", "notes": "plain note"},
    {"title": "Call", "callouts": ["bubble"]},
    {"title": "Sum", "children": [{"title": "s1"}, {"title": "s2"}], "summaryTopics": [{"range": "(0,1)", "title": "S!"}]},
    {"title": "Wide", "width": 240},
    {"title": "T1", "durationDays": 2},
    {"title": "T2", "durationDays": 3, "dependencies": [{"targetTitle": "T1", "type": "FS"}]},
    {"title": "", "fill": "#FFC009"}]},
    "detachedTopics": [{"title": "Float", "position": {"x": 300, "y": 300}}],
    "relationships": [{"sourceTitle": "Plain", "targetTitle": "Float", "title": "rel"}]}]})
rd = read(f21)[0]
p = create({"path": f"{TMP}/verbatim2.xmind", "sheets": [{"title": rd["sheetTitle"], "rootTopic": rd}]}, expect_ok=False)
check("verbatim reader output → create", p.returncode == 0, p.stderr)
if p.returncode == 0:
    a, b = read(f21)[0], read(f"{TMP}/verbatim2.xmind")[0]
    by = lambda r, t: next(c for c in r["children"] if c["title"] == t)
    check("plain note kept", by(b, "Plain").get("notes", {}).get("content") == "plain note")
    check("callout text kept", by(b, "Call").get("callouts") == [{"title": "bubble"}], by(b, "Call").get("callouts"))
    check("summary kept", by(b, "Sum").get("summaries", [{}])[0].get("topicTitle") == "S!")
    check("customWidth kept", by(b, "Wide").get("customWidth") == 240)
    check("dependency by id kept", by(b, "T2").get("dependencies", [{}])[0].get("id") == by(b, "T1")["id"])
    check("duration kept", by(b, "T2").get("duration") == 3 * 86400000)
    check("untitled topic kept", by(b, "").get("style", {}).get("svg:fill") == "#FFC009")
    check("detached + relationship kept", [d["title"] for d in b.get("detachedTopics", [])] == ["Float"] and
          len(b.get("relationships", [])) == 1 and b.get("topicPositioning") == "free", b.keys())

print("\n--- 22: XMind-only data carried over on regenerate ---")
f22 = f"{TMP}/carry.xmind"
regen(f22, {"title": "R", "children": [{"title": "Num", "children": [{"title": "x"}]}, {"title": "Rich"}]})
with zipfile.ZipFile(f22) as z:
    files = {n: z.read(n) for n in z.namelist()}
c22 = json.loads(files["content.json"])
c22[0]["style"] = {"id": "bg", "properties": {"svg:fill": "#0C0029FF"}}      # background set in XMind
c22[0]["compactLayoutModeLevel"] = 1
num = topic(c22[0], "Num")
num["extensions"] = [{"provider": "org.xmind.ui.numbering", "content": {"numberFormat": "org.xmind.numbering.arabic"}}]
num["customWidth"] = 180
topic(c22[0], "Rich")["attributedTitle"] = [{"text": "Ri"}, {"text": "ch", "fo:font-weight": "bold"}]
files["content.json"] = json.dumps(c22).encode()
with zipfile.ZipFile(f22, "w") as z:
    for n, d in files.items():
        z.writestr(n, d)
regen(f22, {"title": "R", "children": [{"title": "Num", "children": [{"title": "x"}]}, {"title": "Rich"}]})
c22 = content(f22)[0][0]
check("sheet background kept", c22.get("style", {}).get("properties", {}).get("svg:fill") == "#0C0029FF")
check("compact layout kept", c22.get("compactLayoutModeLevel") == 1)
num = topic(c22, "Num")
check("numbering extension kept", [e["provider"] for e in num.get("extensions", [])] == ["org.xmind.ui.numbering"])
check("customWidth kept", num.get("customWidth") == 180)
check("rich title kept while text unchanged", len(topic(c22, "Rich").get("attributedTitle", [])) == 2)
regen(f22, {"title": "R", "children": [{"title": "Num"}, {"title": "Richer"}]})
check("rich title dropped when text changes", "attributedTitle" not in topic(content(f22)[0][0], "Richer"))

print("\n--- 22b: numberChildren ---")
f22b = f"{TMP}/numbering.xmind"
regen(f22b, {"title": "R", "numberChildren": "arabic", "children": [
    {"title": "A", "numberChildren": {"pattern": "lower", "tiered": True}, "children": [{"title": "a1"}]}, {"title": "B"}]})
c = content(f22b)[0][0]
num = lambda t: next((e["content"] for e in t.get("extensions", []) if e["provider"] == "org.xmind.ui.numbering"), None)
check("children numbered arabic", num(topic(c, "A")) == {"pattern": "numeral-arabic", "tiered": False} and
      num(topic(c, "B")) == {"pattern": "numeral-arabic", "tiered": False})
check("tiered lower", num(topic(c, "A", "a1")) == {"pattern": "alphabet-lowercase", "tiered": True})
regen(f22b, {"title": "R", "children": [{"title": "A"}, {"title": "B"}]})
check("numbering carried over on regenerate", num(topic(content(f22b)[0][0], "B")) is not None)
regen(f22b, {"title": "R", "numberChildren": False, "children": [{"title": "A"}, {"title": "B"}]})
check("numberChildren:false removes it", num(topic(content(f22b)[0][0], "B")) is None)
p = regen(f"{TMP}/bad.xmind", {"title": "R", "numberChildren": "greek", "children": [{"title": "x"}]}, expect_ok=False)
check("unknown numbering fails", p.returncode != 0 and "numberChildren" in p.stderr, p.stderr)

shutil.rmtree(TMP, ignore_errors=True)

print("\n" + "=" * 60)
print(f"Results: {passed} passed, {len(failed)} failed")
for f in failed:
    print("  -", f)
sys.exit(1 if failed else 0)
