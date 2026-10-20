/** Safe, deliberately constrained Boolean expression interpreter.
 * No eval, Function, WASM, subprocesses, network I/O, or arbitrary user code.
 * Language selection documents the original syntax; we support common boolean
 * operators from Python (and/or/not) and C-family languages (&&/||/!).
 * Each non-comment line MUST be an assignment: out1 = in1 && in2;
 */
const tokenPattern = /\s*(===|!==|==|!=|&&|\|\||[()!^=]|\b(?:and|or|not|true|false)\b|[A-Za-z_][A-Za-z_0-9]*)/gy;
const tokenize = (source) => {
  if (source.length > 2000) throw new Error('An expression exceeds the 2,000 character limit');
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    if (/^\s*$/.test(source.slice(offset))) break;
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(source);
    if (!match) throw new Error(`Unsupported syntax near “${source.slice(offset, offset + 16)}”`);
    tokens.push(match[1]);
    if (tokens.length > 200) throw new Error('Expression contains too many tokens');
    offset = tokenPattern.lastIndex;
  }
  return tokens;
};

export function parseBooleanExpression(source) {
  const tokens = tokenize(source);
  let i = 0;
  const at = () => tokens[i];
  const match = (...keys) => { if (keys.includes(at())) { i++; return true; } return false; };
  const primary = () => {
    if (match('(')) { const body = or(); if (!match(')')) throw new Error('Missing closing parenthesis'); return body; }
    const word = at();
    if (word === undefined) throw new Error('Missing operand');
    if (/^(?:true|false)$/i.test(word)) { i++; return { type: 'literal', value: word.toLowerCase() === 'true' }; }
    if (/^in(?:[1-9]|1[0-6])$/.test(word)) { i++; return { type: 'input', key: word }; }
    throw new Error(`Unknown input “${word}” (expected in1…in16)`);
  };
  const unary = () => match('!', 'not') ? { type: 'not', item: unary() } : primary();
  const eq = () => { let a = unary(); while (['==', '===', '!=', '!=='].includes(at())) { const kind = tokens[i++]; a = { type: kind.startsWith('!') ? 'ne' : 'eq', left: a, right: unary() }; } return a; };
  const and = () => { let a = eq(); while (match('&&', 'and')) a = { type: 'and', left: a, right: eq() }; return a; };
  const xor = () => { let a = and(); while (match('^')) a = { type: 'xor', left: a, right: and() }; return a; };
  const or = () => { let a = xor(); while (match('||', 'or')) a = { type: 'or', left: a, right: xor() }; return a; };
  const ast = or();
  if (i < tokens.length) throw new Error(`Unexpected token “${at()}”`);
  return ast;
}

export function triGate(type, inputs) {
  if (!inputs.length) return null;
  if (type === 'and' || type === 'nand') {
    const value = inputs.includes(false) ? false : inputs.every(v => v === true) ? true : null;
    return value === null ? null : type === 'nand' ? !value : value;
  }
  if (type === 'or' || type === 'nor') {
    const value = inputs.includes(true) ? true : inputs.every(v => v === false) ? false : null;
    return value === null ? null : type === 'nor' ? !value : value;
  }
  if (type === 'xor' || type === 'xnor') {
    const value = inputs.includes(null) ? null : inputs.filter(Boolean).length % 2 === 1;
    return value === null ? null : type === 'xnor' ? !value : value;
  }
  return null;
}

export function evalBooleanExpression(ast, inputs) {
  switch (ast.type) {
    case 'literal': return ast.value;
    case 'input': return inputs[ast.key] ?? null;
    case 'not': { const v = evalBooleanExpression(ast.item, inputs); return v === null ? null : !v; }
    case 'and': case 'or': case 'xor': return triGate(ast.type, [evalBooleanExpression(ast.left, inputs), evalBooleanExpression(ast.right, inputs)]);
    case 'eq': case 'ne': {
      const a = evalBooleanExpression(ast.left, inputs), b = evalBooleanExpression(ast.right, inputs);
      return a === null || b === null ? null : ast.type === 'eq' ? a === b : a !== b;
    }
    default: return null;
  }
}

export function parseCustomCode(code, outputCount) {
  const assignments = {};
  const lines = String(code || '').split(/\r?\n/);
  if (lines.length > 100) throw new Error('Custom code exceeds 100 lines');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const match = /^(out(?:[1-9]|1[0-6]))\s*=\s*(.+?);?$/.exec(line);
    if (!match) throw new Error(`Line ${i + 1}: expected “out1 = Boolean expression”`);
    const index = Number(match[1].slice(3));
    if (index > outputCount) throw new Error(`Line ${i + 1}: ${match[1]} does not exist — add an output port`);
    if (assignments[match[1]]) throw new Error(`Line ${i + 1}: duplicate assignment to ${match[1]}`);
    // Optional terminal semicolon allowed in C-family languages.
    assignments[match[1]] = parseBooleanExpression(match[2].replace(/;\s*$/, ''));
  }
  return assignments;
}
