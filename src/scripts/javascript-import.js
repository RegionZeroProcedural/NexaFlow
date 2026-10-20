/** Import one JavaScript function using a real parser, without executing it.
 * Limited supported expressions become portable IR; other statements stay opaque.
 * Original source offsets make minimal, lossless JavaScript round-trip edits possible.
 */
import { parse, parseExpressionAt } from '../vendor/acorn.mjs';

const MAX_SOURCE = 150000;
const MAX_NODES = 240;
const safeName = name => /^[a-zA-Z_$][\w$]*$/.test(name);
function irExpression(ast) {
  if (!ast) throw new Error('Missing expression');
  if (ast.type === 'Literal' && (ast.value === null || ['number', 'boolean', 'string'].includes(typeof ast.value))) return { type: 'literal', value: ast.value };
  if (ast.type === 'Identifier' && !['undefined', 'NaN', 'Infinity'].includes(ast.name)) return { type: 'identifier', name: ast.name };
  if (ast.type === 'UnaryExpression' && ['!', '-', '+'].includes(ast.operator)) return { type: 'unary', op: ast.operator, argument: irExpression(ast.argument) };
  if (ast.type === 'BinaryExpression' && ['+', '-', '*', '/', '%', '**', '===', '!==', '==', '!=', '>', '>=', '<', '<='].includes(ast.operator)) return { type: 'binary', op: ast.operator, left: irExpression(ast.left), right: irExpression(ast.right) };
  if (ast.type === 'LogicalExpression' && ['&&', '||', '??'].includes(ast.operator)) return { type: 'binary', op: ast.operator, left: irExpression(ast.left), right: irExpression(ast.right) };
  if (ast.type === 'ConditionalExpression') return { type: 'conditional', test: irExpression(ast.test), yes: irExpression(ast.consequent), no: irExpression(ast.alternate) };
  throw new Error(`Unsupported ${ast.type}; preserved as source only`);
}
export function parseSafeExpression(source) {
  if (!source || source.length > 2000) throw new Error('Expression must contain 1–2000 characters');
  let expression;
  try { expression = parseExpressionAt(source, 0, { ecmaVersion: 2022 }); }
  catch (e) { throw new Error(`Expression syntax: ${e.message}`); }
  if (source.slice(expression.end).trim()) throw new Error('Expression has extra statements');
  return irExpression(expression);
}
export function dependenciesOf(expression) {
  const names = new Set();
  const walk = a => { if (!a) return; if (a.type === 'identifier') names.add(a.name); else if (a.type === 'unary') walk(a.argument); else if (a.type === 'binary') { walk(a.left); walk(a.right); } else if (a.type === 'conditional') { walk(a.test); walk(a.yes); walk(a.no); } };
  walk(expression);
  return [...names];
}
// null means UNKNOWN, and unsupported expression types never execute.
export function evaluateSafeExpression(a, env) {
  if (a.type === 'literal') return a.value;
  if (a.type === 'identifier') return Object.prototype.hasOwnProperty.call(env, a.name) ? env[a.name] : null;
  if (a.type === 'unary') {
    const v = evaluateSafeExpression(a.argument, env);
    if (v === null) return null;
    if (a.op === '!') return !v;
    if (typeof v !== 'number') return null;
    return a.op === '-' ? -v : v;
  }
  if (a.type === 'conditional') { const test = evaluateSafeExpression(a.test, env); return test === null ? null : evaluateSafeExpression(test ? a.yes : a.no, env); }
  if (a.type !== 'binary') return null;
  const left = evaluateSafeExpression(a.left, env);
  if (a.op === '&&') return left === null ? null : left ? evaluateSafeExpression(a.right, env) : left;
  if (a.op === '||') return left === null ? null : left ? left : evaluateSafeExpression(a.right, env);
  if (a.op === '??') return left === null ? evaluateSafeExpression(a.right, env) : left;
  const right = evaluateSafeExpression(a.right, env);
  if (left === null || right === null) return null;
  let result;
  switch (a.op) {
    case '+': if (typeof left !== typeof right || !['number', 'string'].includes(typeof left)) return null; result = left + right; break;
    case '-': case '*': case '/': case '%': case '**':
      if (typeof left !== 'number' || typeof right !== 'number') return null;
      result = a.op === '-' ? left - right : a.op === '*' ? left * right : a.op === '/' ? left / right : a.op === '%' ? left % right : left ** right;
      break;
    case '===': case '==': result = left === right; break;
    case '!==': case '!=': result = left !== right; break;
    case '>': case '<': case '>=': case '<=':
      if (typeof left !== typeof right || !['number', 'string'].includes(typeof left)) return null;
      result = a.op === '>' ? left > right : a.op === '<' ? left < right : a.op === '>=' ? left >= right : left <= right;
      break;
    default: return null;
  }
  return typeof result === 'number' && !Number.isFinite(result) ? null : result;
}
const coord = index => ({ x: 96 + (Math.floor(index / 9) * 420), y: 75 + (index % 9) * 274 });
export function importJavaScriptFunction(source, filename = 'Imported JavaScript') {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE) throw new Error('JavaScript source must be 1–150 KB');
  const ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true, allowReturnOutsideFunction: false });
  const list = ast.body.map(item => item.type === 'ExportNamedDeclaration' || item.type === 'ExportDefaultDeclaration' ? item.declaration : item);
  const fn = list.find(item => item && ((item.type === 'FunctionDeclaration') || (item.type === 'VariableDeclaration' && item.declarations.length === 1 && ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.declarations[0].init?.type))));
  if (!fn) throw new Error('No function found. Import a JavaScript function declaration or const arrow function.');
  const expression = fn.type === 'FunctionDeclaration' ? fn : fn.declarations[0].init;
  if (expression.body?.type !== 'BlockStatement') throw new Error('Function must have a { ... } statement body.');
  const parameters = expression.params.map(p => { if (p.type !== 'Identifier' || !safeName(p.name)) throw new Error('Only simple function parameters supported initially (no destructuring/defaults).'); return p.name; });
  if (parameters.length > 16) throw new Error('Maximum 16 parameters for now.');
  const nodes = [], edges = [];
  const emit = (type, title, astNode, props = {}) => {
    if (nodes.length >= MAX_NODES) throw new Error(`Import limited to ${MAX_NODES} nodes.`);
    const id = `src_${nodes.length + 1}`;
    const node = { id, type, title: title.slice(0, 80), description: '', ...coord(nodes.length), ...(astNode ? { sourceStart: astNode.start, sourceEnd: astNode.end, sourceLine: astNode.loc.start.line } : {}), ...props };
    nodes.push(node); return node;
  };
  const link = (endpoints, target) => endpoints.forEach(({ node, port }) => {
    const n = edges.filter(e => e.target === target.id).length;
    if (n >= 16) throw new Error('Function has more than 16 incoming branches at one merge; reduce branch fan-in before import.');
    target.flowInCount = Math.max(1, n + 1);
    edges.push({ id: `src_edge_${edges.length + 1}`, source: node.id, sourcePort: port, target: target.id, targetPort: n ? `in${n + 1}` : 'in' });
  });
  const start = emit('source-start', `${fn.id?.name || fn.declarations?.[0]?.id?.name || 'Function'}(${parameters.join(', ')})`, expression);
  const expressionFields = (field, expr) => {
    const raw = source.slice(expr.start, expr.end);
    try { return { expressionText: raw, expressionIR: irExpression(expr), expressionStart: expr.start, expressionEnd: expr.end, reads: dependenciesOf(irExpression(expr)), statementKind: field }; }
    catch (e) { return { unsupportedReason: e.message, original: raw }; }
  };
  function compileSequence(statements, incoming, controlNodes = []) {
    let ends = incoming;
    for (const statement of statements) {
      if (!ends.length) break; // unreachable statements remain in original source verbatim
      if (statement.type === 'IfStatement') {
        const details = expressionFields('test', statement.test);
        const valid = !details.unsupportedReason;
        const node = emit(valid ? 'source-decision' : 'source-opaque', valid ? 'if ' + source.slice(statement.test.start, statement.test.end).slice(0, 55) : 'Unsupported if condition', statement, {
          ...details, controlNodes, description: valid ? 'Choose a branch from the simulated condition.' : 'Preserved unchanged. Simulation stops before evaluating this condition.',
        });
        link(ends, node);
        if (!valid) { ends = [{ node, port: 'out' }]; continue; } // Opaque node blocks simulation, but the rest of the source remains visible
        const yes = compileSequence(statement.consequent.type === 'BlockStatement' ? statement.consequent.body : [statement.consequent], [{ node, port: 'true' }], [...controlNodes, node.id]);
        const no = statement.alternate ? compileSequence(statement.alternate.type === 'BlockStatement' ? statement.alternate.body : [statement.alternate], [{ node, port: 'false' }], [...controlNodes, node.id]) : [{ node, port: 'false' }];
        ends = [...yes, ...no];
      } else {
        let expr = null, target = null, kind = null;
        if (statement.type === 'VariableDeclaration' && statement.declarations.length === 1 && statement.declarations[0].id.type === 'Identifier' && statement.declarations[0].init) {
          target = statement.declarations[0].id.name; expr = statement.declarations[0].init; kind = 'assign';
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.operator === '=' && statement.expression.left.type === 'Identifier') {
          target = statement.expression.left.name; expr = statement.expression.right; kind = 'assign';
        } else if (statement.type === 'ReturnStatement' && statement.argument) { expr = statement.argument; kind = 'return'; }
        const details = expr ? expressionFields(kind, expr) : { unsupportedReason: `Unsupported ${statement.type}`, original: source.slice(statement.start, statement.end) };
        if (kind === 'assign' && (!safeName(target) || ['__proto__', 'prototype', 'constructor'].includes(target))) details.unsupportedReason = 'Unsafe variable identifier';
        const supported = !details.unsupportedReason;
        const type = !supported ? 'source-opaque' : kind === 'return' ? 'source-return' : 'source-operation';
        const title = !supported ? `Opaque: ${statement.type}` : kind === 'return' ? `return ${details.expressionText}` : `${target} = ${details.expressionText}`;
        const node = emit(type, title, statement, { ...details, controlNodes, variableName: target || null, description: supported ? `Line ${statement.loc.start.line} • editable pure expression` : details.unsupportedReason });
        link(ends, node);
        ends = type === 'source-return' ? [] : [{ node, port: 'out' }];
      }
    }
    return ends;
  }
  const ends = compileSequence(expression.body.body, [{ node: start, port: 'out' }]);
  if (ends.length) { const done = emit('source-return', 'Implicit return', null, { statementKind: 'implicit', description: 'Function falls through without an explicit return.' }); link(ends, done); }
  // Conservative CFG reaching-definitions analysis. At branch joins, retain
  // every possible writer rather than selecting the last lexical statement.
  // The visual data graph is static / may include paths not taken at runtime.
  const incomingEdges = new Map(nodes.map(n => [n.id, []]));
  const children = new Map(nodes.map(n => [n.id, []]));
  for (const edge of edges) { incomingEdges.get(edge.target).push(edge.source); children.get(edge.source).push(edge.target); }
  const pending = new Map(nodes.map(n => [n.id, incomingEdges.get(n.id).length]));
  const queue = nodes.filter(n => !pending.get(n.id)).map(n => n.id);
  const knownOut = new Map(), dataEdges = [], dataEdgeKeys = new Set();
  const addDataEdge = (from, to, variable) => {
    if (from === to) return;
    const key = `${from}/${to}/${variable}`;
    if (dataEdgeKeys.has(key)) return;
    dataEdgeKeys.add(key); dataEdges.push({ source: from, target: to, variable });
  };
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], node = nodes.find(n => n.id === id);
    const reaching = new Map();
    for (const parent of incomingEdges.get(id)) {
      for (const [name, origins] of knownOut.get(parent) || []) {
        if (!reaching.has(name)) reaching.set(name, new Set());
        for (const origin of origins) reaching.get(name).add(origin);
      }
    }
    if (node.type === 'source-start') for (const name of parameters) reaching.set(name, new Set([id]));
    for (const name of node.reads || []) for (const origin of reaching.get(name) || []) addDataEdge(origin, id, name);
    for (const control of node.controlNodes || []) addDataEdge(control, id, 'branch');
    if (node.variableName && node.type === 'source-operation') reaching.set(node.variableName, new Set([id]));
    knownOut.set(id, reaching);
    for (const child of children.get(id)) { pending.set(child, pending.get(child) - 1); if (pending.get(child) === 0) queue.push(child); }
  }
  if (dataEdges.length > 4000) throw new Error('Too many possible data dependencies (4,000 max). Import a smaller function.');
  const functionName = fn.id?.name || fn.declarations?.[0]?.id?.name || 'anonymous';
  return {
    name: `${filename.replace(/\.m?js$/i, '')} • ${functionName}`,
    nodes, edges,
    program: { kind: 'javascript-function', source, functionName, parameters, inputValues: Object.fromEntries(parameters.map(p => [p, 0])), watchRules: [], dataEdges, importedNodeIds: nodes.map(n => n.id), importedEdgeIds: edges.map(e => e.id), originalEdges: edges.map(e => ({ ...e })) },
  };
}

