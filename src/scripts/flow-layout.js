import { NODE_TYPES, getNodeHeight } from '../data/node-types';

/** Visual-only nodes belong to the data graph, not the execution CFG. */
const DATA_ONLY = new Set([
  'source-value', 'source-operator', 'source-member', 'source-ternary',
  'source-call-expr', 'source-object', 'source-array', 'source-template',
]);

function orderedFlowNodes(nodes) {
  return nodes.filter(node =>
    node.type.startsWith('source-') && (node.inspectOnly || !DATA_ONLY.has(node.type))
  );
}

function flowTopology(nodes, edges) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));

  for (const edge of edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }

  const degree = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]));
  const queue = nodes.filter(node => degree.get(node.id) === 0);
  const ordered = [];

  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    ordered.push(node);
    for (const edge of outgoing.get(node.id)) {
      degree.set(edge.target, degree.get(edge.target) - 1);
      if (!degree.get(edge.target)) queue.push(nodes[index.get(edge.target)]);
    }
  }
  return { ordered, incoming, outgoing, index };
}

// Consistent ordering keeps TRUE paths visually above FALSE and UNKNOWN paths.
const BRANCH_BIAS = { true: -0.32, false: 0.32, unknown: 0.65 };

/** Deterministic Sugiyama-style left-to-right graph layout.
 * Branch lanes are kept separate; a merge is placed near its incoming paths.
 * Geometry is independent of simulation and does not rewrite the code or CFG.
 */
export function layoutSourceFlow(nodes, edges, options = {}) {
  const flow = orderedFlowNodes(nodes);
  if (!flow.length) return nodes;
  const { ordered, incoming, index } = flowTopology(flow, edges);
  if (ordered.length !== flow.length) return nodes; // A cyclic CFG is not safely layoutable.

  const gapX = options.gapX ?? 100;
  const gapY = options.gapY ?? 65;
  const rank = new Map(), score = new Map(), columns = new Map();

  for (const node of ordered) {
    const incomingEdges = incoming.get(node.id);
    const r = incomingEdges.length
      ? Math.max(...incomingEdges.map(edge => (rank.get(edge.source) ?? 0) + 1))
      : 0;
    rank.set(node.id, r);
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(node);

    const incomingScore = incomingEdges.length
      ? incomingEdges.reduce((sum, edge) => sum + (score.get(edge.source) ?? 0)
          + (BRANCH_BIAS[edge.sourcePort] ?? 0), 0) / incomingEdges.length
      : 0;
    score.set(node.id, incomingScore);
  }

  const sortedRanks = [...columns.keys()].sort((a, b) => a - b);
  const widths = new Map(sortedRanks.map(r => [r,
    Math.max(...columns.get(r).map(node => NODE_TYPES[node.type]?.width ?? 245))]));
  let offsetX = 145;
  const xByRank = new Map();
  for (const r of sortedRanks) {
    xByRank.set(r, offsetX);
    offsetX += widths.get(r) + gapX;
  }

  // Positional barycentres in earlier columns avoid unnecessary crossings.
  // The original source order is the stable tiebreaker at branch merges.
  const centers = new Map();
  for (const r of sortedRanks) {
    const column = columns.get(r);
    column.sort((a, b) => {
      const favor = node => {
        const incomingEdges = incoming.get(node.id);
        if (!incomingEdges.length) return score.get(node.id) || 0;
        return incomingEdges.reduce((sum, edge) =>
          sum + (centers.get(edge.source) ?? score.get(edge.source) ?? 0)
            + (BRANCH_BIAS[edge.sourcePort] ?? 0) * 240, 0) / incomingEdges.length;
      };
      return favor(a) - favor(b) || score.get(a.id) - score.get(b.id)
        || index.get(a.id) - index.get(b.id);
    });

    // Each column uses the actual node heights. No box overlaps, even when
    // conditions have three exits and some nodes are unusually tall.
    let top = 0;
    for (const node of column) {
      centers.set(node.id, top + getNodeHeight(node) / 2);
      top += getNodeHeight(node) + gapY;
    }
    const totalHeight = top - gapY;
    const centerOffset = totalHeight / 2;
    for (const node of column) {
      centers.set(node.id, centers.get(node.id) - centerOffset);
    }
  }

  // The title and view tabs overlay the top edge of the canvas. Keep an
  // explicit upper gutter rather than positioning the entry behind them.
  const minCenter = Math.min(...centers.values());
  const yShift = 225 - minCenter;
  for (const node of flow) {
    node.x = Math.round(xByRank.get(rank.get(node.id)));
    node.y = Math.round(centers.get(node.id) + yShift);
  }
  return nodes;
}

/** Build a *presentation-only* layout for Data Dependencies. The real graph
 * keeps its original positions for source export, undo, and simulation. Atom
 * nodes and their owning assignments are arranged in separate readable rows.
 * The result is a list of clones; never mutate or save these coordinates.
 */
export function layoutSourceData(nodes, dataEdges = []) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const atomNodes = nodes.filter(node => node.id.startsWith('src_expr_') && node.parentNodeId);
  const ids = new Set(dataEdges.flatMap(edge => [edge.source, edge.target]));
  for (const node of atomNodes) ids.add(node.id);
  for (const node of atomNodes) ids.add(node.parentNodeId);
  const owners = nodes.filter(node => !node.id.startsWith('src_expr_') && ids.has(node.id));
  const result = [];
  let top = 210;

  for (const owner of owners.sort((a,b) => (a.sourceStart ?? 0) - (b.sourceStart ?? 0) || a.id.localeCompare(b.id))) {
    const atoms = atomNodes.filter(node => node.parentNodeId === owner.id);
    const cols = 3;
    const rowCount = Math.max(1, Math.ceil(atoms.length / cols));
    const height = Math.max(236, rowCount * 248);
    const h = getNodeHeight(owner);
    result.push({ ...owner, x: 1060, y: Math.round(top + (height - h) / 2) });
    atoms.forEach((node, index) => {
      result.push({ ...node, x: 160 + (index % cols) * 290,
        y: top + Math.floor(index / cols) * 248 });
    });
    top += height + 110;
  }
  return result;
}
