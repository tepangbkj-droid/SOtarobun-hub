// Tarobun Service Worker
// Fungsi utama: mengaktifkan reg.showNotification() (wajib dipakai di Chrome Android)
// dan menangani klik pada notifikasi supaya membuka/fokus tab aplikasi.

const CACHE_NAME = 'tarobun-cache-v1';

self.addEventListener('install', (event) => {
  // Langsung aktif tanpa menunggu tab lama ditutup, supaya notifikasi bisa
  // langsung dipakai sejak kunjungan pertama tanpa perlu reload dua kali.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Jika suatu saat menambahkan Web Push (server-push, bukan hanya notifikasi lokal),
// event 'push' ini yang akan menampilkan notifikasinya.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch (e) { payload = { title: 'Tarobun', body: event.data.text() }; }
  const title = payload.title || 'Tarobun';
  const options = {
    body: payload.body || '',
    tag: 'tarobun-chat',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Saat notifikasi diklik: fokus ke tab yang sudah terbuka, atau buka tab baru jika belum ada.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
