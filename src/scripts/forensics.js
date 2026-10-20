import { evaluateSafeExpression, parseSafeExpression, dependenciesOf } from './javascript-import';

/** Bounded IR-only debugger. No source code evaluation, functions, disk, APIs, or eval. */
export function checkWatchRule(rule, value) {
  if (value === null || value === undefined) return { failed: true, reason: 'Value is UNKNOWN' };
  if (rule.check === 'range') {
    if (typeof value !== 'number') return { failed: true, reason: 'Value is not numeric' };
    if (value < Number(rule.min) || value > Number(rule.max)) return { failed: true, reason: `Outside [${rule.min}, ${rule.max}]` };
  } else if (rule.check === 'equals') {
    const expected = rule.expected === 'true' ? true : rule.expected === 'false' ? false : rule.expected === 'null' ? null : Number.isFinite(Number(rule.expected)) && String(rule.expected).trim() !== '' ? Number(rule.expected) : rule.expected;
    if (value !== expected) return { failed: true, reason: `Expected ${JSON.stringify(expected)}` };
  } else if (rule.check === 'type' && typeof value !== rule.expectedType) return { failed: true, reason: `Expected ${rule.expectedType}` };
  return { failed: false };
}
export function traceValueOrigins(events, originId) {
  const lookup = new Map(events.map(e => [e.id, e]));
  const visited = new Set(), ordered = [];
  const walk = id => {
    if (visited.has(id)) return;
    visited.add(id);
    const e = lookup.get(id);
    if (!e) return;
    for (const parent of e.dependencyEvents || []) walk(parent);
    ordered.push(e);
  };
  walk(originId);
  return ordered;
}
export function simulateImportedProgram(graph) {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const incoming = new Map();
  for (const edge of graph.edges) {
    const key = `${edge.source}:${edge.sourcePort}`;
    if (!incoming.has(key)) incoming.set(key, []);
    incoming.get(key).push(edge);
  }
  const issues = [], trace = [], passedEdges = [], events = [], assertions = [], watchSamples = [], profiles = {};
  const values = {}, portValues = {}, conditions = {}, versions = {}, conditionVersions = {}, environment = Object.create(null);
  const MAX_STEPS = 500;
  let counter = 0;
  function record(name, value, node, deps = [], operation = '', step = 0) {
    const previous = Object.prototype.hasOwnProperty.call(environment, name) ? environment[name] : null;
    const e = { id: `value_${++counter}`, step, name, value, previousValue: previous, nodeId: node?.id || null, sourceLine: node?.sourceLine || null, operation, dependencyEvents: [...deps.map(d => versions[d]).filter(Boolean), ...(node?.controlNodes || []).map(id => conditionVersions[id]).filter(Boolean)] };
    events.push(e);
    environment[name] = value;
    versions[name] = e.id;
    for (const rule of graph.program.watchRules || []) {
      if (rule.variable !== name) continue;
      const status = checkWatchRule(rule, value);
      watchSamples.push({ id: `${e.id}_${rule.id}`, watchName: `Watch: ${name}`, watchId: rule.id, variable: name, nodeId: node?.id || null, sourceLine: node?.sourceLine || null, executionStep: step, value, previousValue: previous, dataType: value == null ? 'unknown' : typeof value, state: status.failed ? (value == null ? 'unknown' : 'failed') : 'passed', reason: status.reason || 'Expected value', dependencyEvents: e.dependencyEvents });
      if (status.failed) assertions.push({ id: `${e.id}_${rule.id}`, eventId: e.id, name, nodeId: node?.id, step, value, expected: rule.check === 'range' ? `[${rule.min}, ${rule.max}]` : rule.check === 'type' ? rule.expectedType : rule.expected, message: status.reason });
    }
    return e;
  }
  const input = graph.program.inputValues || {};
  const root = graph.nodes.find(n => n.type === 'source-start');
  for (const param of graph.program.parameters || []) record(param, Object.prototype.hasOwnProperty.call(input, param) ? input[param] : null, root, [], 'Function parameter', 0);
  let current = root, edge = null, steps = 0, stoppedForOpaque = false;
  const snapshots = [];
  while (current && steps < MAX_STEPS) {
    steps++;
    profiles[current.id] = (profiles[current.id] || 0) + 1;
    const item = { id: `source-run-${steps}`, nodeId: current.id, title: current.title, type: current.type, edgeId: edge?.id || null, detail: '', step: steps };
    if (edge) passedEdges.push(edge.id);
    let outPort = 'out';
    if (current.type === 'source-operation') {
      let ast = current.expressionIR;
      try { ast = parseSafeExpression(current.expressionText); } catch (e) { issues.push(`Line ${current.sourceLine}: ${e.message}`); item.detail = 'Invalid edited expression'; stoppedForOpaque = true; }
      if (!stoppedForOpaque) {
        const result = evaluateSafeExpression(ast, environment);
        const evt = record(current.variableName, result, current, dependenciesOf(ast), current.expressionText, steps);
        values[current.id] = result; portValues[`${current.id}:value`] = result;
        item.detail = `${evt.name}: ${JSON.stringify(evt.previousValue)} → ${JSON.stringify(result)}`;
      }
    } else if (current.type === 'source-decision') {
      let ast = current.expressionIR;
      try { ast = parseSafeExpression(current.expressionText); } catch (e) { issues.push(`Line ${current.sourceLine}: ${e.message}`); stoppedForOpaque = true; }
      if (!stoppedForOpaque) {
        const decision = evaluateSafeExpression(ast, environment);
        conditionVersions[current.id] = record(`$condition_line_${current.sourceLine}`, decision, current, dependenciesOf(ast), current.expressionText, steps).id;
        if (decision === null) { issues.push(`Unknown condition at line ${current.sourceLine}; cannot select a branch.`); stoppedForOpaque = true; }
        else { conditions[current.id] = Boolean(decision); outPort = decision ? 'true' : 'false'; item.detail = `Condition ${Boolean(decision) ? 'TRUE' : 'FALSE'} → ${outPort}`; }
      }
    } else if (current.type === 'source-opaque') {
      item.detail = `UNSIMULATED: ${current.unsupportedReason || 'Unknown operation'}. Original code retained.`;
      issues.push(`Stopped before unsupported operation at line ${current.sourceLine || '?'}. No side effects executed.`);
      stoppedForOpaque = true;
    } else if (current.type === 'source-return') {
      if (current.statementKind === 'return') {
        let ast = current.expressionIR;
        try { ast = parseSafeExpression(current.expressionText); } catch (e) { issues.push(`Line ${current.sourceLine}: ${e.message}`); stoppedForOpaque = true; }
        if (!stoppedForOpaque) {
          const result = evaluateSafeExpression(ast, environment);
          record('$return', result, current, dependenciesOf(ast), current.expressionText, steps);
          values[current.id] = result;
          item.detail = `Returned ${JSON.stringify(result)}`;
        }
      } else item.detail = 'Implicit return (undefined)';
      stoppedForOpaque = true;
    } else item.detail = `Started ${graph.program.functionName}`;
    trace.push(item);
    snapshots.push({ ...environment });
    if (stoppedForOpaque) break;
    const next = (incoming.get(`${current.id}:${outPort}`) || [])[0];
    if (!next) { issues.push(`Flow ended at “${current.title}” without a connected successor.`); break; }
    edge = next; current = nodeMap.get(next.target);
  }
  if (steps >= MAX_STEPS) issues.push('Safety limit: maximum 500 simulated steps.');
  return { values, portValues, conditions, trace, passedEdges, issues, events, assertions, watchSamples, profiles, snapshots, environment: { ...environment }, forensics: true };
}
