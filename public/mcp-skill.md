---
name: uangku-mcp-setup
description: Connect this agent to the user's UangKu personal finance tracker via MCP, so it can read, add, and delete their transactions. Use this whenever the user asks to connect, set up, or link UangKu / huzky.xyz.
---

# UangKu MCP setup

UangKu is a personal finance tracker at `https://huzky.xyz`. It exposes an MCP
(Model Context Protocol) server with three tools: `list_transactions`,
`add_transaction`, `delete_transaction`. This file tells you, the agent, how
to connect yourself to it. Follow these steps without asking the human
anything except the one item marked **ASK THE HUMAN**.

## 1. Get a token

**ASK THE HUMAN:** "Please give me a UangKu MCP access token. You can create
one at https://huzky.xyz/dashboard under Pengaturan (Settings) → Koneksi →
MCP → 'Buat Token Baru'. Paste the token here (it starts with `uku_live_`)."

Do not attempt to obtain this token any other way — it is only ever shown
once, in the user's own browser session, and cannot be retrieved via API.

## 2. Configure the connection

The server URL is always:

```
https://huzky.xyz/mcp
```

Authentication is a standard bearer header:

```
Authorization: Bearer <the token the human gave you>
```

Add it to your own MCP client configuration. If you use a JSON config file
with an `mcpServers` block (e.g. Claude Desktop, Claude Code project/user
config), add or merge this entry:

```json
{
  "mcpServers": {
    "uangku": {
      "url": "https://huzky.xyz/mcp",
      "headers": {
        "Authorization": "Bearer <the token the human gave you>"
      }
    }
  }
}
```

If your configuration mechanism is different (a CLI flag, a settings UI, a
different config schema), adapt the two facts above — URL and bearer header —
to whatever mechanism you use. Do not invent additional fields; none are
required.

Note: this bearer-token method is for agents and file-based MCP clients only.
If instead you *are* a web-based connector UI with just a "server URL" field
and no header field (e.g. Claude.ai's "Add custom connector"), don't use this
file — just paste `https://huzky.xyz/mcp` as the URL. That path uses OAuth
2.1 with Dynamic Client Registration instead; the human will be redirected to
log in and approve access in their browser, no token needed.

## 3. Verify

After configuring, call `list_transactions` with no arguments. A successful
response looks like:

```json
{
  "ringkasan": { "saldo": 0, "pemasukan": 0, "pengeluaran": 0 },
  "transaksi": []
}
```

If you get a 401/Unauthorized error, the token was mistyped or has been
revoked — ask the human to double check it or issue a new one.

## 4. Tools reference

- `list_transactions({ jenis?, cari? })` — read transactions. `jenis` is
  `"masuk"` (income) or `"keluar"` (expense); `cari` filters by substring in
  the description. Returns a summary (`ringkasan`) plus the matching rows.
- `add_transaction({ jenis, keterangan, jumlah })` — record a new
  transaction. `jenis` is `"masuk"` or `"keluar"` (both required);
  `keterangan` is a short description (1-120 chars); `jumlah` is a positive
  integer amount in Indonesian Rupiah.
- `delete_transaction({ id })` — delete a transaction by its numeric `id`
  (get it from `list_transactions` first).

Each token only ever sees the data belonging to the account that created it —
there is no cross-account access possible.
