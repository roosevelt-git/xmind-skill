# Reading and analysing files

Every read_xmind.mjs action with its fields and output.

## How to read and analyze XMind files

Pipe a JSON object with an `action` field to the read script:

```bash
echo '{"action": "read", "path": "/path/to/file.xmind"}' | node <skill-dir>/scripts/read_xmind.mjs
```

### Available actions

| Action | Input fields | Description |
|--------|-------------|-------------|
| `read` | `path`, `maxDepth?` | Full structure as JSON. `sheetTitle` is on each sheet's root topic; topics deeper than `maxDepth` (root = 0) are replaced by a `childCount` |
| `list` | `directory` | Recursively scan a directory for .xmind files |
| `search_files` | `pattern`, `directory` | Search for .xmind files by name or content |
| `read_multiple` | `paths` (array) | Read multiple .xmind files at once |
| `extract_node` | `path`, `searchQuery`, `includeChildren?`, `limit?` | Fuzzy title search — top 5 (or `limit`) matches; each match is the topic without its subtree (`childCount` instead) unless `includeChildren: true` |
| `extract_node_by_id` | `path`, `nodeId` | Extract a specific node by its XMind ID |
| `search_nodes` | `path`, `query?`, `searchIn?`, `caseSensitive?`, `taskStatus?` | Multi-field search; `taskStatus` filters the `query` results (AND) |
| `format_info` | `path` | Detect XMind format version (zen/legacy) and list internal files |
| `validate` | `path`, `password?` | Check the file against what XMind reads — returns `{valid, errors, warnings}` |
| `export` | `path`, `format` (`markdown` · `opml` · `text`), `output?`, `sheet?` | Outline export (to a file with `output`) |
| `list_stickers` / `list_illustrations` | `query?` | Names in XMind's own library (from the installed app; nothing is opened) |
| `decrypt` | `path`, `password`, `output` | Write an unprotected copy of a password-protected file |

Every action accepts `password` for password-protected files.

### Action details

**`read`** — Parse a complete mind map:
```bash
echo '{"action": "read", "path": "/path/to/file.xmind"}' | node <skill-dir>/scripts/read_xmind.mjs
```
Returns an array of sheets, each with a root topic containing the full tree structure including notes, labels, markers, task status, relationships, etc.

**`list`** — Find .xmind files in a directory:
```bash
echo '{"action": "list", "directory": "/Users/user/Documents"}' | node <skill-dir>/scripts/read_xmind.mjs
```

**`search_files`** — Search by filename or content:
```bash
echo '{"action": "search_files", "pattern": "project", "directory": "/Users/user"}' | node <skill-dir>/scripts/read_xmind.mjs
```
Filename matches are returned first, then content matches.

**`extract_node`** — Fuzzy search when you don't know the exact path:
```bash
echo '{"action": "extract_node", "path": "/path/to/file.xmind", "searchQuery": "Backend API"}' | node <skill-dir>/scripts/read_xmind.mjs
```
Returns top 5 matches with confidence scores. Use when exploring complex maps.

**`extract_node_by_id`** — Direct ID lookup (fastest):
```bash
echo '{"action": "extract_node_by_id", "path": "/path/to/file.xmind", "nodeId": "abc123def456"}' | node <skill-dir>/scripts/read_xmind.mjs
```

**`search_nodes`** — Advanced search with filters:
```bash
echo '{"action": "search_nodes", "path": "/path/to/file.xmind", "query": "auth", "searchIn": ["title", "notes"], "taskStatus": "todo"}' | node <skill-dir>/scripts/read_xmind.mjs
```
`searchIn` options: `title`, `notes` (plain and HTML), `labels`, `callouts`, `tasks` (the task status text). Default: `title`, `notes`, `labels`, `callouts`. `taskStatus` alone lists all `todo` / `done` topics; with a `query` it keeps only matching topics with that status; `searchIn: ["tasks"]` without a query lists every topic that has a task.

**Ranking in `extract_node`:** the exact title scores 1.0, a title containing the query 0.9, then the share of query words found in the title (words found only in an ancestor count half). Queries shorter than 3 characters must match a whole word.

`export` and `decrypt` never replace an existing `output` unless `"overwrite": true` (a symlink there is replaced, not followed); the decrypted copy, and an export of a protected map, are readable by their owner only.

All actions print compact JSON; add `"pretty": true` for indented output. `search_files` matches file names and the text people see in the map (titles, notes, labels, callouts, relationship titles), not the file's markup.

### When to use each action

- **Browsing/understanding a map**: Use `read` to get the full structure
- **Finding .xmind files**: Use `list` or `search_files`
- **Navigating to a specific topic**: Use `extract_node` (fuzzy) or `extract_node_by_id` (exact)
- **Finding content across a map**: Use `search_nodes` with appropriate `searchIn` filters
- **Filtering tasks**: Use `search_nodes` with `taskStatus: "todo"` or `"done"`
- **Comparing maps**: Use `read_multiple` to load several files at once

**Untrusted files.** A file that would unpack to more than 1 GB, has a large entry that shrank more than 100× (a "ZIP bomb"), or unpacks past its declared sizes is refused by every script before it uses much memory. Set `XMIND_MAX_UNZIPPED_MB` to raise the limit for a file you trust (this also turns off the ratio check).
