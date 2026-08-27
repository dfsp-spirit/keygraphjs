// Playwright tests for keygraphjs.
//
//   npm install
//   npx playwright install chromium
//   npm test
//
// The editor is a dependency-free static page, so these tests open it directly
// from disk (no dev server needed).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const EDITOR_URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

// Wait for the initial one-shot auto-layout to finish and freeze.
async function settle(page) {
  await page.waitForFunction(() =>
    document.getElementById('stats').textContent.includes('nodes')
  );
  await page.waitForTimeout(1800);
}

// The app replaces the browser-native confirm() with an in-app dialog
// (#confirmOverlay). These helpers accept / dismiss it.
async function acceptConfirm(page) {
  await page.locator('#confirmOk').click();
}
async function dismissConfirm(page) {
  await page.locator('#confirmCancel').click();
}

// Count opaque dark pixels on the network canvas. Node labels are always drawn;
// edge labels add a lot more dark text when the "Edge labels" toggle is on.
async function darkTextPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#network canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 128 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) n++;
    }
    return n;
  });
}

// Click helpers via the test hook exposed by the editor (window.__graphEditor).
// Returns viewport coordinates for each node and each edge midpoint.
async function graphPoints(page) {
  return page.evaluate(() => {
    const n = window.__graphEditor;
    const c = document.getElementById('network').getBoundingClientRect();
    const P = n.getPositions();
    const vp = (p) => ({ x: p.x + c.x, y: p.y + c.y });
    const toViewport = (x, y) => vp(n.canvasToDOM({ x, y }));

    const nodes = {};
    for (const id of Object.keys(P)) nodes[id] = toViewport(P[id].x, P[id].y);

    const ids = Object.keys(nodes).sort();
    const edgeMids = {};
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        edgeMids[a + '__' + b] = toViewport((P[a].x + P[b].x) / 2, (P[a].y + P[b].y) / 2);
      }
    }
    return { nodes, edgeMids };
  });
}

// Click along the a–b edge until a single edge (not a node) is selected.
// Edges are drawn as smooth curves, so the straight midpoint occasionally
// misses; only click points that vis-network reports as on an edge, probing a
// small perpendicular neighborhood to catch the thin curve. (In a dense graph
// a crossing edge is fine too — the count-based assertions don't care which.)
async function clickEdge(page, a, b) {
  const candidates = await page.evaluate(([a, b]) => {
    const n = window.__graphEditor;
    const c = document.getElementById('network').getBoundingClientRect();
    const P = n.getPositions();
    const vp = (pt) => ({ x: pt.x + c.x, y: pt.y + c.y });
    const toDOM = (x, y) => vp(n.canvasToDOM({ x, y }));
    const out = [];
    const ts = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
    for (const t of ts) {
      const x = P[a].x + (P[b].x - P[a].x) * t;
      const y = P[a].y + (P[b].y - P[a].y) * t;
      for (const [dx, dy] of [[0, 0], [0, 4], [0, -4], [4, 0], [-4, 0]]) {
        const d = n.canvasToDOM({ x: x + dx, y: y + dy });
        if (!n.getNodeAt(d) && n.getEdgeAt(d)) {
          const q = vp(d);
          if (out.findIndex((o) => Math.abs(o.x - q.x) < 3 && Math.abs(o.y - q.y) < 3) < 0) out.push(q);
        }
      }
    }
    return out;
  }, [a, b]);

  for (const pt of candidates) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(120);
    const ok = await page.evaluate(() => {
      const n = window.__graphEditor;
      return n.getSelectedNodes().length === 0 && n.getSelectedEdges().length === 1;
    });
    if (ok) return;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(EDITOR_URL);
  await settle(page);
});

test('loads the sample graph: 8 nodes, 28 edges', async ({ page }) => {
  await expect(page.locator('#nodeList .node-row')).toHaveCount(8);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
  await expect(page.locator('#stats')).toContainText('28 edges');
  // The startup sample is the "Two Hubs" example graph.
  await expect(page.locator('#graphName')).toHaveValue('Two Hubs');
});

test('loads a named example graph (Petersen) from the Example graphs menu', async ({ page }) => {
  await page.click('#btnExamples');
  await expect(page.locator('#exampleMenu')).toBeVisible();
  await page.locator('#exampleMenu button[data-example="petersen"]').click();
  await acceptConfirm(page);
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(10);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(15);
  await expect(page.locator('#stats')).toContainText('15 edges');
  await expect(page.locator('#graphName')).toHaveValue('Petersen graph');
});

test('cancelling an example load leaves the current graph untouched', async ({ page }) => {
  await page.click('#btnExamples');
  await page.locator('#exampleMenu button[data-example="tree"]').click();
  await dismissConfirm(page);
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(8); // sample graph unchanged
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
});

test('the DAG example loads in directed mode', async ({ page }) => {
  await page.click('#btnExamples');
  await page.locator('#exampleMenu button[data-example="dag"]').click();
  await acceptConfirm(page);
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(7);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(9);
  await expect(page.locator('#stats')).toContainText('directed');
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
});

test('the directed textbook examples load in directed mode', async ({ page }) => {
  const cases = [
    { id: 'dijkstra', nodes: 5, edges: 10, name: 'Dijkstra graph' },
    { id: 'scc', nodes: 8, edges: 14, name: 'SCC graph' },
    { id: 'flow', nodes: 6, edges: 9, name: 'Max-flow network' },
    { id: 'tournament', nodes: 5, edges: 10, name: 'Tournament (T5)' },
    { id: 'debruijn', nodes: 4, edges: 8, name: 'De Bruijn graph B(2,2)' }
  ];
  for (const c of cases) {
    await page.click('#btnExamples');
    await page.locator('#exampleMenu button[data-example="' + c.id + '"]').click();
    await acceptConfirm(page);
    await settle(page);
    await expect(page.locator('#nodeList .node-row')).toHaveCount(c.nodes);
    await expect(page.locator('#edgeList .edge-row')).toHaveCount(c.edges);
    await expect(page.locator('#stats')).toContainText('directed');
    await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
    await expect(page.locator('#graphName')).toHaveValue(c.name);
  }
});

