import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Client-side crash logging
window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled Rejection]', event.reason);
  if (event.reason && event.reason.message) {
    console.error('Rejection Message:', event.reason.message);
  }
  if (event.reason && event.reason.stack) {
    console.error('Rejection Stack:', event.reason.stack);
  }
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('CRITICAL: Root element #root not found in the DOM.');
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
