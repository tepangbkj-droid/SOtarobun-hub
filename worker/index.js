// =====================================================================
// TAROBUN API WORKER — pengganti Firebase (Auth + Database + Presence)
// Tempel SELURUH file ini ke Cloudflare Dashboard > Workers > (worker Anda) > Edit Code
// Pastikan sudah bind: D1 database sebagai "DB", R2 bucket sebagai "MEDIA"
// Dan set Secret "JWT_SECRET" (Settings > Variables > Add Secret) — isi bebas, string acak panjang.
//
// === TAMBAHAN OPTIMASI FREE TIER (R2 Class B & D1 Rows Read/Written) ===
// 1) Butuh 1 binding Durable Object baru untuk batching view counter.
//    Tambahkan di wrangler.toml:
//
//      [[durable_objects.bindings]]
//      name = "VIEW_COUNTER"
//      class_name = "ViewCounter"
//
//      [[migrations]]
//      tag = "v1"
//      new_classes = ["ViewCounter"]
//
// 2) Butuh tabel D1 baru untuk menampung hasil batch write view counter:
//
//      CREATE TABLE IF NOT EXISTS view_counters (
//        target TEXT PRIMARY KEY,   -- format: "store:<storeId>" atau "product:<storeId>:<productId>"
//        views INTEGER NOT NULL DEFAULT 0,
//        updated_at INTEGER
//      );
//
// === TAMBAHAN CHAT REAL-TIME (2026-07-20) — HTTP long-polling, BUKAN WebSocket ===
// 3) Butuh 1 binding Durable Object lagi untuk ChatHub (lihat class ChatHub di bawah):
//
//      [[durable_objects.bindings]]
//      name = "CHAT_HUB"
//      class_name = "ChatHub"
//
//      [[migrations]]
//      tag = "v2"
//      new_classes = ["ChatHub"]
//
//    (Kalau sudah pernah pakai migrations tag "v1" untuk ViewCounter/PresenceTracker,
//    pakai tag baru "v2" khusus ChatHub — JANGAN pakai ulang tag yang sama.)
//    TIDAK butuh tabel D1 baru — ChatHub cuma menyimpan versi angka di memori, bukan di D1.
//
// === TAMBAHAN LIMIT 2 DEVICE/TOKO + AUTO-LOGOUT 5 JAM (2026-07-20) — numpang di PresenceTracker ===
// 4) TIDAK butuh binding baru & TIDAK butuh tabel D1 baru. Numpang penuh di Durable Object
//    PresenceTracker yang sudah ada (memori + storage bawaan DO, bukan D1), supaya tetap
//    efisien (tanpa WebSocket, tanpa endpoint polling terpisah — cukup "menumpang" di
//    request heartbeat /api/presence/ping yang memang sudah jalan tiap beberapa detik).
//    Cara kerja singkat (detail lengkap ada di komentar dalam class PresenceTracker):
//      - Client (index.html) membuat & menyimpan `deviceId` acak sekali di localStorage
//        per browser/perangkat.
//      - Saat login toko (/api/login/store), deviceId didaftarkan ke PresenceTracker. Kalau
//        toko itu sudah punya 2 device terdaftar, device yang PALING LAMA tidak aktif
//        otomatis "ditendang" (dihapus dari daftar) supaya slot device baru ini muat.
//      - Setiap heartbeat (/api/presence/ping) sekaligus MEMPERBARUI "terakhir aktif" device
//        ini DAN mengecek apakah device ini masih terdaftar/valid. Kalau device sudah
//        ditendang (login di tempat lain, kelebihan 2 device) ATAU sudah lebih dari 5 jam
//        tidak mengirim heartbeat (tab ditutup / laptop mati / dsb), server membalas
//        `deviceValid:false` dan client (index.html) langsung logout otomatis dari web —
//        semua ini terjadi lewat 1 request yang SAMA yang memang sudah ada, TANPA endpoint
//        atau koneksi tambahan sama sekali.
// === TAMBAHAN CACHE BROWSER + VERSION-CHECK MURAH (2026-07-25) — hemat D1 Rows Read =====
// 5) Butuh 1 binding Durable Object lagi untuk DataVersion (lihat class DataVersion di bawah):
//
//      [[durable_objects.bindings]]
//      name = "DATA_VERSION"
//      class_name = "DataVersion"
//
//      [[migrations]]
//      tag = "v3"
//      new_classes = ["DataVersion"]
//
//    (Kalau tag "v1"/"v2" sudah pernah dipakai untuk ViewCounter/PresenceTracker/ChatHub,
//    pakai tag baru "v3" khusus DataVersion — JANGAN pakai ulang tag yang sama.)
//    TIDAK butuh tabel D1 baru — DataVersion cuma menyimpan angka versi di memori.
//    Cara kerja singkat: index.html sekarang menyimpan data di IndexedDB browser + nomor
//    versi terakhir yang diketahui. Tiap ~25 detik, SEMUA listener aktif digabung jadi satu
//    panggilan GET /api/data-version (0 Rows Read D1 — cuma baca Map di memori DO). Kalau
//    versi tidak berubah, data D1 TIDAK di-fetch ulang sama sekali (dipakai cache lokal).
//    Kalau berubah, baru fetch penuh (sentuh D1) & update cache lokal. Ini TIDAK mengurangi
//    Rows Written (menulis tetap menulis seperti biasa), tapi memangkas Rows Read secara
//    signifikan untuk data yang jarang berubah namun sering dibuka berulang.
// =====================================================================

async function getSecret(binding) {
  if (binding && typeof binding.get === 'function') return await binding.get();
  return binding;
}

// OPTIMASI/KEAMANAN (2026-07-18, diupdate 2026-07-19 untuk dukung >1 origin): Access-
// Control-Allow-Origin dibaca dari Environment Variable "ALLOWED_ORIGIN". Sekarang BISA diisi
// LEBIH DARI SATU domain, dipisah koma — misalnya kalau kamu punya versi web DAN versi APK
// (yang origin-nya "capacitor://localhost", beda dari domain web-mu). CARA SET:
//   Settings > Variables and Secrets > Add variable > Name: ALLOWED_ORIGIN
//   Value: https://domain-web-kamu.com,capacitor://localhost
//   (pisahkan dengan koma, TANPA spasi setelah koma, TANPA trailing slash di tiap domain)
// Kalau belum di-set sama sekali, otomatis fallback ke '*' (semua origin diizinkan) —
// jadi TIDAK akan merusak apa pun kalau kamu belum sempat mengisinya.
//
// Catatan teknis: karena Access-Control-Allow-Origin cuma boleh berisi SATU nilai per
// response (bukan daftar), yang dilakukan di sini adalah "reflect" — kalau origin yang
// mengirim request itu ADA di daftar ALLOWED_ORIGIN, origin itu persis yang dipantulkan
// balik; kalau tidak ada di daftar/tidak dikenali, dipantulkan origin PERTAMA di daftar
// sebagai fallback (browser tetap akan menolak sendiri di sisi client kalau memang tidak
// match, jadi ini bukan celah keamanan — cuma soal header mana yang paling masuk akal
// dikembalikan).
// BUGFIX (2026-07-22): corsHeaders()/json() dipindah jadi closure di dalam fetch() supaya tidak race condition antar-request bersamaan (lihat definisi ALLOWED_ORIGIN di dalam fetch()).

// ---------- util: hash password (PBKDF2 via Web Crypto, tanpa library luar) ----------
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256
  );
  return bufToHex(salt) + ':' + bufToHex(new Uint8Array(bits));
}
async function verifyPassword(password, stored) {
  const [saltHex] = stored.split(':');
  const recomputed = await hashPassword(password, saltHex);
  return recomputed === stored;
}
function bufToHex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBuf(hex) { const arr = new Uint8Array(hex.length / 2); for (let i=0;i<arr.length;i++) arr[i]=parseInt(hex.substr(i*2,2),16); return arr; }

