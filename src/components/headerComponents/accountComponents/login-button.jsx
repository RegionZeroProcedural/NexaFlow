import React from 'react';
/** Optional authentication UI for a future authenticated Nexora workspace. */
export default function LoginButton({ onClick, disabled = false }) { return <button type="button" className="header-secondary" disabled={disabled || !onClick} onClick={onClick}>Log in</button>; }
