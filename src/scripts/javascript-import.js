/** Import one JavaScript function using a real parser, without executing it.
 * Limited supported expressions become portable IR; other statements stay opaque.
 * Original source offsets make minimal, lossless JavaScript round-trip edits possible.
 */
import { parse, parseExpressionAt } from '../vendor/acorn.mjs';
import { createSourceWorkspace, resolveFunction } from './source-workspace';
import { canAnalyzeExpression, getMemberPath } from './restricted-ast';
import { layoutSourceFlow } from './flow-layout';

const MAX_SOURCE = 150000;
const MAX_NODES = 240;
function directCalls(ast, found = []) {
  if (!ast || typeof ast !== 'object') return found;
  if (ast.type === 'CallExpression' && ast.callee?.type === 'Identifier' && !ast.optional && ast.arguments.every(a => a.type !== 'SpreadElement')) found.push(ast);
  if (['FunctionExpression', 'ArrowFunctionExpression'].includes(ast.type)) return found;
  for (const [key, value] of Object.entries(ast)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item?.type) directCalls(item, found);
    } else if (value?.type) directCalls(value, found);
  }
  return found;
}
function readsInExpression(ast, found = new Set()) {
  if (!ast || typeof ast !== 'object') return [...found];
  if (ast.type === 'Identifier') { found.add(ast.name); return [...found]; }
  if (ast.type === 'CallExpression') {
    for (const arg of ast.arguments || []) readsInExpression(arg, found);
    if (ast.callee?.type === 'MemberExpression') readsInExpression(ast.callee.object, found);
    return [...found];
  }
  for (const [key, value] of Object.entries(ast)) {
    if (['loc','start','end'].includes(key) || (ast.type === 'MemberExpression' && key === 'property' && !ast.computed)) continue;
    if (Array.isArray(value)) { for (const item of value) if (item?.type) readsInExpression(item, found); }
    else if (value?.type) readsInExpression(value, found);
  }
  return [...found];
}
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
/** Check an editable source expression against the bounded AST interpreter.
 * This accepts objects, property reads, optional chains and pure callbacks,
 * while keeping the original source's surrounding text unchanged.
 */
export function validateSourceExpression(source, allowedCallees = null) {
  if (typeof source !== 'string' || source.length < 1 || source.length > 2000) throw Error('Source expression must be 1–2,000 characters');
  let expression;
  try { expression = parseExpressionAt(source, 0, { ecmaVersion: 2022 }); }
  catch (error) { throw Error(`JavaScript expression syntax: ${error.message}`); }
  if (source.slice(expression.end).trim()) throw Error('Only one expression can replace the original expression');
  if (!canAnalyzeExpression(expression)) throw Error(`Unsupported or unsafe ${expression.type} expression`);
  if (allowedCallees) {
    // An edit may call helpers that already exist in the module, but must not
    // introduce new globals such as fetch() or require() into exported source.
    const check = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && !allowedCallees.has(node.callee.name)) throw Error(`${node.callee.name}() is not a function defined or imported by this module`);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(check);
        else if (value?.type) check(value);
      }
    };
    check(expression);
  }
  return expression;
}
/** Functions an edited expression may call: top-level functions and imports. */
export function moduleCallableNames(source) {
  const ast = parseModule(source);
  const names = new Set(functionCandidates(ast).map(fn => fn.name));
  for (const item of ast.body) if (item.type === 'ImportDeclaration') for (const spec of item.specifiers) names.add(spec.local.name);
  return names;
}
/** Locals that a nested closure may reassign. An unresolved call could invoke
 * such a closure, so these cannot be assumed unchanged across opaque calls. */
