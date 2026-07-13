// GeoTerraChain QFS — Knowledge Engine™ (Priorité 1 du Document Directeur IA)
// Base de connaissances interne : répond instantanément, sans appel externe,
// aux questions les plus courantes. Fonctionne même si Anthropic est indisponible
// ou mal configuré — c'est la base du Failover Engine™.

const FAQ = [
  {
    motsCles: ['kyc', 'vérification identité', 'pourquoi kyc'],
    reponse: "Le KYC (Know Your Customer) est obligatoire sur GeoTerraChain QFS : seuls les Pioneers vérifiés par Pi Network peuvent tokeniser des actifs fonciers. La vérification est automatique lors de la connexion via Pi SDK — aucune démarche supplémentaire n'est nécessaire de ton côté."
  },
  {
    motsCles: ['gtcπ', 'gtcp', 'gtc', 'token', 'jeton', 'supply', 'tokenomique'],
    reponse: "GTCπ est le token de gouvernance de GeoTerraChain QFS. Supply totale : 3 141 592 GTCπ. Prix de base : 1 GTCπ = 1 π. Un burn déflationnaire de 0,5% s'applique à chaque tokenisation, réduisant progressivement la supply en circulation."
  },
  {
    motsCles: ['burn', 'brûl', 'déflation'],
    reponse: "Le mécanisme de burn déflationnaire retire 0,5% du montant de chaque tokenisation de la supply totale de GTCπ. Concrètement : sur une tokenisation de 100 GTCπ, 0,5 GTCπ est brûlé et 99,5 GTCπ reviennent au propriétaire."
  },
  {
    motsCles: ['tokeniser', 'tokenisation', 'comment tokeniser'],
    reponse: "Pour tokeniser : connecte-toi via π Connexion (KYC requis), va dans l'onglet 📁 Dossier Foncier pour créer ton dossier avec le mode d'acquisition et les pièces justificatives, puis dans ◈ Tokeniser une fois le dossier au niveau N6 (Actif éligible à étude)."
  },
  {
    motsCles: ['dossier foncier', 'mode acquisition', 'n0', 'n1', 'n6', 'niveau vérification'],
    reponse: "Le Référentiel foncier classe chaque dossier de N0 (brouillon) à N7 (rejeté/litigieux). Seuls les dossiers atteignant N6 (Actif éligible à étude) sont recommandés pour une tokenisation sérieuse. 11 modes d'acquisition sont reconnus : achat/vente, succession, donation, titre foncier, droit coutumier rural, etc."
  },
  {
    motsCles: ['uemoa', 'zone géographique', 'pays', 'côte d\'ivoire'],
    reponse: "GeoTerraChain QFS lance en priorité dans la zone UEMOA (8 pays : Côte d'Ivoire, Sénégal, Mali, Burkina Faso, Bénin, Togo, Niger, Guinée-Bissau), avec une expansion prévue vers l'ensemble du continent africain."
  },
  {
    motsCles: ['convocation', 'réunion', 'gouvernance', 'présence'],
    reponse: "Le module 📩 Convocations & Présences permet de créer des convocations officielles, recueillir les confirmations de présence des dirigeants, et tenir un registre numérique sécurisé avec empreinte SHA-256 à la clôture."
  },
  {
    motsCles: ['sécurité', 'vault', 'clé api', 'chiffrement'],
    reponse: "Les clés API et secrets sensibles sont chiffrés (AES-256-GCM) et jamais stockés en clair. Chaque action sensible est vérifiée côté serveur via le token Pi Network authentique — jamais uniquement côté navigateur."
  }
];

export function chercherReponse(question) {
  const q = question.toLowerCase();
  let meilleur = null, meilleurScore = 0;
  for (const entry of FAQ) {
    const score = entry.motsCles.filter(mot => q.includes(mot)).length;
    if (score > meilleurScore) { meilleurScore = score; meilleur = entry; }
  }
  return meilleurScore > 0 ? meilleur.reponse : null;
}
