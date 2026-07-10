// GeoTerraChain QFS — Émission d'une session courte durée après vérification Pi réelle.
// Le token Pi est vérifié une seule fois ici, auprès de l'API officielle Pi ;
// la session signée qui en résulte (30 min) évite de rappeler Pi Network à
// chaque action ensuite, sans jamais faire confiance à un rôle défini côté client.

import {
  setCors, verifyPiUser, getBearerToken, isAdmin, isSecretaire,
  isSuspended, signSessionToken, rateLimit, logAudit, clientIp
} from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const ip = clientIp(req);
  const rl = await rateLimit(`pi-auth:${ip}`, 20, 300);
  if (!rl.allowed) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });

  const piAccessToken = getBearerToken(req);
  if (!piAccessToken || piAccessToken.length < 20) {
    return res.status(401).json({ error: 'PI_TOKEN_MISSING', message: 'Jeton Pi manquant ou invalide.' });
  }

  if (!process.env.APP_JWT_SECRET) {
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'APP_JWT_SECRET manquant sur Vercel.' });
  }

  try {
    const identity = await verifyPiUser(piAccessToken);
    if (!identity) {
      await logAudit({ actor: ip, action: 'PI_AUTH_ECHOUEE', result: 'FAILURE', reason: 'PI_API_REJECTED' });
      return res.status(401).json({ error: 'PI_AUTH_FAILED', message: 'Authentification Pi refusée.' });
    }

    if (await isSuspended(identity.uid)) {
      await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'CONNEXION_ECHOUEE', result: 'FAILURE', reason: 'ACCOUNT_SUSPENDED' });
      return res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Accès temporairement indisponible.' });
    }

    const role = isAdmin(identity.uid) ? 'ADMIN' : isSecretaire(identity.uid) ? 'SECRETAIRE' : 'UTILISATEUR';
    const userId = `pi:${identity.uid}`;

    const access_token = signSessionToken(
      { sub: userId, pi_uid: identity.uid, pi_username: identity.username, role },
      1800 // 30 minutes, exactement comme spécifié
    );

    await logAudit({ actor: identity.username, actorUid: identity.uid, action: 'PI_AUTH_VERIFIE', result: 'SUCCESS' });

    return res.status(200).json({
      success: true,
      access_token,
      expires_in_seconds: 1800,
      user: { id: userId, username: identity.username, role }
    });
  } catch (e) {
    await logAudit({ actor: ip, action: 'PI_AUTH_ECHOUEE', result: 'FAILURE', reason: 'INTERNAL_ERROR' });
    return res.status(500).json({ error: 'AUTHENTICATION_ERROR', message: e.message });
  }
}
