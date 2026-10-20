import React from 'react';
import ChildIcon from './childComponents/child-icon';
import ChildLabel from './childComponents/child-label';
export default function MenuChild({ icon, children, shortcut }) {
  return <><ChildIcon name={icon}/><ChildLabel>{children}</ChildLabel>{shortcut && <kbd>{shortcut}</kbd>}</>;
}
