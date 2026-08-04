# 0003 — Viable TUI stacks for a 2026 terminal app

Research ticket 0003. Facts only; the winner is picked in *Language and TUI framework*.

All GitHub metadata below was read via `gh api` on **2026-08-04**. All timings were
measured on this machine (Apple M4 Pro, darwin 25.2.0, tmux / `xterm-256color`) in a
throwaway `/tmp/tuiscout.*` directory with `GOMODCACHE`, `GOCACHE` and `CARGO_HOME`
redirected into it. Nothing was installed globally.

## Summary

- **Five candidates are alive and shipping.** Go + Bubble Tea v2 (v2.0.8, 2026-07-03),
  Rust + Ratatui (v0.30.2, 2026-06-19), TS/Bun + OpenTUI (v0.5.1, released
  **today**, 2026-08-04), TS + Ink (v7.1.1, 2026-07-16), Python + Textual
  (v8.2.8, 2026-06-30). None is archived. Nothing surveyed is dead, but
  **Ink's satellite ecosystem is** — `ink-spinner`'s last release was 2023-03-01
  and its repo was last pushed 2024-08-18.
- **OSC 8 hyperlinks split the field cleanly.** Verified by capturing raw PTY bytes:
  Bubble Tea / Lipgloss **yes** (`Style.Hyperlink()`, emitted natively), OpenTUI **yes**
  (`link()` styled-text helper, emits `ESC ] 8 ; id=…`), Ink **yes** via `ink-link`
  (with tmux passthrough wrapping), Textual **yes** via Rich `[link='…']` markup.
  **Ratatui: no.** Its own issue #1028 has been open since 2024-04-12 and a maintainer
  said on **2026-08-02** it is still blocked on an unreleased Crossterm.
- **Nobody but Textual has a real collapsible tree.** Textual ships `Tree`,
  `Collapsible`, `ListView`, `OptionList` and `SelectionList` as first-class widgets.
  Bubbles has only a flat `list`; Lipgloss's `tree` package is a pure `Stringer`
  renderer with no cursor, selection or collapse state. Ratatui has no tree widget in
  `ratatui-widgets`; the third-party `tui-rs-tree-widget` is a 126-star
  one-maintainer crate. OpenTUI has `ScrollBox` + `Select` but no tree. Ink has no
  list at all.
- **Startup spans two orders of magnitude.** Time to first painted frame under a
  120x40 PTY, median of 12 runs: Ratatui **3.4 ms**, Bubble Tea **21.6 ms**, Ink
  compiled **55.5 ms**, Ink on Bun **75.3 ms**, OpenTUI on Bun **135.6 ms**,
  Textual **255.9 ms**. OpenTUI's `bun build --compile` binary was *slower*
  (321 ms) than running from source.
- **Single self-contained binary:** trivial for Go (5.0 MB) and Rust (743 KB);
  achievable but obese for TypeScript (`bun build --compile` → **62 MB** for Ink,
  **70 MB** for OpenTUI); not achievable off the shelf for Textual.
- **OpenTUI is Bun-only today.** The same program under Node 24.15.0 fails with
  `OpenTUI native FFI is not available for this runtime yet`. Its npm package ships a
  prebuilt `libopentui.dylib`, so end users do **not** need Zig.
- **`gh-dash` is the closest existing analogue** and is Go + Bubble Tea v2 + Bubbles v2
  + Lipgloss v2, YAML config via koanf, mouse zones via bubblezone. That is an
  existence proof for the exact shape of this tool, at v4.25.2 (2026-07-10).

## Findings

### Maintenance status and release cadence

Read from each project's own release list and commit log via `gh api repos/<r>/releases`
and `gh api repos/<r>/commits` on 2026-08-04.

