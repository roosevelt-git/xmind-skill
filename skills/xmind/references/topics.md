# Topic reference

Every field a topic accepts, plus the valid shapes, layouts, markers and task fields. Read this when you need a field the short table in SKILL.md does not list.

## JSON Input Format

```json
{
  "path": "/Users/user/Desktop/my_mindmap.xmind",
  "sheets": [
    {
      "title": "Sheet 1",
      "rootTopic": {
        "title": "Central Topic",
        "children": [
          {
            "title": "Branch 1",
            "notes": "Plain text note",
            "children": [
              { "title": "Sub-topic A" },
              { "title": "Sub-topic B" }
            ]
          }
        ]
      },
      "relationships": [
        { "sourceTitle": "Sub-topic A", "targetTitle": "Sub-topic B", "title": "related" }
      ]
    }
  ]
}
```

## Topic Properties

Each topic object supports:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string (required) | Topic title |
| `children` | array of topics | Child topics |
| `notes` | string or `{plain?, html?}` | Notes. HTML supports: `<strong>`, `<u>`, `<ul>`, `<ol>`, `<li>`, `<br>`. NOT `<code>`. |
| `href` | string | External URL link |
| `attachment` | string | Absolute path to a file to attach (embedded in the .xmind). Mutually exclusive with `href`. |
| `linkToTopic` | string | Title of another topic to link to (internal `xmind:#id` link, works across sheets) |
| `labels` | string[] | Tags/labels |
| `markers` | string[] | Marker IDs (see "Markers" below), e.g. `task-done`, `priority-1`, `flag-red` |
| `callouts` | string[] | Callout text bubbles |
| `boundaries` | `{range, title?, shape?, fill?, lineColor?, lineWidth?, pattern?}[]` | Visual grouping of children. Range: `"(start,end)"`. XMind wraps the title to the boundary's width, so keep it to a word or two on narrow groups (otherwise it is drawn one letter per line). `shape`: `roundedRect` · `rect` · `scallops` · `waves` · `tension` · `polygon` · `roundedPolygon` · `cross` · `focus` |
| `summaryTopics` | `{range, title, shape?, lineColor?, lineWidth?, pattern?}[]` | Summary topics spanning children ranges. `shape`: `round` · `square` · `curly` · `bracket` · `angle` · `sharp` · `straight` · `fold` |
| `structureClass` | string | Layout (see below) — the full name or the short form after `org.xmind.ui.` (`"logic.right"`); unknown layouts are rejected |
| `shape` | string | Topic shape (see shapes below) — full or short name (`"diamond"`); unknown shapes are rejected |
| `position` | `{x, y}` | Absolute position (only for detached topics in free-positioning sheets) |
| `ref` | string | Unique key for this topic. Reference it with `sourceRef` / `targetRef` / `linkToRef` / dependency `targetRef` — needed when titles repeat |
| `linkToRef` | string | Like `linkToTopic`, but targets a topic by `ref` |
| `color` | palette name | Fill + matching border + readable text colour: `blue`, `green`, `yellow`, `orange`, `red`, `purple`, `teal`, `pink`, `gray`, `navy` (white text), `white` |
| `fill` / `borderColor` / `textColor` | `"#RRGGBB"` | Exact colours (override `color`). Must be hex (`#RGB`, `#RRGGBB`, `#RRGGBBAA`) or `"none"` — CSS names like `"red"` are rejected |
| `borderWidth` / `fontSize` / `lineWidth` | number (pt) or `"2pt"` | Border width, font size, width of the line to this topic's children |
| `width` | number (px) | Fixed text width — long titles wrap inside it (XMind's `customWidth`) |
| `titleRuns` | `[{text, bold?, italic?, color?, highlight?, underline?, strike?, fontSize?, fontFamily?}]` | Rich-text title: parts of the title in different styles (`title` is then optional — the runs' text joined). Colours: hex or palette name |
| `folded` | boolean | Collapse the branch (children hidden until expanded in XMind) |
| `equation` | LaTeX string or `{latex, fontSize?, color?}` | Math equation (XMind's equation topic). The script renders the image itself (fractions, roots, scripts, Greek, operators); XMind re-renders with MathJax when it is edited. Give the topic `"title": ""` or a caption |
| `video` | URL or `{url, thumbnail?, embedUrl?, label?}` | Web video (YouTube / Vimeo / bilibili embed URLs are derived). Without a `thumbnail` image a play-button placeholder is drawn. Sets the topic's link and image |
| `audio` | path (`.mp3 .m4a .aac .wav .ogg .webm .flac`) | Audio note embedded in the file |
| `linkPreview` | `true` or `{url?, title?, description?, siteName?, imageUrl?, faviconUrl?, mode?}` | Link card for the topic's `href` (no network access — give the title/description yourself) |
| `matrix` | `{columns: [..], rows: [{title, cells: {column: text \| topic \| [..]}}]}` | Matrix (XMind's spreadsheet structure): rows × columns; cells become children labelled with their column |
| `handDrawn` | boolean | Sketch look for this topic: hand-drawn fill, border and branch line |
| `highlight` | `"#RRGGBB"` | Text highlight (background) colour |
| `underline` / `strike` | boolean | Underlined / struck-through title |
| `textTransform` | `manual` · `uppercase` · `lowercase` · `capitalize` | Letter case as displayed |
| `textAlign` | `left` · `center` · `right` | Alignment of multi-line titles |
| `fillOpacity` | 0–1 | Fill transparency |
| `fillPattern` | `solid` · `none` · `handDrawn` | Fill style (`none` = no fill) |
| `borderPattern` / `linePattern` | `solid` · `dash` · `dot` · `dash-dot` · `dash-dot-dot` · `handdrawn-solid` · `handdrawn-dash` · … | Border / branch-line stroke |
| `numberChildren` | `arabic` · `upper` · `lower` · `roman` or `{pattern, tiered}` | Number this topic's children "1. 2. 3." / "A. B." / "a. b." / "I. II."; `tiered: true` prefixes the parent's number ("1.a."). `false` removes numbering carried over from the existing file |
| `bold` / `italic` | boolean | Font weight / style |
| `fontFamily` | string | e.g. `"NeverMind"` (XMind's default) |
| `lineColor` | `"#RRGGBB"` | Colour of the branch lines from this topic to its children |
| `branchLine` | `curve` · `straight` · `elbow` · `roundedElbow` · `fold` · `roundedFold` · `bight` · `arrowedCurve` · `none` | Branch connector style to children |
| `style` | object or `null` | Raw XMind style properties merged last (e.g. `{"fo:text-decoration": "underline"}`); a property set to `null` is removed. `null` drops the style carried over from the existing file |
| `image` | path, `{path \| sticker \| illustration \| src, width?, height?, align?, opacity?, borderColor?, borderWidth?, shadow?}` | PNG / JPG / GIF / SVG shown inside the topic. Give one dimension to keep the aspect ratio; default width ≤ 300px. `sticker` / `illustration`: a name from XMind's own library (needs XMind installed — list them with the `list_stickers` / `list_illustrations` actions). `align`: `top` (default) · `bottom` · `left` · `right` — where the image sits next to the title. `{src: "xap:resources/…"}` (as returned by the reader) keeps an image already in the file. `false` drops an image carried over from the existing file |
| `id` | string | Optional — an id returned by `read_xmind.mjs`; only used to pair the topic with the file being overwritten (new ids are always generated) |

### Topic shapes

- `org.xmind.topicShape.roundedRect` — rounded rectangle (default)
- `org.xmind.topicShape.diamond` — diamond (use for conditions/decisions)
- `org.xmind.topicShape.ellipserect` — ellipse (use for start/end)
- `org.xmind.topicShape.rect` — rectangle
- `org.xmind.topicShape.underline` — underline only
- `org.xmind.topicShape.circle` — circle
- `org.xmind.topicShape.parallelogram` — parallelogram (use for I/O)
- Also known to XMind: `hexagon`, `roundedhexagon`, `cloud`, `document`, `database`, `decision`, `predefinedProcess`, `manualInput`, `card`, `star`, `heart`, `flag`, `shield`, `leaf`, `waterdrop`, `trapezoid`, `doubleunderline`, `noBorder` (prefix `org.xmind.topicShape.`)

### Layout structures

- `org.xmind.ui.map.clockwise` — balanced map
- `org.xmind.ui.map.unbalanced` — unbalanced map
- `org.xmind.ui.logic.right` — logic chart (right)
- `org.xmind.ui.org-chart.down` — org chart (down)
- `org.xmind.ui.tree.right` — tree (right)
- `org.xmind.ui.fishbone.leftHeaded` — fishbone
- `org.xmind.ui.timeline.horizontal` — timeline
- More (all checked against XMind 27): `map.anticlockwise`, `logic.left`, `org-chart.up`, `tree.left`, `fishbone.rightHeaded`, `brace.right` / `brace.left` (brace map), `treetable` (tree table), `timeline.vertical`, `timeline.sided.horizontal`, `timeline.through.vertical` — all prefixed `org.xmind.ui.`

### Markers

`task-start` `task-quarter` `task-half` `task-3quar` `task-done` `task-pause` · `priority-1` … `priority-9` ·
`flag-<c>` `star-<c>` `people-<c>` (c = `red` `orange` `yellow` `green` `blue` `purple` `gray` `dark-blue` `dark-green` `dark-gray`) ·
`half-star-<red|yellow|green|blue|purple|gray>` · `tag-<red|orange|yellow|green|blue|dark-blue|dark-purple|grey>` ·
`smiley-<smile|laugh|love|cry|sad|angry|surprise|think|...>` · `arrow-<up|down|left|right|up-right|refresh|...>` ·
`month-<jan…dec>` · `week-<mon…sun>`

### Task properties

**Simple checkbox** (no dates needed):
- `taskStatus`: `"todo"` or `"done"`

**Planned tasks** (for Gantt/timeline view in XMind):

| Field | Type | Description |
|-------|------|-------------|
| `progress` | number 0.0-1.0 | Completion progress |
| `priority` | number 1-9 | Priority (1=highest) |
| `startDate` | ISO 8601 string | Start date, e.g. `"2026-02-01T00:00:00Z"` |
| `dueDate` | ISO 8601 string | Due date |
| `durationDays` | number | Duration in days (preferred for relative planning). With `startDate` the due date is computed; with `dueDate` the start date |
| `dependencies` | array | `{targetTitle, type, lag?}` — type: `FS`, `FF`, `SS`, `SF` |

**Two approaches for planned tasks:**

1. **Relative (preferred):** Use `durationDays` + `dependencies`. XMind auto-calculates dates.
2. **Absolute:** Use `startDate` + `dueDate` for fixed dates.

When the user mentions "planning", "schedule", "timeline", "Gantt", "project", "phases", "排期", "甘特图", "项目计划", "时间线", "里程碑", use RELATIVE planned tasks unless specific dates are given.

Task fields are checked: `taskStatus` is `todo` or `done`, `priority` a whole number 1–9, `progress` 0–1 (other numbers are clamped), and dates must be ISO 8601 (`"2026-02-01"`, `"2026-02-01T09:00:00Z"`) — anything else is an error rather than a silent 1 January 1970.
