import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import FileStoreFactory from "session-file-store";
import bcrypt from "bcryptjs";
import { createServer } from "http";
import { Server } from "socket.io";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DOWNLOADS_FILE = path.join(DATA_DIR, "downloads.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");
const BROADCAST_FILE = path.join(DATA_DIR, "broadcast.json");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");

const MAX_DOWNLOAD_LOG = 200;
const MAX_CHAT_LOG = 300;
const MAX_FEEDBACK_LOG = 200;

// Alias tampilan untuk tombol/link Telegram admin (jangan tampilkan username mentah di UI)
const TELEGRAM_ADMIN_USERNAME = process.env.TELEGRAM_ADMIN_USERNAME || "lamzy969";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Pakai FileStore (bukan MemoryStore bawaan) supaya sesi login TIDAK hilang
// setiap kali proses Node restart (sleep/redeploy di Railway). Ini akar
// penyebab utama kenapa fitur-fitur yang butuh login (termasuk riwayat
// unduhan) suka "putih"/gagal diam-diam: sesi hilang lebih dulu.
const FileStore = FileStoreFactory(session);
const sessionMiddleware = session({
  store: new FileStore({
    path: path.join(DATA_DIR, "sessions"),
    ttl: 60 * 60 * 24 * 7,
    retries: 1,
    logFn: () => {}
  }),
  secret: process.env.SESSION_SECRET || "ganti-secret-ini",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.static("public"));

// ==================== Helper baca/tulis file JSON ====================

async function bacaJSON(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function tulisJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Tulis ke file sementara lalu rename (atomic) supaya file JSON tidak pernah
  // terbaca dalam keadaan setengah tertulis/korup kalau proses ke-interupsi.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ==================== Antrian tulis per-file (anti race condition) ====================
// Tanpa ini, dua request yang datang hampir bersamaan (mis. 2 user unduh di
// waktu yang sama) bisa saling baca data lama lalu saling timpa saat menulis,
// sehingga satu riwayat "hilang" walau sudah tercatat sebentar di layar
// (itulah salah satu penyebab riwayat sempat tampil lalu kosong lagi).
const antrianFile = new Map();

function ekorAntrian(filePath, tugas) {
  const sebelumnya = antrianFile.get(filePath) || Promise.resolve();
  const berikutnya = sebelumnya.then(tugas, tugas);
  antrianFile.set(filePath, berikutnya.catch(() => {}));
  return berikutnya;
}

async function perbaruiJSON(filePath, fallback, updater) {
  return ekorAntrian(filePath, async () => {
    const current = await bacaJSON(filePath, fallback);
    const updated = await updater(current);
    await tulisJSON(filePath, updated);
    return updated;
  });
}

function buatId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function usernameValid(username) {
  return typeof username === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

// ==================== Middleware ====================

function wajibLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Silakan login terlebih dahulu." });
  }
  next();
}

function wajibAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Akses ditolak. Khusus admin." });
  }
  next();
}

// ==================== Rute Autentikasi ====================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!usernameValid(username)) {
      return res.status(400).json({ success: false, message: "Username harus 3-20 karakter, hanya huruf/angka/underscore." });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ success: false, message: "Kata sandi minimal 6 karakter." });
    }
    if (username.toLowerCase() === "admin") {
      return res.status(400).json({ success: false, message: "Username 'admin' dilindungi sistem." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let konflik = false;
    await perbaruiJSON(USERS_FILE, [], users => {
      const sudahAda = users.some(u => u.username.toLowerCase() === username.toLowerCase());
      if (sudahAda) {
        konflik = true;
        return users;
      }
      users.push({ id: buatId(), username, passwordHash, role: "user", createdAt: new Date().toISOString() });
      return users;
    });

    if (konflik) {
      return res.status(409).json({ success: false, message: "Username sudah digunakan, silakan pilih yang lain." });
    }

    return res.json({ success: true, message: "Pendaftaran berhasil. Silakan masuk." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal mendaftar.", error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan kata sandi wajib diisi." });
    }

    if (username.toLowerCase() === "admin") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword || password !== adminPassword) {
        return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
      }
      req.session.user = { username: "admin", role: "admin" };
      return req.session.save(() => res.json({ success: true, user: { username: "admin", role: "admin" } }));
    }

    const users = await bacaJSON(USERS_FILE, []);
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
    }

    const cocok = await bcrypt.compare(password, user.passwordHash);
    if (!cocok) {
      return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
    }

    req.session.user = { username: user.username, role: "user" };
    return req.session.save(() => res.json({ success: true, user: { username: user.username, role: "user" } }));
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal login.", error: error.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (req.session.user) {
    return res.json({ success: true, user: req.session.user });
  }
  return res.status(401).json({ success: false, message: "Belum login." });
});

