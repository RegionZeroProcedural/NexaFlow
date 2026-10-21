/** Project call board: each project function becomes a regular Function node
 * on the main canvas (EXEC/DONE + one data input per parameter). Call links
 * are drawn as an overlay rather than graph edges, because call graphs may
 * contain cycles (recursion) and fan-in, which flow edges forbid. */
import { getNodeHeight } from '../../data/node-types';

const COL_W = 380, ROW_GAP = 42;

export function boardNodeId(fnId) { return `fn:${fnId}`.slice(0, 300); }

function functionNode(fn) {
  const inputCount = Math.min(16, fn.params.length);
  return {
    id: boardNodeId(fn.id), type: 'function', x: 0, y: 0,
    title: fn.name.slice(0, 80),
    description: `${fn.path}:${fn.line}`.slice(-400),
    value: true, inputCount, outputCount: 1, triggerMode: 'signal', language: 'javascript', shape: 'rounded',
    functionName: fn.name.split(/[.›\s]/).filter(Boolean).pop()?.replace(/[^\w$]/g, '').slice(0, 80) || 'fn',
    portTypes: {},
    portLabels: Object.fromEntries(fn.params.slice(0, 16).map((p, i) => [`in${i + 1}`, p.replace(/\s*=.*$/, '').replace(/^\.\.\./, '…').slice(0, 14)])),
    code: `// ${fn.name}(${fn.params.join(', ')})\n// ${fn.path}:${fn.line}–${fn.endLine} · open the microscope to dissect and run it`.slice(0, 2000),
    projectFunctionId: fn.id,
    projectMeta: { path: fn.path, line: fn.line, calls: fn.calls.filter(c => c.targetId).length, callers: fn.callers.length, async: fn.async, kind: fn.kind, lines: fn.lines },
  };
}

/** Build a board around `focusId`: its callers on the left, then callees in
 * breadth-first columns to the right. */
export function buildCallBoard(project, focusId, { depth = 3, maxNodes = 90 } = {}) {
  const focus = project.functions[focusId];
  if (!focus) throw new Error('Function not found');
  const level = new Map([[focusId, 0]]);
  const queue = [focusId];
  while (queue.length && level.size < maxNodes) {
    const id = queue.shift();
    if (level.get(id) >= depth) continue;
    for (const call of project.functions[id].calls) {
      if (!call.targetId || level.has(call.targetId) || level.size >= maxNodes) continue;
      level.set(call.targetId, level.get(id) + 1);
      queue.push(call.targetId);
    }
  }
  for (const caller of focus.callers.slice(0, 12)) if (!level.has(caller)) level.set(caller, -1);
  const columns = new Map();
  for (const [id, col] of level) { if (!columns.has(col)) columns.set(col, []); columns.get(col).push(id); }
  const nodes = [];
  for (const [col, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 120;
    const first = nodes.length;
    for (const id of ids) {
      const node = functionNode(project.functions[id]);
      node.x = 140 + (col + 1) * COL_W; node.y = y;
      y += getNodeHeight(node) + ROW_GAP;
      nodes.push(node);
    }
    // Center each column vertically around the focus row.
    const shift = Math.round(440 - (120 + (y - ROW_GAP - 120) / 2));
    for (const node of nodes.slice(first)) node.y += shift;
  }
  const present = new Set(level.keys());
  const linkMap = new Map();
  for (const id of present) for (const call of project.functions[id].calls) {
    if (!call.targetId || !present.has(call.targetId) || call.targetId === id) continue;
    const key = `${id}→${call.targetId}`;
    linkMap.set(key, { source: boardNodeId(id), target: boardNodeId(call.targetId), count: (linkMap.get(key)?.count || 0) + 1 });
  }
  return {
    name: `${project.name} • ${focus.name} call board`,
    nodes, edges: [],
    callLinks: [...linkMap.values()],
    projectBoard: { focusId, project: project.name },
  };
}
