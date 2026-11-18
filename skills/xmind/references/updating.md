# Updating existing files

How create_xmind.mjs carries over styling and XMind-only data when it rewrites a file, and how to do a read → edit → write round trip. Read this before changing a map someone already worked on.

### Updating an existing file (theme/style preservation)

If `path` points to a file that already exists (e.g. you're adding/editing a branch in a mind map someone already styled), `create_xmind.mjs` automatically preserves that file's visual theme, layout extensions, and embedded resources (like `Thumbnails/thumbnail.png`) — matched per-sheet by `title`. **Per-topic styling is preserved too**: each topic is paired with the same topic in the old file — by `id` when the input carries the ids `read_xmind.mjs` returned, otherwise by its title path from the root (the root always pairs with the old root; siblings with the same title pair by position), otherwise by title when that title occurs exactly once in both the old and the new sheet (so a moved topic or one whose parent was renamed keeps its look). Its old colours/fonts/shape, `structureClass` and image are kept. Style keys given in the input are layered on top, so a colour the user set in XMind survives unless your input sets that same property. To **remove** a carried-over property set its key to `null` (`"color": null` clears fill, border and text colour; `"shape": null`, `"structureClass": null`, `"image": false`), or pass `"style": null` to drop that topic's old style entirely. Pass `"preserveStyles": false` at the top level to rebuild all topic styling from the input only. Resource files that nothing references any more (a replaced image, the attachment of a deleted topic) are dropped. The old thumbnail is carried over as-is — refresh it with `preview_xmind.py --thumbnail` after editing.

**Read → edit → create round trip:** the topic objects `read_xmind.mjs` returns can be passed back to `create_xmind.mjs` (the root topic's `sheetTitle` is the sheet `title`). This works for XMind 8 files too — their embedded images are reused. To save the edited map under a **different** path ("save as"), add `"sourcePath": "<the file you read>"`: its embedded images, audio and attachments are reused and its styling is preserved as if it were overwritten (`sourcePassword` if it is protected and the new file is not). Everything the reader returns is accepted as-is: `id`s pair topics exactly (and `end1Id`/`end2Id` on relationships, `id` on dependencies resolve to them), sheet data the reader puts on the root topic (`relationships`, `detachedTopics`, `topicPositioning`) is moved back to the sheet, `notes.content`, `{title}` callouts, `summaries` with `topicTitle`, `duration` (ms) and `customWidth` are understood, untitled topics come back as `""`, and `image: {src: "xap:…"}` keeps the embedded image. Things the reader doesn't expose — rich-text title runs (while the title is unchanged), numbering and other topic extensions, the sheet background, compact-layout and free-positioning flags — are carried over from the old file. `style` holds the raw XMind properties — it is merged last, so when you change a read topic's colour with `color`, also delete (or edit) its `style`. An explicit sheet `theme` always replaces the old theme. You do NOT need to read the old theme, back up the file, or manually merge anything yourself; just include the unchanged sheets/branches in your input JSON (with the same sheet `title`s) alongside the new/edited content, and the script carries the styling forward.

This only applies to the modern `zen` format. If you rewrite a sheet under a **different** title than it had before, it's treated as a brand-new sheet and gets a fresh default theme — keep sheet titles stable across updates when you want styling preserved.

## Format compatibility

Both scripts handle two XMind format families:

| Format | Files inside ZIP | XMind version | Default |
|--------|-----------------|---------------|---------|
| `zen` (modern) | `content.json`, `metadata.json`, `manifest.json` | XMind Zen, XMind 2020+ | Yes |
| `legacy` (XML) | `content.xml`, `meta.xml`, `META-INF/manifest.xml` | XMind 3–8 (2008–2019) | No |

**Reading:** Auto-detects format — no configuration needed. Checks for `content.json` first (zen), then `content.xml` (legacy). All actions work on both formats.

**Creating:** Add `"format"` to the input JSON. Accepts many version aliases:

```json
{
  "path": "/tmp/old_format.xmind",
  "format": "xmind8",
  "sheets": [...]
}
```

| Alias examples | Resolved format |
|---------------|----------------|
| `"zen"`, `"json"`, `"latest"`, `"modern"`, `"new"` | Modern (JSON) |
| `"xmind2024"`, `"2024"`, `"xmind2020"`, `"2020"` | Modern (JSON) |
| `"legacy"`, `"xml"`, `"old"` | Legacy (XML) |
| `"xmind8"`, `"xmind7"`, `"xmind6"`, `"8"`, `"7"` | Legacy (XML) |
| `"2013"`, `"2012"`, `"2008"` | Legacy (XML) |
| `"pro8"`, `"pro7"` | Legacy (XML) |

**Heuristic for numeric values:** version ≤ 9 → legacy (XMind 3–8), version ≥ 10 → zen (XMind 10+), year ≤ 2019 → legacy, year ≥ 2020 → zen.

**Checking format:** Use `format_info` action to inspect an existing file:
```bash
echo '{"action": "format_info", "path": "/path/to/file.xmind"}' | node <skill-dir>/scripts/read_xmind.mjs
```

When the user says "兼容旧版" / "XMind 8格式" / "旧版本格式" / "old format" / "XMind 8 compatible" / "兼容其他编辑器", use `"format": "legacy"`. Otherwise use the default zen format.

### Password-protected files

- Pass the file's `"password"` to update it; it stays protected and keeps its hint.
- Without a password, or with a wrong one, `create_xmind.mjs` stops with an error and **does not touch the file** — it never silently writes an unprotected copy.
- To save it unprotected on purpose, pass the current `"password"` and `"removePassword": true`. XMind 8 (legacy) files can't be protected, so writing legacy over a protected file also needs `"removePassword": true`.

### A file that can't be read

If the target `path` exists but isn't a readable `.xmind` file (damaged, not a ZIP, over the size limits), nothing is written. Pass `"overwrite": true` to replace it on purpose.
