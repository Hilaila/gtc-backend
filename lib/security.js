// GeoTerraChain QFS — Fonctions de sécurité partagées par tous les endpoints
import crypto from 'crypto';

export function setCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGIN || 'https://hilaila.github.io')
    .split(',').map(s => s.trim());
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export async function verifyPiUser(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const data = await r.json();
    // Un compte suspendu est bloqué à la source : impossible d'agir nulle part
    // dans l'application tant qu'il n'est pas réactivé par le Président Fondateur.
    const suspended = await isSuspended(data.uid);
    if (suspended) return null;
    return { uid: data.uid, username: data.username };
  } catch { return null; }
}

export function getBearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export function isAdmin(uid) {
  const list = (process.env.ADMIN_PI_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(uid);
}
export function isSecretaire(uid) {
  const list = (process.env.SECRETAIRE_PI_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(uid);
}
export function isAdminOrSecretaire(uid) { return isAdmin(uid) || isSecretaire(uid); }

export async function sha256Hex(message) {
  const enc = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Accès centralisé à Upstash Redis ──
export async function kvCommand(cmd) {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return r.json();
}
export async function kvPipeline(commands) {
  const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  return r.json();
}

// ── Limite de requêtes (rate limiting) — fenêtre fixe via INCR + EXPIRE ──
export async function rateLimit(key, limit, windowSeconds) {
  const fullKey = `geoterrachain:ratelimit:${key}`;
  const incr = await kvCommand(['INCR', fullKey]);
  const count = incr.result;
  if (count === 1) await kvCommand(['EXPIRE', fullKey, String(windowSeconds)]);
  return { allowed: count <= limit, count, limit };
}

// ── Journal d'audit — append-only, plafonné à 2000 entrées ──
export async function logAudit(entry) {
  const record = { ...entry, at: new Date().toISOString() };
  await kvPipeline([
    ['LPUSH', 'geoterrachain:audit', JSON.stringify(record)],
    ['LTRIM', 'geoterrachain:audit', '0', '1999']
  ]);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
}

// ═══════════════════════════════════════════
// SESSION JWT COURTE DURÉE (implémentation native, sans dépendance npm)
// Émise uniquement après vérification réelle du token Pi Network.
// Signée avec APP_JWT_SECRET, connu uniquement de Vercel — jamais du navigateur.
// ═══════════════════════════════════════════

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

export function signSessionToken(payload, expiresInSeconds = 1800) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload, iat: now, exp: now + expiresInSeconds,
    iss: 'GeoTerraChainQFS', aud: 'GeoTerraChainQFS-Web'
  }));
  const sig = crypto.createHmac('sha256', process.env.APP_JWT_SECRET)
    .update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${body}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.APP_JWT_SECRET)
    .update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return null;
  if (payload.iss !== 'GeoTerraChainQFS' || payload.aud !== 'GeoTerraChainQFS-Web') return null;
  return payload;
}

// ═══════════════════════════════════════════
// SUSPENSION DE COMPTE — via Upstash (remplace la table Supabase du document)
// ═══════════════════════════════════════════
export async function isSuspended(uid) {
  const r = await kvCommand(['SISMEMBER', 'geoterrachain:suspended_uids', uid]);
  return r.result === 1;
}
export async function suspendUser(uid) {
  return kvCommand(['SADD', 'geoterrachain:suspended_uids', uid]);
}
export async function unsuspendUser(uid) {
  return kvCommand(['SREM', 'geoterrachain:suspended_uids', uid]);
}
export async function listSuspended() {
  const r = await kvCommand(['SMEMBERS', 'geoterrachain:suspended_uids']);
  return r.result || [];
}
