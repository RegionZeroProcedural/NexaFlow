import React from 'react';
import ProfilePicture from './accountComponents/profile-picture';
import Username from './accountComponents/username';
export default function AccountArea() { return <div className="account-area" title="Projects are saved in this browser. No account is connected."><div className="local-status-dot"/><Username name="Local workspace"/><ProfilePicture/></div>; }
