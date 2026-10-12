import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const Admin = lazy(() => import('./Admin.jsx'));
const isAdmin = /^\/admin(?:\/|$)/.test(location.pathname);

createRoot(document.getElementById('root')).render(<React.StrictMode><Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>正在加载管理后台…</div>}>{isAdmin ? <Admin /> : <App />}</Suspense></React.StrictMode>);
