import React from 'react';
import ReactDOM from 'react-dom/client';
import { createIcons, icons } from 'lucide';
import App from './App.jsx';
import './index.css';

// Font, dulu dimuat lewat <link> ke unpkg.com -- sekarang di-bundle sendiri oleh Vite
// dari package NPM @fontsource (self-hosted, tidak lagi bergantung pada CDN pihak ketiga
// saat runtime, dan otomatis ikut di-cache/versioning oleh Vite).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';

// ==========================================
// SHIM UNTUK lucide (dulu CDN global `window.lucide`)
// ==========================================
// App.jsx (dipindah 1:1 dari index.html lama) masih memanggil `window.lucide.createIcons()`
// di puluhan tempat (lihat pola `<i data-lucide="...">` + refresh manual di useEffect).
// Daripada mengedit setiap pemanggilan itu satu per satu (berisiko salah ketik di file
// besar), kita cukup sediakan ulang `window.lucide` di sini memakai paket NPM asli --
// SEMUA pemanggilan lama tetap berjalan tanpa perlu disentuh.
window.lucide = { createIcons: () => createIcons({ icons }) };

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Tangkap error async (Promise) yang tidak ter-handle, dipindah dari index.html lama.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Tarobun App - Promise ditolak tanpa ditangani:', event.reason);
});

// Registrasi Service Worker (fitur offline/push), dipindah dari index.html lama.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.log('SW gagal:', err));
    } catch (err) {
      console.log('SW gagal (sinkron):', err);
    }
  });
}
