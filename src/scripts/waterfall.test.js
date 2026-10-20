import { prepareWaterfallRun, visibleWaterfallSamples } from './waterfall';
import { simulateControlFlow } from './simulate-control-flow';
import { importJavaScriptFunction, exportImportedJavaScript } from './javascript-import';
import { variablesExampleGraph } from '../data/variables-example';
import { createNode } from '../data/node-types';

test('connected Watch nodes capture typed values, in replay order', () => {
  const result = prepareWaterfallRun(variablesExampleGraph, simulateControlFlow(variablesExampleGraph));
  expect(result.waterfallSamples).toHaveLength(2);
  expect(result.waterfallSamples.map(s => s.value)).toEqual([77, true]);
  expect(result.waterfallSamples.every(s => s.state === 'passed')).toBe(true);
  expect(result.waterfallSamples.every(s => s.step > 0 && s.step <= result.trace.length)).toBe(true);
  expect(result.trace.some(step => step.type === 'watch-sample')).toBe(true);
  const first = result.waterfallSamples[0].step;
  expect(visibleWaterfallSamples(result.waterfallSamples, first - 1).length).toBe(0);
  expect(visibleWaterfallSamples(result.waterfallSamples, result.trace.length)).toHaveLength(2);
});

test('unconnected Watch node does not claim to have received data', () => {
  const graph = { nodes: [createNode('watch', 100, 100)], edges: [] };
  const result = prepareWaterfallRun(graph, simulateControlFlow(graph));
  expect(result.waterfallSamples).toHaveLength(0);
});

test('failing Watch records observed value and validation failure', () => {
  const graph = {
    nodes: [
      { ...createNode('variable'), id: 'value', title: 'Order value', dataValue: 150 },
      { ...createNode('watch'), id: 'watch', title: 'Limit guard', min: 0, max: 100 },
    ],
    edges: [{ id: 'edge', source: 'value', sourcePort: 'out', target: 'watch', targetPort: 'in' }],
  };
  const result = prepareWaterfallRun(graph, simulateControlFlow(graph));
  expect(result.waterfallSamples).toHaveLength(1);
  expect(result.waterfallSamples[0]).toMatchObject({ value: 150, variable: 'Order value', state: 'failed' });
});

test('imported-source watch rules record each variable version without changing source', () => {
  const source = 'function add(price) { let total = price; total = total + 1; return total; }';
  const graph = importJavaScriptFunction(source);
  graph.program.inputValues = { price: 25 };
  graph.program.watchRules = [{ id: 'total-watch', variable: 'total', check: 'range', min: 0, max: 100 }];
  const result = prepareWaterfallRun(graph, simulateControlFlow(graph));
  expect(result.waterfallSamples.map(sample => sample.value)).toEqual([25, 26]);
  expect(result.waterfallSamples[1].previousValue).toBe(25);
  expect(result.waterfallSamples[0].step).toBeLessThan(result.waterfallSamples[1].step);
  expect(exportImportedJavaScript(graph)).toBe(source);
});
