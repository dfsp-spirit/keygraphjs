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
  const swatch = page.locator('#nodeList .node-row .swatch').first();
  const before = await swatch.evaluate((el) => el.style.background);
  await page.locator('#nodeList .node-row input.group-input').first().fill('renamed');
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
  await page.locator('#nodeList .node-row').first()
    .locator('input[type="text"]:not([list])').fill('crown');
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
