/**
 * Routes super-admin : pilotage manuel des garages tant que l'inscription
 * en ligne self-service n'existe pas (créer un garage, générer son lien de
 * paiement Stripe, déclencher le provisioning de son numéro WhatsApp,
 * suspendre/réactiver). Réservé aux comptes présents dans `superadmins`.
 */
const express = require('express');

const { supabase, run } = require('../services/supabase');
const { requireSuperAdmin } = require('../services/auth');
const { createCheckoutLink } = require('../services/stripeBilling');
const { provisionGarageNumber } = require('../services/twilioProvisioning');

const router = express.Router();

router.use(requireSuperAdmin);

const ALLOWED_GARAGE_STATUS = ['onboarding', 'active', 'suspended', 'canceled'];

/** GET /superadmin/garages — liste tous les garages avec statut abonnement + numéro WhatsApp. */
router.get('/garages', async (_req, res, next) => {
  try {
    const data = await run(
      supabase
        .from('garages')
        .select(
          'id, name, vertical, status, created_at, ' +
            'subscriptions(status, current_period_end), ' +
            'garage_whatsapp_numbers(whatsapp_number, status, provisioning_error)'
        )
        .order('created_at', { ascending: false })
    );
    res.json({ count: data.length, garages: data });
  } catch (err) {
    next(err);
  }
});

/** POST /superadmin/garages — crée un nouveau garage (statut initial "onboarding"). */
router.post('/garages', async (req, res, next) => {
  try {
    const { name, vertical } = req.body || {};
    if (!name || !vertical) return res.status(400).json({ error: 'name et vertical sont obligatoires' });
    if (!['vente', 'reparation'].includes(vertical)) {
      return res.status(400).json({ error: "vertical doit valoir 'vente' ou 'reparation'" });
    }

    const data = await run(supabase.from('garages').insert({ name, vertical, status: 'onboarding' }).select());
    res.status(201).json({ garage: data[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /superadmin/garages/:id/checkout-link — génère un lien de paiement Stripe (abonnement mensuel). */
router.post('/garages/:id/checkout-link', async (req, res, next) => {
  try {
    const garage = await run(supabase.from('garages').select('id, name').eq('id', req.params.id).maybeSingle());
    if (!garage) return res.status(404).json({ error: 'Garage introuvable' });

    const url = await createCheckoutLink(garage, req.body?.email);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/** POST /superadmin/garages/:id/provision-whatsapp — achète/relance un numéro WhatsApp dédié. */
router.post('/garages/:id/provision-whatsapp', async (req, res, next) => {
  const garageId = req.params.id;
  try {
    const garage = await run(supabase.from('garages').select('id, name').eq('id', garageId).maybeSingle());
    if (!garage) return res.status(404).json({ error: 'Garage introuvable' });

    try {
      const { accountSid, authToken, whatsappNumber } = await provisionGarageNumber(garage);
      const data = await run(
        supabase
          .from('garage_whatsapp_numbers')
          .upsert(
            {
              garage_id: garageId,
              twilio_account_sid: accountSid,
              twilio_auth_token: authToken,
              whatsapp_number: whatsappNumber,
              // Reste "pending" tant que l'activation WhatsApp (Twilio/Meta) n'est
              // pas confirmée manuellement (voir /activate-whatsapp ci-dessous).
              status: 'pending',
              provisioning_error: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'garage_id' }
          )
          .select()
      );
      res.json({ number: data[0] });
    } catch (provisionErr) {
      const data = await run(
        supabase
          .from('garage_whatsapp_numbers')
          .upsert(
            {
              garage_id: garageId,
              twilio_account_sid: '',
              twilio_auth_token: '',
              whatsapp_number: '',
              status: 'failed',
              provisioning_error: provisionErr.message,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'garage_id' }
          )
          .select()
      );
      res.status(502).json({ error: `Provisioning Twilio échoué: ${provisionErr.message}`, number: data[0] });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /superadmin/garages/:id/activate-whatsapp — confirme manuellement
 * qu'un numéro est bien activé comme expéditeur WhatsApp (après vérification
 * dans la Console Twilio, cf. limite documentée dans provisionGarageNumber).
 */
router.post('/garages/:id/activate-whatsapp', async (req, res, next) => {
  try {
    const data = await run(
      supabase
        .from('garage_whatsapp_numbers')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('garage_id', req.params.id)
        .select()
    );
    if (!data.length) return res.status(404).json({ error: 'Numéro introuvable pour ce garage' });
    res.json({ number: data[0] });
  } catch (err) {
    next(err);
  }
});

/** PATCH /superadmin/garages/:id/status — override manuel (suspension, réactivation...). */
router.patch('/garages/:id/status', async (req, res, next) => {
  try {
    const { status, note } = req.body || {};
    if (!ALLOWED_GARAGE_STATUS.includes(status)) {
      return res.status(400).json({ error: `status doit valoir : ${ALLOWED_GARAGE_STATUS.join(', ')}` });
    }

    const data = await run(supabase.from('garages').update({ status }).eq('id', req.params.id).select());
    if (!data.length) return res.status(404).json({ error: 'Garage introuvable' });

    await run(
      supabase.from('admin_actions').insert({
        superadmin_user_id: req.userId,
        garage_id: req.params.id,
        action: `status -> ${status}`,
        note: note || null,
      })
    );

    res.json({ garage: data[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
