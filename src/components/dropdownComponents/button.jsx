import React from 'react';
import MenuChild from '../headerComponents/menuComponents/menu-child';
export default function DropdownButton({ icon, children, shortcut, onClick, danger = false }) {
  return <button type="button" className={`dropdown-item ${danger ? 'danger' : ''}`} onClick={onClick}><MenuChild icon={icon} shortcut={shortcut}>{children}</MenuChild></button>;
}
