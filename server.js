// Serveur de paiement Poupet Créations — version 2
// Variables Railway : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL, PB_URL, PB_CLE
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const catalog = require('./catalog.json');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITES = (process.env.SITE_URL || 'https://poupetcreations.fr,https://www.poupetcreations.fr')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
if (!SITES.includes('https://poupetcreations.fr')) SITES.push('https://poupetcreations.fr');
if (!SITES.includes('https://www.poupetcreations.fr')) SITES.push('https://www.poupetcreations.fr');
const PB_URL = (process.env.PB_URL || 'https://poupetcreations.fr/.sfs-be').replace(/\/$/, '');
const PB_CLE = process.env.PB_CLE || '';
const MIN_RATIO = Number(process.env.MIN_RATIO || 0.6); // garde-fou : prix payé >= 60 % du prix catalogue
const eur = (n) => Math.round(n * 100) / 100;

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, !o || SITES.includes(o)) }));

// ---------- Webhook Stripe (corps brut obligatoire, avant express.json) ----------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send('Signature invalide');
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      if (s.payment_status === 'paid') await enregistrerCommande(s);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook erreur:', err.message);
    res.status(500).json({ error: 'À rejouer' }); // Stripe réessaiera
  }
});

app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Poupet Stripe Server', version: 2 }));
app.get('/health', (req, res) => res.json({ status: 'ok', version: 2 }));

// ---------- Vérification d'un paiement (page « Merci ») ----------
app.get('/session-status', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'id invalide' });
    const s = await stripe.checkout.sessions.retrieve(id);
    res.json({ paid: s.payment_status === 'paid', amount: (s.amount_total || 0) / 100 });
  } catch (err) { res.status(404).json({ paid: false }); }
});

// ---------- Livraison : mêmes règles que le panier ----------
function calculerLivraison(lignes, sousTotal) {
  const lum = lignes.filter(l => l.category === 'luminaires');
  if (lum.length) return lum.some(l => l.price > 140) ? 50 : 20;
  const petits = ['obj-13','obj-14','obj-15','obj-16','obj-17','obj-18','obj-19','obj-20','obj-21'];
  if (lignes.some(l => l.category === 'sacs' || petits.includes(l.id))) return 7.9;
  return 0; // autres produits : pas de frais de port
}

// ---------- Code promo : relu dans la base à chaque paiement ----------
async function lireCode(code) {
  const c = String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const q = new URLSearchParams({ filter: `code = "${c}"`, code: c, perPage: '1' });
  const r = await fetch(`${PB_URL}/api/collections/codes_reduction/records?${q}`);
  if (!r.ok) throw new Error('Code introuvable');
  const rec = (await r.json()).items[0];
  const now = Date.now();
  if (!rec || !rec.actif) return null;
  if (rec.date_debut && new Date(rec.date_debut).getTime() > now) return null;
  if (rec.date_fin && new Date(rec.date_fin).getTime() + 86400000 < now) return null;
  if (rec.limite_utilisations > 0 && (rec.utilisations || 0) >= rec.limite_utilisations) return null;
  return rec;
}

