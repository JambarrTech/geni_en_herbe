import { describe, it, expect } from 'vitest';

import type { EventItem } from '@shared/types.ts';
import { isEventInProgress, pickCurrentEvent } from '@apps/admin/src/lib/currentEvent.ts';

/**
 * Construit un événement minimal. Les tests ne portent que sur `id` et
 * `status` : les autres champs sont là pour que l'objet soit un `EventItem`
 * valide, et les omettre obligerait à caster à chaque ligne.
 */
function ev(id: number, status: EventItem['status']): EventItem {
  return {
    id,
    name: `Édition ${id}`,
    edition: `Édition ${id}`,
    location: 'Keur Salla Mbatta',
    status,
    resultsPublished: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isEventInProgress', () => {
  it('reconnaît les quatre statuts d’usage', () => {
    for (const status of ['READY', 'RUNNING', 'PAUSED', 'REGISTRATION'] as const) {
      expect(isEventInProgress(status)).toBe(true);
    }
  });

  it('rejette les statuts terminaux ou inactifs', () => {
    for (const status of [
      'DRAFT',
      'FINISHED',
      'RESULTS_PENDING',
      'RESULTS_PUBLISHED',
      'ARCHIVED',
    ] as const) {
      expect(isEventInProgress(status)).toBe(false);
    }
  });

  it('ne se laisse pas tromper par une valeur absente ou d’un autre type', () => {
    // Le statut vient du réseau : il peut manquer si la réponse est partielle.
    // Un `includes` direct sur `undefined` renverrait `false` par chance, mais
    // sur un objet il renverrait aussi `false` — le test fige le comportement.
    expect(isEventInProgress(undefined)).toBe(false);
    expect(isEventInProgress(null)).toBe(false);
    expect(isEventInProgress(42)).toBe(false);
    expect(isEventInProgress({})).toBe(false);
  });
});

describe('pickCurrentEvent — absence d’événement', () => {
  it('renvoie null sur une liste vide', () => {
    expect(pickCurrentEvent([])).toBeNull();
  });

  it('renvoie null sur null, undefined ou une valeur non-tableau', () => {
    // Le serveur peut renvoyer autre chose qu'une liste (erreur sérialisée,
    // réponse tronquée). L'ancien code testait `Array.isArray` : la règle
    // extraite doit conserver cette robustesse.
    expect(pickCurrentEvent(null)).toBeNull();
    expect(pickCurrentEvent(undefined)).toBeNull();
    expect(pickCurrentEvent('pas une liste' as never)).toBeNull();
    expect(pickCurrentEvent({} as never)).toBeNull();
  });
});

describe('pickCurrentEvent — priorité au statut d’usage', () => {
  it('préfère un événement en cours au plus récent', () => {
    // Le cas qui décide de tout : l'édition 2 est archivée, l'édition 1 est en
    // cours. Publier les résultats de l'édition 2 serait une erreur visible en
    // direct.
    const choice = pickCurrentEvent([ev(1, 'RUNNING'), ev(2, 'ARCHIVED')]);
    expect(choice?.id).toBe(1);
  });

  it('choisit le premier événement en cours de la liste', () => {
    // Comportement conservé tel quel : le serveur renvoie un ordre stable, et
    // changer cette règle modifierait l'événement ciblé par les actions
    // d'administration sans qu'aucun écran ne le signale.
    const choice = pickCurrentEvent([ev(7, 'PAUSED'), ev(9, 'RUNNING')]);
    expect(choice?.id).toBe(7);
  });

  it('accepte chaque statut d’usage', () => {
    for (const status of ['READY', 'RUNNING', 'PAUSED', 'REGISTRATION'] as const) {
      expect(pickCurrentEvent([ev(3, status)])?.id).toBe(3);
    }
  });

  it('ignore un événement en cours porté par un id plus petit', () => {
    // La priorité est le statut, pas l'identifiant.
    const choice = pickCurrentEvent([ev(100, 'FINISHED'), ev(2, 'REGISTRATION')]);
    expect(choice?.id).toBe(2);
  });
});

describe('pickCurrentEvent — repli sur le plus récent', () => {
  it('prend le plus grand identifiant quand aucun n’est en cours', () => {
    const choice = pickCurrentEvent([ev(1, 'FINISHED'), ev(3, 'ARCHIVED'), ev(2, 'DRAFT')]);
    expect(choice?.id).toBe(3);
  });

  it('trouve le plus récent même si la liste arrive dans le désordre', () => {
    // Le tri ne doit pas dépendre de l'ordre d'arrivée : c'est précisément
    // pourquoi la règle trie au lieu de prendre le dernier élément.
    const choice = pickCurrentEvent([ev(2, 'FINISHED'), ev(9, 'ARCHIVED'), ev(5, 'DRAFT')]);
    expect(choice?.id).toBe(9);
  });

  it('retourne le seul élément disponible quel que soit son statut', () => {
    expect(pickCurrentEvent([ev(4, 'DRAFT')])?.id).toBe(4);
    expect(pickCurrentEvent([ev(4, 'ARCHIVED')])?.id).toBe(4);
  });
});

describe('pickCurrentEvent — pureté', () => {
  it('ne mute pas la liste reçue', () => {
    // La liste vient d'un state React. `sort` mute : trier en place
    // produirait un changement non détecté par le rendu, et le prochain
    // `fetchData` comparerait à une liste déjà réordonnée.
    const events = [ev(1, 'FINISHED'), ev(3, 'ARCHIVED'), ev(2, 'DRAFT')];
    const avant = events.map((e) => e.id);

    pickCurrentEvent(events);

    expect(events.map((e) => e.id)).toEqual(avant);
  });

  it('renvoie la même référence d’objet, pas une copie', () => {
    // L'événement choisi est ensuite utilisé pour publier des résultats : une
    // copie perdrait silencieusement tout champ non recopié.
    const events = [ev(1, 'RUNNING')];
    expect(pickCurrentEvent(events)).toBe(events[0]);
  });

  it('tolère un élément sans identifiant lors du repli', () => {
    // `?? 0` protège contre un `undefined` reçu du réseau : sans lui, la
    // soustraction vaudrait `NaN` et le tri serait non déterministe.
    const malformed = { ...ev(1, 'DRAFT'), id: undefined } as unknown as EventItem;
    const choice = pickCurrentEvent([malformed, ev(2, 'ARCHIVED')]);
    expect(choice?.id).toBe(2);
  });
});