// ---------- util: session token (HMAC-signed, tanpa library luar) ----------
async function signSession(payload, secret) {
  const enc = new TextEncoder();
  const body = btoa(JSON.stringify({ ...payload, exp: Date.now() + 24.5 * 60 * 60 * 1000 }));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return body + '.' + bufToHex(sig);
}
async function verifySession(token, secret) {
  try {
    const [body, sigHex] = token.split('.');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const valid = await crypto.subtle.verify('HMAC', key, hexToBuf(sigHex), enc.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}
function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// ==========================================
// FASE 4: RBAC TERPUSAT (Role-Based Access Control)
// ==========================================
// PRINSIP UTAMA: role di frontend (tombol disembunyikan, menu tidak ditampilkan untuk
// non-admin, dst) HANYA kosmetik/UX -- siapa pun bisa memanggil endpoint Worker LANGSUNG
// (curl, Postman, DevTools) tanpa pernah menyentuh UI React sama sekali, sehingga
// pengecekan role di frontend TIDAK PERNAH boleh jadi satu-satunya pertahanan. Setiap
// endpoint yang mengubah data (POST/PUT/DELETE) atau membaca data sensitif WAJIB
// memvalidasi ULANG role dari `session` (yang berasal dari Cookie HttpOnly yang sudah
// diverifikasi tanda tangannya lewat verifySession -- BUKAN dari apa pun yang dikirim
// client di body/header, karena itu bisa dipalsukan bebas).
//
// Dua helper generik di bawah ini dipakai supaya pengecekan role SERAGAM di semua
// endpoint (satu baris yang sama, gampang diaudit dengan `grep requireRole worker.js`),
// bukan ditulis ulang beda-beda gaya di puluhan tempat yang gampang lupa/typo.
function requireSession(session) {
  if (!session) { const e = new Error('Unauthorized'); e.status = 401; throw e; }
  return session;
}
function requireRole(session, ...roles) {
  requireSession(session);
  if (!roles.includes(session.role)) {
    const e = new Error(`Forbidden: endpoint ini butuh role ${roles.join(' atau ')}`);
    e.status = 403;
    throw e;
  }
  return session;
}

// ---------- RBAC untuk endpoint tulis RTDB generik (/api/rtdb/set|update|push) ----------
// Endpoint-endpoint ini menerima `path` BEBAS dari body request lalu menulis ke path itu --
// desain yang praktis (frontend bisa menulis ke path RTDB mana pun tanpa Worker perlu tahu
// skema setiap fitur), TAPI kalau tidak dijaga di sini, artinya session TOKO yang sah pun
// bisa menulis ke path MANA SAJA, termasuk data toko lain, path admin, atau field pada
// tokonya sendiri yang seharusnya hanya boleh diubah admin (mis. status aktif/nonaktif atau
// token login toko itu sendiri -- toko tidak boleh menonaktifkan validasi token-nya sendiri
// atau mengaktifkan ulang dirinya sendiri setelah dinonaktifkan admin).
//
// Field di bawah ini ADMIN-ONLY meski berada di dalam subtree milik toko itu sendiri.
// Tambahkan field lain ke daftar ini kalau kamu punya field sensitif serupa.
const ADMIN_ONLY_STORE_SUBPATHS = ['info/token', 'info/active'];

function assertPathWritable(session, rawPath) {
  requireSession(session);
  const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
  if (!p) { const e = new Error('Path tidak valid'); e.status = 400; throw e; }

  // Admin dipercaya penuh untuk menulis di mana pun -- konsisten dengan desain sistem ini
  // di tempat lain (admin memang peran tunggal yang mengelola semua toko).
  if (session.role === 'admin') return;

  if (session.role === 'store') {
    const ownPrefix = `stores/${session.storeId}/`;
    if (!p.startsWith(ownPrefix)) {
      const e = new Error('Forbidden: toko hanya boleh menulis data milik tokonya sendiri');
      e.status = 403;
      throw e;
    }
    const rest = p.slice(ownPrefix.length);
    const touchesAdminOnlyField = ADMIN_ONLY_STORE_SUBPATHS.some(
      (sub) => rest === sub || rest.startsWith(sub + '/')
    );
    if (touchesAdminOnlyField) {
      const e = new Error('Forbidden: field ini hanya boleh diubah oleh admin');
      e.status = 403;
      throw e;
    }
    return;
  }

  const e = new Error('Forbidden'); e.status = 403; throw e;
}

// ---------- util: HttpOnly session cookie (menggantikan token di localStorage) ----------
// KEAMANAN (2026-08): token sesi TIDAK LAGI dikirim balik ke browser lewat body JSON, jadi
// JavaScript di frontend (index.html) tidak pernah bisa membacanya sama sekali -> serangan
// XSS yang berhasil menyuntik script tetap TIDAK BISA mencuri sesi ini (beda dengan
// localStorage yang bisa dibaca script apa pun dari origin yang sama).
//
// CATATAN PENTING soal SameSite: cookie ini dipakai LINTAS ORIGIN (frontend di domain-mu,
// Worker di *.workers.dev). SameSite=Strict (bahkan Lax) akan membuat browser TIDAK PERNAH
// mengirim cookie ini sama sekali pada request fetch() lintas origin seperti ini, jadi login
// akan terlihat "berhasil" tapi setiap request berikutnya balas 401 -- itu sebabnya cookie
// ini memakai SameSite=None (wajib disertai Secure). Proteksi CSRF yang biasanya "dibeli"
// oleh SameSite=Strict digantikan oleh pengecekan header Origin di bawah (lihat blok
// "CSRF PROTECTION"), yang WAJIB cocok dengan ALLOWED_ORIGIN untuk setiap request yang
// mengubah data. Kalau suatu saat Worker ini di-mount di domain YANG SAMA dengan frontend
// (lewat Custom Domain/Route Cloudflare, bukan subdomain workers.dev terpisah), SameSite di
// bawah bisa diperketat jadi 'Lax' atau 'Strict' untuk pertahanan berlapis tambahan.
const SESSION_COOKIE_MAX_AGE_SEC = Math.floor(24.5 * 60 * 60); // 24 jam 30 menit, samakan dengan exp di signSession
function buildSessionCookie(token) {
  return `session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`;
}
function buildClearSessionCookie() {
  return `session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
}

// ===== PUSH NOTIFICATION (FCM HTTP v1, buat APK Capacitor) — ditambahkan 2026-07-18 =====
// Butuh 3 Secret di Worker (Dashboard > Settings > Variables and Secrets > Add secret),
// diambil dari file JSON "Service Account" yang di-download dari Firebase Console:
//   FCM_PROJECT_ID    <- field "project_id"
//   FCM_CLIENT_EMAIL  <- field "client_email"
//   FCM_PRIVATE_KEY   <- field "private_key" (paste APA ADANYA, termasuk baris
//                        -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)
// Lihat README-APK.md bagian "Setel Secret Worker" untuk langkah lengkapnya.

let _fcmAccessTokenCache = { token: null, expiresAt: 0 };

function _pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function _base64url(input) {
  const str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Tukar Service Account JSON -> access token OAuth2 Google, pakai JWT RS256 yang
// ditandatangani langsung dengan Web Crypto API bawaan Workers (tidak perlu npm package
// tambahan seperti 'jsonwebtoken' yang tidak jalan di lingkungan Workers).
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_fcmAccessTokenCache.token && _fcmAccessTokenCache.expiresAt > now + 60) return _fcmAccessTokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = _base64url(JSON.stringify(header)) + '.' + _base64url(JSON.stringify(claim));
  const keyData = _pemToArrayBuffer(env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + _base64url(sig);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Gagal ambil Google access token: ' + JSON.stringify(data));
  _fcmAccessTokenCache = { token: data.access_token, expiresAt: now + (data.expires_in || 3500) };
  return data.access_token;
}

// Kirim 1 notifikasi push ke 1 device (lewat token FCM device itu).
async function sendFcmToToken(env, fcmToken, title, body, data = {}) {
  const accessToken = await getGoogleAccessToken(env);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'high', notification: { sound: 'default', channel_id: 'tarobun_default' } },
      },
    }),
  });
  const result = await res.json().catch(() => ({}));
  return { ok: res.ok, result };
}

// Kirim ke SEMUA device milik satu owner (satu toko, atau satu admin tertentu). Token yang
// sudah tidak valid (app di-uninstall dll) otomatis dihapus dari D1, supaya tidak dicoba lagi.
async function notifyOwnerPush(env, ownerType, ownerId, title, body, data = {}) {
  const { results } = await env.DB.prepare('SELECT fcm_token FROM push_tokens WHERE owner_type = ? AND owner_id = ?')
    .bind(ownerType, ownerId).all();
  await _dispatchPush(env, results, title, body, data);
}

// Kirim ke SEMUA admin sekaligus (dipakai saat toko mengirim chat — semua admin yang login
// di HP masing-masing perlu tahu, bukan cuma satu admin tertentu).
async function notifyAllAdminsPush(env, title, body, data = {}) {
  const { results } = await env.DB.prepare("SELECT fcm_token FROM push_tokens WHERE owner_type = 'admin'").all();
  await _dispatchPush(env, results, title, body, data);
}

async function _dispatchPush(env, rows, title, body, data) {
  if (!rows || rows.length === 0) return;
  await Promise.all(rows.map(async (row) => {
    try {
      const { ok, result } = await sendFcmToToken(env, row.fcm_token, title, body, data);
      const code = result?.error?.status;
      if (!ok && (code === 'UNREGISTERED' || code === 'NOT_FOUND' || code === 'INVALID_ARGUMENT')) {
        await env.DB.prepare('DELETE FROM push_tokens WHERE fcm_token = ?').bind(row.fcm_token).run();
      }
    } catch (err) {
      console.log('Gagal kirim push ke satu device:', err.message);
    }
  }));
}

// ---------- BUGFIX (2026-07-18) ----------
// RANGE_UPPER_SENTINEL sebelumnya dideklarasikan dengan `const` DI DALAM fungsi fetch(),
// setelah route /api/login/store. Karena `const`/`let` di JS masuk "Temporal Dead Zone"
// sampai baris deklarasinya benar-benar dieksekusi, setiap request ke /api/login/store
// (yang me-return lebih awal, sebelum baris const itu tercapai) memanggil rtdbReadPath()
// yang memakai variabel tsb SEBELUM diinisialisasi -> ReferenceError: "Cannot access
// 'RANGE_UPPER_SENTINEL' before initialization" -> response 500 -> toko tidak bisa login
// sama sekali walau token benar. Fix: pindahkan ke scope modul (di luar fetch), supaya
// sudah terinisialisasi SEBELUM request apa pun masuk.
//
// Batas atas range untuk pencarian "semua path di bawah prefix ini". '\uFFFF' dipakai
// supaya path apa pun yang diawali `prefix` (huruf, angka, dash, dll — semuanya berada
// di bawah U+FFFF) pasti tercakup, tanpa perlu tahu isi path sebenarnya.
const RANGE_UPPER_SENTINEL = '\uFFFF';

// =====================================================================
// HELPER RTDB — VERSI MODULE-LEVEL (2026-07-20)
// =====================================================================
// Fungsi-fungsi rtdbReadPath/rtdbSetPath ASLI ada di dalam fetch(request, env, ctx)
// (lihat lebih ke bawah) supaya bisa dipanggil endpoint-endpoint HTTP. Tapi fungsi
// scheduled() (dipicu Cron Trigger, BUKAN request HTTP) tidak bisa mengakses fungsi yang
// nested di dalam fetch(). Makanya di sini dibuat SALINAN level-modul yang identik
// (hanya menyentuh env & tabel D1, tidak menyentuh apa pun dari closure fetch), khusus
// dipakai oleh scheduled() untuk fitur pengingat Pre Order (lihat sendPreOrderReminders).
function moduleFlattenWrites(basePath, value, out) {
  if (value === null || value === undefined) return;
  if (value === '.sv_timestamp') { out.push([basePath, JSON.stringify(Date.now())]); return; }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) { out.push([basePath, JSON.stringify({})]); return; }
    for (const k of keys) moduleFlattenWrites(basePath + '/' + k, value[k], out);
  } else {
    out.push([basePath, JSON.stringify(value)]);
  }
}
function moduleBuildWriteStatements(env, path, value, stmts) {
  const p = path.replace(/^\/+|\/+$/g, '');
  if (p === '') {
    stmts.push(env.DB.prepare('DELETE FROM data_nodes'));
  } else {
    const lower = p + '/';
    const upper = p + '/' + RANGE_UPPER_SENTINEL;
    stmts.push(env.DB.prepare('DELETE FROM data_nodes WHERE path = ? OR (path >= ? AND path < ?)').bind(p, lower, upper));
  }
  const rows = [];
  moduleFlattenWrites(p, value, rows);
  for (const [path2, val] of rows) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO data_nodes (path, value, updated_at) VALUES (?,?,?)').bind(path2, val, Date.now()));
  }
}
async function moduleRunBatched(env, stmts) {
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
async function rtdbSetPathModule(env, path, value) {
  const stmts = [];
  moduleBuildWriteStatements(env, path, value, stmts);
  await moduleRunBatched(env, stmts);
  return true;
}
async function rtdbReadPathModule(env, path) {
  const p = path.replace(/^\/+|\/+$/g, '');
  const lower = p + '/';
  const upper = p + '/' + RANGE_UPPER_SENTINEL;
  const { results } = await env.DB.prepare('SELECT path, value FROM data_nodes WHERE path = ? OR (path >= ? AND path < ?)')
    .bind(p, lower, upper).all();
  if (results.length === 0) return null;
  const exact = results.find(r => r.path === p);
  if (exact && results.length === 1) return JSON.parse(exact.value);
  const tree = {};
  for (const r of results) {
    let rest = r.path === p ? '' : r.path.slice(p.length + 1);
    if (rest === '') continue;
    const parts = rest.split('/');
    let cursor = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = JSON.parse(r.value);
  }
  return tree;
}

// =====================================================================
// FITUR: PENGINGAT PRE ORDER — 1 JAM SEBELUM PICKUP (2026-07-20)
// =====================================================================
// Dipanggil oleh scheduled() (Cron Trigger). WAJIB tambahkan trigger cron di wrangler.toml
// milikmu, contoh jalan tiap 5 menit:
//   [triggers]
//   crons = ["*/5 * * * *"]
// Cara kerja: setiap toko yang punya integrasi Telegram (stores/{id}/telegramConfig) dicek
// daftar preOrders-nya. Kalau ada preOrder yang waktu pickup-nya (pickupAt) tinggal ~1 jam
// lagi DAN belum pernah dikirim pengingat (reminderSent belum true), kirim pesan pengingat
// ke grup Telegram toko itu, lalu tandai reminderSent = true supaya tidak dikirim berulang.
const PREORDER_REMINDER_LEAD_MS = 60 * 60 * 1000; // ingatkan H-1 jam sebelum pickup
// Toleransi jendela deteksi — HARUS >= interval cron di wrangler.toml supaya tidak ada
// preOrder yang "kelewat" di antara dua eksekusi cron.
const PREORDER_REMINDER_WINDOW_MS = 10 * 60 * 1000;

async function sendPreOrderReminders(env) {
  const dir = await rtdbReadPathModule(env, 'storeDirectory');
  const storeIds = Object.keys(dir || {});
  if (storeIds.length === 0) return;
  const now = Date.now();

  await Promise.all(storeIds.map(async (storeId) => {
    try {
      const [preOrders, tgConfig] = await Promise.all([
        rtdbReadPathModule(env, `stores/${storeId}/preOrders`),
        rtdbReadPathModule(env, `stores/${storeId}/telegramConfig`),
      ]);
      if (!preOrders || !tgConfig || !tgConfig.botToken || !tgConfig.chatId) return;

      for (const [poId, po] of Object.entries(preOrders)) {
        if (!po || typeof po !== 'object' || !po.pickupAt || po.reminderSent) continue;
        const remaining = po.pickupAt - now;
        // Jendela: sisa waktu sudah <= 1 jam, tapi belum lewat dari (1 jam - toleransi window)
        if (remaining <= PREORDER_REMINDER_LEAD_MS && remaining > PREORDER_REMINDER_LEAD_MS - PREORDER_REMINDER_WINDOW_MS) {
          const metodeLabel = po.metodePickup === 'ojol' ? 'Ojek Online' : 'Ambil Sendiri';
          const text = `⏰ *Pengingat Pre Order — 1 Jam Lagi!*\n\n`
            + `👤 Pemesan: ${po.namaPemesan || '-'}\n`
            + `📝 Pesanan:\n${po.isiPesanan || '-'}\n\n`
            + `📅 Pickup: ${po.pickupTanggal || '-'} pukul ${po.pickupJam || '-'}\n`
            + `🚚 Metode: ${metodeLabel}`;
          try {
            await fetch(`https://api.telegram.org/bot${String(tgConfig.botToken).trim()}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: String(tgConfig.chatId).trim(), text, parse_mode: 'Markdown' }),
            });
            await rtdbSetPathModule(env, `stores/${storeId}/preOrders/${poId}/reminderSent`, true);
          } catch (sendErr) {
            console.error(`Gagal kirim pengingat Pre Order (toko ${storeId}, id ${poId}):`, sendErr);
          }
        }
      }
    } catch (err) {
      console.error(`Gagal memproses pengingat Pre Order untuk toko ${storeId}:`, err);
    }
  }));
}

