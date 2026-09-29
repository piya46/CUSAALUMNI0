import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './views/App';
import LegalPage from './views/Legal';
import Install from './views/Install';
import { legalPageForPath } from './models/legal';
import './styles.css';

// Legal documents are public, even when authentication or the database is unavailable.
const legalPage = legalPageForPath(window.location.pathname);
const installPage = /^\/install\/?$/i.test(window.location.pathname);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{legalPage ? <LegalPage kind={legalPage} /> : installPage ? <Install /> : <App />}</React.StrictMode>);
