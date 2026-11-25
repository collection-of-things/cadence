import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  // portless injects PORT; fall back to Vite's usual port when run directly.
  server: { port: Number(process.env.PORT) || 5173, strictPort: true },
});
