// GeoTerraChain QFS — Gouvernance : Convocations & Présences (v2 — autorisations serveur)
//
// PRINCIPE DE SÉCURITÉ : le navigateur affiche l'interface, le serveur décide.
// Chaque action sensible exige un accessToken Pi Network valide, vérifié ici
// auprès de api.minepi.com/v2/me. Ce token est émis par Pi Network lui-même
// lors de Pi.authenticate() côté client et ne peut pas être falsifié pour
// usurper l'identité d'un autre Pioneer — impossible à contourner en modifiant
// le JavaScript de la page, car le serveur Pi seul délivre ce jeton.
//
// L'identité canonique utilisée dans tous les enregistrements est le uid Pi
// (identifiant stable), jamais uniquement le nom affiché.

const ADMIN_UIDS = [
  '22a18d26-5d0f-4010-a1bf-e2fe3b2bd403' // Hilaila — Président Fondateur (uid Pi réel)
];
// Ajouter ici l'uid Pi du Secrétaire général dès qu'il sera désigné et authentifié une première fois.
const SECRETAIRE_UIDS = [];

async function verifyPiUser(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return { uid: data.uid, username: data.username };
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function isAdmin(uid) { return ADMIN_UIDS.includes(uid); }
function isSecretaire(uid) { return SECRETAIRE_UIDS.includes(uid); }
function isAdminOrSecretaire(uid) { return isAdmin(uid) || isSecretaire(uid); }

async function redisCommand(REST_URL, REST_TOKEN, cmd) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return r.json();
}

async function redisPipeline(REST_URL, REST_TOKEN, commands) {
  const r = await fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  return r.json();
}

