/** Bounded AST interpreter for specifically whitelisted pure JavaScript.
 * No eval/new Function/dynamic import, no invoking methods on user objects,
 * no getters/prototypes, no mutations outside the synthetic interpreter env.
 */
export function safeObject(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);
const asKey = v => typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' && v.length <= 100 ? v : null;
function readOwn(value, key) {
  if (key === null || badKeys.has(key)) throw Error('Unsafe or invalid property name');
  if (value == null) throw Error(`Cannot read ${key} from null/undefined`);
  if (key === 'length' && (typeof value === 'string' || Array.isArray(value) || value instanceof Uint8Array)) return value.length;
  if (typeof value !== 'string' && !Array.isArray(value) && !(value instanceof Uint8Array) && !safeObject(value)) throw Error('Unsupported object shape');
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) throw Error('Property getter/setter not allowed');
    return desc.value;
  }
  return undefined;
}
const requireNumber = n => { if (typeof n !== 'number' || !Number.isFinite(n)) throw Error('Expected finite number'); return n; };
const bounded = n => { if (typeof n === 'number' && !Number.isFinite(n)) throw Error('Non-finite numeric value'); return n; };
const primitive = v => v === null || v === undefined || ['number','boolean','string'].includes(typeof v);
const builtinMethods = new Set(['startsWith','endsWith','includes','toUpperCase','toLowerCase','toString','find','isSafeInteger','isInteger','isArray','from']);
/** Is the AST shape supported? Missing user data can still make it UNKNOWN at runtime. */
export function canAnalyzeExpression(ast, budget = { n: 0 }) {
  if (!ast || ++budget.n > 700) return false;
  const go = x => canAnalyzeExpression(x, budget);
  switch(ast.type) {
    case 'Literal': return ast.regex == null && primitive(ast.value);
    case 'Identifier': return !badKeys.has(ast.name);
    case 'ChainExpression': return go(ast.expression);
    case 'UnaryExpression': return ['!', '-', '+', 'typeof', 'void'].includes(ast.operator) && go(ast.argument);
    case 'BinaryExpression': return ['+','-','*','/','%','**','===','!==','==','!=','>','>=','<','<='].includes(ast.operator) && go(ast.left) && go(ast.right);
    case 'LogicalExpression': return ['&&','||','??'].includes(ast.operator) && go(ast.left) && go(ast.right);
    case 'ConditionalExpression': return go(ast.test) && go(ast.consequent) && go(ast.alternate);
    case 'MemberExpression': return go(ast.object) && (!ast.computed || go(ast.property)) && (ast.computed || ast.property.type === 'Identifier');
    case 'ArrayExpression': return ast.elements.length <= 256 && ast.elements.every(x => x && x.type !== 'SpreadElement' && go(x));
    case 'ObjectExpression': return ast.properties.length <= 128 && ast.properties.every(x => x.type === 'Property' && x.kind === 'init' && !x.method && !x.computed && (x.key.type === 'Identifier' || x.key.type === 'Literal') && go(x.value));
    case 'TemplateLiteral': return ast.expressions.length <= 16 && ast.expressions.every(go);
    case 'ArrowFunctionExpression': return !ast.async && ast.params.length === 1 && ast.params[0].type === 'Identifier' && ast.body.type !== 'BlockStatement' && go(ast.body);
    case 'CallExpression': return !ast.optional && !ast.arguments.some(x => x.type === 'SpreadElement') && ast.arguments.length <= 6 && ast.arguments.every(go) && (ast.callee.type === 'Identifier' || (ast.callee.type === 'MemberExpression' && !ast.callee.computed && ast.callee.property.type === 'Identifier' && builtinMethods.has(ast.callee.property.name) && go(ast.callee.object)));
    default: return false;
  }
}
/** Resolve a member-assignment's root + static paths without evaluating any
 * user functions, getters, or dynamic property expressions. */