export function closureAssignedNames(source, functionIndex = 0) {
  const fn = functionCandidates(parseModule(source))[functionIndex]?.expression;
  const names = new Set();
  const visit = (ast, nested) => {
    if (!ast || typeof ast !== 'object') return;
    const isFunction = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(ast.type);
    if (isFunction && nested) { findAssignedNames(ast.body, names); return; }
    for (const [key, value] of Object.entries(ast)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(child => child?.type && visit(child, true));
      else if (value?.type) visit(value, true);
    }
  };
  if (fn?.body) visit(fn.body, true);
  return names;
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

/** Conservatively identify locals whose values could have changed in a skipped construct. */
function findAssignedNames(ast, result = new Set(), budget = { remaining: 1800 }) {
  if (!ast || typeof ast !== 'object' || --budget.remaining < 0) return result;
  if (ast.type === 'VariableDeclarator' && ast.id?.type === 'Identifier') result.add(ast.id.name);
  if (ast.type === 'AssignmentExpression' && ast.left?.type === 'Identifier') result.add(ast.left.name);
  if (ast.type === 'UpdateExpression' && ast.argument?.type === 'Identifier') result.add(ast.argument.name);
  for (const [key, value] of Object.entries(ast)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) { for (const child of value) if (child && child.type) findAssignedNames(child, result, budget); }
    else if (value && typeof value === 'object' && value.type) findAssignedNames(value, result, budget);
  }
  return result;
}
/** Expand expressions into visible primitive operand/operator cards. They are
 * inspection-only, derived from the original AST; CFG execution still uses the
 * owner statement's restricted IR, so these cards can never execute source. */
function expandExpressions(source, nodes, dataEdges) {
  const statements = nodes.filter(n => (Number.isInteger(n.expressionStart) || n.type === 'source-call') && !n.unsupportedReason);
  let serial = 0;
  const limit = Math.min(200, MAX_NODES - nodes.length);
  const displayOps = { '+': 'ADD (+)', '-': 'SUBTRACT (−)', '*': 'MULTIPLY (×)', '/': 'DIVIDE (÷)', '%': 'MODULO (%)', '**': 'POWER (**)', '&&': 'AND', '||': 'OR', '??': 'NULLISH', '===': 'EQUALS (===)', '!==': 'NOT EQUAL (≠)', '>': 'GREATER THAN', '>=': 'AT LEAST', '<': 'LESS THAN', '<=': 'AT MOST' };
  function decompose(ast, owner, depth, lane) {
    if (serial >= limit || depth > 8) return null;
    const expressionKind = ast.type === 'ConditionalExpression' ? 'source-ternary' : ast.type === 'MemberExpression' ? 'source-member' : ast.type === 'CallExpression' ? 'source-call-expr' : ['ObjectExpression', 'ArrayExpression'].includes(ast.type) ? 'source-value' : ['BinaryExpression', 'LogicalExpression', 'UnaryExpression'].includes(ast.type) ? 'source-operator' : ['Identifier', 'Literal', 'TemplateLiteral'].includes(ast.type) ? 'source-value' : null;
    if (!expressionKind) return null;
    const children = ast.type === 'ChainExpression' ? [ast.expression] : ast.type === 'ObjectExpression' ? ast.properties.map(p => p.value) : ast.type === 'ArrayExpression' ? ast.elements : ast.type === 'ConditionalExpression' ? [ast.test, ast.consequent, ast.alternate] : ast.type === 'UnaryExpression' ? [ast.argument] : ast.type === 'MemberExpression' ? [ast.object, ast.computed ? ast.property : null] : ast.type === 'CallExpression' ? [...ast.arguments] : ['Identifier', 'Literal', 'TemplateLiteral'].includes(ast.type) ? [] : [ast.left, ast.right];
    const id = `src_expr_${++serial}`;
    const title = ast.type === 'ObjectExpression' ? 'OBJECT LITERAL' : ast.type === 'ArrayExpression' ? 'ARRAY LITERAL' : ast.type === 'Identifier' ? ast.name : ast.type === 'Literal' ? JSON.stringify(ast.value) : ast.type === 'ConditionalExpression' ? 'TERNARY (?:)' : ast.type === 'MemberExpression' ? 'PROPERTY LOOKUP' : ast.type === 'CallExpression' ? 'FUNCTION CALL' : ast.type === 'TemplateLiteral' ? 'TEMPLATE LITERAL' : ast.type === 'UnaryExpression' ? `UNARY (${ast.operator})` : displayOps[ast.operator] || `OPERATOR ${ast.operator}`;
    const node = { id, type: expressionKind, title: title.slice(0, 80), description: 'Read-only expression component. Edit its parent source statement.', x: owner.x + 340 + depth * 270, y: owner.y + (lane * 225), sourceStart: ast.start, sourceEnd: ast.end, sourceLine: ast.loc?.start.line || owner.sourceLine, parentNodeId: owner.id, expressionText: source.slice(ast.start, ast.end).slice(0, 2000), operator: ast.operator || null };
    nodes.push(node);
    const successors = children.filter(Boolean).map((child, i) => decompose(child, owner, depth + 1, lane + (i - (children.length - 1) / 2))).filter(Boolean);
    for (const childId of successors) dataEdges.push({ source: childId, target: id, variable: 'input' });
    return id;
  }
  for (const statement of statements) {
    if (serial >= limit) break;
    if (statement.type === 'source-call' && !Number.isInteger(statement.callStart)) continue;
    try {
      const ast = parseExpressionAt(source, statement.type === 'source-call' ? statement.callStart : statement.expressionStart, { ecmaVersion: 2022, locations: true });
      const root = decompose(ast.type === 'ChainExpression' ? ast.expression : ast, statement, 0, 0);
      if (root) dataEdges.push({ source: root, target: statement.id, variable: 'result' });
    } catch (_) { /* Parent statement remains executable even if visualization cannot expand. */ }
  }
}

