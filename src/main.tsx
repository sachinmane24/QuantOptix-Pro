import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Client-side crash logging
window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled Rejection]');
  if (event.reason instanceof Error) {
    console.error('Rejection Message:', event.reason.message || String(event.reason) || 'No message provided');
    console.error('Rejection Stack:', event.reason.stack || 'No stack provided');
    console.log('Full Error Object:', event.reason);
  } else {
    try {
      console.error('Rejection Data:', JSON.stringify(event.reason));
    } catch (e) {
      console.error('Rejection Data (raw):', event.reason);
    }
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
