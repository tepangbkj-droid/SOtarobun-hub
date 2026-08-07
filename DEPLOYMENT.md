# Panduan Deploy — Tarobun SO Mandiri Hub

## 0. Sebelum mulai — file yang HARUS Anda pindahkan sendiri
Saya tidak punya akses ke file-file ini dari project lama Anda (tidak ada di upload), jadi
salin manual dari project lama ke folder `public/` di project baru ini:
- `manifest.json`
- `icon-192.png`, `icon-512.png`
- `sw.js` (service worker)

Semua file di `public/` otomatis ikut ter-copy ke root hasil build oleh Vite.

## 1. Install & build frontend
```bash
npm install
npm run dev      # coba dulu di localhost, pastikan tampilan & fitur sama seperti sebelumnya
npm run build     # hasil akhir ada di folder dist/
```

## 2. Deploy frontend ke Cloudflare Pages
Cara termudah (tanpa hubungkan Git dulu):
```bash
npm install -g wrangler   # kalau belum ada
npx wrangler pages deploy dist --project-name=tarobun-hub
```
Ikuti instruksi di terminal (pilih/buat project). Setelah selesai, Anda dapat URL seperti
`https://tarobun-hub.pages.dev` — ini yang jadi origin Anda.

**Alternatif (disarankan untuk jangka panjang):** hubungkan repo GitHub Anda ke Cloudflare
Pages lewat dashboard (Workers & Pages > Create > Pages > Connect to Git), set Build command
`npm run build`, Build output directory `dist`. Setiap `git push` otomatis ter-deploy.

*(GitHub Pages TIDAK disarankan di sini karena Worker Anda memakai Cookie
`SameSite=None; Secure` lintas-origin — ini butuh HTTPS yang konsisten dan domain yang stabil,
yang lebih mudah diatur lewat Cloudflare Pages daripada GitHub Pages.)*

## 3. Set domain final & sinkronkan CORS
1. Setelah tahu domain final Anda (mis. `https://tarobun-hub.pages.dev` atau domain custom),
   buka `wrangler.toml` → ganti nilai `ALLOWED_ORIGIN` dengan domain itu persis (tanpa `/` di akhir).
2. Buka `index.html` → ganti domain di baris `connect-src` pada meta CSP kalau domain Worker
   Anda berbeda dari `tarobun-api.tepangbkj8.workers.dev`.
3. Build ulang & deploy ulang frontend (`npm run build` lalu `npx wrangler pages deploy dist ...`).

## 4. Deploy Worker (backend)
```bash
npx wrangler login                 # sekali saja, buka browser untuk otorisasi
npx wrangler secret put JWT_SECRET
npx wrangler secret put FCM_CLIENT_EMAIL
npx wrangler secret put FCM_PRIVATE_KEY
npx wrangler secret put FCM_PROJECT_ID
npx wrangler deploy
```
Sebelum `deploy`, pastikan di `wrangler.toml`:
- `database_id` di `[[d1_databases]]` sudah diisi ID D1 database Anda yang sudah ada
  (cek dengan `npx wrangler d1 list`).
- `bucket_name` R2 sudah cocok dengan bucket Anda (cek `npx wrangler r2 bucket list`).
- `ALLOWED_ORIGIN` sudah diisi domain frontend Anda (langkah 3).

## 5. Checklist Dashboard Cloudflare (WAF & Bot Fight Mode)
Berlaku untuk **domain custom** (bukan subdomain `*.pages.dev` / `*.workers.dev` gratisan —
keduanya tidak bisa diatur WAF custom rules per-zone karena bukan zone Anda sendiri). Kalau
Anda pakai domain custom yang sudah terhubung ke Cloudflare:

1. **Blokir IP luar Indonesia (WAF Custom Rule):**
   - Dashboard → pilih domain Anda → **Security** → **WAF** → tab **Custom rules** → **Create rule**.
   - Nama rule: `Blokir Luar Indonesia`.
   - Field: **Country** (bukan "IP Source Address") → Operator: **is not in** → pilih **Indonesia**.
   - Action: **Block**.
   - Klik **Deploy**.
   - *(Opsional lebih aman: pakai action **Managed Challenge** dulu, bukan langsung **Block**,
     supaya Anda/tim yang kebetulan sedang di luar negeri tidak langsung terkunci total.)*

2. **Bot Fight Mode:**
   - Dashboard → domain Anda → **Security** → **Bots**.
   - Aktifkan toggle **Bot Fight Mode** (gratis) atau **Super Bot Fight Mode** (kalau plan
     Anda Pro/Business ke atas, lebih granular).

3. **Kalau masih pakai `*.pages.dev`/`*.workers.dev` (belum ada domain custom):**
   WAF Custom Rules per-negara di atas TIDAK tersedia. Sebagai gantinya, lakukan pembatasan
   negara **di dalam Worker Anda sendiri** memakai header `request.cf.country` (Cloudflare
   otomatis menyediakan ini di setiap request, gratis, tanpa perlu WAF berbayar) — beri tahu
   saya kalau Anda mau saya tambahkan blok kode ini ke `worker/index.js`.

## 6. Uji ulang setelah deploy
- Login sebagai admin & sebagai toko — pastikan cookie sesi tersimpan (cek DevTools →
  Application → Cookies → cari `session`, harus ada flag `HttpOnly` & `Secure`).
- Coba akses endpoint Worker langsung dari domain LAIN (mis. lewat `fetch()` di console tab
  browser yang beda origin) — harus ditolak CORS.
- Coba login dengan password salah 5x berturut-turut — harus terkunci sementara (anti brute-force
  sudah ada di `worker/index.js`, tidak perlu ditambah).
