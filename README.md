<p align="center">
  <img src="assets/readme-hero-v2.png" alt="XMind Skill for Claude Code and Claude Desktop: create, read, validate and preview mind maps, illustrated as a glowing cyan network." width="100%">
</p>

# XMind Skill

https://github.com/user-attachments/assets/10ce6370-abb6-4cbf-ab64-c40b3564d07f

A [Claude Code](https://claude.com/claude-code) / Claude Desktop skill that creates, reads, validates and previews
[XMind](https://xmind.app) mind maps (`.xmind`). Ask Claude for a mind map, a project plan, a flowchart or an org
chart in plain language, or hand it an existing `.xmind` file to analyse, search, edit or export.

- **No dependencies to install.** The create and read scripts use only Node.js built-ins; the optional preview
  needs Python 3 with Pillow.
- **Works on the file only.** Nothing opens XMind, takes screenshots or drives a UI. Files are checked with a
  structural validator and an offline preview renderer.
- **Matches XMind's own format.** Field names, layouts, shapes, arrows, markers and the password scheme follow
  what XMind itself reads and writes.

## What it can do

**Structure.** Nested topics, plain and HTML notes, labels, markers, callouts, boundaries, summaries,
relationships, internal links, web links and file attachments. Detached topics with free positioning for
flowcharts. 30+ layouts: map, logic, org chart, tree, tree table, brace, fishbone, timeline and matrix.

**Planning.** To-do checkboxes, and planned tasks with start/due dates, durations, progress, priority and
dependencies for XMind's Gantt view.

**Styling.**
- Palette colours and exact hex colours, fonts, borders, branch lines and their patterns.
- Hand-drawn look, text highlight, underline / strike-through, letter case, alignment, fill opacity.
- Relationship colours, dashes and arrow heads.
- Themes: `clean`, `dark`, `colorful` (a colour per branch, tapered lines), `handDrawn`, or one copied from any
  other `.xmind` file (such as a map styled with one of XMind's built-in themes).

**Rich content.**
- Rich-text titles (bold, colour or highlight on part of a title).
- Images inside topics, with alignment, opacity, border and shadow.
- Stickers and illustrations from XMind's own library, read from the installed app.
- LaTeX equations: rendered to SVG by the script; XMind re-renders them when you edit them.
- Web videos (YouTube, Vimeo, bilibili), audio notes, link previews and numbering.
- Folded branches and fixed topic widths.

**Sheet extras.** Marker legend, custom marker icons, watermark (text or image), grid or dot background texture,
and file thumbnails.

**Password protection.** Writes and reads XMind's own encryption: AES-128-CBC with a PBKDF2-HMAC-SHA512 key,
plus an optional password hint.

**Safe updates.** Rewriting an existing file keeps what was done in XMind:
- the theme, per-topic colours, fonts and shapes, images and widths;
- rich-text titles, numbering and other extensions;
- the sheet background, legend and layout settings.

Topics are matched by id, then title path, then unique title. Setting a property to `null` removes it.

**Reading and analysis.**
- Full structure as JSON, with fuzzy node search, search across title, notes, labels and tasks, and task
  progress.
- Several files at once, or every file in a directory.
- The reader's output can be passed back to the create script unchanged (read → edit → write).

**Validation.** `create_xmind.mjs` checks every file it writes, and `validate` checks any file, against what XMind actually reads:
- unknown shapes, arrows and layouts;
- misplaced summary topics, dangling ids and missing resources;
- manifest problems, and legacy styles that XMind 8 ignores.

**Export.** Markdown, OPML and plain-text outlines from the read script; PNG or multi-page PDF from the preview.

**Formats.** Modern XMind (2020+, the default) and legacy XMind 8, for both reading and writing.

## Install

### Claude Code

Link the skill into your personal or project skills directory:

```bash
git clone https://github.com/roosevelt-git/xmind-skill.git
ln -s "$PWD/xmind-skill/skills/xmind" ~/.claude/skills/xmind        # all projects
# or: ln -s "$PWD/xmind-skill/skills/xmind" .claude/skills/xmind    # one project
```

### Claude Desktop

Build the skill package and upload it:

```bash
npm run build:skill        # → build/xmind-skill.zip
```

In Claude Desktop, open **Settings → Capabilities → Skills** and upload `build/xmind-skill.zip`.

## Requirements

- Node.js 18 or newer, used by `create_xmind.mjs` and `read_xmind.mjs`.
- Python 3 with Pillow (`pip install pillow`), used by `preview_xmind.py` and the preview tests. Optional.
- XMind installed locally, only for stickers and illustrations from its library (read from its `app.asar`).
  Optional; set `XMIND_APP_ASAR` if it lives somewhere unusual.

## Usage

Just ask Claude, for example:

- "Create a mind map of the main ideas in this article"
- "Make a project plan with a Gantt timeline for the launch"
- "Draw a flowchart of the login process"
- "Open roadmap.xmind and list the tasks that are still open"
- "Add a risks branch to plan.xmind and keep the existing styling"
- "Export this map to Markdown"

[`skills/xmind/SKILL.md`](skills/xmind/SKILL.md) documents the full JSON input format and every option.

### Scripts directly

```bash
S=skills/xmind/scripts

# Create
echo '{"path":"/tmp/demo.xmind","sheets":[{"title":"Demo","theme":"colorful","rootTopic":{"title":"Hello",
  "children":[{"title":"World","equation":"E = mc^2"}]}}]}' | node $S/create_xmind.mjs

# Read, validate, export
echo '{"action":"read","path":"/tmp/demo.xmind"}' | node $S/read_xmind.mjs
echo '{"action":"validate","path":"/tmp/demo.xmind"}' | node $S/read_xmind.mjs
echo '{"action":"export","path":"/tmp/demo.xmind","format":"markdown"}' | node $S/read_xmind.mjs

# Preview (PNG per sheet, or --format pdf)
python3 $S/preview_xmind.py /tmp/demo.xmind --out-dir /tmp/xmind-preview
```

## Project structure

```
skills/xmind/
  SKILL.md                  Skill definition: routing, workflow, rules (loaded on every use)
  references/               Field-by-field reference, read only when needed (topics, styling,
                            updating, flowcharts, reading)
  scripts/
    create_xmind.mjs        Create / update .xmind files; validates what it writes
    read_xmind.mjs          Read, search, validate, export, decrypt
    preview_xmind.py        Offline PNG / PDF preview and thumbnail embedding (Pillow)
    lib/                    Shared modules: zip, crypto, asar (XMind library), latex,
                            legacy-writer, validate, known (valid XMind values), util
tests/                      npm test: round-trip, complex, edge-case, styling, feature and regression suites
scripts/build-skill.sh      Builds build/xmind-skill.zip
```

## Development

```bash
npm test               # all test suites
npm run build:skill    # package the skill
```

Tests write only to temporary directories. Checks that need XMind's sticker library are skipped when XMind is
not installed.

## Limitations

- The preview approximates XMind's layout engine; it is not pixel-identical. Fishbone and brace maps, among
  others, are drawn approximately.
- Equation images come from a built-in LaTeX subset (fractions, roots, scripts, Greek letters, common operators).
  XMind renders the full equation again with MathJax once it is edited.
- There is no network access: link previews and video thumbnails use the details you provide, or a placeholder.
- XMind 8 (legacy) files cannot hold equations, videos, audio notes, link previews, rich-text titles,
  numbering, matrix columns, legends, custom markers, watermarks, textures or passwords. The script warns when
  any of these are dropped.

## License

[MIT](LICENSE)

## Acknowledgements

This project started from [apeyroux/mcp-xmind](https://github.com/apeyroux/mcp-xmind) by Alexandre Peyroux
and its contributors. Many thanks for the original XMind reader and writer and the groundwork this skill is
built on.
