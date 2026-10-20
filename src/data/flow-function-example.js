/** v0.7: sequencing wires are interchangeable with Function EXEC/DONE.
 * The numeric values still use separate typed data connections. */
export const flowFunctionExample = {
  name: 'NEXT ↔ EXEC / DONE sequence',
  nodes: [
    { id: 'seq-start', type: 'start', x: 35, y: 90, title: 'Start checkout', description: 'NEXT sends an execution token to EXEC' },
    { id: 'seq-a', type: 'function', x: 350, y: 70, title: 'Calculate subtotal', description: 'Receives NEXT at EXEC', triggerMode: 'signal', functionName: 'subtotal', language: 'javascript', shape: 'rounded', inputCount: 2, outputCount: 1, portTypes: { in1: 'number', in2: 'number', out1: 'number' }, code: 'subtotal = in1 + in2\nout1 = subtotal' },
    { id: 'seq-middle', type: 'process', x: 725, y: 70, title: 'Continue to tax', description: 'DONE connects to a standard flow input' },
    { id: 'seq-b', type: 'function', x: 1010, y: 70, title: 'Double subtotal', description: 'The Process NEXT triggers this Function', triggerMode: 'signal', functionName: 'doubleSubtotal', language: 'javascript', shape: 'rounded', inputCount: 1, outputCount: 1, portTypes: { in1: 'number', out1: 'number' }, code: 'out1 = in1 * 2' },
    { id: 'seq-end', type: 'end', x: 1360, y: 70, title: 'Finished', description: 'Reached only when DONE becomes true' },
    { id: 'seq-price', type: 'variable', x: 50, y: 385, title: 'Price', description: 'Numeric input', dataType: 'number', dataValue: 40 },
    { id: 'seq-fee', type: 'variable', x: 50, y: 630, title: 'Fee', description: 'Numeric input', dataType: 'number', dataValue: 5 },
    { id: 'seq-a-watch', type: 'watch', x: 735, y: 385, title: 'Watch subtotal', description: 'Observe Function A local assignments', check: 'range', min: 0, max: 100, expected: 'true', expectedType: 'number' },
    { id: 'seq-b-watch', type: 'watch', x: 1350, y: 425, title: 'Watch DONE', description: 'Observe the finishing Boolean', check: 'type', min: 0, max: 100, expected: 'true', expectedType: 'boolean' },
    { id: 'seq-note', type: 'comment', x: 30, y: 900, title: 'SEQUENCING VS DATA', description: 'Green/purple flow: Start NEXT → Function EXEC; Function DONE → Process Flow; Process NEXT → Function EXEC; Function DONE → End Flow. Separate cyan wires transfer numbers through the Watch node. Both Functions must successfully finish before the End step is reached.' },
  ],
  edges: [
    { id: 'seq-e1', source: 'seq-start', sourcePort: 'out', target: 'seq-a', targetPort: 'execute' },
    { id: 'seq-e2', source: 'seq-a', sourcePort: 'done', target: 'seq-middle', targetPort: 'in' },
    { id: 'seq-e3', source: 'seq-middle', sourcePort: 'out', target: 'seq-b', targetPort: 'execute' },
    { id: 'seq-e4', source: 'seq-b', sourcePort: 'done', target: 'seq-end', targetPort: 'in' },
    { id: 'seq-e5', source: 'seq-price', sourcePort: 'out', target: 'seq-a', targetPort: 'in1' },
    { id: 'seq-e6', source: 'seq-fee', sourcePort: 'out', target: 'seq-a', targetPort: 'in2' },
    { id: 'seq-e7', source: 'seq-a', sourcePort: 'out1', target: 'seq-a-watch', targetPort: 'in' },
    { id: 'seq-e8', source: 'seq-a-watch', sourcePort: 'out', target: 'seq-b', targetPort: 'in1' },
    { id: 'seq-e9', source: 'seq-b', sourcePort: 'done', target: 'seq-b-watch', targetPort: 'in' },
  ],
};
