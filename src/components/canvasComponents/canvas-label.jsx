import React from 'react';
import Icon from '../icon';
import InlineTitle from '../inline-title';
export default function CanvasLabel({ name, onFit, onRename }) {
  return <div className="canvas-title-overlay"><div className="canvas-eyebrow"><span className="active-little-dot"/> FLOW EDITOR <span className="tiny-divider">/</span> CANVAS 01</div><div className="canvas-title-line"><h1><InlineTitle className="flow-title" value={name || 'Untitled flow'} label="flow title" onCommit={onRename}/></h1><button type="button" title="Fit diagram" onClick={onFit}><Icon name="fit" size={15}/></button></div><p>Connect nodes to design and test your logic.</p></div>;
}
