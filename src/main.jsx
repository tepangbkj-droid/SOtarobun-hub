import React from 'react';
import ReactDOM from 'react-dom/client';

// Font (dulu dimuat lewat <link> ke unpkg di index.html lama; sekarang lewat npm
// package @fontsource supaya build sepenuhnya self-contained/offline dan tidak perlu
// menambahkan domain font ke Content-Security-Policy).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';

import './index.css';
import App from './App.jsx';

// CATATAN: TIDAK dibungkus <React.StrictMode> secara sengaja. App.jsx ini adalah
// migrasi dari kode lama yang beberapa efeknya (mis. inisialisasi chat, listener sesi)
// tidak ditulis untuk aman dipanggil dua kali (perilaku StrictMode di React 18 dev
// mode). Menambah StrictMode berisiko memunculkan bug/duplikasi yang TIDAK ada di
// aplikasi lama. Bisa diaktifkan lagi belakangan setelah efek-efek tsb diaudit.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