async function getConvocation(REST_URL, REST_TOKEN, id) {
  const data = await redisCommand(REST_URL, REST_TOKEN, ['GET', `geoterrachain:convocation:${id}`]);
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function isLocked(REST_URL, REST_TOKEN, id) {
  const data = await redisCommand(REST_URL, REST_TOKEN, ['GET', `geoterrachain:cloture:${id}`]);
  return !!data.result;
}

async function sha256Hex(message) {
  const enc = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const LIST_KEY = 'geoterrachain:convocations';

  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({ error: 'Registre non configuré — variables Upstash manquantes sur Vercel' });
  }

  const action = req.query.action;
  const token = getBearerToken(req);

  try {
    // ── Créer une convocation — Admin uniquement, vérifié serveur ──
    if (req.method === 'POST' && action === 'create') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Seul le Président Fondateur peut créer une convocation' });

      const body = req.body || {};
      if (!body.titre || !body.date) return res.status(400).json({ error: 'Titre et date obligatoires' });

      const convocation = {
        id: 'CONV_' + Date.now(),
        titre: body.titre,
        date: body.date,
        heure: body.heure || '00:00',
        lieu: body.lieu || '',
        ordreDuJour: body.ordreDuJour || '',
        dirigeants: body.dirigeants || [],
        dateLimiteReponse: body.dateLimiteReponse || '',
        createdByUid: identity.uid,
        createdByUsername: identity.username,
        createdAt: new Date().toISOString()
      };

      await redisPipeline(REST_URL, REST_TOKEN, [
        ['LPUSH', LIST_KEY, JSON.stringify(convocation)],
        ['LTRIM', LIST_KEY, '0', '199'],
        ['SET', `geoterrachain:convocation:${convocation.id}`, JSON.stringify(convocation)]
      ]);
      return res.status(200).json({ success: true, convocation });
    }

    // ── Lister les convocations — lecture publique (titres/dates non sensibles) ──
    if (req.method === 'GET' && action === 'list') {
      const data = await redisCommand(REST_URL, REST_TOKEN, ['LRANGE', LIST_KEY, '0', '-1']);
      const convocations = (data.result || [])
        .map(item => { try { return JSON.parse(item); } catch { return null; } })
        .filter(Boolean);
      return res.status(200).json({ success: true, convocations });
    }

    // ── Marquer une convocation comme vue — identité vérifiée serveur ──
    if (req.method === 'POST' && action === 'viewed') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });

      const hkey = `geoterrachain:vues:${convocationId}`;
      const value = JSON.stringify({ username: identity.username, viewedAt: new Date().toISOString() });
      await redisCommand(REST_URL, REST_TOKEN, ['HSET', hkey, identity.uid, value]);
      return res.status(200).json({ success: true });
    }

    // ── Répondre présent/absent — identité vérifiée, registre non verrouillé ──
    if (req.method === 'POST' && action === 'respond') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const { convocationId, reponse, motif } = req.body || {};
      if (!convocationId || !reponse) return res.status(400).json({ error: 'Paramètres manquants' });

      if (await isLocked(REST_URL, REST_TOKEN, convocationId)) {
        return res.status(403).json({ error: 'Registre finalisé et verrouillé — aucune modification possible' });
      }

      const hkey = `geoterrachain:reponses:${convocationId}`;
      const value = JSON.stringify({
        username: identity.username, reponse, motif: motif || '', respondedAt: new Date().toISOString()
      });
      await redisCommand(REST_URL, REST_TOKEN, ['HSET', hkey, identity.uid, value]);
      return res.status(200).json({ success: true });
    }

    // ── Confirmer la présence effective (jour J) — fenêtre horaire vérifiée serveur ──
    if (req.method === 'POST' && action === 'confirmPresence') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });

      if (await isLocked(REST_URL, REST_TOKEN, convocationId)) {
        return res.status(403).json({ error: 'Registre finalisé et verrouillé — aucune modification possible' });
      }

      const conv = await getConvocation(REST_URL, REST_TOKEN, convocationId);
      if (!conv) return res.status(404).json({ error: 'Convocation introuvable' });

      // Fenêtre de pointage : 30 minutes avant → 2 heures après le début — vérifiée côté serveur,
      // donc valable que le lien vienne du QR Code, d'un favori ou d'un appel direct à l'API.
      const meetingStart = new Date(`${conv.date}T${conv.heure || '00:00'}:00`);
      const now = new Date();
      const windowStart = new Date(meetingStart.getTime() - 30 * 60000);
      const windowEnd = new Date(meetingStart.getTime() + 2 * 60 * 60000);
      if (now < windowStart || now > windowEnd) {
        return res.status(403).json({
          error: `Pointage fermé. Autorisé uniquement de 30 min avant à 2h après le début (${meetingStart.toISOString()}).`
        });
      }

      const delayMinutes = Math.round((now - meetingStart) / 60000);
      const statutPresence = delayMinutes > 15 ? 'retard' : 'a_l_heure';

      const canonical = `${convocationId}|${identity.uid}|${now.toISOString()}`;
      const hash = await sha256Hex(canonical);

      const record = {
        uid: 'PRES_' + Date.now(),
        username: identity.username,
        piUid: identity.uid,
        confirmedAt: now.toISOString(),
        statut: statutPresence,
        retardMinutes: delayMinutes > 0 ? delayMinutes : 0,
        hash,
        validatedBy: 'auto' // auto = auto-pointage par le membre lui-même
      };

      await redisCommand(REST_URL, REST_TOKEN, [
        'HSET', `geoterrachain:presences:${convocationId}`, identity.uid, JSON.stringify(record)
      ]);
      return res.status(200).json({ success: true, record });
    }

    // ── Pointage manuel par un Admin/Secrétaire (membre sans téléphone) ──
    if (req.method === 'POST' && action === 'manualCheckin') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: 'Réservé à l\'Administrateur ou au Secrétaire' });

      const { convocationId, targetUsername } = req.body || {};
      if (!convocationId || !targetUsername) return res.status(400).json({ error: 'Paramètres manquants' });

      if (await isLocked(REST_URL, REST_TOKEN, convocationId)) {
        return res.status(403).json({ error: 'Registre finalisé et verrouillé' });
      }

      const manualKey = 'manual:' + targetUsername.trim().toLowerCase().replace(/\s+/g, '_');
      const record = {
        uid: 'PRES_' + Date.now(),
        username: targetUsername,
        confirmedAt: new Date().toISOString(),
        statut: 'present_manuel',
        validatedBy: `${identity.username} (${identity.uid})`
      };
      await redisCommand(REST_URL, REST_TOKEN, [
        'HSET', `geoterrachain:presences:${convocationId}`, manualKey, JSON.stringify(record)
      ]);
      return res.status(200).json({ success: true, record });
    }

    // ── Marquer un membre "Excusé" — Admin/Secrétaire uniquement ──
    if (req.method === 'POST' && action === 'markExcused') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: 'Réservé à l\'Administrateur ou au Secrétaire' });

      const { convocationId, targetUsername, motif } = req.body || {};
      if (!convocationId || !targetUsername) return res.status(400).json({ error: 'Paramètres manquants' });

      if (await isLocked(REST_URL, REST_TOKEN, convocationId)) {
        return res.status(403).json({ error: 'Registre finalisé et verrouillé' });
      }

      const key = targetUsername.trim();
      const value = JSON.stringify({
        username: targetUsername, reponse: 'excuse', motif: motif || '',
        excusedBy: `${identity.username} (${identity.uid})`, respondedAt: new Date().toISOString()
      });
      await redisCommand(REST_URL, REST_TOKEN, ['HSET', `geoterrachain:reponses:${convocationId}`, key, value]);
      return res.status(200).json({ success: true });
    }

    // ── Tableau global des réponses/présences — Admin/Secrétaire uniquement ──
    if (req.method === 'GET' && action === 'status') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: 'Accès réservé à l\'Administrateur ou au Secrétaire' });

      const convocationId = req.query.id;
      if (!convocationId) return res.status(400).json({ error: 'id requis' });

      const [vues, reponses, presences] = await Promise.all([
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:vues:${convocationId}`]),
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:reponses:${convocationId}`]),
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:presences:${convocationId}`])
      ]);

      const toObject = (flat) => {
        const out = {}; const arr = flat.result || [];
        for (let i = 0; i < arr.length; i += 2) {
          try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch { out[arr[i]] = arr[i + 1]; }
        }
        return out;
      };

      return res.status(200).json({
        success: true,
        vues: toObject(vues), reponses: toObject(reponses), presences: toObject(presences)
      });
    }

    // ── Clôturer et verrouiller le registre — Admin uniquement ──
    if (req.method === 'POST' && action === 'close') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdmin(identity.uid)) return res.status(403).json({ error: 'Seul le Président Fondateur peut clôturer le registre' });

      const { convocationId } = req.body || {};
      if (!convocationId) return res.status(400).json({ error: 'convocationId requis' });

      if (await isLocked(REST_URL, REST_TOKEN, convocationId)) {
        return res.status(409).json({ error: 'Registre déjà clôturé' });
      }

      const [vues, reponses, presences] = await Promise.all([
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:vues:${convocationId}`]),
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:reponses:${convocationId}`]),
        redisCommand(REST_URL, REST_TOKEN, ['HGETALL', `geoterrachain:presences:${convocationId}`])
      ]);

      // Seule cette empreinte SHA-256 du registre final pourrait, si souhaité un jour,
      // être ancrée publiquement (ex. mémo d'une transaction Pi) — jamais les données
      // personnelles elles-mêmes. Non implémenté ici, laissé en option future.
      const canonical = JSON.stringify({ vues: vues.result, reponses: reponses.result, presences: presences.result });
      const hash = await sha256Hex(canonical);

      const cloture = {
        closedByUid: identity.uid,
        closedByUsername: identity.username,
        closedAt: new Date().toISOString(),
        hash
      };
      await redisCommand(REST_URL, REST_TOKEN, [
        'SET', `geoterrachain:cloture:${convocationId}`, JSON.stringify(cloture)
      ]);
      return res.status(200).json({ success: true, cloture });
    }

    return res.status(400).json({ error: 'Action inconnue ou méthode incorrecte' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
