import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';

import { api } from '@shared/lib/api.ts';
import type { MatchItem } from '@shared/types.ts';
import { AdminDashboard } from '@apps/admin/src/pages/AdminDashboard.tsx';

// ---------------------------------------------------------------------------
// Contextes simulés
// ---------------------------------------------------------------------------
// Comme pour l'écran jury : monter les vrais contextes ouvrirait une connexion
// WebSocket et un appel `GET /api/auth/me`, sans rapport avec ce qu'on vérifie
// (le rendu des huit onglets et l'absence de violation d'accessibilité).
vi.mock('@shared/context/LiveContext.tsx', () => ({
  useLive: () => ({ liveState: null, refreshLiveState: vi.fn() }),
}));

vi.mock('@shared/context/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Comité', role: 'ADMIN' }, token: 'jeton-de-test' }),
}));

// ---------------------------------------------------------------------------
// Données de test
// ---------------------------------------------------------------------------

/** Un événement terminé : le seul statut qui n'est pas « en cours ». */
const EVENT = {
  id: 1,
  name: "Journée d'Excellence AEERKS",
  edition: 'Édition 2026',
  location: 'Keur Salla Mbatta',
  status: 'FINISHED' as const,
  resultsPublished: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Les huit chemins chargés au montage.
 *
 * On ne remplit que ce qui est affiché : les autres listes restent vides, ce
 * qui est aussi le cas réel d'une base fraîche et évite d'inventer des données
 * qui masqueraient un plantage sur liste vide.
 */
const ROUTES: Record<string, unknown> = {
  '/api/events': [EVENT],
  '/api/participants': [],
  '/api/teams': [],
  '/api/categories': [],
  '/api/questions': [],
  '/api/matches': [],
  '/api/rankings': [],
  '/api/audit-logs': [],
  // UsersManager est monté par l'onglet `users` et charge ses propres comptes.
  '/api/users': [],
};

/**
 * Branche les huit chemins sur `routes`.
 *
 * Le paramètre permet à un test de n'injecter que la liste qui l'intéresse :
 * les tests de suppression ont besoin de matchs, les autres n'en veulent pas.
 */
function stubGet(routes: Record<string, unknown> = ROUTES) {
  return vi
    .spyOn(api, 'get')
    .mockImplementation((async (path: string) => {
      if (!(path in routes)) throw new Error(`GET inattendu dans ce test : ${path}`);
      return routes[path];
    }) as unknown as typeof api.get);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Monte l'écran et attend la fin de l'état de chargement.
 *
 * Le signal d'attente est le bouton de publication, et non le nom de
 * l'événement : ce nom apparaît légitimement à deux endroits (bandeau de
 * l'aperçu et en-tête de page), donc s'y fier rendrait le test ambigu le jour
 * où un troisième emplacement l'affiche.
 */
async function mountAdmin() {
  stubGet();
  const view = render(<AdminDashboard />);

  await waitFor(() => expect(document.getElementById('btn-publish-overview')).not.toBeNull());
  return view;
}

describe('AdminDashboard — navigation', () => {
  it('expose les huit sections réellement implémentées', async () => {
    await mountAdmin();

    // L'union `AdminTab` promet huit onglets. Ce test échoue si l'un d'eux
    // disparaît du barème sans que le type suive — ou l'inverse.
    const attendus = [
      'overview',
      'results',
      'matches',
      'teams',
      'questions',
      'participants',
      'audit',
      'users',
    ];
    for (const id of attendus) {
      expect(document.getElementById(`tab-${id}`)).not.toBeNull();
    }
  });

  it("marque la section active avec aria-current, pas seulement par la couleur", async () => {
    await mountAdmin();

    // `aria-current="page"` est la seule information non visuelle qui dise
    // « vous êtes ici » : la couleur du bouton ne parle pas à un lecteur
    // d'écran.
    expect(document.getElementById('tab-overview')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(document.getElementById('tab-audit')!);

    await waitFor(() => {
      expect(document.getElementById('tab-audit')).toHaveAttribute('aria-current', 'page');
    });
    expect(document.getElementById('tab-overview')).not.toHaveAttribute('aria-current');
  });

  it('change de contenu sans erreur pour chaque section', async () => {
    // Un onglet peut être déclaré et néanmoins planter au rendu (données
    // absentes, accès à un `[0]`). On visite donc toutes les sections.
    await mountAdmin();

    for (const id of ['results', 'matches', 'teams', 'questions', 'participants', 'audit', 'users']) {
      fireEvent.click(document.getElementById(`tab-${id}`)!);
      await waitFor(() => expect(document.getElementById(`tab-${id}`)).toHaveAttribute('aria-current', 'page'));
    }

    // Retour à l'aperçu : l'écran doit rester intact après le tour complet.
    fireEvent.click(document.getElementById('tab-overview')!);
    await waitFor(() =>
      expect(document.getElementById('btn-publish-overview')).not.toBeNull()
    );
    expect(document.getElementById('tab-overview')).toHaveAttribute('aria-current', 'page');
  });
});

describe('AdminDashboard — publication des résultats', () => {
  it('ne propose que la publication tant que rien n’est publié', async () => {
    await mountAdmin();

    // L'événement est FINISHED et non publié : le bouton « Masquer du public »
    // n'a pas de sens et ne doit pas être rendu.
    expect(document.getElementById('btn-publish-overview')).not.toBeNull();
    expect(document.getElementById('btn-unpublish-overview')).toBeNull();
  });
});

/**
 * Suppression d'un match.
 *
 * POURQUOI CES TESTS EXISTENT
 * ----------------------------
 * La route `DELETE /api/matches/:id` existait déjà, prudente et bien gardée
 * (400 sur un match en cours, 409 si un historique de score s'y oppose). Mais
 * rien ne la rendait accessible depuis l'interface : le comité pouvait
 * programmer un match par erreur et n'avait aucun moyen de le corriger.
 *
 * Ce qui est vérifié ici n'est donc pas « un bouton existe », mais qu'il ne
 * peut pas faire n'importe quoi, et qu'il prévient. Le serveur refuse deux
 * cas, et l'interface doit les ANNONCER plutôt que de les faire découvrir à
 * l'essai : un bouton qui échoue toujours se lit comme un bug.
 */
describe('AdminDashboard — suppression d’un match', () => {
  /** Un match minimal, dans l'état demandé. */
  const match = (id: number, status: MatchItem['status'], numero = id) => ({
    id,
    eventId: 1,
    phase: 'Phase qualificative',
    matchNumber: numero,
    teamAId: 10 + id,
    teamBId: 20 + id,
    teamA: { id: 10 + id, name: `Alpha ${id}` },
    teamB: { id: 20 + id, name: `Bravo ${id}` },
    status,
    currentQuestionIndex: 0,
    scoreA: 0,
    scoreB: 0,
    timerSecondsLeft: 0,
    timerIsRunning: false,
    timerDuration: 0,
  });

  async function mountAvecMatches(matches: unknown[]) {
    stubGet({ ...ROUTES, '/api/matches': matches });
    const view = render(<AdminDashboard />);
    await waitFor(() => expect(document.getElementById('btn-publish-overview')).not.toBeNull());

    fireEvent.click(document.getElementById('tab-matches')!);
    await waitFor(() => expect(document.getElementById('btn-add-match')).not.toBeNull());
    return view;
  }

  /** Le bouton de confirmation du dialogue, pas celui qui l'ouvre. */
  function boutonConfirmer(): HTMLElement {
    const boutons = Array.from(document.querySelectorAll<HTMLElement>('dialog button'));
    const danger = boutons.find((b) => b.textContent?.includes('Supprimer définitivement'));
    if (!danger) throw new Error('le dialogue de suppression ne propose pas de confirmation');
    return danger;
  }

  it('propose la suppression sur un match programmé', async () => {
    await mountAvecMatches([match(1, 'SCHEDULED')]);

    const bouton = document.getElementById('btn-delete-match-1') as HTMLButtonElement;
    expect(bouton).not.toBeNull();
    expect(bouton.disabled).toBe(false);
  });

  it('interdit l’action sur un match en cours ou en pause, et l’explique', async () => {
    await mountAvecMatches([match(1, 'LIVE', 4), match(2, 'PAUSED', 5)]);

    // Le serveur répond 400 dans ces deux cas. Désactiver le bouton évite au
    // comité d'ouvrir une confirmation pour une opération vouée à l'échec —
    // mais un bouton gris sans raison se lit comme un bug, donc le motif est
    // dans le `title` ET dans le nom accessible.
    for (const id of [1, 2]) {
      const bouton = document.getElementById(`btn-delete-match-${id}`) as HTMLButtonElement;
      expect(bouton.disabled).toBe(true);
      expect(bouton.getAttribute('title')).toMatch(/terminez-le/);
      expect(bouton.getAttribute('aria-label')).toContain('Supprimer le match n°');
    }
  });

  it('nomme le match visé, pour que la décision soit éclairée', async () => {
    await mountAvecMatches([match(7, 'SCHEDULED', 3)]);

    fireEvent.click(document.getElementById('btn-delete-match-7')!);

    // Sans le numéro et les équipes, « Supprimer ? » ne permet pas de vérifier
    // qu'on a choisi le bon match — c'est toute la raison d'être de la
    // confirmation.
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());
    const dialogue = document.querySelector('dialog[open]')!;
    expect(dialogue.textContent).toContain('Supprimer le match n° 3');
    expect(dialogue.textContent).toContain('Alpha 7');
    expect(dialogue.textContent).toContain('Bravo 7');
  });

  it('supprime le match après confirmation', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);
    await mountAvecMatches([match(7, 'SCHEDULED', 3)]);

    fireEvent.click(document.getElementById('btn-delete-match-7')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());
    fireEvent.click(boutonConfirmer());

    await waitFor(() => expect(supprimer).toHaveBeenCalledWith('/api/matches/7'));
  });

  it('n’envoie rien si la confirmation est annulée', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);
    await mountAvecMatches([match(7, 'SCHEDULED', 3)]);

    fireEvent.click(document.getElementById('btn-delete-match-7')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

    const annuler = Array.from(document.querySelectorAll<HTMLElement>('dialog button')).find((b) =>
      b.textContent?.includes('Annuler')
    )!;
    fireEvent.click(annuler);

    expect(supprimer).not.toHaveBeenCalled();
  });

  it('remonte le refus du serveur au lieu d’un échec muet', async () => {
    // 409 : le match a un historique de score. Cette information n'existe PAS
    // côté client — seule la réponse du serveur la porte. Si elle n'atteint pas
    // l'écran, l'administrateur voit un bouton faire semblant, puis rien.
    vi.spyOn(api, 'delete').mockRejectedValue(
      new Error('Impossible de supprimer : ce match possède un historique de score.')
    );
    await mountAvecMatches([match(7, 'FINISHED', 3)]);

    fireEvent.click(document.getElementById('btn-delete-match-7')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());
    fireEvent.click(boutonConfirmer());

    await waitFor(() => {
      const toast = document.getElementById('admin-toast-alert');
      expect(toast?.textContent).toContain('historique de score');
    });
  });
});

describe('AdminDashboard — accessibilité', () => {
  it("n'a aucune violation axe sur l'aperçu", async () => {
    const { container } = await mountAdmin();

    // Le premier écran de l'administration est le plus large de la plateforme :
    // huit sections, des cartes de statistiques, des modales. C'est aussi
    // l'écran où une erreur d'accessibilité coûte le plus cher, parce que le
    // comité y passe ses journées.
    expect(await axe(container)).toHaveNoViolations();
  });

  it("n'a aucune violation axe sur le journal d'audit", async () => {
    // Deuxième écran le plus dense (tableaux de règles, historique) : il est
    // visité en boucle pendant la compétition.
    const { container } = await mountAdmin();
    fireEvent.click(document.getElementById('tab-audit')!);
    await waitFor(() =>
      expect(document.getElementById('tab-audit')).toHaveAttribute('aria-current', 'page')
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
