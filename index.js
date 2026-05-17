import express from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

// ── ENV ───────────────────────────────────────────────────────
const API_ID     = process.env.SAKURUPIAH_API_ID      || "";
const API_KEY    = process.env.SAKURUPIAH_API_KEY     || "";
const BASE_URL   = process.env.SAKURUPIAH_BASE_URL    || "https://sakurupiah.id/api-sanbox/";
const CB_URL     = process.env.SAKURUPIAH_CALLBACK_URL || "";
const RET_URL    = process.env.SAKURUPIAH_RETURN_URL   || "";
const EXPIRED    = Number(process.env.SAKURUPIAH_EXPIRED_HOURS || 24);
const MERCH_FEE  = Number(process.env.SAKURUPIAH_MERCHANT_FEE  || 1);
const MERCH_CODE = process.env.SAKURUPIAH_MERCHANT_CODE || "SANBOX";

// ── Penyimpanan data ──────────────────────────────────────────
// Vercel: /tmp bisa ditulis. Lokal: folder /data
const DATA_DIR   = process.env.NODE_ENV === "production"
  ? "/tmp/everastore"
  : path.join(__dirname, "..", "data");
const STOK_FILE  = path.join(DATA_DIR, "stok.json");
const ORDER_FILE = path.join(DATA_DIR, "orders.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function bacaJSON(file, def = {}) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : def; }
  catch { return def; }
}
function tulisJSON(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── Auth helpers ──────────────────────────────────────────────
function safeEqual(a, b) {
  const l = Buffer.from(String(a || ""));
  const r = Buffer.from(String(b || ""));
  return l.length === r.length && crypto.timingSafeEqual(l, r);
}
function passwordMatches(input) {
  const plain = process.env.ADMIN_PASSWORD || "";
  const hash  = process.env.ADMIN_PASSWORD_SHA256 || "";
  if (hash) {
    const h = crypto.createHash("sha256").update(String(input || "")).digest("hex");
    return safeEqual(h, hash);
  }
  return plain ? safeEqual(input, plain) : false;
}
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || "";
  if (!token || !safeEqual(token, process.env.ADMIN_TOKEN || "")) {
    return res.status(401).json({ ok: false, message: "Akses admin ditolak" });
  }
  next();
}

// ── Helpers payment ───────────────────────────────────────────
function normalizePhone(phone) {
  const c = String(phone || "").replace(/[^0-9]/g, "");
  if (c.startsWith("08")) return `62${c.slice(1)}`;
  if (c.startsWith("8"))  return `62${c}`;
  return c;
}
function generateSignature(method, amount) {
  const plain = `${API_ID}${method}${MERCH_CODE}${amount}${API_KEY}`;
  console.log("SIG:", plain.replace(API_ID, "[ID]").replace(API_KEY, "[KEY]"));
  return crypto.createHash("md5").update(plain).digest("hex");
}
function extractCheckoutUrl(data) {
  const f = Array.isArray(data?.data) ? data.data[0] : data?.data;
  return data?.checkout_url || data?.payment_url || data?.url ||
    f?.checkout_url || f?.checkoutURL || f?.CheckoutURL || f?.payment_url || f?.url || null;
}

// ── Cek status ke Sakurupiah ──────────────────────────────────
async function cekStatusSakurupiah(merchantRef) {
  const baseUrl = BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`;
  const url     = new URL("status.php", baseUrl).toString();
  const sig     = crypto.createHash("md5")
    .update(`${API_ID}${merchantRef}${API_KEY}`).digest("hex");

  const form = new URLSearchParams();
  form.set("api_id",       API_ID);
  form.set("merchant_ref", merchantRef);
  form.set("signature",    sig);

  const resp = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Bearer ${API_KEY}` },
    body:    form,
  });
  const raw = await resp.text();
  console.log("STATUS CHECK:", merchantRef, "→", raw);
  try { return JSON.parse(raw); } catch { return { raw }; }
}

