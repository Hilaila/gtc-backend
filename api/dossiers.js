// GeoTerraChain QFS — Référentiel foncier : Dossiers, modes d'acquisition,
// niveaux de vérification N0-N7, précision géospatiale G1-G5.
//
// GeoTerraChainQFS ne délivre pas de titre foncier et ne remplace pas les
// administrations foncières, notaires, géomètres-experts, autorités
// coutumières ou juridictions. Ce module sécurise, horodate et trace
// les dossiers — il ne constitue jamais une preuve juridique de propriété.

import { setCors, verifyPiUser, getBearerToken, isAdmin, isAdminOrSecretaire, rateLimit, logAudit, kvCommand, kvPipeline } from '../lib/security.js';

const MODES_ACQUISITION = [
  'achat_vente', 'succession_heritage', 'donation', 'attribution_administrative',
  'droit_coutumier_rural', 'certificat_foncier_rural', 'titre_foncier',
  'bail_emphyteotique', 'partage_copropriete', 'decision_judiciaire', 'autre_a_verifier'
];

// Statuts valides du référentiel — transitions laissées au jugement humain
// de l'Administrateur/Secrétaire, jamais automatiques au-delà de N0/N1.
const STATUTS = ['N0','N1','N2','N3','N4','N5','N6','N7'];

function genererIdentifiant(pays, zone) {
  const annee = new Date().getFullYear();
  const numero = String(Date.now()).slice(-6);
  const zoneCode = (zone || 'XXX').toUpperCase().slice(0,3).padEnd(3,'X');
  const paysCode = (pays || 'CI').toUpperCase().slice(0,2);
  return `GTCQFS-${paysCode}-${zoneCode}-${annee}-${numero}`;
}

// Classe honnêtement le niveau géospatial en fonction de la précision réelle
// annoncée par l'appareil — jamais G3+ sans relevé professionnel déclaré.
function classifierNiveauG(precisionHorizontaleCm, methodeReleve) {
  const methodesProAcceptees = ['rtk', 'nrtk', 'gnss_professionnel', 'geometre_expert', 'plan_cadastral'];
  if (!methodesProAcceptees.includes(methodeReleve)) {
    // Smartphone uniquement : plafonné à G1/G2, jamais au-delà.
    if (precisionHorizontaleCm == null) return 'G1';
    return precisionHorizontaleCm <= 500 ? 'G2' : 'G1';
  }
  if (methodeReleve === 'plan_cadastral' || methodeReleve === 'geometre_expert') return 'G5';
  if (precisionHorizontaleCm <= 20) return 'G4';
  if (precisionHorizontaleCm <= 100) return 'G3';
  return 'G2';
}