// ---------- Router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // KEAMANAN (2026-08): sejak sesi memakai HttpOnly Cookie (bukan header Authorization),
    // browser mengizinkan Access-Control-Allow-Origin: '*' TIDAK BOLEH dipakai bersama cookie
    // (Access-Control-Allow-Credentials: true mewajibkan origin SPESIFIK, wildcard ditolak
    // browser). Karena itu daftar ALLOWED_ORIGIN sekarang WAJIB diisi (fail-closed): kalau
    // origin request tidak ada di daftar (atau daftar belum diisi sama sekali), cookie sesi
    // TIDAK akan pernah terkirim/terbaca oleh origin itu -- ini sengaja, supaya website lain
    // tidak bisa menumpang cookie milik user (CSRF) hanya karena CORS "dilonggarkan".
    // CARA SET: Settings > Variables and Secrets > ALLOWED_ORIGIN = https://domain-kamu.com
    // (boleh lebih dari satu, pisah koma, TANPA spasi & TANPA trailing slash).
    const allowedList = (env.ALLOWED_ORIGIN && String(env.ALLOWED_ORIGIN).trim())
      ? String(env.ALLOWED_ORIGIN).split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const reqOrigin = request.headers.get('Origin');
    const ALLOWED_ORIGIN = (reqOrigin && allowedList.includes(reqOrigin)) ? reqOrigin : null;

    // corsHeaders()/json() sebagai closure, pakai ALLOWED_ORIGIN milik request ini saja.
    function corsHeaders() {
      const h = {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin', // supaya proxy/cache tidak keliru simpan header CORS punya origin lain
      };
      // Header ini SENGAJA tidak disertakan sama sekali kalau origin tidak dikenali --
      // bukan di-set ke '*' atau nilai tebakan -- supaya browser menolak sendiri di sisi
      // client kalau memang origin tidak cocok (fail-closed, bukan fail-open).
      if (ALLOWED_ORIGIN) h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
      return h;
    }
    function json(data, status = 200, extraHeaders = {}) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
      });
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    // ===== CSRF PROTECTION =====
    // Sesi sekarang dibawa lewat Cookie, yang otomatis ikut terkirim browser pada request
    // lintas-situs manapun (inilah risiko CSRF). Pertahanannya: setiap request yang MENGUBAH
    // data (bukan GET/HEAD/OPTIONS) WAJIB datang dengan header Origin yang cocok persis
    // dengan salah satu ALLOWED_ORIGIN, kalau tidak langsung ditolak sebelum menyentuh
    // logika/database apa pun di bawah.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !ALLOWED_ORIGIN) {
      return json({ error: 'Origin tidak diizinkan' }, 403);
    }

    try {
      // ===== AUTH =====
      if (path === '/api/login/admin' && request.method === 'POST') {
        const { email, password } = await request.json();
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const guardKeys = [`admin:email:${String(email || '').toLowerCase()}`, `admin:ip:${ip}`];
        const guard = await loginGuardCheck(env, guardKeys);
        if (!guard.allowed) {
          const minutes = Math.ceil((guard.retryAfterMs || 0) / 60000);
          return json({ error: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${minutes} menit.` }, 429);
        }
        const row = await env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first();
        if (!row || !(await verifyPassword(password, row.password_hash))) {
          await loginGuardFail(env, guardKeys);
          return json({ error: 'Email atau password salah' }, 401);
        }
        await loginGuardSuccess(env, guardKeys);
        const token = await signSession({ uid: row.uid, role: 'admin' }, await getSecret(env.JWT_SECRET));
        // KEAMANAN: token TIDAK dikirim di body JSON lagi (supaya tidak berakhir di
        // localStorage/state JS yang bisa dicuri XSS) -- dikirim lewat Set-Cookie HttpOnly.
        return json({ ok: true, role: 'admin', uid: row.uid, onboardingSeen: !!row.onboarding_seen }, 200, {
          'Set-Cookie': buildSessionCookie(token),
        });
      }

      if (path === '/api/login/store' && request.method === 'POST') {
        const { storeId, token: inputToken, deviceId, deviceLabel } = await request.json();
        if (!storeId || !inputToken) return json({ error: 'Kode toko dan token wajib diisi' }, 400);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const guardKeys = [`store:id:${storeId}`, `store:ip:${ip}`];
        const guard = await loginGuardCheck(env, guardKeys);
        if (!guard.allowed) {
          const minutes = Math.ceil((guard.retryAfterMs || 0) / 60000);
          return json({ error: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${minutes} menit.` }, 429);
        }
        const info = await rtdbReadPath(env, `stores/${storeId}/info`);
        if (!info) { await loginGuardFail(env, guardKeys); return json({ error: 'Toko tidak ditemukan' }, 404); }
        if (!info.active) return json({ error: 'Akun toko tidak aktif' }, 403);
        if (String(info.token || '') !== String(inputToken)) {
          await loginGuardFail(env, guardKeys);
          return json({ error: 'Token salah' }, 401);
        }
        await loginGuardSuccess(env, guardKeys);
        // KEAMANAN (device-spoofing): `sid` (session/device id) dibuat DI SERVER, TIDAK
        // memakai `deviceId` kiriman client sama sekali untuk keperluan keamanan. `deviceId`
        // kiriman client (kalau ada, dari versi lama) diabaikan; `deviceLabel` HANYA dipakai
        // sebagai label tampilan kosmetik di menu "Perangkat" Admin (mis. "Chrome - Android"),
        // bukan identitas yang menentukan hak akses. `sid` ini lalu ditandatangani di dalam
        // token sesi (lihat signSession di bawah) sehingga client tidak bisa mengubahnya --
        // memalsukan sid berarti tanda tangan HMAC tidak lagi cocok dan sesi ditolak.
        const sid = crypto.randomUUID();
        const stub = getPresenceStub(env);
        await stub.fetch('https://presence/device-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId, deviceId: sid, deviceLabel: (typeof deviceLabel === 'string' ? deviceLabel.slice(0, 80) : '') }),
        }).catch(() => {});
        const token = await signSession({ storeId, role: 'store', sid }, await getSecret(env.JWT_SECRET));
        return json({ ok: true, role: 'store', storeId, storeInfo: info }, 200, {
          'Set-Cookie': buildSessionCookie(token),
        });
      }

      // Beberapa path RTDB WAJIB bisa dibaca TANPA login dulu — dipakai oleh layar login itu
      // sendiri (daftar nama toko utk dropdown, & cek apakah admin sudah pernah dibuat).
      const PUBLIC_RTDB_READ_PATHS = ['storeDirectory', 'meta/adminAccountExists'];
      const isPublicRtdbRead = path === '/api/rtdb/get' && request.method === 'GET' &&
        PUBLIC_RTDB_READ_PATHS.includes((url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, ''));

      // Semua endpoint di bawah ini butuh sesi yang valid, dibaca dari HttpOnly Cookie
      // "session" (BUKAN lagi header "Authorization: Bearer ..." -- token tidak pernah lagi
      // ada di tempat yang bisa disentuh JavaScript frontend, lihat buildSessionCookie()).
      const cookieToken = getCookie(request, 'session');
      let session = cookieToken ? await verifySession(cookieToken, await getSecret(env.JWT_SECRET)) : null;

      // ===== KERAS-KAN LOGIKA DEVICE (mencegah device-spoofing) =====
      // Sebelumnya, "logout paksa" 1 device oleh Admin (menu Perangkat) cuma sebuah FLAG yang
      // dicek client secara SUKARELA saat heartbeat (/api/presence/ping) -- client yang sudah
      // dimodifikasi (mis. token/cookie dicuri lalu dipakai lewat script/tool sendiri, bukan
      // index.html asli) bisa saja MENGABAIKAN flag itu dan tetap memakai sesinya untuk semua
      // endpoint lain, karena endpoint lain sama sekali tidak mengecek status device.
      // Sekarang device/sesi diidentifikasi lewat `sid` yang DIBUAT & DITANDATANGANI SERVER
      // saat login (lihat /api/login/store), bukan `deviceId` kiriman client -- client tidak
      // bisa memalsukan/mengganti sid ini karena sid ikut ditandatangani di dalam token sesi.
      // Setiap request yang memakai sesi 'store' divalidasi ulang ke PresenceTracker (sumber
      // kebenaran daftar device aktif per toko): kalau device ini sudah di-kick Admin atau
      // sudah lebih dari 5 jam tidak aktif, sesi langsung dianggap TIDAK VALID di endpoint
      // MANAPUN -- bukan cuma berhenti di heartbeat berikutnya seperti sebelumnya.
      if (session && session.role === 'store' && session.sid) {
        try {
          const stub = getPresenceStub(env);
          const res = await stub.fetch('https://presence/sid-valid', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storeId: session.storeId, sid: session.sid }),
          });
          const chk = await res.json();
          if (!chk.valid) session = null;
        } catch (e) {
          // Kalau Durable Object sedang bermasalah, JANGAN diam-diam mengizinkan semua request
          // (fail-open); lebih aman memaksa login ulang daripada membuka celah keamanan.
          session = null;
        }
      }

      // BUGFIX (2026-07-18): index.html memanggil GET /api/admin-exists (lihat tryAdminCheck
      // di index.html), tapi route ini sebelumnya TIDAK ADA di worker sama sekali — sehingga
      // request selalu jatuh ke pengecekan Authorization di bawah dan balas 401 Unauthorized
      // terus-menerus (retry loop di layar login). Ini tidak menyebabkan login toko gagal
      // (itu penyebabnya RANGE_UPPER_SENTINEL di atas), tapi tetap bug: dropdown "cek admin
      // sudah dibuat atau belum" jadi selalu gagal/fallback ke cache lokal.
      // /api/logout ditambahkan ke daftar publik supaya tetap bisa membersihkan Cookie
      // walau cookie yang dikirim sudah kedaluwarsa/tidak valid (handler-nya sendiri sudah
      // aman dipanggil tanpa sesi -- lihat pengecekan `if (session && ...)` di dalamnya).
      const PUBLIC_ENDPOINTS = ['/api/bootstrap-admin', '/api/admin-exists', '/api/logout'];
      // File media (foto/video) di-serve publik lewat key acak panjang (mirip signed URL) karena
      // dipakai langsung sebagai <img src="...">, yang tidak bisa mengirim header Authorization.
      const isPublicMediaRead = path.startsWith('/api/media/file/') && request.method === 'GET';

      // BUGFIX (digabung dari sesi lain, 2026-07-20): /api/view/<target> dipakai untuk
      // menghitung tayangan halaman toko/produk yang dibuka PENGUNJUNG PUBLIK (customer,
      // belum tentu login). Sebelum baris ini ditambahkan, endpoint ini ikut ketiban aturan
      // "wajib session" di bawah, sehingga SELALU balas 401 Unauthorized untuk visitor
      // anonim — padahal justru merekalah yang paling sering memicu view count. Publikkan
      // endpoint ini (POST saja, sesuai handler-nya).
      const isPublicViewTrack = path.startsWith('/api/view/') && request.method === 'POST';

      if (path.startsWith('/api/') && !PUBLIC_ENDPOINTS.includes(path) && !isPublicRtdbRead && !isPublicMediaRead && !isPublicViewTrack && !session) {
        return json({ error: 'Unauthorized' }, 401);
      }

      // ===== RATE LIMITING UMUM (bukan cuma login) =====
      // loginGuardCheck/Fail/Success di atas SUDAH menangani brute-force login secara khusus
      // (salah password berkali-kali -> dikunci sekian menit). Ini BEDA kasus: mencegah 1
      // client (baik toko yang login sah, maupun penyerang tanpa login) mengirim request
      // SPAM ke endpoint mana pun secara membabi-buta (mis. memukul /api/rtdb/get atau
      // /api/chat ribuan kali/detik) yang bisa membanjiri D1 dengan Rows Read/Written dan
      // berimbas ke biaya + performa semua pengguna lain.
      //
      // Memakai Rate Limiting API bawaan Cloudflare Workers (binding `env.RATE_LIMITER`,
      // lihat wrangler.toml) -- BUKAN dihitung manual di Durable Object seperti loginGuard,
      // karena untuk kasus "hitung semua request" volumenya jauh lebih tinggi & binding ini
      // memang didesain untuk itu (counter di-cache lokal per lokasi Cloudflare, nyaris tanpa
      // menambah latency, lihat komentar performa di dokumentasi Cloudflare).
      //
      // Key mengikuti rekomendasi resmi Cloudflare: PAKAI identitas user (storeId/uid) kalau
      // sudah login, BUKAN alamat IP -- karena banyak user sah bisa berbagi IP yang sama
      // (jaringan seluler/kantor), jadi rate-limit berbasis IP berisiko salah menghukum orang
      // yang tidak bersalah. IP tetap dipakai sebagai fallback HANYA untuk request yang belum
      // punya sesi sama sekali (mis. endpoint publik /api/admin-exists, atau /api/login/*
      // sebelum berhasil login -- yang mana SUDAH punya guard khusus terpisah juga di atas).
      if (path.startsWith('/api/') && env.RATE_LIMITER) {
        const rlKey = session ? `user:${session.role}:${session.storeId || session.uid}` : `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
        try {
          const { success } = await env.RATE_LIMITER.limit({ key: rlKey });
          if (!success) {
            return json({ error: 'Terlalu banyak request, coba lagi sesaat lagi.' }, 429);
          }
        } catch (e) {
          // Binding rate limiter gagal (jarang terjadi) -> fail-OPEN (tetap izinkan request).
          // Ini keputusan sadar: rate limiter adalah pertahanan tambahan, bukan gerbang utama
          // (gerbang utama tetap sesi & CORS/CSRF di atas) -- lebih baik sedikit request lolos
          // tanpa dihitung daripada SELURUH aplikasi ikut down gara-gara binding ini bermasalah.
          console.error('RATE_LIMITER error (fail-open):', e);
        }
      }

      // Serve file dari R2 (route ini sengaja diletakkan sebelum semua route lain yang butuh session,
      // supaya path dinamis /api/media/file/<key...> tidak ikut ketiban aturan auth di atas).
      //
      // PENTING soal R2 Class B: karena file dibaca lewat BINDING (env.MEDIA.get), bukan lewat
      // fetch() ke origin, response ini TIDAK otomatis masuk ke edge cache Cloudflare hanya
      // dengan header Cache-Control. Header Cache-Control cuma dipatuhi oleh BROWSER si user.
      // Supaya CDN Cloudflare juga menyimpan salinannya (dan permintaan berikutnya dari user
      // lain / device lain TIDAK lagi memicu env.MEDIA.get() = R2 Class B op), kita simpan
      // response ke `caches.default` secara eksplisit lalu selalu cek cache itu dulu di awal.
      if (path.startsWith('/api/media/file/') && request.method === 'GET') {
        const cache = caches.default;
        // Cache key harus request GET murni tanpa header Authorization/Cookie, supaya key-nya
        // stabil dan tidak mengunci konten ke satu user tertentu (file media memang publik).
        const cacheKey = new Request(url.toString(), { method: 'GET' });

        let cached = await cache.match(cacheKey);
        if (cached) {
          // HIT: 0 R2 operation sama sekali untuk request ini.
          const headers = new Headers(cached.headers);
          headers.set('CF-Cache-Status', 'HIT-EDGE'); // penanda custom, memudahkan debug di Network tab
          return new Response(cached.body, { status: cached.status, headers });
        }

        const key = decodeURIComponent(path.slice('/api/media/file/'.length));
        if (!key) return json({ error: 'Key tidak valid' }, 400);
        const obj = await env.MEDIA.get(key); // <- 1x R2 Class B op, hanya terjadi saat MISS
        if (!obj) return json({ error: 'File tidak ditemukan' }, 404);

        const response = new Response(obj.body, {
          headers: {
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
            // OPTIMASI (2026-07-19): dinaikkan dari 1 hari -> 1 tahun + immutable. Ini AMAN
            // karena key file di sini sudah unik permanen per-upload (timestamp+random di
            // /api/media/upload) — file dengan key yang sama TIDAK PERNAH berubah isinya,
            // jadi browser boleh percaya penuh dan tidak perlu cek ulang sama sekali sampai
            // 1 tahun. Ini mengurangi request ke edge cache/R2 lebih jauh untuk foto yang
            // sering ditampilkan berulang (mis. foto produk di katalog).
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': obj.httpEtag,
            'CF-Cache-Status': 'MISS-EDGE',
            ...corsHeaders(),
          },
        });

        // Simpan ke edge cache TANPA menahan response ke user (waitUntil = jalan di background).
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // ===== EMULASI RTDB GENERIK (path tree di atas D1) =====
      // Semua data disimpan sebagai baris (path, value_json). Meniru perilaku Firebase RTDB:
      // PUT di suatu path mengganti seluruh subtree; baca di suatu path menggabungkan subtree-nya.
      function flattenWrites(basePath, value, out) {
        if (value === null || value === undefined) return; // null = hapus (subtree sudah dihapus sebelumnya)
        if (value === '.sv_timestamp') { out.push([basePath, JSON.stringify(Date.now())]); return; }
        if (typeof value === 'object' && !Array.isArray(value)) {
          const keys = Object.keys(value);
          if (keys.length === 0) { out.push([basePath, JSON.stringify({})]); return; }
          for (const k of keys) flattenWrites(basePath + '/' + k, value[k], out);
        } else {
          out.push([basePath, JSON.stringify(value)]);
        }
      }
      // Menyiapkan (TANPA menjalankan) statement DELETE+INSERT untuk satu path/value, lalu
      // menambahkannya ke array `stmts` yang dipakai bersama. Dipisah dari eksekusi supaya
      // beberapa path (misalnya dari /api/rtdb/update) bisa digabung jadi SATU transaksi D1
      // (env.DB.batch) — kalau salah satu gagal, semuanya dibatalkan, tidak ada yang
      // "setengah tersimpan".
      function buildWriteStatements(env, path, value, stmts) {
        const p = path.replace(/^\/+|\/+$/g, '');
        if (p === '') {
          stmts.push(env.DB.prepare('DELETE FROM data_nodes'));
        } else {
          // PENTING: JANGAN pakai "path LIKE ?" (batas ~50 karakter pattern di SQLite/D1) ATAUPUN
          // "substr(path,1,N) = ?" (fungsi di kolom mematikan index PRIMARY KEY, jadi full table
          // scan — inilah penyebab utama tingginya Rows Read). Sebagai gantinya pakai perbandingan
          // RANGE langsung pada kolom `path` (path >= ... AND path < ...) — bentuk ini "sargable",
          // artinya SQLite bisa langsung memakai index PRIMARY KEY `path` untuk lompat ke baris
          // yang relevan saja, tanpa menyentuh baris lain sama sekali.
          const lower = p + '/';
          const upper = p + '/' + RANGE_UPPER_SENTINEL;
          stmts.push(env.DB.prepare('DELETE FROM data_nodes WHERE path = ? OR (path >= ? AND path < ?)').bind(p, lower, upper));
        }
        const rows = [];
        flattenWrites(p, value, rows);
        for (const [path2, val] of rows) {
          stmts.push(env.DB.prepare('INSERT OR REPLACE INTO data_nodes (path, value, updated_at) VALUES (?,?,?)').bind(path2, val, Date.now()));
        }
      }

      // Menjalankan statement dalam potongan maksimal 50 (batas aman D1 per batch()).
      // CATATAN: kalau total statement > 50, tetap terpecah jadi beberapa batch terpisah
      // (masing-masing batch atomik, tapi TIDAK atomik lintas-batch). Untuk update toko
      // biasa (beberapa path kecil) ini nyaris selalu masih di bawah 50, jadi tetap
      // benar-benar sekali-jalan/atomik.
      async function runBatched(env, stmts) {
        for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      }

      // Endpoint katalog (di bawah) menyimpan hasil query D1 di caches.default selama 5 menit
      // Cache key khusus untuk 'storeDirectory' dipisah dari query string apa pun, supaya
      // stabil dan gampang di-purge dari fungsi manapun (baik GET handler di bawah maupun
      // saat ada tulisan baru).
      function storeDirCacheKey(request) {
        const base = new URL(request.url);
        base.pathname = '/api/rtdb/get';
        base.search = '?path=storeDirectory';
        return new Request(base.toString(), { method: 'GET' });
      }

      // dengan cache key = URL /api/catalog/<storeId>. Kalau katalog toko itu baru saja ditulis
      // ulang lewat /api/rtdb/set atau /api/rtdb/update, cache lama harus dibuang SEKARANG juga
      // (bukan nunggu 5 menit habis) supaya perubahan produk langsung terlihat.
      // Sama juga berlaku untuk 'storeDirectory' (dipakai dropdown daftar toko di layar
      // login): begitu ada toko baru ditambah/dihapus, cache lama langsung dibuang supaya
      // toko baru langsung muncul di dropdown, bukan nunggu 5 menit.
      async function purgeDerivedCachesIfNeeded(request, touchedPaths) {
        const storeIds = new Set();
        let touchedStoreDir = false;
        for (const p0 of touchedPaths) {
          const p = p0.replace(/^\/+|\/+$/g, '');
          const m = /^stores\/([^/]+)\/products(\/|$)/.exec(p);
          if (m) storeIds.add(m[1]);
          if (p === 'storeDirectory' || p.startsWith('storeDirectory/')) touchedStoreDir = true;
        }
        const cache = caches.default;
        const base = new URL(request.url);
        const jobs = [...storeIds].map(storeId => {
          base.pathname = `/api/catalog/${storeId}`;
          base.search = '';
          return cache.delete(new Request(base.toString(), { method: 'GET' }));
        });
        if (touchedStoreDir) jobs.push(cache.delete(storeDirCacheKey(request)));
        if (jobs.length > 0) await Promise.all(jobs);
      }

      async function rtdbSetPath(env, path, value) {
        const stmts = [];
        buildWriteStatements(env, path, value, stmts);
        await runBatched(env, stmts);
        return true;
      }

      // ===== TAMBAHAN: VERSION-CHECK MURAH via Durable Object (2026-07-25) =====
      // Ide: client (index.html) tidak lagi mem-fetch data penuh dari D1 tiap 25 detik buta-
      // buta. Sebelum itu, client tanya dulu "versi" path ini ke Durable Object DATA_VERSION
      // (murni memori, 0 Rows Read D1). Kalau versi sama seperti terakhir client tahu, client
      // pakai data yang sudah di-cache di IndexedDB browser — TIDAK fetch ulang ke D1 sama
      // sekali. Kalau beda, baru client fetch data penuh (baru itu sentuh D1), lalu update
      // cache lokalnya.
      // Granularitas versi: per-toko (`stores/<id>`) untuk path di bawah 1 toko, atau
      // per-top-level-key untuk path lain (mis. 'storeDirectory'). Ini SENGAJA tidak
      // sampai ke level path detail (mis. per-history-item) supaya tetap 1 angka simpel
      // per toko — cukup akurat karena rata-rata 1 toko hanya diakses oleh sedikit device.
      // WAJIB: tambahkan binding Durable Object baru di wrangler.toml:
      //   [[durable_objects.bindings]]
      //   name = "DATA_VERSION"
      //   class_name = "DataVersion"
      //   [[migrations]]
      //   tag = "v3"
      //   new_classes = ["DataVersion"]
      // (Kalau tag v1/v2 sudah pernah dipakai untuk ViewCounter/PresenceTracker/ChatHub,
      // pakai tag baru "v3" khusus DataVersion — JANGAN pakai ulang tag yang sama.)
      // CATATAN: kalau binding ini BELUM di-set (mis. lupa update wrangler.toml), semua
      // fungsi di bawah ini SENGAJA "diam saja" (try/catch, tidak melempar error) supaya
      // fitur lama (baca/tulis RTDB biasa) tetap jalan normal seperti sebelum fitur ini ada.
      function versionKeyForPath(p) {
        // DIPERHALUS (2026-07-30): sebelumnya granularitasnya cuma per-toko (`stores/<id>`),
        // jadi 1 perubahan kecil (mis. history nambah 1 transaksi baru) ikut membuat listener
        // LAIN yang tidak berhubungan (wasteFotos, preOrders, bapReports, telegramConfig)
        // sama-sama dianggap "berubah" dan refetch semua, padahal isinya tidak berubah.
        // Sekarang per-toko DAN per-sub-koleksi (`stores/<id>/<subkey>`), supaya perubahan di
        // 'history' tidak lagi memicu refetch 'preOrders' dkk pada toko yang sama.
        const parts = String(p || '').replace(/^\/+|\/+$/g, '').split('/');
        if (parts[0] === 'stores' && parts[1]) return parts[2] ? `stores/${parts[1]}/${parts[2]}` : `stores/${parts[1]}`;
        return parts[0] || 'root';
      }
      function getDataVersionStub(env) {
        const id = env.DATA_VERSION.idFromName('global');
        return env.DATA_VERSION.get(id);
      }
      async function bumpDataVersion(env, paths) {
        try {
          if (!env.DATA_VERSION) return; // binding belum diatur, jangan pecahkan request
          const keys = [...new Set((paths || []).map(versionKeyForPath))];
          if (keys.length === 0) return;
          const stub = getDataVersionStub(env);
          await stub.fetch('https://data-version/bump', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys }),
          });
        } catch (e) { /* diamkan, ini cuma optimisasi cache — tidak boleh gagalkan write asli */ }
      }

      async function rtdbReadPath(env, path) {
        const p = path.replace(/^\/+|\/+$/g, '');
        // Sama seperti di atas: range scan (sargable), bukan LIKE atau substr(), supaya
        // SQLite tetap memakai index PRIMARY KEY `path` — hemat Rows Read, dan tidak terbatas
        // panjang path.
        const lower = p + '/';
        const upper = p + '/' + RANGE_UPPER_SENTINEL;
        const { results } = await env.DB.prepare('SELECT path, value FROM data_nodes WHERE path = ? OR (path >= ? AND path < ?)')
          .bind(p, lower, upper).all();
        if (results.length === 0) return null;
        const exact = results.find(r => r.path === p);
        if (exact && results.length === 1) return JSON.parse(exact.value);
        const tree = {};
        for (const r of results) {
          let rest = r.path === p ? '' : r.path.slice(p.length + 1);
          if (rest === '') continue; // nilai persis di path ini biasanya objek kosong penanda, abaikan jika ada anak
          const parts = rest.split('/');
          let cursor = tree;
          for (let i = 0; i < parts.length - 1; i++) {
            cursor[parts[i]] = cursor[parts[i]] || {};
            cursor = cursor[parts[i]];
          }
          cursor[parts[parts.length - 1]] = JSON.parse(r.value);
        }
        return tree;
      }

      // Versi terbatas dari rtdbReadPath, dipakai kalau frontend minta ?limit=N (mis. "150
      // riwayat terakhir"). CATATAN PENTING: karena objek bersarang disimpan sebagai BEBERAPA
      // baris terpisah (lihat flattenWrites), N di sini adalah batas RAW ROWS (field individual),
      // bukan jumlah record logis persis. Praktiknya kalau N cukup longgar (mis. 1500), itu
      // tetap mencakup ratusan record lengkap — lebih dari cukup untuk tampilan "riwayat
      // terakhir" di UI. Yang penting: ORDER BY ... LIMIT di sini bisa memakai index PRIMARY
      // KEY `path` untuk BERHENTI LEBIH AWAL, alih-alih selalu scan SELURUH riwayat toko itu
      // (yang terus pengar makin besar & makin mahal seiring waktu) seperti sebelumnya.
      async function rtdbReadPathLimited(env, path, limitRows) {
        const p = path.replace(/^\/+|\/+$/g, '');
        const lower = p + '/';
        const upper = p + '/' + RANGE_UPPER_SENTINEL;
        const { results } = await env.DB.prepare(
          'SELECT path, value FROM data_nodes WHERE path >= ? AND path < ? ORDER BY path DESC LIMIT ?'
        ).bind(lower, upper, limitRows).all();
        if (results.length === 0) return null;
        results.reverse(); // balik lagi ke urutan lama->baru
        const tree = {};
        for (const r of results) {
          const rest = r.path.slice(p.length + 1);
          if (rest === '') continue;
          const parts = rest.split('/');
          let cursor = tree;
          for (let i = 0; i < parts.length - 1; i++) {
            cursor[parts[i]] = cursor[parts[i]] || {};
            cursor = cursor[parts[i]];
          }
          cursor[parts[parts.length - 1]] = JSON.parse(r.value);
        }
        return tree;
      }

      // KRITIS (2026-07-19): sebelumnya panel admin baca db.ref('stores') lewat /api/rtdb/get
      // — path itu mencakup SEMUA anak di bawahnya: stores/{id}/history/*, wasteFotos/*,
      // kedatanganBarang/*, dst — BUKAN cuma stores/{id}/info (nama/token/status
      // aktif) yang sebenarnya dipakai admin. Efeknya: setiap kali admin buka dashboard,
      // SELURUH data SEMUA toko ikut ke-scan dari D1. Ini kemungkinan besar kontributor Rows
      // Read TERBESAR di seluruh aplikasi. Endpoint ini gantinya: baca stores/{id}/info SATU
      // PER SATU (kecil & bertarget), tidak pernah menyentuh sub-path lain.
      if (path === '/api/stores-summary' && request.method === 'GET') {
        if (!session || session.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
        const dirValue = await rtdbReadPath(env, 'storeDirectory');
        const ids = Object.keys(dirValue || {});
        const infos = await Promise.all(ids.map(id => rtdbReadPath(env, `stores/${id}/info`)));
        const result = {};
        ids.forEach((id, i) => { if (infos[i]) result[id] = infos[i]; });
        return json({ ok: true, stores: result });
      }

      if (path === '/api/rtdb/get' && request.method === 'GET') {
        const p = url.searchParams.get('path') || '';
        const pNorm = p.replace(/^\/+|\/+$/g, '');

        // OPTIMASI (2026-07-18): 'storeDirectory' dibaca oleh SETIAP orang yang membuka
        // layar login (buat isi dropdown "Pilih Toko") — kemungkinan besar ini kontributor
        // terbesar ke angka Rows Read D1 kamu. Isinya jarang berubah (cuma saat admin
        // tambah/hapus toko), jadi cocok dicache 5 menit persis seperti /api/catalog/.
        // Cache HIT = 0 query D1 sama sekali untuk request ini.
        if (pNorm === 'storeDirectory') {
          const cache = caches.default;
          const cacheKey = storeDirCacheKey(request);
          const cached = await cache.match(cacheKey);
          if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('X-StoreDir-Cache', 'HIT'); // 0 D1 Rows Read untuk request ini
            return new Response(cached.body, { status: cached.status, headers });
          }
          const value = await rtdbReadPath(env, p);
          const response = json({ value });
          response.headers.set('Cache-Control', 'public, max-age=300'); // 5 menit
          response.headers.set('X-StoreDir-Cache', 'MISS');
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }

        // OPTIMASI (2026-07-19): sebelumnya .limitToLast(n) di sisi client itu KOSMETIK —
        // server tetap kirim SELURUH isi node, baru dipotong belakangan di HP. Sekarang kalau
        // ada ?limit=N, batasan itu BENERAN diterapkan di query SQL (ORDER BY path DESC LIMIT),
        // yang bisa memakai index (path adalah PRIMARY KEY) untuk berhenti lebih awal — jauh
        // lebih hemat daripada scan seluruh isi node dulu baru dipotong.
        const limitParam = parseInt(url.searchParams.get('limit') || '0', 10);
        if (limitParam > 0) {
          const value = await rtdbReadPathLimited(env, p, limitParam);
          return json({ value });
        }

        const value = await rtdbReadPath(env, p);
        return json({ value });
      }
      if (path === '/api/rtdb/set' && request.method === 'POST') {
        const { path: p, value } = await request.json();
        // FASE 4 (RBAC): sebelum baris ini ditambahkan, endpoint ini HANYA mengecek "apakah
        // ada sesi valid" (lihat gerbang umum di atas) -- TIDAK peduli sesi itu admin atau
        // toko, dan TIDAK peduli path yang ditulis. Artinya sesi toko yang sah bisa menulis
        // ke path toko LAIN atau path admin hanya dengan mengganti `path` di body request
        // (gampang dilakukan lewat DevTools, tidak perlu tombol apa pun di UI). Sekarang
        // divalidasi ulang di server berdasarkan role dari Cookie, bukan dari input client.
        assertPathWritable(session, p);
        await rtdbSetPath(env, p, value);
        ctx.waitUntil(purgeDerivedCachesIfNeeded(request, [p]));
        ctx.waitUntil(bumpDataVersion(env, [p]));
        return json({ ok: true });
      }
      if (path === '/api/rtdb/update' && request.method === 'POST') {
        const { updates } = await request.json();
        // FASE 4 (RBAC): validasi SETIAP path di batch ini satu per satu -- kalau SATU SAJA
        // path di luar kewenangan role sesi ini, seluruh batch ditolak (tidak ada yang
        // ditulis sebagian), supaya tidak ada celah "selundupkan 1 path terlarang di antara
        // banyak path yang sah" dalam satu request /update.
        for (const p of Object.keys(updates)) assertPathWritable(session, p);
        // Gabungkan statement dari SEMUA path sekaligus, lalu jalankan sebagai satu batch —
        // supaya multi-update (misalnya saat "Tambah Toko" menulis 3 path berbeda) sungguh
        // atomik: kalau satu bagian gagal, tidak ada satupun yang tersimpan setengah-setengah.
        const stmts = [];
        for (const [p, v] of Object.entries(updates)) buildWriteStatements(env, p, v, stmts);
        await runBatched(env, stmts);
        ctx.waitUntil(purgeDerivedCachesIfNeeded(request, Object.keys(updates)));
        ctx.waitUntil(bumpDataVersion(env, Object.keys(updates)));
        return json({ ok: true });
      }
      if (path === '/api/rtdb/push' && request.method === 'POST') {
        const { path: p, value } = await request.json();
        assertPathWritable(session, p);
        const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        await rtdbSetPath(env, p.replace(/\/+$/, '') + '/' + key, value);
        ctx.waitUntil(bumpDataVersion(env, [p]));
        return json({ name: key });
      }

      // ===== Endpoint version-check murah untuk client (lihat blok DATA_VERSION di atas) =====
      // Dipakai oleh dbRef(...).on() di index.html: 1 kali per siklus poll, DIGABUNG untuk
      // SEMUA listener aktif sekaligus (bukan 1 request per listener), supaya makin hemat.
      // Endpoint ini TIDAK PERNAH menyentuh D1 sama sekali — cuma baca Map di memori DO.
      if (path === '/api/data-version' && request.method === 'GET') {
        const keysParam = url.searchParams.get('keys') || '';
        const keys = [...new Set(keysParam.split(',').map(k => k.trim()).filter(Boolean))].slice(0, 50);
        if (keys.length === 0) return json({ ok: true, versions: {} });
        if (!env.DATA_VERSION) return json({ ok: true, versions: {} }); // binding belum diatur -> fallback aman
        const stub = getDataVersionStub(env);
        const res = await stub.fetch(`https://data-version/get?keys=${encodeURIComponent(keys.join(','))}`);
        const data = await res.json();
        return json({ ok: true, versions: data.versions || {} });
      }

      // ===== KATALOG PRODUK (cache 5 menit via Cache API — hemat D1 Rows Read) =====
      // Data katalog per toko jarang berubah (beda dengan chat/presence yang tiap detik
      // berubah), jadi cocok di-cache. Pola: cek caches.default dulu -> kalau HIT, langsung
      // balikin TANPA baca D1 sama sekali. Kalau MISS, baru query D1 (lewat rtdbReadPath yang
      // sudah sargable/pakai index), lalu simpan ke cache selama 5 menit sebelum dikembalikan.
      if (path.startsWith('/api/catalog/') && request.method === 'GET') {
        const storeId = decodeURIComponent(path.slice('/api/catalog/'.length)).replace(/\/+$/, '');
        if (!storeId) return json({ error: 'storeId wajib diisi' }, 400);

        const cache = caches.default;
        // Cache key sengaja hanya berdasarkan URL (method GET polos), bukan request asli yang
        // membawa header Authorization — supaya semua user yang berhak lihat katalog toko yang
        // sama saling berbagi 1 cache entry yang sama (bukan 1 entry per-user yang sia-sia).
        const cacheUrl = new URL(request.url);
        cacheUrl.search = ''; // abaikan query string lain supaya key tetap stabil
        const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

        const cached = await cache.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('X-Catalog-Cache', 'HIT'); // 0 D1 Rows Read untuk request ini
          return new Response(cached.body, { status: cached.status, headers });
        }

        // MISS: baru sentuh D1. rtdbReadPath dipilih (bukan SELECT * biasa) karena sudah
        // pakai range scan sargable di index PRIMARY KEY `path`, jadi Rows Read tetap minimal
        // (hanya baris di bawah stores/<id>/products, bukan full table scan).
        const products = await rtdbReadPath(env, `stores/${storeId}/products`);

        const response = json({ ok: true, storeId, products: products || {} });
        response.headers.set('Cache-Control', 'public, max-age=300'); // 5 menit
        response.headers.set('X-Catalog-Cache', 'MISS');

        // Simpan ke edge cache di background, tidak menahan response ke user.
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // Dipakai layar login (index.html) untuk tahu apakah harus tampilkan form "Buat Admin
      // Pertama" atau form login biasa. Publik (lihat PUBLIC_ENDPOINTS) karena dipanggil
      // SEBELUM siapa pun login. Hanya COUNT(*), jadi murah (tidak membaca isi baris admin).
      if (path === '/api/admin-exists' && request.method === 'GET') {
        const row = await env.DB.prepare('SELECT COUNT(*) as c FROM admins').first();
        return json({ ok: true, exists: row.c > 0 });
      }

      // ===== FALLBACK: buat admin dari DALAM APP kalau belum ada admin sama sekali =====
      // (dipakai oleh index.html saat adminAccountExists === false; dijaga hanya bisa
      //  dipakai SEKALI selama belum ada baris di tabel admins)
      if (path === '/api/bootstrap-admin' && request.method === 'POST') {
        const existing = await env.DB.prepare('SELECT COUNT(*) as c FROM admins').first();
        if (existing.c > 0) return json({ error: 'Admin sudah ada' }, 400);
        const { email, password } = await request.json();
        if (!email || !password || password.length < 6) return json({ error: 'Email/password tidak valid' }, 400);
        const uid = crypto.randomUUID();
        const hash = await hashPassword(password);
        await env.DB.prepare('INSERT INTO admins (uid, email, password_hash, onboarding_seen) VALUES (?,?,?,0)')
          .bind(uid, email, hash).run();
        await rtdbSetPath(env, 'meta/adminAccountExists', true);
        const token = await signSession({ uid, role: 'admin' }, await getSecret(env.JWT_SECRET));
        return json({ ok: true, uid }, 200, { 'Set-Cookie': buildSessionCookie(token) });
      }

      // ===== LOGOUT: hapus Cookie sesi di sisi server =====
      // Karena cookie HttpOnly tidak bisa dihapus lewat JavaScript (document.cookie tidak bisa
      // menyentuhnya), penghapusan HARUS lewat response Set-Cookie dari server seperti ini.
      if (path === '/api/logout' && request.method === 'POST') {
        // Best-effort: kalau ini sesi toko, langsung keluarkan device-nya dari PresenceTracker
        // juga supaya tidak "menggantung" terhitung sebagai device aktif sampai timeout 5 jam.
        if (session && session.role === 'store' && session.sid) {
          try {
            const stub = getPresenceStub(env);
            await stub.fetch('https://presence/kick-device', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ storeId: session.storeId, deviceId: session.sid }),
            });
          } catch (e) {}
        }
        return json({ ok: true }, 200, { 'Set-Cookie': buildClearSessionCookie() });
      }

      // ===== SESSION/ME: dipakai frontend saat halaman dibuka untuk mengecek "apakah saya
      // masih login?", karena JavaScript TIDAK BISA lagi membaca cookie HttpOnly secara
      // langsung untuk mengetahuinya sendiri (itu justru intinya -- lihat catatan XSS di atas).
      if (path === '/api/session/me' && request.method === 'GET') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        if (session.role === 'admin') return json({ ok: true, role: 'admin', uid: session.uid });
        const info = await rtdbReadPath(env, `stores/${session.storeId}/info`);
        if (!info || info.active === false) return json({ error: 'Akun toko tidak aktif' }, 403);
        return json({ ok: true, role: 'store', storeId: session.storeId, storeInfo: info });
      }

      // ===== SALES HISTORY =====
      if (path === '/api/history' && request.method === 'POST') {
        const body = await request.json();
        const id = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO sales_history (id, store_id, timestamp, data) VALUES (?,?,?,?)')
          .bind(id, body.storeId, Date.now(), JSON.stringify(body)).run();
        return json({ ok: true, id });
      }
      if (path === '/api/history' && request.method === 'GET') {
        const storeId = url.searchParams.get('storeId');
        const { results } = await env.DB.prepare('SELECT * FROM sales_history WHERE store_id = ? ORDER BY timestamp DESC LIMIT 200')
          .bind(storeId).all();
        return json({ ok: true, items: results.map(r => ({ id: r.id, timestamp: r.timestamp, ...JSON.parse(r.data) })) });
      }

      // ===== CHAT REALTIME — HTTP LONG-POLLING lewat Durable Object (2026-07-20) =====
      // SENGAJA BUKAN WebSocket — WS sering diblokir/di-drop oleh proxy kantor, sekolah,
      // firewall jaringan seluler tertentu (upgrade Connection: Upgrade suka ditolak),
      // sehingga chat malah jadi tidak jalan sama sekali di jaringan begitu. Long-polling
      // cuma request GET/POST HTTP biasa — dari sisi jaringan/proxy TIDAK ADA BEDANYA
      // dengan fetch API biasa, jadi kompatibel di jaringan manapun. Cara kerja:
      //   1) Client kirim GET /api/chat/wait?v=<versi_terakhir_yg_dia_tahu>
      //   2) Kalau versi di server SUDAH beda -> Worker balas LANGSUNG (instan).
      //   3) Kalau versi masih SAMA -> request "digantung" (ditahan, belum dibalas) di
      //      Durable Object sampai ADA pesan baru (langsung dibangunkan saat itu juga),
      //      ATAU maksimal ~30 detik lalu dibalas "tidak ada perubahan" supaya client bisa
      //      langsung buka request baru lagi (mencegah 1 request nyangkut selamanya).
      //   4) Client, begitu dapat balasan (baik karena ada pesan BARU atau timeout kosong),
      //      LANGSUNG buka lagi GET /api/chat/wait berikutnya (loop). Efeknya terasa
      //      real-time (delay cuma round-trip network, bukan 15 detik lagi) tapi tetap
      //      100% HTTP biasa, tanpa WebSocket sama sekali.
      // WAJIB: binding Durable Object CHAT_HUB didaftarkan di wrangler.toml, sama seperti
      // PRESENCE_DO:
      //   [[durable_objects.bindings]]
      //   name = "CHAT_HUB"
      //   class_name = "ChatHub"
      //   [[migrations]]
      //   tag = "v2"
      //   new_classes = ["ChatHub"]
      function getChatHubStub(env) {
        const id = env.CHAT_HUB.idFromName('global');
        return env.CHAT_HUB.get(id);
      }

      // Dipanggil setiap ada pesan baru terkirim (lihat POST /api/chat di bawah) supaya
      // SEMUA client yang sedang "menggantung" di /api/chat/wait langsung dibangunkan
      // saat itu juga — inilah bagian yang bikin terasa real-time.
      async function bumpChatHub(env, storeId, event) {
        const stub = getChatHubStub(env);
        await stub.fetch('https://chat-hub/bump', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId, event }),
        });
      }

      if (path === '/api/chat/wait' && request.method === 'GET') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        // Toko cuma boleh "menunggu" pesan toko sendiri. Admin bisa nunggu 1 toko spesifik
        // (waktu lagi buka jendela chat toko itu) ATAU semua toko sekaligus (waktu di
        // halaman daftar chat, untuk update badge unread real-time tanpa buka satu-satu).
        const storeId = session.role === 'store' ? session.storeId : url.searchParams.get('storeId');
        const watchAll = session.role === 'admin' && !storeId;
        const sinceVersion = parseInt(url.searchParams.get('v') || '0', 10) || 0;
        const stub = getChatHubStub(env);
        const waitUrl = `https://chat-hub/wait?since=${sinceVersion}${watchAll ? '&all=1' : `&storeId=${encodeURIComponent(storeId)}`}`;
        const res = await stub.fetch(waitUrl);
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }

      // ===== PRESENCE (status online/offline toko) — Durable Object =====
      // Disimpan murni di MEMORI Durable Object (Map biasa), TIDAK PERNAH menyentuh
      // this.state.storage atau D1 sama sekali — presence untuk 100 toko sekalipun, dengan
      // heartbeat sesering apa pun, TIDAK numpang ke limit "Rows Written" D1 SAMA SEKALI.
      // WAJIB: binding Durable Object PRESENCE_DO didaftarkan lewat Wrangler CLI (lihat
      // wrangler.toml + workflow deploy-worker.yml) — TIDAK BISA lewat Dashboard biasa.
      function getPresenceStub(env) {
        const id = env.PRESENCE_DO.idFromName('global');
        return env.PRESENCE_DO.get(id);
      }

      // ===== ANTI BRUTE-FORCE LOGIN — numpang di Durable Object yang sama =====
      // 5x salah dalam 15 menit -> dikunci 15 menit. Dicek per akun (supaya 1 akun tidak
      // digempur dari banyak IP) DAN per IP (supaya 1 IP tidak menggempur banyak akun).
      async function loginGuardCheck(env, keys) {
        const stub = getPresenceStub(env);
        for (const key of keys) {
          const res = await stub.fetch('https://presence/login-check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
          });
          const data = await res.json();
          if (!data.allowed) return data;
        }
        return { allowed: true };
      }
      async function loginGuardFail(env, keys) {
        const stub = getPresenceStub(env);
        await Promise.all(keys.map(key => stub.fetch('https://presence/login-fail', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
        })));
      }
      async function loginGuardSuccess(env, keys) {
        const stub = getPresenceStub(env);
        await Promise.all(keys.map(key => stub.fetch('https://presence/login-success', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
        })));
      }

      if (path === '/api/presence/ping' && request.method === 'POST') {
        if (!session || session.role !== 'store') return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const stub = getPresenceStub(env);
        const res = await stub.fetch('https://presence/ping', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // KEAMANAN: pakai session.sid (dari cookie yang sudah diverifikasi tanda tangannya),
          // BUKAN body.deviceId kiriman client -- client tidak bisa lagi mengaku-aku sebagai
          // device lain hanya dengan mengganti nilai yang dikirim di body request.
          body: JSON.stringify({ storeId: session.storeId, storeName: body.storeName || '', deviceId: session.sid || null }),
        });
        // deviceValid:false artinya device ini sudah ditendang (kelebihan 2 device/toko) ATAU
        // sudah lebih dari 5 jam tidak mengirim heartbeat — client WAJIB logout otomatis saat menerima ini.
        const data = await res.json().catch(() => ({ ok: true, deviceValid: true }));
        return json(data);
      }

      if (path === '/api/presence/offline' && request.method === 'POST') {
        if (!session || session.role !== 'store') return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const stub = getPresenceStub(env);
        await stub.fetch('https://presence/offline', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: session.storeId, deviceId: session.sid || null }),
        });
        return json({ ok: true });
      }

      if (path === '/api/presence/status' && request.method === 'GET') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const stub = getPresenceStub(env);
        const res = await stub.fetch('https://presence/status');
        const data = await res.json();
        return json(data);
      }

      // ===== FITUR ADMIN: MENU "PERANGKAT" — monitor & logout paksa device (2026-08-06) =====
      // Menampilkan SEMUA device yang sedang tercatat login di setiap toko (deviceId, waktu
      // login, terakhir aktif, status aktif/tidak). Tidak ada lagi batas 2 device/toko —
      // menu ini murni untuk MEMANTAU, dan Admin bisa logout paksa device tertentu yang
      // dianggap tidak dikenali/mencurigakan lewat /api/admin/devices/kick di bawah.
      if (path === '/api/admin/devices' && request.method === 'GET') {
        if (!session || session.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
        const stub = getPresenceStub(env);
        const res = await stub.fetch('https://presence/devices');
        const data = await res.json();
        return json(data);
      }

      if (path === '/api/admin/devices/kick' && request.method === 'POST') {
        if (!session || session.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.storeId || !body.deviceId) return json({ error: 'storeId & deviceId wajib' }, 400);
        const stub = getPresenceStub(env);
        await stub.fetch('https://presence/kick-device', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: body.storeId, deviceId: body.deviceId }),
        });
        return json({ ok: true });
      }

      // ===== MEDIA (FOTO/VIDEO) DI R2 =====
      // Dipakai untuk foto Laporan (Waste/Rijek, media SOP) supaya TIDAK lagi disimpan
      // sebagai base64 di D1 (yang bikin database berat & gampang kena limit ukuran baris).
      // Sekarang cuma reference (key) yang disimpan di D1; file aslinya di R2 bucket "MEDIA".

      // Upload satu file biner. Body = file mentah (bukan JSON), query: ?folder=...&ext=jpg
      if (path === '/api/media/upload' && request.method === 'POST') {
        const folder = (url.searchParams.get('folder') || 'misc').replace(/[^a-zA-Z0-9/_-]/g, '');
        const ext = (url.searchParams.get('ext') || 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
        const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

        // KEAMANAN (2026-07-19): sebelumnya endpoint ini menerima file APA SAJA, ukuran
        // BERAPA SAJA, dari siapa pun yang punya token login (walau sudah lewat kompresi
        // di app, token yang bocor/dicuri tetap bisa dipakai upload file raksasa berulang-
        // ulang untuk menghabiskan storage R2). Sekarang dibatasi: hanya gambar/video, maks
        // 15 MB per file (jauh di atas hasil kompresi normal ~1-2 MB, jadi tidak mengganggu
        // pemakaian normal, tapi cukup ketat untuk mencegah penyalahgunaan).
        const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];
        if (!ALLOWED_TYPES.some(t => contentType.startsWith(t))) {
          return json({ error: 'Tipe file tidak diizinkan. Hanya gambar/video yang boleh diupload.' }, 415);
        }
        const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
        const declaredLength = parseInt(request.headers.get('Content-Length') || '0', 10);
        if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
          return json({ error: 'File terlalu besar (maksimal 15 MB).' }, 413);
        }

        const key = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        const body = await request.arrayBuffer();
        if (!body || body.byteLength === 0) return json({ error: 'File kosong' }, 400);
        if (body.byteLength > MAX_UPLOAD_BYTES) return json({ error: 'File terlalu besar (maksimal 15 MB).' }, 413);
        await env.MEDIA.put(key, body, { httpMetadata: { contentType } });
        return json({ ok: true, key });
      }

      // Hapus satu atau beberapa key sekaligus. Body: { key: "..." } atau { keys: ["...", "..."] }
      if (path === '/api/media/delete' && request.method === 'POST') {
        const body = await request.json();
        const keys = body.keys && Array.isArray(body.keys) ? body.keys : (body.key ? [body.key] : []);
        const clean = keys.filter(Boolean);
        if (clean.length === 0) return json({ ok: true, deleted: 0 });
        await env.MEDIA.delete(clean);
        return json({ ok: true, deleted: clean.length });
      }

      // ===== PUSH NOTIFICATION TOKEN (APK Capacitor) =====
      // Dipanggil dari app native setelah dapat FCM token, supaya Worker tahu "device ini
      // milik toko/admin siapa" dan bisa mengirim push saat ada kejadian (chat baru, dst).
      if (path === '/api/push/register' && request.method === 'POST') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const { fcmToken, platform } = await request.json();
        if (!fcmToken) return json({ error: 'fcmToken wajib diisi' }, 400);
        const ownerType = session.role; // 'admin' | 'store'
        const ownerId = session.role === 'admin' ? session.uid : session.storeId;
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO push_tokens (id, owner_type, owner_id, fcm_token, platform, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fcm_token) DO UPDATE SET owner_type=excluded.owner_type, owner_id=excluded.owner_id, updated_at=excluded.updated_at`
        ).bind(crypto.randomUUID(), ownerType, ownerId, fcmToken, platform || 'android', now, now).run();
        return json({ ok: true });
      }
      if (path === '/api/push/unregister' && request.method === 'POST') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const { fcmToken } = await request.json();
        if (fcmToken) await env.DB.prepare('DELETE FROM push_tokens WHERE fcm_token = ?').bind(fcmToken).run();
        return json({ ok: true });
      }

      // ===== CHAT (dirombak 2026-07-19: dulu app ini sebenarnya TIDAK memakai endpoint ini
      // sama sekali — chat jalan lewat jalur generic rtdb 'chats/...' yang bikin admin
      // membaca SELURUH riwayat pesan SEMUA toko tiap 15 detik. Sekarang endpoint di bawah
      // ini yang dipakai index.html, dengan tambahan tabel ringkasan chat_summary supaya
      // listener badge/notifikasi admin cukup baca ~100 baris ringkasan, bukan ribuan baris
      // isi pesan. =====

      if (path === '/api/chat' && request.method === 'GET') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        // Toko cuma boleh baca chat-nya sendiri (tidak bisa intip chat toko lain lewat
        // ganti-ganti query param storeId); admin boleh baca chat toko manapun.
        const storeId = session.role === 'store' ? session.storeId : url.searchParams.get('storeId');
        if (!storeId) return json({ error: 'storeId wajib' }, 400);
        // LIMIT beneran diterapkan di server (bukan cuma dipotong belakangan di HP seperti
        // limitToLast() versi lama) — jadi biarpun riwayat chat toko itu ribuan pesan, yang
        // ke-scan/ke-baca dari D1 tetap dibatasi.
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 300);
        const { results } = await env.DB.prepare(
          'SELECT * FROM chat_messages WHERE store_id = ? ORDER BY timestamp DESC LIMIT ?'
        ).bind(storeId, limit).all();
        results.reverse(); // supaya urutannya tetap lama->baru seperti sebelumnya
        return json({ ok: true, messages: results });
      }

      if (path === '/api/chat' && request.method === 'POST') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        // Jangan percaya storeId/sender kiriman client mentah-mentah — ambil dari session
        // supaya toko tidak bisa kirim pesan mengatasnamakan toko lain / berpura-pura jadi admin.
        const storeId = session.role === 'store' ? session.storeId : body.storeId;
        const sender = session.role === 'store' ? 'store' : 'admin';
        const senderLabel = session.role === 'store' ? (body.senderLabel || storeId) : 'Admin';
        const text = String(body.text || '').slice(0, 4000);
        if (!storeId || !text.trim()) return json({ error: 'storeId dan text wajib diisi' }, 400);

        const id = crypto.randomUUID();
        const now = Date.now();
        await env.DB.prepare('INSERT INTO chat_messages (id, store_id, sender, sender_label, text, timestamp) VALUES (?,?,?,?,?,?)')
          .bind(id, storeId, sender, senderLabel, text, now).run();

        // Perbarui ringkasan (1 baris per toko) — inilah yang bikin listener badge admin
        // murah dibaca, tidak perlu buka seluruh isi pesan tiap toko.
        const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
        await env.DB.prepare(
          `INSERT INTO chat_summary (store_id, last_message_at, last_sender, last_sender_label, last_text, last_message_id, unread_for_admin, unread_for_store, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(store_id) DO UPDATE SET
             last_message_at = excluded.last_message_at,
             last_sender = excluded.last_sender,
             last_sender_label = excluded.last_sender_label,
             last_text = excluded.last_text,
             last_message_id = excluded.last_message_id,
             unread_for_admin = unread_for_admin + ?,
             unread_for_store = unread_for_store + ?,
             updated_at = excluded.updated_at`
        ).bind(
          storeId, now, sender, senderLabel, preview, id,
          sender === 'store' ? 1 : 0, sender === 'admin' ? 1 : 0, now,
          sender === 'store' ? 1 : 0, sender === 'admin' ? 1 : 0
        ).run();

        // Bangunkan SEMUA request /api/chat/wait yang sedang "menggantung" untuk toko ini —
        // inilah yang bikin lawan bicara langsung terima pesan detik itu juga (tanpa nunggu
        // interval poll), tapi tetap murni HTTP biasa (lihat penjelasan di getChatHubStub).
        // Ditaruh di ctx.waitUntil juga supaya pengirim tidak ikut menunggu proses ini.
        ctx.waitUntil(bumpChatHub(env, storeId, {
          id, sender, senderLabel, text, timestamp: now,
        }));

        // Kirim push notification ke lawan bicara (waitUntil supaya pengirim tidak nunggu).
        // Ini KHUSUS untuk kondisi app/tab TIDAK sedang terbuka (mobile app di-background/
        // ditutup) — lewat FCM. Kalau app-nya lagi kebuka, notifikasi datang lewat jalur
        // /api/chat/wait di atas (lebih cepat, tidak perlu nunggu FCM).
        if (sender === 'store') {
          ctx.waitUntil(notifyAllAdminsPush(env, `💬 Pesan dari ${senderLabel}`, preview, { type: 'chat', storeId }));
        } else {
          ctx.waitUntil(notifyOwnerPush(env, 'store', storeId, '💬 Pesan dari Admin', preview, { type: 'chat', storeId }));
        }

        // Beres-beres kecil: 1 dari ~20 pesan (5%), buang pesan toko ini yang lebih tua dari
        // 30 hari. Diacak (bukan tiap kali) supaya tidak menambah beban ke setiap pengiriman
        // pesan, tapi tetap rutin membuat tabel tidak membengkak selamanya.
        if (Math.random() < 0.05) {
          const cutoff = now - 30 * 24 * 60 * 60 * 1000;
          ctx.waitUntil(env.DB.prepare('DELETE FROM chat_messages WHERE store_id = ? AND timestamp < ?').bind(storeId, cutoff).run());
        }

        return json({ ok: true, id });
      }

      // Admin mengakhiri sesi chat: hapus semua pesan toko ini + reset ringkasannya.
      if (path === '/api/chat/end-session' && request.method === 'POST') {
        if (!session || session.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const storeId = body.storeId;
        if (!storeId) return json({ error: 'storeId wajib' }, 400);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM chat_messages WHERE store_id = ?').bind(storeId),
          env.DB.prepare('DELETE FROM chat_summary WHERE store_id = ?').bind(storeId),
        ]);
        return json({ ok: true });
      }

      // Ringkasan chat — INI yang dipoll tiap 15 detik (bukan isi pesannya), jauh lebih murah:
      // ~1 baris per toko, bukan ribuan baris pesan.
      if (path === '/api/chat/summary' && request.method === 'GET') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        if (session.role === 'store') {
          const row = await env.DB.prepare('SELECT * FROM chat_summary WHERE store_id = ?').bind(session.storeId).first();
          return json({ ok: true, summary: row || null });
        }
        const { results } = await env.DB.prepare('SELECT * FROM chat_summary').all();
        const map = {};
        results.forEach(r => { map[r.store_id] = r; });
        return json({ ok: true, summary: map });
      }

      // Reset counter unread saat admin/toko benar-benar membuka percakapan itu.
      if (path === '/api/chat/mark-read' && request.method === 'POST') {
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const storeId = session.role === 'store' ? session.storeId : body.storeId;
        if (!storeId) return json({ error: 'storeId wajib' }, 400);
        const field = session.role === 'store' ? 'unread_for_store' : 'unread_for_admin';
        await env.DB.prepare(`UPDATE chat_summary SET ${field} = 0 WHERE store_id = ?`).bind(storeId).run();
        return json({ ok: true });
      }

      // ===== VIEW COUNTER (batched lewat Durable Object — hemat D1 Rows Written) =====
      // TIDAK melakukan UPDATE ... SET views = views + 1 langsung ke D1 di sini. Setiap
      // request cuma mengirim 1 pesan super murah (in-memory) ke Durable Object bernama
      // "view-counter-shard" yang menumpuk semua increment dan baru menuliskannya ke D1
      // secara massal lewat alarm(). Lihat class ViewCounter di bagian bawah file.
      // target format: "store:<storeId>" atau "product:<storeId>:<productId>"
      if (path.startsWith('/api/view/') && request.method === 'POST') {
        const target = decodeURIComponent(path.slice('/api/view/'.length)).replace(/\/+$/, '');
        if (!target) return json({ error: 'target wajib diisi' }, 400);

        // 1 shard tunggal cukup untuk skala ~100 toko (throughput 1 DO jauh di atas kebutuhan
        // view counter). Kalau nanti mau scale lebih jauh, ganti idFromName(target) supaya
        // tiap toko/produk punya shard DO sendiri-sendiri (paralel, tapi tetap sama-sama batched).
        const id = env.VIEW_COUNTER.idFromName('view-counter-shard');
        const stub = env.VIEW_COUNTER.get(id);
        // Fire-and-forget: tidak perlu await penuh siklus DO, cukup pastikan pesannya terkirim.
        ctx.waitUntil(stub.fetch(`https://do-view-counter/increment?target=${encodeURIComponent(target)}`));
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      // Kalau error sengaja dilempar dengan status tertentu (mis. 403 dari requireRole/
      // assertPathWritable di bawah -- RBAC terpusat), pakai status itu, bukan selalu 500.
      const status = (err && typeof err.status === 'number') ? err.status : 500;
      return json({ error: err.message, stack: (err.stack || '').split('\n').slice(0, 5) }, status);
    }
  },

  // Dipicu oleh Cron Trigger Cloudflare (bukan request HTTP biasa). Wajib didaftarkan di
  // wrangler.toml, lihat komentar di atas fungsi sendPreOrderReminders untuk contohnya.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendPreOrderReminders(env));
  },
};