// ── Deliver akun dari stok ────────────────────────────────────
function deliverAkun(merchantRef) {
  const orders = bacaJSON(ORDER_FILE, {});
  const order  = orders[merchantRef];
  if (!order) return { ok: false, message: "Order tidak ditemukan" };
  if (order.delivered) return { ok: true, akun: order.akunDikirim, sudahDeliver: true };

  const stok     = bacaJSON(STOK_FILE, {});
  const kode     = order.kodeProduk;
  const listAkun = stok[kode]?.akun || [];

  if (listAkun.length === 0) {
    orders[merchantRef].status = "stok_habis";
    tulisJSON(ORDER_FILE, orders);
    return { ok: false, message: "Stok akun habis, hubungi admin" };
  }

  const akunDikirim    = listAkun[0];
  stok[kode].akun      = listAkun.slice(1);
  tulisJSON(STOK_FILE, stok);

  orders[merchantRef] = {
    ...order,
    delivered:   true,
    akunDikirim,
    deliveredAt: new Date().toISOString(),
    status:      "sukses",
  };
  tulisJSON(ORDER_FILE, orders);
  return { ok: true, akun: akunDikirim };
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ── 1. Buat invoice ───────────────────────────────────────────
app.post("/api/payments/create", async (req, res) => {
  try {
    if (!API_ID)  throw new Error("SAKURUPIAH_API_ID belum diisi");
    if (!API_KEY) throw new Error("SAKURUPIAH_API_KEY belum diisi");
    if (!CB_URL)  throw new Error("SAKURUPIAH_CALLBACK_URL belum diisi");
    if (!RET_URL) throw new Error("SAKURUPIAH_RETURN_URL belum diisi");

    const { namaProduk, kodeProduk, harga, phone, gameId = "", catatan = "" } = req.body || {};

    const amount = Math.round(Number(harga || 0));
    if (!amount || amount <= 0)  return res.status(400).json({ ok: false, message: "Harga tidak valid" });
    if (!namaProduk)             return res.status(400).json({ ok: false, message: "Nama produk wajib" });
    if (!kodeProduk)             return res.status(400).json({ ok: false, message: "Kode produk wajib" });

    const hp = normalizePhone(phone);
    if (!hp || hp.length < 10)  return res.status(400).json({ ok: false, message: "Nomor WhatsApp tidak valid" });

    const merchantRef = `EVA-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const noteText    = [gameId && `ID: ${gameId}`, catatan].filter(Boolean).join(" | ") || namaProduk;

    // Simpan order (pending)
    const orders = bacaJSON(ORDER_FILE, {});
    orders[merchantRef] = {
      merchantRef, namaProduk, kodeProduk,
      harga: amount, phone: hp, gameId, catatan,
      delivered: false, status: "pending",
      createdAt: new Date().toISOString(),
    };
    tulisJSON(ORDER_FILE, orders);

    // Kirim ke Sakurupiah
    const method = "QRIS";
    const form   = new URLSearchParams();
    form.set("api_id",       API_ID);
    form.set("method",       method);
    form.set("phone",        hp);
    form.set("amount",       String(amount));
    form.set("merchant_fee", String(MERCH_FEE));
    form.set("merchant_ref", merchantRef);
    form.set("callback_url", CB_URL);
    // Return URL bawa ref & kode agar halaman selesai bisa auto-cek
    form.set("return_url",   `${RET_URL}?ref=${merchantRef}&produk=${encodeURIComponent(namaProduk)}&kode=${encodeURIComponent(kodeProduk)}`);
    form.set("signature",    generateSignature(method, amount));
    form.set("expired",      String(EXPIRED));
    form.append("produk[]",  namaProduk);
    form.append("qty[]",     "1");
    form.append("harga[]",   String(amount));
    form.append("note[]",    noteText);

    const baseUrl = BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`;
    const apiUrl  = new URL("create.php", baseUrl).toString();

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Bearer ${API_KEY}` },
      body: form,
    });

    const raw = await response.text();
    console.log("SAKURUPIAH:", response.status, raw);
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!response.ok)
      return res.status(response.status).json({ ok: false, message: data?.message || "Sakurupiah menolak", data });

    const checkoutUrl = extractCheckoutUrl(data);
    if (!checkoutUrl)
      return res.status(502).json({ ok: false, message: "checkout_url tidak ditemukan", data });

    return res.json({ ok: true, merchant_ref: merchantRef, checkout_url: checkoutUrl });

  } catch (err) {
    console.error("CREATE ERROR:", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

// ── 2. Cek status + auto-deliver (polling dari frontend) ──────
app.get("/api/payments/status/:ref", async (req, res) => {
  const ref    = req.params.ref;
  const orders = bacaJSON(ORDER_FILE, {});
  const order  = orders[ref];

  if (!order) return res.status(404).json({ ok: false, message: "Order tidak ditemukan" });

  // Sudah deliver sebelumnya → langsung return akun
  if (order.delivered) {
    return res.json({ ok: true, status: "sukses", akun: order.akunDikirim });
  }

  if (order.status === "stok_habis") {
    return res.json({ ok: false, status: "stok_habis", message: "Stok akun habis, hubungi admin" });
  }

  if (order.status === "expired") {
    return res.json({ ok: false, status: "expired", message: "Pembayaran kadaluarsa" });
  }

  // Tanya Sakurupiah
  let statusData;
  try { statusData = await cekStatusSakurupiah(ref); }
  catch { return res.status(500).json({ ok: false, message: "Gagal cek ke Sakurupiah" }); }

  const statusCode = String(statusData?.status || statusData?.data?.status || "");
  const pesan      = String(statusData?.message || "").toLowerCase();
  const isPaid     = statusCode === "00" || statusCode === "success" || statusCode === "paid"
    || pesan.includes("sukses") || pesan.includes("paid") || pesan.includes("berhasil");
  const isExpired  = statusCode === "02" || pesan.includes("expired") || pesan.includes("kadaluarsa");

  if (isExpired) {
    orders[ref].status = "expired";
    tulisJSON(ORDER_FILE, orders);
    return res.json({ ok: false, status: "expired", message: "Pembayaran kadaluarsa" });
  }

  if (!isPaid) {
    return res.json({ ok: false, status: "pending", message: "Menunggu pembayaran" });
  }

  // Lunas → deliver akun
  const result = deliverAkun(ref);
  if (result.ok) {
    return res.json({ ok: true, status: "sukses", akun: result.akun });
  }
  return res.json({ ok: false, status: "stok_habis", message: result.message });
});

// ── 3. Callback otomatis dari Sakurupiah ──────────────────────
app.get("/api/payments/callback",  (_req, res) => res.json({ ok: true }));
app.post("/api/payments/callback", (req, res) => {
  console.log("📩 CALLBACK:", req.body);
  const ref = req.body?.merchant_ref || req.body?.ref;
  if (ref) {
    const result = deliverAkun(ref);
    console.log("AUTO-DELIVER via callback:", ref, result);
  }
  return res.json({ ok: true });
});

// ── 4. Admin login ────────────────────────────────────────────
app.post("/api/admin/login", (req, res) => {
  const email    = String(req.body?.email || "").trim().toLowerCase();
  const cfgEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!cfgEmail || (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_SHA256))
    return res.status(500).json({ ok: false, message: "Kredensial admin belum diatur" });
  if (safeEqual(email, cfgEmail) && passwordMatches(req.body?.password))
    return res.json({ ok: true, token: process.env.ADMIN_TOKEN || "" });
  return res.status(401).json({ ok: false, message: "Email atau password salah" });
});

// ── 5. API Stok Akun ──────────────────────────────────────────

// Lihat semua stok (admin)
app.get("/api/stok", adminAuth, (_req, res) => {
  res.json({ ok: true, data: bacaJSON(STOK_FILE, {}) });
});

// Jumlah stok per kode (publik, hanya angka)
app.get("/api/stok/:kode", (req, res) => {
  const stok  = bacaJSON(STOK_FILE, {});
  const entry = stok[req.params.kode];
  res.json({ ok: true, jumlah: entry?.akun?.length || 0 });
});

// Tambah akun ke stok (admin)
// Body: { kode: "#CC1", namaProduk: "CapCut 1 Hari", akun: ["user1|pass1", "user2|pass2"] }
app.post("/api/stok/tambah", adminAuth, (req, res) => {
  const { kode, namaProduk, akun } = req.body || {};
  if (!kode) return res.status(400).json({ ok: false, message: "Kode produk wajib" });
  if (!Array.isArray(akun) || akun.length === 0)
    return res.status(400).json({ ok: false, message: "Akun wajib berupa array" });

  const stok = bacaJSON(STOK_FILE, {});
  if (!stok[kode]) stok[kode] = { namaProduk: namaProduk || kode, akun: [] };

  const existing = new Set(stok[kode].akun);
  const baru     = akun.map(a => String(a).trim()).filter(a => a && !existing.has(a));
  stok[kode].akun = [...stok[kode].akun, ...baru];
  if (namaProduk) stok[kode].namaProduk = namaProduk;

  tulisJSON(STOK_FILE, stok);
  res.json({ ok: true, message: `${baru.length} akun ditambahkan`, jumlah: stok[kode].akun.length });
});

// Hapus 1 akun dari stok (admin)
app.delete("/api/stok/hapus", adminAuth, (req, res) => {
  const { kode, akun } = req.body || {};
  const stok = bacaJSON(STOK_FILE, {});
  if (!stok[kode]) return res.status(404).json({ ok: false, message: "Kode tidak ditemukan" });
  stok[kode].akun = stok[kode].akun.filter(a => a !== akun);
  tulisJSON(STOK_FILE, stok);
  res.json({ ok: true, jumlah: stok[kode].akun.length });
});

// Kosongkan stok 1 kode (admin)
app.delete("/api/stok/:kode", adminAuth, (req, res) => {
  const stok = bacaJSON(STOK_FILE, {});
  if (stok[req.params.kode]) { stok[req.params.kode].akun = []; tulisJSON(STOK_FILE, stok); }
  res.json({ ok: true, message: "Stok dikosongkan" });
});

// ── 6. API Orders (admin) ─────────────────────────────────────

// Semua order
app.get("/api/orders", adminAuth, (_req, res) => {
  const orders = bacaJSON(ORDER_FILE, {});
  const list   = Object.values(orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, data: list });
});

// Deliver manual (jika stok habis saat auto-deliver)
app.post("/api/orders/:ref/deliver", adminAuth, (req, res) => {
  const { akun } = req.body || {};
  const orders   = bacaJSON(ORDER_FILE, {});
  if (!orders[req.params.ref])
    return res.status(404).json({ ok: false, message: "Order tidak ditemukan" });
  orders[req.params.ref] = {
    ...orders[req.params.ref],
    delivered: true, akunDikirim: akun,
    deliveredAt: new Date().toISOString(), status: "sukses_manual",
  };
  tulisJSON(ORDER_FILE, orders);
  res.json({ ok: true });
});

// ── Static pages ──────────────────────────────────────────────
app.get("/payment-selesai", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "payment-selesai.html")));
app.get("/admin/stok", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "admin-stok.html")));
app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "index.html")));

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`🚀 Everastore → http://localhost:${PORT}`));
}

export default app;
