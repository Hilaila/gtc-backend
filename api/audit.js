// GeoTerraChain QFS — Consultation du journal d'audit (Admin uniquement)
import { setCors, verifyPiUser, getBearerToken, isAdmin, kvCommand } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

  const identity = await verifyPiUser(getBearerToken(req));
  if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
  if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Réservé au Président Fondateur' });

  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
    const data = await kvCommand(['LRANGE', 'geoterrachain:audit', '0', String(limit - 1)]);
    const entries = (data.result || []).map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({ success: true, entries });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
