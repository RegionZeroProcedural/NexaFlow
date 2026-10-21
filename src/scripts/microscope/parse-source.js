/** Parse project sources into ESTree ASTs. Babel's parser understands JSX and
 * TypeScript, which the restricted single-function importer (Acorn) does not.
 * Parsing never executes the source. */
import { parse } from '@babel/parser';

export const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

export function isSourcePath(path) {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some(ext => lower.endsWith(ext)) && !lower.endsWith('.d.ts') && !/\.min\.[cm]?js$/.test(lower);
}

function pluginsFor(path) {
  const lower = path.toLowerCase();
  const estree = ['estree', { classFeatures: true }];
  const common = ['classProperties', 'classPrivateProperties', 'classPrivateMethods', 'classStaticBlock', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator', 'topLevelAwait', 'exportDefaultFrom', ['decorators', { decoratorsBeforeExport: true }]];
  if (/\.(ts|mts|cts)$/.test(lower)) return [estree, 'typescript', ...common];
  if (lower.endsWith('.tsx')) return [estree, 'typescript', 'jsx', ...common];
  return [estree, 'jsx', ...common];
}

/** Returns { ast, errors }. errorRecovery keeps partially broken files usable. */
export function parseSource(code, path = 'module.js') {
  try {
    const file = parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins: pluginsFor(path),
    });
    return { ast: file.program, errors: (file.errors || []).map(e => e.message) };
  } catch (error) {
    return { ast: null, errors: [error.message] };
  }
}

/** Parse a single expression typed by the user (e.g. argument values). */
export function parseExpressionSource(code) {
  const { ast, errors } = parseSource(`(${code}\n)`, 'input.js');
  if (!ast || errors.length) throw new Error(errors[0] || 'Could not parse expression');
  const statement = ast.body[0];
  if (ast.body.length !== 1 || statement?.type !== 'ExpressionStatement') throw new Error('Enter a single JavaScript expression');
  return statement.expression;
}

/** Shallow child iteration over ESTree nodes, skipping position metadata. */
export function forEachChild(node, visit) {
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'typeAnnotation' || key === 'returnType' || key === 'typeParameters' || key === 'superTypeParameters') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === 'string') visit(item, key); }
    else if (value && typeof value.type === 'string') visit(value, key);
  }
}

export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Stable key shared by the dissector and interpreter to match AST nodes. */
export const astKey = node => `${node.start}:${node.end}:${node.type}`;

/** Strip TypeScript-only expression wrappers (`x as T`, `x!`, `<T>x`). */
export function unwrapTs(node) {
  let current = node;
  while (current && ['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSInstantiationExpression', 'ParenthesizedExpression'].includes(current.type)) current = current.expression;
  return current;
}
