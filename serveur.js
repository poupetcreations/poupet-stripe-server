const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Poupet Stripe Server' }));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const { items, successUrl, cancelUrl } = req.body;
    const line_items = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.name,
          ...(item.img ? { images: [item.img] } : {}),
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: item.qty,
    }));
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU'] },
      locale: 'fr',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Serveur Poupet démarré sur le port ' + PORT));
