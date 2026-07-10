import { setCors, rateLimit, clientIp } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rl = await rateLimit(`cancel:${clientIp(req)}`, 30, 300);
  if (!rl.allowed) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans quelques minutes.' });

  const { paymentId } = req.query;
  if (!paymentId) return res.status(400).json({ error: 'paymentId requis' });

  try {
    const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Key ${process.env.PI_API_KEY}` }
    });
    const data = await r.json().catch(() => ({}));
    return res.status(200).json({ success: true, cancelled: paymentId, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