// =====================================================================
// DURABLE OBJECT: ViewCounter
// Menampung increment view count di memori/storage DO (BUKAN di D1), lalu menuliskannya
// ke D1 secara massal (batch) lewat alarm setiap FLUSH_INTERVAL_MS sekali.
//
// Kenapa ini menghemat D1 Rows Written:
// - Tanpa ini: 1000x pageview/menit = 1000x UPDATE ke D1 = 1000 Rows Written.
// - Dengan ini: 1000x pageview/menit numpuk jadi in-memory counter di DO (operasi ini GRATIS,
//   tidak menyentuh D1 sama sekali), lalu alarm menulis SEKALI per target yang berubah, jadi
//   kalau dalam 1 menit itu cuma ada, misalnya, 15 store/produk berbeda yang di-view, maka
//   hanya 15 Rows Written per menit — bukan 1000.
// - DO storage sendiri (state.storage) TIDAK termasuk D1, jadi menumpuk data di sana sebelum
//   di-flush juga tidak memakan kuota D1.
// =====================================================================
// ===== DURABLE OBJECT: DataVersion (version-check murah untuk cache browser) =====
// Menyimpan nomor versi per "kunci" (per-toko, atau per-top-level-key) murni di MEMORI
// (Map biasa) — sama pola dengan ChatHub/PresenceTracker, TIDAK menyentuh D1/storage sama
// sekali. Cuma 1 instance untuk seluruh app (idFromName('global')).
// Kalau DO ini di-restart Cloudflare (jarang), semua versi reset ke 0 — TIDAK berbahaya:
// client yang cache lokalnya "lebih tinggi" dari 0 otomatis dianggap "beda", jadi paling
// buruk cuma 1x fetch data penuh ekstra per kunci yang aktif (self-healing), TIDAK PERNAH
// menyebabkan data basi ditampilkan selamanya.
export class DataVersion {
  constructor(state) {
    this.state = state;
    this.versions = new Map(); // key -> angka versi, naik terus tiap ada tulisan
  }
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/bump' && request.method === 'POST') {
        const { keys } = await request.json();
        const out = {};
        for (const k of (keys || [])) {
          const v = (this.versions.get(k) || 0) + 1;
          this.versions.set(k, v);
          out[k] = v;
        }
        return new Response(JSON.stringify({ ok: true, versions: out }));
      }
      if (url.pathname === '/get' && request.method === 'GET') {
        const keysParam = url.searchParams.get('keys') || '';
        const keys = keysParam.split(',').filter(Boolean);
        const out = {};
        for (const k of keys) out[k] = this.versions.get(k) || 0;
        return new Response(JSON.stringify({ ok: true, versions: out }));
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }
}

