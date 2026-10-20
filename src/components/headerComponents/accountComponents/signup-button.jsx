import React from 'react';
/** Optional authentication UI; never shown until actual sign-up is implemented. */
export default function SignupButton({ onClick, disabled = false }) { return <button type="button" className="primary-button" disabled={disabled || !onClick} onClick={onClick}>Sign up</button>; }
