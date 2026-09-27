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