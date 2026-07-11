const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `Kamu adalah asisten pencatat keuangan untuk aplikasi Monitor Keuangan (huzky.xyz).
Tugasmu: baca pesan teks atau foto (struk belanja, nota, catatan tulisan tangan, tangkapan layar transfer, dsb) dari pengguna,
lalu catat SETIAP transaksi keuangan yang kamu temukan dengan memanggil tool "catat_transaksi" satu kali per transaksi.

Aturan:
- "jenis" = "masuk" untuk pemasukan (gaji, transfer masuk, dsb), "keluar" untuk pengeluaran (belanja, tagihan, dsb).
- "jumlah" harus bilangan bulat positif dalam Rupiah, tanpa titik/koma/simbol mata uang.
- "keterangan" singkat dan jelas (contoh: "Belanja Indomaret", "Gaji Bulanan Juli").
- Jika satu struk berisi banyak item, boleh gabungkan jadi satu transaksi total belanja, KECUALI pengguna secara eksplisit minta dipisah per item.
- Jika pesan/foto tidak mengandung informasi transaksi keuangan yang jelas, JANGAN panggil tool apa pun — cukup balas dengan teks biasa menjelaskan kamu tidak menemukan transaksi.
- Jangan bertanya balik untuk konfirmasi — langsung catat berdasarkan data yang tersedia (mode otomatis).`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'catat_transaksi',
      description: 'Catat satu transaksi keuangan (pemasukan atau pengeluaran) ke laporan Monitor Keuangan.',
      parameters: {
        type: 'object',
        properties: {
          jenis: { type: 'string', enum: ['masuk', 'keluar'], description: 'masuk = pemasukan, keluar = pengeluaran' },
          keterangan: { type: 'string', description: 'Deskripsi singkat transaksi' },
          jumlah: { type: 'integer', description: 'Nominal transaksi dalam Rupiah, bilangan bulat positif' }
        },
        required: ['jenis', 'keterangan', 'jumlah']
      }
    }
  }
];

async function askFinanceAgent({ text, imageBase64, imageMime }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;

  if (!apiKey || !model) {
    throw new Error('OPENROUTER_API_KEY / OPENROUTER_MODEL belum diset.');
  }

  const userContent = [];
  if (text) {
    userContent.push({ type: 'text', text });
  }
  if (imageBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${imageMime || 'image/jpeg'};base64,${imageBase64}` }
    });
  }
  if (userContent.length === 0) {
    userContent.push({ type: 'text', text: '(pesan kosong)' });
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://huzky.xyz',
      'X-Title': 'Huzky Monitor Keuangan Bot'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      tools: TOOLS,
      tool_choice: 'auto'
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenRouter error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message || {};

  const toolCalls = (message.tool_calls || [])
    .filter((call) => call.function?.name === 'catat_transaksi')
    .map((call) => {
      try {
        return JSON.parse(call.function.arguments);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return { toolCalls, replyText: message.content || null };
}

export { askFinanceAgent };
