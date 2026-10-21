/** Safe, user-selected JavaScript module workspace. No module loading or evaluation. */
import { parse, parseExpressionAt } from '../vendor/acorn.mjs';
import { listJavaScriptFunctions } from './javascript-import';
import { evaluateRestricted, getMemberPath, updateMember, safeObject } from './restricted-ast';

export const MAX_FILES = 24;
function norm(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
export function resolveModulePath(from, request, files) {
  if (!request.startsWith('./') && !request.startsWith('../')) return null;
  const base = from.split('/').slice(0, -1).join('/');
  const joined = norm(`${base}/${request}`);
  if (!joined) return null;
  return [joined, `${joined}.js`, `${joined}.mjs`, `${joined}/index.js`, `${joined}/index.mjs`].find(candidate => Object.prototype.hasOwnProperty.call(files, candidate)) || null;
}
export function createSourceWorkspace(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Select JavaScript files to import');
  const entries = Object.entries(files);
  if (entries.length < 1 || entries.length > MAX_FILES || entries.reduce((s, [, code]) => s + String(code).length, 0) > 900000) throw new Error('Import at most 24 files or 900 KB total');
  const normalized = Object.create(null);
  const modules = Object.create(null);
  for (const [rawName, source] of entries) {
    const name = norm(rawName);
    if (!name || !/\.(?:m?js)$/.test(name) || typeof source !== 'string' || !source.trim() || source.length > 150000 || Object.prototype.hasOwnProperty.call(normalized, name)) throw new Error(`Invalid or duplicate JavaScript file: ${rawName}`);
    normalized[name] = source;
  }
  for (const [path, source] of Object.entries(normalized)) {
    let ast;
    try { ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true }); }
    catch (error) {
      throw new Error(`${path}:${error.loc?.line ?? '?'}:${error.loc?.column ?? '?'} — could not parse JavaScript. JSX and TypeScript syntax are not supported by this Acorn importer; use a plain .js/.mjs module or pre-transpile it. ${error.message}`);
    }
    const localFunctions = listJavaScriptFunctions(source);
    const imports = Object.create(null);
    const exported = Object.create(null);
    for (const item of ast.body) {
      if (item.type === 'ExportDefaultDeclaration') {
        const decl = item.declaration;
        if (decl?.type === 'FunctionDeclaration' || decl?.type === 'FunctionExpression' || decl?.type === 'ArrowFunctionExpression') exported.default = decl.id?.name || 'default';
        else if (decl?.type === 'Identifier') exported.default = decl.name;
      }
      if (item.type === 'ExportNamedDeclaration') {
        if (item.declaration?.type === 'FunctionDeclaration' && item.declaration.id) exported[item.declaration.id.name] = item.declaration.id.name;
        if (item.declaration?.type === 'VariableDeclaration') {
          for (const d of item.declaration.declarations) if (d.id?.type === 'Identifier') exported[d.id.name] = d.id.name;
        }
        for (const spec of item.specifiers || []) if (spec.local && spec.exported) exported[spec.exported.name] = spec.local.name;
      }
    }
    for (const declaration of ast.body.filter(item => item.type === 'ImportDeclaration')) {
      const target = resolveModulePath(path, declaration.source.value, normalized);
      for (const item of declaration.specifiers) {
        if (item.type === 'ImportNamespaceSpecifier') continue;
        imports[item.local.name] = { path: target, imported: item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported.name, request: declaration.source.value };
      }
    }
    modules[path] = { source, localFunctions, imports, exported };
  }
  return { files: normalized, modules };
}
export function resolveFunction(workspace, filePath, callee) {
  const module = workspace.modules[filePath];
  if (!module) return null;
  const local = module.localFunctions.find(f => f.name === callee);
  if (local) return { path: filePath, name: local.name, index: local.index, parameters: local.parameters };
  const imported = module.imports[callee];
  if (imported?.path) {
    const target = workspace.modules[imported.path];
    const resolvedName = target?.exported[imported.imported];
    const candidate = resolvedName && target.localFunctions.find(f => f.name === resolvedName);
    if (candidate) return { path: imported.path, name: candidate.name, index: candidate.index, parameters: candidate.parameters };
  }
  return null;
}

/** Interpret a referenced helper using the same bounded AST subset. Only
 * functions from files explicitly supplied by the user can be called.
 * The returned object distinguishes a verified null/undefined from UNKNOWN.
 */
