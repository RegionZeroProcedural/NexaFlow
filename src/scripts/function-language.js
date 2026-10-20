/**
 * Small, explicit expression language shared by the simulator and JS/TS/Python
 * exporters. User snippets are parsed, never eval'd or dynamically imported.
 * This is NOT an arbitrary-language transpiler. Unsupported syntax is an error.
 */
const MAX_STATEMENTS = 100;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TOKEN = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(===|!==|==|!=|>=|<=|&&|\|\||\*\*|[()+\-*/%<>!^])|([A-Za-z_$][A-Za-z0-9_$]*))/gy;

function tokenize(source) {
  if (source.length > 2000) throw new Error('An expression exceeds 2,000 characters');
  const result = [];
  let index = 0;
  while (index < source.length) {
    if (!source.slice(index).trim()) break;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`Unsupported syntax at “${source.slice(index, index + 18)}”`);
    result.push(match[1] || match[2] || match[3] || match[4]);
    if (result.length > 250) throw new Error('Expression has too many tokens');
    index = TOKEN.lastIndex;
  }
  return result;
}

export function parseExpression(source, allowedNames = []) {
  const tokens = tokenize(source);
  const allowed = new Set(allowedNames);
  let i = 0;
  const peek = () => tokens[i];
  const match = (...args) => { if (args.includes(peek())) { i++; return true; } return false; };
  const primary = () => {
    if (match('(')) { const expression = parseOr(); if (!match(')')) throw new Error('Unclosed parenthesis'); return expression; }
    const word = tokens[i++];
    if (word === undefined) throw new Error('Missing operand');
    if (/^(true|false|True|False)$/.test(word)) return { type: 'literal', value: word.toLowerCase() === 'true' };
    if (/^(None|null)$/.test(word)) return { type: 'literal', value: null };
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(word)) return { type: 'literal', value: Number(word) };
    if (/^['"]/.test(word)) {
      try {
        // Only simple quoted string literals; never treat source as JavaScript.
        let contents = word.slice(1, -1).replace(/\\(['"\\nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
        return { type: 'literal', value: contents };
      } catch (_) { throw new Error('Invalid string literal'); }
    }
    if (IDENTIFIER.test(word) && allowed.has(word)) return { type: 'identifier', name: word };
    throw new Error(`Unknown identifier or unsupported call “${word}”`);
  };
  const unary = () => match('!', 'not') ? { type: 'not', value: unary() } : match('-') ? { type: 'neg', value: unary() } : primary();
  const power = () => { let x = unary(); if (match('**')) x = { type: 'binary', op: '**', left: x, right: power() }; return x; };
  const mult = () => { let x = power(); while (['*', '/', '%'].includes(peek())) { const op = tokens[i++]; x = { type: 'binary', op, left: x, right: power() }; } return x; };
  const add = () => { let x = mult(); while (['+', '-'].includes(peek())) { const op = tokens[i++]; x = { type: 'binary', op, left: x, right: mult() }; } return x; };
  const compare = () => { let x = add(); while (['>', '>=', '<', '<=', '==', '===', '!=', '!=='].includes(peek())) { const op = tokens[i++]; x = { type: 'binary', op, left: x, right: add() }; } return x; };
  const and = () => { let x = compare(); while (match('&&', 'and')) x = { type: 'binary', op: 'and', left: x, right: compare() }; return x; };
  const xor = () => { let x = and(); while (match('^')) x = { type: 'binary', op: 'xor', left: x, right: and() }; return x; };
  const parseOr = () => { let x = xor(); while (match('||', 'or')) x = { type: 'binary', op: 'or', left: x, right: xor() }; return x; };
  const result = parseOr();
  if (i !== tokens.length) throw new Error(`Unexpected token “${peek()}”`);
  return result;
}

/** Function editor accepts a body of assignments, not an arbitrary script.
 * Local variables can be used in later statements. All declared outN names
 * are always available. Optional const/let/var are normalized away.
 */
export function parseFunctionBody(code, inputCount, outputCount) {
  const inputs = Array.from({ length: inputCount }, (_, i) => `in${i + 1}`);
  const outputs = Array.from({ length: outputCount }, (_, i) => `out${i + 1}`);
  const names = new Set([...inputs, ...outputs]);
  const statements = [];
  const lines = String(code || '').split(/\r?\n/);
  if (lines.length > MAX_STATEMENTS) throw new Error(`Limit: ${MAX_STATEMENTS} lines`);
  lines.forEach((source, i) => {
    const line = source.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) return;
    const withoutTerminator = line.replace(/;\s*$/, '');
    const match = /^(?:(?:const|let|var)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.+?)\s*$/.exec(withoutTerminator);
    if (!match) throw new Error(`Line ${i + 1}: use “variable = expression” (no loops/calls)`);
    const [, name, rhs] = match;
    // Input names may be rebound INSIDE the function (as in JS/Python). That
    // never modifies a connected Variable node upstream: arguments are values.
    if (/^out\d+$/.test(name) && !outputs.includes(name)) throw new Error(`Line ${i + 1}: ${name} has no output port`);
    if (!names.has(name) && !IDENTIFIER.test(name)) throw new Error(`Line ${i + 1}: invalid variable name`);
    if (['function', 'def', 'return', 'while', 'for', 'if', 'import', 'eval', 'class', '__proto__', 'prototype', 'constructor', 'arguments', 'NaN', 'Infinity'].includes(name)) throw new Error(`Line ${i + 1}: reserved name`);
    let expression;
    try { expression = parseExpression(rhs, [...names]); }
    catch (error) { throw new Error(`Line ${i + 1}: ${error.message}`); }
    statements.push({ name, expression, local: !names.has(name), line: i + 1 });
    names.add(name);
  });
  if (statements.length > MAX_STATEMENTS) throw new Error('Too many assignments');
  return { inputs, outputs, statements };
}

export function valueType(value) {
  return value === null || value === undefined ? 'unknown' : typeof value;
}
export function coercesToType(value, type) {
  return value == null || type === 'any' || typeof value === type;
}

/** Deterministic, pure evaluator; unknown/unconnected ports => null. */
export function evaluateExpression(ast, env) {
  if (ast.type === 'literal') return ast.value;
  if (ast.type === 'identifier') return env[ast.name] ?? null;
  if (ast.type === 'not') { const v = evaluateExpression(ast.value, env); return typeof v === 'boolean' ? !v : null; }
  if (ast.type === 'neg') { const v = evaluateExpression(ast.value, env); return typeof v === 'number' ? -v : null; }
  if (ast.type !== 'binary') return null;
  const a = evaluateExpression(ast.left, env), b = evaluateExpression(ast.right, env);
  if (ast.op === 'and') return a === false || b === false ? false : a === true && b === true ? true : null;
  if (ast.op === 'or') return a === true || b === true ? true : a === false && b === false ? false : null;
  if (ast.op === 'xor') return typeof a === 'boolean' && typeof b === 'boolean' ? a !== b : null;
  if (a === null || b === null) return null;
  if (['==', '==='].includes(ast.op)) return a === b;
  if (['!=', '!=='].includes(ast.op)) return a !== b;
  if (['>', '>=', '<', '<='].includes(ast.op)) {
    if (!(typeof a === typeof b && (typeof a === 'number' || typeof a === 'string'))) return null;
    return ast.op === '>' ? a > b : ast.op === '>=' ? a >= b : ast.op === '<' ? a < b : a <= b;
  }
  if (ast.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  let result = null;
  switch (ast.op) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '*': result = a * b; break;
    case '/': result = b !== 0 ? a / b : null; break;
    case '%': result = b !== 0 ? a % b : null; break;
    case '**': result = a ** b; break;
    default: break;
  }
  return typeof result === 'number' && !Number.isFinite(result) ? null : result;
}

/** Evaluates safe assignments in order, retaining *every* variable revision.
 * The snapshots are plain data. They allow downstream Watch nodes to replay
 * intermediate changes without ever running untrusted JavaScript/Python.
 */
export function evaluateFunctionBodyWithTrace(parsed, args, outputTypes = {}) {
  const environment = Object.fromEntries(parsed.inputs.map(key => [key, args[key] ?? null]));
  parsed.outputs.forEach(name => { environment[name] = null; });
  const changes = [];
  for (const statement of parsed.statements) {
    const previousValue = environment[statement.name] ?? null;
    const value = evaluateExpression(statement.expression, environment);
    environment[statement.name] = value;
    changes.push({
      variable: statement.name, value, previousValue,
      line: statement.line,
      // Immutable snapshots: later assignments cannot corrupt earlier frames.
      variables: { ...environment },
      outputs: Object.fromEntries(parsed.outputs.map(key => [key, environment[key]])),
    });
  }
  const outputs = Object.fromEntries(parsed.outputs.map(name => [name,
    coercesToType(environment[name], outputTypes[name] || 'any') ? environment[name] : null]));
  return { outputs, changes };
}

export function evaluateFunctionBody(parsed, args, outputTypes = {}) {
  return evaluateFunctionBodyWithTrace(parsed, args, outputTypes).outputs;
}

/** Translate this explicit subset, not arbitrary foreign code. */
export function emitExpression(ast, language) {
  const py = language === 'python';
  if (ast.type === 'literal') return ast.value === null ? (py ? 'None' : 'null') : typeof ast.value === 'boolean' ? (py ? (ast.value ? 'True' : 'False') : String(ast.value)) : JSON.stringify(ast.value);
  if (ast.type === 'identifier') return ast.name;
  if (ast.type === 'not') return `tri_not(${emitExpression(ast.value, language)})`;
  if (ast.type === 'neg') return `(-${emitExpression(ast.value, language)})`;
  const a = emitExpression(ast.left, language), b = emitExpression(ast.right, language);
  const fn = { and: 'tri_and', or: 'tri_or', xor: 'tri_xor' }[ast.op];
  if (fn) return `${fn}(${a}, ${b})`;
  const op = ['==', '==='].includes(ast.op) ? (py ? '==' : '===') : ['!=', '!=='].includes(ast.op) ? (py ? '!=' : '!==') : ast.op;
  return `(${a} ${op} ${b})`;
}

export function makeFunctionName(node) {
  const name = String(node.functionName || node.title || 'function').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^\d/, '_$&').replace(/^_+/, '') || 'function';
  return `flow_fn_${name}_${String(node.id).replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function emitFunctionDeclaration(node, language, inputCount, outputCount) {
  const parsed = parseFunctionBody(node.code, inputCount, outputCount);
  const py = language === 'python', ts = language === 'typescript';
  const name = makeFunctionName(node);
  const typeOf = key => (node.portTypes || {})[key] || 'any';
  const tsType = key => ({ number: 'number | null', string: 'string | null', boolean: 'boolean | null', any: 'any' })[typeOf(key)];
  const args = parsed.inputs.map(key => ts ? `${key}: ${tsType(key)}` : key).join(', ');
  const lines = [`${py ? 'def' : 'function'} ${name}(${args})${py ? ':' : ' {'}`];
  const pad = py ? '    ' : '  ';
  if (parsed.inputs.length) {
    const unknownOutputs = py ? `{${parsed.outputs.map(key => `${JSON.stringify(key)}: None`).join(', ')}}` : `{ ${parsed.outputs.map(key => `${key}: null`).join(', ')} }`;
    const missing = parsed.inputs.map(key => py ? `${key} is None` : `${key} == null`).join(py ? ' or ' : ' || ');
    lines.push(`${pad}${py ? 'if ' : 'if ('}${missing}${py ? ':' : ')'}${py ? ` return ${unknownOutputs}` : ` return ${unknownOutputs};`}`);
  }
  parsed.outputs.forEach(key => lines.push(py ? `${pad}${key} = None` : `${pad}let ${key}${ts ? ': any' : ''} = null;`));
  const localNames = new Set();
  parsed.statements.forEach(item => {
    const expression = emitExpression(item.expression, language);
    if (py) lines.push(`${pad}${item.name} = ${expression}`);
    else {
      const declaration = item.local && !localNames.has(item.name) ? 'let ' : '';
      lines.push(`${pad}${declaration}${item.name} = ${expression};`);
    }
    if (item.local) localNames.add(item.name);
  });
  if (py) lines.push(`${pad}return {${parsed.outputs.map(key => `${JSON.stringify(key)}: ${key}`).join(', ')}}`);
  else lines.push(`${pad}return { ${parsed.outputs.join(', ')} };`, '}');
  if (!parsed.outputs.length && !parsed.statements.length && py) lines.push(`${pad}pass`);
  return { name, source: lines.join('\n'), parsed };
}
