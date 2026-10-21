/** Disassemble one function's AST into a "die shot": basic operation nodes
 * wired by data, nested inside control regions (if / loop / switch / try).
 *
 * Every node carries the same `key` (start:end:type) the interpreter puts on
 * its trace events, so replaying a trace lights up the matching nodes. */
import { astKey, unwrapTs, FUNCTION_TYPES } from './parse-source';

export const NODE_W = 172;
export const NODE_H = 56;
const COL_GAP = 46, ROW_GAP = 20, STACK_GAP = 14, PAD = 16, HEADER = 28, LANE_GAP = 22, RAIL = 22;
const MAX_NODES = 2600, MAX_EXPR_DEPTH = 9;

const ARITH = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^']);
const OP_NAMES = { '+': 'ADD', '-': 'SUBTRACT', '*': 'MULTIPLY', '/': 'DIVIDE', '%': 'MODULO', '**': 'POWER', '<<': 'SHIFT LEFT', '>>': 'SHIFT RIGHT', '>>>': 'SHIFT RIGHT (U)', '&': 'BIT AND', '|': 'BIT OR', '^': 'BIT XOR', '===': 'STRICT EQUAL', '!==': 'STRICT NOT EQUAL', '==': 'EQUAL', '!=': 'NOT EQUAL', '<': 'LESS THAN', '<=': 'AT MOST', '>': 'GREATER THAN', '>=': 'AT LEAST', in: 'HAS KEY', instanceof: 'INSTANCE OF', '&&': 'AND', '||': 'OR', '??': 'NULLISH OR', '!': 'NOT', typeof: 'TYPE OF', void: 'VOID', delete: 'DELETE', '~': 'BIT NOT' };

/** Node kind catalogue (also drives the legend in the UI). */
export const NODE_KINDS = {
  entry: { label: 'Function entry', group: 'Structure' },
  param: { label: 'Parameter', group: 'Data' },
  literal: { label: 'Literal', group: 'Data' },
  read: { label: 'Variable read', group: 'Data' },
  this: { label: 'this', group: 'Data' },
  declare: { label: 'Declare', group: 'Data' },
  destructure: { label: 'Destructure', group: 'Data' },
  assign: { label: 'Assign', group: 'Data' },
  'prop-write': { label: 'Property write', group: 'Data' },
  update: { label: 'Increment / update', group: 'Data' },
  arith: { label: 'Arithmetic', group: 'Operators' },
  compare: { label: 'Comparison', group: 'Operators' },
  logical: { label: 'Logic (short-circuit)', group: 'Operators' },
  unary: { label: 'Unary operator', group: 'Operators' },
  ternary: { label: 'Ternary select', group: 'Operators' },
  member: { label: 'Property read', group: 'Objects' },
  object: { label: 'Object literal', group: 'Objects' },
  array: { label: 'Array literal', group: 'Objects' },
  template: { label: 'Template string', group: 'Objects' },
  spread: { label: 'Spread', group: 'Objects' },
  jsx: { label: 'JSX element', group: 'Objects' },
  call: { label: 'Project function call', group: 'Calls' },
  'call-ext': { label: 'External / built-in call', group: 'Calls' },
  method: { label: 'Method call', group: 'Calls' },
  new: { label: 'Construct (new)', group: 'Calls' },
  closure: { label: 'Nested function', group: 'Calls' },
  class: { label: 'Class definition', group: 'Calls' },
  await: { label: 'Await', group: 'Async' },
  yield: { label: 'Yield', group: 'Async' },
  if: { label: 'If decision', group: 'Control' },
  loop: { label: 'Loop header', group: 'Control' },
  switch: { label: 'Switch', group: 'Control' },
  return: { label: 'Return', group: 'Control' },
  throw: { label: 'Throw', group: 'Control' },
  jump: { label: 'Break / continue', group: 'Control' },
  sequence: { label: 'Sequence (comma)', group: 'Operators' },
  expr: { label: 'Collapsed expression', group: 'Structure' },
};