// ==================== Download (real + broadcast via Socket.IO) ====================

const apiMap = {
  tiktok: process.env.TIKTOK_API,
  instagram: process.env.INSTAGRAM_API,
  youtube: process.env.YOUTUBE_API
};

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return null;
}

// ==================== Ekstraksi preview (video/thumbnail/audio) dari respons API pihak ketiga ====================
// Bentuk respons tiap API downloader berbeda-beda, jadi di sini kita "menyisir" seluruh
// objek hasil untuk menemukan URL media (video/gambar/audio) berdasarkan nama key & ekstensi file.

function kumpulkanUrlDenganKey(data, jejakKey = "", hasil = []) {
  if (!data) return hasil;
  if (typeof data === "string") {
    if (/^https?:\/\//i.test(data)) hasil.push({ key: jejakKey.toLowerCase(), url: data });
    return hasil;
  }
  if (Array.isArray(data)) {
    data.forEach(item => kumpulkanUrlDenganKey(item, jejakKey, hasil));
    return hasil;
  }
  if (typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      kumpulkanUrlDenganKey(v, k, hasil);
    }
  }
  return hasil;
}

function cariTeksJudul(data) {
  if (!data || typeof data !== "object") return "";
  const kandidatKey = ["title", "desc", "description", "caption", "text", "judul"];
  const stack = [data];
  while (stack.length) {
    const cur = stack.shift();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string" && v.trim() && kandidatKey.includes(k.toLowerCase())) {
        return v.trim().slice(0, 80);
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return "";
}

function ekstrakPreview(data, quality, platform) {
  const semuaUrl = kumpulkanUrlDenganKey(data);

  const cocok = (regex) => semuaUrl.filter(u => regex.test(u.key) || regex.test(u.url));

  const thumbnailKandidat = cocok(/thumb|cover|poster|preview|image/i)
    .concat(semuaUrl.filter(u => /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u.url)));
  const audioKandidat = cocok(/audio|music|mp3/i)
    .concat(semuaUrl.filter(u => /\.mp3(\?|$)/i.test(u.url)));
  const hdKandidat = cocok(/hd|1080|high|no.?watermark|nowm/i);
  const sdKandidat = cocok(/sd|720|low|watermark(?!.*no)/i);
  const videoUmum = semuaUrl.filter(u => /\.mp4(\?|$)/i.test(u.url) || /video|play/i.test(u.key));

  const thumbnail = (thumbnailKandidat[0] || {}).url || "";
  const audioUrl = (audioKandidat[0] || {}).url || "";

  let mediaUrl = "";
  let type = "unknown";

  if (quality === "audio" && audioUrl) {
    mediaUrl = audioUrl;
    type = "audio";
  } else if (quality === "hd" && hdKandidat[0]) {
    mediaUrl = hdKandidat[0].url;
    type = "video";
  } else if (quality === "sd" && sdKandidat[0]) {
    mediaUrl = sdKandidat[0].url;
    type = "video";
  }

  if (!mediaUrl) {
    const fallbackVideo = hdKandidat[0] || sdKandidat[0] || videoUmum[0];
    if (fallbackVideo) {
      mediaUrl = fallbackVideo.url;
      type = "video";
    } else if (quality === "audio" && audioUrl) {
      mediaUrl = audioUrl;
      type = "audio";
    } else if (thumbnail) {
      // tidak ada video/audio, tapi ada gambar (mis. carousel foto Instagram)
      mediaUrl = thumbnail;
      type = "image";
    }
  }

  const judul = cariTeksJudul(data) || `Media ${platform}`;

  return {
    type,
    mediaUrl,
    thumbnail: thumbnail || (type === "image" ? mediaUrl : ""),
    title: judul
  };
}

