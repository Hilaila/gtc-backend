import crypto from 'crypto';
import { Horizon, Keypair, TransactionBuilder, Operation, Asset, Memo } from '@stellar/stellar-sdk';

const PI_API = 'https://api.minepi.com/v2';
const HORIZON = 'https://api.testnet.minepi.com';
const PASSPHRASE = 'Pi Testnet';

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const expected = process.env.ADMIN_KEY;
  if (!expected || !sameKey(req.headers['x-admin-key'], expected))
    return res.status(401).json({ error: 'Non autorisé' });

  const body = req.body || {};
  let step = 'init';
  try {
    const kp = Keypair.fromSecret(process.env.APP_WALLET_SEED);
    const server = new Horizon.Server(HORIZON);

    if (body.check) {
      try {
        const acc = await server.loadAccount(kp.publicKey());
        const bal = acc.balances.find(b => b.asset_type === 'native');
        return res.json({ address: kp.publicKey(), existe: true, solde: bal && bal.balance });
      } catch (e) {
        return res.json({ address: kp.publicKey(), existe: false });
      }
    }

    const uid = body.uid;
    const amount = Number(body.amount || 0.01);
    if (!uid) return res.status(400).json({ error: 'uid manquant' });
    if (!(amount > 0 && amount <= 1)) return res.status(400).json({ error: 'Montant invalide' });

    const headers = { Authorization: `Key ${process.env.PI_API_KEY}`, 'Content-Type': 'application/json' };

    step = 'create';
    const r1 = await fetch(`${PI_API}/payments`, {
      method: 'POST', headers,
      body: JSON.stringify({ payment: { amount, memo: 'GTC payment', metadata: { type: 'a2u' }, uid } })
    });
    const p = await r1.json();
    if (!r1.ok) return res.status(r1.status).json({ step, pi: p });

    step = 'sign';
    const account = await server.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: String(await server.fetchBaseFee()),
      networkPassphrase: PASSPHRASE,
      timebounds: await server.fetchTimebounds(180)
    })
      .addOperation(Operation.payment({ destination: p.to_address, asset: Asset.native(), amount: String(amount) }))
      .addMemo(Memo.text(p.identifier))
      .build();
    tx.sign(kp);
    const sent = await server.submitTransaction(tx);

    step = 'complete';
    const r3 = await fetch(`${PI_API}/payments/${p.identifier}/complete`, {
      method: 'POST', headers, body: JSON.stringify({ txid: sent.hash })
    });
    return res.status(r3.status).json({ step: 'done', pi: await r3.json() });
  } catch (e) {
    return res.status(500).json({ step, error: e.message });
  }
}
