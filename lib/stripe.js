import Stripe from 'stripe';
let override = null;
let real = null;
export function setStripe(s) { override = s; }
export function getStripe() {
  if (override) return override;
  if (!real) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    real = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return real;
}
// Webhook verification never needs the network, so always use the real library.
export function verifyWebhook(rawBody, signature) {
  const s = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  return s.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}
