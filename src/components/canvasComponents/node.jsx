import React from 'react';
import { showValue } from '../node-config';
import Icon from '../icon';
import { NODE_TYPES, DATA_OPERATORS, getNodeHeight, getNodePorts, canConnectPorts } from '../../data/node-types';
import BooleanNode from './nodeType/boolean';
import ConditionalNode from './nodeType/conditional';
import CommentNode from './nodeType/comment';
import LogicAnd from './nodeType/logic-and';
import LogicOr from './nodeType/logic-or';
import LogicNand from './nodeType/logic-nand';
import LogicNor from './nodeType/logic-nor';
import LogicXor from './nodeType/logic-xor';
import LogicXnor from './nodeType/logic-xnor';
import LogicNot from './nodeType/logic-not';

const GATES = { and: LogicAnd, or: LogicOr, not: LogicNot, nand: LogicNand, nor: LogicNor, xor: LogicXor, xnor: LogicXnor };

export default function CanvasNode({ node, selected, active, visited, value, condition, onSelect, onDragBegin, onPortBegin, connectionAnchor, hoverTarget, onToggle, onDoubleClick, functionDone = false }) {
  const meta = NODE_TYPES[node.type];
  const ports = getNodePorts(node);
  const Gate = GATES[node.type];
  const portAppearance = (port, direction) => {
    if (!connectionAnchor) return '';
    if (connectionAnchor.nodeId === node.id && connectionAnchor.portId === port.id && connectionAnchor.direction === direction) return 'port-anchor';
    if (connectionAnchor.direction === direction || connectionAnchor.nodeId === node.id) return 'port-unavailable';
    // The pending connector stores the endpoint definition, not a wire.
    const from = connectionAnchor.portMeta;
    const matches = from ? (direction === 'in' ? canConnectPorts(from, port) : canConnectPorts(port, from)) : true;
    return matches ? 'port-compatible' : 'port-unavailable';
  };
  const activatePortKey = (e, portId, direction) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    onPortBegin({ ...e, button: 0, pointerId: undefined, stopPropagation: () => e.stopPropagation(), preventDefault: () => e.preventDefault() }, node.id, portId, direction);
  };
  return <div data-node-id={node.id} className={`canvas-node node-${node.type} shape-${['custom', 'function'].includes(node.type) ? (node.shape || 'rounded') : 'rounded'} ${selected ? 'selected' : ''} ${active ? 'executing' : ''} ${visited ? 'visited' : ''}`} style={{ left: node.x, top: node.y, width: meta.width, height: getNodeHeight(node), '--node-accent': meta.accent }} onPointerDown={e => { if (e.button !== 0 || e.target.closest('[data-port-direction], button, input, textarea')) return; e.stopPropagation(); onSelect(node.id); onDragBegin(e, node); }} onDoubleClick={e => { e.stopPropagation(); onDoubleClick(node.id); }}>
    {node.type === 'comment' ? <><div className="node-heading note-heading"><Icon name="note" size={17}/><span className="node-title">{node.title}</span></div><CommentNode node={node}/></> : <>
      <div className="node-heading"><span className="node-type-icon"><Icon name={meta.icon} size={16}/></span><div className="node-heading-text"><span className="node-type-name">{meta.label.toUpperCase()}</span><strong className="node-title" title={node.title}>{node.title}</strong></div>{visited && <Icon className="node-visited-icon" name="check" size={14}/>}</div>
      {['custom', 'function'].includes(node.type) ? <div className="custom-node-body"><span className="custom-lang">{node.language || 'javascript'}</span><code title={node.code}>{(node.code || '').split('\n')[0] || '// Write a function body'}</code><small>{ports.inputs.length - 1} data inputs → {ports.outputs.length - 1} data outputs · {node.shape || 'rounded'}</small><small className={functionDone ? 'function-done-true' : 'function-done-false'}>EXEC → DONE: {functionDone ? 'TRUE ✓' : 'FALSE'}</small></div> : node.type.startsWith('source-') ? <div className="custom-node-body"><span className="custom-lang">{node.sourceLine ? `SOURCE LINE ${node.sourceLine}` : 'FUNCTION'}</span><code title={node.expressionText || node.unsupportedReason || ''}>{node.expressionText || node.unsupportedReason || node.description}</code><small>{node.type === 'source-opaque' ? '⚠ Preserved · Not simulated' : node.type === 'source-decision' ? 'TRUE / FALSE branches' : 'Source linked • editable expression'}</small></div> : ['watch', 'assert'].includes(node.type) ? <div className="output-body"><span className="large-status">{node.check || 'range'}</span><small>{node.type === 'assert' ? 'Validate input' : 'Track data provenance'}</small></div> : node.type === 'variable' ? <div className="output-body"><span className="large-status value-status">{showValue(value)}</span><small>{node.dataType || 'number'} · variable</small></div> : DATA_OPERATORS.includes(node.type) ? <div className="output-body"><span className="large-status">{showValue(value)}</span><small>{node.type.toUpperCase()} · operator result</small></div> : node.type === 'compare' ? <div className="output-body"><span className="large-status">A {node.comparison || '=='} B</span><small>Result: {showValue(value)}</small></div> : node.type === 'boolean' ? <BooleanNode node={node} onToggle={() => onToggle(node.id)}/> : node.type === 'conditional' ? <ConditionalNode condition={condition} inputCount={node.inputCount || 1} mode={node.conditionMode || 'and'}/> : Gate ? <Gate value={value} inputCount={ports.inputs.length}/> : node.type === 'output' ? <div className="output-body"><span className={`large-status ${value === null ? 'unknown' : value === false ? 'false' : 'true'}`}>{showValue(value)}</span><small>Live input value</small></div> : <div className="simple-node-body"><span className="simple-node-description">{node.description}</span><span className="node-arrow-decor"><Icon name={node.type === 'end' ? 'check' : 'arrowRight'} size={15}/></span></div>}
    </>}
    {ports.inputs.map(p => <div key={p.id} role="button" tabIndex={0} aria-label={`Connect input ${p.label} on ${node.title}`} data-port-node={node.id} data-port-id={p.id} data-port-direction="in" className={`node-port input-port ${portAppearance(p, 'in')} ${hoverTarget?.nodeId === node.id && hoverTarget?.portId === p.id && hoverTarget?.direction === 'in' ? 'port-hover-target' : ''}`} style={{ top: p.top }} title={`${p.label} · ${p.flowCompatible ? 'Boolean or NEXT control signal' : p.dataType || p.kind} input`} onPointerDown={e => onPortBegin(e, node.id, p.id, 'in')} onKeyDown={e => activatePortKey(e, p.id, 'in')}><span className={`port-knob ${p.kind}${p.flowCompatible ? ' flow-compatible' : ''}`}/><span className="port-label">{p.label}</span></div>)}
    {ports.outputs.map(p => <div key={p.id} role="button" tabIndex={0} aria-label={`Connect output ${p.label} on ${node.title}`} data-port-node={node.id} data-port-id={p.id} data-port-direction="out" className={`node-port output-port ${portAppearance(p, 'out')} ${hoverTarget?.nodeId === node.id && hoverTarget?.portId === p.id && hoverTarget?.direction === 'out' ? 'port-hover-target' : ''}`} style={{ top: p.top }} title={`${p.label} · ${p.flowCompatible ? 'Boolean or NEXT control signal' : p.dataType || p.kind} output`} onPointerDown={e => onPortBegin(e, node.id, p.id, 'out')} onKeyDown={e => activatePortKey(e, p.id, 'out')}><span className="port-label">{p.label}</span><span className={`port-knob ${p.kind}${p.flowCompatible ? ' flow-compatible' : ''}`}/></div>)}
  </div>;
}
