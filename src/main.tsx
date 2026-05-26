import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Client-side crash logging
window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error);
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