// Vue publique redacted — jamais de coordonnées exactes, jamais de document,
// jamais l'identité complète du titulaire hors des personnes autorisées.
function vuePublique(d) {
  return {
    id: d.id, modeAcquisition: d.modeAcquisition, pays: d.pays,
    region: d.region, commune: d.commune, // zone générale seulement, pas le village/quartier précis
    statut: d.statut, niveauG: d.niveauG,
    hashPreuve: d.hashPreuve || null,
    createdAt: d.createdAt
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Registre non configuré — variables Upstash manquantes sur Vercel' });
  }

  const action = req.query.action;
  const token = getBearerToken(req);
  const LIST_KEY = 'geoterrachain:dossiers';

  try {
    // ── Créer un dossier foncier (tout Pioneer authentifié = déposant) ──
    if (req.method === 'POST' && action === 'create') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });

      const rl = await rateLimit(`dossier_create:${identity.uid}`, 5, 3600);
      if (!rl.allowed) return res.status(429).json({ error: 'Trop de dossiers créés récemment. Réessayez plus tard.' });

      const b = req.body || {};
      if (!b.modeAcquisition || !MODES_ACQUISITION.includes(b.modeAcquisition)) {
        return res.status(400).json({ error: 'Mode d\'acquisition invalide ou manquant' });
      }
      if (!b.titulaireDeclare || !b.commune) {
        return res.status(400).json({ error: 'Titulaire déclaré et commune obligatoires' });
      }
      if (!b.declarationExactitude || !b.consentementTraitement) {
        return res.status(400).json({ error: 'La déclaration d\'exactitude et le consentement de traitement sont obligatoires' });
      }

      const niveauG = classifierNiveauG(b.precisionHorizontaleCm, b.methodeReleve || 'smartphone');
      const id = genererIdentifiant(b.pays || 'CI', b.commune);

      const dossier = {
        id,
        modeAcquisition: b.modeAcquisition,
        titulaireDeclare: b.titulaireDeclare,
        titulaireUid: identity.uid,
        titulaireUsername: identity.username,
        pays: b.pays || 'Côte d\'Ivoire',
        region: b.region || '', departement: b.departement || '',
        commune: b.commune, village: b.village || '',
        referenceParcelle: b.referenceParcelle || '',
        superficieDeclaree: b.superficieDeclaree || '',
        latitude: b.latitude ?? null, longitude: b.longitude ?? null,
        precisionHorizontaleCm: b.precisionHorizontaleCm ?? null,
        precisionVerticaleCm: b.precisionVerticaleCm ?? null,
        dateHeureMesureUTC: b.dateHeureMesureUTC || new Date().toISOString(),
        systemeGNSS: b.systemeGNSS || 'Multi-constellation (détection automatique du téléphone)',
        methodeReleve: b.methodeReleve || 'smartphone',
        niveauG,
        documentsIds: [],
        declarationExactitude: true,
        consentementTraitement: true,
        statut: 'N1', // Déposé — les pièces peuvent être ajoutées ensuite
        statutHistorique: [{ statut: 'N1', changedBy: identity.username, changedAt: new Date().toISOString(), motif: 'Création initiale' }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await kvPipeline([
        ['LPUSH', LIST_KEY, JSON.stringify({ id, titulaireUid: identity.uid })], // index léger pour listage
        ['SET', `geoterrachain:dossier:${id}`, JSON.stringify(dossier)],
        ['SADD', `geoterrachain:dossiers:par_uid:${identity.uid}`, id]
      ]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'dossier.create', resource: id, result: `niveau_${niveauG}` });
      return res.status(200).json({ success: true, dossier });
    }

    // ── Liste publique redacted (aucune authentification requise) ──
    if (req.method === 'GET' && action === 'listPublic') {
      const idx = await kvCommand(['LRANGE', LIST_KEY, '0', '-1']);
      const ids = (idx.result || []).map(i => { try { return JSON.parse(i).id; } catch { return null; } }).filter(Boolean);
      const dossiers = [];
      for (const id of ids.slice(0, 100)) {
        const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
        if (d.result) { try { dossiers.push(vuePublique(JSON.parse(d.result))); } catch {} }
      }
      return res.status(200).json({ success: true, dossiers });
    }

    // ── Mes dossiers (déposant authentifié) — détail complet des siens uniquement ──
    if (req.method === 'GET' && action === 'mine') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });

      const ids = await kvCommand(['SMEMBERS', `geoterrachain:dossiers:par_uid:${identity.uid}`]);
      const dossiers = [];
      for (const id of (ids.result || [])) {
        const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
        if (d.result) { try { dossiers.push(JSON.parse(d.result)); } catch {} }
      }
      return res.status(200).json({ success: true, dossiers });
    }

    // ── Détail complet — titulaire ou Admin/Secrétaire uniquement ──
    if (req.method === 'GET' && action === 'detail') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id requis' });

      const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
      if (!d.result) return res.status(404).json({ error: 'Dossier introuvable' });
      const dossier = JSON.parse(d.result);

      if (dossier.titulaireUid !== identity.uid && !isAdminOrSecretaire(identity.uid)) {
        return res.status(403).json({ error: 'Accès réservé au titulaire du dossier ou à un vérificateur habilité' });
      }
      return res.status(200).json({ success: true, dossier });
    }

    // ── Tous les dossiers (Admin/Secrétaire — vue de vérification complète) ──
    if (req.method === 'GET' && action === 'listAll') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: 'Réservé à l\'Administrateur ou au Secrétaire' });

      const idx = await kvCommand(['LRANGE', LIST_KEY, '0', '-1']);
      const ids = (idx.result || []).map(i => { try { return JSON.parse(i).id; } catch { return null; } }).filter(Boolean);
      const dossiers = [];
      for (const id of ids) {
        const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
        if (d.result) { try { dossiers.push(JSON.parse(d.result)); } catch {} }
      }
      return res.status(200).json({ success: true, dossiers });
    }

    // ── Changer le statut de vérification (N0-N7) — Admin/Secrétaire uniquement ──
    if (req.method === 'POST' && action === 'updateStatus') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      if (!isAdminOrSecretaire(identity.uid)) return res.status(403).json({ error: 'Réservé à l\'Administrateur ou au Secrétaire' });

      const { id, statut, motif } = req.body || {};
      if (!id || !STATUTS.includes(statut)) return res.status(400).json({ error: 'id et statut valide (N0-N7) requis' });

      const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
      if (!d.result) return res.status(404).json({ error: 'Dossier introuvable' });
      const dossier = JSON.parse(d.result);

      dossier.statut = statut;
      dossier.updatedAt = new Date().toISOString();
      dossier.statutHistorique.push({ statut, changedBy: identity.username, changedAt: dossier.updatedAt, motif: motif || '' });

      await kvCommand(['SET', `geoterrachain:dossier:${id}`, JSON.stringify(dossier)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'dossier.updateStatus', resource: id, result: statut });
      return res.status(200).json({ success: true, dossier });
    }

    // ── Rattacher un document déjà uploadé (via api/documents.js) à un dossier ──
    if (req.method === 'POST' && action === 'attachDocument') {
      const identity = await verifyPiUser(token);
      if (!identity) return res.status(401).json({ error: 'Authentification Pi requise ou expirée' });
      const { id, docId } = req.body || {};
      if (!id || !docId) return res.status(400).json({ error: 'id et docId requis' });

      const d = await kvCommand(['GET', `geoterrachain:dossier:${id}`]);
      if (!d.result) return res.status(404).json({ error: 'Dossier introuvable' });
      const dossier = JSON.parse(d.result);

      if (dossier.titulaireUid !== identity.uid && !isAdminOrSecretaire(identity.uid)) {
        return res.status(403).json({ error: 'Réservé au titulaire du dossier ou à un vérificateur habilité' });
      }

      dossier.documentsIds.push(docId);
      dossier.updatedAt = new Date().toISOString();
      await kvCommand(['SET', `geoterrachain:dossier:${id}`, JSON.stringify(dossier)]);
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'dossier.attachDocument', resource: id, result: docId });
      return res.status(200).json({ success: true, dossier });
    }

    return res.status(400).json({ error: 'Action inconnue ou méthode incorrecte' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