/** Only patch supported expressions. Everything else (comments, calls, imports,
 * formatting, side effects) remains byte-for-byte identical.
 * Structural rewiring is explicitly rejected, not silently dropped.
 */
export function exportImportedJavaScript(graph) {
  if (graph.program?.kind !== 'javascript-function') throw new Error('Not an imported function');
  const { source, importedNodeIds, importedEdgeIds } = graph.program;
  if (graph.nodes.length !== importedNodeIds.length || graph.edges.length !== importedEdgeIds.length || graph.nodes.some(n => !importedNodeIds.includes(n.id)) || graph.edges.some(e => !importedEdgeIds.includes(e.id)) || graph.edges.some(e => !graph.program.originalEdges?.some(x => x.id === e.id && x.source === e.source && x.sourcePort === e.sourcePort && x.target === e.target && x.targetPort === e.targetPort))) throw new Error('Graph structure changed. Source export supports expression edits only; undo structural changes or export project JSON.');
  const edits = [];
  for (const node of graph.nodes) {
    if (!Number.isInteger(node.expressionStart)) continue;
    const original = source.slice(node.expressionStart, node.expressionEnd);
    if (node.expressionText !== original) {
      parseSafeExpression(node.expressionText); // fail closed
      edits.push({ start: node.expressionStart, end: node.expressionEnd, text: node.expressionText });
    }
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}
