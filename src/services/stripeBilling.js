/**
 * Facturation Stripe : lien de paiement (Checkout) + traitement des webhooks.
 * Source de vérité = l'objet `subscription` renvoyé par Stripe (jamais
 * d'incrément/toggle local), pour rester cohérent même en cas de webhook
 * redélivré ou reçu dans le désordre.
 */
const Stripe = require('stripe');

const { supabase, run } = require('./supabase');

const { STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, PUBLIC_URL } = process.env;

const isConfigured = Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/**
 * Crée un lien de paiement Stripe Checkout (abonnement mensuel) pour un garage.
 * @param {{id: string, name: string}} garage
 * @param {string} [customerEmail]
 * @returns {Promise<string>} URL à envoyer au garage
 */
async function createCheckoutLink(garage, customerEmail) {
  if (!isConfigured) throw new Error('Stripe non configuré (STRIPE_SECRET_KEY / STRIPE_PRICE_ID manquants)');
  if (!PUBLIC_URL) throw new Error('PUBLIC_URL manquant (nécessaire pour les URLs de retour Stripe)');

  const base = PUBLIC_URL.replace(/\/$/, '');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: garage.id,
    metadata: { garage_id: garage.id },
    customer_email: customerEmail || undefined,
    success_url: `${base}/superadmin?checkout=success&garage_id=${garage.id}`,
    cancel_url: `${base}/superadmin?checkout=cancelled&garage_id=${garage.id}`,
  });

  return session.url;
}

/** Vérifie la signature du webhook Stripe (nécessite le corps brut de la requête). */
function verifyWebhookSignature(rawBody, signature) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET manquant');
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

/** Traduit un statut d'abonnement Stripe en statut garage. */
function garageStatusFor(subscriptionStatus) {
  if (['active', 'trialing'].includes(subscriptionStatus)) return 'active';
  if (['past_due', 'unpaid'].includes(subscriptionStatus)) return 'suspended';
  if (subscriptionStatus === 'canceled') return 'canceled';
  return 'onboarding';
}

/** Upsert de la ligne `subscriptions` + recalcul de `garages.status`. */
async function syncSubscription({
  garageId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
  currentPeriodEnd,
  cancelAtPeriodEnd,
}) {
  await run(
    supabase.from('subscriptions').upsert(
      {
        garage_id: garageId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId || null,
        status,
        current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
        cancel_at_period_end: Boolean(cancelAtPeriodEnd),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'garage_id' }
    )
  );

  await run(supabase.from('garages').update({ status: garageStatusFor(status) }).eq('id', garageId));
}

/**
 * Traite un événement Stripe. Idempotent via `processed_stripe_events` :
 * une redélivrance ne doit jamais re-déclencher de changement d'état.
 * @param {import('stripe').Stripe.Event} event
 */
async function handleWebhookEvent(event) {
  const already = await run(
    supabase.from('processed_stripe_events').select('event_id').eq('event_id', event.id).maybeSingle()
  );
  if (already) return { skipped: true };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const garageId = session.metadata?.garage_id || session.client_reference_id;
      if (garageId) {
        const subscription = session.subscription
          ? await stripe.subscriptions.retrieve(session.subscription)
          : null;
        await syncSubscription({
          garageId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription || null,
          status: subscription?.status || 'active',
          currentPeriodEnd: subscription?.current_period_end,
          cancelAtPeriodEnd: subscription?.cancel_at_period_end,
        });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const existing = await run(
        supabase
          .from('subscriptions')
          .select('garage_id')
          .eq('stripe_subscription_id', subscription.id)
          .maybeSingle()
      );
      const garageId = existing?.garage_id || subscription.metadata?.garage_id;
      if (garageId) {
        await syncSubscription({
          garageId,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        });
      }
      break;
    }
    default:
      break;
  }

  await run(supabase.from('processed_stripe_events').insert({ event_id: event.id }));
  return { skipped: false };
}

module.exports = { createCheckoutLink, verifyWebhookSignature, handleWebhookEvent, isConfigured };
