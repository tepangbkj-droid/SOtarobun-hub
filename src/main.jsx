import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

// Font di-bundle lewat npm (@fontsource), pengganti <link> CDN unpkg lama.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';

import './index.css';

// CATATAN: React.StrictMode SENGAJA TIDAK dipakai di sini. App ini punya banyak
// useEffect dengan efek samping nyata (heartbeat presence, polling chat, timer
// auto-logout) yang ditulis untuk mode non-Strict; StrictMode akan me-render &
// menjalankan efek 2x di development sehingga bisa memicu request/timer ganda.
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

// Registrasi service worker (offline / push notif) — sama seperti versi lama.
// Taruh file sw.js Anda yang lama di folder public/ (lihat PANDUAN DEPLOYMENT).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.log('SW gagal:', err));
    } catch (err) {
      console.log('SW gagal (sinkron):', err);
    }
  });
}
