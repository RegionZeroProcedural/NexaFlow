import React from 'react';
import ToolIcon from './toolComponents/icon';
export default function Tool({ icon, title, active, disabled, onClick, children }) { return <button type="button" className={`tool-button ${active ? 'active' : ''}`} aria-label={title} title={title} onClick={onClick} disabled={disabled}><ToolIcon name={icon}/>{children}</button>; }
