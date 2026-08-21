# SnapLam Downloader — v3 (Socket.IO, real-time sungguhan)

## Cara menjalankan

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`.

## Perubahan dari v2 → v3

Polling (cek server tiap 3 detik) diganti **Socket.IO** — event terkirim
instan lewat WebSocket, tanpa jeda:

- `download:new` — riwayat/terminal log muncul instan di semua browser yang terbuka
- `stats:update` — statistik admin (Total/Sukses/Gagal) update instan
- `chat:new` — pesan chat muncul instan ke semua pengguna online
- `chat:cleared` — saat admin bersihkan chat, semua browser ikut bersih instan
- `broadcast:update` — pengumuman admin langsung muncul di semua layar user

Socket.IO memakai sesi login yang sama dengan HTTP (`express-session`)
lewat `io.engine.use(sessionMiddleware)`, jadi koneksi socket otomatis
ditolak kalau belum login.

## UI

Struktur, layout, warna, dan semua class Tailwind di `public/index.html`
dipertahankan **persis sama** seperti desain aslinya — hanya logika JavaScript
di bagian bawah yang diganti dari simulasi/polling menjadi Socket.IO.

## Struktur data

Sama seperti v2 — data tetap disimpan di file JSON (`data/*.json`) untuk
persistensi (chat/riwayat/broadcast tidak hilang saat server restart),
tapi pengiriman ke browser sekarang lewat event Socket.IO, bukan polling.

## Sebelum production

1. Ganti `SESSION_SECRET`, `ADMIN_PASSWORD`, dan `TELEGRAM_ADMIN_USERNAME` di `.env`.
2. Set `NODE_ENV=production` untuk cookie session lewat HTTPS saja.
3. **PENTING (root cause "Live Sistem" jadi putih/kosong saat refresh):**
   jalankan server ini sebagai **SATU proses/instance saja** dengan folder
   `data/` yang persisten (bukan disk sementara/ephemeral). Kalau dijalankan
   dengan banyak instance/replica (mis. PM2 cluster mode, atau beberapa
   container tanpa disk bersama) di belakang load balancer, tiap instance
   punya salinan `data/*.json` dan koneksi Socket.IO sendiri-sendiri —
   akibatnya riwayat yang baru saja tampil (real-time lewat instance A)
   bisa hilang saat browser refresh dan request baru dilayani instance B
   yang belum tahu data itu. Kalau memang perlu banyak instance, wajib
   pakai storage bersama (database/Redis) + `@socket.io/redis-adapter`.

## Perubahan v4

- Riwayat "Live Sistem" di dashboard user sekarang lebih tahan banting:
  auto-retry tanpa menyerah kalau gagal fetch, tidak pernah menghapus data
  yang sudah tampil hanya karena satu request gagal, dan ada auto-resync
  berkala (setiap 12 detik) sebagai jaring pengaman selain event Socket.IO.
- Semua tulis-baca file JSON (`downloads.json`, `users.json`, `chat.json`,
  `feedback.json`) sekarang diantrikan per-file + ditulis atomic, supaya
  dua request yang datang bersamaan tidak saling menimpa/menghilangkan data.
- Akun **admin** sekarang tetap bisa memakai semua fitur user biasa
  (unduh video, lihat Live Sistem, chat, dst) lewat tombol "🛡️ Admin" di
  pojok kanan atas untuk membuka Panel Admin, dan tombol "⬅ Aplikasi" di
  Panel Admin untuk kembali. User biasa tidak pernah melihat/bisa membuka
  Panel Admin (selain tombolnya disembunyikan, endpoint `/api/admin/*` di
  server tetap divalidasi lewat middleware `wajibAdmin`).
- Fitur baru **Feedback**: tab "💬 Feedback" di menu user untuk mengirim
  masukan/laporan bug. Pesan disimpan di server (dan tampil real-time di
  Panel Admin) lalu dibukakan ke saluran Telegram admin dengan teks yang
  sudah terisi otomatis. Nama/alamat Telegram admin sengaja tidak pernah
  ditampilkan mentah di UI — hanya muncul sebagai label "Feedback".
