# Keygraph.js

[![Tests](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml/badge.svg)](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml)

A small, dependency-free web editor for **undirected, edge-weighted graphs**. It runs entirely in
the browser — no server, no build step — and reads/writes a simple JSON format.

## About

Keygraph.js lets you:

- drag nodes and run a one-shot force-directed **auto-layout** (with undo),
- add and remove nodes, and connect nodes to add edges,
- edit edge **weights** (0–1) per edge, or select several and set them all at once,
- set a **node weight** (0–1) per node — heavier nodes draw larger and export with the weight,
- give nodes human-readable **names** and arbitrary **groups** (colors are assigned automatically),
- toggle edge-weight labels in the view, and
- **load and save** graphs as JSON via the file dialog, and **export** them to
  standard graph formats (GML, GraphML, DOT) for use in other tools.

Open `index.html` directly (works fully offline) or serve it as static files — for example via
GitHub Pages.

## Live Demo

**[dfsp-spirit.github.io/keygraphjs](https://dfsp-spirit.github.io/keygraphjs/)**

## Export

The **Export…** button in the toolbar writes the current graph to a standard
graph format that other tools can read:

- **GML** (`.gml`) — compact, plain-text format (igraph, NetworkX, Gephi, yEd).
- **GraphML** (`.graphml`) — XML with typed attributes; the most widely supported
  interchange format (NetworkX, Gephi, yEd, Cytoscape, …).
- **DOT** (`.dot`) — Graphviz's graph description language, great for rendering:
  `dot -Tpng graph.dot -o graph.png`.

Node labels, groups, edge weights and node weights are preserved in all three;
node positions (x/y) are included where the format supports them. Note that in
DOT the edge `weight` attribute also acts as a layout hint for Graphviz, and DOT
has no native node weight — it is emitted there as a custom attribute.

## Development

The editor has no build step and no runtime dependencies — it's plain HTML/CSS/JS with
[vis-network](https://visjs.github.io/vis-network/) vendored under `vendor/`.

The test suite uses [Playwright](https://playwright.dev/):

```bash
npm install
npx playwright install chromium   # once — downloads the browser
npm test
```

## Layout

- `index.html` — UI and styles
- `src/app.js` — editor logic
- `vendor/vis-network.min.js` — vendored vis-network (standalone build)
- `examples/sample_graph.json` — an example graph
- `tests/` — Playwright end-to-end tests