function namaFileDariPreview(preview, platform) {
  const basis = (preview.title || platform || "media")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "media";
  const ext = preview.type === "audio" ? "mp3" : preview.type === "image" ? "jpg" : "mp4";
  return `${basis}_${platform}.${ext}`;
}

async function catatRiwayatDownload(entry) {
  const all = await perbaruiJSON(DOWNLOADS_FILE, [], downloads => {
    downloads.push(entry);
    while (downloads.length > MAX_DOWNLOAD_LOG) downloads.shift();
    return downloads;
  });

  io.emit("download:new", entry);

  const total = all.length;
  const sukses = all.filter(d => d.success).length;
  io.emit("stats:update", { total, sukses, gagal: total - sukses });
}

app.post("/api/download", wajibLogin, async (req, res) => {
  const { url, platform, quality } = req.body || {};
  const username = req.session.user.username;
  const kualitasValid = ["hd", "sd", "audio"].includes(quality) ? quality : "sd";

  if (!url) {
    return res.status(400).json({ success: false, message: "URL wajib diisi." });
  }

  const detectedPlatform = platform || detectPlatform(url);

  if (!detectedPlatform || !apiMap[detectedPlatform]) {
    await catatRiwayatDownload({
      id: buatId(), username,
      filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
      platform: detectedPlatform || "unknown",
      success: false, message: "Platform tidak didukung.",
      createdAt: new Date().toISOString()
    });
    return res.status(400).json({ success: false, message: "Platform tidak didukung." });
  }

  try {
    const targetUrl = `${apiMap[detectedPlatform]}?url=${encodeURIComponent(url)}`;
    const response = await fetch(targetUrl);
    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { success: false, message: "API tidak mengembalikan JSON.", raw: rawText };
    }

    const berhasil = response.ok && data && data.success !== false;
    const preview = berhasil ? ekstrakPreview(data, kualitasValid, detectedPlatform) : null;

    if (berhasil && preview && !preview.mediaUrl && !preview.thumbnail) {
      await catatRiwayatDownload({
        id: buatId(), username,
        filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
        platform: detectedPlatform,
        success: false, message: "Media tidak ditemukan pada respons API.",
        createdAt: new Date().toISOString()
      });
      return res.status(502).json({ success: false, message: "Media tidak ditemukan pada respons API." });
    }

    const filename = preview ? namaFileDariPreview(preview, detectedPlatform) : (url.length > 40 ? url.slice(0, 40) + "..." : url);

    await catatRiwayatDownload({
      id: buatId(), username,
      filename,
      platform: detectedPlatform,
      success: berhasil,
      message: berhasil ? "Sukses" : (data && data.message) || "Gagal",
      createdAt: new Date().toISOString()
    });

    if (!response.ok || !berhasil) return res.status(response.ok ? 502 : response.status).json(data);
    return res.json({ success: true, platform: detectedPlatform, preview: { ...preview, filename } });
  } catch (error) {
    await catatRiwayatDownload({
      id: buatId(), username,
      filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
      platform: detectedPlatform,
      success: false, message: error.message,
      createdAt: new Date().toISOString()
    });
    return res.status(500).json({ success: false, message: "Gagal menghubungi API downloader.", error: error.message });
  }
});

// ==================== Proxy unduh file (biar unduhan tetap di halaman yang sama) ====================

function hostBerbahaya(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  );
}

