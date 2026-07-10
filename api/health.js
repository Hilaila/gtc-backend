import { setCors } from '../lib/security.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(200).json({ status: 'ok', app: 'GeoTerraChain QFS Backend', version: '2.0.0', timestamp: new Date().toISOString() });
}