// ===== DURABLE OBJECT: ChatHub (long-polling, BUKAN WebSocket) =====
// Menyimpan versi chat per toko murni di MEMORI (Map biasa) — sama seperti PresenceTracker,
// TIDAK menyentuh this.state.storage/D1 sama sekali. Cuma 1 instance untuk seluruh app
// (dipanggil selalu dengan idFromName('global')). Kalau DO ini di-restart oleh Cloudflare
// (jarang), versi reset ke 0 — TIDAK masalah, client yang sedang connect otomatis dapat
// "versi baru" di respons berikutnya dan lanjut seperti biasa (tidak ada pesan yang hilang,
// karena isi pesan aslinya tetap ada di D1 lewat GET /api/chat, DO ini cuma alarm penanda
// "ada yang berubah, buruan reload").
export class ChatHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storeVersion = new Map(); // storeId -> versi (angka naik terus)
    this.globalVersion = 0;        // naik tiap kali ADA toko manapun yang versi-nya naik
    this.lastEvent = new Map();    // storeId -> payload pesan terakhir (buat toast instan)
    this.waiters = [];             // { storeId|null (null = watch semua), resolve }
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/bump' && request.method === 'POST') {
        const { storeId, event } = await request.json();
        if (!storeId) return new Response(JSON.stringify({ error: 'storeId wajib' }), { status: 400 });
        const v = (this.storeVersion.get(storeId) || 0) + 1;
        this.storeVersion.set(storeId, v);
        this.globalVersion += 1;
        this.lastEvent.set(storeId, event || null);

        // Bangunkan semua waiter yang cocok: waiter spesifik toko ini, ATAU waiter "watch
        // semua toko" (dipakai admin di halaman daftar chat untuk badge unread real-time).
        const stillWaiting = [];
        for (const w of this.waiters) {
          if (w.storeId === storeId || w.storeId === null) {
            w.resolve({ changed: true, version: w.storeId === null ? this.globalVersion : v, storeId, event });
          } else {
            stillWaiting.push(w);
          }
        }
        this.waiters = stillWaiting;
        return new Response(JSON.stringify({ ok: true, version: v }));
      }

      if (url.pathname === '/wait' && request.method === 'GET') {
        const watchAll = url.searchParams.get('all') === '1';
        const storeId = watchAll ? null : url.searchParams.get('storeId');
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        if (!watchAll && !storeId) return new Response(JSON.stringify({ error: 'storeId wajib' }), { status: 400 });

        const currentVersion = watchAll ? this.globalVersion : (this.storeVersion.get(storeId) || 0);

        // Kalau sudah ada perubahan sejak versi terakhir yang client tahu -> balas LANGSUNG,
        // tidak perlu digantung sama sekali.
        if (currentVersion !== since) {
          const event = watchAll ? null : (this.lastEvent.get(storeId) || null);
          return new Response(JSON.stringify({ changed: true, version: currentVersion, storeId, event }));
        }

        // Belum ada perubahan -> gantung request ini (jangan langsung dibalas), maksimal
        // WAIT_TIMEOUT_MS. Selama itu, kalau /bump dipanggil untuk toko yang cocok, promise
        // ini langsung resolve saat itu juga (lihat blok /bump di atas).
        const WAIT_TIMEOUT_MS = 30_000;
        const result = await new Promise((resolve) => {
          const waiter = { storeId, resolve };
          this.waiters.push(waiter);
          setTimeout(() => {
            // Kalau timeout duluan (bukan dibangunkan /bump), buang diri sendiri dari
            // daftar waiter supaya tidak numpuk memory, lalu balas "tidak ada perubahan".
            this.waiters = this.waiters.filter(w => w !== waiter);
            resolve({ changed: false, version: currentVersion, storeId });
          }, WAIT_TIMEOUT_MS);
        });
        return new Response(JSON.stringify(result));
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }
}

