// GeoTerraChain QFS — Gestion des suspensions de compte (Président Fondateur uniquement)
import { setCors, verifyPiUser, getBearerToken, isAdmin, suspendUser, unsuspendUser, listSuspended, logAudit } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const identity = await verifyPiUser(getBearerToken(req));
  if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
  if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Réservé au Président Fondateur' });

  const action = req.query.action;

  try {
    if (req.method === 'GET' && action === 'list') {
      const uids = await listSuspended();
      return res.status(200).json({ success: true, suspended: uids });
    }

    if (req.method === 'POST' && action === 'suspend') {
      const { targetUid } = req.body || {};
      if (!targetUid) return res.status(400).json({ error: 'targetUid requis' });
      await suspendUser(targetUid);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'user.suspend', resource: targetUid, result: 'success' });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'unsuspend') {
      const { targetUid } = req.body || {};
      if (!targetUid) return res.status(400).json({ error: 'targetUid requis' });
      await unsuspendUser(targetUid);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'user.unsuspend', resource: targetUid, result: 'success' });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Action inconnue ou méthode incorrecte' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
