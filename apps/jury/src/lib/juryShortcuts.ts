/**
 * Raccourcis clavier de l'écran jury.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * Attribuer un point est l'action la plus répétée de la plateforme. Les
 * raccourcis vivaient dans un `switch` en plein `useEffect`, mêlés au
 * câblage DOM (`addEventListener`, `preventDefault`, tableau de dépendances).
 * Deux conséquences fâcheuses :
 *
 *  - le tableau de touches n'était vérifiable qu'en montant le composant, un
 *    contexte d'auth, un contexte WebSocket et une API simulée ;
 *  - les MOTIFS d'attribution (« Bonne réponse directe (10 pts) ») étaient
 *    écrits deux fois — une fois dans le `onClick` du bouton, une fois dans le
 *    `switch`. Ces motifs sont enregistrés en base comme motif d'audit et
 *    affichés dans l'historique : les faire diverger signifierait deux
 *    libellés différents pour la même action selon qu'elle a été déclenchée à
 *    la souris ou au clavier. Les constructeurs de motifs sont désormais
 *    exportés d'ici et utilisés par les deux chemins.
 *
 * Ce module ne connaît ni React, ni le DOM, ni l'API : il traduit une touche en
 * intention. Cela le rend éprouvable directement, cas limites compris
 * (touche inconnue, modificateur enfoncé, saisie dans un champ, bornes de
 * navigation).
 */

/** Équipe visée par un raccourci, désignation interne à l'écran. */
export type ShortcutTeam = 'A' | 'B';

/** Type d'attribution, aligné sur le corps attendu par `POST /:id/score`. */
export type ScoreType = 'ANSWER' | 'BONUS' | 'PENALTY';

/**
 * Motifs d'attribution, uniques pour le clic et le clavier.
 *
 * Ils sont écrits en base comme motif d'audit : ce sont des libellés
 * durables, pas de la décoration. D'où leur centralisation — un historique
 * où la même action apparaît sous deux textes différents selon son mode de
 * déclenchement serait un piège pour l'audit.
 *
 * `penalty` ne paramètre pas ses points : une réponse erronée vaut toujours
 * 0, et le libellé « (0 pt) » le dit. Accepter un paramètre laisserait
 * croire qu'une pénalité peut valoir autre chose.
 */
export const SCORE_REASONS = {
  answer: (points: number): string => `Bonne réponse directe (${points} pts)`,
  bonus: (points: number): string => `Points Bonus (+${points} pts)`,
  penalty: (): string => 'Réponse erronée (0 pt)',
} as const;

/** Contexte nécessaire pour traduire une touche en attribution. */
export interface ShortcutContext {
  teamAId: number;
  teamBId: number;
  /** Points de la question courante — utilisés pour `ANSWER` uniquement. */
  questionPoints: number;
  /** Valeur du bonus, issue de la configuration et non codée en dur. */
  bonusPoints: number;
}

/** Attribution prête à envoyer à l'API. */
export interface ResolvedScore {
  teamId: number;
  points: number;
  type: ScoreType;
  reason: string;
}

/**
 * Table des touches de score.
 *
 * `a` / `e` valident la bonne réponse (équipe A / équipe B), `1` / `2`
 * attribuent le bonus, `z` / `s` marquent la réponse erronée. Ces touches sont
 * rappelées à l'écran (voir le tableau des raccourcis et les
 * `aria-keyshortcuts` des boutons) : cette table doit rester leur unique
 * source.
 *
 * Clés en minuscules : `resolveScoreShortcut` normalise la casse, de sorte que
 * `a` et `A` (majuscule produite avec Verr. Maj. activé) désignent la même
 * action. Sans cette normalisation, un jury ayant Verr. Maj. activé ne pouvait
 * plus attribuer un seul point.
 */
