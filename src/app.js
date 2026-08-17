/* keygraphjs — a small web editor for undirected, edge-weighted graphs.
 *
 * Runs entirely in the browser from a double-clicked HTML file (no server, no
 * build step). Uses vis-network (vendored locally).
 *
 * The JSON it reads/writes:
 *   {
 *     "meta": { "name": "...", "description": "..." },
 *     "nodes": [ { "id": "C1", "label": "crown", "group": "A", "weight": 0.5 }, ... ],
 *     "edges": [ { "source": "C1", "target": "C2", "weight": 0.90 }, ... ]
 *   }
 *
 * `nodes[].id`, `nodes[].weight`, `edges[].source/target/weight` carry the graph
 * data; `label` and `group` are human metadata; `x`/`y` are optional layout hints.
 */
(function () {
  'use strict';

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

  var graph = null;      // { meta, nodes, edges }
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

  function newCompleteGraph(n) {
    n = n || NUM_NODES;
    var nodes = [];
    for (var i = 0; i < n; i++) {
      nodes.push({ id: nodeId(i), label: nodeId(i), group: '', weight: DEFAULT_WEIGHT });
    }
    var edges = [];
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        edges.push({ source: nodeId(a), target: nodeId(b), weight: DEFAULT_WEIGHT });
      }
    }
    return { meta: { name: '', description: '' }, nodes: nodes, edges: edges };
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
      nodes: nodes,
      edges: edges
    };
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

  function edgeLabelText(e) { return showEdgeLabels ? Number(e.weight).toFixed(2) : ''; }

  function edgeVisObject(e) {
    return {
      id: e.source + '__' + e.target,
      from: e.source,
      to: e.target,
      title: labelOf(e.source) + ' \u2014 ' + labelOf(e.target) + ': ' + e.weight.toFixed(2),
      label: edgeLabelText(e),
      color: { color: edgeColor(e.weight) }
    };
  }

  function visEdges() {
    return graph.edges.map(edgeVisObject);
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
        addEdge(connectSource, id);
        network.unselectAll();
        connectSource = null;
        setMessage('Added edge ' + labelOf(connectSource) + ' \u2014 ' + labelOf(id) + '.');
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
      return (e.source === a && e.target === b) || (e.source === b && e.target === a);
    });
  }

  function addEdge(a, b) {
    if (a === b) return;
    if (edgeExists(a, b)) {
      setMessage('Edge ' + labelOf(a) + ' \u2014 ' + labelOf(b) + ' already exists.', true);
      return;
    }
    var e = { source: a, target: b, weight: DEFAULT_WEIGHT };
    graph.edges.push(e);
    network.body.data.edges.add(edgeVisObject(e));
    renderEdgeList();
    renderStats();
  }

  function deleteEdge(source, target) {
    var e = graph.edges.find(function (x) {
      return (x.source === source && x.target === target) || (x.source === target && x.target === source);
    });
    if (!e) return;
    graph.edges = graph.edges.filter(function (x) { return x !== e; });
    bulkSelected.delete(e);
    network.body.data.edges.remove([source + '__' + target, target + '__' + source]);
    renderEdgeList();
    renderStats();
    setMessage('Removed edge ' + labelOf(source) + ' \u2014 ' + labelOf(target) + '.');
  }

  function deleteSelectedEdges() {
    var sel = network.getSelectedEdges();
    if (sel.length === 0) { setMessage('No edge selected (click an edge first).', true); return; }
    var keys = sel.slice();
    graph.edges = graph.edges.filter(function (e) {
      var key = e.source + '__' + e.target;
      if (keys.indexOf(key) >= 0) { bulkSelected.delete(e); return false; }
      return true;
    });
    network.body.data.edges.remove(sel);
    renderEdgeList();
    renderStats();
    setMessage('Deleted ' + sel.length + ' edge(s).');
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
    var expected = n * (n - 1) / 2;
    document.getElementById('stats').textContent =
      n + ' nodes \u00b7 ' + graph.edges.length +
      ' edges (complete = ' + expected + ')';
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

      var del = document.createElement('button');
      del.className = 'edge-del';
      del.textContent = '\u2715';
      del.title = 'Remove this node (and its edges)';
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

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.title = 'Select for bulk editing';
      cb.checked = bulkSelected.has(e);
      cb.addEventListener('change', function () {
        if (cb.checked) bulkSelected.add(e); else bulkSelected.delete(e);
        updateSelectAll();
        updateBulkBar();
      });

      var lbl = document.createElement('span');
      lbl.className = 'edge-label';
      lbl.textContent = labelOf(e.source) + ' \u2014 ' + labelOf(e.target);
      lbl.title = e.source + ' \u2014 ' + e.target;

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0;
      slider.max = 1;
      slider.step = 0.01;
      slider.value = e.weight;

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

  function loadFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
          throw new Error('file must contain "nodes" and "edges" arrays');
        }
        graph = normalize(parsed);
        rebuild();
        setMessage('Loaded "' + (graph.meta.name || '(unnamed)') + '" (' +
          graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges).');
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
    l.push('  directed 0');
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
    l.push('  <graph id="G" edgedefault="undirected">');
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
    var l = ['graph G {'];
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
      l.push('  "' + escapeQuoted(e.source) + '" -- "' + escapeQuoted(e.target) +
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
  }

  function closeExportMenu() {
    document.getElementById('exportMenu').hidden = true;
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
  }

  function setMessage(text, isError) {
    var el = document.getElementById('message');
    el.textContent = text;
    el.className = 'hint' + (isError ? ' error' : '');
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
      highlightEdgeRows(network.getSelectedEdges());
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
      graph = newCompleteGraph(n);
      rebuild();
      setMessage('New complete graph (' + n + ' nodes, ' + (n * (n - 1) / 2) + ' edges).');
    });
    document.getElementById('btnAddNode').addEventListener('click', addNode);
    document.getElementById('btnSample').addEventListener('click', function () {
      graph = sampleGraph();
      rebuild();
      setMessage('Loaded sample graph (communities A/B + hubs).');
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
    document.getElementById('fileInput').addEventListener('change', function (evt) {
      if (evt.target.files && evt.target.files[0]) loadFromFile(evt.target.files[0]);
      evt.target.value = '';
    });
    document.getElementById('btnConnect').addEventListener('click', toggleConnect);
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
