opencode-vcc
============

Algorithmic conversation compaction for [OpenCode](https://opencode.ai) V2.
No LLM calls: the summary is built by pure extraction and formatting, so a
compaction costs tokens only for the messages that are actually kept.

This is a port of [pi-vcc](https://github.com/sting8k/pi-vcc) (MIT, © 2026
sting8k) from [Pi](https://github.com/earendil-works/pi-coding-agent) to
OpenCode. See `NOTICE` for attribution.

What it does
------------

OpenCode replaces a long conversation with a short summary once the context
window fills up. That summary is usually written by a model, which costs a
model call and tends to lose detail. `opencode-vcc` replaces the whole
compaction with an algorithmic one:

* A structured summary with fixed sections — `[Session Goal]`,
  `[Files And Changes]`, `[Commits]`, `[Tracked Commands]`,
  `[Outstanding Context]`, `[User Preferences]` — plus a short brief
  transcript of the most recent turns.
* Every message that is dropped gets a stable, session-global `#N` index and
  is kept on disk, so the model can get it back with the `vcc_recall` tool
  instead of it being lost.
* The tail of the conversation (the last user turn by default) is kept
  verbatim, so the model still sees the immediate context.

Usage
-----

* Compaction runs automatically when OpenCode decides to compact, and on
  `/compact`.
* `/vcc` compacts now, keeping the last user turn.
* `/vcc keep:N [prompt]` keeps the last `N` user turns (`keep:0` compacts
  everything) and sends the optional prompt to the agent afterwards.
* `/vcc-recall [query] [scope:all] [page:N]` recalls earlier parts of the
  session and injects the result into the context.

The `vcc_recall` tool is available to the agent directly:

```
vcc_recall({ query: "redis cache decision" })
vcc_recall({ range: [10, 50] })
vcc_recall({ expand: [12] })
vcc_recall({ mode: "touched" })
vcc_recall({ query: "#12:src/auth.ts" })   // file content of that entry
```

`#N` is the number shown in summary refs like `(#12)` and in recall results.

Config
------

Options are read from the plugin's `options` in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-vcc",
      "options": {
        "overrideDefaultCompaction": true,
        "smartKeepTail": true,
        "debug": false,
        "skipForProviders": [],
        "skipNativeCompactionModels": true,
        "trackCommands": []
      }
    }
  ]
}
```

* **`overrideDefaultCompaction`** (default `true`): opencode-vcc handles
  `/compact` and automatic compactions as well as `/vcc`. With `false` only
  `/vcc` is handled and OpenCode's own summarizer keeps the rest.
* **`smartKeepTail`** (default `true`): if the `keep:1` tail is under 5k
  tokens, keep as many user turns as fit in 25k. An explicit `keep:N` is
  always respected.
* **`debug`** (default `false`): write the details of each compaction (cut,
  sections, calibration) to `<tmp>/opencode-vcc-debug.json`.
* **`skipForProviders`** (default `[]`): provider ids for which opencode-vcc
  steps aside, so another compactor can handle them. Compared
  case-insensitively; checked on every compaction. `/vcc` always runs.
* **`skipNativeCompactionModels`** (default `true`): models whose provider
  compacts natively are skipped — that window is encrypted provider state, not
  text this compactor can replace.
* **`trackCommands`** (default `[]`): command names whose runs are tracked in
  the `[Tracked Commands]` section, e.g. `["ssh", "kubectl"]`. Off by default.

Install
-------

The plugin is a plain directory OpenCode can load:

```jsonc
{
  "plugins": ["/path/to/opencode-vcc"]
}
```

It is also published as a package (`opencode-vcc`) with the same default
export; point `plugins` at the package name to use it.

Development
-----------

```bash
npm install
npm run typecheck
npm test
```

Parity with pi-vcc
------------------

Ported as-is: the extraction core (goals, files, commits, preferences,
tracked commands, outstanding context), the ranked brief budget, the
normalizer, the section merge across compactions, the search / recall engine
(BM25 scoring, relative floor, result cap, drill-down, touched files), the
keep-tail logic (smart keep, token-budget cut, compact-all fallback) and the
`vcc_recall` tool surface.

Dropped, with the reason:

| pi-vcc | Why |
| --- | --- |
| `continueAfterThresholdCompact` | OpenCode resumes an interrupted run itself; the fallback continue is not needed (and was a known source of ghost turns upstream). |
| `skipCustomTypes` | OpenCode has no custom message types to skip. |
| UI toasts / notifications | The plugin context has no notification API. Compaction statistics are written to the debug file instead. |
| Branch lineage (`scope:all` forking) | OpenCode sessions are linear; `scope:'all'` is accepted and reads the same history. |
| Session-file scanning for recall | OpenCode keeps the pre-compaction messages out of the live context, so the port persists the messages it drops in the plugin's own storage instead of reading a session file. |
| `willRetry` / `overflow` reasons | The compaction hook does not expose the compaction reason; automatic and manual compactions are treated alike. |

The OpenCode-specific mapping is `firstKeptEntryId` → `metadata.keepID`:
OpenCode rebuilds the kept tail from the message named by `keepID`, so the
port sets it to the id of the first kept message. A compact-all compaction
omits `keepID` (and pins the stored recent part to nothing), so no tail
survives.

Layout
------

```
src/core/      extraction, normalization, search, formatting (host-agnostic)
src/extract/   goals, files, commits, preferences, tracked commands
src/compact/   the cut engine and the compaction hook
src/recall/    the recall window, tool and view
src/oc/        the OpenCode boundary: adapter, storage, settings, pending state
src/command/   the /vcc and /vcc-recall commands
```

License
-------

MIT. See `LICENSE` and `NOTICE`.
