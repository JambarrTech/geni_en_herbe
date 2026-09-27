import type { Router, Request, Response, NextFunction } from 'express';

/**
 * Validation des paramètres de route.
 *
 * Le problème
 * -----------
 * Trente-et-un handlers font `parseInt(req.params.id, 10)` sans vérifier le
 * résultat. `parseInt('abc', 10)` ne lève pas : il renvoie `NaN`. Selon la
 * route, le `NaN` se retrouve alors dans une requête PostgreSQL, ce qui donne
 * soit un 404 trompeur (« la ressource n'existe pas » alors que la demande est
 * malformée), soit une erreur base de données remontée en 500. Une URL
 * griffonnée à la main ne doit pas produire une erreur serveur : c'est une
 * mauvaise requête du client, pas une panne.
 *
 * La solution
 * -----------
 * `router.param()` d'Express, qui valide un paramètre une seule fois pour TOUTES
 * les routes du routeur. On normalise ensuite `req.params` : le gestionnaire
 * appelait `parseInt(req.params.id, 10)`, qui continue de fonctionner tel quel
 * une fois la valeur garantie numérique.
 *
 * L'alternative — ajouter `if (id === null) return res.status(400)…` dans les
 * trente-et-un handlers — aurait été plus explicite mais répété trente-et-un
 * fois le même test, avec le risque d'en oublier un.
 */

/**
 * Convertit un paramètre de route en identifiant entier positif.
 * Renvoie `null` si la valeur n'en est pas un — y compris si elle est trop
 * grande pour être un entier sûr, ou négative, ce qu'aucun identifiant n'est.
 */
export function parseId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Installe la validation des paramètres d'un routeur.
 *
 * ```
 * export const teamsRouter = Router();
 * validateIds(teamsRouter);
 * ```
 *
 * À appeler juste après la création du routeur, avant toute déclaration de
 * route : Express n'applique `param()` qu'aux routes enregistrées ensuite.
 */
export function validateIds(router: Router) {
  const check = (name: string) => (req: Request, res: Response, next: NextFunction) => {
    const raw = (req.params as Record<string, string>)[name];
    const id = parseId(raw);
    if (id === null) {
      res.status(400).json({
        error: `Identifiant invalide pour « ${name} » : « ${String(raw).slice(0, 32)} ». Un entier positif est attendu.`,
      });
      return;
    }
    // Normalisé : les handlers font `parseInt(req.params.id, 10)`, qui reste
    // correct et ne peut plus produire `NaN`.
    (req.params as Record<string, string>)[name] = String(id);
    next();
  };

  router.param('id', check('id'));
  router.param('memberId', check('memberId'));
}