| Project | Latest release | Date | Last push | Stars | Archived |
|---|---|---|---|---|---|
| [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea/releases) | v2.0.8 | 2026-07-03 | 2026-07-20 | 44.1k | no |
| [charmbracelet/bubbles](https://github.com/charmbracelet/bubbles/releases) | v2.1.1 | 2026-07-04 | 2026-08-02 | 8.8k | no |
| [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss/releases) | v2.0.5 | 2026-07-03 | 2026-07-26 | 11.7k | no |
| [ratatui/ratatui](https://github.com/ratatui/ratatui/releases) | ratatui-v0.30.2 | 2026-06-19 | 2026-08-03 | 22.1k | no |
| [crossterm-rs/crossterm](https://github.com/crossterm-rs/crossterm/releases) | 0.29 | **2025-04-05** | 2026-08-02 | 4.2k | no |
| [vadimdemedes/ink](https://github.com/vadimdemedes/ink/releases) | v7.1.1 | 2026-07-16 | 2026-08-03 | 39.6k | no |
| [anomalyco/opentui](https://github.com/anomalyco/opentui/releases) | v0.5.1 | **2026-08-04** | 2026-08-04 | 12.9k | no |
| [Textualize/textual](https://github.com/Textualize/textual/releases) | v8.2.8 | 2026-06-30 | 2026-07-11 | 36.8k | no |
| [rivo/tview](https://github.com/rivo/tview/releases) | v0.42.0 | **2025-08-27** | 2026-08-03 | 14.0k | no |
| [gdamore/tcell](https://github.com/gdamore/tcell/releases) | v3.4.1 | 2026-07-19 | 2026-08-02 | 5.2k | no |
| [EdJoPaTo/tui-rs-tree-widget](https://github.com/EdJoPaTo/tui-rs-tree-widget/releases) | v0.24.0 | 2026-01-09 | 2026-08-03 | 126 | no |
| [sindresorhus/terminal-link](https://github.com/sindresorhus/terminal-link) | — | — | 2025-09-08 | — | no |
| [vadimdemedes/ink-spinner](https://github.com/vadimdemedes/ink-spinner/releases) | v5.0.0 | **2023-03-01** | **2024-08-18** | 194 | no |

Notes and flags:

- **Charm v2 changed its import path.** `go get github.com/charmbracelet/bubbletea/v2`
  now fails with *"module declares its path as: charm.land/bubbletea/v2"*. The v2
  modules are `charm.land/bubbletea/v2`, `charm.land/lipgloss/v2` and
  `charm.land/bubbles/v2`. Observed while running `go get` in the temp dir.
- **Bubble Tea v2 is post-1.0 and churning fast.** v2.0.0 shipped 2026-02-24 and
  reached v2.0.8 by 2026-07-03 — eight patch releases in four months. Bubbles went
  v1.0.0 (2026-02-10) → v2.0.0 (2026-02-24) → v2.1.1 (2026-07-04) in the same window.
  The API is not settled: my first two hello-world attempts failed to compile because
  `Init()` is now `Init() tea.Cmd` and `View()` now returns `tea.View`, not `string`.
- **Ratatui is healthy but its recent `main` commits are mostly Dependabot**
  (`build(deps): bump …`, 2026-07-20 and 2026-07-21); the only non-bot commit in the
  top five is a docs change on 2026-07-25. Cadence is a minor roughly every six
  months with patches between.
- **Crossterm is the slow link in the Rust chain.** 0.29 released 2025-04-05, no
  release in ~16 months, though `main` is active (commits 2026-07-30, 2026-08-02).
  This is the direct cause of the missing hyperlink support below.
- **OpenTUI is the youngest and fastest-moving.** Still 0.x: five 0.4.x releases in
  July alone, and 0.5.0 → 0.5.1 within 13 hours on 2026-08-03/04. Expect breaking
  changes. The repo has **moved from `sst/opentui` to `anomalyco/opentui`**
  (`gh api repos/sst/opentui` returns `full_name = anomalyco/opentui`). It claims
  production use in OpenCode.
- **tview is the one stalled option**: a single release, v0.42.0 on 2025-08-27, ~11
  months ago, despite an active push date. Its foundation `tcell` is healthy (v3.4.1,
  2026-07-19). I did not build a tview prototype.
- **Ink's core is well maintained** (commits 2026-08-03) but its component ecosystem
  is not — see `ink-spinner` above.

### Grouped / nested list with collapsible sections

The requirement is a scrollable list grouped into collapsible sections (by relevance
bucket, then repo) with a detail view.

**Go + Bubble Tea.** No tree, no sections. `charmbracelet/bubbles` ships exactly these
packages: `cursor filepicker help key list paginator progress spinner stopwatch table
textarea textinput timer viewport` (repo contents listing). Its `list` is flat —
`list/` contains only `list.go`, `defaultitem.go`, `keys.go`, `style.go`, and a code
search for `section` scoped to that path returns nothing. `charmbracelet/lipgloss` has
a [`tree` package](https://github.com/charmbracelet/lipgloss/blob/main/tree/tree.go)
whose `Node` interface is `fmt.Stringer` + `Value()` + `Children()` + `Hidden()` — a
**pure renderer**, no cursor, no selection, no expand/collapse state. So a collapsible
grouped list is **hand-rolled**: flatten your groups into a row list, track
expanded-ness yourself, render into a `viewport`. This is exactly what
[gh-dash](https://github.com/dlvhdr/gh-dash) does; it composes bubbletea/bubbles/lipgloss
v2 with `github.com/lrstanley/bubblezone/v2` for mouse hit-testing (from its
[`go.mod`](https://github.com/dlvhdr/gh-dash/blob/main/go.mod)).

**Rust + Ratatui.** No tree either. `ratatui-widgets/src` contains `barchart block
borders calendar canvas chart clear fill gauge list logo mascot paragraph scrollbar
sparkline table tabs` — `List` is flat, `Table` is flat. The community answer is
[`tui-rs-tree-widget`](https://github.com/EdJoPaTo/tui-rs-tree-widget) (v0.24.0,
2026-01-09), which does give expand/collapse, but it is a 126-star single-maintainer
crate whose releases lag Ratatui minors. Otherwise: hand-rolled flatten-and-render,
same as Bubble Tea.

**TS + Ink.** Weakest of all. Ink's component surface is `<Text> <Box> <Newline>
<Spacer> <Static> <Transform>` plus hooks (`useInput usePaste useApp useStdin
useStdout useBoxMetrics useFocus useFocusManager useCursor useAnimation useWindowSize
useIsScreenReaderEnabled`) — from the
[README table of contents](https://github.com/vadimdemedes/ink#readme). There is no
list, no table, no tree. Everything is composed from flexbox `<Box>`. The upside is
that a collapsible section is a natural React conditional render; the downside is you
build scrolling, selection and viewport clipping yourself.

**TS/Bun + OpenTUI.** Closest of the non-Python options. `@opentui/core` ships
renderables `Box ScrollBox ScrollBar Select TabSelect TextTable Input Textarea Markdown
Code Diff Image ASCIIFont Slider FrameBuffer`
([`packages/core/src/renderables`](https://github.com/anomalyco/opentui/tree/main/packages/core/src/renderables),
with matching docs under `packages/web/src/content/docs/components/`). `ScrollBox` +
`Select` gets you a scrollable selectable list for free; grouping and collapse are
still hand-rolled, but from a much higher floor. React and Solid reconcilers exist
(`@opentui/react`, `@opentui/solid`).

**Python + Textual.** The only stack where this is a first-class widget.
`textual/widgets` contains `_tree.py`, `_collapsible.py`, `_list_view.py`,
`_list_item.py`, `_option_list.py`, `_selection_list.py` and their public re-exports
([widgets listing](https://github.com/Textualize/textual/tree/main/src/textual/widgets)).
My prototype built a `Tree` with a root, a repo node and a PR leaf in five lines and it
rendered. This is the one place where the requirement is a library call rather than a
feature you write.

### OSC 8 terminal hyperlinks

Method: run each prototype under a real 120x40 PTY with `TERM=xterm-256color`, capture
raw bytes, grep for the OSC 8 introducer. Harness = `/tmp/tuiscout.*/cap.py`
(Python `pty.openpty` + `TIOCSWINSZ`).

| Stack | OSC 8 | Evidence |
|---|---|---|
| Bubble Tea + Lipgloss | **First-class** | `Style.Hyperlink(link, params...)` at [`lipgloss/set.go:820`](https://github.com/charmbracelet/lipgloss/blob/main/set.go); documented in the [README "Hyperlinks" section](https://github.com/charmbracelet/lipgloss#hyperlinks): *"In unsupported terminals this will degrade gracefully and hyperlinks will simply not render."* `lipgloss.Wrap` preserves hyperlinks across line boundaries. Captured output contained `ESC ] 8 ; ; https://github.com/o/r/pull/1 BEL PR #1 ESC ] 8 ; ; BEL`. Underlying encoder: [`charmbracelet/x/ansi/hyperlink.go`](https://github.com/charmbracelet/x/blob/main/ansi/hyperlink.go). |
| OpenTUI | **First-class** | `link()` styled-text helper exported from `@opentui/core` (used in [`packages/examples/src/link-demo.ts`](https://github.com/anomalyco/opentui/blob/main/packages/examples/src/link-demo.ts); implemented in `packages/core/src/utils.ts` and `renderables/TextNode.ts`). There is also `packages/core/src/lib/detect-links.ts` for auto-linkifying bare URLs. Captured output contained `ESC ] 8 ; id=65599 ; https://github.com/o/r/pull/1 ST` — note the `id=` parameter, which correctly groups a link split across wrapped lines. Caveats: open issue [#869 "OSC 8 hyperlink labels are not clickable"](https://github.com/anomalyco/opentui/issues/869) (2026-03-24) and [#864](https://github.com/anomalyco/opentui/issues/864) (`file://` links execute files — wants a click handler). |
| Ink | **Via a package** | Core Ink has no link component. `ink-link@5.0.0` (wrapping `terminal-link`, repo last pushed 2025-09-08) works: captured bytes show tmux passthrough wrapping around the OSC 8 sequence. It *degrades by printing the URL as plain text* when it cannot detect support — which is what happened when I piped stdout to a file instead of a PTY. |
| Ratatui | **Not supported** | [Issue #1028 "Support styling as a hyperlink"](https://github.com/ratatui/ratatui/issues/1028), open since 2024-04-12; last comment **2026-08-02**: *"No, Crossterm is moving toward a release but hasn't done it yet."* Related design discussion [#1227](https://github.com/ratatui/ratatui/issues/1227) (open since 2024-07-12, last substantive comment 2025-10-07) proposes a `Sequence { style, osc_8 }` type — not implemented. Empirically my Ratatui prototype produced `HAS_OSC8: False`. The blocker is structural: Ratatui's `Buffer` is a grid of styled cells and `Style` is `Copy`, so a per-cell URI string does not fit. Escapes embedded in cell content are treated as characters, so raw emission does not work; a workaround means bypassing the Ratatui buffer for those cells. |
| Textual | **Works** | Rich markup `[link='https://…']Open PRs[/link]` inside a `Static`; captured `HAS_OSC8: True`. Encoder is [`rich/style.py`](https://github.com/Textualize/rich/blob/master/rich/style.py). Note the Textual CSS `link-color` / `link-style` properties target *Textual actions*, not OSC 8 — the OSC 8 path is Rich markup. Textual 8's markup parser requires the URL to be quoted; unquoted `[link=https://…]` raises `MarkupError: Expected markup value`. |

### Distribution and binary size

Measured by building each hello-world in the temp dir.

| Stack | What the user installs | Single binary | Size |
|---|---|---|---|
| Go + Bubble Tea | one file | **yes**, `go build` | **5,246,306 B (5.0 MB)**, static, no runtime dep |
| Rust + Ratatui | one file | **yes**, `cargo build --release` | **760,640 B (743 KB)** |
| TS + Ink (Bun) | one file | **yes**, `bun build --compile` | **65,311,970 B (62 MB)** |
| TS + Ink (Node) | Node >= 20 plus a bundle | no | bundle 1,951,103 B; `node_modules` 22 MB |
| TS + OpenTUI (Bun) | one file | **yes**, `bun build --compile` | **73,138,658 B (70 MB)** |
| Python + Textual | Python plus a venv | not off the shelf | venv 11 MB |

Details:

- Bun's compile floor is 63,446,114 B for a `console.log("hi")` — the runtime itself is
  ~60 MB, so Ink adds only ~2 MB and OpenTUI ~10 MB on top. Compiling is fast:
  `[21ms] bundle 541 modules / [317ms] compile` for Ink.
- **OpenTUI does not require Zig for consumers.** The README says *"You must have Zig
  installed on your system to build the packages"*, but that is for building the repo.
  `bun add @opentui/core` pulled a prebuilt
  `node_modules/@opentui/core-darwin-arm64/libopentui.dylib` — 12 packages, 48 MB on
  disk, 3.5 s install.
- **OpenTUI is Bun-only right now.** Bundling for Node and running gave:
  `Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not
  available for this runtime yet` (`@opentui/core` 0.5.1, Node 24.15.0). Its
  `package.json` declares a `#opentui/runtime-assets` node condition, so Node support
  is clearly intended, but it does not work today.
- **Ink needs one packaging workaround.** `bun build --compile` fails with
  `Could not resolve: "react-devtools-core"` from `ink/build/devtools.js` unless you
  install that package or mark it external.
- **Ratatui 0.30 will not build with the toolchain on this machine.** `cargo add
  ratatui` resolved to **0.29.0**, not 0.30.2, reporting *"Adding ratatui v0.29.0
  (available: v0.30.2, requires Rust 1.88.0)"* against the installed `rustc 1.84.1`.
  Even 0.29 failed until I pinned `instability@0.3.7`, `unicode-segmentation@1.12.0`
  and `darling@0.20.10`. Choosing Rust means upgrading the toolchain first.
- Go needed no pinning; the toolchain here is `go1.26.5 darwin/arm64`.

### Startup time

Two harnesses, both written into `/tmp/tuiscout.*`:

- `bench.py CMD` — wall clock around `subprocess.run`, 3 warm-ups then 20 runs, no PTY.
  The harness's own floor, measured against `/usr/bin/true`, is **min 1.8 ms /
  median 2.2 ms**; subtract that for a true process cost.
- `ttfm.py NEEDLE CMD` — spawns under `pty.openpty()` sized 120x40 via `TIOCSWINSZ` and
  stops the clock when `NEEDLE` first appears in the output stream, i.e. **time to
  first painted frame**. 3 warm-ups then 12 runs; median reported.

Runtime floors (`bench.py`, no PTY; `console.log("hi")` / `fmt.Println` / `println!`):

| Command | min | median |
|---|---|---|
| `python3 bench.py ./rshi/target/release/rshi` (Rust) | 2.4 ms | **3.0 ms** |
| `python3 bench.py ./gohi/hi` (Go) | 3.3 ms | **3.9 ms** |
| `python3 bench.py ./hi-compiled` (`bun build --compile`) | 10.4 ms | **11.4 ms** |
| `python3 bench.py bun hi.js` | 11.1 ms | **12.8 ms** |
| `python3 bench.py node hi.js` | 23.5 ms | **25.8 ms** |
| `python3 bench.py /usr/bin/true` (harness overhead) | 1.8 ms | 2.2 ms |

Real TUI, time to first painted frame (`ttfm.py`, 120x40 PTY):

| Command | min | median |
|---|---|---|
| `python3 ttfm.py 'PR' ./rt/target/release/rtdemo` (Ratatui 0.29) | 2.8 ms | **3.4 ms** |
| `python3 ttfm.py 'PR #1' ./bt/btdemo` (Bubble Tea v2.0.8 + Lipgloss v2.0.5) | 21.1 ms | **21.6 ms** |
| `python3 ttfm.py 'Open PRs' ./inkapp/inkbin` (Ink 7.1.1, bun-compiled) | 51.8 ms | **55.5 ms** |
| `python3 ttfm.py 'Open PRs' bun run inkapp/app.tsx` (Ink 7.1.1) | 68.3 ms | **75.3 ms** |
| `python3 ttfm.py 'Open PRs' bun run otui/app.ts` (OpenTUI 0.5.1) | 107.3 ms | **135.6 ms** |
| `python3 ttfm.py 'Open PRs' ./venv/bin/python tx/app.py` (Textual 8.2.8) | 242.6 ms | **255.9 ms** |
| `python3 ttfm.py 'Open PRs' ./otui/otuibin` (OpenTUI 0.5.1, bun-compiled) | 292.5 ms | **321.4 ms** |

Reading these numbers:

- **Bubble Tea pays ~18 ms over a bare Go binary** (21.6 ms vs 3.9 ms). The captured
  PTY bytes show why: it opens with synchronised-output and Kitty-keyboard capability
  queries (`CSI ? 2026 $p`, `CSI ? 2027 $p`, `CSI > 4 ; 2 m`, `CSI = 1 ; 1 u`,
  `CSI ? u`) whose replies it waits on before painting.
- **Ratatui pays essentially nothing** over a bare Rust binary — it just writes.
- **OpenTUI's compiled binary is 2.4x slower to first frame than `bun run`**
  (321 ms vs 136 ms). Consistent with the standalone binary extracting its embedded
  `libopentui.dylib` on every launch. That is a real regression for a
  many-times-a-day tool and worth re-measuring against a later 0.x.
- **Textual at 256 ms** is CPython import cost, not rendering.
- **Node 24.15.0 cannot run Ink source directly.** `node --experimental-strip-types
  app.tsx` fails with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx"` —
  type stripping does not cover JSX. A Node-hosted Ink app needs a build step; Bun runs
  the `.tsx` directly. For completeness, `node inkapp/bundle.mjs` measured 110 ms min /
  120 ms median to *first byte* (not first frame), so it is not comparable to the
  table above; I list it only as a rough Node-hosting cost.
- Caveat on the venv: `uv venv` selected **CPython 3.11.11**, not the 3.14.6 recorded
  in the map (`python3 -m venv` failed with an `ensurepip` error on the 3.14 install).
  The 255.9 ms figure is 3.11.

### Ecosystem for the boring parts

**Config parsing.**

- Go: [`BurntSushi/toml`](https://github.com/BurntSushi/toml) is alive (pushed
  2026-06-27, 5.0k stars). For YAML, note **`go-yaml/yaml` is archived** (last push
  2025-04-01); the live successor is `go.yaml.in/yaml/v3`, which is what gh-dash
  depends on, alongside `github.com/knadh/koanf/parsers/yaml` for layered config.
- Rust: `serde` + `toml`. Note **`toml-rs/toml-rs` is archived** (last push
  2022-09-23); the maintained crate lives at `toml-rs/toml`.
- Bun: **TOML is built in.** Verified — `import cfg from "./cfg.toml"` under `bun run`
  printed `{"a":1,"b":{"c":"x"}}`. No dependency at all. YAML needs the `yaml` package.
- Node: no built-in TOML.
  `node -e 'console.log(typeof require("node:util").parseTOML)'` prints `undefined` on
  24.15.0. (`--experimental-config-file` exists but configures Node itself, not your
  app.)
- Python: `tomllib` has been in the stdlib since 3.11; YAML needs PyYAML.

**Concurrent fetches across N repos.**

- Go: `golang.org/x/sync/errgroup` — and `golang.org/x/sync` is already pulled in
  transitively by Bubble Tea v2 (observed in `go get` output: `go: added
  golang.org/x/sync v0.21.0`). Bounded concurrency is `errgroup.SetLimit`. Feeding
  results into the UI is idiomatic: a goroutine sends `tea.Msg` values.
- Rust: `tokio` (32.8k stars, pushed 2026-07-31) plus
  `futures::stream::buffer_unordered`. Ratatui is sync and single-threaded by design,
  so you own the channel between the async runtime and the draw loop.
- TS (Bun or Node): `Promise.all` / `Promise.allSettled` natively; bounded concurrency
  needs `p-limit` or a hand-rolled semaphore. If shelling out to `gh`, Bun's
  `Bun.spawn` is the direct route.
- Python: `asyncio` — and Textual is *natively* async, so a worker that awaits and
  posts messages back to the app is the documented pattern.

**Spinners and progress.**

- Go: `bubbles/spinner` and `bubbles/progress` are in-tree, first-party, and versioned
  with the framework (v2.1.1, 2026-07-04). Least friction of any option.
- Rust: `indicatif` is healthy (5.2k stars, pushed 2026-07-20) but it is a *stdout*
  progress library and does not compose with a Ratatui alternate-screen draw loop.
  Inside Ratatui you use the in-tree `Gauge`, or a third-party throbber widget.
- Ink: **the gap.** `ink-spinner`'s last release is v5.0.0 on **2023-03-01** and its
  repo was last pushed **2024-08-18** — stalled against an Ink that has since shipped
  v6 and v7. Ink 7 does ship a `useAnimation` hook, so hand-rolling a spinner is
  straightforward, but the off-the-shelf answer is stale. `ink-select-input` is in
  better shape (v6.2.0, 2025-04-29) but still predates Ink 7.
- OpenTUI: no spinner in the renderables list; you animate a `Text` yourself. There is
  a `TimeToFirstDraw` renderable, which at least suggests the project cares about
  startup latency.
- Textual: `LoadingIndicator` and `ProgressBar` are first-party widgets.

### One more datapoint: the existing analogue

[`dlvhdr/gh-dash`](https://github.com/dlvhdr/gh-dash) (12.2k stars, v4.25.2 on
2026-07-10, pushed 2026-08-01) is a GitHub PR and issue dashboard TUI — almost exactly
this tool's shape. Its [`go.mod`](https://github.com/dlvhdr/gh-dash/blob/main/go.mod)
pins `charm.land/bubbletea/v2 v2.0.2`, `charm.land/bubbles/v2 v2.0.0`,
`charm.land/lipgloss/v2 v2.0.1`, `charm.land/glamour/v2 v2.0.0`,
`github.com/lrstanley/bubblezone/v2 v2.0.0`, `github.com/knadh/koanf/parsers/yaml
v1.1.0` and `gopkg.in/yaml.v3`. Its internal layout is
`internal/{config,data,git,shell,tui,utils}` and its README states *"Control every
setting with a YAML config file."* It is a working reference implementation of the Go +
Bubble Tea answer, including the hand-rolled grouped-section problem.

## Comparison table

| Axis | Go + Bubble Tea v2 | Rust + Ratatui | TS/Bun + OpenTUI | TS + Ink | Python + Textual |
|---|---|---|---|---|---|
| Latest release | v2.0.8, 2026-07-03 | 0.30.2, 2026-06-19 | 0.5.1, 2026-08-04 | 7.1.1, 2026-07-16 | 8.2.8, 2026-06-30 |
| Maturity | post-1.0, churning | stable, 0.x-versioned | **0.x, pre-1.0** | mature | mature |
| API stability risk | medium (v2 broke `Init` / `View`) | low-medium | **high** | low | low |
| Collapsible tree | hand-rolled | hand-rolled, or a 126-star crate | hand-rolled on `ScrollBox` + `Select` | fully hand-rolled | **first-class `Tree` / `Collapsible`** |
| OSC 8 hyperlink | **first-class** (`Style.Hyperlink`) | **none**, blocked on Crossterm | **first-class** (`link()`, emits `id=`) | via `ink-link` | via Rich `[link='…']` |
| Startup, first frame | 21.6 ms | **3.4 ms** | 135.6 ms (321 ms compiled) | 55.5 ms compiled, 75.3 ms from source | 255.9 ms |
| Single binary | **yes, 5.0 MB** | **yes, 743 KB** | yes, 70 MB (and slower) | yes, 62 MB | no |
| Runtime prerequisite on this box | go1.26.5 OK | **rustc 1.84.1 too old for 0.30** | Bun 1.3.14 OK; **Node fails** | Bun OK; Node needs a build step | 3.11 venv OK |
| Config parsing | BurntSushi/toml, koanf, go.yaml.in | serde + toml | **TOML built into Bun** | `yaml` package; no built-in TOML on Node | stdlib `tomllib` |
| Concurrent fetch | `errgroup`, already a dep | `tokio` + manual channel | `Promise.all` / `Bun.spawn` | `Promise.all` | `asyncio`, native to the framework |
| Spinner / progress | **in-tree in `bubbles`** | `Gauge` in-tree; `indicatif` does not compose | roll your own | **`ink-spinner` stalled since 2023** | first-party widgets |
| Existing analogue | **`gh-dash`, this exact app** | `gitui` and similar | OpenCode | many CLIs, few dashboards | many |

## Tradeoff axes

Stated plainly, so the decision can be made in one sitting:

1. **Startup latency versus component richness.** These are inversely ordered across
   the whole field. Ratatui is ~75x faster to first frame than Textual and gives you
   the least; Textual is the slowest and gives you the tree, the collapsible, the
   progress bar and the async model for free. Bubble Tea and Ink sit in between at
   21.6 ms and 55.5 ms.
2. **Hyperlinks are a hard gate, and they eliminate Ratatui.** A clickable PR URL is in
   the destination statement. Ratatui cannot do OSC 8, the blocking issue is over two
   years old, and a maintainer confirmed two days ago that it is still blocked
   upstream. Anything Ratatui-based means bypassing its buffer for link cells or
   dropping the requirement.
3. **Binary size versus runtime prerequisite.** Go and Rust give a 0.7–5 MB file with
   no prerequisite. The TypeScript options give a 62–70 MB file, or a small bundle plus
   a runtime the user must already have. Textual gives neither and needs a Python
   environment. For a personal tool this may not matter; for a Homebrew formula it does.
4. **Maturity versus momentum.** OpenTUI is the most capable TS renderer, has the best
   hyperlink implementation in this survey (it emits the `id=` parameter that keeps a
   wrapped link clickable), and shipped a release today — but it is 0.5.1, its compiled
   binary is slower than its interpreted form, and it has an open bug saying OSC 8
   labels are not clickable. Ink is boring and stable, but its component ecosystem has
   rotted around it.
5. **Nobody except Textual gives you the grouped collapsible list.** On four of five
   stacks you will write a flatten-and-track-expanded-state view yourself. That is
   perhaps 200 lines, and gh-dash proves it is tractable in Bubble Tea. The question is
   whether those 200 lines are worth 230 ms of startup.
6. **Toolchain readiness on this machine.** Go and Bun work today. Rust needs a
   toolchain upgrade before Ratatui 0.30 will even resolve. OpenTUI works on Bun and
   not on Node. Textual works, but via `uv` on 3.11, not the 3.14 recorded in the map.

## Open gaps

- **I did not build a tview or `tui-rs-tree-widget` prototype.** tview's `TreeView` is
  genuinely first-class and would change the Go picture, but tview's only release in
  the past 11 months is v0.42.0 (2025-08-27), so I treated it as stalled rather than
  investigating further. Its OSC 8 story is therefore unestablished.
- **I did not measure Textual on Python 3.14.6.** `python3 -m venv` failed with an
  `ensurepip` error and `uv venv` fell back to CPython 3.11.11. Treat 255.9 ms as an
  upper bound; 3.14 starts faster, by an amount I did not establish.
- **I did not establish the cause of OpenTUI's compiled-binary startup penalty.** The
  321 ms versus 136 ms gap is measured and reproducible, but attributing it to dylib
  extraction is my inference from the fact that the binary embeds `libopentui.dylib`.
- **I measured hello-worlds, not a realistic app.** Render cost at, say, 200 PRs across
  20 repos, and re-render cost while scrolling, is unmeasured for every candidate.
  Ratatui's buffer diffing and OpenTUI's native Zig compositor should both scale well;
  Ink's React reconciler over flexbox is the one I would expect to degrade first, and I
  have no data either way.
- **I did not verify OpenTUI's `ScrollBox` under load**, nor confirm that `Select`
  supports the disabled or header rows a grouped list needs.
- **Node support for OpenTUI is a moving target.** It fails today on 0.5.1, but the
  package ships a `node` runtime-assets condition, so it may land soon. I found no
  issue or milestone stating a date.
- **I did not check licences.** These are all MIT or Apache-2.0 as far as I know, but I
  did not read the LICENSE files, so that is unverified.
