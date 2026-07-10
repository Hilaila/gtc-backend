// GeoTerraChain QFS — Gouvernance : Convocations & Présences (v4)
import {
  setCors, verifyPiUser, getBearerToken, isAdmin, isAdminOrSecretaire,
  sha256Hex, kvCommand, kvPipeline, rateLimit, logAudit, clientIp
} from '../lib/security.js';

async function getConvocation(id) {
  const data = await kvCommand(['GET', `geoterrachain:convocation:${id}`]);
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}
async function isLocked(id) {
  const data = await kvCommand(['GET', `geoterrachain:cloture:${id}`]);
  return !!data.result;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Registre non configuré — variables Upstash manquantes sur Vercel' });
  }

  const action = req.query.action;
  const token = getBearerToken(req);
  const LIST_KEY = 'geoterrachain:convocations';

  try {
    if (req.method === 'POST' && action === 'create') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Seul le Président Fondateur peut créer une convocation' });

      const rl = await rateLimit(`conv_create:${identity.uid}`, 10, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de convocations créées récemment. Réessayez plus tard.' });

      const body = req.body || {};
      if (!body.titre || !body.date) return res.status(400).json({ error: 'Titre et date obligatoires' });

      const convocation = {
        id: 'CONV_' + Date.now(), titre: body.titre, date: body.date, heure: body.heure || '00:00',
        lieu: body.lieu || '', ordreDuJour: body.ordreDuJour || '',
        dirigeants: body.dirigeants || [], dateLimiteReponse: body.dateLimiteReponse || '',
        createdByUid: identity.uid, createdByUsername: identity.username, createdAt: new Date().toISOString()
      };
      await kvPipeline([
        ['LPUSH', LIST_KEY, JSON.stringify(convocation)],
        ['LTRIM', LIST_KEY, '0', '199'],
        ['SET', `geoterrachain:convocation:${convocation.id}`, JSON.stringify(convocation)]
      ]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.create', resource: convocation.id, result: 'success' });
      return res.status(200).json({ success: true, convocation });
    }

    if (req.method === 'GET' && action === 'list') {
      const data = await kvCommand(['LRANGE', LIST_KEY, '0', '-1']);
      const convocations = (data.result || []).map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
      return res.status(200).json({ success: true, convocations });
    }

    if (req.method === 'POST' && action === 'viewed') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });
      const value = JSON.stringify({ username: identity.username, viewedAt: new Date().toISOString() });
      await kvCommand(['HSET', `geoterrachain:vues:${convocationId}`, identity.uid, value]);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'respond') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const rl = await rateLimit(`conv_respond:${identity.uid}`, 30, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de réponses envoyées récemment.' });

      const { convocationId, reponse, motif } = req.body || {};
      if (!convocationId || !reponse) return res.status(400).json({ error: 'Paramètres manquants' });
      if (await isLocked(convocationId)) return res.status(403).json({ error: 'Registre finalisé et verrouillé' });

      const value = JSON.stringify({ username: identity.username, reponse, motif: motif || '', respondedAt: new Date().toISOString() });
      await kvCommand(['HSET', `geoterrachain:reponses:${convocationId}`, identity.uid, value]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.respond', resource: convocationId, result: reponse });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'POST' && action === 'confirmPresence') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const rl = await rateLimit(`conv_presence:${identity.uid}`, 10, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de tentatives de pointage récentes.' });

      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });
      if (await isLocked(convocationId)) return res.status(403).json({ error: 'Registre finalisé et verrouillé' });

      const conv = await getConvocation(convocationId);
      if (!conv) return res.status(404).json({ error: 'Convocation introuvable' });

      const meetingStart = new Date(`${conv.date}T${conv.heure || '00:00'}:00`);
      const now = new Date();
      const windowStart = new Date(meetingStart.getTime() - 30 * 60000);
      const windowEnd = new Date(meetingStart.getTime() + 2 * 60 * 60000);
      if (now < windowStart || now > windowEnd) {
        return res.status(403).json({ error: `Pointage fermé. Autorisé de 30 min avant à 2h après le début (${meetingStart.toISOString()}).` });
      }
      const delayMinutes = Math.round((now - meetingStart) / 60000);
      const statutPresence = delayMinutes > 15 ? 'retard' : 'a_l_heure';
      const hash = await sha256Hex(`${convocationId}|${identity.uid}|${now.toISOString()}`);

      const record = {
        uid: 'PRES_' + Date.now(), username: identity.username, piUid: identity.uid,
        confirmedAt: now.toISOString(), statut: statutPresence,
        retardMinutes: delayMinutes > 0 ? delayMinutes : 0, hash, validatedBy: 'auto'
      };
      await kvCommand(['HSET', `geoterrachain:presences:${convocationId}`, identity.uid, JSON.stringify(record)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.confirmPresence', resource: convocationId, result: statutPresence });
      return res.status(200).json({ success: true, record });
    }

    if (req.method === 'POST' && action === 'manualCheckin') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: "Réservé à l'Administrateur ou au Secrétaire" });
      const { convocationId, targetUsername } = req.body || {};
      if (!convocationId || !targetUsername) return res.status(400).json({ error: 'Paramètres manquants' });
      if (await isLocked(convocationId)) return res.status(403).json({ error: 'Registre finalisé et verrouillé' });

      const manualKey = 'manual:' + targetUsername.trim().toLowerCase().replace(/\s+/g, '_');
      const record = { uid: 'PRES_' + Date.now(), username: targetUsername, confirmedAt: new Date().toISOString(), statut: 'present_manuel', validatedBy: `${identity.username} (${identity.uid})` };
      await kvCommand(['HSET', `geoterrachain:presences:${convocationId}`, manualKey, JSON.stringify(record)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.manualCheckin', resource: convocationId, result: targetUsername });
      return res.status(200).json({ success: true, record });
    }

    if (req.method === 'POST' && action === 'markExcused') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: "Réservé à l'Administrateur ou au Secrétaire" });
      const { convocationId, targetUsername, motif } = req.body || {};
      if (!convocationId || !targetUsername) return res.status(400).json({ error: 'Paramètres manquants' });
      if (await isLocked(convocationId)) return res.status(403).json({ error: 'Registre finalisé et verrouillé' });

      const value = JSON.stringify({ username: targetUsername, reponse: 'excuse', motif: motif || '', excusedBy: `${identity.username} (${identity.uid})`, respondedAt: new Date().toISOString() });
      await kvCommand(['HSET', `geoterrachain:reponses:${convocationId}`, targetUsername.trim(), value]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.markExcused', resource: convocationId, result: targetUsername });
      return res.status(200).json({ success: true });
    }

    if (req.method === 'GET' && action === 'status') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: "Accès réservé à l'Administrateur ou au Secrétaire" });
      const convocationId = req.query.id;
      if (!convocationId) return res.status(400).json({ error: 'id requis' });

      const [vues, reponses, presences] = await Promise.all([
        kvCommand(['HGETALL', `geoterrachain:vues:${convocationId}`]),
        kvCommand(['HGETALL', `geoterrachain:reponses:${convocationId}`]),
        kvCommand(['HGETALL', `geoterrachain:presences:${convocationId}`])
      ]);
      const toObject = (flat) => {
        const out = {}; const arr = flat.result || [];
        for (let i = 0; i < arr.length; i += 2) { try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch { out[arr[i]] = arr[i + 1]; } }
        return out;
      };
      return res.status(200).json({ success: true, vues: toObject(vues), reponses: toObject(reponses), presences: toObject(presences) });
    }

    if (req.method === 'POST' && action === 'close') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Seul le Président Fondateur peut clôturer le registre' });
      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });
      if (await isLocked(convocationId)) return res.status(409).json({ error: 'Registre déjà clôturé' });

      const [vues, reponses, presences] = await Promise.all([
        kvCommand(['HGETALL', `geoterrachain:vues:${convocationId}`]),
        kvCommand(['HGETALL', `geoterrachain:reponses:${convocationId}`]),
        kvCommand(['HGETALL', `geoterrachain:presences:${convocationId}`])
      ]);
      const hash = await sha256Hex(JSON.stringify({ vues: vues.result, reponses: reponses.result, presences: presences.result }));
      const cloture = { closedByUid: identity.uid, closedByUsername: identity.username, closedAt: new Date().toISOString(), hash };
      await kvCommand(['SET', `geoterrachain:cloture:${convocationId}`, JSON.stringify(cloture)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'convocation.close', resource: convocationId, result: hash.slice(0,16) });
      return res.status(200).json({ success: true, cloture });
    }

    return res.status(400).json({ error: 'Action inconnue ou méthode incorrecte' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
