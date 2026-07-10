// GeoTerraChain QFS — Stockage privé des pièces justificatives foncières
//
// Les documents ne sont JAMAIS servis par une URL publique directe. Chaque
// consultation exige un "ticket" temporaire à usage unique, valable 5 minutes,
// généré uniquement pour le titulaire du dossier ou un vérificateur habilité.
// Chaque dépôt et chaque consultation sont journalisés dans l'audit.

import { setCors, verifyPiUser, getBearerToken, isAdminOrSecretaire, sha256Hex, rateLimit, logAudit, kvCommand } from '../lib/security.js';

const TAILLE_MAX_OCTETS = 2 * 1024 * 1024; // 2 Mo — adapté aux scans/photos raisonnables.
// Pour de gros volumes de documents lourds, migrer vers un service de stockage
// de fichiers dédié (Vercel Blob, S3...) plutôt que Redis.

function estimerTailleBase64(base64) {
  return Math.floor((base64.length * 3) / 4);
}

async function getDossierOwner(dossierId) {
  const d = await kvCommand(['GET', `geoterrachain:dossier:${dossierId}`]);
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Registre non configuré — variables Upstash manquantes sur Vercel' });
  }

  const action = req.query.action;
  const token = getBearerToken(req);

  try {
    // ── Déposer un document (titulaire du dossier ou Admin/Secrétaire) ──
    if (req.method === 'POST' && action === 'upload') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });

      const rl = await rateLimit(`doc_upload:${identity.uid}`, 20, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de dépôts de documents récents.' });

      const { dossierId, filename, docType, contentBase64, mimeType } = req.body || {};
      if (!dossierId || !filename || !contentBase64) return res.status(400).json({ error: 'Paramètres manquants' });

      const tailleOctets = estimerTailleBase64(contentBase64);
      if (tailleOctets > TAILLE_MAX_OCTETS) {
        return res.status(413).json({ error: `Document trop volumineux (${(tailleOctets/1024/1024).toFixed(2)} Mo). Limite : 2 Mo.` });
      }

      const dossier = await getDossierOwner(dossierId);
      if (!dossier) return res.status(404).json({ error: 'Dossier introuvable' });
      if (dossier.titulaireUid !== identity.uid && !isAdminOrSecretaire(identity.uid)) {
        return res.status(403).json({ error: 'Réservé au titulaire du dossier ou à un vérificateur habilité' });
      }

      const docId = 'DOC_' + Date.now();
      const hash = await sha256Hex(contentBase64);

      const metadata = {
        docId, dossierId, filename, docType: docType || 'autre', mimeType: mimeType || 'application/octet-stream',
        hash, tailleOctets,
        uploadedByUid: identity.uid, uploadedByUsername: identity.username,
        uploadedAt: new Date().toISOString()
      };

      await kvCommand(['SET', `geoterrachain:docfile:${docId}`, contentBase64]);
      await kvCommand(['LPUSH', `geoterrachain:docmeta:${dossierId}`, JSON.stringify(metadata)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'document.upload', resource: docId, result: `dossier:${dossierId}` });

      return res.status(200).json({ success: true, docId, hash, filename, docType: metadata.docType });
    }

    // ── Métadonnées des documents d'un dossier (jamais le contenu) ──
    if (req.method === 'GET' && action === 'listMeta') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const dossierId = req.query.dossierId;
      if (!dossierId) return res.status(400).json({ error: 'dossierId requis' });

      const dossier = await getDossierOwner(dossierId);
      if (!dossier) return res.status(404).json({ error: 'Dossier introuvable' });
      if (dossier.titulaireUid !== identity.uid && !isAdminOrSecretaire(identity.uid)) {
        return res.status(403).json({ error: 'Réservé au titulaire du dossier ou à un vérificateur habilité' });
      }

      const data = await kvCommand(['LRANGE', `geoterrachain:docmeta:${dossierId}`, '0', '-1']);
      const documents = (data.result || []).map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
      return res.status(200).json({ success: true, documents });
    }

    // ── Demander un lien d'accès temporaire (ticket à usage unique, 5 minutes) ──
    if (req.method === 'POST' && action === 'requestAccess') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });

      const rl = await rateLimit(`doc_ticket:${identity.uid}`, 30, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de demandes d\'accès récentes.' });

      const { docId, dossierId } = req.body || {};
      if (!docId || !dossierId) return res.status(400).json({ error: 'docId et dossierId requis' });

      const dossier = await getDossierOwner(dossierId);
      if (!dossier) return res.status(404).json({ error: 'Dossier introuvable' });
      if (dossier.titulaireUid !== identity.uid && !isAdminOrSecretaire(identity.uid)) {
        return res.status(403).json({ error: 'Réservé au titulaire du dossier ou à un vérificateur habilité' });
      }

      const ticket = 'TCK_' + crypto.randomUUID().replace(/-/g, '');
      await kvCommand(['SET', `geoterrachain:ticket:${ticket}`, docId, 'EX', '300']); // expire dans 300s = 5 min

      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'document.requestAccess', resource: docId, result: 'ticket_emis' });
      return res.status(200).json({ success: true, ticket, expiresIn: 300 });
    }

    // ── Consulter un document via son ticket temporaire (usage unique) ──
    if (req.method === 'GET' && action === 'view') {
      const ticket = req.query.ticket;
      if (!ticket) return res.status(400).json({ error: 'ticket requis' });

      const t = await kvCommand(['GET', `geoterrachain:ticket:${ticket}`]);
      if (!t.result) return res.status(403).json({ error: 'Lien expiré ou déjà utilisé (valable 5 minutes, usage unique)' });

      const docId = t.result;
      await kvCommand(['DEL', `geoterrachain:ticket:${ticket}`]); // usage unique — invalidation immédiate

      const file = await kvCommand(['GET', `geoterrachain:docfile:${docId}`]);
      if (!file.result) return res.status(404).json({ error: 'Document introuvable' });

      await logAudit({ actor: 'ticket', action: 'document.view', resource: docId, result: 'consulte' });
      return res.status(200).json({ success: true, contentBase64: file.result });
    }

    return res.status(400).json({ error: 'Action inconnue ou méthode incorrecte' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
