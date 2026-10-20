import { exampleGraph } from './data/example';
import { simulateControlFlow, wouldCreateCycle } from './scripts/simulate-control-flow';

describe('Nexa Flow logic simulator', () => {
  test('TRUE routes order fulfillment through the Yes branch', () => {
    const result = simulateControlFlow(exampleGraph);
    expect(result.trace.map(step => step.title)).toEqual([
      'Incoming order', 'Payment verified?', 'Fulfill order', 'Completed',
    ]);
    expect(result.values.b1).toBe(true);
    expect(result.values.o1).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('FALSE routes to request payment through the No branch', () => {
    const graph = { ...exampleGraph, nodes: exampleGraph.nodes.map(n => n.id === 'b1' ? { ...n, value: false } : n) };
    const result = simulateControlFlow(graph);
    expect(result.trace.map(step => step.title)).toEqual([
      'Incoming order', 'Payment verified?', 'Request payment', 'On hold',
    ]);
    expect(result.values.o1).toBe(false);
  });

  test('unknown condition stops traversal instead of guessing', () => {
    const graph = { ...exampleGraph, edges: exampleGraph.edges.filter(e => e.targetPort !== 'condition') };
    const result = simulateControlFlow(graph);
    expect(result.trace.map(step => step.title)).toEqual(['Incoming order', 'Payment verified?']);
    expect(result.issues[0]).toMatch(/Boolean input/);
  });

  test('boolean gates support three-state logic', () => {
    const graph = {
      nodes: [
        { id: 'a', type: 'boolean', value: true },
        { id: 'b', type: 'boolean', value: false },
        { id: 'c', type: 'and' },
        { id: 'd', type: 'or' },
        { id: 'e', type: 'xor' },
        { id: 'f', type: 'not' },
      ],
      edges: ['c', 'd', 'e'].flatMap(id => [
        { source: 'a', sourcePort: 'out', target: id, targetPort: 'a' },
        { source: 'b', sourcePort: 'out', target: id, targetPort: 'b' },
      ]).concat([{ source: 'a', sourcePort: 'out', target: 'f', targetPort: 'a' }]),
    };
    const result = simulateControlFlow(graph);
    expect(result.values).toMatchObject({ a: true, b: false, c: false, d: true, e: true, f: false });
    const missingB = { ...graph, edges: graph.edges.filter(e => !(e.target === 'c' && e.targetPort === 'a')) };
    expect(simulateControlFlow(missingB).values.c).toBe(false);
  });

  test('rejects attempted cycles', () => {
    expect(wouldCreateCycle(exampleGraph.edges, 'e1', 's1')).toBe(true);
    expect(wouldCreateCycle(exampleGraph.edges, 's1', 'e1')).toBe(false);
  });
});

// v0.2 behavior — stable ports, multi-arity logic, custom safe parser and exporter
import { createNode, getNodePorts, isValidGraph } from './data/node-types';
import { parseCustomCode } from './scripts/custom-expression';
import { generateCode } from './scripts/generate-code';

describe('Customizable nodes', () => {
  test('a gate supports up to 16 inputs without chained nodes', () => {
    const gate = { ...createNode('and'), id: 'gate', inputCount: 3 };
    const nodes = [
      { ...createNode('boolean'), id: 'one', value: true },
      { ...createNode('boolean'), id: 'two', value: true },
      { ...createNode('boolean'), id: 'three', value: false },
      gate,
    ];
    const edges = ['one', 'two', 'three'].map((source, i) => ({ id: `edge${i}`, source, sourcePort: 'out', target: 'gate', targetPort: ['a', 'b', 'c'][i] }));
    expect(getNodePorts(gate).inputs).toHaveLength(3);
    expect(isValidGraph({ nodes, edges })).toBe(true);
    expect(simulateControlFlow({ nodes, edges }).values.gate).toBe(false);
    expect(getNodePorts({ ...gate, inputCount: 16 }).inputs).toHaveLength(16);
  });

  test('custom multi-output Boolean code propagates through connections', () => {
    const custom = { ...createNode('custom'), id: 'custom', triggerMode: 'auto', outputCount: 2, code: 'out1 = in1 && !in2;\nout2 = in1 or in2' };
    const nodes = [
      { ...createNode('boolean'), id: 'one', value: true },
      { ...createNode('boolean'), id: 'two', value: false },
      custom,
      { ...createNode('output'), id: 'watch' },
    ];
    const edges = [
      { id: 'i1', source: 'one', sourcePort: 'out', target: 'custom', targetPort: 'in1' },
      { id: 'i2', source: 'two', sourcePort: 'out', target: 'custom', targetPort: 'in2' },
      { id: 'w1', source: 'custom', sourcePort: 'out2', target: 'watch', targetPort: 'in' },
    ];
    const result = simulateControlFlow({ nodes, edges });
    expect(result.portValues['custom:out1']).toBe(true);
    expect(result.portValues['custom:out2']).toBe(true);
    expect(result.values.watch).toBe(true);
    expect(isValidGraph({ nodes, edges })).toBe(true);
    expect(isValidGraph({ nodes: nodes.map(n => n.id === 'custom' ? { ...n, outputCount: 1 } : n), edges })).toBe(false);
  });

  test('unknown inputs remain UNKNOWN, and unsafe code is never run', () => {
    expect(() => parseCustomCode('out1 = fetch("bad-site")', 1)).toThrow();
    const graph = { nodes: [{ ...createNode('custom'), id: 'custom', code: 'out1 = in1 && in2' }], edges: [] };
    expect(simulateControlFlow(graph).values.custom).toBe(null);
  });

  test('decision node combines multiple condition ports', () => {
    const graph = { ...exampleGraph,
      nodes: exampleGraph.nodes.concat([{ ...createNode('boolean'), id: 'b2', value: false }]).map(n => n.id === 'd1' ? { ...n, inputCount: 2, conditionMode: 'or' } : n),
      edges: [...exampleGraph.edges, { id: 'cond2', source: 'b2', sourcePort: 'out', target: 'd1', targetPort: 'condition2' }],
    };
    expect(simulateControlFlow(graph).trace[2].title).toBe('Fulfill order');
    const andGraph = { ...graph, nodes: graph.nodes.map(n => n.id === 'd1' ? { ...n, conditionMode: 'and' } : n) };
    expect(simulateControlFlow(andGraph).trace[2].title).toBe('Request payment');
  });

  test('generates JavaScript, TypeScript and Python code skeletons', () => {
    for (const lang of ['javascript', 'typescript', 'python']) {
      const code = generateCode(exampleGraph, lang);
      expect(code).toMatch(/read\(/);
      expect(code).toMatch(/Payment verified/);
      expect(code).toMatch(/tri_and/);
    }
  });
});

// v0.3: first-class functions, numeric/string wiring, and portable source conversion
import { variablesExampleGraph } from './data/variables-example';
import { parseFunctionBody, evaluateFunctionBody } from './scripts/function-language';
import { canConnectPorts } from './data/node-types';

describe('Function nodes and typed data connections (v0.3)', () => {
  test('variables pass numeric values through wires into named Function locals', () => {
    expect(isValidGraph(variablesExampleGraph)).toBe(true);
    const result = simulateControlFlow(variablesExampleGraph);
    expect(result.values['dv-function']).toBe(77);
    expect(result.portValues['dv-function:out2']).toBe(true);
    expect(result.values['dv-monitor']).toBe(77);
    expect(result.values['dv-compare']).toBe(true);
    expect(result.trace.map(item => item.title)).toContain('Free delivery');
    expect(result.issues).toEqual([]);
  });

  test('output port count, node shape and typed interface are configurable', () => {
    const node = { ...createNode('function'), inputCount: 3, outputCount: 2, shape: 'diamond', portTypes: { in1: 'number', in2: 'string', in3: 'boolean', out1: 'number', out2: 'string' } };
    const ports = getNodePorts(node);
    expect(ports.inputs.filter(p => p.id !== 'execute').map(p => p.dataType)).toEqual(['number', 'string', 'boolean']);
    expect(ports.outputs.filter(p => p.id !== 'done').map(p => p.dataType)).toEqual(['number', 'string']);
    expect(ports.inputs.find(p => p.id === 'execute').kind).toBe('boolean');
    expect(ports.outputs.find(p => p.id === 'done').kind).toBe('boolean');
    expect(canConnectPorts(ports.outputs.find(p => p.id === 'out1'), { kind: 'data', dataType: 'string' })).toBe(false);
    expect(canConnectPorts(ports.outputs.find(p => p.id === 'out1'), { kind: 'data', dataType: 'any' })).toBe(true);
  });

  test('Function body can pass strings and intermediate locals between outputs', () => {
    const ast = parseFunctionBody('prefix = in1 + "-"\nout1 = prefix + in2\nout2 = in3 >= 10', 3, 2);
    expect(evaluateFunctionBody(ast, { in1: 'Nexa', in2: 'Flow', in3: 12 })).toEqual({ out1: 'Nexa-Flow', out2: true });
  });

  test('generates genuine function definitions in JS, TS and Python', () => {
    for (const lang of ['javascript', 'typescript', 'python']) {
      const source = generateCode(variablesExampleGraph, lang);
      expect(source).toMatch(/flow_fn_calculateInvoice_dv_function/);
      expect(source).toMatch(/subtotal/);
      expect(source).toMatch(lang === 'python' ? /def flow_fn/ : /function flow_fn/);
      expect(source).toMatch(lang === 'python' ? /return \{"out1": out1/ : /return \{ out1, out2 \}/);
    }
  });

  test('export explicitly fails on unsupported code; no eval occurs', () => {
    const graph = {
      nodes: [{ ...createNode('function'), id: 'unsafe', code: 'out1 = fetch("https://example.com")' }],
      edges: [],
    };
    expect(() => generateCode(graph, 'python')).toThrow(/unsupported|unknown|unexpected/i);
    expect(simulateControlFlow(graph).values.unsafe).toBe(null);
  });

  test('rejects invalid typed wiring during graph import', () => {
    const broken = { ...variablesExampleGraph,
      nodes: variablesExampleGraph.nodes.map(n => n.id === 'dv-price' ? { ...n, dataType: 'string', dataValue: '70' } : n),
    };
    expect(isValidGraph(broken)).toBe(false);
  });
});
