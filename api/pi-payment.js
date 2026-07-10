// GeoTerraChain QFS — Paiements Pi Network (approve/complete/cancel/status regroupés)
// Fusionné en un seul fichier pour rester sous la limite de 12 fonctions
// serverless du plan Vercel Hobby (gratuit).
import { setCors, rateLimit, clientIp } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const rl = await rateLimit(`pi-payment:${action}:${clientIp(req)}`, 30, 300);
  if (!rl.allowed) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans quelques minutes.' });

  const { paymentId, txid } = req.query;

  try {
    if (action === 'approve') {
      if (!paymentId) return res.status(400).json({ error: 'paymentId requis' });
      const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
        method: 'POST', headers: { Authorization: `Key ${process.env.PI_API_KEY}` }
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json({ success: r.ok, data });
    }

    if (action === 'complete') {
      if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId et txid requis' });
      const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Key ${process.env.PI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ txid })
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json({ success: r.ok, data });
    }

    if (action === 'cancel') {
      if (!paymentId) return res.status(400).json({ error: 'paymentId requis' });
      const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/cancel`, {
        method: 'POST', headers: { Authorization: `Key ${process.env.PI_API_KEY}` }
      });
      const data = await r.json().catch(() => ({}));
      return res.status(200).json({ success: true, cancelled: paymentId, data });
    }

    if (action === 'status') {
      if (!paymentId) return res.status(400).json({ error: 'paymentId requis' });
      const r = await fetch(`https://api.minepi.com/v2/payments/${paymentId}`, {
        headers: { Authorization: `Key ${process.env.PI_API_KEY}` }
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    }

    return res.status(400).json({ error: 'Action inconnue (approve|complete|cancel|status)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
