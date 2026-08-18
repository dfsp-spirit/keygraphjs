/* keygraphjs — a small web editor for undirected, edge-weighted graphs.
 *
 * Runs entirely in the browser from a double-clicked HTML file (no server, no
 * build step). Uses vis-network (vendored locally).
 *
 * The JSON it reads/writes:
 *   {
 *     "meta": { "name": "...", "description": "..." },
 *     "directed": false,   // true for directed graphs (absent = undirected)
 *     "nodes": [ { "id": "C1", "label": "crown", "group": "A", "weight": 0.5 }, ... ],
 *     "edges": [ { "source": "C1", "target": "C2", "weight": 0.90 }, ... ]
 *   }
 *
 * `nodes[].id`, `nodes[].weight`, `edges[].source/target/weight` carry the graph
 * data; `label` and `group` are human metadata; `x`/`y` are optional layout hints.
 * In directed mode a bidirectional pair is stored as two edges (A->B and B->A)
 * and rendered as a single double-arrowed edge.
 */
(function () {
  'use strict';

  // App version — keep in sync with the "version" field in package.json.
  var APP_VERSION = '0.1.0';

  var NUM_NODES = 8;
  var DEFAULT_WEIGHT = 0.10;

  var GROUP_PALETTE = [
    '#4c8bf5', '#f59e0b', '#34d399', '#a78bfa', '#f472b6',
    '#22d3ee', '#facc15', '#fb7185', '#84cc16', '#f97316'
  ];
  // Stable colors for the well-known example groups; anything else hashes
  // deterministically into the palette above.
  var GROUP_COLORS = { A: '#4c8bf5', B: '#f59e0b', hub: '#34d399' };

  function groupColor(name) {
    name = (name || '').trim();
    if (!name) return '#9ca3af';                       // ungrouped -> gray
    if (GROUP_COLORS[name]) return GROUP_COLORS[name];
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return GROUP_PALETTE[h % GROUP_PALETTE.length];
  }

  var graph = null;      // { meta, directed, nodes, edges }
  var network = null;
  var connectMode = false;
  var connectSource = null;
  var showEdgeLabels = false;
  var highlightedEdgeKeys = new Set();  // vis edge ids ('source__target') highlighted in the list
  var highlightedNodeKeys = new Set();  // vis node ids highlighted in the node list
  var layoutSnapshot = null;  // {id, x, y}[] captured before auto-layout
  var bulkSelected = new Set();  // edge objects selected for bulk edit

  // ---------------------------------------------------------------- builders

  function nodeId(i) { return 'C' + (i + 1); }

  function newCompleteGraph(n, directed) {
    n = n || NUM_NODES;
    var nodes = [];
    for (var i = 0; i < n; i++) {
      nodes.push({ id: nodeId(i), label: nodeId(i), group: '', weight: DEFAULT_WEIGHT });
    }
    var edges = [];
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        edges.push({ source: nodeId(a), target: nodeId(b), weight: DEFAULT_WEIGHT });
        if (directed) edges.push({ source: nodeId(b), target: nodeId(a), weight: DEFAULT_WEIGHT });
      }
    }
    return { meta: { name: '', description: '' }, directed: !!directed, nodes: nodes, edges: edges };
  }

  // The README example: two communities (A, B) and two hubs, with the exact
  // edge-weight rule from the algorithm spec.
  function sampleGraph() {
    var communityA = ['C1', 'C2', 'C3'];
    var communityB = ['C4', 'C5', 'C6'];
    var hubs = ['C7', 'C8'];

    var nodes = [];
    for (var i = 0; i < NUM_NODES; i++) {
      var id = nodeId(i);
      var group = communityA.indexOf(id) >= 0 ? 'A'
                : communityB.indexOf(id) >= 0 ? 'B'
                : 'hub';
      nodes.push({ id: id, label: id, group: group, weight: nodeWeight(id) });
    }

    var edges = [];
    for (var a = 0; a < NUM_NODES; a++) {
      for (var b = a + 1; b < NUM_NODES; b++) {
        var u = nodeId(a), v = nodeId(b);
        edges.push({ source: u, target: v, weight: edgeWeight(u, v) });
      }
    }
    return {
      meta: { name: 'A/B/hub example', description: 'Communities A and B, hubs C7/C8 (README weights).' },
      directed: false,
      nodes: nodes,
      edges: edges
    };

    function edgeWeight(u, v) {
      var inA = communityA.indexOf(u) >= 0 && communityA.indexOf(v) >= 0;
      var inB = communityB.indexOf(u) >= 0 && communityB.indexOf(v) >= 0;
      if (inA || inB) return 0.90;
      var uHub = hubs.indexOf(u) >= 0, vHub = hubs.indexOf(v) >= 0;
      if (uHub && vHub) return 0.35;
      if (uHub !== vHub) return 0.65; // hub <-> leaf
      return 0.05; // cross-community leaf <-> leaf
    }

    function nodeWeight(id) {
      // Hubs are "heavier". Values avoid colliding with edge weights so they
      // stay unambiguous in exported files (edges: 0.90/0.65/0.35/0.05).
      return hubs.indexOf(id) >= 0 ? 0.75 : 0.50;
    }
  }

  // -------------------------------------------------------------- normalization

  function clampWeight(w) {
    var n = Number(w);
    if (!isFinite(n)) n = DEFAULT_WEIGHT;
    return Math.min(1, Math.max(0, n));
  }

  function normalize(parsed) {
    var nodes = (parsed.nodes || []).map(function (n) {
      return {
        id: String(n.id),
        label: n.label !== undefined && n.label !== null ? String(n.label) : String(n.id),
        group: (n.group !== undefined && n.group !== null) ? String(n.group) : '',
        weight: clampWeight(n.weight),
        x: (typeof n.x === 'number') ? n.x : undefined,
        y: (typeof n.y === 'number') ? n.y : undefined
      };
    });
    var edges = (parsed.edges || []).map(function (e) {
      return {
        source: String(e.source),
        target: String(e.target),
        weight: clampWeight(e.weight)
      };
    });
    return {
      meta: { name: (parsed.meta && parsed.meta.name) || '', description: (parsed.meta && parsed.meta.description) || '' },
      directed: !!parsed.directed,
      nodes: nodes,
      edges: edges
    };
  }

  // ------------------------------------------------- directed/undirected mode

  // Canonical "lowest id first" ordering for an unordered node pair, so a
  // bidirectional pair (A->B and B->A) is recognized as one unit regardless of
  // storage order. Ids are usually "C"+number; compare numerically when both
  // look like that, otherwise fall back to plain string comparison.
  function idNum(id) {
    var m = /^C(\d+)$/.exec(String(id));
    return m ? Number(m[1]) : null;
  }
  function idLess(a, b) {
    var na = idNum(a), nb = idNum(b);
    if (na !== null && nb !== null) return na < nb;
    return String(a) < String(b);
  }
  function pairOrder(a, b) {
    return idLess(a, b) ? [a, b] : [b, a];
  }
  function pairKey(a, b) {
    var o = pairOrder(a, b);
    return o[0] + '__' + o[1];
  }

  // The model edges (0, 1 or 2) connecting the unordered pair {a, b}.
  function pairEdges(a, b) {
    return graph.edges.filter(function (e) {
      return (e.source === a && e.target === b) || (e.source === b && e.target === a);
    });
  }

  // Does model edge e correspond to vis edge key `key`? In directed mode a
  // collapsed pair edge is keyed by the canonical order, so both directions
  // match it; in undirected mode only the exact stored order matches.
  function matchesVisKey(e, key) {
    if (e.source + '__' + e.target === key) return true;
    return !!graph.directed && (e.target + '__' + e.source === key);
  }

  // Expand vis edge keys into the sidebar row keys they represent (a collapsed
  // bidirectional pair expands to both of its rows).
  function edgeRowKeysForVisKeys(keys) {
    var out = [];
    keys.forEach(function (k) {
      graph.edges.forEach(function (e) {
        if (matchesVisKey(e, k)) out.push(e.source + '__' + e.target);
      });
    });
    return out;
  }

  function edgeLabel(a, b) {
    return labelOf(a) + (graph.directed ? ' \u2192 ' : ' \u2014 ') + labelOf(b);
  }

  // Mode conversions (destructive — the toolbar toggle asks for confirmation).
  function convertToDirected() {
    var extra = graph.edges.map(function (e) {
      return { source: e.target, target: e.source, weight: e.weight };
    });
    graph.edges = graph.edges.concat(extra);
    graph.directed = true;
  }

  function convertToUndirected() {
    var byPair = {};
    graph.edges.forEach(function (e) {
      var k = pairKey(e.source, e.target);
      if (!byPair[k]) byPair[k] = [];
      byPair[k].push(e.weight);
    });
    var edges = [];
    Object.keys(byPair).forEach(function (k) {
      var ws = byPair[k];
      var sum = 0;
      ws.forEach(function (w) { sum += w; });
      var o = k.split('__');
      edges.push({ source: o[0], target: o[1], weight: clampWeight(sum / ws.length) });
    });
    graph.edges = edges;
    graph.directed = false;
  }

  function toggleMode() {
    var goDirected = !graph.directed;
    var msg = goDirected
      ? 'Switch to directed mode? Each undirected edge becomes two directed edges (weights are copied).'
      : 'Switch to undirected mode? Bidirectional pairs are merged into one edge (mean weight); lone directed edges are kept.';
    if (!window.confirm(msg)) return;
    if (goDirected) convertToDirected(); else convertToUndirected();
    rebuild();
    setMessage('Switched to ' + (graph.directed ? 'directed' : 'undirected') + ' mode (' +
      graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges).');
  }

  function updateModeButton() {
    var btn = document.getElementById('btnMode');
    if (!btn) return;
    var directed = !!graph.directed;
    btn.textContent = directed ? 'Mode: directed' : 'Mode: undirected';
    btn.classList.toggle('active', directed);
  }

  // ------------------------------------------------------------- vis conversion

  function labelOf(id) {
    for (var i = 0; i < graph.nodes.length; i++) {
      if (graph.nodes[i].id === id) return graph.nodes[i].label || graph.nodes[i].id;
    }
    return id;
  }

  function edgeColor(w) {
    // 0 -> red, 1 -> green. Lets structure show up at a glance.
    return 'hsl(' + Math.round(140 * w) + ', 65%, 42%)';
  }

  function nodeSize(w) {
    return 12 + 22 * clampWeight(w); // heavier nodes draw larger
  }

  function visNodeObject(n) {
    var c = groupColor(n.group);
    var out = {
      id: n.id,
      label: n.label || n.id,
      size: nodeSize(n.weight),
      title: 'weight ' + Number(n.weight).toFixed(2),
      color: { background: c, border: c, highlight: { background: c, border: c } }
    };
    if (typeof n.x === 'number' && typeof n.y === 'number') { out.x = n.x; out.y = n.y; }
    return out;
  }

  function visNodes() {
    return graph.nodes.map(visNodeObject);
  }

  function hasPositions() {
    return graph.nodes.length > 0 && graph.nodes.every(function (n) {
      return typeof n.x === 'number' && typeof n.y === 'number';
    });
  }

  function edgeVisObject(e) {
    return visObjectForPair(e.source, e.target);
  }

  // The vis-network edge for the node pair {a, b}: a single double-arrowed edge
  // when both directions exist, a single-arrowed edge when only one does.
  // Keeping one line per pair avoids the clutter of two parallel curves.
  function visObjectForPair(a, b) {
    var list = pairEdges(a, b);
    if (list.length === 0) return null;
    var o = pairOrder(a, b);
    var low = o[0], high = o[1];

    if (!graph.directed) {
      var u = list[0];
      return {
        id: u.source + '__' + u.target,
        from: u.source,
        to: u.target,
        title: labelOf(u.source) + ' \u2014 ' + labelOf(u.target) + ': ' + u.weight.toFixed(2),
        label: showEdgeLabels ? Number(u.weight).toFixed(2) : '',
        color: { color: edgeColor(u.weight) }
      };
    }

    var lowToHigh = list.find(function (e) { return e.source === low && e.target === high; });
    var highToLow = list.find(function (e) { return e.source === high && e.target === low; });
    var both = !!lowToHigh && !!highToLow;
    var single = lowToHigh || highToLow;

    var out = {
      id: low + '__' + high,
      from: low,
      to: high,
      title: both
        ? labelOf(low) + ' \u2194 ' + labelOf(high) + ' \u00b7 ' + low + ' \u2192 ' + high +
          ' ' + lowToHigh.weight.toFixed(2) + ' \u00b7 ' + high + ' \u2192 ' + low + ' ' + highToLow.weight.toFixed(2)
        : labelOf(single.source) + ' \u2192 ' + labelOf(single.target) + ': ' + single.weight.toFixed(2),
      label: both
        ? (showEdgeLabels ? Number(lowToHigh.weight).toFixed(2) + ' | ' + Number(highToLow.weight).toFixed(2) : '')
        : (showEdgeLabels ? Number(single.weight).toFixed(2) : ''),
      color: { color: edgeColor(single.weight) }
    };
    out.arrows = both
      ? { to: { enabled: true }, from: { enabled: true } }
      : { to: { enabled: true } };
    return out;
  }

  function visEdges() {
    var seen = new Set();
    return graph.edges.map(edgeVisObject).filter(function (o) {
      if (!o) return false;
      if (seen.has(o.id)) return false;  // a bidirectional pair emits one edge
      seen.add(o.id);
      return true;
    });
  }

  function buildNetwork() {
    var data = {
      nodes: new vis.DataSet(visNodes()),
      edges: new vis.DataSet(visEdges())
    };
    var options = {
      nodes: { shape: 'dot', size: 24, font: { size: 15, color: '#0f172a' } },
      edges: {
        width: 2,
        smooth: { enabled: true, type: 'continuous' },
        chosen: { edge: function (values) { values.width = 4; } }
      },
      physics: {
        enabled: !hasPositions(),
        stabilization: { enabled: !hasPositions(), iterations: 250 },
        barnesHut: {
          springLength: 160,
          springConstant: 0.04,
          gravitationalConstant: -3000,
          damping: 0.09
        }
      },
      interaction: { hover: true, tooltipDelay: 100 }
    };
    network = new vis.Network(document.getElementById('network'), data, options);
    // Test hook used by tests/editor.spec.js (positions/selection helpers).
    window.__graphEditor = network;

    network.on('click', onCanvasClick);
    network.on('selectEdge', syncHighlight);
    network.on('selectNode', syncHighlight);
    network.on('deselectEdge', syncHighlight);
    network.on('deselectNode', syncHighlight);
    network.on('dragEnd', syncPositions);
    network.on('stabilizationIterationsDone', function () {
      // vis-network may leave physics running (continuous) after stabilization
      // if the layout didn't fully converge; force it off on the next tick so
      // steady state is always frozen and drags only move the dragged node.
      var net = network;
      setTimeout(function () {
        if (network !== net) return; // a rebuild happened in the meantime
        net.setOptions({ physics: { enabled: false, stabilization: { enabled: false } } });
        syncPositions();
        updateLayoutButtons();
        if (layoutSnapshot) setMessage('Auto-layout done. Use "Undo layout" to revert.');
      }, 0);
    });
  }

  // ------------------------------------------------------------------ events

  function onCanvasClick(params) {
    if (!connectMode) return;

    if (params.nodes.length === 1) {
      var id = params.nodes[0];
      if (connectSource === null) {
        connectSource = id;
        network.selectNodes([id]);
        setMessage('Connect: now click the second node ("' + labelOf(id) + '" selected).');
      } else if (connectSource === id) {
        network.unselectAll();
        connectSource = null;
        setMessage('Cancelled.');
      } else {
        var src = connectSource;
        addEdge(src, id);
        network.unselectAll();
        connectSource = null;
        setMessage('Added edge ' + edgeLabel(src, id) + '.');
      }
    } else if (params.nodes.length === 0) {
      // clicked empty canvas: cancel the pending source
      network.unselectAll();
      connectSource = null;
      setMessage('Cancelled.');
    }
  }

  function syncPositions() {
    if (!network) return;
    var pos = network.getPositions();
    graph.nodes.forEach(function (n) {
      if (pos[n.id]) { n.x = pos[n.id].x; n.y = pos[n.id].y; }
    });
  }

  // ---------------------------------------------------------------- edge ops

  function edgeExists(a, b) {
    return graph.edges.some(function (e) {
      if (e.source === a && e.target === b) return true;
      return !graph.directed && e.source === b && e.target === a;
    });
  }

  function addEdge(a, b) {
    if (a === b) return;
    if (edgeExists(a, b)) {
      setMessage('Edge ' + edgeLabel(a, b) + ' already exists.', true);
      return;
    }
    var e = { source: a, target: b, weight: DEFAULT_WEIGHT };
    graph.edges.push(e);
    // Refresh this node pair's vis representation: adding the reverse direction
    // of a pair must replace the single arrow with the collapsed double arrow.
    network.body.data.edges.remove([a + '__' + b, b + '__' + a]);
    network.body.data.edges.add(edgeVisObject(e));
    renderEdgeList();
    renderStats();
  }

  function deleteEdge(source, target) {
    var e = graph.edges.find(function (x) {
      if (x.source === source && x.target === target) return true;
      return !graph.directed && x.source === target && x.target === source;
    });
    if (!e) return;
    graph.edges = graph.edges.filter(function (x) { return x !== e; });
    bulkSelected.delete(e);
    network.body.data.edges.remove([source + '__' + target, target + '__' + source]);
    // If the other direction of a former pair still exists, draw it again.
    var rest = visObjectForPair(source, target);
    if (rest) network.body.data.edges.add(rest);
    renderEdgeList();
    renderStats();
    setMessage('Removed edge ' + edgeLabel(source, target) + '.');
  }

  function deleteSelectedEdges() {
    var sel = network.getSelectedEdges();
    if (sel.length === 0) { setMessage('No edge selected (click an edge first).', true); return; }
    var removed = graph.edges.filter(function (e) {
      return sel.some(function (k) { return matchesVisKey(e, k); });
    });
    if (removed.length === 0) return;
    graph.edges = graph.edges.filter(function (e) { return removed.indexOf(e) < 0; });
    removed.forEach(function (e) { bulkSelected.delete(e); });
    network.body.data.edges.remove(sel);
    renderEdgeList();
    renderStats();
    setMessage('Deleted ' + removed.length + ' edge(s).');
  }

  // Delete every direction of the given vis edge key (used by the context
  // menu: a collapsed bidirectional pair deletes both directions).
  function deleteEdgesForVisKey(key) {
    var removed = graph.edges.filter(function (e) { return matchesVisKey(e, key); });
    if (removed.length === 0) return;
    graph.edges = graph.edges.filter(function (e) { return removed.indexOf(e) < 0; });
    removed.forEach(function (e) { bulkSelected.delete(e); });
    network.body.data.edges.remove([key]);
    renderEdgeList();
    renderStats();
    setMessage('Removed edge' + (removed.length > 1 ? 's (both directions)' : '') + '.');
  }

  function nextNodeId() {
    var i = 1;
    while (graph.nodes.some(function (n) { return n.id === 'C' + i; })) i++;
    return 'C' + i;
  }

  function centroidPosition() {
    var xs = [], ys = [];
    graph.nodes.forEach(function (n) {
      if (typeof n.x === 'number' && typeof n.y === 'number') { xs.push(n.x); ys.push(n.y); }
    });
    if (xs.length === 0) return { x: 0, y: 0 };
    var cx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    var cy = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    return { x: cx + (Math.random() * 60 - 30), y: cy + (Math.random() * 60 - 30) };
  }

  function addNode() {
    var id = nextNodeId();
    var pos = centroidPosition();
    var n = { id: id, label: id, group: '', weight: DEFAULT_WEIGHT, x: pos.x, y: pos.y };
    graph.nodes.push(n);
    network.body.data.nodes.add(visNodeObject(n));
    renderNodeList();
    renderStats();
    setMessage('Added node ' + id + '.');
  }

  function addFullyConnectedNode() {
    var id = nextNodeId();
    var pos = centroidPosition();
    var n = { id: id, label: id, group: '', weight: DEFAULT_WEIGHT, x: pos.x, y: pos.y };
    graph.nodes.push(n);
    network.body.data.nodes.add(visNodeObject(n));
    graph.nodes.forEach(function (m) {
      if (m.id === id) return;
      graph.edges.push({ source: id, target: m.id, weight: DEFAULT_WEIGHT });
      if (graph.directed) graph.edges.push({ source: m.id, target: id, weight: DEFAULT_WEIGHT });
    });
    network.body.data.edges.clear();
    network.body.data.edges.add(visEdges());
    renderNodeList();
    renderEdgeList();
    renderStats();
    setMessage('Added node ' + id + ' connected to all other nodes' + (graph.directed ? ' (both directions)' : '') + '.');
  }

  function deleteNode(id) {
    if (graph.nodes.length <= 1) {
      setMessage('Cannot remove the last node.', true);
      return;
    }
    graph.nodes = graph.nodes.filter(function (n) { return n.id !== id; });
    var removedIds = [];
    graph.edges = graph.edges.filter(function (e) {
      if (e.source === id || e.target === id) {
        removedIds.push(e.source + '__' + e.target, e.target + '__' + e.source);
        bulkSelected.delete(e);
        return false;
      }
      return true;
    });
    network.body.data.nodes.remove([id]);
    if (removedIds.length) network.body.data.edges.remove(removedIds);
    removedIds.forEach(function (k) { highlightedEdgeKeys.delete(k); });
    highlightedNodeKeys.delete(id);
    renderNodeList();
    renderEdgeList();
    renderStats();
    setMessage('Removed node ' + id + '.');
  }

  // --------------------------------------------------------------- rendering

  function renderStats() {
    var n = graph.nodes.length;
    var expected = graph.directed ? n * (n - 1) : n * (n - 1) / 2;
    document.getElementById('stats').textContent =
      n + ' nodes \u00b7 ' + graph.edges.length + ' edges (complete = ' + expected + ') \u00b7 ' +
      (graph.directed ? 'directed' : 'undirected');
    // Accessible description of the canvas graph, kept in sync with the stats.
    document.getElementById('network').setAttribute('aria-label',
      n + ' nodes, ' + graph.edges.length + ' edges, ' + (graph.directed ? 'directed' : 'undirected') + ' graph');
  }

  function collectGroups() {
    var set = [];
    graph.nodes.forEach(function (n) {
      var g = (n.group || '').trim();
      if (g && set.indexOf(g) < 0) set.push(g);
    });
    return set;
  }

  function renderGroupDatalist() {
    var dl = document.getElementById('groupOptions');
    if (!dl) return;
    dl.innerHTML = '';
    collectGroups().forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g;
      dl.appendChild(opt);
    });
  }

  function renderNodeList() {
    var el = document.getElementById('nodeList');
    el.innerHTML = '';
    renderGroupDatalist();

    graph.nodes.forEach(function (n) {
      var row = document.createElement('div');
      row.className = 'node-row';
      row.setAttribute('data-id', n.id);

      // line 1: id, color, name (read-only), group chip, edit, delete
      var mainLine = document.createElement('div');
      mainLine.className = 'node-main-line';

      var idSpan = document.createElement('span');
      idSpan.className = 'node-id';
      idSpan.textContent = n.id;

      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = groupColor(n.group);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'node-name';
      nameSpan.textContent = n.label || n.id;
      nameSpan.title = (n.label || n.id) + (n.group ? ' \u00b7 ' + n.group : '');

      var chip = document.createElement('span');
      chip.className = 'node-chip';
      chip.textContent = n.group || '';
      chip.title = 'Group';
      chip.style.background = groupColor(n.group);
      chip.style.display = n.group ? '' : 'none';

      var editBtn = document.createElement('button');
      editBtn.className = 'node-edit';
      editBtn.textContent = '\u270e'; // pencil
      editBtn.title = 'Edit name / group';
      editBtn.setAttribute('aria-label', 'Edit name/group of node ' + n.id);

      var del = document.createElement('button');
      del.className = 'edge-del';
      del.textContent = '\u2715';
      del.title = 'Remove this node (and its edges)';
      del.setAttribute('aria-label', 'Remove node ' + n.id);
      del.addEventListener('click', function () { deleteNode(n.id); });

      // line 2: vertex weight slider (mirrors the edge rows)
      var weightLine = document.createElement('div');
      weightLine.className = 'node-weight-line';

      var weightLabel = document.createElement('span');
      weightLabel.className = 'node-wlabel';
      weightLabel.textContent = 'w';
      weightLabel.title = 'Vertex weight (0\u20131)';

      var weightSlider = document.createElement('input');
      weightSlider.type = 'range';
      weightSlider.min = 0;
      weightSlider.max = 1;
      weightSlider.step = 0.01;
      weightSlider.value = n.weight;
      weightSlider.setAttribute('aria-label', 'Weight of node ' + n.id);

      var weightVal = document.createElement('span');
      weightVal.className = 'node-val';
      weightVal.textContent = Number(n.weight).toFixed(2);

      weightSlider.addEventListener('input', function () {
        n.weight = Number(weightSlider.value);
        weightVal.textContent = n.weight.toFixed(2);
        network.body.data.nodes.update(visNodeObject(n));
      });

      weightLine.appendChild(weightLabel);
      weightLine.appendChild(weightSlider);
      weightLine.appendChild(weightVal);

      // line 3 (hidden): name + group editing — rare, so tucked away
      var editLine = document.createElement('div');
      editLine.className = 'node-edit-line';
      editLine.hidden = true;

      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = n.label || '';
      labelInput.placeholder = 'name';
      labelInput.title = 'Human-readable name (optional).';
      labelInput.setAttribute('aria-label', 'Name of node ' + n.id);
      labelInput.addEventListener('input', function () {
        n.label = labelInput.value;
        nameSpan.textContent = labelInput.value || n.id;
        nameSpan.title = (labelInput.value || n.id) + (n.group ? ' \u00b7 ' + n.group : '');
        network.body.data.nodes.update({ id: n.id, label: labelInput.value || n.id });
        renderEdgeList(); // edge labels use node names
      });

      var groupInput = document.createElement('input');
      groupInput.type = 'text';
      groupInput.className = 'group-input';
      groupInput.setAttribute('list', 'groupOptions');
      groupInput.value = n.group || '';
      groupInput.placeholder = 'group';
      groupInput.title = 'Group metadata (optional). Type a name or pick one.';
      groupInput.setAttribute('aria-label', 'Group of node ' + n.id);
      var applyGroup = function () {
        n.group = groupInput.value.trim();
        swatch.style.background = groupColor(n.group);
        chip.textContent = n.group;
        chip.style.background = groupColor(n.group);
        chip.style.display = n.group ? '' : 'none';
        network.body.data.nodes.update(visNodeObject(n));
      };
      groupInput.addEventListener('input', applyGroup);
      groupInput.addEventListener('change', function () {
        applyGroup();
        renderGroupDatalist(); // new names become suggestions
      });
      groupInput.addEventListener('blur', function () {
        applyGroup();
        renderGroupDatalist(); // ensure datalist reflects the committed name
      });

      editBtn.addEventListener('click', function () {
        editLine.hidden = !editLine.hidden;
        if (!editLine.hidden) {
          labelInput.focus();
          labelInput.select();
        }
      });

      editLine.appendChild(labelInput);
      editLine.appendChild(groupInput);

      mainLine.appendChild(idSpan);
      mainLine.appendChild(swatch);
      mainLine.appendChild(nameSpan);
      mainLine.appendChild(chip);
      mainLine.appendChild(editBtn);
      mainLine.appendChild(del);

      row.appendChild(mainLine);
      row.appendChild(weightLine);
      row.appendChild(editLine);
      el.appendChild(row);
    });

    applyNodeHighlight();
  }

  function renderEdgeList() {
    var el = document.getElementById('edgeList');
    el.innerHTML = '';

    if (graph.edges.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No edges. Use "Connect nodes" to add them.';
      el.appendChild(empty);
      updateSelectAll();
      updateBulkBar();
      return;
    }

    graph.edges.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'edge-row';
      row.setAttribute('data-key', e.source + '__' + e.target);

      var sep = graph.directed ? ' \u2192 ' : ' \u2014 ';
      var edgeName = labelOf(e.source) + sep + labelOf(e.target);

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.title = 'Select for bulk editing';
      cb.setAttribute('aria-label', 'Select edge ' + edgeName + ' for bulk editing');
      cb.checked = bulkSelected.has(e);
      cb.addEventListener('change', function () {
        if (cb.checked) bulkSelected.add(e); else bulkSelected.delete(e);
        updateSelectAll();
        updateBulkBar();
      });

      var lbl = document.createElement('span');
      lbl.className = 'edge-label';
      lbl.textContent = edgeName;
      lbl.title = edgeName;

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 1;
      slider.step = 0.01;
      slider.value = e.weight;
      slider.setAttribute('aria-label', 'Weight of edge ' + edgeName);

      var val = document.createElement('span');
      val.className = 'edge-val';
      val.textContent = Number(e.weight).toFixed(2);

      slider.addEventListener('input', function () {
        e.weight = Number(slider.value);
        val.textContent = e.weight.toFixed(2);
        network.body.data.edges.update(edgeVisObject(e));
      });

      var del = document.createElement('button');
      del.className = 'edge-del';
      del.textContent = '\u2715';
      del.title = 'Remove this edge';
      del.setAttribute('aria-label', 'Remove edge ' + edgeName);
      del.addEventListener('click', function () { deleteEdge(e.source, e.target); });

      row.appendChild(cb);
      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(val);
      row.appendChild(del);
      el.appendChild(row);
    });

    applyEdgeHighlight();
    updateSelectAll();
    updateBulkBar();
  }

  function updateSelectAll() {
    var cb = document.getElementById('selectAllEdges');
    if (!cb) return;
    var all = graph.edges.length > 0 && graph.edges.every(function (e) { return bulkSelected.has(e); });
    cb.checked = all;
    cb.indeterminate = !all && bulkSelected.size > 0;
  }

  function updateBulkBar() {
    var bar = document.getElementById('bulkBar');
    if (!bar) return;
    var count = bulkSelected.size;
    if (count === 0) { bar.hidden = true; return; }
    bar.hidden = false;
    document.getElementById('bulkCount').textContent = count + ' selected';
    var first = null, uniform = true;
    bulkSelected.forEach(function (e) {
      if (first === null) first = e.weight;
      else if (e.weight !== first) uniform = false;
    });
    if (uniform && first !== null) {
      document.getElementById('bulkSlider').value = first;
      document.getElementById('bulkVal').textContent = Number(first).toFixed(2);
    } else {
      document.getElementById('bulkVal').textContent = '\u2014';
    }
  }

  function applyBulkWeight(value) {
    bulkSelected.forEach(function (e) {
      e.weight = value;
      network.body.data.edges.update(edgeVisObject(e));
      var row = getEdgeRow(e.source + '__' + e.target);
      if (row) {
        var s = row.querySelector('input[type="range"]');
        var v = row.querySelector('.edge-val');
        if (s) s.value = value;
        if (v) v.textContent = Number(value).toFixed(2);
      }
    });
    document.getElementById('bulkVal').textContent = Number(value).toFixed(2);
  }

  function clearBulkSelection() {
    bulkSelected.clear();
    var boxes = document.querySelectorAll('#edgeList .edge-row input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
    document.getElementById('bulkCount').textContent = '0 selected';
    updateSelectAll();
    updateBulkBar();
  }

  // ------------------------------------------------------------------- load/save

  function baseFilename() {
    return (graph.meta.name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'keygraph';
  }

  function downloadText(filename, text, mimeType) {
    var blob = new Blob([text], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function saveToFile() {
    syncPositions();
    downloadText(baseFilename() + '.json', JSON.stringify(graph, null, 2), 'application/json');
    setMessage('Saved JSON (' + graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges).');
  }

  // ------------------------------------------------------------------- import

  function detectFormat(text) {
    var s = String(text).replace(/^\uFEFF/, '').replace(/^\s+/, '').toLowerCase();
    if (s.indexOf('<graphml') >= 0) return 'graphml';
    if (/^graph\s*\[/m.test(String(text))) return 'gml';
    return 'json';
  }

  // ---- GML (plain-text; node ids are integers, labels are strings) ----

  function tokenizeGML(text) {
    var tokens = [];
    var i = 0, n = text.length;
    while (i < n) {
      var ch = text[i];
      if (ch === '#') { while (i < n && text[i] !== '\n') i++; continue; }
      if (ch === '[' || ch === ']') { tokens.push(ch); i++; continue; }
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        var str = '';
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n && (text[i + 1] === '"' || text[i + 1] === '\\')) {
            str += text[i + 1]; i += 2; continue;
          }
          str += text[i]; i++;
        }
        tokens.push(str);
        i++;
        continue;
      }
      var j = i;
      while (j < n && !/\s/.test(text[j]) && text[j] !== '[' && text[j] !== ']' && text[j] !== '#') j++;
      tokens.push(text.slice(i, j));
      i = j;
    }
    return tokens;
  }

  // Recursively parse "key value" pairs inside a "[ ... ]" block. Repeated
  // keys (e.g. node/edge) become arrays.
  function parseGMLList(tokens, pos) {
    var items = {};
    pos++; // skip '['
    while (pos < tokens.length && tokens[pos] !== ']') {
      var key = tokens[pos]; pos++;
      var val;
      if (tokens[pos] === '[') {
        var sub = parseGMLList(tokens, pos);
        val = sub.value; pos = sub.next;
      } else {
        val = tokens[pos]; pos++;
      }
      if (Object.prototype.hasOwnProperty.call(items, key)) {
        if (!Array.isArray(items[key])) items[key] = [items[key]];
        items[key].push(val);
      } else {
        items[key] = val;
      }
    }
    return { value: items, next: pos + 1 }; // skip ']'
  }

  function asArray(v) { return Array.isArray(v) ? v : (v === undefined ? [] : [v]); }

  function parseGML(text) {
    var tokens = tokenizeGML(text);
    if (tokens[0] !== 'graph') throw new Error('not a GML file (expected "graph [")');
    var g = parseGMLList(tokens, 1).value;
    var directed = String(g.directed) === '1';
    var meta = { name: g.label || '', description: g.comment || '' };
    var nodes = [], idToIdx = {};
    asArray(g.node).forEach(function (nd, idx) {
      var id = nd.id !== undefined ? String(nd.id) : 'N' + idx;
      var graphics = Array.isArray(nd.graphics) ? nd.graphics[0] : nd.graphics;
      nodes.push({
        id: id,
        label: nd.label !== undefined ? String(nd.label) : id,
        group: nd.group !== undefined ? String(nd.group) : '',
        weight: nd.weight !== undefined ? Number(nd.weight) : undefined,
        x: graphics && graphics.x !== undefined ? Number(graphics.x) : undefined,
        y: graphics && graphics.y !== undefined ? Number(graphics.y) : undefined
      });
      idToIdx[id] = nodes.length - 1;
    });
    var edges = [], seen = new Set();
    asArray(g.edge).forEach(function (e) {
      var s = String(e.source), t = String(e.target);
      if (s === t) return; // self-loop
      if (idToIdx[s] === undefined || idToIdx[t] === undefined) return; // dangling edge
      var ed = String(e.directed);
      if (ed === '1' || ed === '0') {
        if ((ed === '1') !== directed) throw new Error('mixed directed/undirected edges are not supported');
      }
      // In directed mode the two directions are distinct edges; only parallel
      // edges in the same direction are deduplicated.
      var key = directed ? s + '__' + t : (s < t ? s + '__' + t : t + '__' + s);
      if (seen.has(key)) return; // parallel edges -> keep one
      seen.add(key);
      edges.push({ source: s, target: t, weight: e.weight !== undefined ? Number(e.weight) : undefined });
    });
    return { meta: meta, directed: directed, nodes: nodes, edges: edges };
  }

  // ---- GraphML (XML with typed attributes) ----

  // Read the value of the <data> child whose key maps to the given attr.name.
  function dataAttr(el, name, keys) {
    for (var i = 0; i < el.children.length; i++) {
      var d = el.children[i];
      if (d.tagName !== 'data') continue;
      if (keys[d.getAttribute('key')] === name) return d.textContent;
    }
    return undefined;
  }

  function parseGraphML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('not valid GraphML XML');
    var keys = {};
    var keyEls = doc.getElementsByTagName('key');
    for (var i = 0; i < keyEls.length; i++) {
      var k = keyEls[i];
      keys[k.getAttribute('id')] = k.getAttribute('attr.name');
    }
    var graphEl = doc.getElementsByTagName('graph')[0];
    if (!graphEl) throw new Error('GraphML: no <graph> element');
    var directed = graphEl.getAttribute('edgedefault') === 'directed';

    var meta = {
      name: dataAttr(graphEl, 'name', keys) || '',
      description: dataAttr(graphEl, 'description', keys) || ''
    };

    var nodes = [], nodeIds = new Set();
    var nodeEls = doc.getElementsByTagName('node');
    for (var a = 0; a < nodeEls.length; a++) {
      var el = nodeEls[a];
      var id = el.getAttribute('id');
      var w = dataAttr(el, 'weight', keys);
      var x = dataAttr(el, 'x', keys);
      var y = dataAttr(el, 'y', keys);
      nodeIds.add(id);
      nodes.push({
        id: id,
        label: dataAttr(el, 'label', keys) || id,
        group: dataAttr(el, 'group', keys) || '',
        weight: w !== undefined ? Number(w) : undefined,
        x: x !== undefined ? Number(x) : undefined,
        y: y !== undefined ? Number(y) : undefined
      });
    }

    var edges = [], seen = new Set();
    var edgeEls = doc.getElementsByTagName('edge');
    for (var b = 0; b < edgeEls.length; b++) {
      var s = edgeEls[b].getAttribute('source');
      var t = edgeEls[b].getAttribute('target');
      var edgeDirected = edgeEls[b].getAttribute('directed');
      if (edgeDirected === 'true' || edgeDirected === 'false') {
        if ((edgeDirected === 'true') !== directed) throw new Error('mixed directed/undirected edges are not supported');
      }
      if (s === t) continue; // self-loop
      if (!nodeIds.has(s) || !nodeIds.has(t)) continue; // dangling edge
      // In directed mode the two directions are distinct edges.
      var ek = directed ? s + '__' + t : (s < t ? s + '__' + t : t + '__' + s);
      if (seen.has(ek)) continue; // parallel edges -> keep one
      seen.add(ek);
      var ew = dataAttr(edgeEls[b], 'weight', keys);
      edges.push({ source: s, target: t, weight: ew !== undefined ? Number(ew) : undefined });
    }
    return { meta: meta, directed: directed, nodes: nodes, edges: edges };
  }

  function parseGraphFile(text) {
    var fmt = detectFormat(text);
    if (fmt === 'graphml') return parseGraphML(text);
    if (fmt === 'gml') return parseGML(text);
    var parsed = JSON.parse(text);
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('file must contain "nodes" and "edges" arrays');
    }
    return parsed;
  }

  function loadFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = parseGraphFile(reader.result);
        graph = normalize(parsed);
        rebuild();
        setMessage('Loaded "' + (graph.meta.name || '(unnamed)') + '" (' +
          graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges, ' +
          (graph.directed ? 'directed' : 'undirected') + ').');
      } catch (err) {
        setMessage('Failed to load: ' + err.message, true);
      }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------ export

  var EXPORT_FORMATS = [
    { id: 'gml', ext: 'gml', mime: 'application/x-gml', label: 'GML' },
    { id: 'graphml', ext: 'graphml', mime: 'application/xml', label: 'GraphML' },
    { id: 'dot', ext: 'dot', mime: 'text/vnd.graphviz', label: 'DOT' }
  ];

  function roundNum(x) { return Math.round(x * 100) / 100; }

  function escapeQuoted(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function nodeIndex(id) {
    for (var i = 0; i < graph.nodes.length; i++) {
      if (graph.nodes[i].id === id) return i;
    }
    return -1;
  }

  // Only edges whose endpoints still exist (defensive; the editor removes
  // incident edges when a node is deleted, so this is normally a no-op).
  function liveEdges() {
    return graph.edges.filter(function (e) {
      return nodeIndex(e.source) >= 0 && nodeIndex(e.target) >= 0;
    });
  }

  // GML: compact plain-text, read by igraph / NetworkX / Gephi / yEd.
  function toGML() {
    var l = ['graph ['];
    l.push('  directed ' + (graph.directed ? '1' : '0'));
    l.push('  id 0');
    if (graph.meta.name) l.push('  label "' + escapeQuoted(graph.meta.name) + '"');
    if (graph.meta.description) l.push('  comment "' + escapeQuoted(graph.meta.description) + '"');
    graph.nodes.forEach(function (n) {
      l.push('  node [');
      l.push('    id ' + nodeIndex(n.id));
      l.push('    label "' + escapeQuoted(n.label || n.id) + '"');
      if (n.group) l.push('    group "' + escapeQuoted(n.group) + '"');
      if (typeof n.weight === 'number') l.push('    weight ' + n.weight.toFixed(6));
      if (typeof n.x === 'number' && typeof n.y === 'number') {
        l.push('    graphics [');
        l.push('      x ' + roundNum(n.x));
        l.push('      y ' + roundNum(n.y));
        l.push('    ]');
      }
      l.push('  ]');
    });
    liveEdges().forEach(function (e) {
      l.push('  edge [');
      l.push('    source ' + nodeIndex(e.source));
      l.push('    target ' + nodeIndex(e.target));
      l.push('    weight ' + e.weight.toFixed(6));
      l.push('  ]');
    });
    l.push(']');
    return l.join('\n') + '\n';
  }

  // GraphML: XML with typed attributes; the most interoperable format.
  function toGraphML() {
    var hasGroup = graph.nodes.some(function (n) { return n.group; });
    var hasPos = graph.nodes.some(function (n) {
      return typeof n.x === 'number' && typeof n.y === 'number';
    });
    var l = [];
    l.push('<?xml version="1.0" encoding="UTF-8"?>');
    l.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns"');
    l.push('         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    l.push('         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
    l.push('  <key id="d_name" for="graph" attr.name="name" attr.type="string"/>');
    l.push('  <key id="d_desc" for="graph" attr.name="description" attr.type="string"/>');
    l.push('  <key id="d_label" for="node" attr.name="label" attr.type="string"/>');
    l.push('  <key id="d_w" for="node" attr.name="weight" attr.type="double"/>');
    if (hasGroup) l.push('  <key id="d_group" for="node" attr.name="group" attr.type="string"/>');
    if (hasPos) {
      l.push('  <key id="d_x" for="node" attr.name="x" attr.type="double"/>');
      l.push('  <key id="d_y" for="node" attr.name="y" attr.type="double"/>');
    }
    l.push('  <key id="d_weight" for="edge" attr.name="weight" attr.type="double"/>');
    l.push('  <graph id="G" edgedefault="' + (graph.directed ? 'directed' : 'undirected') + '">');
    l.push('    <data key="d_name">' + escapeXml(graph.meta.name) + '</data>');
    l.push('    <data key="d_desc">' + escapeXml(graph.meta.description) + '</data>');
    graph.nodes.forEach(function (n) {
      l.push('    <node id="' + escapeXml(n.id) + '">');
      l.push('      <data key="d_label">' + escapeXml(n.label || n.id) + '</data>');
      l.push('      <data key="d_w">' + n.weight.toFixed(6) + '</data>');
      if (n.group) l.push('      <data key="d_group">' + escapeXml(n.group) + '</data>');
      if (typeof n.x === 'number' && typeof n.y === 'number') {
        l.push('      <data key="d_x">' + roundNum(n.x) + '</data>');
        l.push('      <data key="d_y">' + roundNum(n.y) + '</data>');
      }
      l.push('    </node>');
    });
    liveEdges().forEach(function (e) {
      l.push('    <edge source="' + escapeXml(e.source) + '" target="' + escapeXml(e.target) + '">');
      l.push('      <data key="d_weight">' + e.weight.toFixed(6) + '</data>');
      l.push('    </edge>');
    });
    l.push('  </graph>');
    l.push('</graphml>');
    return l.join('\n') + '\n';
  }

  // DOT: Graphviz graph description language, handy for rendering.
  function toDOT() {
    var l = [graph.directed ? 'digraph G {' : 'graph G {'];
    if (graph.meta.name) l.push('  graph [label="' + escapeQuoted(graph.meta.name) + '"];');
    graph.nodes.forEach(function (n) {
      var attrs = [];
      if (n.label && n.label !== n.id) attrs.push('label="' + escapeQuoted(n.label) + '"');
      if (typeof n.weight === 'number') attrs.push('weight=' + n.weight.toFixed(6));
      if (n.group) attrs.push('group="' + escapeQuoted(n.group) + '"');
      if (typeof n.x === 'number' && typeof n.y === 'number') {
        attrs.push('pos="' + roundNum(n.x) + ',' + roundNum(n.y) + '"');
      }
      l.push('  "' + escapeQuoted(n.id) + '"' + (attrs.length ? ' [' + attrs.join(', ') + ']' : '') + ';');
    });
    liveEdges().forEach(function (e) {
      l.push('  "' + escapeQuoted(e.source) + '"' + (graph.directed ? ' -> ' : ' -- ') + '"' + escapeQuoted(e.target) +
        '" [weight=' + e.weight.toFixed(6) + '];');
    });
    l.push('}');
    return l.join('\n') + '\n';
  }

  function exportGraph(format) {
    syncPositions();
    var fmt = EXPORT_FORMATS.find(function (f) { return f.id === format; });
    if (!fmt) return;
    var text = fmt.id === 'gml' ? toGML()
             : fmt.id === 'graphml' ? toGraphML()
             : toDOT();
    downloadText(baseFilename() + '.' + fmt.ext, text, fmt.mime);
    setMessage('Exported ' + fmt.label + ' (' + graph.nodes.length + ' nodes, ' +
      graph.edges.length + ' edges).');
  }

  function toggleExportMenu() {
    var menu = document.getElementById('exportMenu');
    var wasHidden = menu.hidden;
    menu.hidden = true;
    if (wasHidden) menu.hidden = false;
    var btn = document.getElementById('btnExport');
    if (btn) btn.setAttribute('aria-expanded', wasHidden ? 'true' : 'false');
  }

  function closeExportMenu() {
    document.getElementById('exportMenu').hidden = true;
    var btn = document.getElementById('btnExport');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleAddNodeMenu() {
    var menu = document.getElementById('addNodeMenu');
    var wasHidden = menu.hidden;
    menu.hidden = true;
    if (wasHidden) menu.hidden = false;
    var btn = document.getElementById('btnAddNode');
    if (btn) btn.setAttribute('aria-expanded', wasHidden ? 'true' : 'false');
  }

  function closeAddNodeMenu() {
    document.getElementById('addNodeMenu').hidden = true;
    var btn = document.getElementById('btnAddNode');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // ---------------------------------------------------------- context menu

  function hideContextMenu() {
    document.getElementById('contextMenu').hidden = true;
  }

  function showContextMenu(x, y, items) {
    if (!items || items.length === 0) return;
    var menu = document.getElementById('contextMenu');
    menu.innerHTML = '';
    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.textContent = item.label;
      if (item.danger) btn.className = 'danger';
      btn.addEventListener('click', function () {
        hideContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    });
    menu.hidden = false;
    // Keep the menu fully on screen near the cursor.
    var r = menu.getBoundingClientRect();
    var px = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    var py = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
  }

  // The hidden name/group editor lives in the node list; open (and scroll to) it.
  function openNodeEditor(id) {
    var row = getNodeRow(id);
    if (!row) return;
    var editLine = row.querySelector('.node-edit-line');
    if (editLine && editLine.hidden) {
      var editBtn = row.querySelector('.node-edit');
      if (editBtn) editBtn.click();
    }
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function nodeContextMenu(id) {
    return [
      { label: 'Edit name / group', action: function () { openNodeEditor(id); } },
      { label: 'Delete node', danger: true, action: function () { deleteNode(id); } }
    ];
  }

  function edgeContextMenu(key) {
    var list = graph.edges.filter(function (e) { return matchesVisKey(e, key); });
    if (list.length === 0) return [];
    var multi = graph.directed && list.length > 1;
    return [
      {
        label: 'Jump to in list',
        action: function () { highlightEdgeRows(edgeRowKeysForVisKeys([key])); }
      },
      {
        label: multi ? 'Delete edge (both directions)' : 'Delete edge',
        danger: true,
        action: function () { deleteEdgesForVisKey(key); }
      }
    ];
  }

  function canvasContextMenu() {
    return [
      { label: 'Add node', action: addNode },
      { label: 'Auto-layout', action: runAutoLayout }
    ];
  }

  // Edges are thin curves, so probe a small neighborhood around the pointer to
  // make right-clicking an edge forgiving.
  function edgeAtPointer(x, y) {
    var e = network.getEdgeAt({ x: x, y: y });
    if (e) return e;
    for (var dx = -4; dx <= 4; dx += 2) {
      for (var dy = -4; dy <= 4; dy += 2) {
        if (dx === 0 && dy === 0) continue;
        e = network.getEdgeAt({ x: x + dx, y: y + dy });
        if (e) return e;
      }
    }
    return null;
  }

  function onCanvasContextMenu(evt) {
    if (!network) return;
    var rect = document.getElementById('network').getBoundingClientRect();
    var x = evt.clientX - rect.left;
    var y = evt.clientY - rect.top;
    evt.preventDefault();
    var nodeId = network.getNodeAt({ x: x, y: y });
    if (nodeId) {
      showContextMenu(evt.clientX, evt.clientY, nodeContextMenu(nodeId));
      return;
    }
    var edgeId = edgeAtPointer(x, y);
    if (edgeId) {
      showContextMenu(evt.clientX, evt.clientY, edgeContextMenu(edgeId));
      return;
    }
    showContextMenu(evt.clientX, evt.clientY, canvasContextMenu());
  }

  // --------------------------------------------------------------------- ui

  function rebuild() {
    if (network) network.destroy();
    layoutSnapshot = null;
    bulkSelected.clear();
    highlightedEdgeKeys = new Set();
    highlightedNodeKeys = new Set();
    document.getElementById('graphName').value = graph.meta.name || '';
    buildNetwork();
    renderNodeList();
    renderEdgeList();
    renderStats();
    updateLayoutButtons();
    updateModeButton();
  }

  function setMessage(text, isError) {
    var el = document.getElementById('message');
    el.textContent = text;
    el.className = 'hint' + (isError ? ' error' : '');
    // Status is announced politely, errors assertively.
    el.setAttribute('role', isError ? 'alert' : 'status');
  }

  function getEdgeRow(key) {
    var rows = document.querySelectorAll('#edgeList .edge-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-key') === key) return rows[i];
    }
    return null;
  }

  function applyEdgeHighlight() {
    var rows = document.querySelectorAll('#edgeList .edge-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected', highlightedEdgeKeys.has(rows[i].getAttribute('data-key')));
    }
  }

  function getNodeRow(id) {
    var rows = document.querySelectorAll('#nodeList .node-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === id) return rows[i];
    }
    return null;
  }

  function applyNodeHighlight() {
    var rows = document.querySelectorAll('#nodeList .node-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected', highlightedNodeKeys.has(rows[i].getAttribute('data-id')));
    }
  }

  function highlightEdgeRows(keys) {
    highlightedEdgeKeys = new Set(keys || []);
    applyEdgeHighlight();
    // Scroll to + focus a single selected edge (edge click); skip for multi
    // highlights (e.g. all edges of a clicked node).
    if (highlightedEdgeKeys.size === 1) {
      var row = getEdgeRow(Array.from(highlightedEdgeKeys)[0]);
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        var s = row.querySelector('input[type="range"]');
        if (s) s.focus();
      }
    }
  }

  function highlightNodeRows(keys) {
    highlightedNodeKeys = new Set(keys || []);
    applyNodeHighlight();
    // Scroll a single selected node into view (node click).
    if (highlightedNodeKeys.size === 1) {
      var row = getNodeRow(Array.from(highlightedNodeKeys)[0]);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Re-sync the list highlight from the current vis-network selection. Called on
  // every selection event so the list always matches the view. Deferred to the
  // next tick because, when clicking an edge that was already selected as part
  // of a node's connected edges, vis emits deselect events first and then
  // silently re-selects the clicked edge — only after that is the final
  // selection state available.
  function syncHighlight() {
    setTimeout(function () {
      if (!network) return;
      highlightEdgeRows(edgeRowKeysForVisKeys(network.getSelectedEdges()));
      highlightNodeRows(network.getSelectedNodes());
    }, 0);
  }

  function toggleEdgeLabels() {
    showEdgeLabels = !showEdgeLabels;
    var btn = document.getElementById('btnEdgeLabels');
    btn.textContent = 'Edge labels: ' + (showEdgeLabels ? 'on' : 'off');
    btn.classList.toggle('active', showEdgeLabels);
    // vis-network does not reliably clear an edge label via update() when it
    // is set to an empty string, so rebuild the edges to apply/remove labels.
    var edges = network.body.data.edges;
    edges.clear();
    edges.add(visEdges());
    setMessage(showEdgeLabels ? 'Edge labels on.' : 'Edge labels off.');
  }

  function toggleConnect() {
    connectMode = !connectMode;
    connectSource = null;
    network.unselectAll();
    document.getElementById('btnConnect').classList.toggle('active', connectMode);
    setMessage(connectMode
      ? 'Connect mode: click two nodes to add an edge (click empty space to cancel).'
      : 'Connect mode off.');
  }

  function snapshotPositions() {
    syncPositions();
    return graph.nodes
      .filter(function (n) { return typeof n.x === 'number' && typeof n.y === 'number'; })
      .map(function (n) { return { id: n.id, x: n.x, y: n.y }; });
  }

  function runAutoLayout() {
    layoutSnapshot = snapshotPositions();
    network.stabilize(250);
    setMessage('Running auto-layout\u2026');
  }

  function undoLayout() {
    if (!layoutSnapshot || layoutSnapshot.length === 0) {
      setMessage('Nothing to undo.', true);
      return;
    }
    network.setOptions({ physics: { enabled: false, stabilization: { enabled: false } } });
    layoutSnapshot.forEach(function (p) {
      var n = graph.nodes.find(function (x) { return x.id === p.id; });
      if (n) { n.x = p.x; n.y = p.y; }
    });
    layoutSnapshot = null;
    network.body.data.nodes.update(graph.nodes.map(visNodeObject));
    updateLayoutButtons();
    setMessage('Layout restored.');
  }

  function updateLayoutButtons() {
    var undo = document.getElementById('btnUndoLayout');
    if (undo) undo.disabled = !layoutSnapshot;
  }

  // Draggable handle between the canvas and the sidebar lets the user resize
  // the right-hand panel (clamped to a sensible range).
  function initResizer() {
    var resizer = document.getElementById('resizer');
    var sidebar = document.getElementById('sidebar');
    var startX = 0;
    var startW = 0;
    resizer.addEventListener('pointerdown', function (evt) {
      startX = evt.clientX;
      startW = sidebar.getBoundingClientRect().width;
      resizer.setPointerCapture(evt.pointerId);
      document.body.classList.add('resizing');
      evt.preventDefault();
    });
    resizer.addEventListener('pointermove', function (evt) {
      if (evt.buttons !== 1) return;
      var w = startW + (startX - evt.clientX);
      w = Math.max(260, Math.min(600, w));
      sidebar.style.flexBasis = w + 'px';
      sidebar.style.width = w + 'px';
    });
    resizer.addEventListener('pointerup', function () {
      document.body.classList.remove('resizing');
    });
    resizer.addEventListener('pointercancel', function () {
      document.body.classList.remove('resizing');
    });
  }

  function init() {
    graph = sampleGraph();
    rebuild();
    initResizer();

    document.getElementById('btnNew').addEventListener('click', function () {
      var n = parseInt(document.getElementById('nodeCount').value, 10);
      if (!isFinite(n) || n < 1) n = NUM_NODES;
      var edgeCount = graph.directed ? n * (n - 1) : n * (n - 1) / 2;
      var msg = 'Replace the current graph with a new complete graph (' + n + ' nodes, ' +
        edgeCount + ' edges, ' + (graph.directed ? 'directed' : 'undirected') + ')?\n' +
        'This removes the current graph (' + graph.nodes.length + ' nodes, ' +
        graph.edges.length + ' edges).';
      if (!window.confirm(msg)) return;
      graph = newCompleteGraph(n, graph.directed);
      rebuild();
      setMessage('New complete graph (' + n + ' nodes, ' + edgeCount + ' edges, ' +
        (graph.directed ? 'directed' : 'undirected') + ').');
    });
    document.getElementById('btnAddNode').addEventListener('click', toggleAddNodeMenu);
    var addNodeBtns = document.querySelectorAll('#addNodeMenu button');
    for (var i = 0; i < addNodeBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (btn.getAttribute('data-mode') === 'connected') addFullyConnectedNode();
          else addNode();
          closeAddNodeMenu();
        });
      })(addNodeBtns[i]);
    }
    document.addEventListener('click', function (evt) {
      var wrap = document.getElementById('addNodeWrap');
      if (wrap && !wrap.contains(evt.target)) closeAddNodeMenu();
    });
    document.getElementById('btnLoad').addEventListener('click', function () {
      document.getElementById('fileInput').click();
    });
    document.getElementById('btnSave').addEventListener('click', saveToFile);
    document.getElementById('btnExport').addEventListener('click', toggleExportMenu);
    var exportBtns = document.querySelectorAll('#exportMenu button');
    for (var i = 0; i < exportBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          exportGraph(btn.getAttribute('data-format'));
          closeExportMenu();
        });
      })(exportBtns[i]);
    }
    document.addEventListener('click', function (evt) {
      var wrap = document.getElementById('exportWrap');
      if (wrap && !wrap.contains(evt.target)) closeExportMenu();
    });
    document.getElementById('network').addEventListener('contextmenu', onCanvasContextMenu);
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('keydown', function (evt) {
      if (evt.key === 'Escape') hideContextMenu();
    });
    window.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('resize', hideContextMenu);
    document.getElementById('fileInput').addEventListener('change', function (evt) {
      if (evt.target.files && evt.target.files[0]) loadFromFile(evt.target.files[0]);
      evt.target.value = '';
    });
    document.getElementById('btnConnect').addEventListener('click', toggleConnect);
    document.getElementById('btnMode').addEventListener('click', toggleMode);
    document.getElementById('btnDeleteEdge').addEventListener('click', deleteSelectedEdges);
    document.getElementById('btnAutoLayout').addEventListener('click', runAutoLayout);
    document.getElementById('btnUndoLayout').addEventListener('click', undoLayout);
    document.getElementById('btnEdgeLabels').addEventListener('click', toggleEdgeLabels);
    document.getElementById('bulkSlider').addEventListener('input', function () {
      applyBulkWeight(Number(this.value));
    });
    document.getElementById('btnBulkClear').addEventListener('click', clearBulkSelection);
    document.getElementById('selectAllEdges').addEventListener('change', function () {
      if (this.checked) {
        graph.edges.forEach(function (e) { bulkSelected.add(e); });
      } else {
        bulkSelected.clear();
      }
      renderEdgeList();
      updateBulkBar();
    });
    document.getElementById('graphName').addEventListener('input', function (evt) {
      graph.meta.name = evt.target.value;
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
