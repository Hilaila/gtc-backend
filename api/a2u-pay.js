import { Horizon, Keypair, TransactionBuilder, Operation, Asset, Memo } from '@stellar/stellar-sdk';

const PI_API = 'https://api.minepi.com/v2';
const HORIZON = 'https://api.testnet.minepi.com';
const PASSPHRASE = 'Pi Testnet';

export default async function handler(req, res) {
  const key = req.headers['x-admin-key'] || req.query.k;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Clé admin invalide' });

  let step = 'init';
  try {
    const kp = Keypair.fromSecret(process.env.APP_WALLET_SEED);
    const server = new Horizon.Server(HORIZON);

    // Mode check : ?k=...&check=1  (aucun paiement)
    if (req.query.check !== undefined) {
      try {
        const acc = await server.loadAccount(kp.publicKey());
        const bal = acc.balances.find(b => b.asset_type === 'native');
        return res.json({ address: kp.publicKey(), existe: true, solde: bal && bal.balance });
      } catch (e) {
        return res.json({ address: kp.publicKey(), existe: false, note: 'Compte absent du réseau de test' });
      }
    }

    // Mode paiement : ?k=...&uid=...&amount=0.01
    const uid = req.query.uid || (req.body && req.body.uid);
    const amount = Number(req.query.amount || (req.body && req.body.amount) || 0.01);
    if (!uid) return res.status(400).json({ error: 'uid manquant' });

    const headers = { Authorization: `Key ${process.env.PI_API_KEY}`, 'Content-Type': 'application/json' };

    step = 'create';
    const r1 = await fetch(`${PI_API}/payments`, {
      method: 'POST', headers,
      body: JSON.stringify({ payment: { amount, memo: 'GTC test', metadata: { type: 'a2u-test' }, uid } })
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
    return res.status(500).json({ step, error: e.message, detail: e.response && e.response.data && e.response.data.extras && e.response.data.extras.result_codes });
  }
}
