// GeoTerraChain QFS — AI Router™ (v2, Phase 1 du Document Directeur)
//
// Priorité 1 : Knowledge Engine™ — réponse instantanée, sans dépendance externe.
// Priorité 5 : Anthropic — pour tout le reste (analyse, questions complexes).
// Failover Engine™ : si Anthropic échoue pour quelque raison que ce soit
// (clé manquante, modèle invalide, réseau, limite de requêtes), l'utilisateur
// reçoit toujours une réponse utile plutôt qu'une erreur brute.
//
// Grok AI, OpenAI et SoloHost (Priorités 2-4 du document directeur) ne sont
// PAS implémentés ici : ils nécessitent des comptes et clés API que le projet
// ne possède pas encore. Les ajouter sans ces comptes donnerait une fausse
// impression de fonctionnement — ils seront branchés dès qu'ils existeront.

import { setCors, rateLimit, logAudit, clientIp } from '../lib/security.js';
import { chercherReponse } from '../lib/knowledge-engine.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const ip = clientIp(req);
  const rl = await rateLimit(`chat:${ip}`, 20, 600);
  if (!rl.allowed) return res.status(429).json({ error: 'Trop de messages envoyés. Patiente quelques minutes.' });

  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message requis' });

  // ── Priorité 1 : Knowledge Engine™ ──
  const reponseLocale = chercherReponse(message);
  if (reponseLocale) {
    await logAudit({ actor: ip, action: 'chat.message', resource: 'knowledge_engine', result: 'ok' });
    return res.status(200).json({ success: true, text: reponseLocale, engine: 'Knowledge Engine' });
  }

  // ── Priorité 5 : Anthropic (si configuré) ──
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    await logAudit({ actor: ip, action: 'chat.message', resource: 'failover', result: 'anthropic_non_configure' });
    return res.status(200).json({
      success: true,
      engine: 'Failover Engine',
      text: "Je n'ai pas trouvé de réponse toute faite à cette question précise, et l'analyse approfondie n'est pas disponible pour l'instant (clé Anthropic non configurée côté serveur). Reformule ta question autour de la tokenisation, du KYC, du GTCπ, des dossiers fonciers ou de la gouvernance — ou réessaie plus tard."
    });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: `Tu es l'assistant expert de GeoTerraChain QFS, plateforme africaine de tokenisation RWA sur Pi Network et Stellar. Tu connais : GTCπ (supply 3 141 592, burn 0.5%), KYC Pioneer Pi Network, le Référentiel foncier (11 modes d'acquisition, niveaux N0-N7), le module Convocations & Présences, zone UEMOA, Côte d'Ivoire. Réponds en français, de façon concise et pratique.`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await r.json();

    if (!r.ok) {
      // Failover : erreur Anthropic (modèle invalide, clé refusée, quota...) → réponse dégradée mais utile.
      await logAudit({ actor: ip, action: 'chat.message', resource: 'anthropic', result: 'error:' + (data.error?.type || r.status) });
      return res.status(200).json({
        success: true,
        engine: 'Failover Engine',
        text: "L'analyse approfondie est momentanément indisponible (" + (data.error?.message || 'erreur API') + "). Voici ce que je peux te dire à partir de nos informations internes : GeoTerraChain QFS tokenise des actifs fonciers africains via GTCπ sur Pi Network, avec KYC obligatoire et un Référentiel foncier structuré. Reformule ta question pour une réponse plus précise, ou réessaie dans un instant."
      });
    }

    await logAudit({ actor: ip, action: 'chat.message', resource: 'anthropic', result: 'ok' });
    return res.status(200).json({ success: true, text: data.content?.[0]?.text || 'Réponse vide.', engine: 'Anthropic' });
  } catch (e) {
    await logAudit({ actor: ip, action: 'chat.message', resource: 'anthropic', result: 'exception:' + e.message });
    return res.status(200).json({
      success: true,
      engine: 'Failover Engine',
      text: "Problème de connexion momentané avec le moteur d'analyse. Pose-moi une question sur la tokenisation, le KYC, le GTCπ ou les dossiers fonciers — ou réessaie dans un instant."
    });
  }
}
