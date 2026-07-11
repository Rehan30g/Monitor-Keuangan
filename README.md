# Monitor Keuangan

Aplikasi pencatat keuangan pribadi berbasis web, dibangun **tanpa framework** dan
**tanpa dependency npm** — murni Node.js (`http`, `node:sqlite`) di sisi server dan
HTML/CSS/JS biasa di sisi klien. Dilengkapi bot Telegram bertenaga AI (vision)
untuk mencatat transaksi cukup dengan kirim foto struk atau catatan teks.

## Fitur

- **Autentikasi**: register + verifikasi email (kode 6 digit via Resend), login
  dengan proteksi brute-force (lockout otomatis) dan notifikasi email setiap ada
  login baru.
- **Captcha**: Cloudflare Turnstile di form login & register.
- **Dashboard**: tab Ringkasan, Transaksi, Laporan, dan Pengaturan — responsif di
  desktop (sidebar) maupun mobile (bottom tab bar), tema ikut sistem device atau
  bisa diganti manual (light/dark).
- **Transaksi**: tambah, cari, filter, dan hapus transaksi pemasukan/pengeluaran,
  dengan grafik tren saldo dan laporan bulanan.
- **Bot Telegram** (`bot/bot.js`): jalan sebagai proses terpisah, terhubung ke akun
  lewat alur "magic link" (`/login` di bot → buka link di browser yang sudah login
  → konfirmasi). Setelah terhubung, kirim foto struk/nota atau catatan teks ke bot
  dan AI (Qwen3.5-Flash lewat OpenRouter, mendukung vision) akan otomatis
  mengekstrak dan mencatatnya sebagai transaksi.

## Stack

- Node.js `http` module (tanpa Express) untuk server web
- `node:sqlite` bawaan Node.js untuk penyimpanan data
- Vanilla JS/CSS di sisi klien, tanpa build step
- [Resend](https://resend.com) untuk pengiriman email
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) untuk captcha
- [OpenRouter](https://openrouter.ai) (model `qwen/qwen3.5-flash-02-23`) untuk agent AI di bot Telegram
- [Telegram Bot API](https://core.telegram.org/bots/api) lewat long polling

## Struktur proyek

```
server.js              # Entry point server web (routing + static file serving)
bot/bot.js              # Entry point bot Telegram (proses terpisah)
lib/
  db.js                 # Skema & koneksi SQLite
  auth.js               # Hashing password, sesi, kode verifikasi
  handlers.js            # Handler semua endpoint /api/*
  validators.js          # Validasi input
  http-utils.js          # Body parser, cookie parser, rate limiter
  email.js               # Kirim email verifikasi & notifikasi login (Resend)
  captcha.js             # Verifikasi Cloudflare Turnstile
  transactions.js        # Query & agregasi transaksi
  telegram-api.js        # Wrapper Telegram Bot API
  telegram-links.js       # Token & mapping akun huzky.xyz <-> chat Telegram
  openrouter.js          # Panggilan ke OpenRouter (vision + tool calling)
  env.js                 # Loader .env sederhana (zero-dependency)
public/                 # Halaman & aset statis (dashboard, login, register, dll)
data/                   # Database SQLite (dibuat otomatis, tidak masuk git)
```

## Menjalankan secara lokal

Butuh Node.js versi 22+ (memakai `node:sqlite` yang masih experimental di versi ini).

1. Salin `.env.example` menjadi `.env` dan isi semua kredensial:

   ```
   RESEND_API_KEY=
   RESEND_FROM_EMAIL=
   TURNSTILE_SITE_KEY=
   TURNSTILE_SECRET_KEY=
   TELEGRAM_BOT_TOKEN=
   OPENROUTER_API_KEY=
   OPENROUTER_MODEL=qwen/qwen3.5-flash-02-23
   PUBLIC_BASE_URL=https://domain-kamu.com
   ```

2. Jalankan server web:

   ```
   node server.js
   ```

3. (Opsional) jalankan bot Telegram di proses terpisah:

   ```
   node bot/bot.js
   ```

Server web default listen di `127.0.0.1:3005` — diasumsikan berjalan di belakang
reverse proxy (mis. Nginx) yang menangani TLS.

## Environment variables

| Variabel | Keterangan |
|---|---|
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Kredensial [Resend](https://resend.com) untuk kirim email verifikasi & notifikasi login |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Kredensial [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) untuk captcha |
| `TELEGRAM_BOT_TOKEN` | Token bot dari [@BotFather](https://t.me/BotFather) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Kredensial & model [OpenRouter](https://openrouter.ai/keys) untuk agent AI di bot |
| `PUBLIC_BASE_URL` | URL publik aplikasi, dipakai untuk membentuk magic link login Telegram |

## Catatan keamanan

- Password di-hash dengan `scrypt` (bawaan `crypto`, bukan library eksternal).
- Sesi berbasis cookie `HttpOnly` + `Secure` + `SameSite=Strict`.
- Login dibatasi rate-limit per IP dan lockout otomatis setelah beberapa kali gagal.
- Token magic-link Telegram sekali pakai dan kedaluwarsa dalam 10 menit.
