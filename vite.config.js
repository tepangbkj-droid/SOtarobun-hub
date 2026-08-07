import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ==========================================================================
// PILAR KEAMANAN #1 — MINIFIKASI / OBFUSCATION AGRESIF
// Vite secara default sudah minify pakai esbuild (cepat, tapi ringan).
// Di sini kita paksa pakai Terser dengan opsi paling agresif: nama variabel
// di-mangle habis (termasuk top-level & properti aman), semua console.*,
// debugger, dan komentar dibuang dari bundle produksi. Ini BUKAN enkripsi
// sungguhan (JS yang jalan di browser selalu bisa dibaca ulang oleh yang
// niat), tapi jauh lebih sulit dibaca/ditelusuri dibanding source asli.
// ==========================================================================
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2018',
    minify: 'terser',
    sourcemap: false,
    cssMinify: true,
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        passes: 3,
        pure_funcs: ['console.log', 'console.info', 'console.debug'],
      },
      mangle: {
        toplevel: true,
        safari10: true,
      },
      format: {
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        // Nama file chunk/asset diacak (hash), bukan nama fungsi/komponen asli,
        // supaya struktur kode tidak mudah ditebak dari nama file di Network tab.
        entryFileNames: 'assets/[hash].js',
        chunkFileNames: 'assets/[hash].js',
        assetFileNames: 'assets/[hash][extname]',
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    // Hanya untuk `npm run dev` lokal; tidak berlaku di build produksi.
    port: 5173,
  },
});
