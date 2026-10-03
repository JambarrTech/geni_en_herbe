/**
 * Scénario de diffusion d'un match sur l'écran public.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * L'écran public ne montre pas « l'état » d'un match : il déroule une
 * SCÉNARISATION que le jury avance d'un cran à la fois, devant le public.
 *
 *   Participants -> Question -> Équipe A -> Équipe B -> Révélation
 *                                                     |
 *                          (on repasse à « Question » pour la suivante)
 *                                                     v
 *                                            Résultats finaux
 *
 * Cette sequencing est la seule chose qui décide, à un instant donné, de ce que
 * voit le public — et donc de ce qui est envoyé dans le payload : la réponse
 * officielle ne sort que si le curseur est sur l'étape `REVEAL`, et les noms des
 * participants que si le curseur est sur l'étape `ROSTER`.
 *
 * Conséquence directe : cette logique ne peut PAS vivre dans le composant
 * React. Elle protège une donnée (la bonne réponse), elle doit survivre à un
 * rechargement de la page, et elle doit produire le même résultat quel que soit
 * l'écran qui la consomme. Elle est donc ici, pure et testable, sans base de
 * données ni React — comme `lib/matchList.ts` et `lib/juryShortcuts.ts`.
 *
 * La position est un couple (étape, index de question) et NON un simple compteur
 * d'étapes. Un compteur se dérègle dès qu'une question est sautée ou reprise ;
 * un couple se recalcule toujours depuis la série réelle, et `normalizeCursor`
 * ramène une valeur abstraite dans le domaine valide.
 */

/** Étapes possibles de la diffusion, dans l'ordre du déroulé. */
export const BROADCAST_STAGE = {
  /** Effectif des deux équipes à l'écran. */
  ROSTER: 'ROSTER',
  /** Énoncé de la question courante. */
  QUESTION: 'QUESTION',
  /** Équipe A donne sa réponse. */
  ANSWER_A: 'ANSWER_A',
  /** Équipe B donne sa réponse. */
  ANSWER_B: 'ANSWER_B',
  /** Le jury diffuse la bonne réponse. */
  REVEAL: 'REVEAL',
  /** Résultat final de la rencontre. */
  FINAL: 'FINAL',
} as const;

export type BroadcastStage = (typeof BROADCAST_STAGE)[keyof typeof BROADCAST_STAGE];

/**
 * Les quatre étapes que chaque question traverse, dans l'ordre.
 *
 * Cette liste EST la boucle du scénario : ajouter une étape ici (une phase
 * d'explication, un contrôle anti-triche) l'insère dans toutes les questions
 * sans toucher à la logique d'avancement.
 */
const QUESTION_STAGES: readonly BroadcastStage[] = [
  BROADCAST_STAGE.QUESTION,
  BROADCAST_STAGE.ANSWER_A,
  BROADCAST_STAGE.ANSWER_B,
  BROADCAST_STAGE.REVEAL,
];

/** Position dans le scénario : une étape, et la question sur laquelle elle se pose. */
export interface BroadcastCursor {
  stage: BroadcastStage;
  /** Index 0-based dans la série de questions du match. */
  questionIndex: number;
}

/** Scénario complet, mis à plat. */
export interface BroadcastPosition {
  cursor: BroadcastCursor;
  /** Rang de l'étape courante dans le scénario, 1-based. */
  stepNumber: number;
  /** Nombre total d'étapes du scénario pour cette série. */
  totalSteps: number;
  /** Existe-t-il une étape après celle-ci ? */
  canAdvance: boolean;
  /** Existe-t-il une étape avant celle-ci ? */
  canRewind: boolean;
  /** Étape suivante, ou `null` si la diffusion est arrivée au bout. */
  next: BroadcastCursor | null;
  /** Étape précédente, ou `null` si la diffusion est déjà au début. */
  previous: BroadcastCursor | null;
  /** L'écran doit-il afficher la réponse officielle ? */
  revealsAnswer: boolean;
  /** L'écran doit-il afficher l'effectif des équipes ? */
  showsRoster: boolean;
}

/**
 * Vrai si `value` est une étape connue.
 *
 * La colonne `matches.broadcast_stage` est du texte libre en base : une valeur
 * saisie à la main, une ligne Importée d'une autre installation, ou le residue
 * d'un déploiement antérieur produiraient une étape inconnue. Plutôt que de
 * la propager jusqu'à l'écran public — où elle ne correspondrait à aucun rendu —
 * elle est ramenée à une valeur du domaine ici.
 */
export function isBroadcastStage(value: unknown): value is BroadcastStage {
  return typeof value === 'string' && (Object.values(BROADCAST_STAGE) as string[]).includes(value);
}

/**
 * Scénario complet, mis à plat, pour une série de `questionCount` questions.
 *
 * On construit la liste plutôt que de calculer « étape ± 1 » arithmétiquement :
 * la forme de la séquence dépend du nombre de questions (une série vide n'a ni
 * question ni réponse à révéler), et une liste rend cette dépendance visible
 * au lieu de la dissimuler dans une formule.
 */