export class ViewCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/increment') {
      const target = url.searchParams.get('target');
      if (!target) return new Response('target wajib diisi', { status: 400 });

      // Numpuk increment di DO storage (bukan di D1). DO storage punya jaminan durability
      // sendiri dari Cloudflare, jadi aman walau belum sempat di-flush ke D1.
      const pending = (await this.state.storage.get('pending')) || {};
      pending[target] = (pending[target] || 0) + 1;
      await this.state.storage.put('pending', pending);

      // Jadwalkan alarm HANYA kalau belum ada alarm aktif, supaya batch window konsisten
      // (mis. selalu flush maksimal 60 detik sekali, bukan reset terus tiap ada view baru).
      const existingAlarm = await this.state.storage.getAlarm();
      if (existingAlarm === null) {
        const FLUSH_INTERVAL_MS = 60_000; // ubah sesuai kebutuhan (mis. 5 menit = 300000)
        await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      }

      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  // Dipanggil otomatis oleh Cloudflare saat alarm terpicu — di sinilah satu-satunya tempat
  // kita benar-benar menulis ke D1, dan itu pun sudah digabung jadi 1 batch.
  async alarm() {
    const pending = (await this.state.storage.get('pending')) || {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return;

    // Hapus dulu SEBELUM menulis, supaya kalau ada view baru masuk selagi batch ini diproses,
    // dia numpuk ke batch berikutnya (bukan ikut campur / ke-double-count ke batch ini).
    await this.state.storage.delete('pending');

    const stmts = entries.map(([target, count]) =>
      this.env.DB.prepare(
        `INSERT INTO view_counters (target, views, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(target) DO UPDATE SET views = views + ?, updated_at = ?`
      ).bind(target, count, Date.now(), count, Date.now())
    );

    // Tetap di-chunk 50 per batch, konsisten dengan runBatched() di router utama.
    for (let i = 0; i < stmts.length; i += 50) {
      await this.env.DB.batch(stmts.slice(i, i + 50));
    }
  }
}


