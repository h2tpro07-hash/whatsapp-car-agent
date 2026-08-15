/**
 * API d'administration du stock : CRUD sur la table `cars`.
 * Protégée par l'en-tête `x-admin-key` (variable ADMIN_API_KEY).
 */
const express = require('express');

const { supabase } = require('../services/supabase');

const router = express.Router();

const ALLOWED_FIELDS = ['brand', 'model', 'year', 'price', 'mileage', 'fuel', 'description', 'status'];
const REQUIRED_FIELDS = ['brand', 'model', 'year', 'price', 'mileage', 'fuel'];
const ALLOWED_STATUS = ['available', 'reserved', 'sold'];

/** Authentification par clé partagée. */
router.use((req, res, next) => {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(500).json({ error: 'ADMIN_API_KEY non configurée sur le serveur' });
  if (req.get('x-admin-key') !== expected) return res.status(401).json({ error: 'Non autorisé' });
  return next();
});

/** Garde uniquement les colonnes connues et valide les types. */
function sanitize(body, { partial = false } = {}) {
  const errors = [];
  const car = {};

  for (const field of ALLOWED_FIELDS) {
    if (body[field] !== undefined) car[field] = body[field];
  }

  if (!partial) {
    for (const field of REQUIRED_FIELDS) {
      if (car[field] === undefined || car[field] === '') errors.push(`${field} est obligatoire`);
    }
  }

  for (const field of ['year', 'price', 'mileage']) {
    if (car[field] !== undefined) {
      const n = Number(car[field]);
      if (Number.isNaN(n) || n < 0) errors.push(`${field} doit être un nombre positif`);
      else car[field] = n;
    }
  }

  if (car.status !== undefined && !ALLOWED_STATUS.includes(car.status)) {
    errors.push(`status doit valoir : ${ALLOWED_STATUS.join(', ')}`);
  }

  return { car, errors };
}

/** GET /admin/cars — liste complète (filtre optionnel ?status=). */
router.get('/cars', async (req, res, next) => {
  try {
    let query = supabase.from('cars').select('*').order('id', { ascending: true });
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ count: data.length, cars: data });
  } catch (err) {
    next(err);
  }
});

/** POST /admin/cars — ajoute un véhicule (objet unique ou tableau). */
router.post('/cars', async (req, res, next) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : [req.body];
    const cars = [];

    for (const [i, item] of payload.entries()) {
      const { car, errors } = sanitize(item || {});
      if (errors.length) return res.status(400).json({ error: `Véhicule ${i + 1}: ${errors.join(', ')}` });
      cars.push(car);
    }

    const { data, error } = await supabase.from('cars').insert(cars).select();
    if (error) throw new Error(error.message);
    res.status(201).json({ created: data.length, cars: data });
  } catch (err) {
    next(err);
  }
});

/** PATCH /admin/cars/:id — mise à jour partielle (ex: passer en `sold`). */
router.patch('/cars/:id', async (req, res, next) => {
  try {
    const { car, errors } = sanitize(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });
    if (Object.keys(car).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });

    const { data, error } = await supabase.from('cars').update(car).eq('id', req.params.id).select();
    if (error) throw new Error(error.message);
    if (!data.length) return res.status(404).json({ error: 'Véhicule introuvable' });
    res.json({ car: data[0] });
  } catch (err) {
    next(err);
  }
});

/** DELETE /admin/cars/:id */
router.delete('/cars/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('cars').delete().eq('id', req.params.id).select();
    if (error) throw new Error(error.message);
    if (!data.length) return res.status(404).json({ error: 'Véhicule introuvable' });
    res.json({ deleted: data[0].id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
