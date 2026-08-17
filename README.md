# Keygraph.js

[![Tests](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml/badge.svg)](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml)

A small, dependency-free web editor for **undirected, edge-weighted graphs**. It runs entirely in
the browser — no server, no build step — and reads/writes a simple JSON format.

## About

Keygraph.js lets you:

- drag nodes and run a one-shot force-directed **auto-layout** (with undo),
- add and remove nodes, and connect nodes to add edges,
- edit edge **weights** (0–1) per edge, or select several and set them all at once,
- give nodes human-readable **names** and arbitrary **groups** (colors are assigned automatically),
- toggle edge-weight labels in the view, and
- **load and save** graphs as JSON via the file dialog.

Open `index.html` directly (works fully offline) or serve it as static files — for example via
GitHub Pages.

## Live Demo

**[dfsp-spirit.github.io/keygraphjs](https://dfsp-spirit.github.io/keygraphjs/)**

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

