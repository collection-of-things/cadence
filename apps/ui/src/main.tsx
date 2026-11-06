import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { session } from './session';
import '@fontsource-variable/inter';
import '@fontsource-variable/figtree';
import './styles.css';
import './motion.css';

// Screenshot/dev seam: lets capture scripts drive the mock session.
(window as unknown as { __cadenceSession?: typeof session }).__cadenceSession = session;

// Frameless window chrome differs per OS (traffic lights vs. overlay controls).
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'mac' : 'other';

void session.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
