# Keygraph.js

[![Tests](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml/badge.svg)](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml)

A small, dependency-free web editor for **undirected and directed, edge-weighted graphs**. It runs
entirely in the browser — no server, no build step — and reads/writes a simple JSON format.



![keygraphjs](https://github.com/dfsp-spirit/keygraphjs/blob/main/web/img/keygraphjs.png "Screenshot of the keygraph.js user interface")


## About

Keygraph.js lets you:

- work on **undirected or directed** graphs — a toolbar toggle switches the mode
  (destructive, with confirmation); the mode is stored in the JSON and shown in the stats,
- drag nodes and run a one-shot force-directed **auto-layout** (with undo),
- add and remove nodes, and connect nodes to add edges,
- edit edge **weights** (0–1) per edge, or select several and set them all at once,
- set a **node weight** (0–1) per node — heavier nodes draw larger and export with the weight,
- give nodes human-readable **names** and arbitrary **groups** (colors are assigned automatically),
- toggle edge-weight labels in the view, and
- **load and save** graphs in JSON or standard formats (GML, GraphML) via the
  file dialog, and **export** them to GML, GraphML or DOT for other tools.

Directed edges are drawn with arrow tips; a bidirectional pair (A→B and B→A) is shown
as a single line with an arrowhead at each end, and its two weights are listed as
`0.90 | 0.30` when edge labels are on.

Open `index.html` directly (works fully offline) or serve it as static files — for example via
GitHub Pages.

## Live Demo

**[dfsp-spirit.github.io/keygraphjs](https://dfsp-spirit.github.io/keygraphjs/)**


## Running it locally

Download [a release](https://dfsp-spirit.github.io/keygraphjs/releases) and unzip it or clone this repo.

Then double-click the `index.html` file to open it with your favorite browser.


## Import & Export

**Load file…** opens graphs in JSON, **GML** and **GraphML** (the format is
auto-detected from the file content), so graphs saved by other tools load
directly. Directedness is detected from the file: GML `directed 1`, GraphML
`edgedefault="directed"`, or the JSON `directed` flag. **Export…** writes the
current graph to a standard format:

- **GML** (`.gml`) — compact, plain-text format (igraph, NetworkX, Gephi, yEd).
- **GraphML** (`.graphml`) — XML with typed attributes; the most widely supported
  interchange format (NetworkX, Gephi, yEd, Cytoscape, …).
- **DOT** (`.dot`) — Graphviz's graph description language, great for rendering:
  `dot -Tpng graph.dot -o graph.png`.

Node labels, groups, edge weights and node weights are preserved in all three;
node positions (x/y) are included where the format supports them. GML node ids
are integers, so on import they become the node ids and the labels carry the
names. Note that in DOT the edge `weight` attribute also acts as a layout hint
for Graphviz, and DOT has no native node weight — it is emitted there as a
custom attribute.

## Development

The editor has no build step and no runtime dependencies — it's plain HTML/CSS/JS with
[vis-network](https://visjs.github.io/vis-network/) vendored under `vendor/`.


### Running the tests

The test suite uses [Playwright](https://playwright.dev/):

```bash
npm install
npx playwright install chromium   # once — downloads the browser
npm test
```

### Making a release

* Log recent changes in CHANGES file
* Increase version in **both** in `src/app.js`, variable `APP_VERSION`, and in `package.json`
* Make sure tests are green locally (see `Running the tests` above)
* Push to github repo
* Make sure tests are green on CI (see `Running the tests` above)
* Run git tag to tag the release commit, push tags
* Create a release on the github repo website based on the tag



## Repo Layout

- `index.html` — UI and styles
- `src/app.js` — editor logic
- `vendor/vis-network.min.js` — vendored vis-network (standalone build)
- `examples/sample_graph.json` — an example graph
- `tests/` — Playwright end-to-end tests


## Author, Credits and License

Written by [Tim Schäfer](https://ts.rcmd.org), licensed under [MIT license](./LICENSE).

This app is built upon the great [vis-network](https://github.com/visjs/vis-network/) javascript package (also published under the MIT license).


