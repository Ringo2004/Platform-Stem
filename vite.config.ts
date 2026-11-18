import { defineConfig } from 'vite';

// base relativa: il sito funziona sia su https://<utente>.github.io/<repo>/ sia in locale,
// e la navigazione tra le sezioni usa l'hash (#/esplora) quindi non servono riscritture lato server.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200
  }
});
