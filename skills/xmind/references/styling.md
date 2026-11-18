# Styling reference

Themes, colours, fonts, images and the per-sheet extras (legend, watermark, texture). Read this before styling a map.

## Styling: themes, colours, images

Unstyled maps open in XMind's bare default look. For anything you hand over:

- Set a sheet `theme`: `"clean"` (white canvas, navy central topic, grey connectors, dashed red relationships) or `"dark"`. Override slots with an object: `{"preset": "clean", "mainTopic": {"fontSize": 20}, "map": {"background": "#FFFFFF"}}`. Slots: `map` (`background`, `multiLineColors`), `centralTopic`, `mainTopic`, `subTopic`, `floatingTopic`, `calloutTopic`, `summaryTopic`, `relationship`, `boundary`, `summary` — topic slots take the same keys as topic styling.
- Colour topics **by meaning, not by position** (e.g. yellow = people, purple = AI, blue = process step, teal = storage, red = rule / open question) and explain the colours in the central topic's `notes`.
- Keep titles to 1–2 short lines (use `\n`); put detail in `notes`. Lines over ~40 characters make wide boxes.
- Use `labels` for cross-cutting tags you want to filter by in XMind (e.g. `"open decision"`).
- More presets: `"colorful"` (a colour per main branch, tapered lines) and `"handDrawn"` (sketch look). The map slot also takes `multiLineColors: ["#FF6B6B", "red", …]` (one colour per main branch) and `lineTapered: true`.
- Palette colours always set a matching text colour; if you combine `fill` and `textColor` yourself, keep them readable — `preview_xmind.py` warns about low-contrast titles.

```json
{
  "path": "/tmp/styled.xmind",
  "sheets": [{
    "title": "Plan",
    "theme": "clean",
    "rootTopic": {
      "title": "System",
      "structureClass": "org.xmind.ui.map.clockwise",
      "notes": "Colours: blue = step, teal = storage, red = open decision.",
      "children": [
        {"title": "Ingest", "color": "blue", "children": [
          {"title": "Fetch", "color": "blue", "ref": "fetch"},
          {"title": "Store", "color": "teal"}]},
        {"title": "Model", "color": "red", "labels": ["open decision"],
         "image": {"path": "/abs/diagram.png", "width": 240}}
      ]
    },
    "relationships": [{"sourceRef": "fetch", "targetTitle": "Model", "title": "feeds",
                       "color": "#E03131", "pattern": "dash", "arrowEnd": "triangle"}]
  }]
}
```

With `"format": "legacy"` (XMind 8) styles go to `styles.xml` as XMind 8 does, the sheet theme is folded into each topic's style, and images and the thumbnail are written too. Equations (kept as their image), videos, audio notes, link previews, rich-text titles, numbering, matrix columns, legend, custom markers, watermark, texture and password protection exist only in the modern format — the script warns when they are dropped.

## Sheet properties

| Field | Type | Description |
|-------|------|-------------|
| `title` | string (required) | Sheet title |
| `rootTopic` | topic (required) | Root topic |
| `relationships` | array | `{sourceTitle \| sourceRef, targetTitle \| targetRef, title?, shape?, color? (hex or palette name), width?, pattern?, arrowBegin?, arrowEnd?, textColor?, fontSize?, style?}` — connects two topics. `shape`: `"org.xmind.relationshipShape.curved"` (default) or `"org.xmind.relationshipShape.straight"`. `pattern`: `solid` · `dash` · `dot` · `dash-dot` · `dash-dot-dot`. Arrows: `none` · `triangle` · `normal` · `spearhead` · `antiTriangle` · `dot` · `ring` · `square` · `squarering` · `diamond` · `herringbone` · `hook` · `eye` · `doublearrow` · `attached`. More `shape`s: `angled` · `zigzag` · `flexible` · `quad` · `threePoint` (prefix `org.xmind.relationshipShape.`) |
| `theme` | preset name or object | Sheet theme — see "Styling" at the top of this file. `{"from": "/path/other.xmind", "sheet"?: 1, …slot overrides}` copies the theme (and default structures) of a sheet in another file — e.g. one styled with an XMind built-in theme |
| `legend` | `true` / `false` or `{visible?, position?: {x,y}, markers?: {markerId: "name"}}` | Marker legend shown on the canvas, with names for the markers |
| `customMarkers` | `[{id, name, image}]` | Your own marker icons (PNG/SVG); use their `id` in topic `markers` |
| `watermark` | text or `{text \| image, fontSize?, bold?, color?, opacity?, rotation?, density?: sparse \| normal \| dense}` | Canvas watermark (`false` removes one carried over) |
| `backgroundTexture` | `grid` · `dots` or `{style, color?, opacity?, density?}` | Canvas texture (`false` removes it) |
| `detachedTopics` | array of topics | Free-floating topics (require `freePositioning: true` and `position` on each topic) |
| `freePositioning` | boolean | Enable free topic positioning (for logic/flow diagrams) |

### Top-level options

| Field | Type | Description |
|-------|------|-------------|
| `path` | string (required) | Output `.xmind` path |
| `format` | string | `zen` (default) or `legacy` — see "Format compatibility" in `references/updating.md` |
| `thumbnail` | PNG path | Embed as `Thumbnails/thumbnail.png` (or use `preview_xmind.py --thumbnail`) |
| `preserveStyles` | boolean | Default `true`: keep per-topic styling from the file being overwritten (see `references/updating.md`) |
| `password` | string | Password-protect the file (XMind's own AES scheme; the thumbnail is left out). Also needed to update an existing protected file |
| `passwordHint` | string | Hint XMind shows when asking for the password (an existing hint is kept when you update the file) |
| `sourcePath` | string | "Save as": the file the input was read from, when `path` is a different file — its embedded images / attachments and styling are reused |
| `overwrite` | boolean | Replace an existing `path` even when it isn't a readable `.xmind` file (otherwise nothing is written) |
| `removePassword` | boolean | With the file's current `password`: save it **without** protection. Without it, a protected file can only be rewritten with its password — otherwise nothing is written |
