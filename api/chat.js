import { setCors, rateLimit, logAudit, clientIp } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const ip = clientIp(req);
  const rl = await rateLimit(`chat:${ip}`, 15, 600);
  if (!rl.allowed) return res.status(429).json({ error: 'Trop de messages envoyés. Patientez quelques minutes.' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Assistant IA non configuré — ANTHROPIC_API_KEY manquante sur Vercel' });

  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message requis' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 600,
        system: `Tu es l'assistant expert de GeoTerraChain QFS, plateforme africaine de tokenisation RWA sur Pi Network et Stellar. Tu connais : GTCπ (supply 3 141 592, burn 0.5%), KYC Pioneer Pi Network, tokenisation foncière, zone UEMOA, Côte d'Ivoire. Le KYC est obligatoire pour toute tokenisation. Réponds en français, de façon concise et pratique.`,
        messages: [{ role: 'user', content: message }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Erreur API Anthropic' });
    await logAudit({ actor: ip, action: 'chat.message', resource: 'assistant', result: 'ok' });
    return res.status(200).json({ success: true, text: data.content?.[0]?.text || 'Réponse vide.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
