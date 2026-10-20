import React from 'react';
export default function BooleanNode({ node, onToggle }) {
  return <div className="switch-body"><span className="switch-status"><span className={`state-dot ${node.value ? 'yes' : 'no'}`}/>{node.value ? 'TRUE' : 'FALSE'}<small>Input signal</small></span><button type="button" aria-label={`Set ${node.title} to ${node.value ? 'false' : 'true'}`} aria-pressed={node.value === true} className={`toggle-switch ${node.value ? 'on' : ''}`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(); }}><span/></button></div>;
}
