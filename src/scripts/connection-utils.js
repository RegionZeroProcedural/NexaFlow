import { canConnectPorts, getNodePorts, portPosition } from '../data/node-types';

/** Normalize any pair of attachment points to the graph's output -> input edge.
 * Users may begin a connection from either side. */
export function orderPortPair(first, second) {
  if (!first || !second || first.nodeId === second.nodeId || first.direction === second.direction) return null;
  return first.direction === 'out'
    ? { source: first.nodeId, sourcePort: first.portId, target: second.nodeId, targetPort: second.portId }
    : { source: second.nodeId, sourcePort: second.portId, target: first.nodeId, targetPort: first.portId };
}

/** Hit-test canvas ports in *screen-space* (a constant usable hit area at any zoom).
 * The nearest compatible opposite-direction port takes precedence; an incompatible
 * one is still returned if there is no compatible choice so the UI can explain why.
 * Pointer targeting doesn't depend on nested spans or the DOM's pointer capture. */
export function findNearbyPort(nodes, clientX, clientY, bounds, pan, zoom, oppositeOf, radius = 34, origin = null) {
  if (!bounds || !zoom) return null;
  const mouseX = clientX - bounds.left;
  const mouseY = clientY - bounds.top;
  const direction = oppositeOf === 'out' ? 'in' : 'out';
  const originNode = origin && nodes.find(n => n.id === origin.nodeId);
  const originPort = originNode && getNodePorts(originNode)[origin.direction === 'out' ? 'outputs' : 'inputs'].find(p => p.id === origin.portId);
  let chosen = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (origin && node.id === origin.nodeId) continue;
    const ports = getNodePorts(node);
    for (const port of ports[direction === 'in' ? 'inputs' : 'outputs']) {
      const pos = portPosition(node, port.id, direction);
      if (!pos) continue;
      const dx = pos.x * zoom + pan.x - mouseX;
      const dy = pos.y * zoom + pan.y - mouseY;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      let compatible = true;
      if (origin) {
        compatible = !!originPort && (origin.direction === 'out' ? canConnectPorts(originPort, port) : canConnectPorts(port, originPort));
      }
      // Prefer a compatible port even when slightly farther away.
      const score = d + (compatible ? 0 : radius * 2);
      if (score < lowest) {
        lowest = score;
        chosen = { nodeId: node.id, portId: port.id, direction, compatible, position: pos };
      }
    }
  }
  return chosen;
}
