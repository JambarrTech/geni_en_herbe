// Suppose aux objets Question renvoyés au public : on retire la réponse officielle
// et l'explication pédagogique, qui ne doivent JAMAIS fuiter sur l'écran live.
export type PublicQuestion = Record<string, unknown>;

export function publicQuestion<T extends Record<string, unknown> | null | undefined>(
  q: T
): PublicQuestion | null {
  if (!q) return null;
  const result: PublicQuestion = { ...q };
  delete result.answer;
  delete result.explanation;
  return result;
}

/**
 * Version publique d'une question dont le jury a DIFFUSÉ la bonne réponse.
 *
 * L'invariant de `publicQuestion` — « la réponse officielle ne part jamais sur
 * l'écran public » — n'est pas levé ici, il est délibérément franchi à une
 * seule condition : le jury en a fait une action explicite.
 *
 * LA PORTE EST CÔTÉ SERVEUR, ET C'EST LE POINT ESSENTIEL
 * -------------------------------------------------------
 * Ce n'est pas l'interface qui décide de montrer ou non la réponse : c'est la
 * valeur de `matches.broadcast_stage`, écrite uniquement par la route
 * authentifiée `POST /:id/broadcast-step`, et lue ici par `getLiveState`.
 *
 * L'écran public n'a donc aucun pouvoir sur ce choix. Un état forgé côté client,
 * une trame WebSocket interceptée puis rejouée, ou un `localStorage` modifié ne
 * changeraient rien : la seule façon d'obtenir la réponse est qu'un jury ou un
 * administrateur ait effectivement cliqué sur « Étape suivante » à l'étape
 * REVEAL. Une pile où le secret serait filtré côté client donnerait l'inverse —
 * il suffirait d'un `console.log` pour l'obtenir.
 *
 * L'explication, elle, reste retirée. C'est une note pédagogique destinée au
 * jury, pas une réponse à révéler au public ; la distinguer ici plutôt que dans
 * le composant évite d'avoir à s'en souvenir à chaque écran.
 */
export function revealedQuestion<T extends Record<string, unknown> | null | undefined>(
  q: T
): PublicQuestion | null {
  if (!q) return null;
  // `answer` est extrait, puis réinjecté explicitement : on ne veut PAS
  // simplement `{ ...q }`, qui renverrait aussi `explanation`.
  const { answer, ...rest } = q as Record<string, unknown>;
  if (answer === undefined || answer === null) return null;
  delete rest.explanation;
  return { ...rest, answer };
}