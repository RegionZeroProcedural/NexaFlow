import { importJavaScriptFunction, listJavaScriptFunctions, exportImportedJavaScript } from './javascript-import';
import { simulateImportedProgram, traceValueOrigins } from './forensics';
import { isValidGraph } from '../data/node-types';

const original = `// preserve comments
export function calculatePrice(price, quantity, discount) {
  const subtotal = price * quantity;
  const discounted = subtotal - discount;
  const total = discounted * 1.08;
  if (total < 0) { return total; }
  return total;
}`;

test('import, simulate, and losslessly round-trip supported JavaScript', () => {
  const graph = importJavaScriptFunction(original, 'pricing.js');
  expect(isValidGraph(graph)).toBe(true);
  expect(graph.nodes.some(n => n.type === 'source-decision')).toBe(true);
  expect(exportImportedJavaScript(graph)).toBe(original);
  graph.program.inputValues = { price: 20, quantity: 2, discount: 50 };
  graph.program.watchRules = [{ id: 'range', variable: 'total', check: 'range', min: 0, max: 100 }];
  const result = simulateImportedProgram(graph);
  expect(result.environment.$return).toBeCloseTo(-10.8);
  expect(result.assertions).toHaveLength(1);
  const parents = traceValueOrigins(result.events, result.assertions[0].eventId);
  expect(parents.map(e => e.name)).toEqual(expect.arrayContaining(['price', 'quantity', 'subtotal', 'discounted', 'discount', 'total']));
  graph.nodes.find(n => n.variableName === 'discounted').expressionText = 'subtotal - 10';
  expect(exportImportedJavaScript(graph)).toContain('const discounted = subtotal - 10;');
  expect(exportImportedJavaScript(graph)).toContain('// preserve comments');
});

test('unresolved calls remain verbatim, never execute, and cannot change primitive locals', () => {
  const source = 'function example(x) { const y = x + 1; unsafeCall(y); return y; }';
  const graph = importJavaScriptFunction(source);
  expect(graph.nodes.find(n => n.type === 'source-call')).toMatchObject({ calleeName: 'unsafeCall' });
  expect(exportImportedJavaScript(graph)).toBe(source);
  graph.program.inputValues = { x: 20 };
  const result = simulateImportedProgram(graph);
  expect(result.issues.join(' ')).toMatch(/unsafeCall\(\) was not safely interpreted/);
  expect(result.skippedOperations).toBe(1);
  expect(result.approximate).toBe(true);
  // A callee receives a copy of a primitive and cannot reassign the caller's local.
  expect(result.environment.$return).toBe(21);
});

test('unresolved calls invalidate objects and closure-written locals', () => {
  const graph = importJavaScriptFunction('function f(order) { let count = 1; const bump = () => { count = count + 1; }; log(order); bump(); return count; }');
  graph.program.inputValues = { order: { total: 5 } };
  const result = simulateImportedProgram(graph);
  expect(result.unknownNames).toEqual(expect.arrayContaining(['order', 'count']));
  expect(result.environment.$return).toBeNull();
});

test('UNKNOWN values do not short-circuit into verified results', () => {
  const graph = importJavaScriptFunction('function f(x) { let d = external(x); let total = d || 0; let other = d ?? 5; return total; }');
  graph.program.inputValues = { x: 1 };
  const result = simulateImportedProgram(graph);
  expect(result.unknownNames).toEqual(expect.arrayContaining(['d', 'total', 'other']));
  expect(result.environment.$return).toBeNull();
});

test('verified null/undefined are values, missing inputs are UNKNOWN', () => {
  const graph = importJavaScriptFunction('function f(a, b) { let x; let y = null; return y; }');
  graph.program.inputValues = { a: 1 };
  const result = simulateImportedProgram(graph);
  expect(result.environment.x).toBeUndefined();
  expect(result.unknownNames).toEqual(['b']);
  const returned = result.events.find(e => e.name === '$return');
  expect(returned).toMatchObject({ value: null, unknown: false });
});

test('source export rejects rewiring, non-portable edits, and structural mutations', () => {
  const graph = importJavaScriptFunction(original);
  graph.nodes.find(n => n.statementKind === 'assign').expressionText = 'fetch("http://example.com")';
  expect(() => exportImportedJavaScript(graph)).toThrow();
  graph.nodes.find(n => n.statementKind === 'assign').expressionText = '[price].find(p => fetch(p))';
  expect(() => exportImportedJavaScript(graph)).toThrow(/fetch\(\) is not a function defined or imported/);
  graph.nodes.find(n => n.statementKind === 'assign').expressionText = 'price * quantity';
  graph.edges.pop();
  expect(() => exportImportedJavaScript(graph)).toThrow(/structure changed/);
});

test('simulator selects the correct if/else branch without running imported source', () => {
  const graph = importJavaScriptFunction('function choose(value) { let x = 0; if (value > 0) { x = 4; } else { x = 5; } return x; }');
  expect(isValidGraph(graph)).toBe(true);
  graph.program.inputValues = { value: -5 };
  expect(simulateImportedProgram(graph).environment.$return).toBe(5);
  graph.program.inputValues = { value: 1 };
  expect(simulateImportedProgram(graph).environment.$return).toBe(4);
});

test('multiple selectable functions expand to primitive value and operator cards', () => {
  const source = 'export function one(x) { return x+1; }\nexport const two = (price, qty) => { let subtotal = price * qty; return subtotal + 2; };';
  expect(listJavaScriptFunctions(source).map(fn => fn.name)).toEqual(['one', 'two']);
  const graph = importJavaScriptFunction(source, 'multi.js', 1);
  expect(graph.program.functionName).toBe('two');
  expect(graph.nodes.filter(n => n.type === 'source-operator').map(n => n.title)).toEqual(expect.arrayContaining(['MULTIPLY (×)', 'ADD (+)']));
  expect(graph.nodes.some(n => n.type === 'source-value' && n.title === 'price')).toBe(true);
  expect(graph.program.dataEdges.some(e => e.variable === 'input')).toBe(true);
  expect(isValidGraph(graph)).toBe(true);
  graph.program.inputValues = { price: 15, qty: 4 };
  expect(simulateImportedProgram(graph).environment.$return).toBe(62);
  expect(exportImportedJavaScript(graph)).toBe(source);
});

test('skipped unsupported statements taint dependencies but do not block safe independent steps', () => {
  const graph = importJavaScriptFunction('function probe(x) { let y = external(x); let safe = 2 * 3; return y + safe; }');
  const result = simulateImportedProgram(graph);
  expect(result.skippedOperations).toBe(1);
  expect(result.environment.safe).toBe(6);
  expect(result.environment.y).toBeNull();
  expect(result.environment.$return).toBeNull();
  expect(result.trace.map(t => t.type)).toContain('source-return');
});

test('unknown condition skips both sides and continues with flagged uncertainty', () => {
  const graph = importJavaScriptFunction('function probe(x) { let total = 10; if (x.method()) { total = 99; } else { total = 77; } let fixed = 6; return fixed; }');
  const result = simulateImportedProgram(graph);
  expect(result.skippedOperations).toBe(1);
  expect(result.environment.total).toBeNull();
  expect(result.environment.$return).toBe(6);
  expect(result.approximate).toBe(true);
});

test('unsupported return cannot fall through or execute following code', () => {
  const graph = importJavaScriptFunction('function test(x) { return external(x); let y = 19; }');
  const result = simulateImportedProgram(graph);
  expect(result.environment.$return).toBeNull();
  expect(result.events.some(e => e.name === 'y')).toBe(false);
});