// ===== DURABLE OBJECT: PresenceTracker =====
// Menyimpan status online/offline SEMUA toko di MEMORI (Map biasa) sebagai sumber utama
// untuk baca/tulis super cepat, TIDAK pernah menyentuh D1 sama sekali — jadi presence
// untuk 100 toko sekalipun, dengan heartbeat sesering apa pun, TIDAK numpang ke limit
// "Rows Written" D1 SAMA SEKALI. Hanya ada 1 instance objek ini untuk seluruh aplikasi
// (dipanggil selalu dengan idFromName('global') dari worker.js), supaya semua toko
// baca/tulis ke tempat yang sama.
//
// BUGFIX (2026-07-20): sebelumnya data ini MURNI di memori tanpa disimpan ke mana pun.
// Asumsinya "toko yang masih aktif akan otomatis muncul lagi begitu Durable Object
// restart" — TAPI itu keliru untuk toko yang SEDANG OFFLINE: begitu Durable Object
// direstart Cloudflare (bisa terjadi tiap kali worker di-deploy ulang, atau kalau lama
// tidak ada traffic sama sekali), seluruh riwayat "terakhir aktif" SEMUA toko ikut hilang
// bersamaan — bukan cuma yang sedang online. Efeknya: toko yang sebelumnya sudah punya
// "Terakhir aktif: ..." tiba-tiba balik ke "Belum pernah aktif" tanpa sebab yang terlihat
// oleh Admin. Sekarang data ini juga di-flush ke this.state.storage (storage BAWAAN
// Durable Object, BUKAN D1 — jadi tetap tidak numpang limit Rows D1) secara BERKALA lewat
// Alarm, bukan setiap ping (supaya tidak menambah biaya/latensi per-heartbeat), dan
// dimuat balik ke memori saat instance baru dibuat (constructor -> blockConcurrencyWhile)
// SEBELUM request apa pun diproses. Hasilnya: walau Durable Object direstart, data
// "terakhir aktif" toko manapun tetap ada persis seperti sebelum restart.
const PRESENCE_FLUSH_INTERVAL_MS = 20 * 1000; // simpan ke storage paling sering tiap 20 detik

