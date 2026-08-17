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
// Edges are drawn as smooth curves, so the straight midpoint occasionally misses.
async function clickEdge(page, a, b) {
  const pts = await page.evaluate(([a, b]) => {
    const n = window.__graphEditor;
    const c = document.getElementById('network').getBoundingClientRect();
    const P = n.getPositions();
    const vp = (pt) => ({ x: pt.x + c.x, y: pt.y + c.y });
    const toDOM = (x, y) => vp(n.canvasToDOM({ x, y }));
    const out = [];
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.45, 0.55]) {
      out.push(toDOM(P[a].x + (P[b].x - P[a].x) * t, P[a].y + (P[b].y - P[a].y) * t));
    }
    return out;
  }, [a, b]);

  for (const pt of pts) {
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
});

test('adds a node', async ({ page }) => {
  await page.click('#btnAddNode');
  await expect(page.locator('#nodeList .node-row')).toHaveCount(9);
  await expect(page.locator('#stats')).toContainText('9 nodes');
});

test('creates a new complete graph with N nodes', async ({ page }) => {
  await page.fill('#nodeCount', '5');
  await page.click('#btnNew');
  await settle(page);
  await expect(page.locator('#nodeList .node-row')).toHaveCount(5);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(10);
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

  const vals = await page.locator('#edgeList .edge-row .edge-val').allTextContents();
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
  await page.click('#btnAddNode');

  expect(errors).toEqual([]);
});

test('deletes an edge via its ✕ button', async ({ page }) => {
  await page.locator('.edge-row[data-key="C1__C2"] .edge-del').click();
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(27);
  await expect(page.locator('#stats')).toContainText('27 edges');
});

test('connects two nodes to add an edge', async ({ page }) => {
  await page.click('#btnAddNode'); // C9, no edges yet
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

test('deletes the selected edge from the canvas', async ({ page }) => {
  await clickEdge(page, 'C3', 'C4');
  await page.click('#btnDeleteEdge');
  await page.waitForTimeout(200);
  await expect(page.locator('#edgeList .edge-row')).toHaveCount(27);
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
  await expect(row.locator('.node-val')).toHaveText('0.77');
  const size = await page.evaluate(() => window.__graphEditor.body.data.nodes.get('C1').size);
  expect(size).toBeCloseTo(12 + 22 * 0.77, 2);
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
