# Keygraph.js

[![Tests](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml/badge.svg)](https://github.com/dfsp-spirit/keygraphjs/actions/workflows/e2e.yml)

A small, dependency-free web editor for **undirected and directed, edge-weighted graphs**. It runs
entirely in the browser — no server, no build step — and reads/writes a simple JSON format and standard graph file formats.



![keygraphjs](https://github.com/dfsp-spirit/keygraphjs/blob/main/web/img/keygraphjs.png "Screenshot of the keygraph.js user interface")


## About

Keygraph.js lets you:

- Work on **undirected or directed** graphs
- Arrange nodes manually or run a one-shot force-directed **auto-layout** (with undo)
- Graph mutation: add and remove nodes and edges
- Edit edge **weights** and node weights, any real value (slider, numerical input, edit several at once)
- Give nodes human-readable **names** and arbitrary **groups** (colors are assigned automatically)
- Display options: toggle edge-weight and vertex weight labels on/off
- **Load and save** graphs in JSON or standard formats (GML, GraphML), and **export** them to GML, GraphML or DOT for other tools.
- Load example graphs from an in-built library of well-known graphs


Keygraph.js is intended for quick editing and online viewing of small to medium sized graphs. If you are interested in studying graphs or networks with many thousands or millions of nodes, need graph algorithms or advanced editing options, obviously use a proper desktop app (Cytoscape, Gephi, whatever). You can always start in Keygraph.js and switch later if needed, as we export in standard formats.


## Live Demo

**[dfsp-spirit.github.io/keygraphjs](https://dfsp-spirit.github.io/keygraphjs/)**


## Running it locally

Download [a release](https://dfsp-spirit.github.io/keygraphjs/releases) and unzip it or clone this repo.

Then double-click the `index.html` file to open it with your favorite browser.

If you prefer the terminal:

```shell
git clone https://dfsp-spirit.github.io/keygraphjs/
cd keygraphjs/
firefox index.html          # or whatever browser you fancy
```

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