test('adds an isolated node via the Add node menu', async ({ page }) => {
  await page.click('#btnAddNode');
  await page.locator('#addNodeMenu button[data-mode="isolated"]').click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
  await expect(page.locator('#stats')).toContainText('9 nodes');
});

test('adds a fully connected node via the Add node menu', async ({ page }) => {
  await page.click('#btnAddNode');
  await page.locator('#addNodeMenu button[data-mode="connected"]').click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
  await expect(page.locator('#stats')).toContainText('9 nodes');
  // New node C9 connects to all 8 existing nodes: 28 + 8 = 36 edges.
  await expect(page.locator('#stats')).toContainText('36 edges');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(36);
});

test('creates a new complete graph with N nodes', async ({ page }) => {
  await page.fill('#nodeCount', '5');
  await page.click('#btnNew');
  await acceptConfirm(page);
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(5);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(10);
});

test('cancelling "New complete graph" leaves the current graph untouched', async ({ page }) => {
  await page.fill('#nodeCount', '3');
  await page.click('#btnNew');
  await dismissConfirm(page);
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(8); // sample graph unchanged
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
});

test('edge labels can be turned on and off again', async ({ page }) => {
  const off = await darkTextPixels(page);

  await page.click('#btnEdgeLabels');
  await page.waitForTimeout(300);
  const on = await darkTextPixels(page);
  expect(on).toBeGreaterThan(off * 1.5); // labels appeared

  await page.click('#btnEdgeLabels');
  await page.waitForTimeout(300);
  const offAgain = await darkTextPixels(page);
  expect(offAgain).toBeLessThan(on * 0.7); // labels removed again
  expect(Math.abs(offAgain - off)).toBeLessThan(Math.max(off * 0.3, 100));
});

test('bulk-selects edges and sets a shared weight', async ({ page }) => {
  const boxes = page.locator('#edgeList .edge-row input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator('#bulkBar')).toBeVisible();
  await expect(page.locator('#bulkCount')).toHaveText('2 selected');

  await page.locator('#bulkSlider').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '0.42');

  const vals = await page.locator('#edgeList .edge-row .edge-winput').evaluateAll((els) => els.map((el) => el.value));
  expect(vals[0]).toBe('0.42');
  expect(vals[1]).toBe('0.42');

  await page.click('#btnBulkClear');
  await expect(page.locator('#bulkBar')).toBeHidden();
});

test('renaming a group changes the node color', async ({ page }) => {
  const row = page.locator('#nodeList .node-row').first();
  await row.locator('.node-edit').click(); // open the name/group editor
  const swatch = row.locator('.swatch');
  const before = await swatch.evaluate((el) => el.style.background);
  await row.locator('.node-edit-line input.group-input').fill('renamed');
  const after = await swatch.evaluate((el) => el.style.background);
  expect(after).not.toBe(before);
});

test('deleting a node removes its incident edges', async ({ page }) => {
  await page.locator('#nodeList .node-row .edge-del').last().click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(7);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(21);
});

test('clicking a node highlights all its incident edges', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.waitForTimeout(300);
  await expect(page.locator('#edgeList .edge-row.selected')).toHaveCount(7);
});

test('clicking a node highlights it in the vertex list', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.waitForTimeout(300);
  await expect(page.locator('#nodeList .node-row.selected')).toHaveCount(1);
  await expect(page.locator('#nodeList .node-row[data-id="C1"]')).toHaveClass(/selected/);
});

test('clicking empty canvas clears the vertex list highlight', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.waitForTimeout(300);
  await expect(page.locator('#nodeList .node-row.selected')).toHaveCount(1);

  // click the canvas corner farthest from every node
  const far = await page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const corners = [
      [c.x + 8, c.y + 8], [c.x + c.width - 8, c.y + 8],
      [c.x + 8, c.y + c.height - 8], [c.x + c.width - 8, c.y + c.height - 8],
    ];
    let best = corners[0], bestD = -1;
    for (const [cx, cy] of corners) {
      let minD = Infinity;
      for (const id of Object.keys(P)) {
        const vp = n.canvasToDOM(P[id]);
        minD = Math.min(minD, Math.hypot(cx - (c.x + vp.x), cy - (c.y + vp.y)));
      }
      if (minD > bestD) { bestD = minD; best = [cx, cy]; }
    }
    return { x: best[0], y: best[1] };
  });
  await page.mouse.click(far.x, far.y);
  await page.waitForTimeout(300);
  await expect(page.locator('#nodeList .node-row.selected')).toHaveCount(0);
});

test('right-clicking a node offers edit and delete actions', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C8.x, p.nodes.C8.y, { button: 'right' });
  const menu = page.locator('#contextMenu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Edit name / group');
  await expect(menu).toContainText('Delete node');
});

test('right-click delete removes the node', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C8.x, p.nodes.C8.y, { button: 'right' });
  await page.locator('#contextMenu button', { hasText: 'Delete node' }).click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(7);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(21); // C8 has 7 edges
});

test('right-clicking an edge deletes it', async ({ page }) => {
  // find a viewport point that lies on the C3–C4 edge curve (not on a node)
  const pt = await page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const vp = (x, y) => { const d = n.canvasToDOM({ x, y }); return { x: d.x + c.x, y: d.y + c.y }; };
    const rel = (x, y) => ({ x: x - c.x, y: y - c.y });
    const a = P['C3'], b = P['C4'];
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55]) {
      const q = vp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      const r = rel(q.x, q.y);
      if (!n.getNodeAt(r) && n.getEdgeAt(r)) return q;
    }
    return null;
  });
  expect(pt).not.toBeNull();
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  const menu = page.locator('#contextMenu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Delete edge');
  await menu.locator('button', { hasText: 'Delete edge' }).click();
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(27);
});

