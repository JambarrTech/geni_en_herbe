/**
 * Mise en place commune à tous les tests du front.
 *
 * CE QUE CE FICHIER FAIT, ET POURQUOI CHAQUE LIGNE EST NÉCESSAIRE
 * ---------------------------------------------------------------
 * Un test de composant vit ou meurt de son environnement. Un test qui passe en
 * local et échoue en CI n'est presque jamais un défaut du code testé : c'est un
 * état global résiduel, une API de navigateur absente, ou un nettoyage oublié.
 * Ces quelques lignes ferment ces trois fuites.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import * as matchers from 'vitest-axe/matchers';

import { FakeWebSocket } from './helpers/fakeWebSocket.ts';

// ---------------------------------------------------------------------------
// Assertions d'accessibilité
// ---------------------------------------------------------------------------
// Deux détails, tous deux appris à l'usage :
//
//  1. `vitest-axe/extend-expect` enregistre le matcher sur un `expect` GLOBAL,
//     que nous n'exposons pas (`globals: false`). On enregistre donc nous-mêmes
//     sur l'instance importée.
//
//  2. Il faut passer l'espace de noms ENTIER (`extend(matchers)`), et non
//     `extend({ toHaveNoViolations })`. Vitest 5 exige des valeurs
//     typiquement « Chai plugin » ; passer une fonction seule ne crée pas la
//     propriété, et l'erreur qui remonte — « Invalid Chai property » — pointe
//     vers un problème de version alors que la cause est l'appel.
expect.extend(matchers);

// ---------------------------------------------------------------------------
// Nettoyage du DOM entre les tests
// ---------------------------------------------------------------------------
// `globals: false` désactive le nettoyage automatique de React Testing Library :
// la bibliothèque s'abonne au `afterEach` global, que nous n'exposons pas.
// Sans ce nettoyage, les rendus s'empilent dans `document.body` — le test
// suivant trouve le texte du précédent, et `getByRole` échoue sur un doublon,
// ou pire, réussit en visant le mauvais élément.
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Stockage local : un vrai localStorage, vidé entre les tests
// ---------------------------------------------------------------------------
// jsdom fournit localStorage, mais il est partagé par tous les fichiers de test
// d'un même processus (chaque fichier a son environnement, pas chaque test).
// Sans cette remise à zéro, un jeton laissé par un test de connexion continuerait
// d'être envoyé par les tests suivants : le résultat dépendrait alors de
// l'ordre d'exécution — le pire genre de test, vert en local et rouge en CI.
beforeEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Correspondance média
// ---------------------------------------------------------------------------
// Plusieurs composants lisent `window.matchMedia` pour savoir si
// l'utilisateur demande moins d'animations. jsdom ne l'expose pas sur tous les
// chemins de rendu, et son comportement n'a pas été figé entre versions.
//
// « Aucune préférence » est l'état neutre attendu. On le déclare donc
// explicitement plutôt que de laisser chaque test le découvrir.
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
// Voir `tests/helpers/fakeWebSocket.ts` pour ce que cette doublure fait — et
// surtout ce qu'elle ne fait pas.
beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

// ---------------------------------------------------------------------------
// Contexte audio
// ---------------------------------------------------------------------------
// Le dashboard jury joue un signal sonore à chaque point attribué. jsdom ne
// connaît pas `AudioContext`. Le code applicatif l'encadre déjà dans un
// `try/catch` et teste l'existence du constructeur, donc l'absence n'est pas un
// problème — mais on installe une doublure muette pour que le chemin « son »
// soit réellement exercé par les tests plutôt que systématiquement court-
// circuité.
class SilentAudioContext {
  currentTime = 0;
  sampleRate = 48_000;
  state = 'running' as const;
  destination = {};
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
  close = vi.fn(async () => undefined);
}

Object.defineProperty(window, 'AudioContext', {
  configurable: true,
  writable: true,
  value: SilentAudioContext,
});
