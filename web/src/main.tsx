import React from 'react';
import ReactDOM from 'react-dom/client';
import { Home } from './views/Home';
import { legalPageForPath } from './models/legal';
import './styles.css';

const App = React.lazy(() => import('./views/App'));
const LegalPage = React.lazy(() => import('./views/Legal'));
const Install = React.lazy(() => import('./views/Install'));

// Legal documents are public, even when authentication or the database is unavailable.
const legalPage = legalPageForPath(window.location.pathname);
const installPage = /^\/install\/?$/i.test(window.location.pathname);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p role="status">กำลังโหลด CUSA SSO…</p>}>{legalPage ? <LegalPage kind={legalPage} /> : installPage ? <Install /> : window.location.pathname==='/' ? <Home/> : <App />}</React.Suspense></React.StrictMode>);
