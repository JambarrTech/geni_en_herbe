/**
 * Sélection de l'événement « courant » côté administration.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * Cette règle vivait dans un `useMemo` de 8 lignes au milieu de 1 680 lignes de
 * tableau de bord. Elle décide pourtant de choses lourdes : c'est l'événement
 * dont on publie les résultats officiels, celui auquel on rattache les équipes
 * et les matchs créés, et celui dont l'édition et le lieu s'affichent en en-tête.
 *
 * Un `useMemo` n'est pas vérifiable seul. Extraite, la règle s'éprouve
 * directement — et elle mérite de l'être, car sa politique de repli (prendre le
 * plus récent par identifiant) était totalement implicite.
 *
 * LA POLITIQUE, EXPLICITEMENT
 * --------------------------
 *  1. Aucun événement -> `null`.
 *  2. Un événement en cours d'usage (READY, RUNNING, PAUSED, REGISTRATION) est
 *     préféré. C'est celui sur lequel le personnel travaille réellement.
 *  3. Sinon, le plus récent par identifiant. L'identifiant est utilisé comme
 *     approximation de l'ordre de création : la liste peut arriver dans
 *     n'importe quel ordre, et on ne veut pas publier les résultats de
 *     l'édition précédente.
 *
 * Si plusieurs événements sont « en cours », le PREMIER de la liste l'emporte.
 * Ce choix est conservé tel quel : le serveur renvoie les événements dans un
 * ordre stable, et en changer ici modifierait l'événement ciblé par les actions
 * d'administration sans qu'aucun écran ne le signale.
 */
import type { EventItem, EventStatus } from '@shared/types.ts';

/**
 * Statuts pour lesquels l'événement est considéré comme en cours.
 *
 * Volontairement distincts de `RESULTS_PENDING` / `RESULTS_PUBLISHED` : un
 * événement en attente de résultats n'est plus « courant » au sens où on y
 * ajoute des équipes ou des matchs. Le repli sur le plus récent le retrouve
 * quand même — et c'est bien ce qu'on veut pour publier un podium.
 */
const IN_PROGRESS: readonly EventStatus[] = ['READY', 'RUNNING', 'PAUSED', 'REGISTRATION'];

/**
 * Vrai si l'événement est en cours d'usage.
 *
 * Le statut est reçu du serveur : il peut être absent si la réponse est
 * partielle, d'où la vérification de type plutôt qu'un `includes` direct sur
 * une valeur possiblement `undefined`.
 */
export function isEventInProgress(status: unknown): boolean {
  return typeof status === 'string' && IN_PROGRESS.includes(status as EventStatus);
}

/**
 * Choisit l'événement courant, ou `null` s'il n'y en a aucun.
 *
 * Le paramètre est accepté comme `unknown` en entrée dans le corps de la
 * fonction uniquement pour tolérer une réponse réseau mal formée : l'appelant
 * passe un `EventItem[]`, mais la valeur reçue n'est pas garantie par le
 * serveur. La signature publique reste typée.
 */
export function pickCurrentEvent(events: readonly EventItem[] | null | undefined): EventItem | null {
  if (!Array.isArray(events) || events.length === 0) return null;

  const inProgress = events.find((e) => isEventInProgress(e?.status));
  if (inProgress) return inProgress;

  // Copie avant tri : `sort` mute, et muter le tableau du state React
  // produirait un changement invisible pour le rendu.
  return events.slice().sort((a, b) => (b?.id ?? 0) - (a?.id ?? 0))[0] ?? null;
}