app.get("/api/proxy-download", wajibLogin, async (req, res) => {
  const { src, name } = req.query;

  if (!src || typeof src !== "string") {
    return res.status(400).json({ success: false, message: "Parameter src wajib diisi." });
  }

  let target;
  try {
    target = new URL(src);
  } catch {
    return res.status(400).json({ success: false, message: "URL sumber tidak valid." });
  }

  if (!["http:", "https:"].includes(target.protocol) || hostBerbahaya(target.hostname)) {
    return res.status(400).json({ success: false, message: "URL sumber tidak diizinkan." });
  }

  const namaFile = (typeof name === "string" && name.trim())
    ? name.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
    : "unduhan_snaplam";

  try {
    const upstream = await fetch(target.toString());
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, message: "Gagal mengambil file dari sumber." });
    }

    res.setHeader("Content-Disposition", `attachment; filename="${namaFile}"`);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const { Readable } = await import("stream");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal memproses unduhan.", error: error.message });
  }
});

// Riwayat unduhan GLOBAL: sengaja TIDAK diwajibkan login, karena ini panel
// publik "Live Sistem" yang harus tetap tampil untuk semua pengguna kapan pun,
// termasuk saat sesi login sempat putus (mis. server restart). Ini akar
// penyebab kenapa box-nya sering "putih"/kosong sebelumnya: request ke sini
// gagal diam-diam (401) tiap kali session hilang, dan frontend menganggapnya
// error biasa.
app.get("/api/downloads", async (req, res) => {
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);
  return res.json({ success: true, downloads: downloads.slice(-50) });
});

app.get("/api/admin/stats", wajibLogin, wajibAdmin, async (req, res) => {
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);
  const users = await bacaJSON(USERS_FILE, []);
  const total = downloads.length;
  const sukses = downloads.filter(d => d.success).length;
  return res.json({ success: true, stats: { total, sukses, gagal: total - sukses, totalUser: users.length } });
});

// ==================== Manajemen User (khusus admin) ====================

app.get("/api/admin/users", wajibLogin, wajibAdmin, async (req, res) => {
  const users = await bacaJSON(USERS_FILE, []);
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);

  const daftar = users
    .map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      totalUnduhan: downloads.filter(d => d.username.toLowerCase() === u.username.toLowerCase()).length
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({ success: true, users: daftar, total: daftar.length });
});

app.delete("/api/admin/users/:id", wajibLogin, wajibAdmin, async (req, res) => {
  let target = null;
  await perbaruiJSON(USERS_FILE, [], users => {
    target = users.find(u => u.id === req.params.id) || null;
    if (!target) return users;
    return users.filter(u => u.id !== req.params.id);
  });

  if (!target) {
    return res.status(404).json({ success: false, message: "Pengguna tidak ditemukan." });
  }
  return res.json({ success: true, message: `Pengguna ${target.username} dihapus.` });
});

// ==================== Chat (real, broadcast via Socket.IO) ====================

app.get("/api/chat", wajibLogin, async (req, res) => {
  const chat = await bacaJSON(CHAT_FILE, []);
  return res.json({ success: true, messages: chat.slice(-100) });
});

app.delete("/api/chat", wajibLogin, wajibAdmin, async (req, res) => {
  await tulisJSON(CHAT_FILE, []);
  io.emit("chat:cleared");
  return res.json({ success: true });
});

// ==================== Broadcast admin (real, broadcast via Socket.IO) ====================

app.get("/api/broadcast", wajibLogin, async (req, res) => {
  const broadcast = await bacaJSON(BROADCAST_FILE, { text: "", image: "", active: false, updatedAt: null });
  return res.json({ success: true, broadcast });
});

app.delete("/api/broadcast", wajibLogin, wajibAdmin, async (req, res) => {
  const broadcast = { text: "", image: "", active: false, updatedAt: new Date().toISOString() };
  await tulisJSON(BROADCAST_FILE, broadcast);
  io.emit("broadcast:update", broadcast);
  return res.json({ success: true, broadcast });
});

// ==================== Feedback / Lapor Bug (dikirim ke Telegram admin) ====================