// ---------- Création de la page de paiement ----------
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, code, siteUrl } = req.body || {};
    const origin = req.headers.origin;
    const site = SITES.includes(origin) ? origin : SITES.includes(String(siteUrl || '').replace(/\/$/, '')) ? String(siteUrl).replace(/\/$/, '') : null;
    if (!site) return res.status(403).json({ error: 'Adresse non autorisée' });
    if (!Array.isArray(items) || !items.length || items.length > 40) return res.status(400).json({ error: 'Panier invalide' });

    const lignes = [];
    for (const it of items) {
      const ref = catalog[it.id];
      const qty = Number(it.qty);
      const prix = Number(it.price);
      if (!ref) return res.status(400).json({ error: `Produit indisponible au paiement direct : ${String(it.name || it.id).slice(0, 60)}` });
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Quantité invalide' });
      if (!Number.isFinite(prix) || prix < eur(ref.price * MIN_RATIO) || prix > ref.price * 5) {
        return res.status(400).json({ error: 'Prix incohérent pour ' + String(it.name || it.id).slice(0, 60) });
      }
      lignes.push({ id: it.id, category: ref.category, price: eur(prix), qty, name: String(it.name || ref.id).slice(0, 120),
        img: typeof it.img === 'string' && it.img.startsWith('https://') ? it.img : undefined,
        description: String(it.description || '').slice(0, 480) });
    }

    const sousTotal = eur(lignes.reduce((s, l) => s + l.price * l.qty, 0));
    let remise = 0, codeValide = null;
    if (code) {
      const rec = await lireCode(code);
      if (!rec) return res.status(400).json({ error: 'Ce code n’est plus valable.' });
      if (rec.montant_minimum > 0 && sousTotal < rec.montant_minimum) return res.status(400).json({ error: 'Montant minimum non atteint pour ce code.' });
      remise = rec.type === 'pourcentage' ? eur(sousTotal * rec.valeur / 100) : Math.min(rec.valeur, sousTotal);
      codeValide = rec.code;
    }
    const livraison = calculerLivraison(lignes, sousTotal);
    if (sousTotal - remise + livraison < 0.5) return res.status(400).json({ error: 'Montant trop faible' });

    const params = {
      mode: 'payment',
      line_items: lignes.map(l => ({
        price_data: { currency: 'eur', unit_amount: Math.round(l.price * 100),
          product_data: { name: l.name, ...(l.img ? { images: [l.img] } : {}), ...(l.description ? { description: l.description } : {}) } },
        quantity: l.qty })),
      success_url: `${site}/?page=thank-you&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/?paiement=annule`,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
      locale: 'fr',
      metadata: { code_promo: codeValide || '', livraison: String(livraison), panier: lignes.map(l => `${l.id}x${l.qty}`).join(',').slice(0, 480) },
    };
    if (livraison > 0) {
      params.shipping_options = [{ shipping_rate_data: { type: 'fixed_amount', display_name: 'Livraison',
        fixed_amount: { amount: Math.round(livraison * 100), currency: 'eur' } } }];
    }
    if (remise > 0) {
      const coupon = await stripe.coupons.create({ amount_off: Math.round(remise * 100), currency: 'eur', duration: 'once', name: `Code ${codeValide}` });
      params.discounts = [{ coupon: coupon.id }];
    }
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Paiement indisponible, réessayez.' });
  }
});

// ---------- Commande enregistrée seulement une fois payée ----------
async function enregistrerCommande(s) {
  const enc = { 'Content-Type': 'application/json' };
  const r = await fetch(`${PB_URL}/api/collections/paiements_stripe/records`, { method: 'POST', headers: enc, body: JSON.stringify({
    id: crypto.createHash('sha1').update(s.id).digest('hex').slice(0, 15), session: s.id, statut: 'payee', montant: (s.amount_total || 0) / 100,
    email: s.customer_details && s.customer_details.email || '', nom: s.customer_details && s.customer_details.name || '',
    code_promo: s.metadata && s.metadata.code_promo || '', livraison: Number(s.metadata && s.metadata.livraison || 0),
    details: (s.metadata && s.metadata.panier || '').slice(0, 900), cle: PB_CLE }) });
  if (!r.ok) {
    const txt = await r.text();
    if (/unique|already|exists/i.test(txt)) return; // déjà enregistrée
    throw new Error('Enregistrement impossible : ' + r.status);
  }
  const code = s.metadata && s.metadata.code_promo;
  if (code) {
    const rec = await lireCodeBrut(code);
    if (rec) await fetch(`${PB_URL}/api/collections/codes_reduction/records/${rec.id}`, { method: 'PATCH', headers: enc, body: JSON.stringify({ utilisations: (rec.utilisations || 0) + 1 }) });
  }
}
async function lireCodeBrut(code) {
  const c = String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const q = new URLSearchParams({ filter: `code = "${c}"`, code: c, perPage: '1' });
  const r = await fetch(`${PB_URL}/api/collections/codes_reduction/records?${q}`);
  return r.ok ? (await r.json()).items[0] : null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur Poupet v2 démarré sur le port ' + PORT));