test('right-clicking empty canvas adds a node', async ({ page }) => {
  const far = await page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const corners = [
      [c.x + 8, c.y + 8], [c.x + c.width - 8, c.y + 8],
      [c.x + 8, c.y + c.height - 8], [c.x + c.width - 8, c.y + c.height - 8],
    ];
    let best = corners[0], bestD = -1;
    for (const [cx, cy] of corners) {
      let minD = Infinity;
      for (const id of Object.keys(P)) {
        const vp = n.canvasToDOM(P[id]);
        minD = Math.min(minD, Math.hypot(cx - (c.x + vp.x), cy - (c.y + vp.y)));
      }
      if (minD > bestD) { bestD = minD; best = [cx, cy]; }
    }
    return { x: best[0], y: best[1] };
  });
  await page.mouse.click(far.x, far.y, { button: 'right' });
  const menu = page.locator('#contextMenu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Add node');
  await menu.locator('button', { hasText: 'Add node' }).click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
});

test('right-click menu closes on Escape and on outside click', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y, { button: 'right' });
  await expect(page.locator('#contextMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#contextMenu')).toBeHidden();
  await page.mouse.click(p.nodes.C2.x, p.nodes.C2.y, { button: 'right' });
  await expect(page.locator('#contextMenu')).toBeVisible();
  await page.mouse.click(p.nodes.C3.x, p.nodes.C3.y); // left-click elsewhere closes it
  await expect(page.locator('#contextMenu')).toBeHidden();
});

test('clicking an edge highlights exactly that edge', async ({ page }) => {
  await clickEdge(page, 'C3', 'C4');
  await expect(page.locator('#edgeList .edge-row.selected')).toHaveCount(1);
});

test('clicking an edge after selecting a node highlights just that edge', async ({ page }) => {
  const p = await graphPoints(page);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.waitForTimeout(300);
  await expect(page.locator('#edgeList .edge-row.selected')).toHaveCount(7);

  await clickEdge(page, 'C1', 'C2');
  await expect(page.locator('#edgeList .edge-row.selected')).toHaveCount(1);
});

test('no console/page errors on load or during interactions', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.reload(); // reload with listeners attached to catch load errors
  await settle(page);
  await page.click('#btnAutoLayout');
  await settle(page);
  await page.click('#btnEdgeLabels');
  await page.click('#btnEdgeLabels');
  await page.click('#btnNodeLabels');
  await page.click('#btnNodeLabels');
  await page.click('#btnAddNode');
  await page.locator('#addNodeMenu button[data-mode="isolated"]').click();

  expect(errors).toEqual([]);
});

test('deletes an edge via its ✕ button', async ({ page }) => {
  await page.locator('.edge-row[data-key="C1__C2"] .edge-del').click();
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(27);
  await expect(page.locator('#stats')).toContainText('27 edges');
});

test('connects two nodes to add an edge', async ({ page }) => {
  await page.click('#btnAddNode'); // C9, no edges yet
  await page.locator('#addNodeMenu button[data-mode="isolated"]').click();
  // Park C9 at a clear on-screen spot: its default position (the graph
  // centroid + random offset) can land on top of another node, which would
  // make the connect click miss. Pick a corner far from every existing node.
  await page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const rect = document.getElementById('network').getBoundingClientRect();
    const spots = [
      [rect.width / 2, 30], [30, rect.height / 2],
      [rect.width - 30, rect.height - 30], [rect.width / 2, rect.height - 30],
    ];
    let best = null, bestD = -1;
    for (const [sx, sy] of spots) {
      const cp = n.DOMtoCanvas({ x: sx, y: sy });
      let minD = Infinity;
      for (const id of Object.keys(P)) {
        if (id === 'C9') continue;
        minD = Math.min(minD, Math.hypot(cp.x - P[id].x, cp.y - P[id].y));
      }
      if (minD > bestD) { bestD = minD; best = cp; }
    }
    n.moveNode('C9', best.x, best.y);
  });
  const p = await graphPoints(page);
  await page.click('#btnConnect');
  await page.mouse.click(p.nodes.C9.x, p.nodes.C9.y);
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.waitForTimeout(200);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(29);
});

test('auto-layout enables undo, undo restores', async ({ page }) => {
  await expect(page.locator('#btnUndoLayout')).toBeDisabled();
  await page.click('#btnAutoLayout');
  await page.waitForTimeout(1500); // wait for the one-shot layout to finish
  await expect(page.locator('#btnUndoLayout')).toBeEnabled();
  await page.click('#btnUndoLayout');
  await expect(page.locator('#btnUndoLayout')).toBeDisabled();
});

test('select-all checkbox selects every edge', async ({ page }) => {
  await page.check('#selectAllEdges');
  await expect(page.locator('#bulkCount')).toHaveText('28 selected');
  await page.click('#btnBulkClear');
  await expect(page.locator('#bulkBar')).toBeHidden();
});

test('renaming a node updates edge labels', async ({ page }) => {
  const row = page.locator('#nodeList .node-row').first();
  await row.locator('.node-edit').click(); // open the name/group editor
  await row.locator('.node-edit-line input[type="text"]:not([list])').fill('crown');
  await expect(page.locator('#edgeList .edge-row').first().locator('.edge-label'))
    .toHaveText('crown — C2');
});

test('saves a JSON file with name and positions', async ({ page }) => {
  await page.fill('#graphName', 'My Test Graph');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnSave'),
  ]);
  expect(download.suggestedFilename()).toBe('My_Test_Graph.json');

  const file = fs.readFileSync(await download.path(), 'utf8');
  const json = JSON.parse(file);
  expect(json.meta.name).toBe('My Test Graph');
  expect(json.nodes).toHaveLength(8);
  expect(json.edges).toHaveLength(28);
  expect(json.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
});

