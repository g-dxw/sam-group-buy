import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import GroupBuyHome from './GroupBuyHome.jsx';
import './styles.css';

const Admin = lazy(() => import('./Admin.jsx'));
const isAdmin = /^\/admin(?:\/|$)/.test(location.pathname);
const isBatch = /^\/b\/[^/]+(?:\/|$)/.test(location.pathname);

createRoot(document.getElementById('root')).render(<React.StrictMode><Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>正在加载管理后台…</div>}>{isAdmin ? <Admin /> : isBatch ? <App /> : <GroupBuyHome />}</Suspense></React.StrictMode>);
