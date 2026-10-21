import { operatorsExampleGraph } from '../data/operators-example';
import { getNodePorts, getFunctionDataInputs, isValidGraph, DATA_OPERATORS, createNode, portPosition } from '../data/node-types';
import { simulateControlFlow } from './simulate-control-flow';
import { prepareWaterfallRun } from './waterfall';
import { findNearbyPort } from './connection-utils';
import { generateCode } from './generate-code';

const copy = value => JSON.parse(JSON.stringify(value));

test('EXEC TRUE evaluates operator values, passes them to Function, and DONE reports completion', () => {
  expect(isValidGraph(operatorsExampleGraph)).toBe(true);
  const result = simulateControlFlow(operatorsExampleGraph);
  expect(result.portValues['op-multiply:out']).toBe(70);
  expect(result.portValues['op-function:out1']).toBe(77);
  expect(result.portValues['op-function:done']).toBe(true);
  expect(result.conditions['op-conditional']).toBe(true);
  expect(result.trace.map(step => step.nodeId)).toContain('op-success');
  expect(result.functionCompletions).toHaveLength(1);
  const timeline = prepareWaterfallRun(operatorsExampleGraph, result);
  expect(timeline.trace.some(s => s.type === 'function-completion')).toBe(true);
  expect(timeline.waterfallSamples.map(s => s.value)).toEqual(expect.arrayContaining([77, true]));
  expect(timeline.trace.findIndex(s => s.type === 'function-completion'))
    .toBeLessThan(timeline.trace.findIndex(s => s.type === 'watch-sample' && s.title === 'Waterfall: DONE'));
});

test('EXEC FALSE never runs the Function and DONE stays FALSE', () => {
  const graph = copy(operatorsExampleGraph);
  graph.nodes.find(n => n.id === 'op-trigger').value = false;
  const result = simulateControlFlow(graph);
  expect(result.portValues['op-function:done']).toBe(false);
  expect(result.portValues['op-function:out1']).toBe(null);
  expect(result.functionCompletions).toHaveLength(0);
  expect(result.trace.map(step => step.nodeId)).toContain('op-failure');
});

test('an unsafe unsupported function never executes and cannot set DONE TRUE', () => {
  const graph = copy(operatorsExampleGraph);
  graph.nodes.find(n => n.id === 'op-function').code = 'out1 = fetch("http://example.org")';
  const result = simulateControlFlow(graph);
  expect(result.portValues['op-function:done']).toBe(false);
  expect(result.issues.join(' ')).toMatch(/unsupported|unknown/i);
});

test('Function uses independent control and data ports, including for code export', () => {
  const node = operatorsExampleGraph.nodes.find(n => n.id === 'op-function');
  expect(getNodePorts(node).inputs.find(p => p.id === 'execute').kind).toBe('boolean');
  expect(getNodePorts(node).outputs.find(p => p.id === 'done').kind).toBe('boolean');
  expect(getFunctionDataInputs(node)).toHaveLength(2);
  for (const lang of ['javascript', 'typescript', 'python']) {
    const code = generateCode(operatorsExampleGraph, lang);
    expect(code).toContain('invoke_function');
    expect(code).toContain('data_operator');
    expect(code).toContain('done');
  }
});

test('eight typed operator nodes support data transformation', () => {
  expect(DATA_OPERATORS).toHaveLength(8);
  for (const type of DATA_OPERATORS) {
    const node = createNode(type);
    expect(getNodePorts(node).inputs.length).toBe(type === 'negate' ? 1 : 2);
    expect(getNodePorts(node).outputs).toHaveLength(1);
  }
});

test('canvas connection hitbox works without relying on pointerup DOM event target', () => {
  const fn = operatorsExampleGraph.nodes.find(n => n.id === 'op-function');
  const exec = portPosition(fn, 'execute', 'in');
  const candidate = findNearbyPort(operatorsExampleGraph.nodes, exec.x - 2, exec.y - 2, { left: 0, top: 0 }, { x: 0, y: 0 }, 1, 'out');
  expect(candidate).toMatchObject({ nodeId: 'op-function', portId: 'execute', direction: 'in' });
  // At 2x zoom the same screen point maps to a different graph location.
  const transformed = findNearbyPort(operatorsExampleGraph.nodes, exec.x - 2, exec.y - 2, { left: 0, top: 0 }, { x: 0, y: 0 }, 2, 'out');
  expect(transformed).toBeNull();
});

test('Function Watch records each internal variable revision before DONE, with provenance', () => {
  const graph = copy(operatorsExampleGraph);
  graph.nodes.find(n => n.id === 'op-function').code = [
    'subtotal = in1',
    'subtotal = subtotal + 5',
    'out1 = subtotal',
    'out1 = out1 + 2',
    'out2 = out1 >= 75',
  ].join('\n');
  const sim = simulateControlFlow(graph);
  const replay = prepareWaterfallRun(graph, sim);
  expect(sim.functionChanges).toHaveLength(5);
  const entries = replay.waterfallSamples.filter(s => s.watchId === 'op-total-watch');
  expect(entries.map(e => e.value)).toEqual([70, 75, 75, 77, true]);
  expect(entries[1]).toMatchObject({ previousValue: 70, value: 75, sourceLine: 2 });
  expect(sim.functionChanges[1].dependencyEvents).toContain(sim.functionChanges[0].id);
  expect(replay.trace[entries[1].step - 2].type).toBe('function-assignment');
  const doneIndex = replay.trace.findIndex(e => e.type === 'function-completion');
  expect(doneIndex).toBeGreaterThan(entries[entries.length - 1].step - 1);
  expect(doneIndex).toBeLessThan(replay.trace.findIndex(e => e.type === 'watch-sample' && e.title === 'Waterfall: DONE'));
});

test('Watch supports connected-output and internal-local filters', () => {
  const graph = copy(operatorsExampleGraph);
  graph.nodes.find(n => n.id === 'op-function').code = 'subtotal = in1\nsubtotal = subtotal + 5\nout1 = subtotal\nout1 = out1 + 2\nout2 = false';
  const watch = graph.nodes.find(n => n.id === 'op-total-watch');
  watch.traceVariable = 'port';
  expect(prepareWaterfallRun(graph, simulateControlFlow(graph)).waterfallSamples.filter(e => e.watchId === watch.id).map(e => e.value)).toEqual([75, 77]);
  watch.traceVariable = 'named';
  watch.traceVariableName = 'subtotal';
  expect(isValidGraph(graph)).toBe(true);
  expect(prepareWaterfallRun(graph, simulateControlFlow(graph)).waterfallSamples.filter(e => e.watchId === watch.id).map(e => e.value)).toEqual([70, 75]);
});

test('An input can be rebound locally without mutating its connected upstream Variable', () => {
  const graph = copy(operatorsExampleGraph);
  graph.nodes.find(n => n.id === 'op-function').code = 'in1 = in1 + 3\nout1 = in1\nout2 = true';
  const sim = simulateControlFlow(graph);
  expect(sim.portValues['op-function:out1']).toBe(73);
  expect(sim.portValues['op-multiply:out']).toBe(70);
  expect(sim.functionChanges[0].variable).toBe('in1');
  const visible = prepareWaterfallRun(graph, sim).waterfallSamples.filter(s => s.watchId === 'op-total-watch');
  expect(visible[0]).toMatchObject({ value: 73, sourceLine: 1 });
});