test('exports GML, GraphML and DOT files with edge and node weights', async ({ page }) => {
  await page.fill('#graphName', 'My Test Graph');
  const count = (text, needle) => text.split(needle).length - 1; // literal substring count
  const cases = [
    {
      fmt: 'gml', ext: 'gml', marker: 'graph [',
      nodes: (t) => count(t, '  node ['), edges: (t) => count(t, '  edge ['),
      // node weights are 0.75 (hubs) and 0.50 (leaves); edge weights are
      // 0.90/0.65/0.35/0.05, so these values only ever come from nodes.
      weights: (t) => [count(t, '0.750000'), count(t, '0.500000')],
    },
    {
      fmt: 'graphml', ext: 'graphml', marker: '<graphml',
      nodes: (t) => count(t, '<node '), edges: (t) => count(t, '<edge '),
      weights: (t) => [count(t, '<data key="d_w">0.750000</data>'), count(t, '<data key="d_w">0.500000</data>')],
    },
    {
      fmt: 'dot', ext: 'dot', marker: 'graph G {',
      // Node statements are lines starting with a quoted id that are not edges.
      nodes: (t) => t.split('\n').filter((ln) => ln.startsWith('  "') && !ln.includes(' -- ')).length,
      edges: (t) => count(t, ' -- '),
      weights: (t) => [count(t, 'weight=0.750000'), count(t, 'weight=0.500000')],
    },
  ];
  for (const c of cases) {
    await page.click('#btnExport');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(`#exportMenu button[data-format="${c.fmt}"]`),
    ]);
    expect(download.suggestedFilename()).toBe(`My_Test_Graph.${c.ext}`);
    const text = fs.readFileSync(await download.path(), 'utf8');
    expect(text).toContain(c.marker);
    expect(c.nodes(text)).toBe(8);
    expect(c.edges(text)).toBe(28);
    expect(c.weights(text)).toEqual([2, 6]); // 2 hub nodes + 6 leaf nodes
    await expect(page.locator('#exportMenu')).toBeHidden(); // menu closes after export
  }
});

test('editing a node weight updates its value and draw size', async ({ page }) => {
  const row = page.locator('#nodeList .node-row').first();
  await row.locator('input[type="range"]').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '0.77');
  await expect(row.locator('.node-winput')).toHaveValue('0.77');
  const size = await page.evaluate(() => window.__graphEditor.body.data.nodes.get('C1').size);
  // Node size maps the raw weight onto the graph's observed range (0.05..0.90).
  expect(size).toBeCloseTo(12 + 22 * ((0.77 - 0.05) / (0.90 - 0.05)), 2);
});

test('the sidebar can be resized with the drag handle', async ({ page }) => {
  const before = await page.locator('#sidebar').boundingBox();
  const handle = await page.locator('#resizer').boundingBox();
  const cx = handle.x + handle.width / 2;
  const cy = handle.y + handle.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy, { steps: 6 });
  await page.mouse.up();
  const after = await page.locator('#sidebar').boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 50);
});

test('loads a graph file', async ({ page }) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles(path.join(__dirname, 'fixtures', 'small_graph.json'));
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(3);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(3);
});

test('loads a GraphML file', async ({ page }) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles(path.join(__dirname, 'fixtures', 'A_B_hub_example.graphml'));
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(8);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
  await expect(page.locator('#graphName')).toHaveValue('A/B/hub example');
  await expect(page.locator('#nodeList .node-row').first().locator('.node-name')).toHaveText('C1');
});

test('loads a GML file', async ({ page }) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles(path.join(__dirname, 'fixtures', 'A_B_hub_example.gml'));
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(8);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
  // GML node ids are integers (0..7); the human labels (C1…) survive
  await expect(page.locator('#nodeList .node-row').first().locator('.node-name')).toHaveText('C1');
});

test('keeps out-of-range weights (5, -1, 500) verbatim and auto-ranges the sliders', async ({ page }) => {
  const json = {
    meta: { name: 'out-of-range' }, directed: false,
    nodes: [
      { id: 'A', weight: 0.5 },
      { id: 'B', weight: 5 },
      { id: 'C', weight: -1 }
    ],
    edges: [
      { source: 'A', target: 'B', weight: 5 },
      { source: 'B', target: 'C', weight: 0.3 },
      { source: 'A', target: 'C', weight: 500 }
    ]
  };
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles({ name: 'wide.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await settle(page);

  // No clamping: the precise inputs show the raw values.
  await expect(page.locator('.node-row[data-id="B"] .node-winput')).toHaveValue('5');
  await expect(page.locator('.node-row[data-id="C"] .node-winput')).toHaveValue('-1');
  await expect(page.locator('.edge-row[data-key="A__C"] .edge-winput')).toHaveValue('500');

  // Sliders auto-range to the graph's observed weight range (min..max).
  const sliderRange = await page.locator('.edge-row[data-key="A__C"] input[type="range"]').evaluate((el) => [el.min, el.max]);
  expect(sliderRange).toEqual(['-1', '500']);

  // A precise value typed into the number input commits and syncs the slider.
  const input = page.locator('.edge-row[data-key="A__B"] .edge-winput');
  await input.fill('12.34');
  await input.blur();
  await expect(input).toHaveValue('12.34');
  await expect(page.locator('.edge-row[data-key="A__B"] input[type="range"]')).toHaveValue('12.34');

  // Auto-sync: typing beyond the current max re-ranges every slider in place
  // (no manual refresh needed) and the committed slider follows immediately.
  await input.fill('9999');
  await input.blur();
  await expect(input).toHaveValue('9999');
  await expect(page.locator('.edge-row[data-key="A__B"] input[type="range"]')).toHaveValue('9999');
  const newMax = await page.locator('.edge-row[data-key="A__C"] input[type="range"]').evaluate((el) => el.max);
  expect(newMax).toBe('9999');

  // Export keeps the raw values (weight=… serialized with full precision).
  await page.click('#btnExport');
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportMenu button[data-format="gml"]'),
  ]);
  const gml = fs.readFileSync(await dl.path(), 'utf8');
  expect(gml).toContain('weight 5.000000');
  expect(gml).toContain('weight -1.000000');
  expect(gml).toContain('weight 500.000000');
  expect(gml).toContain('weight 9999.000000');
});

