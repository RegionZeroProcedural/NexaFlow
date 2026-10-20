export const exampleGraph = {
  name: 'Order approval flow',
  nodes: [
    { id: 's1', type: 'start', x: 36, y: 216, title: 'Incoming order', description: 'Entry point for each new order' },
    { id: 'd1', type: 'conditional', x: 310, y: 216, title: 'Payment verified?', description: 'Route by payment status' },
    { id: 'p2', type: 'process', x: 608, y: 75, title: 'Fulfill order', description: 'Prepare and dispatch package' },
    { id: 'p3', type: 'process', x: 608, y: 345, title: 'Request payment', description: 'Send customer a reminder' },
    { id: 'e1', type: 'end', x: 877, y: 75, title: 'Completed', description: 'Order fulfilled successfully' },
    { id: 'e2', type: 'end', x: 877, y: 345, title: 'On hold', description: 'Waiting on customer payment' },
    { id: 'b1', type: 'boolean', x: 43, y: 425, title: 'Payment received', description: 'Change this switch, then run again', value: true },
    { id: 'o1', type: 'watch', x: 333, y: 467, title: 'Payment signal', description: 'Watch captures each simulation reading', check: 'type', min: 0, max: 100, expected: 'true', expectedType: 'boolean' },
    { id: 'n1', type: 'comment', x: 38, y: 28, title: 'ORDER ROUTING · DEMO', description: 'Flip the payment switch and press Run to see the path change.' },
  ],
  edges: [
    { id: 'l1', source: 's1', sourcePort: 'out', target: 'd1', targetPort: 'in' },
    { id: 'l3', source: 'b1', sourcePort: 'out', target: 'd1', targetPort: 'condition' },
    { id: 'l4', source: 'd1', sourcePort: 'true', target: 'p2', targetPort: 'in' },
    { id: 'l5', source: 'd1', sourcePort: 'false', target: 'p3', targetPort: 'in' },
    { id: 'l6', source: 'p2', sourcePort: 'out', target: 'e1', targetPort: 'in' },
    { id: 'l7', source: 'p3', sourcePort: 'out', target: 'e2', targetPort: 'in' },
    { id: 'l8', source: 'b1', sourcePort: 'out', target: 'o1', targetPort: 'in' },
  ],
};
