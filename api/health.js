export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    status: 'ok',
    app: 'GeoTerraChain QFS Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
}