// ---------------------------------------------------------------------------
// Directed-graph mode
// ---------------------------------------------------------------------------

// The destructive mode toggle asks for confirmation; accept it.
async function toggleMode(page) {
  await page.click('#btnMode');
  await acceptConfirm(page);
  await settle(page);
}

test('switches to directed mode (edges doubled) and back (pairs merged with mean)', async ({ page }) => {
  await expect(page.locator('#btnMode')).toHaveText('Mode: undirected');
  await expect(page.locator('#stats')).toContainText('undirected');

  await toggleMode(page);

  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
  await expect(page.locator('#stats')).toContainText('directed');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(56); // 28 doubled
  // A bidirectional pair is shown as two directed rows.
  await expect(page.locator('.edge-row[data-key="C1__C2"] .edge-label')).toHaveText('C1 → C2');
  await expect(page.locator('.edge-row[data-key="C2__C1"] .edge-label')).toHaveText('C2 → C1');

  // Give the C1->C2 direction a different weight, then merge back: mean applies.
  await page.locator('.edge-row[data-key="C1__C2"] input[type="range"]').evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '0.30');
  await expect(page.locator('.edge-row[data-key="C1__C2"] .edge-winput')).toHaveValue('0.3');

  await toggleMode(page); // directed -> undirected
  await expect(page.locator('#btnMode')).toHaveText('Mode: undirected');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
  await expect(page.locator('.edge-row[data-key="C1__C2"] .edge-winput')).toHaveValue('0.6'); // (0.90 + 0.30) / 2
});

test('adds a fully connected node in directed mode (both directions)', async ({ page }) => {
  await toggleMode(page);

  await page.click('#btnAddNode');
  await page.locator('#addNodeMenu button[data-mode="connected"]').click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(72); // 56 + 2*8
  await expect(page.locator('#stats')).toContainText('72 edges');
});

test('connect mode adds the missing direction of a pair', async ({ page }) => {
  await toggleMode(page);

  // Remove the C1 -> C2 direction only; C2 -> C1 must remain.
  await page.locator('.edge-row[data-key="C1__C2"] .edge-del').click();
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(55);

  // Re-connect C1 -> C2; in directed mode this is a distinct edge from C2 -> C1.
  const p = await graphPoints(page);
  await page.click('#btnConnect');
  await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
  await page.mouse.click(p.nodes.C2.x, p.nodes.C2.y);
  await page.waitForTimeout(200);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(56);
});

test('deletes both directions of a collapsed pair via the context menu', async ({ page }) => {
  await toggleMode(page);

  const pt = await page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const vp = (x, y) => { const d = n.canvasToDOM({ x, y }); return { x: d.x + c.x, y: d.y + c.y }; };
    const rel = (x, y) => ({ x: x - c.x, y: y - c.y });
    const a = P['C1'], b = P['C2'];
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55]) {
      const q = vp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      const r = rel(q.x, q.y);
      if (!n.getNodeAt(r) && n.getEdgeAt(r)) return q;
    }
    return null;
  });
  expect(pt).not.toBeNull();
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  const menu = page.locator('#contextMenu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Delete edge (both directions)');
  await menu.locator('button', { hasText: 'both directions' }).click();
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(54); // 56 - 2
});

test('exports a directed graph as GML, GraphML and DOT', async ({ page }) => {
  await toggleMode(page);

  const count = (text, needle) => text.split(needle).length - 1;
  const cases = [
    { fmt: 'gml', marker: 'directed 1', edges: (t) => count(t, '  edge [') },
    { fmt: 'graphml', marker: 'edgedefault="directed"', edges: (t) => count(t, '<edge ') },
    { fmt: 'dot', marker: 'digraph G {', edges: (t) => count(t, ' -> ') },
  ];
  for (const c of cases) {
    await page.click('#btnExport');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(`#exportMenu button[data-format="${c.fmt}"]`),
    ]);
    const text = fs.readFileSync(await download.path(), 'utf8');
    expect(text).toContain(c.marker);
    expect(c.edges(text)).toBe(56);
  }

  // DOT for a directed graph must not use the undirected ' -- ' separator.
  await page.click('#btnExport');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportMenu button[data-format="dot"]'),
  ]);
  expect(fs.readFileSync(await download.path(), 'utf8')).not.toContain(' -- ');
});

test('saves and reloads the directed flag in JSON', async ({ page }) => {
  await toggleMode(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnSave'),
  ]);
  const json = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(json.directed).toBe(true);
  expect(json.edges).toHaveLength(56);

  // Round-trip: load the saved file back; the mode must be restored.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await settle(page);
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(56);
});

test('loads a directed GML file and keeps both directions', async ({ page }) => {
  const gml = [
    'graph [',
    '  directed 1',
    '  node [ id 0 label "A" ]',
    '  node [ id 1 label "B" ]',
    '  edge [ source 0 target 1 weight 0.4 ]',
    '  edge [ source 1 target 0 weight 0.9 ]',
    ']'
  ].join('\n');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles({ name: 'directed.gml', mimeType: 'application/x-gml', buffer: Buffer.from(gml) });
  await settle(page);
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(2);
  await expect(page.locator('.edge-row[data-key="0__1"] .edge-label')).toHaveText('A → B');
  await expect(page.locator('.edge-row[data-key="1__0"] .edge-label')).toHaveText('B → A');
});