function patternIdentifiers(pattern, out = []) {
  pattern = unwrapTs(pattern);
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern);
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) patternIdentifiers(p.type === 'RestElement' ? p.argument : p.value, out);
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) patternIdentifiers(e, out);
  else if (pattern.type === 'AssignmentPattern') patternIdentifiers(pattern.left, out);
  else if (pattern.type === 'RestElement') patternIdentifiers(pattern.argument, out);
  else if (pattern.type === 'TSParameterProperty') patternIdentifiers(pattern.parameter, out);
  return out;
}
const keyText = key => key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? String(key.value) : key?.type === 'PrivateIdentifier' || key?.type === 'PrivateName' ? `#${key.name || key.id?.name}` : '[…]';

export function dissectFunction(project, fnId) {
  const fn = project.functions[fnId];
  if (!fn) throw new Error('Function not found');
  const file = project.files[fn.path];
  const text = file.text;
  const src = (node, max = 64) => { const s = text.slice(node.start, node.end).replace(/\s+/g, ' '); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
  const callSites = new Map(fn.calls.map(c => [`${c.start}:${c.end}`, c]));
  const nestedById = new Map(Object.values(project.functions).filter(f => f.parentId === fnId).map(f => [f.start, f]));

  const nodes = [], wires = [], regions = [], rows = [];
  let truncated = false, created = 0;
  const usedIds = new Set();
  const node = (kind, ast, label, extra = {}) => {
    if (++created >= MAX_NODES) truncated = true;
    const n = { id: ast ? astKey(ast) : `synthetic:${nodes.length}`, kind, label: String(label).slice(0, 80), line: ast?.loc?.start.line, start: ast?.start, end: ast?.end, ...extra };
    // Keys must be unique per graph; synthetic duplicates get a suffix.
    if (usedIds.has(n.id)) n.id = `${n.id}#${created}`;
    usedIds.add(n.id);
    return n;
  };

  // ---------- Expression trees ----------
  // A tree is { n, children: [{ tree, label }] } laid out right-to-left.
  const leaf = n => ({ n, children: [] });
  const withChildren = (n, children) => ({ n, children: children.filter(c => c && c.tree) });
  const child = (ast, label, depth) => ast ? { tree: exprTree(ast, depth + 1), label } : null;

  function exprTree(raw, depth = 0) {
    const ast = unwrapTs(raw);
    if (!ast) return leaf(node('literal', raw, '∅'));
    if (depth > MAX_EXPR_DEPTH || created > MAX_NODES) { truncated = true; return leaf(node('expr', ast, src(ast, 40), { sub: 'collapsed — see source' })); }
    switch (ast.type) {
      case 'Literal': return leaf(node('literal', ast, ast.regex ? `/${ast.regex.pattern}/${ast.regex.flags}` : ast.bigint ? `${ast.bigint}n` : JSON.stringify(ast.value) ?? String(ast.value), { constant: true, sub: ast.regex ? 'regex' : ast.value === null ? 'null' : typeof ast.value }));
      case 'Identifier': return leaf(node(ast.name === 'undefined' ? 'literal' : 'read', ast, ast.name, { varName: ast.name, constant: ast.name === 'undefined', sub: ast.name === 'undefined' ? 'undefined' : 'read' }));
      case 'ThisExpression': return leaf(node('this', ast, 'this'));
      case 'Super': return leaf(node('this', ast, 'super'));
      case 'TemplateLiteral': return withChildren(node('template', ast, 'TEMPLATE `…`', { sub: src(ast, 30) }), ast.expressions.map((e, i) => child(e, `\${${i}}`, depth)));
      case 'TaggedTemplateExpression': return withChildren(node('call-ext', ast, `${src(ast.tag, 24)}\`…\``, { sub: 'tagged template' }), ast.quasi.expressions.map((e, i) => child(e, `\${${i}}`, depth)));
      case 'ArrayExpression': return withChildren(node('array', ast, `ARRAY [${ast.elements.length}]`), ast.elements.map((e, i) => e && (e.type === 'SpreadElement' ? { tree: withChildren(node('spread', e, '…spread'), [child(e.argument, null, depth + 1)]), label: `…${i}` } : child(e, String(i), depth))));
      case 'ObjectExpression': return withChildren(node('object', ast, `OBJECT {${ast.properties.length}}`), ast.properties.map(p => p.type === 'SpreadElement' ? { tree: withChildren(node('spread', p, '…spread'), [child(p.argument, null, depth + 1)]), label: '…' } : FUNCTION_TYPES.has(unwrapTs(p.value)?.type) ? { tree: closureTree(unwrapTs(p.value), keyText(p.key)), label: keyText(p.key) } : child(p.value, p.computed ? `[${src(p.key, 12)}]` : keyText(p.key), depth)));
      case 'FunctionExpression': case 'ArrowFunctionExpression': return closureTree(ast);
      case 'ClassExpression': return leaf(node('class', ast, `class ${ast.id?.name || ''}`.trim(), { sub: `${ast.body.body.length} members` }));
      case 'UnaryExpression': return withChildren(node('unary', ast, `${OP_NAMES[ast.operator] || ast.operator} (${ast.operator})`, { op: ast.operator }), [child(ast.argument, null, depth)]);
      case 'UpdateExpression': return withChildren(node('update', ast, `${ast.prefix ? ast.operator : ''}${src(ast.argument, 20)}${ast.prefix ? '' : ast.operator}`, { op: ast.operator, varName: ast.argument.type === 'Identifier' ? ast.argument.name : null, writes: true }), ast.argument.type === 'MemberExpression' ? [child(ast.argument.object, 'object', depth)] : []);
      case 'BinaryExpression': return withChildren(node(ARITH.has(ast.operator) ? 'arith' : 'compare', ast, `${OP_NAMES[ast.operator] || ast.operator} (${ast.operator})`, { op: ast.operator }), [child(ast.left, 'a', depth), child(ast.right, 'b', depth)]);
      case 'LogicalExpression': return withChildren(node('logical', ast, `${OP_NAMES[ast.operator]} (${ast.operator})`, { op: ast.operator, branching: true }), [child(ast.left, 'a', depth), child(ast.right, 'b (lazy)', depth)]);
      case 'ConditionalExpression': return withChildren(node('ternary', ast, 'SELECT ? :', { branching: true }), [child(ast.test, 'test', depth), child(ast.consequent, 'then', depth), child(ast.alternate, 'else', depth)]);
      case 'AssignmentExpression': return assignmentTree(ast, depth);
      case 'SequenceExpression': return withChildren(node('sequence', ast, `SEQUENCE (${ast.expressions.length})`), ast.expressions.map((e, i) => child(e, String(i + 1), depth)));
      case 'ChainExpression': return exprTree(ast.expression, depth);
      case 'MemberExpression': case 'OptionalMemberExpression':
        return withChildren(node('member', ast, ast.computed ? `[${src(ast.property, 18)}]` : `${ast.optional ? '?.' : '.'}${keyText(ast.property)}`, { sub: src(ast, 36), optional: Boolean(ast.optional) }), [child(ast.object, 'object', depth), ast.computed ? child(ast.property, 'key', depth) : null]);
      case 'CallExpression': case 'OptionalCallExpression': case 'NewExpression': return callTree(ast, depth);
      case 'AwaitExpression': return withChildren(node('await', ast, 'AWAIT'), [child(ast.argument, 'promise', depth)]);
      case 'YieldExpression': return withChildren(node('yield', ast, ast.delegate ? 'YIELD*' : 'YIELD'), [child(ast.argument, null, depth)]);
      case 'SpreadElement': return withChildren(node('spread', ast, '…spread'), [child(ast.argument, null, depth)]);
      case 'JSXElement': case 'JSXFragment': return jsxTree(ast, depth);
      case 'MetaProperty': return leaf(node('read', ast, `${ast.meta.name}.${ast.property.name}`));
      case 'ImportExpression': return withChildren(node('call-ext', ast, 'import()', { sub: 'dynamic import' }), [child(ast.source, 'path', depth)]);
      default: return leaf(node('expr', ast, src(ast, 40), { sub: ast.type }));
    }
  }
  function closureTree(ast, name) {
    const nested = nestedById.get(ast.start) || project.functions[`${fn.path}#${ast.start}`];
    return leaf(node('closure', ast, `ƒ ${nested?.name?.split(' › ').pop() || name || (ast.type === 'ArrowFunctionExpression' ? 'arrow' : 'function')}`, { sub: `(${ast.params.map(p => src(p, 14)).join(', ')})${ast.async ? ' async' : ''}`, targetId: nested?.id || null }));
  }
  function callTree(ast, depth) {
    const site = callSites.get(`${ast.start}:${ast.end}`);
    const callee = unwrapTs(ast.callee);
    const target = site?.targetId ? project.functions[site.targetId] : null;
    const argLabel = i => target?.params[i]?.replace(/\s*=.*$/, '').slice(0, 14) || `arg${i}`;
    const args = ast.arguments.map((a, i) => a.type === 'SpreadElement' ? { tree: withChildren(node('spread', a, '…args'), [child(a.argument, null, depth + 1)]), label: '…' } : child(a, argLabel(i), depth));
    const meta = { targetId: target?.id || null, targetName: target?.name || site?.className || null, external: site?.external || null, optional: Boolean(ast.optional) };
    if (ast.type === 'NewExpression') return withChildren(node('new', ast, `new ${src(callee, 26)}`, { ...meta, sub: target ? `${target.path.split('/').pop()}:${target.line}` : meta.external || 'constructor' }), args);
    if (callee.type === 'Super') return withChildren(node('call', ast, 'super(…)', { ...meta, sub: 'parent constructor' }), args);
    if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !target) {
      const name = callee.computed ? `[${src(callee.property, 14)}]` : keyText(callee.property);
      return withChildren(node('method', ast, `.${name}()`, { ...meta, sub: meta.external || src(callee.object, 30) }), [child(callee.object, 'receiver', depth), ...args]);
    }
    const label = `${src(callee, 30)}()`;
    if (target) {
      const receiver = callee.type === 'MemberExpression' && callee.object.type !== 'Identifier' ? [child(callee.object, 'this', depth)] : [];
      return withChildren(node('call', ast, label, { ...meta, sub: `${target.path.split('/').pop()}:${target.line}` }), [...receiver, ...args]);
    }
    if (callee.type !== 'Identifier') return withChildren(node('call-ext', ast, '(…)()', { ...meta, sub: 'computed callee' }), [child(callee, 'callee', depth), ...args]);
    return withChildren(node('call-ext', ast, label, { ...meta, sub: meta.external || 'dynamic / built-in' }), args);
  }
  function jsxTree(ast, depth) {
    const site = ast.type === 'JSXElement' ? callSites.get(`${ast.openingElement.start}:${ast.openingElement.end}`) : null;
    const tag = ast.type === 'JSXFragment' ? '<>' : `<${src(ast.openingElement.name, 24)}>`;
    const attrs = ast.type === 'JSXElement' ? ast.openingElement.attributes.map(a => a.type === 'JSXSpreadAttribute' ? child(a.argument, '…props', depth) : a.value?.type === 'JSXExpressionContainer' ? (FUNCTION_TYPES.has(unwrapTs(a.value.expression)?.type) ? { tree: closureTree(unwrapTs(a.value.expression), a.name.name), label: String(a.name.name) } : child(a.value.expression, String(a.name.name), depth)) : null) : [];
    const kids = ast.children.map(c => c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression' ? child(c.expression, 'child', depth) : (c.type === 'JSXElement' || c.type === 'JSXFragment') ? child(c, 'child', depth) : null);
    return withChildren(node('jsx', ast, tag, { targetId: site?.targetId || null, targetName: site?.targetId ? project.functions[site.targetId].name : null, sub: site?.targetId ? 'component' : 'element' }), [...attrs, ...kids]);
  }
  function assignmentTree(ast, depth) {
    const left = unwrapTs(ast.left);
    if (left.type === 'MemberExpression') {
      return withChildren(node('prop-write', ast, `${src(left, 26)} ${ast.operator}`, { sub: 'property write', writes: true }), [child(left.object, 'object', depth), left.computed ? child(left.property, 'key', depth) : null, child(ast.right, 'value', depth)]);
    }
    if (left.type === 'Identifier') return withChildren(node('assign', ast, `${left.name} ${ast.operator}`, { varName: left.name, writes: true, sub: ast.operator === '=' ? 'assign' : 'compound update' }), [child(ast.right, 'value', depth)]);
    return withChildren(node('destructure', ast, `${src(left, 26)} =`, { writes: true, varNames: patternIdentifiers(left).map(i => i.name) }), [child(ast.right, 'value', depth)]);
  }

  /** Lay out a tree; returns a box with absolute-able relative coordinates. */
  function layoutTree(tree) {
    const placed = [], localWires = [];
    const place = (t, right, top) => {
      const kids = t.children;
      let height = 0;
      const childCenters = [];
      kids.forEach((c, i) => {
        if (i) height += STACK_GAP;
        const used = place(c.tree, right - NODE_W - COL_GAP, top + height);
        childCenters.push(c.tree.n.y + NODE_H / 2);
        localWires.push({ from: c.tree.n.id, to: t.n.id, pin: i, pins: kids.length, label: c.label, kind: 'data' });
        height += used;
      });
      t.n.x = right - NODE_W;
      t.n.y = kids.length ? Math.max(top, (childCenters[0] + childCenters[childCenters.length - 1]) / 2 - NODE_H / 2) : top;
      placed.push(t.n);
      return Math.max(height, t.n.y - top + NODE_H);
    };
    const height = place(tree, 0, 0);
    const minX = Math.min(...placed.map(n => n.x));
    for (const n of placed) n.x -= minX;
    return { nodes: placed, wires: localWires, width: Math.max(...placed.map(n => n.x + NODE_W)), height, root: tree.n };
  }

  // A box is { width, height, emit(x, y) } so parents can position children.
  const treeBox = (tree, rowAst) => {
    const laid = layoutTree(tree);
    return {
      width: laid.width + RAIL, height: laid.height,
      emit(x, y) {
        for (const n of laid.nodes) { n.x += x + RAIL; n.y += y; nodes.push(n); }
        wires.push(...laid.wires);
        if (rowAst) rows.push({ key: astKey(rowAst), x, y, w: laid.width + RAIL, h: laid.height, line: rowAst.loc?.start.line });
      },
    };
  };
  const stack = (boxes, gap = ROW_GAP) => ({
    width: Math.max(0, ...boxes.map(b => b.width)),
    height: boxes.reduce((h, b, i) => h + b.height + (i ? gap : 0), 0),
    emit(x, y) { let cy = y; for (const b of boxes) { b.emit(x, cy); cy += b.height + gap; } },
  });
  const side = (boxes) => ({
    width: boxes.reduce((w, b, i) => w + b.width + (i ? LANE_GAP : 0), 0),
    height: Math.max(0, ...boxes.map(b => b.height)),
    emit(x, y) { let cx = x; for (const b of boxes) { b.emit(cx, y); cx += b.width + LANE_GAP; } },
  });
  const region = (kind, label, inner, ast, extra = {}) => ({
    width: Math.max(inner.width + PAD * 2, 200), height: inner.height + PAD * 2 + HEADER,
    emit(x, y) {
      regions.push({ kind, label, x, y, w: Math.max(inner.width + PAD * 2, 200), h: inner.height + PAD * 2 + HEADER, key: ast ? astKey(ast) : null, line: ast?.loc?.start.line, ...extra });
      inner.emit(x + PAD, y + PAD + HEADER);
    },
  });
  const emptyBox = label => treeBox(leaf(node('expr', null, label, { sub: 'no statements' })));

  // ---------- Statements ----------
  function statementBox(raw) {
    const ast = raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration' ? (raw.declaration || raw) : raw;
    switch (ast.type) {
      case 'BlockStatement': return blockBox(ast.body, 'BLOCK', ast);
      case 'EmptyStatement': return null;
      case 'ExpressionStatement': return treeBox(exprTree(ast.expression), ast);
      case 'VariableDeclaration': return stack(ast.declarations.map(d => {
        const ids = patternIdentifiers(d.id);
        const simple = unwrapTs(d.id).type === 'Identifier';
        const sink = node(simple ? 'declare' : 'destructure', d, simple ? `${ast.kind} ${d.id.name}` : `${ast.kind} ${src(d.id, 28)}`, { varName: simple ? d.id.name : null, varNames: ids.map(i => i.name), writes: true, sub: d.init ? 'declare + init' : 'declare' });
        const tree = withChildren(sink, [d.init ? { tree: FUNCTION_TYPES.has(unwrapTs(d.init).type) ? closureTree(unwrapTs(d.init), simple ? d.id.name : null) : exprTree(d.init), label: 'init' } : null]);
        return treeBox(tree, ast.declarations.length === 1 ? ast : d);
      }), STACK_GAP);
      case 'FunctionDeclaration': return treeBox(closureTree(ast, ast.id?.name), ast);
      case 'ClassDeclaration': return treeBox(leaf(node('class', ast, `class ${ast.id?.name || ''}`, { sub: `${ast.body.body.length} members` })), ast);
      case 'ReturnStatement': return treeBox(withChildren(node('return', ast, 'RETURN', { sub: ast.argument ? 'value' : 'undefined' }), [ast.argument ? { tree: exprTree(ast.argument), label: 'value' } : null]), ast);
      case 'ThrowStatement': return treeBox(withChildren(node('throw', ast, 'THROW'), [{ tree: exprTree(ast.argument), label: 'error' }]), ast);
      case 'BreakStatement': case 'ContinueStatement': return treeBox(leaf(node('jump', ast, `${ast.type === 'BreakStatement' ? 'BREAK' : 'CONTINUE'}${ast.label ? ' ' + ast.label.name : ''}`)), ast);
      case 'DebuggerStatement': return treeBox(leaf(node('jump', ast, 'DEBUGGER')), ast);
      case 'IfStatement': {
        const header = treeBox(withChildren(node('if', ast, 'IF', { branching: true, sub: src(ast.test, 30) }), [{ tree: exprTree(ast.test), label: 'test' }]), ast);
        const lanes = [region('then', 'THEN ✓', bodyBox(ast.consequent), ast, { branch: 'then' })];
        if (ast.alternate) lanes.push(region('else', ast.alternate.type === 'IfStatement' ? 'ELSE IF' : 'ELSE ✗', bodyBox(ast.alternate), ast, { branch: 'else' }));
        return region('if', `IF · line ${ast.loc?.start.line}`, stack([header, side(lanes)]), ast);
      }
      case 'WhileStatement': case 'DoWhileStatement': {
        const loopNode = node('loop', ast, ast.type === 'WhileStatement' ? 'WHILE' : 'DO … WHILE', { branching: true, sub: src(ast.test, 30) });
        const header = treeBox(withChildren(loopNode, [{ tree: exprTree(ast.test), label: 'test' }]), ast);
        const body = region('body', 'BODY ↻', bodyBox(ast.body), ast, { loopBody: true });
        return region('loop', `${ast.type === 'WhileStatement' ? 'WHILE LOOP' : 'DO-WHILE LOOP'} · line ${ast.loc?.start.line}`, stack(ast.type === 'WhileStatement' ? [header, body] : [body, header]), ast, { loop: true });
      }
      case 'ForStatement': {
        const parts = [];
        if (ast.init) parts.push(ast.init.type === 'VariableDeclaration' ? statementBox(ast.init) : treeBox(exprTree(ast.init), ast.init));
        parts.push(treeBox(withChildren(node('loop', ast, 'FOR', { branching: true, sub: ast.test ? src(ast.test, 30) : 'forever' }), [ast.test ? { tree: exprTree(ast.test), label: 'test' } : null]), ast));
        parts.push(region('body', 'BODY ↻', bodyBox(ast.body), ast, { loopBody: true }));
        if (ast.update) parts.push(region('update', 'UPDATE (after each pass)', treeBox(exprTree(ast.update)), ast.update));
        return region('loop', `FOR LOOP · line ${ast.loc?.start.line}`, stack(parts), ast, { loop: true });
      }
      case 'ForOfStatement': case 'ForInStatement': {
        const decl = ast.left.type === 'VariableDeclaration' ? ast.left.declarations[0] : null;
        const binding = decl ? node('declare', decl, `${ast.left.kind} ${src(decl.id, 22)}`, { varName: unwrapTs(decl.id).type === 'Identifier' ? decl.id.name : null, varNames: patternIdentifiers(decl.id).map(i => i.name), writes: true, sub: ast.type === 'ForOfStatement' ? 'current item' : 'current key' }) : node('assign', ast.left, `${src(ast.left, 22)} =`, { writes: true, varName: ast.left.type === 'Identifier' ? ast.left.name : null });
        const loopNode = withChildren(node('loop', ast, ast.type === 'ForOfStatement' ? `FOR ${ast.await ? 'AWAIT ' : ''}… OF` : 'FOR … IN', { branching: true, sub: src(ast.right, 30) }), [{ tree: exprTree(ast.right), label: ast.type === 'ForOfStatement' ? 'iterable' : 'object' }]);
        const header = treeBox(withChildren(binding, [{ tree: loopNode, label: 'each' }]), ast);
        return region('loop', `${ast.type === 'ForOfStatement' ? 'FOR-OF' : 'FOR-IN'} LOOP · line ${ast.loc?.start.line}`, stack([header, region('body', 'BODY ↻', bodyBox(ast.body), ast, { loopBody: true })]), ast, { loop: true });
      }
      case 'SwitchStatement': {
        const header = treeBox(withChildren(node('switch', ast, 'SWITCH', { branching: true, sub: src(ast.discriminant, 30) }), [{ tree: exprTree(ast.discriminant), label: 'value' }]), ast);
        const lanes = ast.cases.map((c, i) => region('case', c.test ? `CASE ${src(c.test, 22)}` : 'DEFAULT', c.consequent.length ? blockInner(c.consequent) : emptyBox('fall through'), c, { branch: c.test ? `case:${i}` : 'default', switchKey: astKey(ast) }));
        return region('switch', `SWITCH · line ${ast.loc?.start.line}`, stack([header, lanes.length > 4 ? stack(lanes) : side(lanes)]), ast);
      }
      case 'TryStatement': {
        const lanes = [region('try', 'TRY', blockInner(ast.block.body), ast.block)];
        if (ast.handler) lanes.push(region('catch', `CATCH${ast.handler.param ? ` (${src(ast.handler.param, 16)})` : ''}`, blockInner(ast.handler.body.body), ast.handler));
        if (ast.finalizer) lanes.push(region('finally', 'FINALLY', blockInner(ast.finalizer.body), ast.finalizer));
        return region('trycatch', `TRY / CATCH · line ${ast.loc?.start.line}`, side(lanes), ast);
      }
      case 'LabeledStatement': return region('label', `LABEL ${ast.label.name}:`, statementBox(ast.body) || emptyBox('empty'), ast);
      default:
        if (ast.type.startsWith('TS')) return null;
        return treeBox(leaf(node('expr', ast, src(ast, 40), { sub: ast.type })), ast);
    }
  }
  function blockInner(statements) {
    const boxes = statements.map(statementBox).filter(Boolean);
    return boxes.length ? stack(boxes) : emptyBox('empty');
  }
  function bodyBox(statement) { return statement.type === 'BlockStatement' ? blockInner(statement.body) : (statementBox(statement) || emptyBox('empty')); }
  function blockBox(statements, label, ast) { return region('block', label, blockInner(statements), ast); }

  // ---------- Assemble ----------
  const fnNode = fn.node;
  const paramIds = fnNode.params.flatMap(p => patternIdentifiers(p));
  const entry = node('entry', fnNode, `${fn.name.split(' › ').pop()}(${fn.params.length ? '…' : ''})`, { sub: `${fn.path}:${fn.line}${fn.async ? ' · async' : ''}${fn.generator ? ' · generator' : ''}` });
  const paramTrees = paramIds.map((id, i) => leaf(node('param', id, id.name, { varName: id.name, writes: true, sub: `param ${i}${fn.params[i]?.includes('=') ? ' · default' : ''}` })));
  const entryBox = {
    width: RAIL + NODE_W + COL_GAP + (paramTrees.length ? NODE_W : 0),
    height: Math.max(NODE_H, paramTrees.length * (NODE_H + STACK_GAP) - STACK_GAP),
    emit(x, y) {
      entry.x = x + RAIL; entry.y = y; nodes.push(entry);
      paramTrees.forEach((t, i) => { t.n.x = x + RAIL + NODE_W + COL_GAP; t.n.y = y + i * (NODE_H + STACK_GAP); nodes.push(t.n); wires.push({ from: entry.id, to: t.n.id, pin: 0, pins: 1, label: null, kind: 'data', reverse: true }); });
    },
  };
  const body = fnNode.body.type === 'BlockStatement'
    ? blockInner(fnNode.body.body)
    : treeBox(withChildren(node('return', null, 'RETURN', { sub: 'implicit (arrow)' }), [{ tree: exprTree(fnNode.body), label: 'value' }]), fnNode.body);
  const root = region('function', `ƒ ${fn.qualifiedName}`, stack([region('entry', 'ENTRY · parameters', entryBox, null), body], ROW_GAP + 6), fnNode, { root: true });
  root.emit(0, 0);

  // ---------- Variable (def → use) wires ----------
  const writers = nodes.filter(n => n.writes && (n.varName || n.varNames?.length));
  const loopRegions = regions.filter(r => r.loop);
  const enclosingLoops = n => loopRegions.filter(r => n.start >= startOfKey(r.key) && n.end <= endOfKey(r.key));
  const varWires = [];
  for (const reader of nodes.filter(n => n.kind === 'read' && n.varName)) {
    const candidates = writers.filter(w => (w.varName === reader.varName || w.varNames?.includes(reader.varName)) && w.id !== reader.id);
    if (!candidates.length) continue;
    const before = candidates.filter(w => w.start < reader.start).sort((a, b) => b.start - a.start);
    const chosen = new Set(before.slice(0, 1));
    // Loop-carried values: a write later in the same loop reaches the next iteration.
    for (const loop of enclosingLoops(reader)) for (const w of candidates) if (w.start > reader.start && w.start >= startOfKey(loop.key) && w.end <= endOfKey(loop.key)) chosen.add(w);
    for (const w of chosen) varWires.push({ from: w.id, to: reader.id, kind: 'var', label: reader.varName, loopCarried: w.start > reader.start });
  }

  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const w of wires) { const target = byId.get(w.to); if (target) target.pins = Math.max(target.pins || 0, w.pins || 1); }
  const free = [...new Set(nodes.filter(n => n.kind === 'read' && n.varName && !writers.some(w => w.varName === n.varName || w.varNames?.includes(n.varName))).map(n => n.varName))];
  return {
    fnId, fn: { id: fn.id, name: fn.name, qualifiedName: fn.qualifiedName, path: fn.path, line: fn.line, params: fn.params, async: fn.async },
    nodes, wires, varWires, regions, rows, byId,
    width: root.width, height: root.height, truncated,
    freeVariables: free,
    stats: { nodes: nodes.length, calls: nodes.filter(n => ['call', 'call-ext', 'method', 'new', 'jsx'].includes(n.kind)).length, branches: nodes.filter(n => n.branching).length, loops: loopRegions.length },
  };
}
const startOfKey = key => Number(key.split(':')[0]);
const endOfKey = key => Number(key.split(':')[1]);

/** Index trace events by node key for fast playback lookups. */
export function indexTrace(events) {
  const byKey = new Map();
  events.forEach((e, i) => {
    if (!e.key) return;
    let list = byKey.get(e.key);
    if (!list) { list = []; byKey.set(e.key, list); }
    list.push(i);
  });
  return byKey;
}