export function broadcastSequence(questionCount: number): BroadcastCursor[] {
  const count = Math.max(0, Math.floor(questionCount) || 0);
  const sequence: BroadcastCursor[] = [{ stage: BROADCAST_STAGE.ROSTER, questionIndex: 0 }];
  for (let i = 0; i < count; i += 1) {
    for (const stage of QUESTION_STAGES) {
      sequence.push({ stage, questionIndex: i });
    }
  }
  sequence.push({ stage: BROADCAST_STAGE.FINAL, questionIndex: Math.max(0, count - 1) });
  return sequence;
}

/**
 * Ramène un curseur, quelle que soit sa valeur, dans le scénario réellement jouable.
 *
 * Trois corrections, chacune tirée d'un incident possible :
 *  - étape inconnue -> `ROSTER` (cf. `isBroadcastStage`) ;
 *  - index hors bornes -> ramené dans la série, parce qu'une série raccourcie
 *    (question supprimée en cours de concours) laisse derrière elle un index
 *    qui ne désigne plus rien ;
 *  - série vide -> seules `ROSTER` et `FINAL` existent. Sans ce cas, un curseur
 *    sur `QUESTION` avec zéro question produirait un écran coincé sur une
 *    question inexistante.
 */
export function normalizeCursor(
  stage: unknown,
  questionIndex: unknown,
  questionCount: number
): BroadcastCursor {
  const count = Math.max(0, Math.floor(questionCount) || 0);

  if (count === 0) {
    return stage === BROADCAST_STAGE.FINAL
      ? { stage: BROADCAST_STAGE.FINAL, questionIndex: 0 }
      : { stage: BROADCAST_STAGE.ROSTER, questionIndex: 0 };
  }

  const rawIndex = Number.isFinite(questionIndex) ? Math.floor(questionIndex as number) : 0;
  const clamped = Math.min(Math.max(rawIndex, 0), count - 1);
  return { stage: isBroadcastStage(stage) ? stage : BROADCAST_STAGE.ROSTER, questionIndex: clamped };
}

function sameCursor(a: BroadcastCursor, b: BroadcastCursor): boolean {
  return a.stage === b.stage && a.questionIndex === b.questionIndex;
}

/** Index d'un curseur dans le scénario, ou -1 s'il n'y figure pas. */
function indexOfCursor(cursor: BroadcastCursor, sequence: BroadcastCursor[]): number {
  return sequence.findIndex((c) => sameCursor(c, cursor));
}

/** Étape suivante, ou `null` si la diffusion est déjà au bout du scénario. */
export function nextCursor(cursor: BroadcastCursor, questionCount: number): BroadcastCursor | null {
  const sequence = broadcastSequence(questionCount);
  const index = indexOfCursor(cursor, sequence);
  // Curseur absent du scénario : il n'existe pas d'étape « après ». Renvoyer
  // `null` est plus sûr que d'inventer une étape — un `broadcast_stage` valide
  // hors séquence ne doit pas faire défiler l'écran vers une étape arbitraire.
  if (index < 0) return null;
  return sequence[index + 1] ?? null;
}

/** Étape précédente, ou `null` si la diffusion est déjà au début du scénario. */
export function previousCursor(cursor: BroadcastCursor, questionCount: number): BroadcastCursor | null {
  const sequence = broadcastSequence(questionCount);
  const index = indexOfCursor(cursor, sequence);
  if (index <= 0) return null;
  return sequence[index - 1] ?? null;
}

/** Première étape du scénario (l'effectif des équipes). */
export function firstCursor(): BroadcastCursor {
  return { stage: BROADCAST_STAGE.ROSTER, questionIndex: 0 };
}

/** Position complète dans le scénario, pour piloter l'écran et le tableau de jury. */
export function broadcastPosition(cursor: BroadcastCursor, questionCount: number): BroadcastPosition {
  const sequence = broadcastSequence(questionCount);
  const index = indexOfCursor(cursor, sequence);
  // -1 : on retombe sur la première étape plutôt que de divisions par zéro en aval.
  const safeIndex = index < 0 ? 0 : index;
  const resolved = sequence[safeIndex];
  return {
    cursor: resolved,
    stepNumber: safeIndex + 1,
    totalSteps: sequence.length,
    canAdvance: index >= 0 && index < sequence.length - 1,
    canRewind: index > 0,
    next: nextCursor(cursor, questionCount),
    previous: previousCursor(cursor, questionCount),
    revealsAnswer: resolved.stage === BROADCAST_STAGE.REVEAL,
    showsRoster: resolved.stage === BROADCAST_STAGE.ROSTER,
  };
}

/**
 * L'étape en cours porte-t-elle sur une question, plutôt que sur l'effectif ou
 * le résultat final ?
 *
 * Les deux étapes qui enveloppent la série — `ROSTER` et `FINAL` — n'ont pas de
 * question. Y afficher un compteur « question 3 / 10 » ferait dire à l'écran du
 * jury que le public regarde une question, alors qu'il regarde l'effectif des
 * équipes. C'est l'appelant qui décide d'afficher ou non ce compteur ; il doit
 * connaître ces deux étapes, donc la liste reste ici, avec la séquence.
 */
export function stageIsPerQuestion(stage: BroadcastStage): boolean {
  return (QUESTION_STAGES as readonly string[]).includes(stage);
}

/** Étapes qui n'appartiennent à aucune question : aucune de la série. */
export function stageIsPerMatch(stage: BroadcastStage): boolean {
  return stage === BROADCAST_STAGE.ROSTER || stage === BROADCAST_STAGE.FINAL;
}