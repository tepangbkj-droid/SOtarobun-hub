import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Catatan jujur soal "obfuscation": Vite/Terser MEMINIFY (menghapus komentar/spasi,
// memendekkan nama variabel lokal) — ini membuat kode tidak nyaman dibaca manusia dan
// mengecilkan ukuran file, tapi ini BUKAN enkripsi. Siapa pun yang cukup gigih tetap bisa
// membaca JS hasil minifikasi (di-"prettify" lalu dibaca pelan-pelan). Untuk aplikasi
// internal, ini sudah standar & memadai; keamanan SUNGGUHAN tetap harus ada di server
// (lihat worker/index.js — RBAC & validasi ulang di sana, bukan di sini).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false, // jangan publikasikan source map di build produksi
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // buang semua console.log/warn/error dari build produksi
        drop_debugger: true,
        passes: 2,
      },
      mangle: {
        toplevel: true, // pendekkan nama variabel/fungsi top-level juga
      },
      format: {
        comments: false, // buang semua komentar (termasuk komentar berisi catatan internal)
      },
    },
    rollupOptions: {
      output: {
        // Pecah vendor besar (react, lucide-react) ke chunk terpisah supaya cache
        // browser lebih efisien saat hanya kode aplikasi yang berubah.
        manualChunks: {
          vendor: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
