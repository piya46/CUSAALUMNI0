import React from 'react';
import ReactDOM from 'react-dom/client';
import { legalPageForPath } from './models/legal';
import './styles.css';
import './theme.css';

const App = React.lazy(() => import('./views/App'));
const LegalPage = React.lazy(() => import('./views/Legal'));
const Install = React.lazy(() => import('./views/Install'));
const WaitingRoom = React.lazy(() => import('./views/WaitingRoom'));
const ServiceEnrollment = React.lazy(() => import('./views/ServiceEnrollment'));
const Consent = React.lazy(() => import('./views/Consent'));

// Legal documents are public, even when authentication or the database is unavailable.
const legalPage = legalPageForPath(window.location.pathname);
const installPage = /^\/install\/?$/i.test(window.location.pathname);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><React.Suspense fallback={<p role="status">กำลังโหลด CUSA SSO…</p>}>{legalPage ? <LegalPage kind={legalPage} /> : installPage ? <Install /> : window.location.pathname==='/service-enrollment' ? <ServiceEnrollment/> : window.location.pathname==='/consent' ? <Consent/> : window.location.pathname==='/waiting' ? <WaitingRoom/> : <App />}</React.Suspense></React.StrictMode>);
