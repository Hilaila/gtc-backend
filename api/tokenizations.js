// GeoTerraChain QFS — Registre public des tokenisations (v3)
import { setCors, kvCommand, kvPipeline, rateLimit, logAudit, clientIp, getBearerToken, verifyPiUser } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = 'geoterrachain:tokenizations';
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Registre non configuré — variables Upstash manquantes sur Vercel' });
  }

  try {
    if (req.method === 'POST') {
      const ip = clientIp(req);
      const rl = await rateLimit(`token_create:${ip}`, 20, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de tokenisations soumises récemment depuis cette connexion.' });

      const record = req.body;
      if (!record || !record.id) return res.status(400).json({ error: 'Données de tokenisation invalides' });

      // Si un dossier foncier est référencé, on vérifie qu'il existe et son niveau
      // de vérification, sans bloquer les tests libres non liés à un dossier.
      if (record.dossierId) {
        const d = await kvCommand(['GET', `geoterrachain:dossier:${record.dossierId}`]);
        if (d.result) {
          try {
            const dossier = JSON.parse(d.result);
            record.dossierStatut = dossier.statut;
          } catch {}
        }
      }

      const value = JSON.stringify(record);
      await kvPipeline([['LPUSH', KEY, value], ['LTRIM', KEY, '0', '499']]);
      await logAudit({ actor: record.proprio || 'inconnu', action: 'tokenization.create', resource: record.id, result: record.dossierId ? `dossier:${record.dossierId}` : 'sans_dossier' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'GET') {
      const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/lrange/${encodeURIComponent(KEY)}/0/-1`, {
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
      });
      const data = await r.json();
      const raw = data.result || [];
      const tokenizations = raw.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(Boolean);
      const count = tokenizations.length;
      const totalGTCp = parseFloat(tokenizations.reduce((s, t) => s + (parseFloat(t.prixGTCp) || 0), 0).toFixed(6));
      const totalBurn = parseFloat(tokenizations.reduce((s, t) => s + (parseFloat(t.burn) || 0), 0).toFixed(6));
      return res.status(200).json({ success: true, count, totalGTCp, totalBurn, tokenizations });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