export const SCORE_SHORTCUTS = {
  a: { team: 'A', type: 'ANSWER' },
  e: { team: 'B', type: 'ANSWER' },
  '1': { team: 'A', type: 'BONUS' },
  '2': { team: 'B', type: 'BONUS' },
  z: { team: 'A', type: 'PENALTY' },
  s: { team: 'B', type: 'PENALTY' },
} as const satisfies Record<string, { team: ShortcutTeam; type: ScoreType }>;

/**
 * Vrai si la frappe vise un champ de saisie.
 *
 * Indispensable : le motif d'ajustement de score est un champ de texte
 * contenant des lettres (`a`, `s`, `z`…). Sans ce garde-fou, écrire un motif
 * attribuerait des points à chaque lettre — et le jury ne comprendrait pas
 * d'où viennent les points.
 *
 * `isContentEditable` est testé au même titre que les balises : un `div`
 * éditable n'est ni un `INPUT` ni un `TEXTAREA`.
 */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined
): boolean {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

/**
 * Vrai si un modificateur est enfoncé.
 *
 * Les raccourcis sont des lettres nues. Laisser passer `Ctrl+S` (enregistrer
 * la page) ou `Alt+A` (raccourci du navigateur ou du système) attribuerait des
 * points pour une commande qui ne visait pas le score.
 */
export function hasModifier(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): boolean {
  return Boolean(event.ctrlKey || event.metaKey || event.altKey);
}

/**
 * Traduit une touche en attribution, ou `null` si la touche ne score pas.
 *
 * `null` couvre volontairement trois cas distincts — touche inconnue, touche
 * de fonction, touche de navigation — que l'appelant traite de la même façon :
 * ne rien faire. Distinguer ces cas ici n'apporterait rien et multiplierait
 * les branches.
 *
 * Les points de `BONUS` et `PENALTY` viennent du contexte ou de la table, et
 * non du paramètre `questionPoints` : une question modifiée à 20 points ne doit
 * pas transformer un bonus en +20.
 */
export function resolveScoreShortcut(
  key: string,
  ctx: ShortcutContext
): ResolvedScore | null {
  const entry = SCORE_SHORTCUTS[key.toLowerCase() as keyof typeof SCORE_SHORTCUTS];
  if (!entry) return null;

  const teamId = entry.team === 'A' ? ctx.teamAId : ctx.teamBId;

  switch (entry.type) {
    case 'ANSWER':
      return {
        teamId,
        points: ctx.questionPoints,
        type: 'ANSWER',
        reason: SCORE_REASONS.answer(ctx.questionPoints),
      };
    case 'BONUS':
      return {
        teamId,
        points: ctx.bonusPoints,
        type: 'BONUS',
        reason: SCORE_REASONS.bonus(ctx.bonusPoints),
      };
    case 'PENALTY':
      return {
        teamId,
        points: 0,
        type: 'PENALTY',
        reason: SCORE_REASONS.penalty(),
      };
  }

  // Inatteignable tant que `ScoreType` et la table ci-dessus restent alignés.
  // Ce retour satisfait l'exigence du compilateur — un retour terminal est
  // obligatoire dès lors que le type de retour ne comprend pas `undefined` —
  // sans rien changer au comportement.
  return null;
}

/** Sens de navigation demandé par une touche fléchée. */
export type NavDirection = 'next' | 'prev';

/**
 * Traduit une flèche horizontale en navigation, en respectant les bornes.
 *
 * Les bornes sont vérifiées ici, et non chez l'appelant : c'est la seule
 * manière d'être sûr qu'un `ArrowRight` sur la dernière question ne déclenche
 * pas un appel au serveur pour une question qui n'existe pas. Le retour `null`
 * signifie « rien à faire », et l'appelant n'a alors pas à appeler
 * `preventDefault`.
 */
export function resolveNavShortcut(
  key: string,
  ctx: { currentIndex: number; questionCount: number }
): NavDirection | null {
  if (key === 'ArrowRight') {
    return ctx.currentIndex < ctx.questionCount - 1 ? 'next' : null;
  }
  if (key === 'ArrowLeft') {
    return ctx.currentIndex > 0 ? 'prev' : null;
  }
  return null;
}
