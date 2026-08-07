# Tarobun SO Mandiri Hub — Vite Migration (Fase 1)

## Cara pakai

```bash
npm install
npm run dev        # http://localhost:5173, pakai .env.development
npm run build       # hasil ke /dist, pakai .env.production
npm run preview      # preview hasil build produksi secara lokal
npm run deploy       # build lalu publish /dist ke branch gh-pages
```

## Apa yang SUDAH dipindahkan otomatis dari index.html lama

- Seluruh kode React (~9000 baris) → `src/App.jsx`, sudah diverifikasi valid secara
  sintaks (esbuild) sebagai modul ES + JSX asli (bukan lagi ditranspile Babel di browser).
- `WORKER_BASE` sekarang membaca dari `import.meta.env.VITE_WORKER_BASE` (lihat
  `.env.development` / `.env.production`), bukan di-hardcode.
- CSS custom (`<style>` inline) → `src/index.css`.
- Konfigurasi warna/font/shadow Tailwind → `tailwind.config.js`.
- Font (`@fontsource/inter`, `@fontsource/plus-jakarta-sans`) → paket NPM, di-import di
  `src/main.jsx`, tidak lagi memuat dari unpkg.com saat runtime.
- Ikon `lucide` → paket NPM asli. Karena kode lama memanggil `window.lucide.createIcons()`
  di puluhan tempat (bukan komponen `<Icon/>` React), `src/main.jsx` sengaja menyediakan
  ulang `window.lucide` sebagai shim tipis di atas paket NPM — **supaya semua pemanggilan
  lama tetap jalan tanpa perlu diedit satu per satu**. Ini valid & aman, bukan workaround
  sementara.
- `React.Fragment`, `React.useRef`, `React.Component`, dsb (dipakai sebagai namespace,
  bukan destructuring) tetap berfungsi karena `src/main.jsx`/`src/App.jsx` meng-import
  `React` sebagai default import.
- CSP di `index.html` sudah diperketat: domain `unpkg.com` dan `cdn.tailwindcss.com`
  dihapus dari whitelist (sudah tidak dipakai lagi), dan `'unsafe-eval'` juga dihapus
  (dulu wajib ada untuk Babel Standalone yang transform JSX di browser).

## Yang PERLU kamu lakukan manual

1. **Aset statis** — salin `manifest.json`, `icon-512.png`, `icon-192.png`, dan `sw.js`
   dari repo GitHub Pages lama kamu ke folder `public/` di sini (file-file itu tidak ada
   di upload sebelumnya, jadi tidak ikut otomatis dipindahkan).
2. **`.env.production`** — ganti `VITE_WORKER_BASE` dengan domain Worker asli kamu
   (lihat Fase 2: custom domain Cloudflare). Sampai domain itu siap, boleh tetap pakai
   URL `*.workers.dev`.
3. **Review `src/App.jsx` sekali** — migrasi ini memindahkan kode APA ADANYA (fungsional
   1:1, tidak dipecah lagi per-komponen ke file terpisah) supaya risiko rusak akibat
   pemecahan otomatis serendah mungkin. Kalau nanti kamu mau memecahnya lebih lanjut
   (mis. `AdminPanel.jsx`, `StoreApp.jsx` terpisah), lakukan bertahap per-komponen sambil
   di-test, bukan sekaligus.
4. **`npm install` lalu `npm run build`** di mesin/CI kamu sendiri untuk konfirmasi akhir
   — saya sudah memvalidasi sintaks JSX-nya lewat esbuild secara offline, tapi belum bisa
   menjalankan `npm install` sungguhan (perlu akses ke registry NPM) dari sandbox ini.
