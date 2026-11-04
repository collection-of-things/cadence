import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { session } from './app';
import './styles.css';

void session.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
