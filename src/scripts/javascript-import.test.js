import { importJavaScriptFunction, exportImportedJavaScript } from './javascript-import';
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

test('unsupported calls remain verbatim and cannot execute', () => {
  const source = 'function example(x) { const y = x + 1; unsafeCall(y); return y; }';
  const graph = importJavaScriptFunction(source);
  expect(graph.nodes.some(n => n.type === 'source-opaque')).toBe(true);
  expect(exportImportedJavaScript(graph)).toBe(source);
  graph.program.inputValues = { x: 20 };
  const result = simulateImportedProgram(graph);
  expect(result.issues.join(' ')).toMatch(/Stopped before unsupported/);
  expect(result.environment.$return).toBeUndefined();
});

test('source export rejects rewiring, non-portable edits, and structural mutations', () => {
  const graph = importJavaScriptFunction(original);
  graph.nodes.find(n => n.statementKind === 'assign').expressionText = 'fetch("http://example.com")';
  expect(() => exportImportedJavaScript(graph)).toThrow();
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
