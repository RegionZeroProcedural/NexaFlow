import { parse } from '../vendor/acorn.mjs';

/** A source-preserving *inspection outline*, not a source formatter/exporter.
 * Changes here never alter the original text, AST, graph or execution.
 * Only AST structure determines indentation; expressions keep source spelling.
 */
export function readableFunctionOutline(program) {
  if (!program || typeof program.source !== 'string') return '';
  const source = program.source;
  const ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  const functions = [];
  for (const item of ast.body) {
    const declaration = ['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(item.type) ? item.declaration : item;
    if (!declaration) continue;
    if (declaration.type === 'FunctionDeclaration') functions.push(declaration);
    else if (declaration.type === 'VariableDeclaration') {
      for (const decl of declaration.declarations) if (['ArrowFunctionExpression','FunctionExpression'].includes(decl.init?.type)) functions.push(decl.init);
    } else if (['ArrowFunctionExpression','FunctionExpression'].includes(declaration.type)) functions.push(declaration);
  }
  const fn = functions[program.functionIndex || 0];
  if (!fn) return '// Selected function not found in this source.';

  const textOf = node => source.slice(node.start, node.end).trim();
  const lines = [], limit = 260;
  const put = (depth, text) => {
    if (lines.length >= limit) return;
    const clipped = text.length > 420 ? `${text.slice(0, 417)}…` : text;
    lines.push(`${'  '.repeat(Math.min(depth, 18))}${clipped}`);
  };
  const statements = (body, depth) => {
    if (lines.length >= limit) return;
    for (const stmt of body) {
      if (lines.length >= limit) break;
      if (stmt.type === 'BlockStatement') {
        put(depth, '{'); statements(stmt.body, depth + 1); put(depth, '}');
      } else if (stmt.type === 'IfStatement') {
        put(depth, `if (${textOf(stmt.test)}) {`);
        statements(stmt.consequent.type === 'BlockStatement' ? stmt.consequent.body : [stmt.consequent], depth + 1);
        if (stmt.alternate) {
          put(depth, '} else {');
          statements(stmt.alternate.type === 'BlockStatement' ? stmt.alternate.body : [stmt.alternate], depth + 1);
        }
        put(depth, '}');
      } else if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          const key = textOf(d.id);
          put(depth, d.init ? `${stmt.kind} ${key} = ${textOf(d.init)};` : `${stmt.kind} ${key};`);
        }
      } else if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
        put(depth, 'return {');
        for (const prop of stmt.argument.properties) put(depth + 1, `${textOf(prop)},`);
        put(depth, '};');
      } else if (stmt.type === 'ReturnStatement') {
        put(depth, stmt.argument ? `return ${textOf(stmt.argument)};` : 'return;');
      } else if (stmt.type === 'ExpressionStatement') {
        put(depth, `${textOf(stmt.expression)};`);
      } else if (stmt.type === 'EmptyStatement') {
        continue;
      } else {
        const marker = ['ForStatement','ForOfStatement','ForInStatement','WhileStatement','DoWhileStatement'].includes(stmt.type)
          ? 'loop' : stmt.type === 'SwitchStatement' ? 'switch' : stmt.type === 'TryStatement' ? 'try/catch' : stmt.type;
        put(depth, `⚠ ${marker} [not necessarily simulatable] ${textOf(stmt).slice(0, 210)}`);
      }
    }
  };
  put(0, `function ${program.functionName || '(selected)'}(${(program.parameters || []).join(', ')}) {`);
  if (fn.body.type === 'BlockStatement') statements(fn.body.body, 1);
  else put(1, `return ${textOf(fn.body)}; // implicit arrow return`);
  put(0, '}');
  if (lines.length >= limit) lines.push('// …outline truncated to 260 lines');
  return lines.join('\n');
}
