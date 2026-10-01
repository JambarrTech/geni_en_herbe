/**
 * Mise en forme des matchs pour l'API.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * Ces trois fonctions vivaient dans `routes/matches.routes.ts`, au milieu de
 * 1080 lignes de gestionnaires Express. Elles n'ont pourtant rien à voir avec
 * HTTP : ce sont des règles métier pures.
 *
 * `winnerTeamIdOf` en particulier répond à la question la plus lourde de
 * conséquence de toute la plateforme — « qui a gagné ce match ? » — et elle
 * n'était vérifiable qu'en montant un serveur, une base et une session. Le
 * classement (voir rankings) et les statistiques d'équipe en dépendent, et une
 * erreur de signe y produirait un classement inversé que personne ne
 * remarquerait avant la remise des prix.
 *
 * Extraire ces fonctions permet de les éprouver directement, avec des cas
 * limites explicites : égalité, scores négatifs (pénalités), et JSON
 * d'options corrompu.
 *
 * Note sur l'égalité : un match nul renvoie `null`, et non `0` ni l'une des
 * deux équipes. `null` est la seule valeur qui se distingue d'un identifiant
 * d'équipe valide, donc la seule qui ne peut pas être prise pour un gagnant par
 * erreur.
 */
import { createLogger } from './logger.ts';

// Même canal que le routeur : les avertissements émis ici doivent continuer à
// se filtrer avec les autres logs de l'API.
const log = createLogger('api');

/** Colonnes strictement nécessaires au calcul du vainqueur. */
export interface MatchScoreRow {
  teamAId: number;
  teamBId: number;
  scoreA: number;
  scoreB: number;
}

/** Projection minimale d'une équipe, telle qu'envoyée au client. */
export interface TeamSummary {
  id: number;
  eventId: number;
  name: string;
  code: string;
  logo: string | null;
  status: string;
}

/** Projection minimale d'un utilisateur : jamais l'empreinte du mot de passe. */
export interface UserSummary {
  id: number;
  name: string;
}

/**
 * Identifiant de l'équipe gagnante, ou `null` en cas d'égalité.
 *
 * Une égalité n'a pas de gagnant : renvoyer l'équipe A (ou B) ferait compter
 * une victoire de plus dans le classement, et une défaite de plus pour
 * l'adversaire. Le `null` force chaque appelant à traiter le cas.
 */
export function winnerTeamIdOf(m: MatchScoreRow): number | null {
  if (m.scoreA > m.scoreB) return m.teamAId;
  if (m.scoreB > m.scoreA) return m.teamBId;
  return null;
}

/**
 * Décode la colonne `options` d'une question.
 *
 * Cette colonne est un `text` contenant du JSON. Elle peut être `NULL` (question
 * ouverte), ou corrompue — une donnée saisie à la main, une migration partielle.
 *
 * On ne laisse JAMAIS remonter l'exception de `JSON.parse` : un seul enregistrement
 * dont les options sont illisibles suffirait à faire échouer tout l'écran jury,
 * alors que la question reste jouable sans ses options. On journalise et on
 * renvoie `null`, que le client affiche comme « pas d'options ».
 *
 * On rejette aussi les JSON valides qui ne sont pas des tableaux : `{"a":1}`
 * parse sans erreur, mais serait ensuite parcouru comme une liste — un tableau
 * est le seul type qui ait un sens ici.
 */
export function parseOptions(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    // L'aperçu est tronqué : une colonne corrompue peut faire des kilo-octets,
    // et un log n'a pas à recopier une charge arbitraire.
    log.warn('options question mal formées (JSON invalide)', { apercu: raw.slice(0, 80) });
    return null;
  }
}

/**
 * Assemble la liste des matchs attendue par le client.
 *
 * Le type de retour est construit à partir du type d'entrée (générique `T`) :
 * les colonnes projetées par la requête Drizzle sont conservées telles quelles,
 * et seuls les champs dérivés sont ajoutés. Un type recopié à la main aurait
 * dérivé de la requête au premier changement de colonne, en silence.
 *
 * Les jointures sont faites ici plutôt qu'en SQL parce que le nombre de
 * rencontres reste petit à l'échelle d'un tournoi. Deux requêtes et deux
 * `Map` évitent un `N+1` et, surtout, évitent de joindre la table `users`
 * complète — donc de faire circuler les empreintes de mots de passe pour un
 * simple mapping `id -> nom`.
 */
export function buildMatchList<
  T extends MatchScoreRow & { juryId: number | null },
>(
  rows: readonly T[],
  teamRows: readonly TeamSummary[],
  userRows: readonly UserSummary[]
): Array<
  T & {
    winnerTeamId: number | null;
    teamA: TeamSummary | null;
    teamB: TeamSummary | null;
    juryName: string | null;
  }
> {
  const teamMap = new Map(teamRows.map((t) => [t.id, t]));
  const userMap = new Map(userRows.map((u) => [u.id, u.name]));

  return rows.map((m) => ({
    ...m,
    winnerTeamId: winnerTeamIdOf(m),
    // `?? null` et non `undefined` : une équipe absente doit être explicite
    // dans le JSON, sinon le client distingue mal « pas d'équipe » de « champ
    // oublié ».
    teamA: teamMap.get(m.teamAId) ?? null,
    teamB: teamMap.get(m.teamBId) ?? null,
    juryName: m.juryId ? (userMap.get(m.juryId) ?? null) : null,
  }));
}
