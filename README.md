# UangKu

Aplikasi pencatat keuangan pribadi berbasis web. Server utama dibangun **tanpa
framework** dan **tanpa dependency npm** — murni Node.js (`http`, `node:sqlite`)
di sisi server dan HTML/CSS/JS biasa di sisi klien, tanpa build step. Satu
subsistem terpisah (server MCP) memakai Express + SDK resmi MCP karena butuh
implementasi OAuth 2.1 penuh. Dilengkapi bot Telegram bertenaga AI (vision)
untuk mencatat transaksi cukup dengan kirim foto struk atau catatan teks.

## Fitur

- **Autentikasi**: register + verifikasi email (kode 6 digit via Resend), login
  dengan proteksi brute-force (lockout otomatis) dan notifikasi email setiap ada
  login baru, lupa/reset password lewat email, dan ganti email in-app (dengan
  masking di tampilan, mis. `re**@gmail.com`).
- **MFA (verifikasi dua langkah)**: TOTP standar (RFC 6238, kompatibel Google
  Authenticator/Authy/1Password dkk) diimplementasikan tanpa dependency
  eksternal, plus 10 kode cadangan sekali pakai. Aktivasi/nonaktivasi selalu
  butuh password + kode, dan tiap perubahan status mengirim email notifikasi.
- **Captcha**: Cloudflare Turnstile di form login & register.
- **Dashboard**: tab Ringkasan, Transaksi, Laporan, dan Pengaturan — responsif di
  desktop (sidebar) maupun mobile (bottom tab bar + floating action button),
  tema ikut sistem device atau bisa diganti manual (light/dark), i18n
  (Indonesia/Inggris/Mandarin).
- **Transaksi**: tambah, cari, filter, dan hapus transaksi pemasukan/pengeluaran,
  dengan grafik tren saldo dan laporan bulanan. Aksi sensitif (hapus akun, ganti
  password, logout, ekspor data) selalu lewat dialog konfirmasi terpisah.
- **Bot Telegram** (`bot/bot.js`): jalan sebagai proses terpisah, terhubung ke akun
  lewat alur "magic link" (`/login` di bot → buka link di browser yang sudah login
  → konfirmasi). Setelah terhubung, kirim foto struk/nota atau catatan teks ke bot
  dan AI (Qwen3.5-Flash lewat OpenRouter, mendukung vision) akan otomatis
  mengekstrak dan mencatatnya sebagai transaksi. Dilengkapi rate limiting dan
  feedback "sedang diproses" saat AI masih bekerja.