export function interpretSafeCallee(workspace, ref, args, depth = 0, visited = new Set(), budget = { steps: 0, max: 4000 }) {
  if (!ref || depth >= 6) return { value: null, verified: false, reason: 'Missing helper or call-depth limit' };
  const key = `${ref.path}::${ref.name}`;
  if (visited.has(key)) return { value: null, verified: false, reason: 'Recursion is not simulated' };
  const entry = workspace.modules[ref.path];
  if (!entry) return { value: null, verified: false, reason: 'Helper source not selected' };
  try {
    const ast = parse(entry.source, { ecmaVersion: 2022, sourceType: 'module', locations: true });
    const all = [];
    for (const part of ast.body) {
      const decl = ['ExportNamedDeclaration','ExportDefaultDeclaration'].includes(part.type) ? part.declaration : part;
      if (!decl) continue;
      if (decl.type === 'FunctionDeclaration') all.push({ name: decl.id?.name || 'default', fn: decl });
      if (decl.type === 'VariableDeclaration') for (const item of decl.declarations) if (item.id.type === 'Identifier' && ['ArrowFunctionExpression','FunctionExpression'].includes(item.init?.type)) all.push({name:item.id.name,fn:item.init});
      if (['FunctionExpression','ArrowFunctionExpression'].includes(decl.type)) all.push({name:decl.id?.name || 'default',fn:decl});
    }
    const fn = all.find(item => item.name === ref.name)?.fn;
    if (!fn || fn.async || fn.generator || fn.params.length !== args.length || fn.params.some(p => p.type !== 'Identifier')) throw Error('Unsupported helper signature');
    const env = Object.create(null);
    fn.params.forEach((param, index) => { env[param.name] = args[index]; });
    const stack = new Set(visited); stack.add(key);
    const expression = node => evaluateRestricted(node, env, (name, params) => {
      const target = resolveFunction(workspace, ref.path, name);
      const result = interpretSafeCallee(workspace, target, params, depth + 1, stack, budget);
      if (!result.verified) throw Error(`${name}(): ${result.reason}`);
      return result.value;
    }, budget);
    const run = statements => {
      for (const statement of statements) {
        if (++budget.steps > budget.max) throw Error('Helper execution limit');
        if (statement.type === 'VariableDeclaration') {
          for (const d of statement.declarations) {
            if (d.id.type !== 'Identifier') throw Error('Unsupported destructuring declaration');
            env[d.id.name] = d.init ? expression(d.init) : undefined;
          }
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
          const a = statement.expression;
          if (a.operator !== '=') throw Error('Unsupported compound assignment in helper');
          const rhs = expression(a.right);
          if (a.left.type === 'Identifier') env[a.left.name] = rhs;
          else {
            const path = getMemberPath(a.left);
            if (!path) throw Error('Unsupported helper property assignment');
            env[path.root] = updateMember(env[path.root], path.parts, rhs);
          }
        } else if (statement.type === 'IfStatement') {
          const condition = expression(statement.test);
          const chosen = condition ? statement.consequent : statement.alternate;
          if (chosen) { const result = run(chosen.type === 'BlockStatement' ? chosen.body : [chosen]); if (result.returned) return result; }
        } else if (statement.type === 'ReturnStatement') return { returned: true, value: statement.argument ? expression(statement.argument) : undefined };
        else if (statement.type === 'BlockStatement') { const result = run(statement.body); if (result.returned) return result; }
        else if (statement.type !== 'EmptyStatement') throw Error(`Unsupported helper statement ${statement.type}`);
      }
      return { returned: false, value: undefined };
    };
    const value = fn.body.type === 'BlockStatement' ? run(fn.body.body).value : expression(fn.body);
    return { value, verified: true };
  } catch (error) { return { value: null, verified: false, reason: error.message }; }
}

/** Interpret an expression AST, never compile or run uploaded source. */
export function evaluateWorkspaceAst(workspace, filePath, ast, environment, budget = { steps: 0, max: 4000 }) {
  try {
    const value = evaluateRestricted(ast, environment, (name, args) => {
      const ref = resolveFunction(workspace, filePath, name);
      const outcome = interpretSafeCallee(workspace, ref, args, 0, new Set(), budget);
      if (!outcome.verified) throw Error(`${name}(): ${outcome.reason}`);
      return outcome.value;
    }, budget);
    return { value, verified: true };
  } catch (error) { return { value: null, verified: false, reason: error.message }; }
}

export function evaluateWorkspaceExpression(workspace, filePath, source, environment) {
  try {
    if (!source || source.length > 2000) throw Error('Invalid expression length');
    const ast = parseExpressionAt(source, 0, { ecmaVersion: 2022 });
    if (source.slice(ast.end).trim()) throw Error('Extra tokens after expression');
    return evaluateWorkspaceAst(workspace, filePath, ast, environment);
  } catch (error) { return { value: null, verified: false, reason: error.message }; }
}
