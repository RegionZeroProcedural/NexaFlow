import React from 'react';
import { portPosition, getNodePorts, isControlEdge } from '../../data/node-types';
export function bezierPath(a, b) {
  const distance = Math.abs(b.x - a.x);
  const bend = Math.max(65, Math.min(190, distance * 0.52));
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}
export default function Connectors({ nodes, edges, selection, passedEdges, activeEdge, onSelect, preview }) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return <svg className="edge-layer" aria-label="Node connections" width="4000" height="3000" style={{ overflow: 'visible' }}>
    <defs><linearGradient id="active-flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#9e89fa"/><stop offset="100%" stopColor="#4dd8ba"/></linearGradient></defs>
    {edges.map(edge => {
      const source = byId.get(edge.source), target = byId.get(edge.target);
      if (!source || !target) return null;
      const a = portPosition(source, edge.sourcePort, 'out'), b = portPosition(target, edge.targetPort, 'in');
      if (!a || !b) return null;
      const port = getNodePorts(source).outputs.find(p => p.id === edge.sourcePort);
      const selected = selection?.kind === 'edge' && selection.id === edge.id;
      const visited = passedEdges?.includes(edge.id);
      const className = `connection ${isControlEdge({nodes, edges}, edge) ? 'flow-compatible-connection ' : ''}${port.kind === 'boolean' ? 'boolean-connection' : port.kind === 'data' ? 'data-connection' : ''} ${selected ? 'edge-selected' : ''} ${visited ? 'edge-visited' : ''} ${activeEdge === edge.id ? 'edge-running' : ''}`;
      const d = bezierPath(a, b);
      return <g className={className} key={edge.id}><path className="edge-click-target" d={d} onPointerDown={e => { e.stopPropagation(); onSelect({ kind: 'edge', id: edge.id }); }}/><path className="edge-visible" d={d}/>{visited && <circle cx={b.x} cy={b.y} r="3.5" fill="#61dabb"/>}</g>;
    })}
    {preview && <path className="connection-preview" d={bezierPath(preview.from, preview.to)}/>}
  </svg>;
}
