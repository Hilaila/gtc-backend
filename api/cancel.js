export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { paymentId } = req.query;
  if (!paymentId) return res.status(400).json({ error: 'paymentId requis' });
  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` }
    });
    const data = await r.json().catch(() => ({}));
    return res.status(200).json({ success: true, cancelled: paymentId, data });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
