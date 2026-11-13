import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { trackInputMode } from './inputMode';
import { session } from './session';
// Inter with its optical-size axis: display sizes get the tighter cut.
import '@fontsource-variable/inter/opsz.css';
// Figtree: the lyric display face in Now Playing.
import '@fontsource-variable/figtree';
import './styles.css';
import './motion.css';

// Screenshot/dev seam: lets capture scripts drive the mock session.
(window as unknown as { __cadenceSession?: typeof session }).__cadenceSession = session;

// Frameless window chrome differs per OS (traffic lights vs. overlay controls).
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'mac' : 'other';

trackInputMode();

void session.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