// ===== MONITOR DEVICE PER TOKO + AUTO-LOGOUT TIDAK AKTIF (2026-07-20, diperbarui 2026-08-06) =====
// PEMBARUAN (2026-08-06): aturan "maksimal 2 device/toko" DIHAPUS atas permintaan — satu toko
// sekarang BOLEH login di berapa pun device secara bersamaan, tidak ada lagi login yang ditolak
// atau device yang otomatis ditendang hanya karena kelebihan slot. Device HANYA dikeluarkan dari
// daftar kalau: (a) memang sudah tidak mengirim heartbeat sama sekali selama lebih dari
// DEVICE_INACTIVITY_MS ("tidak aktif"), atau (b) dikeluarkan MANUAL oleh Admin lewat menu
// "Perangkat" di Panel Admin (lihat handler /devices dan /kick-device di bawah, serta rute
// /api/admin/devices & /api/admin/devices/kick di fungsi fetch utama worker ini).
const DEVICE_INACTIVITY_MS = 5 * 60 * 60 * 1000; // 5 jam

// Dipakai HANYA untuk keperluan tampilan monitoring Admin (menandai device "Aktif" vs
// "Tidak Aktif" di menu Perangkat) — device dianggap masih aktif kalau heartbeat terakhirnya
// masih dalam rentang ini. TIDAK lagi dipakai untuk menendang/menolak login siapa pun.
const DEVICE_ACTIVE_GRACE_MS = 10 * 60 * 1000; // 10 menit

export class PresenceTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.online = new Map(); // storeId -> { lastSeen, storeName, isOnline }
    this.devices = new Map(); // storeId -> [{ deviceId, loginAt, lastSeen }, ...] (maks MAX_DEVICES_PER_STORE)
    this.loginAttempts = new Map(); // key -> { count, windowStart, lockedUntil }
    this.dirty = false; // ada perubahan sejak flush terakhir?
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get('online');
      if (saved) this.online = new Map(Object.entries(saved));
      const savedDevices = await this.state.storage.get('devices');
      if (savedDevices) this.devices = new Map(Object.entries(savedDevices));
    });
  }

  // Jadwalkan penulisan ke storage (kalau belum ada jadwal aktif), digabung jadi SATU
  // write per PRESENCE_FLUSH_INTERVAL_MS berapa pun banyaknya ping yang masuk di rentang
  // itu — supaya tetap hemat walau heartbeat datang dari banyak toko sekaligus.
  async scheduleFlush() {
    this.dirty = true;
    const existingAlarm = await this.state.storage.getAlarm();
    if (existingAlarm === null) {
      await this.state.storage.setAlarm(Date.now() + PRESENCE_FLUSH_INTERVAL_MS);
    }
  }

  async alarm() {
    if (this.dirty) {
      await this.state.storage.put('online', Object.fromEntries(this.online));
      await this.state.storage.put('devices', Object.fromEntries(this.devices));
      this.dirty = false;
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    try {
      if (url.pathname === '/ping' && request.method === 'POST') {
        const { storeId, storeName, deviceId } = await request.json();
        if (!storeId) return new Response(JSON.stringify({ error: 'storeId wajib' }), { status: 400 });
        const prev = this.online.get(storeId);
        this.online.set(storeId, { lastSeen: Date.now(), storeName: storeName || (prev && prev.storeName) || '', isOnline: true });

        // ===== Cek limit device + auto-logout tidak aktif 5 jam, numpang di heartbeat ini =====
        let deviceValid = true;
        let reason = null;
        if (deviceId) {
          const now = Date.now();
          const list = this.devices.get(storeId) || [];
          const idx = list.findIndex(d => d.deviceId === deviceId);
          if (idx === -1) {
            // Device ini tidak (lagi) terdaftar -> dikeluarkan MANUAL oleh Admin lewat menu
            // "Perangkat" (lihat /kick-device di atas), atau memang belum pernah /device-login.
            deviceValid = false;
            reason = 'admin-kicked';
          } else if (now - list[idx].lastSeen > DEVICE_INACTIVITY_MS) {
            // Sudah lebih dari 5 jam sejak heartbeat terakhir device ini -> anggap sesi habis.
            list.splice(idx, 1);
            this.devices.set(storeId, list);
            deviceValid = false;
            reason = 'inactive-timeout';
          } else {
            list[idx].lastSeen = now;
            this.devices.set(storeId, list);
          }
        }

        await this.scheduleFlush();
        return new Response(JSON.stringify({ ok: true, deviceValid, reason }));
      }

      // ===== KERAS-KAN LOGIKA DEVICE: cek validitas sid TANPA efek samping =====
      // Dipanggil dari gerbang otorisasi utama (worker.js) pada SETIAP request bersesi
      // 'store' -- bukan cuma saat heartbeat -- supaya device yang sudah di-kick Admin atau
      // sudah lewat 5 jam tidak aktif benar-benar kehilangan akses ke SEMUA endpoint,
      // bukan cuma diberi tahu (dan bisa diabaikan) lewat heartbeat seperti sebelumnya.
      // Sengaja TIDAK mengubah lastSeen/menghapus device di sini (murni baca) supaya
      // pemanggilan berulang-ulang di setiap request tidak mengganggu jadwal flush storage.
      if (url.pathname === '/sid-valid' && request.method === 'POST') {
        const { storeId, sid } = await request.json();
        if (!storeId || !sid) return new Response(JSON.stringify({ valid: false }));
        const list = this.devices.get(storeId) || [];
        const found = list.find(d => d.deviceId === sid);
        if (!found) return new Response(JSON.stringify({ valid: false, reason: 'kicked-or-unknown' }));
        if (Date.now() - found.lastSeen > DEVICE_INACTIVITY_MS) {
          return new Response(JSON.stringify({ valid: false, reason: 'inactive-timeout' }));
        }
        return new Response(JSON.stringify({ valid: true }));
      }

      // Dipanggil sekali saat toko BERHASIL login (lihat /api/login/store di worker.js).
      // Mendaftarkan deviceId ke daftar device toko ini. TIDAK ADA LAGI limit jumlah device —
      // toko boleh login di device sebanyak apa pun secara bersamaan (lihat catatan
      // "PEMBARUAN 2026-08-06" di atas). Info userAgent/label dikirim opsional dari client
      // supaya Admin bisa mengenali device ini di menu "Perangkat" (mis. "Chrome - Android").
      if (url.pathname === '/device-login' && request.method === 'POST') {
        const { storeId, deviceId, deviceLabel } = await request.json();
        if (!storeId || !deviceId) return new Response(JSON.stringify({ ok: true }));
        const now = Date.now();
        const existing = this.devices.get(storeId) || [];
        const others = existing.filter(d => d.deviceId !== deviceId);
        others.push({ deviceId, deviceLabel: deviceLabel || '', loginAt: now, lastSeen: now });
        this.devices.set(storeId, others);
        await this.scheduleFlush();
        return new Response(JSON.stringify({ ok: true }));
      }

      // ===== FITUR ADMIN: MONITOR & LOGOUT PAKSA DEVICE (2026-08-06) =====
      // Dipanggil dari /api/admin/devices (lihat worker.js) untuk menampilkan daftar SEMUA
      // device yang sedang terdaftar login di setiap toko, lengkap dengan waktu login, waktu
      // terakhir aktif, dan status aktif/tidak-aktifnya (berdasarkan DEVICE_ACTIVE_GRACE_MS).
      if (url.pathname === '/devices' && request.method === 'GET') {
        const now = Date.now();
        const out = {};
        for (const [storeId, list] of this.devices.entries()) {
          out[storeId] = (list || []).map(d => ({
            deviceId: d.deviceId,
            deviceLabel: d.deviceLabel || '',
            loginAt: d.loginAt,
            lastSeen: d.lastSeen,
            isActive: (now - d.lastSeen) <= DEVICE_ACTIVE_GRACE_MS,
          }));
        }
        return new Response(JSON.stringify(out));
      }

      // Logout paksa 1 device tertentu milik 1 toko (dipicu Admin dari menu "Perangkat").
      // Device dihapus dari daftar; heartbeat berikutnya dari device itu akan menerima
      // deviceValid:false reason:'admin-kicked' sehingga client otomatis logout.
      if (url.pathname === '/kick-device' && request.method === 'POST') {
        const { storeId, deviceId } = await request.json();
        if (!storeId || !deviceId) return new Response(JSON.stringify({ error: 'storeId & deviceId wajib' }), { status: 400 });
        const list = (this.devices.get(storeId) || []).filter(d => d.deviceId !== deviceId);
        this.devices.set(storeId, list);
        await this.scheduleFlush();
        return new Response(JSON.stringify({ ok: true }));
      }

      if (url.pathname === '/offline' && request.method === 'POST') {
        const { storeId, deviceId } = await request.json();
        // BUGFIX (2026-07-20): sebelumnya baris ini this.online.delete(storeId) — menghapus
        // TOTAL data toko dari memori begitu offline, jadi lastSeen ikut lenyap dan Admin
        // selalu melihat "Belum pernah aktif" walau tokonya baru saja online. Sekarang data
        // TETAP disimpan (supaya "Terakhir aktif: ..." tetap muncul di Admin), hanya flag
        // isOnline yang diubah jadi false. lastSeen di-update ke waktu logout sebagai jejak
        // "terakhir aktif".
        if (storeId) {
          const prev = this.online.get(storeId);
          this.online.set(storeId, { lastSeen: Date.now(), storeName: (prev && prev.storeName) || '', isOnline: false });
          // Lepaskan slot device ini juga, supaya langsung bisa dipakai login device lain
          // tanpa perlu menunggu timeout 5 jam kalau memang logout manual/sengaja.
          if (deviceId) {
            const list = (this.devices.get(storeId) || []).filter(d => d.deviceId !== deviceId);
            this.devices.set(storeId, list);
          }
          await this.scheduleFlush();
        }
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/status' && request.method === 'GET') {
        const out = {};
        for (const [storeId, info] of this.online.entries()) {
          out[storeId] = { isOnline: !!info.isOnline, lastSeen: info.lastSeen, storeName: info.storeName };
        }
        return new Response(JSON.stringify(out));
      }

      // ===== Anti brute-force login =====
      const LOGIN_MAX_ATTEMPTS = 5;
      const LOGIN_WINDOW_MS = 15 * 60 * 1000;   // hitung percobaan dalam jendela 15 menit
      const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;  // dikunci 15 menit kalau kelewat batas

      if (url.pathname === '/login-check' && request.method === 'POST') {
        const { key } = await request.json();
        const rec = this.loginAttempts.get(key);
        const now = Date.now();
        if (rec && rec.lockedUntil && rec.lockedUntil > now) {
          return new Response(JSON.stringify({ allowed: false, retryAfterMs: rec.lockedUntil - now }));
        }
        return new Response(JSON.stringify({ allowed: true }));
      }
      if (url.pathname === '/login-fail' && request.method === 'POST') {
        const { key } = await request.json();
        const now = Date.now();
        let rec = this.loginAttempts.get(key);
        if (!rec || (now - rec.windowStart) > LOGIN_WINDOW_MS) {
          rec = { count: 0, windowStart: now, lockedUntil: 0 };
        }
        rec.count += 1;
        if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
        this.loginAttempts.set(key, rec);
        return new Response(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/login-success' && request.method === 'POST') {
        const { key } = await request.json();
        this.loginAttempts.delete(key);
        return new Response(JSON.stringify({ ok: true }));
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }
}
