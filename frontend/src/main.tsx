import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initInstall } from './lib/install';
import { initTheme } from './pages/Settings';
import './index.css';

initTheme();
initInstall();

// The offline page (see public/sw.js). Only in the real build, so local development is never affected.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); // the app works the same without it
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
