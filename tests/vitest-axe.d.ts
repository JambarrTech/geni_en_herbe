/**
 * Types des assertions d'accessibilité.
 *
 * `vitest-axe` fournit une extension qui cible le namespace d'assertions de
 * Jest. Vitest a le sien (`Assertion`, dans le module `vitest`), et son
 * enregistrement ne passe que par un `expect.extend` à l'exécution — rien ne
 * déclare au compilateur que `toHaveNoViolations` existe.
 *
 * Ce fichier comble l'écart ; il est ramassé par `tests/tsconfig.json`.
 *
 * Sans lui, `expect(results).toHaveNoViolations()` échouerait au typecheck,
 * et la réaction naturelle serait d'écrire `expect(results.violations).toHaveLength(0)`.
 * Cette écriture est plus faible : elle compte les violations sans vérifier
 * qu'un audit a réellement tourné. Un jour où `axe` n'aurait rien analysé (un
 * conteneur vide, un sélecteur erroné), le test resterait vert en affichant
 * « aucune violation » alors que rien n'a été mesuré.
 */
import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  // `any` est ici obligatoire et non un oubli : TypeScript exige qu'un
  // paramètre de type soit utilisé au moins une fois, et on ne peut pas écrire
  // `interface Assertion<T = never> extends AxeMatchers` — cela fixerait le
  // type de la valeur assertée à `never` et casserait les assertions courantes.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends AxeMatchers {}

  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

export {};
