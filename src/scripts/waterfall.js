import { getNodePorts, isFunctionNode } from '../data/node-types';
import { checkWatchRule } from './forensics';

/** Playback is deliberately separate from execution. The simulator interprets
 * a pure, bounded expression subset once; this function lays out the resulting
 * assignment revisions and Watch observations as individually visible steps.
 * No imported source or arbitrary user code runs here.
 */
export function prepareWaterfallRun(graph, simulation) {
  if (graph.program?.kind === 'javascript-function') {
    const total = simulation.trace.length;
    const samples = (simulation.watchSamples || []).map((sample, index) => ({
      ...sample, id: sample.id || `source_watch_${index}`,
      step: Math.max(1, Math.min(total || 1, sample.executionStep || 1)),
      ordinal: index + 1,
    }));
    return { ...simulation, waterfallSamples: samples };
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const trace = simulation.trace || [];
  const functionSteps = new Map();
  trace.forEach((entry, index) => { if (isFunctionNode(byId.get(entry.nodeId) || {})) functionSteps.set(entry.nodeId, index); });
  const destinationIndices = new Map();
  trace.forEach((entry, index) => {
    if (byId.get(entry.nodeId)?.type === 'conditional') destinationIndices.set(entry.nodeId, index);
  });
  const incoming = new Map(graph.edges.map(e => [`${e.target}:${e.targetPort}`, e]));
  const outgoing = new Map();
  for (const edge of graph.edges) {
    const node = byId.get(edge.source);
    const port = node && getNodePorts(node).outputs.find(p => p.id === edge.sourcePort);
    if (!port || port.kind === 'flow') continue;
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge.target);
  }
  const consumedAt = id => {
    // For control-flow Functions, show each assignment AFTER its execution
    // step; DONE observations appear after successful completion, never at
    // the beginning of the run. Standalone Boolean-triggered Functions retain
    // the previous earliest-downstream-consumer placement.
    if (functionSteps.has(id)) return functionSteps.get(id) + 1;
    const inputEdge = incoming.get(`${id}:in`);
    if (inputEdge?.sourcePort === 'done' && functionSteps.has(inputEdge.source))
      return functionSteps.get(inputEdge.source) + 1;
    const visited = new Set([id]), queue = [id];
    let earliest = Infinity;
    while (queue.length) {
      const next = queue.shift();
      for (const target of outgoing.get(next) || []) {
        if (visited.has(target)) continue;
        visited.add(target);
        if (destinationIndices.has(target)) earliest = Math.min(earliest, destinationIndices.get(target));
        queue.push(target);
      }
    }
    return Number.isFinite(earliest) ? earliest : Math.min(1, trace.length);
  };
  // A pass-through Watch chain is still observing the original Function port.
  // Operators remain purely final-value transformations in this iteration.
  const functionSource = watch => {
    let node = watch, sourcePort = null;
    const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      const edge = incoming.get(`${node.id}:in`);
      if (!edge) return null;
      node = byId.get(edge.source);
      sourcePort = edge.sourcePort;
      if (node && isFunctionNode(node)) return sourcePort === 'done' ? null : { node, sourcePort };
      if (!node || !['watch', 'assert'].includes(node.type)) return null;
    }
    return null;
  };

  const watchNodes = graph.nodes.filter(node => node.type === 'watch');
  const dynamicWatchIds = new Set();
  const changesByNode = new Map();
  for (const revision of simulation.functionChanges || []) {
    if (!changesByNode.has(revision.nodeId)) changesByNode.set(revision.nodeId, []);
    changesByNode.get(revision.nodeId).push(revision);
  }
  const watchRule = node => ({
    check: node.check || 'range', min: node.min ?? 0, max: node.max ?? 100,
    expected: node.expected ?? 'true', expectedType: node.expectedType || 'number',
  });
  const sampleFor = ({ id, node, sourceNode, port, value, previousValue = null, variable, line = null, dependencies = [] }) => {
    const check = checkWatchRule(watchRule(node), value);
    return {
      id, nodeId: node.id, watchId: node.id, watchName: node.title,
      variable, port, value, previousValue,
      dataType: value == null ? 'unknown' : typeof value,
      state: check.failed ? (value == null ? 'unknown' : 'failed') : 'passed',
      reason: check.reason || 'Validation passed', sourceLine: line,
      dependencyEvents: dependencies, sourceNodeId: sourceNode?.id,
    };
  };
  // Bucket actions by the control-flow step immediately after which they occur.
  // Within a bucket, all variable changes precede function completion and DONE.
  const buckets = new Map();
  const addAction = (before, action) => {
    if (!buckets.has(before)) buckets.set(before, []);
    buckets.get(before).push(action);
  };
  // Replay every assignment with its own timeline position; Watch sees values
  // changing inside the body, not just its last returned value.
  for (const revision of simulation.functionChanges || []) {
    const parent = byId.get(revision.nodeId);
    const position = consumedAt(revision.nodeId);
    addAction(position, {
      kind: 'assignment', nodeId: revision.nodeId,
      title: `${parent?.title || revision.title}: ${revision.variable}`,
      type: 'function-assignment',
      detail: `Line ${revision.line} · ${revision.variable} updated`,
      revision,
    });
    for (const watch of watchNodes) {
      const source = functionSource(watch);
      if (!source || source.node.id !== revision.nodeId) continue;
      // Default watches observe all assignments, including named local state.
      // 'port' means only the connected outN. A specific identifier selects
      // just that local or output. DONE watches record completion separately.
      const mode = watch.traceVariable || 'all';
      const desired = mode === 'port' ? source.sourcePort : mode === 'named' ? watch.traceVariableName : '*';
      if (desired !== '*' && desired !== revision.variable) continue;
      dynamicWatchIds.add(watch.id);
      addAction(position, {
        kind: 'sample',
        sample: sampleFor({
          id: `revision_${revision.id}_${watch.id}`, node: watch,
          sourceNode: source.node, port: source.sourcePort,
          value: revision.value, previousValue: revision.previousValue,
          variable: `${source.node.title}.${revision.variable}`,
          line: revision.line,
          dependencies: [revision.id],
        }),
      });
    }
  }
  // Suppress final-value duplicates for dynamic watches, including a named
  // variable that was never assigned (rather than silently substituting outN).
  const targetedFunctionWatchIds = new Set(watchNodes.filter(watch => functionSource(watch) &&
    changesByNode.has(functionSource(watch).node.id)).map(watch => watch.id));

  for (const event of simulation.events || []) {
    const node = byId.get(event.nodeId);
    if (!node || node.type !== 'watch' || targetedFunctionWatchIds.has(node.id)) continue;
    const edge = incoming.get(`${node.id}:in`);
    if (!edge) continue;
    const source = byId.get(edge.source);
    const sample = sampleFor({
      id: event.id, node, sourceNode: source, port: edge.sourcePort,
      value: event.value, previousValue: event.previousValue,
      variable: source?.title || edge.source,
      dependencies: event.dependencyEvents || [],
    });
    // DONE must be visible AFTER completion. Non-function streams are still
    // sampled once at their first downstream consumer.
    addAction(consumedAt(node.id), { kind: 'final-sample', sample });
  }
  for (const completion of simulation.functionCompletions || []) {
    addAction(consumedAt(completion.nodeId), {
      kind: 'completion', nodeId: completion.nodeId,
      title: completion.title, type: 'function-completion',
      detail: 'DONE → TRUE · safe function body finished',
    });
  }

  const timeline = [], captured = [];
  for (let i = 0; i <= trace.length; i++) {
    const actions = buckets.get(i) || [];
    // Per group: assignment(s) in original order with immediate Watch samples,
    // then completion, finally terminal-value/DONE Watch observations.
    for (const action of [...actions.filter(a => a.kind === 'assignment' || a.kind === 'sample'),
      ...actions.filter(a => a.kind === 'completion'),
      ...actions.filter(a => a.kind === 'final-sample')]) {
      if (action.kind === 'sample' || action.kind === 'final-sample') {
        const sample = { ...action.sample, step: timeline.length + 1, ordinal: captured.length + 1 };
        timeline.push({ id: `capture_${sample.id}`, nodeId: sample.nodeId,
          title: sample.watchName, type: 'watch-sample',
          detail: `${sample.variable} = ${String(sample.value)}`, edgeId: null,
          watchSampleId: sample.id });
        captured.push(sample);
      } else {
        timeline.push({ id: action.revision?.id || `complete_${action.nodeId}_${timeline.length}`,
          nodeId: action.nodeId, title: action.title, type: action.type,
          detail: action.detail, edgeId: null });
      }
    }
    if (i < trace.length) timeline.push(trace[i]);
  }
  return { ...simulation, trace: timeline, waterfallSamples: captured };
}

/** Rewinding playback does not erase captured samples until a new run. */
export function visibleWaterfallSamples(samples, highestStep) {
  return (samples || []).filter(sample => sample.step <= highestStep);
}
