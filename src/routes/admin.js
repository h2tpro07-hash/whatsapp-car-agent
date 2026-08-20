/**
 * API d'administration : CRUD scopé par garage (garage_id résolu depuis la
 * session Supabase Auth). `/cars` sert le métier vente, `/services` +
 * `/appointments` + `/quotes` le métier réparation.
 */
const express = require('express');

const { supabase, run } = require('../services/supabase');
const { requireGarageAuth, requireVertical } = require('../services/auth');

const router = express.Router();

router.use(requireGarageAuth);

/** GET /admin/me — infos du garage connecté, utilisées par l'UI pour choisir vente/réparation. */
router.get('/me', (req, res) => {
  res.json({ garage: req.garage, role: req.role });
});

/**
 * Fabrique un routeur CRUD générique scopé par garage_id pour une table.
 * @param {string} table nom de la table (aussi utilisé comme clé de réponse)
 * @param {object} opts
 * @param {string[]} opts.allowedFields colonnes acceptées en écriture
 * @param {string[]} [opts.requiredFields] colonnes obligatoires à la création
 * @param {string[]} [opts.numericFields] colonnes à valider/convertir en nombre positif
 * @param {string[]} [opts.booleanFields] colonnes à convertir en booléen
 * @param {string} [opts.statusField] colonne de statut à valider par une liste fermée
 * @param {string[]} [opts.allowedStatus] valeurs autorisées pour `statusField`
 * @param {string} [opts.order] colonne de tri par défaut
 */
function makeResourceRouter(table, opts) {
  const {
    allowedFields,
    requiredFields = [],
    numericFields = [],
    booleanFields = [],
    statusField,
    allowedStatus = [],
    order = 'id',
  } = opts;

  const resource = express.Router();
  const singular = table.endsWith('s') ? table.slice(0, -1) : table;

  function sanitize(body, { partial = false } = {}) {
    const errors = [];
    const row = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) row[field] = body[field];
    }

    if (!partial) {
      for (const field of requiredFields) {
        if (row[field] === undefined || row[field] === '') errors.push(`${field} est obligatoire`);
      }
    }

    for (const field of numericFields) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        const n = Number(row[field]);
        if (Number.isNaN(n) || n < 0) errors.push(`${field} doit être un nombre positif`);
        else row[field] = n;
      } else if (row[field] === '') {
        row[field] = null;
      }
    }

    for (const field of booleanFields) {
      if (row[field] !== undefined) row[field] = row[field] === true || row[field] === 'true';
    }

    if (statusField && row[statusField] !== undefined && !allowedStatus.includes(row[statusField])) {
      errors.push(`${statusField} doit valoir : ${allowedStatus.join(', ')}`);
    }

    return { row, errors };
  }

  /** GET /admin/<table> — liste du garage connecté (filtre optionnel ?<statusField>=). */
  resource.get('/', async (req, res, next) => {
    try {
      let query = supabase.from(table).select('*').eq('garage_id', req.garageId).order(order, { ascending: true });
      if (statusField && req.query[statusField]) query = query.eq(statusField, req.query[statusField]);

      const data = await run(query);
      res.json({ count: data.length, [table]: data });
    } catch (err) {
      next(err);
    }
  });

  /** POST /admin/<table> — ajoute une ligne (objet unique ou tableau), forcée sur le garage connecté. */
  resource.post('/', async (req, res, next) => {
    try {
      const payload = Array.isArray(req.body) ? req.body : [req.body];
      const rows = [];

      for (const [i, item] of payload.entries()) {
        const { row, errors } = sanitize(item || {});
        if (errors.length) return res.status(400).json({ error: `Élément ${i + 1}: ${errors.join(', ')}` });
        rows.push({ ...row, garage_id: req.garageId });
      }

      const data = await run(supabase.from(table).insert(rows).select());
      res.status(201).json({ created: data.length, [table]: data });
    } catch (err) {
      next(err);
    }
  });

  /** PATCH /admin/<table>/:id — mise à jour partielle, restreinte au garage connecté. */
  resource.patch('/:id', async (req, res, next) => {
    try {
      const { row, errors } = sanitize(req.body || {}, { partial: true });
      if (errors.length) return res.status(400).json({ error: errors.join(', ') });
      if (Object.keys(row).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });

      const data = await run(
        supabase.from(table).update(row).eq('id', req.params.id).eq('garage_id', req.garageId).select()
      );
      if (!data.length) return res.status(404).json({ error: 'Élément introuvable' });
      res.json({ [singular]: data[0] });
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /admin/<table>/:id — restreint au garage connecté. */
  resource.delete('/:id', async (req, res, next) => {
    try {
      const data = await run(
        supabase.from(table).delete().eq('id', req.params.id).eq('garage_id', req.garageId).select()
      );
      if (!data.length) return res.status(404).json({ error: 'Élément introuvable' });
      res.json({ deleted: data[0].id });
    } catch (err) {
      next(err);
    }
  });

  return resource;
}

// --- Métier vente ---
router.use(
  '/cars',
  requireVertical('vente'),
  makeResourceRouter('cars', {
    allowedFields: ['brand', 'model', 'year', 'price', 'mileage', 'fuel', 'description', 'status'],
    requiredFields: ['brand', 'model', 'year', 'price', 'mileage', 'fuel'],
    numericFields: ['year', 'price', 'mileage'],
    statusField: 'status',
    allowedStatus: ['available', 'reserved', 'sold'],
  })
);

// --- Métier réparation ---
router.use(
  '/services',
  requireVertical('reparation'),
  makeResourceRouter('services', {
    allowedFields: ['name', 'description', 'price_min', 'price_max', 'duration_min', 'active'],
    requiredFields: ['name'],
    numericFields: ['price_min', 'price_max', 'duration_min'],
    booleanFields: ['active'],
    order: 'name',
  })
);

router.use(
  '/appointments',
  requireVertical('reparation'),
  makeResourceRouter('appointments', {
    allowedFields: [
      'service_id',
      'customer_phone',
      'customer_name',
      'vehicle_desc',
      'requested_at',
      'scheduled_at',
      'status',
      'notes',
    ],
    requiredFields: ['customer_phone'],
    statusField: 'status',
    allowedStatus: ['requested', 'confirmed', 'completed', 'canceled', 'no_show'],
    order: 'created_at',
  })
);

router.use(
  '/quotes',
  requireVertical('reparation'),
  makeResourceRouter('quotes', {
    allowedFields: ['appointment_id', 'customer_phone', 'description', 'amount', 'status'],
    requiredFields: ['customer_phone', 'description'],
    numericFields: ['amount'],
    statusField: 'status',
    allowedStatus: ['draft', 'sent', 'accepted', 'declined'],
    order: 'created_at',
  })
);

module.exports = router;
