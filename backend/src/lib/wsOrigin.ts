/**
 * Contrôle d'origine des connexions WebSocket.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * Tant que l'interface et le serveur de diffusion partageaient une origine,
 * la sécurité du canal venait de la seule politique du navigateur : un socket
 * vers une autre origine est bloqué par la CSP (`connect-src 'self'`), et une
 * requête vers une autre origine ne porte ni cookie ni jeton automatique.
 *
 * Cette garantie disparaît dès que l'interface est déployée sur un CDN et l'API
 * ailleurs : le socket devient cross-origin, et le navigateur l'autorise si la
 * CSP l'autorise. Le contrôle doit donc être refait CÔTÉ SERVEUR, explicitement.
 *
 * Le jeton de session voyage dans la chaîne de requête, et aucune vérification
 * d'origine n'est faite aujourd'hui. Un site tiers pourrait donc ouvrir un
 * socket vers ce serveur avec un jeton qu'il a obtenu par ailleurs, et lire le
 * flux temps réel — scores en cours, chronomètre — sans être le détenteur
 * légitime de la session. C'est un canal d'information, pas un canal de
 * commande : l'impact est une fuite de données, pas une prise de contrôle.
 *
 * POLITIQUE
 * ---------
 *  1. `WS_ALLOWED_ORIGINS` vide (défaut) : seule la même origine est acceptée,
 *     ainsi que les clients sans en-tête `Origin` (sondes, tests, scripts
 *     serveur). **Le comportement par défaut est donc inchangé** : le
 *     déploiement actuel continue de fonctionner sans configuration.
 *  2. `WS_ALLOWED_ORIGINS` renseignée : liste blanche stricte. L'absence
 *     d'en-tête `Origin` est alors REFUSÉE, car une liste blanche n'a de sens
 *     que si elle est fermée.
 */

/** Normalise une origine pour comparaison : minuscules, sans barre oblique finale. */
function normalize(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Découpe une liste d'origines autorisées.
 *
 * Les séparateurs usuels sont acceptés (virgule, espace, point-virgule) parce
 * que ces variables se saisissent à la main dans un tableau de bord
 * d'hébergeur, où la virgule est plus facile à taper qu'un séparateur dédié.
 * Les entrées vides sont ignorées : une ligne laissée vide par accident ne doit
 * pas produire une origine « vide » autorisée.
 */
export function parseAllowedOrigins(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map(normalize)
    .filter((o) => o.length > 0);
}

export interface OriginDecision {
  allowed: boolean;
  /** Origine refusée, pour le journal. Les jetons ne sont jamais journalisés. */
  origin: string | null;
  /** Raison du refus, à destination des journaux et du client. */
  reason?: string;
}

/**
 * Autorise ou refuse une connexion entrante.
 *
 * @param origin        En-tête `Origin` de la requête (absent pour un client non navigateur).
 * @param allowed       Liste issue de `parseAllowedOrigins`.
 * @param requestHost   Hôte de la requête, pour la comparaison de même origine.
 */
export function checkWebSocketOrigin(
  origin: string | string[] | undefined,
  allowed: readonly string[],
  requestHost?: string
): OriginDecision {
  // Node expose l'en-tête sous forme de tableau s'il est répété. Une origine
  // répétée est anormale : on refuse, plutôt que de choisir au hasard.
  if (Array.isArray(origin)) {
    return { allowed: false, origin: null, reason: 'origine répétée' };
  }

  if (allowed.length === 0) {
    // Mode par défaut : même origine. Un client sans `Origin` est accepté —
    // ce sont les sondes de vivacité et les tests, qui ne sont pas des
    // navigateurs et ne peuvent donc pas usurper une origine.
    if (!origin) return { allowed: true, origin: null };
    if (!requestHost) {
      return { allowed: false, origin: origin, reason: 'hôte de requête inconnu' };
    }
    try {
      const candidate = new URL(origin);
      if (candidate.host === requestHost) return { allowed: true, origin: normalize(origin) };
      return {
        allowed: false,
        origin: normalize(origin),
        reason: 'origine tierce refusée (définir WS_ALLOWED_ORIGINS pour l\'autoriser)',
      };
    } catch {
      return { allowed: false, origin: null, reason: 'en-tête Origin illisible' };
    }
  }

  // Liste blanche explicite : fermée. Un client sans origine n'a rien à prouver,
  // mais ne peut rien prouver non plus — il est refusé.
  if (!origin) {
    return { allowed: false, origin: null, reason: 'origine absente' };
  }
  const normalized = normalize(origin);
  return allowed.includes(normalized)
    ? { allowed: true, origin: normalized }
    : { allowed: false, origin: normalized, reason: 'origine non autorisée' };
}