const coord = index => ({ x: 96 + (Math.floor(index / 9) * 420), y: 75 + (index % 9) * 274 });
function parseModule(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE) throw new Error('JavaScript source must be 1–150 KB');
  try { return parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true }); }
  catch (error) {
    const context = /(?:=>\s*\(?\s*<|return\s*\(?\s*<|<\/?[A-Z][\w.]*(?:\s|\/>|>))/.test(source);
    throw new Error(`JavaScript parse error at ${error.loc?.line ?? '?'}:${error.loc?.column ?? '?'}: ${error.message}. ${context ? 'This Acorn importer does not parse JSX; select a plain JavaScript module or convert JSX with a compatible parser first.' : 'Check for JSX, TypeScript syntax or a JavaScript syntax error. Unsupported function statements can be visualized after the file parses.'}`);
  }
}
function functionCandidates(ast) {
  const found = [];
  for (const item of ast.body) {
    const declaration = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(item.type) ? item.declaration : item;
    if (!declaration) continue;
    if (declaration.type === 'FunctionDeclaration') {
      found.push({ expression: declaration, name: declaration.id?.name || 'default', kind: 'function' });
    } else if (declaration.type === 'VariableDeclaration') {
      for (const part of declaration.declarations) {
        if (['ArrowFunctionExpression', 'FunctionExpression'].includes(part.init?.type) && part.id.type === 'Identifier') {
          found.push({ expression: part.init, name: part.id.name, kind: part.init.type === 'ArrowFunctionExpression' ? 'arrow function' : 'function expression' });
        }
      }
    } else if (['FunctionExpression', 'ArrowFunctionExpression'].includes(declaration.type)) {
      found.push({ expression: declaration, name: declaration.id?.name || 'default', kind: 'default export' });
    }
  }
  return found;
}
/** List individual, top-level JavaScript functions without importing or running them. */
export function listJavaScriptFunctions(source) {
  return functionCandidates(parseModule(source)).map((item, index) => ({
    index, name: item.name, kind: item.kind,
    line: item.expression.loc.start.line, endLine: item.expression.loc.end.line,
    parameters: item.expression.params.map(p => p.type === 'Identifier' ? p.name : source.slice(p.start, p.end)),
    // An arrow with an expression body is still a complete, valid function.
    // Its expression is an implicit return; it does not need braces.
    supportedBody: Boolean(item.expression.body),
    bodyStyle: item.expression.body.type === 'BlockStatement' ? 'block' : 'expression',
    simpleParameters: item.expression.params.every(p => p.type === 'Identifier' && safeName(p.name)),
  }));
}
/** `functionIndex` matches the selected entry returned by listJavaScriptFunctions. */
export function importJavaScriptFunction(source, filename = 'Imported JavaScript', functionIndex = 0, suppliedWorkspace = null) {
  const importPath = suppliedWorkspace ? filename : /\.m?js$/i.test(filename) ? filename : 'import.js';
  const workspace = suppliedWorkspace || createSourceWorkspace({ [importPath]: source });
  const candidates = functionCandidates(parseModule(source));
  if (!candidates.length) throw new Error('No functions found. Import a JS file with a top-level function or const/let arrow function.');
  if (!Number.isInteger(functionIndex) || functionIndex < 0 || functionIndex >= candidates.length) throw new Error('Selected function is no longer available.');
  const candidate = candidates[functionIndex];
  const { expression } = candidate;
  if (!expression.body) throw new Error('Selected function has no body.');
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
  const start = emit('source-start', `${candidate.name}(${parameters.join(', ')})`, expression);
  const expressionFields = (field, expr) => {
    const raw = source.slice(expr.start, expr.end);
    try { return { expressionText: raw, expressionIR: irExpression(expr), expressionStart: expr.start, expressionEnd: expr.end, reads: dependenciesOf(irExpression(expr)), statementKind: field }; }
    catch (e) {
      if (canAnalyzeExpression(expr)) return { expressionText: raw, expressionStart: expr.start, expressionEnd: expr.end, reads: readsInExpression(expr), statementKind: field, richExpression: true };
      return { unsupportedReason: e.message, original: raw };
    }
  };
  /** Visible control-flow microsteps, each a single AST operation. These
   * inspection nodes do NOT execute a second copy of the expression. */
  function detailSteps(expressionNode, starts, controlNodes = []) {
    if (!expressionNode || !starts.length || nodes.length >= MAX_NODES - 12) return starts;
    const examined = [];
    const walk = (ast, depth = 0) => {
      if (!ast || depth > 12 || examined.length > 80) return;
      if (ast.type === 'ChainExpression') { walk(ast.expression, depth + 1); return; }
      if (ast.type === 'ArrowFunctionExpression') { walk(ast.body, depth + 1); return; }
      if (ast.type === 'MemberExpression') walk(ast.object, depth + 1);
      else if (ast.type === 'CallExpression') { walk(ast.callee, depth + 1); for (const a of ast.arguments) walk(a, depth + 1); }
      else if (ast.type === 'BinaryExpression' || ast.type === 'LogicalExpression') { walk(ast.left, depth + 1); walk(ast.right, depth + 1); }
      else if (ast.type === 'ConditionalExpression') { walk(ast.test, depth + 1); walk(ast.consequent, depth + 1); walk(ast.alternate, depth + 1); }
      else if (ast.type === 'ObjectExpression') for (const prop of ast.properties) walk(prop.value, depth + 1);
      else if (ast.type === 'ArrayExpression') for (const child of ast.elements) walk(child, depth + 1);
      else if (ast.type === 'UnaryExpression') walk(ast.argument, depth + 1);
      let kind = '', title = '';
      if (ast.type === 'MemberExpression') { kind = ast.optional ? 'source-optional' : 'source-property-read'; title = ast.optional ? 'Optional property access' : 'Read property'; }
      else if (ast.type === 'CallExpression' && ast.callee.type === 'MemberExpression') { kind = 'source-method'; title = `Method: ${ast.callee.property.name}()`; }
      else if (ast.type === 'BinaryExpression') { kind = 'source-math'; title = `Compute ${ast.operator}`; }
      else if (ast.type === 'LogicalExpression') { kind = 'source-comparison'; title = `Evaluate ${ast.operator}`; }
      else if (ast.type === 'ObjectExpression') { kind = 'source-object'; title = `Create object (${ast.properties.length} fields)`; }
      else if (ast.type === 'ArrayExpression') { kind = 'source-array'; title = `Create array (${ast.elements.length} items)`; }
      else if (ast.type === 'TemplateLiteral') { kind = 'source-template'; title = 'Build template string'; }
      else if (ast.type === 'ConditionalExpression') { kind = 'source-ternary-step'; title = 'Choose ternary result'; }
      if (kind && canAnalyzeExpression(ast)) examined.push({ ast, kind, title });
    };
    walk(expressionNode);
    // At most three focused microsteps per statement keep the main canvas
    // readable; more detailed trees remain available in Data Dependencies.
    const choices = [...new Map(examined.slice(-4).map(step => [`${step.kind}:${step.ast.start}`, step])).values()].slice(-3);
    let ends = starts;
    for (const { ast, kind, title } of choices) {
      const step = emit(kind, title, ast, { controlNodes, inspectOnly: true, sourceExcerpt: source.slice(ast.start, ast.end).slice(0, 180), description: 'Read-only decomposition: evaluated by its owning statement, not twice.' });
      link(ends, step);
      ends = [{ node: step, port: 'out' }];
    }
    return ends;
  }
  function compileSequence(statements, incoming, controlNodes = []) {
    let ends = incoming;
    for (const statement of statements) {
      if (!ends.length) break; // unreachable statements remain in original source verbatim
      if (statement.type === 'EmptyStatement') continue;
      if (statement.type === 'BlockStatement') { ends = compileSequence(statement.body, ends, controlNodes); continue; }
      if (statement.type === 'VariableDeclaration' && statement.declarations.length > 1) {
        ends = compileSequence(statement.declarations.map(decl => ({ ...statement, declarations: [decl], start: decl.start, end: decl.end, loc: decl.loc })), ends, controlNodes);
        continue;
      }
      if (statement.type === 'IfStatement') {
        const details = expressionFields('test', statement.test);
        const calls = directCalls(statement.test);
        const containsCall = calls.length > 0;
        // A call in an if-condition must remain a compact dependency node;
        // its branch choice is evaluated only when the decision is reached.
        if (containsCall) {
          for (const call of calls) {
            const dependency = resolveFunction(workspace, importPath, call.callee.name);
            const reference = emit('source-call', `${call.callee.name}(…)`, statement, {
              controlNodes, calleeName: call.callee.name, callSource: source.slice(call.start, call.end), callStart: call.start,
              callArguments: call.arguments.map(a => source.slice(a.start, a.end)), callAuxiliary: true,
              dependencyPath: dependency?.path || null, dependencyName: dependency?.name || null,
              dependencyStatus: dependency ? 'linked' : 'unresolved', dependencyRef: dependency,
              reads: readsInExpression(call), description: dependency ? `Linked condition dependency • ${dependency.path}` : 'Unresolved condition dependency',
            });
            link(ends, reference);
            ends = [{ node: reference, port: 'out' }];
          }
        }
        const valid = !details.unsupportedReason;
        const usable = valid || containsCall;
        const mayBeUnknown = containsCall || details.richExpression;
        const node = emit(usable ? 'source-decision' : 'source-opaque', usable ? 'if ' + source.slice(statement.test.start, statement.test.end).slice(0, 55) : 'Unsupported if condition', statement, {
          ...(valid ? details : containsCall ? { expressionText: source.slice(statement.test.start, statement.test.end), reads: readsInExpression(statement.test), statementKind: 'test' } : details),
          sourceCallCondition: containsCall, controlNodes,
          description: usable ? 'Choose TRUE/FALSE via isolated AST. UNKNOWN uses an explicitly unverified bypass.' : 'Unverified condition: skip both branches and taint affected variables.',
          opaqueWrites: mayBeUnknown || !usable ? [...new Set(findAssignedNames(statement))] : [],
        });
        ends = detailSteps(statement.test, ends, controlNodes);
        link(ends, node);
        if (!usable) { ends = [{ node, port: 'out' }]; continue; }
        const yes = compileSequence(statement.consequent.type === 'BlockStatement' ? statement.consequent.body : [statement.consequent], [{ node, port: 'true' }], [...controlNodes, node.id]);
        const no = statement.alternate ? compileSequence(statement.alternate.type === 'BlockStatement' ? statement.alternate.body : [statement.alternate], [{ node, port: 'false' }], [...controlNodes, node.id]) : [{ node, port: 'false' }];
        ends = [...yes, ...no, ...(mayBeUnknown ? [{ node, port: 'unknown' }] : [])];
      } else {
        let expr = null, target = null, kind = null, updateOperator = null;
        if (statement.type === 'VariableDeclaration' && statement.declarations.length === 1 && statement.declarations[0].id.type === 'Identifier') {
          target = statement.declarations[0].id.name; expr = statement.declarations[0].init; kind = expr ? 'assign' : 'declare';
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.left.type === 'MemberExpression') {
          const memberPath = getMemberPath(statement.expression.left);
          if (memberPath && statement.expression.operator === '=') {
            target = memberPath.root; expr = statement.expression.right; kind = 'write'; updateOperator = '=';
          }
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.left.type === 'Identifier') {
          target = statement.expression.left.name; expr = statement.expression.right;
          updateOperator = statement.expression.operator;
          kind = updateOperator === '=' ? 'assign' : 'update';
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'UpdateExpression' && statement.expression.argument.type === 'Identifier') {
          target = statement.expression.argument.name; updateOperator = statement.expression.operator; kind = 'update';
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression') { expr = statement.expression; kind = 'call'; }
        else if (statement.type === 'ReturnStatement' && statement.argument) { expr = statement.argument; kind = 'return'; }
        const calls = directCalls(expr);
        // Property assignments must keep the property-write node as the owner
        // of the result. A helper in the RHS is an inspect-only dependency,
        // NOT an assignment to the root object itself.
        if (kind === 'write' && calls.length) {
          for (const call of calls) {
            const linked = resolveFunction(workspace, importPath, call.callee.name);
            const reference = emit('source-call', `${call.callee.name}(…)`, call, {
              controlNodes, calleeName: call.callee.name,
              callSource: source.slice(call.start, call.end), callStart: call.start,
              callArguments: call.arguments.map(arg => source.slice(arg.start, arg.end)),
              callAuxiliary: true, dependencyPath: linked?.path || null,
              dependencyName: linked?.name || null,
              dependencyStatus: linked ? 'linked' : 'unresolved',
              dependencyRef: linked, reads: readsInExpression(call),
              description: linked ? `Inspect helper ${linked.name}()` : 'Unresolved dependency; owning property write checks its result',
            });
            link(ends, reference);
            ends = [{ node: reference, port: 'out' }];
          }
        }
        if (calls.length && kind !== 'write') {
          // Keep the focused function expanded, but each referenced function
          // stays one linked, source-backed dependency node. The final call
          // node evaluates the *whole* expression (including arithmetic and
          // short-circuit logic); earlier cards are references only.
          for (const [callIndex, call] of calls.entries()) {
            const resolved = resolveFunction(workspace, importPath, call.callee.name);
            const argTexts = call.arguments.map(arg => source.slice(arg.start, arg.end));
            const last = callIndex === calls.length - 1;
            const node = emit('source-call', `${last && kind === 'return' ? 'return ' : last && target ? target + ' = ' : ''}${call.callee.name}(…)`, statement, {
              controlNodes, calleeName: call.callee.name, callSource: source.slice(call.start, call.end), callStart: call.start, callArguments: argTexts,
              callExpressionText: last ? source.slice(expr.start, expr.end) : null, callAuxiliary: !last,
              dependencyPath: resolved?.path || null, dependencyName: resolved?.name || null, dependencyStatus: resolved ? 'linked' : 'unresolved',
              dependencyRef: resolved, variableName: last ? target : null, callReturns: last && kind === 'return',
              reads: readsInExpression(expr),
              description: resolved ? `${resolved.path} · ${resolved.name}(${resolved.parameters.join(', ')}) · compact function dependency` : 'Unresolved external call · unknown effects',
              opaqueWrites: [...new Set(findAssignedNames(statement))],
            });
            link(ends, node);
            ends = last && kind === 'return' ? [] : [{ node, port: 'out' }];
          }
          continue;
        }
        // Keep update operations explicit instead of treating them as opaque.
        const updateSupported = kind === 'update' && ['+=', '-=', '*=', '/=', '%=', '**=', '++', '--'].includes(updateOperator);
        const details = kind === 'declare' ? { statementKind: kind, reads: [] }
          : updateSupported && !expr ? { statementKind: 'update', expressionIR: { type: 'literal', value: 1 }, expressionText: '1', reads: [target] }
          : expr ? expressionFields(kind, expr) : { unsupportedReason: `Unsupported ${statement.type}`, original: source.slice(statement.start, statement.end) };
        if (kind === 'update' && !updateSupported) details.unsupportedReason = `Unsupported update ${updateOperator}`;
        if (target && (!safeName(target) || ['__proto__', 'prototype', 'constructor'].includes(target))) details.unsupportedReason = 'Unsafe variable identifier';
        const supported = !details.unsupportedReason;
        const unsupportedType = ['ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement'].includes(statement.type) ? 'source-loop'
          : statement.type === 'SwitchStatement' ? 'source-switch'
          : statement.type === 'TryStatement' ? 'source-try'
          : statement.type === 'ThrowStatement' ? 'source-throw'
          : expr?.type === 'AwaitExpression' ? 'source-await'
          : 'source-opaque';
        const type = !supported ? unsupportedType : kind === 'write' ? 'source-property-write' : kind === 'return' ? 'source-return' : kind === 'declare' ? 'source-declare' : kind === 'update' ? 'source-update' : 'source-operation';
        const title = !supported ? `Opaque: ${statement.type}` : kind === 'write' ? `${source.slice(statement.expression.left.start, statement.expression.left.end)} = ${details.expressionText}` : kind === 'return' ? `return ${details.expressionText}` : kind === 'declare' ? `let ${target} (uninitialized)` : kind === 'update' ? `${target} ${updateOperator} ${expr ? details.expressionText : ''}` : `${target} = ${details.expressionText}`;
        const node = emit(type, title, statement, { ...details, controlNodes, variableName: target || null, propertyPath: kind === 'write' ? getMemberPath(statement.expression.left) : null, updateOperator,
          opaqueTerminal: !supported && ['ReturnStatement', 'ThrowStatement', 'UnsupportedFunctionSemantics'].includes(statement.type),
          opaqueReturn: statement.opaqueReturn === true || statement.implicitArrowReturn === true,
          opaqueWrites: !supported ? [...new Set(findAssignedNames(statement))] : [],
          description: supported ? `Line ${statement.loc.start.line} • ${kind === 'update' ? 'source update' : 'editable pure expression'}` : details.unsupportedReason });
        if (supported && expr && !['source-update'].includes(type)) ends = detailSteps(expr, ends, controlNodes);
        link(ends, node);
        ends = type === 'source-return' || node.opaqueTerminal ? [] : [{ node, port: 'out' }];
      }
    }
    return ends;
  }
  // Concise arrow bodies (`const double = x => x * 2`) implicitly return
  // the expression. A synthetic ReturnStatement records exactly the original
  // expression offsets, so source edits still patch only its expression.
  // This is an AST interpretation, NOT a source-text rewrite or JS execution.
  const body = expression.body;
  const statements = expression.async || expression.generator ? [{
    // Async functions return Promises and generators return iterators. The
    // restricted interpreter cannot reproduce either, even for pure-looking
    // expressions, so import them as explicitly unsupported terminal nodes.
    type: 'UnsupportedFunctionSemantics', start: body.start, end: body.end,
    loc: body.loc, opaqueReturn: true,
  }] : body.type === 'BlockStatement' ? body.body : [{
    type: 'ReturnStatement', start: body.start, end: body.end, loc: body.loc,
    argument: body, implicitArrowReturn: true,
  }];
  const ends = compileSequence(statements, [{ node: start, port: 'out' }]);
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
    if (node.variableName && ['source-operation', 'source-declare', 'source-update', 'source-call', 'source-property-write'].includes(node.type)) reaching.set(node.variableName, new Set([id]));
    knownOut.set(id, reaching);
    for (const child of children.get(id)) { pending.set(child, pending.get(child) - 1); if (pending.get(child) === 0) queue.push(child); }
  }
  if (dataEdges.length > 4000) throw new Error('Too many possible data dependencies (4,000 max). Import a smaller function.');
  layoutSourceFlow(nodes, edges);
  expandExpressions(source, nodes, dataEdges);
  const functionName = candidate.name;
  return {
    name: `${filename.replace(/\.m?js$/i, '')} • ${functionName}`,
    nodes, edges,
    program: { kind: 'javascript-function', source, sourcePath: importPath, workspaceFiles: { ...workspace.files }, functionIndex, functionName, bodyStyle: body.type === 'BlockStatement' ? 'block' : 'expression', parameters, inputValues: Object.fromEntries(parameters.map(p => [p, 0])), watchRules: [], dataEdges, importedNodeIds: nodes.map(n => n.id), importedEdgeIds: edges.map(e => e.id), originalEdges: edges.map(e => ({ ...e })) },
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
  const callable = moduleCallableNames(source);
  for (const node of graph.nodes) {
    if (!Number.isInteger(node.expressionStart)) continue;
    const original = source.slice(node.expressionStart, node.expressionEnd);
    if (node.expressionText !== original) {
      validateSourceExpression(node.expressionText, callable); // fail closed; richer AST subset
      edits.push({ start: node.expressionStart, end: node.expressionEnd, text: node.expressionText });
    }
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}