- **Server MCP** (`mcp/server.js`, port terpisah): mengekspos transaksi ke
  aplikasi/agen AI apa pun yang mendukung [MCP](https://modelcontextprotocol.io)
  lewat tiga tools — `list_transactions` (dipaginasi 10 transaksi terbaru per
  halaman supaya hemat token), `add_transaction`, `delete_transaction`. Dua jalur
  autentikasi didukung sekaligus di endpoint yang sama:
  - **OAuth 2.1** (Dynamic Client Registration, PKCE, refresh token, revocation) —
    untuk konektor berbasis web yang cuma minta URL server (mis. "Add custom
    connector" di Claude.ai). Layar persetujuannya meniru tampilan halaman
    hubungkan-Telegram, dengan badge ikon Claude asli atau ikon robot generik
    untuk konektor lain.
  - **Personal access token statis** — untuk client berbasis file konfigurasi
    (Claude Desktop, Claude Code, dll), dibuat & dicabut dari Pengaturan.
  - Panduan lengkap ada di `/mcp-docs` (manusia) dan `/mcp-skill.md` (agar agen
    AI bisa membaca sendiri cara memasang koneksinya, cukup minta token ke
    pengguna).

## Stack

- Node.js `http` module (tanpa Express) untuk server web utama
- `node:sqlite` bawaan Node.js untuk penyimpanan data
- Vanilla JS/CSS di sisi klien, tanpa build step
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) + Express + `zod` — khusus untuk server MCP (`mcp/server.js`), satu-satunya bagian yang tidak zero-dependency
- [Resend](https://resend.com) untuk pengiriman email
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) untuk captcha
- [OpenRouter](https://openrouter.ai) (model `qwen/qwen3.5-flash-02-23`) untuk agent AI di bot Telegram
- [Telegram Bot API](https://core.telegram.org/bots/api) lewat long polling

## Struktur proyek

```
server.js               # Entry point server web utama (routing + static file serving)
bot/bot.js               # Entry point bot Telegram (proses terpisah)
mcp/server.js            # Entry point server MCP + OAuth 2.1 (proses terpisah, port sendiri)
lib/
  db.js                  # Skema & koneksi SQLite
  auth.js                # Hashing password, sesi, kode verifikasi, reset password
  handlers.js             # Handler semua endpoint /api/*
  validators.js           # Validasi input
  http-utils.js           # Body parser, cookie parser, rate limiter
  email.js                # Kirim email verifikasi, notifikasi login, reset password (Resend)
  captcha.js              # Verifikasi Cloudflare Turnstile
  transactions.js         # Query & agregasi transaksi
  telegram-api.js         # Wrapper Telegram Bot API
  telegram-links.js        # Token & mapping akun huzky.xyz <-> chat Telegram
  openrouter.js           # Panggilan ke OpenRouter (vision + tool calling)
  api-tokens.js           # Personal access token untuk MCP (hash tersimpan, bukan raw token)
  oauth-store.js          # Data access OAuth: klien terdaftar, auth code, access/refresh token
  avatars.js              # Simpan/hapus foto profil
  totp.js                 # TOTP (RFC 6238) zero-dependency: base32, HOTP, verifikasi drift ±30s
  mfa.js                  # Data access MFA: enrollment, kode cadangan, challenge login dua langkah
  env.js                  # Loader .env sederhana (zero-dependency)
public/                  # Halaman & aset statis (dashboard, login, register, mcp-docs, dll)
data/                    # Database SQLite (dibuat otomatis, tidak masuk git)
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

2. Install dependency (dipakai khusus oleh server MCP):

   ```
   npm install
   ```

3. Jalankan server web:

   ```
   node server.js
   ```

4. (Opsional) jalankan bot Telegram di proses terpisah:

   ```
   node bot/bot.js
   ```

5. (Opsional) jalankan server MCP di proses terpisah:

   ```
   node mcp/server.js
   ```

Server web default listen di `127.0.0.1:3005`, server MCP di `127.0.0.1:3007` —
keduanya diasumsikan berjalan di belakang reverse proxy (mis. Nginx) yang
menangani TLS dan meneruskan path terkait (`/mcp`, `/authorize`, `/token`,
`/register`, `/revoke`, `/.well-known/oauth-*`) ke server MCP.

## Environment variables

| Variabel | Keterangan |
|---|---|
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Kredensial [Resend](https://resend.com) untuk kirim email verifikasi, notifikasi login, dan reset password |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Kredensial [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) untuk captcha |
| `TELEGRAM_BOT_TOKEN` | Token bot dari [@BotFather](https://t.me/BotFather) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Kredensial & model [OpenRouter](https://openrouter.ai/keys) untuk agent AI di bot |
| `PUBLIC_BASE_URL` | URL publik aplikasi, dipakai untuk membentuk magic link login Telegram |

## Catatan keamanan

- Password di-hash dengan `scrypt` (bawaan `crypto`, bukan library eksternal).
- Sesi berbasis cookie `HttpOnly` + `Secure` + `SameSite=Strict`.
- Login dibatasi rate-limit per IP dan lockout otomatis setelah beberapa kali gagal.
  IP diambil dari header `X-Real-IP` yang di-set Nginx sendiri (`$remote_addr`,
  tak bisa dipalsukan client) — bukan dari `X-Forwarded-For` yang bisa disuntik
  siapa pun untuk melewati rate limit.
- Token reset password dan kode verifikasi email membatalkan otomatis semua
  token/kode aktif sebelumnya milik user yang sama tiap kali diminta ulang,
  supaya cuma yang terbaru yang pernah valid.
- Token magic-link Telegram sekali pakai dan kedaluwarsa dalam 10 menit.
- MFA: secret TOTP per user, kode cadangan disimpan sebagai hash (SHA-256).
  Aktivasi butuh konfirmasi satu kode valid sebelum benar-benar aktif;
  nonaktivasi butuh password + kode (bukan sekali klik) supaya sesi yang
  dicuri tidak bisa mematikan 2FA begitu saja.
- Personal access token MCP disimpan sebagai hash (SHA-256) saja, sama seperti
  session/password, dan hanya ditampilkan satu kali saat dibuat.
- Token akses OAuth punya masa berlaku 1 jam dengan rotasi refresh token; kode
  otorisasi sekali pakai dan kedaluwarsa dalam 5 menit.
- Setiap token/izin OAuth cuma bisa mengakses data akun pemiliknya sendiri, dan
  bisa dicabut kapan saja dari Pengaturan.
