export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { paymentId, txid } = req.query;
  if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId et txid requis' });
  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid })
    });
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json({ success: r.ok, data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
