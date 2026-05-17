# Everastore — Toko Digital + Sakurupiah Payment Gateway

## 📁 Struktur File

```
everastore/
├── api/
│   └── index.js              ← Backend (Express + Sakurupiah API)
├── public/
│   ├── index.html            ← Halaman toko utama
│   ├── payment-selesai.html  ← Halaman setelah bayar (auto-deliver akun)
│   └── admin-stok.html       ← Panel admin kelola stok & orders
├── data/                     ← Dibuat otomatis (lokal), /tmp di Vercel
├── .env.example              ← Template env variables
├── package.json
├── vercel.json
└── README.md
```

---

## 🚀 Cara Deploy ke Vercel

### 1. Upload ke GitHub
Upload semua file ke repo GitHub kamu (bisa drag & drop di github.com)

### 2. Connect ke Vercel
- Buka vercel.com → New Project → Import repo GitHub kamu
- Vercel otomatis detect `vercel.json` dan siap deploy

### 3. Set Environment Variables di Vercel
Buka: **Vercel Dashboard → Project → Settings → Environment Variables**

| Key | Value |
|-----|-------|
| `SAKURUPIAH_API_ID` | API ID dari dashboard Sakurupiah |
| `SAKURUPIAH_API_KEY` | API Key dari dashboard Sakurupiah |
| `SAKURUPIAH_MERCHANT_CODE` | `SANBOX` (testing) |
| `SAKURUPIAH_BASE_URL` | `https://sakurupiah.id/api-sanbox/` |
| `SAKURUPIAH_CALLBACK_URL` | `https://everastore.biz.id/api/payments/callback` |
| `SAKURUPIAH_RETURN_URL` | `https://everastore.biz.id/payment-selesai` |
| `SAKURUPIAH_EXPIRED_HOURS` | `24` |
| `SAKURUPIAH_MERCHANT_FEE` | `1` |
| `ADMIN_EMAIL` | Email admin kamu |
| `ADMIN_PASSWORD` | Password admin kamu |
| `ADMIN_TOKEN` | String acak panjang (lihat cara generate di bawah) |

**Generate ADMIN_TOKEN:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Deploy!
Klik Deploy di Vercel — selesai!

---

## 🛒 Cara Pakai

### Untuk Pembeli
1. Pilih produk → klik **Beli Sekarang**
2. Isi nomor WhatsApp (dan ID Game jika perlu)
3. Klik **Bayar via QRIS** → scan QRIS
4. Setelah bayar, **halaman otomatis mengecek** setiap 5 detik
5. Begitu terkonfirmasi, **akun muncul langsung** di halaman

### Untuk Admin — Kelola Stok
1. Buka `https://domain-kamu.vercel.app/admin/stok`
2. Login dengan email & password dari `.env`
3. Tab **Stok Akun** → Tambah akun (1 per baris, format bebas)
4. Tab **Orders** → Lihat semua order + deliver manual jika perlu

---

## 🎮 Kode Produk

Setiap produk punya kode unik. Pastikan kode di `index.html` dan stok yang ditambahkan **sama persis**:

| Produk | Kode |
|--------|------|
| Mobile Legends 86 Diamond | `#ML86` |
| Free Fire 70 Diamond | `#FF70` |
| Spotify Premium 1 Bulan | `#SP1` |
| CapCut Premium 7 Hari | `#CC1` |
| CapCut Premium 30 Hari | `#CC2` |
| Canva Pro 30 Hari | `#CNV` |
| 1K Followers Instagram | `#IG1K` |
| dst... | |

Kode bisa kamu ubah bebas di `public/index.html` bagian array `PRODUK`.

---

## ✅ Checklist Sebelum Production

- [ ] Ganti `SAKURUPIAH_MERCHANT_CODE` ke kode merchant production
- [ ] Ganti `SAKURUPIAH_BASE_URL` ke `https://sakurupiah.id/api/`
- [ ] Pastikan `ADMIN_TOKEN` sudah diisi dengan string acak panjang
- [ ] Isi stok akun di panel admin sebelum promosi
- [ ] Test beli 1 produk end-to-end (bayar QRIS → akun muncul)
- [ ] Ganti nomor WA admin di `payment-selesai.html` (cari `6285750173207`)

---

## 🆘 Troubleshooting

**"Signature tidak valid"** dari Sakurupiah  
→ Cek `SAKURUPIAH_MERCHANT_CODE` harus sama persis dengan di dashboard Sakurupiah  
→ Backend sudah pakai MD5 (bukan HMAC)

**Stok tidak berkurang / akun tidak muncul**  
→ Cek log di Vercel → Functions tab  
→ Pastikan `kodeProduk` di form sama dengan kode di stok admin

**Data stok hilang setelah beberapa waktu**  
→ Vercel `/tmp` bisa reset. Untuk production, upgrade ke database (Vercel KV/Neon/PlanetScale)

**Panel admin tidak bisa login**  
→ Pastikan `ADMIN_EMAIL`, `ADMIN_PASSWORD`, dan `ADMIN_TOKEN` sudah diset di Vercel env
