export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const KEY = 'geoterrachain:tokenizations';

  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({
      error: 'Registre non configuré — variables UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN manquantes sur Vercel'
    });
  }

  if (req.method === 'POST') {
    try {
      const record = req.body;
      if (!record || !record.id) {
        return res.status(400).json({ error: 'Données de tokenisation invalides' });
      }
      const value = JSON.stringify(record);
      const r = await fetch(`${REST_URL}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          ['LPUSH', KEY, value],
          ['LTRIM', KEY, '0', '499']
        ])
      });
      const data = await r.json();
      return res.status(200).json({ success: true, data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'GET') {
    try {
      const r = await fetch(`${REST_URL}/lrange/${encodeURIComponent(KEY)}/0/-1`, {
        headers: { Authorization: `Bearer ${REST_TOKEN}` }
      });
      const data = await r.json();
      const raw = data.result || [];
      const tokenizations = raw
        .map(item => { try { return JSON.parse(item); } catch { return null; } })
        .filter(Boolean);
      const count = tokenizations.length;
      const totalGTCp = parseFloat(
        tokenizations.reduce((s, t) => s + (parseFloat(t.prixGTCp) || 0), 0).toFixed(6)
      );
      const totalBurn = parseFloat(
        tokenizations.reduce((s, t) => s + (parseFloat(t.burn) || 0), 0).toFixed(6)
      );
      return res.status(200).json({ success: true, count, totalGTCp, totalBurn, tokenizations });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
