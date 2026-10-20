import { getNodePorts, getFunctionDataInputs, DATA_OPERATORS, LOGIC_GATES, isFunctionNode, isControlEdge } from '../data/node-types';
import { triGate } from './custom-expression';
import { simulateImportedProgram, checkWatchRule } from './forensics';
import { parseFunctionBody, evaluateFunctionBodyWithTrace, coercesToType } from './function-language';

/** Graph values are data, never just booleans. Only typed ports can connect.
 * Function bodies are interpreted by a bounded AST evaluator, NEVER by eval.
 */
export function simulateControlFlow(graph) {
  if (graph.program?.kind === 'javascript-function') return simulateImportedProgram(graph);
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const incoming = new Map(), outgoing = new Map();
  for (const e of graph.edges) {
    incoming.set(`${e.target}:${e.targetPort}`, e);
    const key = `${e.source}:${e.sourcePort}`;
    if (!outgoing.has(key)) outgoing.set(key, []);
    outgoing.get(key).push(e);
  }
  // Next -> EXEC and DONE -> Next are control edges. A DONE -> Watch,
  // however, is an ordinary Boolean/data dependency.
  const controlOutgoing = new Map();
  const flowTriggered = new Set();
  for (const edge of graph.edges.filter(e => isControlEdge(graph, e))) {
    const key = `${edge.source}:${edge.sourcePort}`;
    if (!controlOutgoing.has(key)) controlOutgoing.set(key, []);
    controlOutgoing.get(key).push(edge);
    if (edge.targetPort === 'execute') flowTriggered.add(edge.target);
  }
  const activeFlowFunctions = new Set();
  let controlWalkComplete = false;
  const values = {}, portValues = {}, conditions = {}, issues = [], events = [], assertions = [];
  const provenance = {}; let eventSeq = 0;
  const resolving = new Set(), functionCache = new Map(), functionCompletions = [], functionChanges = [];
  const expressionInputs = expr => !expr ? [] : expr.type === 'identifier' ? [expr.name]
    : expr.type === 'binary' ? [...expressionInputs(expr.left), ...expressionInputs(expr.right)]
    : expr.type === 'not' || expr.type === 'neg' ? expressionInputs(expr.value) : [];
  // Computation is pure and bounded. DONE represents an interpreted function's
  // successful completion, not native execution of the user's source code.
  function calculateOperator(type, a, b) {
    if (type === 'concat') return typeof a === 'string' && typeof b === 'string' ? a + b : null;
    if (typeof a !== 'number' || !Number.isFinite(a) || (type !== 'negate' && (typeof b !== 'number' || !Number.isFinite(b)))) return null;
    if (['divide', 'modulo'].includes(type) && b === 0) return null;
    const result = type === 'add' ? a + b : type === 'subtract' ? a - b : type === 'multiply' ? a * b : type === 'divide' ? a / b : type === 'modulo' ? a % b : type === 'power' ? a ** b : type === 'negate' ? -a : null;
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  }
  function input(node, portId) {
    const edge = incoming.get(`${node.id}:${portId}`);
    if (!edge) return null;
    // A Next port is not an always-true Boolean: it emits an execution token
    // only when the control-flow walker actually reaches this Function.
    const sourceNode = nodes.get(edge.source);
    const sourcePort = sourceNode && getNodePorts(sourceNode).outputs.find(p => p.id === edge.sourcePort);
    const raw = portId === 'execute' && sourcePort?.kind === 'flow'
      ? activeFlowFunctions.has(node.id) : resolve(edge.source, edge.sourcePort);
    const port = getNodePorts(node).inputs.find(p => p.id === portId);
    const type = port?.kind === 'boolean' ? 'boolean' : (port?.dataType || 'any');
    if (!coercesToType(raw, type)) {
      issues.push(`“${node.title}” expects ${type} on ${portId}, got ${typeof raw}.`);
      return null;
    }
    return raw;
  }
  function resolve(id, portId = 'out') {
    const key = `${id}:${portId}`;
    if (Object.prototype.hasOwnProperty.call(portValues, key)) return portValues[key];
    if (resolving.has(key)) { issues.push('Circular data dependency detected.'); return null; }
    const node = nodes.get(id);
    if (!node) return null;
    // Don't speculate that an EXEC connected to Next is TRUE just because its
    // predecessor exists. Also don't memoize FALSE before control visits it.
    if (isFunctionNode(node) && (node.triggerMode || 'auto') === 'signal' &&
        flowTriggered.has(id) && !activeFlowFunctions.has(id)) {
      const idle = portId === 'done' ? false : null;
      if (controlWalkComplete) {
        portValues[key] = idle;
        if (portId === 'out1') values[id] = idle;
      }
      return idle;
    }
    resolving.add(key);
    let result = null;
    if (node.type === 'boolean') result = node.value === true;
    else if (node.type === 'variable') result = node.dataValue;
    else if (node.type === 'not') { const v = input(node, 'a'); result = typeof v === 'boolean' ? !v : null; }
    else if (LOGIC_GATES.includes(node.type)) result = triGate(node.type, getNodePorts(node).inputs.map(p => input(node, p.id)));
    else if (['output', 'watch', 'assert'].includes(node.type)) result = input(node, 'in');
    else if (DATA_OPERATORS.includes(node.type)) {
      const a = input(node, 'a');
      const b = node.type === 'negate' ? null : input(node, 'b');
      result = calculateOperator(node.type, a, b);
      if (result === null) issues.push(`“${node.title}”: missing, invalid or non-finite operands for ${node.type}.`);
    }
    else if (node.type === 'compare') {
      const a = input(node, 'a'), b = input(node, 'b');
      const op = node.comparison || '==';
      if (a !== null && b !== null && (op === '==' || op === '!=')) result = op === '==' ? a === b : a !== b;
      else if (a !== null && b !== null && typeof a === typeof b && (typeof a === 'number' || typeof a === 'string')) result = op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
    }
    else if (isFunctionNode(node)) {
      if (!functionCache.has(node.id)) {
        const outputs = { done: false };
        const portSpec = getNodePorts(node);
        const dataInputs = getFunctionDataInputs(node);
        const dataOutputs = portSpec.outputs.filter(port => port.id !== 'done');
        for (const output of dataOutputs) outputs[output.id] = null;
        const auto = (node.triggerMode || 'auto') === 'auto';
        // Any unconnected/missing/false EXEC never calls the body.
        const enabled = auto || input(node, 'execute') === true;
        if (enabled) {
          try {
            const parsed = parseFunctionBody(node.code, dataInputs.length, dataOutputs.length);
            const argumentsByName = Object.fromEntries(dataInputs.map(p => [p.id, input(node, p.id)]));
            const evaluated = evaluateFunctionBodyWithTrace(parsed, argumentsByName);
            // The original input producers seed our variable lineage. Each
            // assignment then points to precisely the prior revisions it read.
            const lastWriter = new Map(dataInputs.map(p => {
              const edge = incoming.get(`${node.id}:${p.id}`);
              return [p.id, edge ? provenance[`${edge.source}:${edge.sourcePort}`] : null];
            }));
            // One revision for EVERY assignment, even if an output is reassigned
            // several times or the assignment affects an internal local only.
            for (let index = 0; index < evaluated.changes.length; index++) {
              const revision = evaluated.changes[index];
              const statement = parsed.statements[index];
              const dependencies = [...new Set(expressionInputs(statement.expression).map(k => lastWriter.get(k)).filter(Boolean))];
              const id = `fn_event_${node.id}_${revision.line}_${functionChanges.length + 1}`;
              functionChanges.push({
                ...revision, nodeId: node.id, title: node.title, id,
                dependencyEvents: dependencies,
              });
              events.push({
                id, nodeId: node.id, name: `${node.title}.${revision.variable}`,
                variable: revision.variable, operation: 'assignment',
                value: revision.value, previousValue: revision.previousValue,
                sourceLine: revision.line, step: ++eventSeq,
                dependencyEvents: dependencies,
              });
              lastWriter.set(revision.variable, id);
            }
            for (const output of dataOutputs) {
              if (!coercesToType(evaluated.outputs[output.id], output.dataType || 'any')) {
                issues.push(`“${node.title}” output ${output.id} requires ${output.dataType}, got ${typeof evaluated.outputs[output.id]}.`);
              } else outputs[output.id] = evaluated.outputs[output.id] ?? null;
            }
            outputs.done = true;
            functionCompletions.push({ nodeId: node.id, title: node.title, done: true });
          } catch (err) { issues.push(`“${node.title}”: ${err.message}. Function outputs are UNKNOWN; DONE remains FALSE.`); }
        }
        functionCache.set(node.id, outputs);
      }
      result = functionCache.get(node.id)[portId] ?? null;
    }
    resolving.delete(key);
    portValues[key] = result;
    if (node.type !== 'comment' && node.type !== 'start' && node.type !== 'process' && node.type !== 'end') {
      const parents = graph.edges.filter(e => e.target === id && getNodePorts(node).inputs.some(p => p.id === e.targetPort && p.kind !== 'flow')).map(e => provenance[`${e.source}:${e.sourcePort}`]).filter(Boolean);
      const event = { id: `graph_value_${++eventSeq}`, nodeId: id, name: `${node.title}:${portId}`, value: result, previousValue: null, operation: node.type, step: eventSeq, dependencyEvents: parents };
      events.push(event); provenance[key] = event.id;
      if (['watch', 'assert'].includes(node.type)) {
        const check = checkWatchRule({ check: node.check || 'range', min: node.min ?? 0, max: node.max ?? 100, expected: node.expected || 'true', expectedType: node.expectedType || 'number' }, result);
        if (check.failed) assertions.push({ id: `failure_${node.id}`, eventId: event.id, nodeId: node.id, name: node.title, value: result, expected: node.check === 'range' ? `[${node.min ?? 0}, ${node.max ?? 100}]` : node.expected || node.expectedType, message: check.reason });
      }
    }
    if (portId === 'out' || (isFunctionNode(node) && portId === 'out1') || node.type === 'output') values[id] = result;
    return result;
  }
  const trace = [], passedEdges = [];
  const starts = graph.nodes.filter(n => n.type === 'start');
  if (!starts.length) issues.push('No Start node found. Add one to run control flow.');
  for (const start of starts) {
    let current = start, incomingEdge = null, steps = 0;
    const visited = new Set();
    while (current && steps++ < 500) {
      if (visited.has(current.id)) { issues.push(`Loop stopped at “${current.title}”.`); break; }
      visited.add(current.id);
      if (incomingEdge) passedEdges.push(incomingEdge.id);
      if (isFunctionNode(current)) activeFlowFunctions.add(current.id);
      const item = { id: `${start.id}-${steps}`, nodeId: current.id, title: current.title, type: current.type, edgeId: incomingEdge?.id || null, detail: '' };
      let port = 'out';
      if (current.type === 'conditional') {
        const value = triGate(current.conditionMode || 'and',
          getNodePorts(current).inputs.filter(p => p.kind !== 'flow').map(p => input(current, p.id)));
        conditions[current.id] = value;
        if (value === null) { item.detail = 'Condition unknown — branch cannot be selected'; issues.push(`“${current.title}” needs a resolved Boolean input.`); trace.push(item); break; }
        port = value ? 'true' : 'false';
        item.detail = value ? 'TRUE → Yes branch' : 'FALSE → No branch';
      } else if (current.type === 'end') { item.detail = 'Flow complete'; trace.push(item); break; }
      else if (isFunctionNode(current)) {
        const done = resolve(current.id, 'done');
        item.detail = done === true ? 'EXEC received → Function finished → DONE TRUE' : 'Function did not finish → DONE FALSE';
        trace.push(item);
        if (done !== true) { issues.push(`Flow stopped at “${current.title}”: DONE is FALSE.`); break; }
        port = 'done';
      }
      else if (current.type === 'start') item.detail = 'Flow started';
      else item.detail = 'Step executed';
      if (!isFunctionNode(current)) trace.push(item);
      const next = controlOutgoing.get(`${current.id}:${port}`) || [];
      if (!next.length) { issues.push(`Flow stopped at “${current.title}”: no outgoing connection.`); break; }
      if (next.length > 1) issues.push(`Multiple flow targets at “${current.title}”; only first branch executed.`);
      incomingEdge = next[0]; current = nodes.get(incomingEdge.target);
    }
    if (steps >= 500) issues.push('Simulation stopped at the 500-step safety limit.');
  }
  controlWalkComplete = true;
  // Populate data/Watch values after flow execution. Crucially, evaluating a
  // Watch before the walker would have forced a flow-triggered Function early.
  for (const node of graph.nodes) {
    if (['boolean', 'variable', 'not', 'output', 'watch', 'assert', 'compare', ...LOGIC_GATES, ...DATA_OPERATORS].includes(node.type)) resolve(node.id);
    else if (isFunctionNode(node)) getNodePorts(node).outputs.forEach(p => resolve(node.id, p.id));
    else if (node.type === 'conditional' && !(node.id in conditions)) conditions[node.id] = triGate(node.conditionMode || 'and',
      getNodePorts(node).inputs.filter(p => p.kind !== 'flow').map(p => input(node, p.id)));
  }
  return { values, portValues, functionCompletions, functionChanges, conditions, trace, passedEdges, issues: [...new Set(issues)], events, assertions, profiles: Object.fromEntries(trace.map(item => [item.nodeId, 1])), snapshots: [] };
}

export function wouldCreateCycle(edges, source, target) {
  const stack = [target], visited = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === source) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    edges.filter(e => e.source === id).forEach(e => stack.push(e.target));
  }
  return false;
}
