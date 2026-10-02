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

  /**
   * Le bouton de confirmation du dialogue OUVERT.
   *
   * Le libellé n'est qu'un filtre : c'est la restriction à `dialog[open]` qui
   * fait la différence. Plusieurs `ConfirmDialog` sont montés en permanence
   * (publication, annulation, suppression) et leurs boutons existent dans le
   * DOM même quand leur dialogue est fermé — chercher « Supprimer
   * définitivement » dans toute la page revenait donc à cliquer sur une
   * suppression en croyant ouvrir autre chose, sans déclencher quoi que ce soit
   * puisque la cible du dialogue fermé est nulle. Un test vert à l'écran et
   * muet sur le réseau.
   */
  function boutonConfirmer(libelle = 'Supprimer définitivement'): HTMLElement {
    const dialogue = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (!dialogue) throw new Error('aucun dialogue ouvert');
    const bouton = Array.from(dialogue.querySelectorAll<HTMLElement>('button')).find((b) =>
      b.textContent?.includes(libelle)
    );
    if (!bouton) throw new Error(`le dialogue ouvert ne propose pas « ${libelle} »`);
    return bouton;
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

  it('propose d\'annuler un résultat, et de le rétablir sur un match annulé', async () => {
    await mountAvecMatches([match(1, 'FINISHED', 2), match(2, 'CANCELLED', 3)]);

    // Deux boutons distincts, jamais présents ensemble : c'est ce qui permet de
    // voir d'un coup d'œil, dans une grille de six matchs, si un résultat pèse
    // encore au classement. Un bouton unique dont l'effet dépendrait de l'état
    // obligerait à lire l'état avant de cliquer.
    expect(document.getElementById('btn-cancel-match-1')).not.toBeNull();
    expect(document.getElementById('btn-restore-match-1')).toBeNull();

    expect(document.getElementById('btn-restore-match-2')).not.toBeNull();
    expect(document.getElementById('btn-cancel-match-2')).toBeNull();
  });

  it('n\'propose ni l\'un ni l\'autre sur un match programmé ou en cours', async () => {
    await mountAvecMatches([match(1, 'SCHEDULED'), match(2, 'LIVE'), match(3, 'PAUSED')]);

    // Un match programmé se SUPPRIME (rien à retirer du classement) ; un match en
    // cours doit être terminé d'abord. Ni l'un ni l'autre n'a de résultat à
    // annuler.
    for (const id of [1, 2, 3]) {
      expect(document.getElementById(`btn-cancel-match-${id}`)).toBeNull();
      expect(document.getElementById(`btn-restore-match-${id}`)).toBeNull();
    }
  });

  it('annule un résultat en annonçant ce qui n\'est PAS effacé', async () => {
    const envoyer = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await mountAvecMatches([match(7, 'FINISHED', 3)]);

    fireEvent.click(document.getElementById('btn-cancel-match-7')!);
    await waitFor(() => expect(boutonConfirmer('Annuler le résultat')).toBeTruthy());

    // Le point entier de l'annulation est là : elle retire le match du
    // classement SANS rien détruire. Un dialogue qui ne le dirait pas ferait
    // croire à une suppression — donc à une perte définitive — et le comité
    // n'oserait pas s'en servir.
    const dialogue = document.querySelector('dialog[open]')!;
    expect(dialogue.textContent).toContain('Annuler le résultat du match n° 3');
    expect(dialogue.textContent).toContain("Rien n'est effacé");
    expect(dialogue.textContent).toMatch(/journal d'audit/);
    // Le score affiché l'est aussi : on conserve, on ne remet pas à zéro.
    expect(dialogue.textContent).toContain('Score conservé');

    fireEvent.click(boutonConfirmer('Annuler le résultat'));
    await waitFor(() => expect(envoyer).toHaveBeenCalledWith('/api/matches/7/cancel'));
  });

  it('rétablit un résultat annulé', async () => {
    const envoyer = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await mountAvecMatches([match(7, 'CANCELLED', 3)]);

    fireEvent.click(document.getElementById('btn-restore-match-7')!);
    await waitFor(() => expect(boutonConfirmer('Rétablir')).toBeTruthy());
    fireEvent.click(boutonConfirmer('Rétablir'));

    await waitFor(() => expect(envoyer).toHaveBeenCalledWith('/api/matches/7/restore'));
  });

  it('affiche « Annulé » en toutes lettres sur un match annulé', async () => {
    await mountAvecMatches([match(7, 'CANCELLED', 3)]);

    // Ni « CANCELLED », ni l'ambre d'un match programmé : l'identifiant brut et
    // cette couleur auraient rendu un résultat retiré visuellement identique à
    // un match à venir — dans une grille où cette différence décide de ce qui
    // part en publication.
    const carte = document.getElementById('btn-restore-match-7')!.closest('div.bg-white')!;
    expect(carte.textContent).toContain('Annulé');
    expect(carte.textContent).not.toContain('CANCELLED');
    expect(carte.textContent).not.toContain('FINISHED');

    // Le texte ne suffit pas : c'est le trait qui la distingue au premier coup
    // d'œil, quand on compare deux cartes côte à côte sans lire les libellés.
    const badge = Array.from(carte.querySelectorAll('span')).find((s) => s.textContent === 'Annulé')!;
    expect(badge.className).toContain('line-through');
  });

  it('remonte le refus du serveur sur une annulation impossible', async () => {
    // Le serveur exige `FINISHED`. Un état qui change entre l'affichage et le clic
    // — le jury relance le match pendant ce temps — ne peut pas être anticipé ici.
    vi.spyOn(api, 'post').mockRejectedValue(
      new Error('Seul un match terminé peut être annulé.')
    );
    await mountAvecMatches([match(7, 'FINISHED', 3)]);

    fireEvent.click(document.getElementById('btn-cancel-match-7')!);
    await waitFor(() => expect(boutonConfirmer('Annuler le résultat')).toBeTruthy());
    fireEvent.click(boutonConfirmer('Annuler le résultat'));

    await waitFor(() => {
      const toast = document.getElementById('admin-toast-alert');
      expect(toast?.textContent).toContain('Seul un match terminé');
    });
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

/**
 * Suppression des autres ressources : équipes, questions, membres.
 *
 * POURQUOI UN SEUL BLOC POUR LES TROIS
 * ------------------------------------
 * Les trois partagent désormais le même hook (`useSuppression`) et le même
 * dialogue. Ce qui les distingue n'est pas la mécanique — c'est ce que le
 * serveur refuse, et ce que l'interface doit annoncer. Ce sont ces différences
 * qui sont testées, pas trois fois la même clic.
 */
describe('AdminDashboard — suppression des équipes, questions et membres', () => {
  const equipe = (id: number) => ({
    id,
    eventId: 1,
    name: `Alpha ${id}`,
    code: `A${id}`,
    members: [{ id: 100 + id, role: 'CAPTAIN' }],
  });

  const question = (id: number) => ({
    id,
    eventId: 1,
    categoryId: 1,
    categoryName: 'Chimie',
    text: `Quel est le nombre d'Avogadro, question ${id} ?`,
    answer: '6,022 × 10²³',
    difficulty: 'DIFFICILE',
    points: 20,
    timeLimitSeconds: 60,
  });

  const membre = (id: number) => ({
    id,
    firstName: `Prénom${id}`,
    lastName: `Nom${id}`,
    gender: 'M' as const,
    schoolId: 1,
    phone: `77 000 00 ${id}`,
    registrationNumber: `AE-${id}`,
  });

  /**
 * Monte l'écran, puis ouvre l'onglet attendu.
   *
   * Renvoie la vue ET démonte la précédente : sans cela, `document` cumulerait
   * les écrans des tests successifs et les `id` identiques pointeraient vers le
   * premier monté — un faux positif silencieux sur tout ce qui suit.
   */
  async function mountOnglet(onglet: string, donnees: Record<string, unknown>, ancre: string) {
    mounted?.unmount();
    stubGet({ ...ROUTES, ...donnees });
    mounted = render(<AdminDashboard />);
    await waitFor(() => expect(document.getElementById('btn-publish-overview')).not.toBeNull());

    fireEvent.click(document.getElementById(`tab-${onglet}`)!);
    await waitFor(() => expect(document.getElementById(ancre)).not.toBeNull());
    return mounted;
  }

  let mounted: ReturnType<typeof render> | null = null;
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** Le bouton de confirmation du dialogue OUVERT, pas celui d'un dialogue fermé. */
  function boutonConfirmer(libelle = 'Supprimer définitivement'): HTMLElement {
    const dialogue = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (!dialogue) throw new Error('aucun dialogue ouvert');
    const bouton = Array.from(dialogue.querySelectorAll<HTMLElement>('button')).find((b) =>
      b.textContent?.includes(libelle)
    );
    if (!bouton) throw new Error(`le dialogue ouvert ne propose pas « ${libelle} »`);
    return bouton;
  }

  it('supprime une équipe après confirmation, en nommant la cible', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);
    await mountOnglet('teams', { '/api/teams': [equipe(4)] }, 'btn-add-team');

    fireEvent.click(document.getElementById('btn-delete-team-4')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

    // Le nom de l'équipe est dans le dialogue ET dans le nom accessible du
    // bouton : dans une grille de huit équipes, « bouton » sans cible laisse
    // deviner laquelle on va effacer.
    const dialogue = document.querySelector('dialog[open]')!;
    expect(dialogue.textContent).toContain('Supprimer l\'équipe Alpha 4');
    expect(dialogue.textContent).toContain('A4');
    expect(document.getElementById('btn-delete-team-4')!.getAttribute('aria-label')).toBe(
      "Supprimer l'équipe Alpha 4"
    );

    fireEvent.click(boutonConfirmer());
    await waitFor(() => expect(supprimer).toHaveBeenCalledWith('/api/teams/4'));
  });

  it('refuse une équipe engagée dans un match, et remonte la raison du serveur', async () => {
    // `matches.team_a_id` / `team_b_id` pointent sur `teams` en RESTRICT : le
    // serveur répond 400 avec `FK_DELETE_MESSAGES.team`. Cette information n'est
    // PAS calculable dans l'écran — une équipe engagée dans un match se présente
    // exactement comme une équipe libre. Le message doit donc atteindre l'écran.
    vi.spyOn(api, 'delete').mockRejectedValue(
      new Error('Impossible de supprimer : cette équipe est engagée dans un match.')
    );
    await mountOnglet('teams', { '/api/teams': [equipe(4)] }, 'btn-add-team');

    // Le bouton reste ACTIF : on ne peut pas savoir ici que le match existe.
    expect((document.getElementById('btn-delete-team-4') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(document.getElementById('btn-delete-team-4')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());
    fireEvent.click(boutonConfirmer());

    await waitFor(() => {
      const toast = document.getElementById('admin-toast-alert');
      expect(toast?.textContent).toContain('engagée dans un match');
    });
  });

  it('supprime une question en montrant son énoncé et sa réponse', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);
    await mountOnglet('questions', { '/api/questions': [question(9)] }, 'btn-add-question');

    fireEvent.click(document.getElementById('btn-delete-question-9')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

    // L'énoncé seul ne suffit pas : deux questions de Chimie peuvent commencer à se
    // ressembler. La réponse officielle est ce qui confirme qu'on a choisi la
    // bonne.
    const dialogue = document.querySelector('dialog[open]')!;
    expect(dialogue.textContent).toContain('Supprimer cette question ?');
    expect(dialogue.textContent).toContain('nombre d\'Avogadro, question 9');
    expect(dialogue.textContent).toContain('6,022');

    fireEvent.click(boutonConfirmer());
    await waitFor(() => expect(supprimer).toHaveBeenCalledWith('/api/questions/9'));
  });

  it('affiche l’énoncé dans le nom accessible du bouton de question', async () => {
    await mountOnglet('questions', { '/api/questions': [question(9)] }, 'btn-add-question');

    const etiquette = document.getElementById('btn-delete-question-9')!.getAttribute('aria-label');
    expect(etiquette).toContain("Supprimer la question Quel est le nombre");
    // Tronquée : une étiquette de plusieurs lignes dans une cellule de tableau
    // est illisible au lecteur d'écran.
    expect(etiquette!.length).toBeLessThanOrEqual('Supprimer la question '.length + 60);
  });

  it('supprime un membre, en annonçant le retrait de son équipe', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);
    await mountOnglet('participants', { '/api/participants': [membre(3)] }, 'btn-add-participant');

    fireEvent.click(document.getElementById('btn-delete-participant-3')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

    // Conséquence à énoncer : `team_members.participant_id` est en CASCADE,
    // donc la personne quitte aussi son équipe. Le dire dans le dialogue évite
    // une découverte plus tard, quand l'équipe aura changé sans explication.
    const dialogue = document.querySelector('dialog[open]')!;
    expect(dialogue.textContent).toContain('Supprimer Prénom3 Nom3 ?');
    expect(dialogue.textContent).toContain('elle en sera également retirée');

    fireEvent.click(boutonConfirmer());
    await waitFor(() => expect(supprimer).toHaveBeenCalledWith('/api/participants/3'));
  });

  it('n’envoie rien sur les trois ressources si la confirmation est annulée', async () => {
    const supprimer = vi.spyOn(api, 'delete').mockResolvedValue({ success: true } as never);

    // Le hook est partagé : une seule annulation mal câblée suffirait à rendre
    // les trois boutons decoratoriels en parasites. On les vérifie ensemble.
    for (const [onglet, donnees, ancre, boutonId] of [
      ['teams', { '/api/teams': [equipe(4)] }, 'btn-add-team', 'btn-delete-team-4'],
      ['questions', { '/api/questions': [question(9)] }, 'btn-add-question', 'btn-delete-question-9'],
      [
        'participants',
        { '/api/participants': [membre(3)] },
        'btn-add-participant',
        'btn-delete-participant-3',
      ],
    ] as const) {
      const { unmount } = await (async () => {
        stubGet({ ...ROUTES, ...donnees });
        const vue = render(<AdminDashboard />);
        await waitFor(() => expect(document.getElementById('btn-publish-overview')).not.toBeNull());
        fireEvent.click(document.getElementById(`tab-${onglet}`)!);
        await waitFor(() => expect(document.getElementById(ancre)).not.toBeNull());
        return vue;
      })();

      fireEvent.click(document.getElementById(boutonId)!);
      await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

      const annuler = Array.from(document.querySelectorAll<HTMLElement>('dialog button')).find((b) =>
        b.textContent?.includes('Annuler')
      )!;
      fireEvent.click(annuler);
      unmount();
    }

    expect(supprimer).not.toHaveBeenCalled();
  });

  it('n’affiche qu’un seul dialogue, quel que soit le nombre de lignes', async () => {
    // Un dialogue par ligne aurait été l'implémentation naturelle : vingt
    // questions, vingt boîtes dans le document. Le hook partagé n'en rend qu'une,
    // ouverte sur la ligne visée.
    // Trois dialogues à l'écran : publication, retrait, suppression. Ce qui compte
    // est qu'ils ne dépendent PAS du nombre de lignes — un dialogue par ligne
    // aurait été l'implémentation naturelle, et vingt questions auraient produit
    // vingt boîtes dans le document. On mesure donc le nombre de dialogues à
    // trois lignes, puis à une seule.
    const avecTrois = await mountOnglet(
      'questions',
      { '/api/questions': [question(1), question(2), question(3)] },
      'btn-add-question'
    );
    const nombreDialogues = avecTrois.container.querySelectorAll('dialog').length;
    avecTrois.unmount();
    mounted = null;

    const avecUne = await mountOnglet(
      'questions',
      { '/api/questions': [question(1)] },
      'btn-add-question'
    );
    expect(avecUne.container.querySelectorAll('dialog')).toHaveLength(nombreDialogues);

    // Et le dialogue ouvert est bien celui de la ligne visée, sans fuite des
    // voisines : c'est le bug classique quand la cible est stockée dans un état
    // partagé mal remis à zéro.
    fireEvent.click(document.getElementById('btn-delete-question-1')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());
    expect(
      avecUne.container.querySelector<HTMLDialogElement>('dialog[open]')!.textContent
    ).toContain('question 1');

    // Même contrôle sur trois lignes : cliquer la deuxième n'expose ni la
    // première ni la troisième.
    avecUne.unmount();
    mounted = null;
    const avecToutes = await mountOnglet(
      'questions',
      { '/api/questions': [question(1), question(2), question(3)] },
      'btn-add-question'
    );

    fireEvent.click(document.getElementById('btn-delete-question-2')!);
    await waitFor(() => expect(boutonConfirmer()).toBeTruthy());

    const dialogue = avecToutes.container.querySelector<HTMLDialogElement>('dialog[open]')!;
    expect(dialogue.textContent).toContain('question 2');
    expect(dialogue.textContent).not.toContain('question 1');
    expect(dialogue.textContent).not.toContain('question 3');
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
