import { evaluateSafeExpression, parseSafeExpression, closureAssignedNames } from './javascript-import';
import { createSourceWorkspace, evaluateWorkspaceExpression } from './source-workspace';
import { updateMember } from './restricted-ast';

/** Bounded IR-only debugger. No source code evaluation, functions, disk, APIs, or eval. */
export function checkWatchRule(rule, value, unknown = value === null || value === undefined) {
  if (unknown) return { failed: true, reason: 'Value is UNKNOWN' };
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
  const workspace = createSourceWorkspace(graph.program.workspaceFiles || { [graph.program.sourcePath || 'import.js']: graph.program.source });
  let counter = 0, skippedOperations = 0;
  // Watch nodes wired to a source node's Value port observe what it records.
  const attachedWatches = new Map();
  for (const edge of graph.edges) {
    const target = nodeMap.get(edge.target);
    if (edge.sourcePort !== 'value' || target?.type !== 'watch') continue;
    if (!attachedWatches.has(edge.source)) attachedWatches.set(edge.source, []);
    attachedWatches.get(edge.source).push(target);
  }
  const unknownNames = new Set();
  // A callee cannot reassign the caller's primitive locals; it can only mutate
  // objects reachable through aliases, or reassign names a nested closure
  // writes. If the closure analysis fails, assume every local may change.
  let closureWrites = null;
  try { closureWrites = closureAssignedNames(graph.program.source, graph.program.functionIndex || 0); } catch (_) { closureWrites = null; }
  const mayBeChangedByCall = name => {
    if (name.startsWith('$')) return false;
    const value = environment[name];
    return !closureWrites || closureWrites.has(name) || unknownNames.has(name) || (value !== null && (typeof value === 'object' || typeof value === 'function'));
  };
  const invalidateAfterOpaque = (node, operation, extra = []) => {
    const names = [...new Set([...extra, ...Object.keys(environment).filter(mayBeChangedByCall)])];
    for (const name of names) record(name, null, node, [name], operation, steps, true);
    return names;
  };
  const readsUnknown = node => (node.reads || []).some(name => unknownNames.has(name));
  const readEnvironment = new Proxy(environment, {
    get(target, key, receiver) {
      if (unknownNames.has(key)) throw Error(`UNKNOWN value: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  function record(name, value, node, deps = [], operation = '', step = 0, unknown = false) {
    const previous = Object.prototype.hasOwnProperty.call(environment, name) ? environment[name] : null;
    const e = { id: `value_${++counter}`, step, name, value, previousValue: previous, nodeId: node?.id || null, sourceLine: node?.sourceLine || null, operation, unknown, dependencyEvents: [...deps.map(d => versions[d]).filter(Boolean), ...(node?.controlNodes || []).map(id => conditionVersions[id]).filter(Boolean)] };
    events.push(e);
    environment[name] = value;
    if (unknown) unknownNames.add(name); else unknownNames.delete(name);
    versions[name] = e.id;
    for (const rule of graph.program.watchRules || []) {
      if (rule.variable !== name) continue;
      const status = checkWatchRule(rule, value, unknown);
      watchSamples.push({ id: `${e.id}_${rule.id}`, watchName: `Watch: ${name}`, watchId: rule.id, variable: name, nodeId: node?.id || null, sourceLine: node?.sourceLine || null, executionStep: step, value, previousValue: previous, dataType: unknown ? 'unknown' : value === null ? 'null' : typeof value, state: status.failed ? (unknown ? 'unknown' : 'failed') : 'passed', unknown, reason: status.reason || 'Expected value', dependencyEvents: e.dependencyEvents });
      if (status.failed) assertions.push({ id: `${e.id}_${rule.id}`, eventId: e.id, name, nodeId: node?.id, step, value, unknown, expected: rule.check === 'range' ? `[${rule.min}, ${rule.max}]` : rule.check === 'type' ? rule.expectedType : rule.expected, message: status.reason });
    }
    for (const watch of attachedWatches.get(node?.id) || []) {
      if (watch.traceVariable === 'named' && watch.traceVariableName && watch.traceVariableName !== name) continue;
      const rule = { check: watch.check || 'range', min: watch.min ?? 0, max: watch.max ?? 100, expected: watch.expected ?? 'true', expectedType: watch.expectedType || 'number' };
      const status = checkWatchRule(rule, value, unknown);
      watchSamples.push({ id: `${e.id}_${watch.id}`, watchName: watch.title, watchId: watch.id, variable: name === '$return' ? 'return' : name, nodeId: watch.id, sourceLine: node?.sourceLine || null, executionStep: step, value, previousValue: previous, dataType: unknown ? 'unknown' : value === null ? 'null' : typeof value, state: status.failed ? (unknown ? 'unknown' : 'failed') : 'passed', unknown, reason: status.reason || 'Validation passed', dependencyEvents: e.dependencyEvents });
    }
    return e;
  }
  const input = graph.program.inputValues || {};
  const root = graph.nodes.find(n => n.type === 'source-start');
  let current = root, edge = null, steps = 0, stoppedForOpaque = false;
  for (const param of graph.program.parameters || []) {
    const supplied = Object.prototype.hasOwnProperty.call(input, param);
    record(param, supplied ? input[param] : null, root, [], supplied ? 'Function parameter' : 'UNKNOWN: no test value supplied', 0, !supplied);
  }
  const snapshots = [], snapshotUnknowns = [];
  const snapshot = () => { snapshots.push({ ...environment }); snapshotUnknowns.push([...unknownNames]); };
  while (current && steps < MAX_STEPS) {
    steps++;
    profiles[current.id] = (profiles[current.id] || 0) + 1;
    const item = { id: `source-run-${steps}`, nodeId: current.id, title: current.title, type: current.type, edgeId: edge?.id || null, detail: '', step: steps };
    if (edge) passedEdges.push(edge.id);
    let outPort = 'out';
    if (current.inspectOnly) {
      // Decomposition is educational, not a second execution of the source.
      // The containing assignment/decision evaluates the whole AST once.
      item.detail = `Inspect ${current.sourceExcerpt || current.title} · read-only subexpression`;
    } else if (current.type === 'source-operation' || current.type === 'source-property-write') {
      // Pure primitive expressions use the existing portable evaluator. More
      // structured expressions use the bounded AST interpreter (no eval,
      // arbitrary method calls or user getters).
      let result, reason = '', verified = false;
      {
        const outcome = evaluateWorkspaceExpression(workspace, graph.program.sourcePath || 'import.js', current.expressionText, readEnvironment);
        result = outcome.value; verified = outcome.verified; reason = outcome.reason || '';
      }
      if (!verified) {
        if (!(skippedOperations > 0 && readsUnknown(current))) skippedOperations++;
        issues.push(`Line ${current.sourceLine}: ${reason || 'Unknown expression'}; value is UNKNOWN.`);
        result = null;
      }
      if (current.type === 'source-property-write') {
        try {
          if (!verified) throw Error('Assignment expression is unknown');
          const updated = updateMember(environment[current.variableName], current.propertyPath.parts, result);
          const evt = record(current.variableName, updated, current, current.reads || [], current.title, steps);
          values[current.id] = result;
          item.detail = `${current.variableName}.${current.propertyPath.parts.join('.')} ← ${JSON.stringify(result)}`;
        } catch (error) {
          if (verified) skippedOperations++;
          issues.push(`Line ${current.sourceLine}: structured write unverified (${error.message}).`);
          record(current.variableName, null, current, current.reads || [], 'UNKNOWN property write', steps, true);
          item.detail = `Unverified structured assignment: ${error.message}`;
        }
      } else {
        const evt = record(current.variableName, result, current, current.reads || [], verified ? current.expressionText : `UNKNOWN: ${current.expressionText}`, steps, !verified);
        values[current.id] = result; portValues[`${current.id}:value`] = result;
        item.detail = `${evt.name}: ${JSON.stringify(evt.previousValue)} → ${JSON.stringify(result)}${verified ? '' : ' (UNKNOWN)'}`;
      }
    } else if (current.type === 'source-declare') {
      record(current.variableName, undefined, current, [], 'Declaration without initializer', steps);
      item.detail = `Declared ${current.variableName} (undefined).`;
    } else if (current.type === 'source-update') {
      try {
        const rhs = current.updateOperator === '++' || current.updateOperator === '--' ? 1 : evaluateSafeExpression(parseSafeExpression(current.expressionText), environment);
        const previous = environment[current.variableName];
        const operator = current.updateOperator === '++' ? '+' : current.updateOperator === '--' ? '-' : current.updateOperator.slice(0, -1);
        const unknown = unknownNames.has(current.variableName) || readsUnknown(current) || previous == null || rhs == null;
        const raw = unknown ? null : evaluateSafeExpression(parseSafeExpression('a ' + operator + ' b'), { a: previous, b: rhs });
        const result = record(current.variableName, raw, current, [current.variableName, ...(current.reads || [])], unknown ? `UNKNOWN: ${current.title}` : current.title, steps, unknown || raw === null);
        values[current.id] = raw;
        item.detail = `${current.variableName}: ${JSON.stringify(result.previousValue)} → ${JSON.stringify(result.value)}`;
      } catch (e) { issues.push(`Line ${current.sourceLine}: update unknown (${e.message})`); record(current.variableName, null, current, [current.variableName], 'UNKNOWN: unsupported update', steps, true); }
    } else if (current.type === 'source-call') {
      // A dependency stays one compact node on the main canvas. We only
      // interpret a verified pure subset of its body, never invoke real JS.
      let reason = '', result = null, verified = false;
      if (current.callAuxiliary) {
        // A call inside a compound/short-circuit expression is a possible
        // dependency, not necessarily executed. Its final expression node
        // decides which branch actually evaluates the call.
        item.detail = `Dependency reference: ${current.calleeName}() in ${current.dependencyPath || 'unresolved module'}. Evaluated only when reached by the containing expression.`;
        trace.push(item);
        snapshot();
        const next = (incoming.get(`${current.id}:out`) || [])[0];
        if (!next) break;
        edge = next; current = nodeMap.get(next.target);
        continue;
      }
      try {
        const outcome = evaluateWorkspaceExpression(workspace, graph.program.sourcePath || 'import.js', current.callExpressionText || current.callSource, readEnvironment);
        result = outcome.value; verified = outcome.verified;
        reason = outcome.reason || '';
      } catch (e) { reason = e.message; }
      if (verified) {
        if (current.variableName) record(current.variableName, result, current, current.reads || [], `Pure ${current.calleeName}()`, steps);
        if (current.callReturns) record('$return', result, current, current.reads || [], `Return ${current.calleeName}()`, steps);
        item.detail = `ISOLATED IR · ${current.calleeName}() → ${JSON.stringify(result)} (${current.dependencyPath})`;
      } else {
        skippedOperations++;
        // An unverified call may mutate objects reachable through aliases or
        // reassign closure-captured locals; primitives it cannot touch survive.
        const invalidated = invalidateAfterOpaque(current, `UNKNOWN: ${current.calleeName}() may have changed this`);
        if (current.variableName) record(current.variableName, null, current, current.reads || [], `UNKNOWN: ${current.calleeName}()`, steps, true);
        if (current.callReturns) record('$return', null, current, current.reads || [], 'UNKNOWN call return', steps, true);
        item.detail = `NOT EXECUTED · ${current.calleeName}(): ${reason}. ${invalidated.length ? `Possibly changed: ${invalidated.join(', ')}.` : 'No local values could have changed.'}`;
        issues.push(`Line ${current.sourceLine}: ${current.calleeName}() was not safely interpreted (${reason}). Execution continued approximately.`);
      }
      values[current.id] = result;
      portValues[`${current.id}:value`] = verified ? result : null;
      if (current.callReturns) stoppedForOpaque = true;
    } else if (current.type === 'source-decision') {
      const isStructured = current.sourceCallCondition || current.richExpression;
      const outcome = evaluateWorkspaceExpression(workspace, graph.program.sourcePath || 'import.js', current.expressionText, readEnvironment);
      const decision = outcome.value;
      const verified = outcome.verified && decision != null;
      const reason = outcome.reason || (!verified ? 'Condition is UNKNOWN' : '');
      conditionVersions[current.id] = record(`$condition_line_${current.sourceLine}`, verified ? decision : null, current, current.reads || [], current.expressionText, steps, !verified).id;
      if (!verified) {
        if (isStructured) {
          // A complex condition may have side effects. Do not invent either
          // outcome: skip both bodies and flow through the unknown merge.
          skippedOperations++;
          invalidateAfterOpaque(current, 'UNKNOWN: branch not simulated', current.opaqueWrites || []);
          outPort = 'unknown';
          item.detail = `UNKNOWN condition → bypass branches (${reason}); following values unverified.`;
          issues.push(`Line ${current.sourceLine}: could not determine branch (${reason}); result is approximate.`);
        } else {
          issues.push(`Unknown condition at line ${current.sourceLine}; cannot choose a branch (${reason}).`);
          stoppedForOpaque = true;
        }
      } else {
        conditions[current.id] = Boolean(decision);
        outPort = decision ? 'true' : 'false';
        item.detail = `Condition ${Boolean(decision) ? 'TRUE' : 'FALSE'} → ${outPort}`;
      }
    } else if (['source-opaque', 'source-loop', 'source-switch', 'source-try', 'source-throw', 'source-await'].includes(current.type)) {
      // An unsupported statement is *never* run. We advance only the known
      // sequential CFG and invalidate values which unknown side effects may
      // have changed. This is an approximate continuation, not proof that the
      // original program would reach the following statement.
      skippedOperations++;
      const raw = graph.program.source.slice(current.sourceStart || 0, current.sourceEnd || 0);
      const possibleCallOrEffect = /\b(?:await|yield|new|delete|throw)\b|\b[A-Za-z_$][\w$]*\s*\(|\.\s*[A-Za-z_$]|\[/.test(raw);
      const aliases = possibleCallOrEffect
        ? invalidateAfterOpaque(current, 'UNKNOWN: skipped unsupported source', current.opaqueWrites || [])
        : (current.opaqueWrites || []).map(name => { record(name, null, current, [name], 'UNKNOWN: skipped unsupported source', steps, true); return name; });
      item.detail = `SKIPPED / UNVERIFIED: ${current.unsupportedReason || 'Unknown operation'}. ${aliases.length ? `Marked ${aliases.join(', ')} UNKNOWN.` : 'Following path is only an approximation.'} Source retained.`;
      issues.push(`Line ${current.sourceLine || '?'}: unsupported source skipped; results after this point are unverified. No imported code was executed.`);
      if (current.opaqueTerminal) {
        if (current.opaqueReturn || raw.trim().startsWith('return')) record('$return', null, current, [], 'UNKNOWN return expression', steps, true);
        stoppedForOpaque = true;
        item.detail += ' This statement terminates the path.';
      }
    } else if (current.type === 'source-return') {
      if (current.statementKind === 'return') {
        let result, verified = false, reason = '';
        {
          const outcome = evaluateWorkspaceExpression(workspace, graph.program.sourcePath || 'import.js', current.expressionText, readEnvironment);
          result = outcome.value; verified = outcome.verified; reason = outcome.reason || '';
        }
        if (!verified) {
          if (!(skippedOperations > 0 && readsUnknown(current))) skippedOperations++;
          issues.push(`Line ${current.sourceLine}: cannot resolve return expression (${reason}).`);
        }
        record('$return', verified ? result : null, current, current.reads || [], verified ? current.expressionText : `UNKNOWN: ${current.expressionText}`, steps, !verified);
        values[current.id] = verified ? result : null;
        item.detail = verified ? `Returned ${JSON.stringify(result)}` : 'Return UNKNOWN · unsupported or invalid expression';
      } else { record('$return', undefined, current, [], 'Implicit return', steps); item.detail = 'Implicit return (undefined)'; }
      stoppedForOpaque = true;
    } else item.detail = `Started ${graph.program.functionName}`;
    trace.push(item);
    snapshot();
    if (stoppedForOpaque) break;
    const next = (incoming.get(`${current.id}:${outPort}`) || [])[0];
    if (!next) { issues.push(`Flow ended at “${current.title}” without a connected successor.`); break; }
    edge = next; current = nodeMap.get(next.target);
  }
  if (steps >= MAX_STEPS) issues.push('Safety limit: maximum 500 simulated steps.');
  return { values, portValues, conditions, trace, passedEdges, issues, events, assertions, watchSamples, profiles, snapshots, snapshotUnknowns, unknownNames: [...unknownNames], environment: { ...environment }, forensics: true, skippedOperations, approximate: skippedOperations > 0 };
}
