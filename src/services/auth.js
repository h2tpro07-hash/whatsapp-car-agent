/**
 * Authentification de l'admin garage : vérifie le token Supabase Auth (JWT)
 * envoyé par le navigateur (Authorization: Bearer <token>), résout le garage
 * associé via `garage_members`. Remplace l'ancienne clé partagée ADMIN_API_KEY.
 */
const { supabase, run } = require('./supabase');

/**
 * Middleware Express : exige une session Supabase Auth valide, attache
 * `req.userId`, `req.garageId`, `req.role` et `req.garage` (id/name/vertical/status).
 */
async function requireGarageAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return res.status(401).json({ error: 'Authentification requise (en-tête Authorization: Bearer <token>)' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Session invalide ou expirée, reconnectez-vous' });
    }

    const membership = await run(
      supabase
        .from('garage_members')
        .select('garage_id, role, garages(id, name, vertical, status)')
        .eq('user_id', userData.user.id)
        .maybeSingle()
    );

    if (!membership || !membership.garages) {
      return res.status(403).json({ error: 'Aucun garage associé à ce compte' });
    }

    req.userId = userData.user.id;
    req.garageId = membership.garage_id;
    req.role = membership.role;
    req.garage = membership.garages;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Middleware : restreint une route au métier `vente` ou `reparation`. */
function requireVertical(vertical) {
  return (req, res, next) => {
    if (req.garage?.vertical !== vertical) {
      return res.status(403).json({ error: `Fonctionnalité indisponible pour le métier "${req.garage?.vertical}"` });
    }
    return next();
  };
}

module.exports = { requireGarageAuth, requireVertical };