test('loads a directed GraphML file', async ({ page }) => {
  const graphml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="d_weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <graph id="G" edgedefault="directed">',
    '    <node id="A"/>',
    '    <node id="B"/>',
    '    <edge source="A" target="B"><data key="d_weight">0.4</data></edge>',
    '    <edge source="B" target="A"><data key="d_weight">0.9</data></edge>',
    '  </graph>',
    '</graphml>'
  ].join('\n');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles({ name: 'directed.graphml', mimeType: 'application/xml', buffer: Buffer.from(graphml) });
  await settle(page);
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(2);
  await expect(page.locator('.edge-row[data-key="A__B"] .edge-winput')).toHaveValue('0.4');
  await expect(page.locator('.edge-row[data-key="B__A"] .edge-winput')).toHaveValue('0.9');
});

test('rejects a mixed GraphML file (per-edge override of edgedefault)', async ({ page }) => {
  const graphml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <graph id="G" edgedefault="undirected">',
    '    <node id="A"/>',
    '    <node id="B"/>',
    '    <edge source="A" target="B" directed="true"/>',
    '  </graph>',
    '</graphml>'
  ].join('\n');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles({ name: 'mixed.graphml', mimeType: 'application/xml', buffer: Buffer.from(graphml) });
  await settle(page);
  await expect(page.locator('#message')).toContainText('Failed to load');
  await expect(page.locator('#message')).toContainText('mixed');
  // The previous graph is untouched.
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
});

// ---------------------------------------------------------------------------
// Every core interaction, run separately in undirected AND directed mode.
// ---------------------------------------------------------------------------

// A viewport point that lies on the a–b edge (used for right-clicking edges).
function edgePoint(page, a, b) {
  return page.evaluate(([a, b]) => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const vp = (x, y) => { const d = n.canvasToDOM({ x, y }); return { x: d.x + c.x, y: d.y + c.y }; };
    const rel = (x, y) => ({ x: x - c.x, y: y - c.y });
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55]) {
      const q = vp(P[a].x + (P[b].x - P[a].x) * t, P[a].y + (P[b].y - P[a].y) * t);
      const r = rel(q.x, q.y);
      if (!n.getNodeAt(r) && n.getEdgeAt(r)) return q;
    }
    return null;
  }, [a, b]);
}

// A canvas corner as far away from every node as possible.
function farCorner(page) {
  return page.evaluate(() => {
    const n = window.__graphEditor;
    const P = n.getPositions();
    const c = document.getElementById('network').getBoundingClientRect();
    const corners = [
      [c.x + 8, c.y + 8], [c.x + c.width - 8, c.y + 8],
      [c.x + 8, c.y + c.height - 8], [c.x + c.width - 8, c.y + c.height - 8],
    ];
    let best = corners[0], bestD = -1;
    for (const [cx, cy] of corners) {
      let minD = Infinity;
      for (const id of Object.keys(P)) {
        const vp = n.canvasToDOM(P[id]);
        minD = Math.min(minD, Math.hypot(cx - (c.x + vp.x), cy - (c.y + vp.y)));
      }
      if (minD > bestD) { bestD = minD; best = [cx, cy]; }
    }
    return { x: best[0], y: best[1] };
  });
}

// Toggle the mode toggle (accepting the confirm) until the wanted mode is active.
async function setMode(page, mode) {
  const label = await page.locator('#btnMode').textContent();
  const isDirected = label.includes('Mode: directed');
  const wantDirected = mode === 'directed';
  if (isDirected !== wantDirected) {
    await page.click('#btnMode');
    await acceptConfirm(page);
    await settle(page);
  }
}

