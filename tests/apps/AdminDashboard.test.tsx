import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';

import { api } from '@shared/lib/api.ts';
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

function stubGet() {
  return vi
    .spyOn(api, 'get')
    .mockImplementation((async (path: string) => {
      if (!(path in ROUTES)) throw new Error(`GET inattendu dans ce test : ${path}`);
      return ROUTES[path];
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