export function getMemberPath(ast) {
  const parts = [];
  let cursor = ast;
  while (cursor?.type === 'MemberExpression' && !cursor.optional) {
    if (cursor.computed && cursor.property.type !== 'Literal') return null;
    const key = cursor.computed ? asKey(cursor.property.value) : cursor.property.name;
    if (key === null || badKeys.has(key)) return null;
    parts.unshift(key);
    cursor = cursor.object;
  }
  return cursor?.type === 'Identifier' && parts.length && parts.length <= 5 && !badKeys.has(cursor.name) ? { root: cursor.name, parts } : null;
}
export function updateMember(root, parts, value) {
  if (!safeObject(root) && !Array.isArray(root)) throw Error('Object write requires plain JSON object/array');
  const copy = Array.isArray(root) ? [...root] : { ...root };
  let current = copy, original = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const old = readOwn(original, parts[i]);
    if (!safeObject(old) && !Array.isArray(old)) throw Error('Unsafe nested property write');
    const next = Array.isArray(old) ? [...old] : { ...old };
    current[parts[i]] = next; current = next; original = old;
  }
  const key = parts[parts.length - 1];
  if (badKeys.has(key)) throw Error('Unsafe property write');
  if (Array.isArray(current) && (!/^\d+$/.test(key) || Number(key) > 10000)) throw Error('Unsafe array index');
  current[key] = value;
  return copy;
}
export function evaluateRestricted(ast, environment, invokeNamed, budget = { steps: 0, max: 4000 }) {
  const calc = (node, env = environment) => {
    if (!node || ++budget.steps > budget.max) throw Error('Restricted interpreter step limit');
    switch (node.type) {
      case 'Literal': if (!primitive(node.value)) throw Error('Unsupported literal'); return node.value;
      case 'Identifier': if (node.name === 'undefined') return undefined; if (node.name === 'NaN' || node.name === 'Infinity') throw Error('Nonfinite identifier');
        if (!Object.prototype.hasOwnProperty.call(env, node.name)) throw Error(`Unknown identifier: ${node.name}`);
        return env[node.name];
      case 'ChainExpression': return calc(node.expression, env);
      case 'MemberExpression': {
        const object = calc(node.object, env);
        if (node.optional && object == null) return undefined;
        return readOwn(object, node.computed ? asKey(calc(node.property, env)) : node.property.name);
      }
      case 'UnaryExpression': {
        const arg = calc(node.argument, env);
        if (node.operator === '!') return !arg;
        if (node.operator === 'typeof') return typeof arg;
        if (node.operator === 'void') return undefined;
        if (node.operator === '+') return requireNumber(+arg);
        if (node.operator === '-') return -requireNumber(arg);
        throw Error('Unsupported unary operator');
      }
      case 'BinaryExpression': {
        const a = calc(node.left, env), b = calc(node.right, env);
        switch (node.operator) {
          case '===': return a === b; case '!==': return a !== b;
          case '==': return a == b; case '!=': return a != b;
          case '>': return a > b; case '>=': return a >= b; case '<': return a < b; case '<=': return a <= b;
          case '+': return bounded(a + b);
          case '-': return bounded(requireNumber(a) - requireNumber(b));
          case '*': return bounded(requireNumber(a) * requireNumber(b));
          case '/': return bounded(requireNumber(a) / requireNumber(b));
          case '%': return bounded(requireNumber(a) % requireNumber(b));
          case '**': return bounded(requireNumber(a) ** requireNumber(b));
          default: throw Error(`Unsupported operator ${node.operator}`);
        }
      }
      case 'LogicalExpression': {
        const a = calc(node.left, env);
        if (node.operator === '&&') return a ? calc(node.right, env) : a;
        if (node.operator === '||') return a ? a : calc(node.right, env);
        if (node.operator === '??') return a == null ? calc(node.right, env) : a;
        throw Error('Unsupported logical operator');
      }
      case 'ConditionalExpression': return calc(calc(node.test, env) ? node.consequent : node.alternate, env);
      case 'ArrayExpression': return node.elements.map(item => calc(item, env));
      case 'ObjectExpression': {
        const result = Object.create(null);
        for (const prop of node.properties) {
          const key = prop.key.type === 'Identifier' ? prop.key.name : asKey(prop.key.value);
          if (key === null || badKeys.has(key)) throw Error('Unsafe object key');
          result[key] = calc(prop.value, env);
        }
        return result;
      }
      case 'TemplateLiteral': {
        let out = node.quasis[0].value.cooked || '';
        for (let i = 0; i < node.expressions.length; i++) out += String(calc(node.expressions[i], env)) + (node.quasis[i + 1].value.cooked || '');
        if (out.length > 8000) throw Error('String size limit');
        return out;
      }
      case 'CallExpression': {
        const args = node.arguments;
        if (node.callee.type === 'Identifier') {
          if (!invokeNamed) throw Error(`No isolated resolver for ${node.callee.name}`);
          return invokeNamed(node.callee.name, args.map(x => calc(x, env)));
        }
        if (node.callee.type !== 'MemberExpression' || node.callee.computed) throw Error('Unsupported callable shape');
        const member = node.callee;
        const method = member.property.name;
        if (!builtinMethods.has(method)) throw Error(`Non-whitelisted method ${method}`);
        const name = member.object.type === 'Identifier' ? member.object.name : null;
        if (name === 'Number' && method === 'isSafeInteger') return Number.isSafeInteger(calc(args[0], env));
        if (name === 'Number' && method === 'isInteger') return Number.isInteger(calc(args[0], env));
        if (name === 'Array' && method === 'isArray') return Array.isArray(calc(args[0], env));
        if (name === 'Uint8Array' && method === 'from') {
          const a = calc(args[0], env);
          if (!Array.isArray(a) || a.length > 512 || !a.every(Number.isFinite)) throw Error('Unsafe typed-array conversion');
          return Uint8Array.from(a);
        }
        const receiver = calc(member.object, env);
        if ((node.optional || member.optional) && receiver == null) return undefined;
        if (method === 'find') {
          if (!Array.isArray(receiver) || receiver.length > 512 || args.length !== 1) throw Error('Unsupported find receiver/arguments');
          const fn = args[0];
          if (fn.type !== 'ArrowFunctionExpression' || fn.async || fn.params.length !== 1 || fn.params[0].type !== 'Identifier' || fn.body.type === 'BlockStatement') throw Error('Only pure expression callback supported');
          for (const item of receiver) {
            const local = Object.assign(Object.create(null), env); local[fn.params[0].name] = item;
            if (calc(fn.body, local)) return item;
          }
          return undefined;
        }
        const evaluated = args.map(a => calc(a, env));
        if (typeof receiver === 'string' && ['startsWith','endsWith','includes'].includes(method)) {
          if (evaluated.length !== 1 || typeof evaluated[0] !== 'string') throw Error('String method requires one string');
          return method === 'startsWith' ? receiver.startsWith(evaluated[0]) : method === 'endsWith' ? receiver.endsWith(evaluated[0]) : receiver.includes(evaluated[0]);
        }
        if (typeof receiver === 'string' && ['toUpperCase','toLowerCase'].includes(method) && !evaluated.length) return method === 'toUpperCase' ? receiver.toUpperCase() : receiver.toLowerCase();
        if (typeof receiver === 'number' && method === 'toString' && evaluated.length <= 1) {
          const radix = evaluated.length ? evaluated[0] : 10;
          if (!Number.isInteger(radix) || radix < 2 || radix > 36) throw Error('Invalid radix');
          return receiver.toString(radix);
        }
        if (typeof receiver === 'string' && method === 'toString' && !evaluated.length) return receiver;
        throw Error(`Cannot safely interpret ${method}() on this receiver`);
      }
      default: throw Error(`Unsupported AST ${node.type}`);
    }
  };
  if (!canAnalyzeExpression(ast)) throw Error(`Unsupported expression ${ast.type}`);
  return calc(ast);
}