for (const mode of ['undirected', 'directed']) {
  const isDirected = mode === 'directed';
  const START_EDGES = isDirected ? 56 : 28; // sample graph: 8 nodes

  test.describe(`core interactions in ${mode} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await setMode(page, mode);
    });

    test('adds an isolated node via the Add node menu', async ({ page }) => {
      await page.click('#btnAddNode');
      await page.locator('#addNodeMenu button[data-mode="isolated"]').click();
      await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
      await expect(page.locator('#stats')).toContainText('9 nodes');
    });

    test('adds a fully connected node', async ({ page }) => {
      await page.click('#btnAddNode');
      await page.locator('#addNodeMenu button[data-mode="connected"]').click();
      await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
      const added = isDirected ? 16 : 8;
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES + added);
    });

    test('connects two nodes to add an edge', async ({ page }) => {
      await page.click('#btnAddNode');
      await page.locator('#addNodeMenu button[data-mode="isolated"]').click();
      // Park C9 in a clear corner so the connect clicks never land on a node.
      await page.evaluate(() => {
        const n = window.__graphEditor;
        const P = n.getPositions();
        const rect = document.getElementById('network').getBoundingClientRect();
        const spots = [
          [rect.width / 2, 30], [30, rect.height / 2],
          [rect.width - 30, rect.height - 30], [rect.width / 2, rect.height - 30],
        ];
        let best = null, bestD = -1;
        for (const [sx, sy] of spots) {
          const cp = n.DOMtoCanvas({ x: sx, y: sy });
          let minD = Infinity;
          for (const id of Object.keys(P)) {
            if (id === 'C9') continue;
            minD = Math.min(minD, Math.hypot(cp.x - P[id].x, cp.y - P[id].y));
          }
          if (minD > bestD) { bestD = minD; best = cp; }
        }
        n.moveNode('C9', best.x, best.y);
      });
      const p = await graphPoints(page);
      await page.click('#btnConnect');
      await page.mouse.click(p.nodes.C9.x, p.nodes.C9.y);
      await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
      await page.waitForTimeout(200);
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES + 1);
    });

    test('deletes an edge via its ✕ button in the sidebar', async ({ page }) => {
      await page.locator('.edge-row[data-key="C1__C2"] .edge-del').click();
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES - 1);
    });

    test('deletes a node via its ✕ button in the sidebar', async ({ page }) => {
      await page.locator('#nodeList .node-row .edge-del').last().click();
      await expect(page.locator('#nodeList .node-row')).toHaveCount(7);
      const removed = isDirected ? 14 : 7; // C8 has 7 pairs, doubled when directed
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES - removed);
    });

    test('edits a node name and group in the sidebar', async ({ page }) => {
      const row = page.locator('#nodeList .node-row').first();
      await row.locator('.node-edit').click();
      const swatch = row.locator('.swatch');
      const before = await swatch.evaluate((el) => el.style.background);
      await row.locator('.node-edit-line input.group-input').fill('renamed');
      const after = await swatch.evaluate((el) => el.style.background);
      expect(after).not.toBe(before);
      // renaming updates the edge-list labels (arrow in directed mode)
      await row.locator('.node-edit-line input[type="text"]:not([list])').fill('crown');
      const sep = isDirected ? ' → ' : ' — ';
      await expect(page.locator('#edgeList .edge-row').first().locator('.edge-label'))
        .toHaveText('crown' + sep + 'C2');
    });

    test('edits a node weight via the sidebar slider', async ({ page }) => {
      const row = page.locator('#nodeList .node-row').first();
      await row.locator('input[type="range"]').evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, '0.77');
      await expect(row.locator('.node-winput')).toHaveValue('0.77');
      const size = await page.evaluate(() => window.__graphEditor.body.data.nodes.get('C1').size);
      // Node size maps the raw weight onto the graph's observed range (0.05..0.90).
      expect(size).toBeCloseTo(12 + 22 * ((0.77 - 0.05) / (0.90 - 0.05)), 2);
    });

    test('edits an edge weight via the sidebar slider', async ({ page }) => {
      const row = page.locator('.edge-row[data-key="C1__C2"]');
      await row.locator('input[type="range"]').evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, '0.42');
      await expect(row.locator('.edge-winput')).toHaveValue('0.42');
    });

    test('bulk-selects edges and sets a shared weight', async ({ page }) => {
      const boxes = page.locator('#edgeList .edge-row input[type="checkbox"]');
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await expect(page.locator('#bulkBar')).toBeVisible();
      await expect(page.locator('#bulkCount')).toHaveText('2 selected');
      await page.locator('#bulkSlider').evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, '0.42');
      const vals = await page.locator('#edgeList .edge-row .edge-winput').evaluateAll((els) => els.map((el) => el.value));
      expect(vals[0]).toBe('0.42');
      expect(vals[1]).toBe('0.42');
      await page.click('#btnBulkClear');
      await expect(page.locator('#bulkBar')).toBeHidden();
    });

    test('select-all checkbox selects every edge', async ({ page }) => {
      await page.check('#selectAllEdges');
      await expect(page.locator('#bulkCount')).toHaveText(START_EDGES + ' selected');
      await page.click('#btnBulkClear');
      await expect(page.locator('#bulkBar')).toBeHidden();
    });

    test('clicking a node highlights its incident edges', async ({ page }) => {
      const p = await graphPoints(page);
      await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
      await page.waitForTimeout(300);
      const incident = isDirected ? 14 : 7;
      await expect(page.locator('#edgeList .edge-row.selected')).toHaveCount(incident);
    });

    test('clicking a node highlights it in the vertex list', async ({ page }) => {
      const p = await graphPoints(page);
      await page.mouse.click(p.nodes.C1.x, p.nodes.C1.y);
      await page.waitForTimeout(300);
      await expect(page.locator('#nodeList .node-row.selected')).toHaveCount(1);
    });

    test('right-click menu on a node offers edit and delete', async ({ page }) => {
      const p = await graphPoints(page);
      await page.mouse.click(p.nodes.C8.x, p.nodes.C8.y, { button: 'right' });
      const menu = page.locator('#contextMenu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('Edit name / group');
      await expect(menu).toContainText('Delete node');
    });

    test('right-click delete removes the node', async ({ page }) => {
      const p = await graphPoints(page);
      await page.mouse.click(p.nodes.C8.x, p.nodes.C8.y, { button: 'right' });
      await page.locator('#contextMenu button', { hasText: 'Delete node' }).click();
      await expect(page.locator('#nodeList .node-row')).toHaveCount(7);
      const removed = isDirected ? 14 : 7;
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES - removed);
    });

    test('right-click menu on an edge deletes it', async ({ page }) => {
      const pt = await edgePoint(page, 'C3', 'C4');
      expect(pt).not.toBeNull();
      await page.mouse.click(pt.x, pt.y, { button: 'right' });
      const menu = page.locator('#contextMenu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('Delete edge');
      await menu.locator('button', { hasText: 'Delete edge' }).click();
      const removed = isDirected ? 2 : 1;
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(START_EDGES - removed);
    });

    test('right-click empty canvas adds a node', async ({ page }) => {
      const far = await farCorner(page);
      await page.mouse.click(far.x, far.y, { button: 'right' });
      const menu = page.locator('#contextMenu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('Add node');
      await menu.locator('button', { hasText: 'Add node' }).click();
      await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
    });

    test('auto-layout enables undo, undo restores', async ({ page }) => {
      await expect(page.locator('#btnUndoLayout')).toBeDisabled();
      await page.click('#btnAutoLayout');
      await page.waitForTimeout(1500);
      await expect(page.locator('#btnUndoLayout')).toBeEnabled();
      await page.click('#btnUndoLayout');
      await expect(page.locator('#btnUndoLayout')).toBeDisabled();
    });

    test('edge labels toggle on and off', async ({ page }) => {
      const off = await darkTextPixels(page);
      await page.click('#btnEdgeLabels');
      await page.waitForTimeout(300);
      const on = await darkTextPixels(page);
      expect(on).toBeGreaterThan(off * 1.5);
      await page.click('#btnEdgeLabels');
      await page.waitForTimeout(300);
      const offAgain = await darkTextPixels(page);
      expect(offAgain).toBeLessThan(on * 0.7);
    });

    test('vertex weight labels toggle on and off', async ({ page }) => {
      const nodeLabel = () => page.evaluate(() => window.__graphEditor.body.data.nodes.get('C1').label);
      await expect(page.locator('#btnNodeLabels')).toHaveText('Vertex weights: off');
      expect(await nodeLabel()).toBe('C1');

      await page.click('#btnNodeLabels');
      await expect(page.locator('#btnNodeLabels')).toHaveText('Vertex weights: on');
      expect(await nodeLabel()).toBe('C1\n0.50'); // C1 is a leaf with weight 0.50

      await page.click('#btnNodeLabels');
      await expect(page.locator('#btnNodeLabels')).toHaveText('Vertex weights: off');
      expect(await nodeLabel()).toBe('C1');
    });

    test('creates a new complete graph with N nodes', async ({ page }) => {
      await page.fill('#nodeCount', '5');
      await page.click('#btnNew');
      await acceptConfirm(page);
      await settle(page);
      await expect(page.locator('#nodeList .node-row')).toHaveCount(5);
      const expected = isDirected ? 20 : 10;
      await expect(page.locator('#edgeList .edge-row')).toHaveCount(expected);
    });

    test('saves and exports the graph', async ({ page }) => {
      await page.fill('#graphName', 'Mode Check');
      const [saveDl] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#btnSave'),
      ]);
      const json = JSON.parse(fs.readFileSync(await saveDl.path(), 'utf8'));
      expect(json.directed).toBe(isDirected);
      expect(json.edges).toHaveLength(START_EDGES);

      await page.click('#btnExport');
      const [dl] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#exportMenu button[data-format="gml"]'),
      ]);
      const gml = fs.readFileSync(await dl.path(), 'utf8');
      expect(gml).toContain(isDirected ? 'directed 1' : 'directed 0');
    });
  });
}

// ---------------------------------------------------------------------------
// Mode switching: assert the exact expected state after each switch.
// ---------------------------------------------------------------------------

test.describe('mode switching', () => {
  test('undirected -> directed doubles edges and marks the graph directed', async ({ page }) => {
    await page.click('#btnMode');
    await acceptConfirm(page);
    await settle(page);
    await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
    await expect(page.locator('#stats')).toContainText('56 edges');
    await expect(page.locator('#stats')).toContainText('directed');
    // every pair now has both directions as separate rows
    await expect(page.locator('.edge-row[data-key="C1__C2"] .edge-label')).toHaveText('C1 → C2');
    await expect(page.locator('.edge-row[data-key="C2__C1"] .edge-label')).toHaveText('C2 → C1');
  });

  test('directed -> undirected merges pairs and keeps a lone directed edge', async ({ page }) => {
    await page.click('#btnMode'); // -> directed
    await acceptConfirm(page);
    await settle(page);
    // remove one direction so C1-C2 becomes a lone directed edge (C2 -> C1)
    await page.locator('.edge-row[data-key="C1__C2"] .edge-del').click();
    await expect(page.locator('#edgeList .edge-row')).toHaveCount(55);
    // switch back
    await page.click('#btnMode'); // -> undirected
    await acceptConfirm(page);
    await settle(page);
    await expect(page.locator('#btnMode')).toHaveText('Mode: undirected');
    await expect(page.locator('#stats')).toContainText('undirected');
    // the lone C2 -> C1 became one undirected C1-C2 edge; all other pairs merged
    await expect(page.locator('#edgeList .edge-row')).toHaveCount(28);
    await expect(page.locator('.edge-row[data-key="C1__C2"] .edge-winput')).toHaveValue('0.9');
  });

  test('a new complete graph inherits the current mode', async ({ page }) => {
    await page.click('#btnMode'); // -> directed
    await acceptConfirm(page);
    await settle(page);
    await page.fill('#nodeCount', '4');
    await page.click('#btnNew');
    await acceptConfirm(page);
    await settle(page);
    await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
    await expect(page.locator('#stats')).toContainText('12 edges'); // complete directed 4*3
  });
});

// ---------------------------------------------------------------------------
// Autosave: the draft is written to localStorage and silently restored.
// ---------------------------------------------------------------------------

test('autosaves the draft to localStorage and silently restores it after reload', async ({ page }) => {
  // Edit the graph: add an isolated node.
  await page.click('#btnAddNode');
  await page.locator('#addNodeMenu button[data-mode="isolated"]').click();
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);

  await page.waitForTimeout(700); // let the debounced (500 ms) autosave fire
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('keygraphjs:draft') || 'null'));
  expect(draft).not.toBeNull();
  expect(draft.nodes).toHaveLength(9);

  // Refresh: the edited graph must come back silently (no sample graph).
  await page.reload();
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
  await expect(page.locator('#stats')).toContainText('9 nodes');
});

test('a loaded file is autosaved and restored on reload', async ({ page }) => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btnLoad'),
  ]);
  await chooser.setFiles(path.join(__dirname, 'fixtures', 'small_graph.json'));
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(3);

  await page.waitForTimeout(700);
  await page.reload();
  await settle(page);
  // The loaded graph, not the sample, is restored.
  await expect(page.locator('#nodeList .node-row')).toHaveCount(3);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(3);
});

test('directed mode is preserved in the autosaved draft', async ({ page }) => {
  await page.click('#btnMode'); // -> directed
  await acceptConfirm(page);
  await settle(page);
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');

  await page.waitForTimeout(700);
  await page.reload();
  await settle(page);
  await expect(page.locator('#btnMode')).toHaveText('Mode: directed');
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(56);
});