app.post("/api/feedback", wajibLogin, async (req, res) => {
  try {
    const { message, category } = req.body || {};
    const teks = typeof message === "string" ? message.trim() : "";

    if (!teks) {
      return res.status(400).json({ success: false, message: "Pesan feedback tidak boleh kosong." });
    }
    if (teks.length > 1000) {
      return res.status(400).json({ success: false, message: "Pesan terlalu panjang (maks 1000 karakter)." });
    }

    const kategoriValid = ["bug", "saran", "lainnya"].includes(category) ? category : "lainnya";
    const pengirim = req.session.user;

    const entry = {
      id: buatId(),
      username: pengirim.username,
      role: pengirim.role,
      category: kategoriValid,
      message: teks.slice(0, 1000),
      createdAt: new Date().toISOString()
    };

    await perbaruiJSON(FEEDBACK_FILE, [], list => {
      list.push(entry);
      while (list.length > MAX_FEEDBACK_LOG) list.shift();
      return list;
    });

    // Beri tahu admin yang sedang online secara real-time (tanpa perlu refresh)
    io.emit("feedback:new", entry);

    // Link Telegram diisi otomatis (prefilled) supaya pengguna tinggal klik "Kirim"
    // di aplikasi Telegram. Nama akun Telegram sengaja tidak ditampilkan di UI,
    // frontend cukup memakai label alias "Feedback".
    const labelKategori = kategoriValid === "bug" ? "🐞 Bug" : kategoriValid === "saran" ? "💡 Saran" : "📝 Lainnya";
    const teksTelegram = `[SnapLam Feedback]\nDari: ${pengirim.username}\nKategori: ${labelKategori}\nPesan: ${teks}`;
    const telegramLink = `https://t.me/${TELEGRAM_ADMIN_USERNAME}?text=${encodeURIComponent(teksTelegram)}`;

    return res.json({ success: true, feedback: entry, telegramLink });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal mengirim feedback.", error: error.message });
  }
});

app.get("/api/admin/feedback", wajibLogin, wajibAdmin, async (req, res) => {
  const list = await bacaJSON(FEEDBACK_FILE, []);
  return res.json({ success: true, feedback: list.slice(-100).reverse() });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, service: "SnapLam Downloader", time: new Date().toISOString() });
});

// ==================== Socket.IO real-time ====================

io.use((socket, next) => {
  const req = socket.request;
  if (req.session && req.session.user) {
    socket.user = req.session.user;
    return next();
  }
  next(new Error("Belum login."));
});

io.on("connection", socket => {
  socket.on("chat:send", async (payload, callback) => {
    const teks = (payload && payload.text || "").trim();
    if (!teks) {
      if (callback) callback({ success: false, message: "Pesan tidak boleh kosong." });
      return;
    }

    const pengirim = socket.user;
    const pesanBaru = {
      id: buatId(),
      sender: pengirim.role === "admin" ? "👑 Admin" : pengirim.username,
      isAdmin: pengirim.role === "admin",
      text: teks.slice(0, 500),
      createdAt: new Date().toISOString()
    };

    await perbaruiJSON(CHAT_FILE, [], chat => {
      chat.push(pesanBaru);
      while (chat.length > MAX_CHAT_LOG) chat.shift();
      return chat;
    });

    io.emit("chat:new", pesanBaru);
    if (callback) callback({ success: true, chatMessage: pesanBaru });
  });

  socket.on("broadcast:send", async (payload, callback) => {
    if (!socket.user || socket.user.role !== "admin") {
      if (callback) callback({ success: false, message: "Akses ditolak. Khusus admin." });
      return;
    }

    const text = (payload && payload.text) || "";
    const image = (payload && payload.image) || "";
    if (!text && !image) {
      if (callback) callback({ success: false, message: "Isi pesan atau gambar wajib diisi." });
      return;
    }

    const broadcast = { text, image, active: true, updatedAt: new Date().toISOString() };
    await tulisJSON(BROADCAST_FILE, broadcast);

    io.emit("broadcast:update", broadcast);
    if (callback) callback({ success: true, broadcast });
  });
});

httpServer.listen(port, () => {
  console.log(`SnapLam (Socket.IO) berjalan di http://localhost:${port}`);
});
