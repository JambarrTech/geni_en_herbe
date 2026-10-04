import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';

import { api } from '@shared/lib/api.ts';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { JuryDashboard } from '@apps/jury/src/pages/JuryDashboard.tsx';

// ---------------------------------------------------------------------------
// Contextes simulés
// ---------------------------------------------------------------------------
// Le tableau de bord dépend de deux contextes React qui, montés pour de vrai,
// ouvriraient une connexion WebSocket et un appel `GET /api/auth/me`. Aucun des
// deux n'a de rapport avec ce qu'on veut vérifier ici : la construction du
// corps envoyé à `POST /:id/score`, et le fait qu'un clic et un raccourci
// produisent le MÊME corps.
vi.mock('@shared/context/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 1, role: 'JURY' }, token: 'jeton-de-test' }),
}));

vi.mock('@shared/context/LiveContext.tsx', () => ({
  useLive: () => ({
    liveState: null,
    refreshLiveState: vi.fn(),
    timerLeft: 15,
    timerRunning: false,
  }),
}));

// ---------------------------------------------------------------------------
// Données de test
// ---------------------------------------------------------------------------

/**
 * Une rencontre en cours, avec une question courante à 10 points.
 *
 * `overrides` permet de fabriquer les variantes qui comptent : match non
 * démarré, absence de question courante.
 */
function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    eventId: 1,
    phase: 'Phase qualificative',
    matchNumber: 3,
    teamAId: 10,
    teamBId: 20,
    teamA: { id: 10, eventId: 1, name: 'Lions', code: 'LIO', status: 'ACTIVE', createdAt: '' },
    teamB: { id: 20, eventId: 1, name: 'Aigles', code: 'AIG', status: 'ACTIVE', createdAt: '' },
    status: 'LIVE',
    currentQuestionIndex: 0,
    currentQuestionId: 100,
    scoreA: 0,
    scoreB: 0,
    timerSecondsLeft: 15,
    timerIsRunning: false,
    currentQuestion: {
      id: 100,
      categoryId: 1,
      text: 'Quelle est la capitale du Sénégal ?',
      answer: 'Dakar',
      type: 'DIRECT',
      difficulty: 'FACILE',
      points: 10,
      timeLimitSeconds: 15,
      active: true,
      createdAt: '',
    },
    matchQuestions: [
      { id: 1, orderNumber: 1, status: 'ACTIVE', pointsAwarded: 0, winningTeamId: null },
      { id: 2, orderNumber: 2, status: 'PENDING', pointsAwarded: 0, winningTeamId: null },
    ],
    scoreEvents: [],
    ...overrides,
  };
}

const MATCH_SUMMARY = {
  id: 5,
  eventId: 1,
  phase: 'Phase qualificative',
  matchNumber: 3,
  teamAId: 10,
  teamBId: 20,
  status: 'LIVE',
  currentQuestionIndex: 0,
  scoreA: 0,
  scoreB: 0,
  timerSecondsLeft: 15,
  timerIsRunning: false,
  timerDuration: 15,
};

/**
 * Remplace `api.get` par un routeur minimal, sans réseau.
 *
 * Un chemin non prévu lève, plutôt que de renvoyer `undefined` : un test qui
 * passerait parce qu'un appel inattendu a silencieusement renvoyé « rien »
 * serait vert pour de mauvaises raisons.
 */
function stubGet(routes: Record<string, unknown>) {
  return vi
    .spyOn(api, 'get')
    .mockImplementation((async (path: string) => {
      if (!(path in routes)) throw new Error(`GET inattendu dans ce test : ${path}`);
      return routes[path];
    }) as unknown as typeof api.get);
}

/** Remplace `api.post` et enregistre les corps envoyés. */
function stubPost(response: unknown = { success: true, scoreA: 0, scoreB: 0 }) {
  return vi
    .spyOn(api, 'post')
    .mockImplementation((async () => response) as unknown as typeof api.post);
}

/**
 * Récupère un élément par son identifiant.
 *
 * Les boutons de score existent en double — un par équipe — avec le même
 * libellé. `getByRole('button', { name: ... })` lèverait donc sur un doublon,
 * et un test qui lèverait pour cette raison n'apprendrait rien. Les
 * identifiants sont stables et explicites.
 */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément #${id} introuvable dans le rendu`);
  return el;
}

/** Monte l'écran et attend que le détail du match soit chargé. */
async function mountReady(detail = makeDetail()) {
  stubGet({
    '/api/matches': [MATCH_SUMMARY],
    '/api/matches/5': detail,
  });
  const post = stubPost();

  const { container } = render(<JuryDashboard />);

  // Le panneau de l'équipe A n'existe qu'une fois le détail chargé : il sert de
  // signal d'attente, plus fiable qu'un délai arbitraire.
  await waitFor(() => expect(document.getElementById('jury-card-team-a')).not.toBeNull());
  return { post, container };
}

/** Corps passé en 2e argument de `api.post` (chemin, corps, options). */
function lastPostedBody(mock: ReturnType<typeof stubPost>) {
  const calls = mock.mock.calls;
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
}

/** Attend la fin du verrou anti-double-clic local. */
function waitForUnlock() {
  return new Promise((resolve) => setTimeout(resolve, APP_CONFIG.ANTI_DOUBLE_CLICK_MS + 100));
}

beforeEach(() => {
  // Repartir d'un stockage vide évite de dépendre de l'ordre d'exécution.
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JuryDashboard — chargement', () => {
  it('sélectionne automatiquement le match en cours', async () => {
    await mountReady();
    const select = screen.getByLabelText(/Match actif/i) as HTMLSelectElement;
    expect(select.value).toBe('5');
  });

  it("n'autorise pas l'attribution quand la question courante manque", async () => {
    // `canScore` exige un statut LIVE/PAUSED *et* une question courante. Sans
    // cette double condition, les boutons envoyaient `questionId: undefined`
    // et chaque clic valait 10 points.
    await mountReady(
      makeDetail({ status: 'SCHEDULED', currentQuestion: null, currentQuestionId: null })
    );

    expect(byId('btn-jury-valider-team-a')).toBeDisabled();
    expect(byId('btn-jury-penalty-team-a')).toBeDisabled();
  });

  it('explique pourquoi le score est désactivé', async () => {
    await mountReady(makeDetail({ status: 'FINISHED' }));

    // Le motif est rendu dans un `role="note"` : il n'est pas seulement visuel.
    expect(screen.getByRole('note')).toHaveTextContent(/clôturé/i);
  });
});

describe('JuryDashboard — corps envoyé à POST /score', () => {
  it("un clic envoie l'identifiant du match, celui de la question et le motif", async () => {
    const { post } = await mountReady();

    fireEvent.click(byId('btn-jury-valider-team-a'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    expect(post.mock.calls[0][0]).toBe('/api/matches/5/score');
    expect(lastPostedBody(post)).toEqual({
      teamId: 10,
      questionId: 100,
      points: 10,
      type: 'ANSWER',
      reason: 'Bonne réponse directe (10 pts)',
    });
  });

  it('le raccourci clavier envoie EXACTEMENT le même corps que le clic', async () => {
    // C'est la garantie que l'extraction de `lib/juryShortcuts.ts` doit
    // apporter : un seul vocabulaire pour les deux chemins d'attribution.
    // Avant, les motifs étaient écrits deux fois (une fois par bouton, une
    // fois par touche) et pouvaient diverger sans que rien ne le signale — or
    // ces motifs sont enregistrés en base comme motif d'audit.
    const { post } = await mountReady();

    fireEvent.click(byId('btn-jury-valider-team-a'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    await waitForUnlock();

    // Le raccourci est posé sur `window` ; on le déclenche sur `body`, comme
    // le ferait un vrai appui clavier sans champ de saisie focalisé.
    fireEvent.keyDown(document.body, { key: 'a' });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    expect(post.mock.calls[1][0]).toBe(post.mock.calls[0][0]);
    expect(lastPostedBody(post)).toEqual(post.mock.calls[0][1]);
  });

  it('le bonus vaut la valeur de configuration, pas les points de la question', async () => {
    const { post } = await mountReady();

    fireEvent.click(byId('btn-jury-bonus-team-a'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    expect(lastPostedBody(post)).toEqual({
      teamId: 10,
      questionId: 100,
      points: APP_CONFIG.BONUS_POINTS,
      type: 'BONUS',
      reason: `Points Bonus (+${APP_CONFIG.BONUS_POINTS} pts)`,
    });
  });

  it('« Faux » vaut 0 point et vise l’équipe B', async () => {
    const { post } = await mountReady();

    fireEvent.click(byId('btn-jury-penalty-team-b'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    expect(lastPostedBody(post)).toEqual({
      teamId: 20,
      questionId: 100,
      points: 0,
      type: 'PENALTY',
      reason: 'Réponse erronée (0 pt)',
    });
  });

  it('le raccourci « e » vise l’équipe B et non l’équipe A', async () => {
    const { post } = await mountReady();

    fireEvent.keyDown(document.body, { key: 'e' });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    expect(lastPostedBody(post)).toMatchObject({ teamId: 20, type: 'ANSWER' });
  });

  it('une frappe dans un champ de saisie ne rapporte aucun point', async () => {
    // Le motif d'ajustement de score contient des lettres qui sont aussi des
    // raccourcis : « z » en écriture libre marquerait une réponse erronée.
    const { post } = await mountReady();

    const cible = document.createElement('textarea');
    document.body.appendChild(cible);

    fireEvent.keyDown(cible, { key: 'a' });
    fireEvent.keyDown(cible, { key: 'z' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(post).not.toHaveBeenCalled();

    cible.remove();
  });

  it('un raccourci avec Ctrl ne rapporte aucun point', async () => {
    // `Ctrl+A` (tout sélectionner) ne doit pas scorer l'équipe A.
    const { post } = await mountReady();

    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(post).not.toHaveBeenCalled();
  });
});

describe('JuryDashboard — verrou anti-double-clic', () => {
  it('deux clics rapides ne produisent qu’un seul appel', async () => {
    // Le verrou est local (1,5 s) ET serveur. Sans lui, un double clic sur
    // « Valider » attribuait deux fois les points, et le second appel se
    // faisait refuser en 429 — un message incompréhensible pour le jury alors
    // que son premier clic avait bien été pris en compte.
    const { post } = await mountReady();

    const bouton = byId('btn-jury-valider-team-a');
    fireEvent.click(bouton);
    fireEvent.click(bouton);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // Une fenêtre laisse le temps à un second appel éventuel de se manifester.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('le verrou se relâche après le délai aligné sur le serveur', async () => {
    const { post } = await mountReady();

    fireEvent.click(byId('btn-jury-valider-team-a'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    await waitForUnlock();

    // Le bouton doit redevenir actif : sinon le jury resterait bloqué.
    await waitFor(() => expect(byId('btn-jury-valider-team-a')).toBeEnabled());
  });
});

describe('JuryDashboard — accessibilité', () => {
  it("expose le chronomètre et l'état du match aux technologies d'assistance", async () => {
    await mountReady();

    // `role="timer"` avec un libellé vocal : sans lui, le chronomètre est un
    // texte qui change plusieurs fois par seconde, qu'un lecteur d'écran ne
    // peut ni situer ni annoncer utilement.
    expect(screen.getByRole('timer')).toHaveAccessibleName(/Chronomètre/);
  });

  it('les boutons de score annoncent leur raccourci clavier', async () => {
    await mountReady();

    // `aria-keyshortcuts` rend le raccourci découvrable sans documentation.
    expect(byId('btn-jury-valider-team-a')).toHaveAttribute('aria-keyshortcuts', 'A');
    expect(byId('btn-jury-valider-team-b')).toHaveAttribute('aria-keyshortcuts', 'E');
  });

  it('le retour d’attribution est annoncé dans une région live', async () => {
    await mountReady();

    fireEvent.click(byId('btn-jury-valider-team-a'));

    // `role="status"` + `aria-live="polite"` : un point attribué doit être
    // annoncé, pas seulement affiché.
    const statut = await screen.findByRole('status');
    expect(statut).toHaveTextContent(/validés pour Lions/);
  });

  it("n'a aucune violation axe sur le poste de jury en cours de match", async () => {
    // L'écran le plus critique de la plateforme : c'est celui qu'un membre du
    // jury utilise sous pression, souvent au clavier, parfois avec un lecteur
    // d'écran. Une violation ici n'est pas cosmétique, elle bloque quelqu'un
    // pendant une compétition.
    const { container } = await mountReady();

    expect(await axe(container)).toHaveNoViolations();
  });

  it("n'a aucune violation axe avec l'aide aux raccourcis dépliée", async () => {
    // L'aide est un `<details>` replié par défaut : son contenu n'est donc pas
    // dans l'arbre accessible tant qu'on ne l'ouvre pas, et c'est précisément
    // la partie du poste de jury que personne ne relit à la main.
    const { container } = await mountReady();

    const aide = container.querySelector('details');
    expect(aide).not.toBeNull();
    // `open` est posé directement : un clic sur `<summary>` ne déplie pas
    // l'élément dans jsdom, qui n'implémente pas ce comportement natif.
    aide!.open = true;

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('bascule automatique de l effectif', () => {
  /**
   * L effectif est la SEULE etape minutee du scenario : au lancement, le jury
   * vient d appuyer sur « Demarrer » et se tourne vers le micro, donc revenir sur
   * l ordinateur pour appuyer sur « Etape suivante » est un oubli banal.
   *
   * Ces tests verrouillent ce que le jury VOIT de cette bascule. Une bascule
   * automatique qu il ne voit pas venir est pire qu une absence de bascule :
   * l ecran change au milieu d une phrase et personne ne sait si c est prevu.
   */
  function matchDetailAvec(broadcast: Record<string, unknown>) {
    return {
      '/api/matches/5': makeDetail({ broadcast }),
      '/api/matches': [MATCH_SUMMARY],
      '/api/score-events': [],
      '/api/settings/active-event': { id: 1, name: 'Geni en Herbe 2026' },
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('annonce le compte a rebours quand une bascule est programmee', async () => {
    // Echeance dans 20 s : le texte doit apparaitre ET etre credible. Un
    // compte a rebours qui affiche 0 pendant 20 secondes est pire que pas
    // d annonce du tout.
    const dans20s = new Date(Date.now() + 20_000).toISOString();
    stubGet(matchDetailAvec({ stage: 'ROSTER', questionIndex: 0, questionCount: 2, stepNumber: 1, totalSteps: 10, canAdvance: true, canRewind: false, revealsAnswer: false, showsRoster: true, rosterUntil: dans20s }));

    render(<JuryDashboard />);

    const annonce = await screen.findByTestId('roster-auto-advance');
    expect(annonce.textContent).toMatch(/Bascule automatique dans \d+ s/);
    expect(annonce.textContent).toMatch(/question 1/);
  });

  it('n annonce RIEN quand aucune bascule n est programmee', async () => {
    // Cas ordinaire : le jury a repris la main, ou le match n a pas demarre. Une
    // annonce permanente « bascule automatique dans » alors qu il ne se passe
    // rien est un mensonge de l interface.
    stubGet(matchDetailAvec({ stage: 'ROSTER', questionIndex: 0, questionCount: 2, stepNumber: 1, totalSteps: 10, canAdvance: true, canRewind: false, revealsAnswer: false, showsRoster: true, rosterUntil: null }));

    render(<JuryDashboard />);

    await screen.findByText(/Effectif des équipes/);
    expect(screen.queryByTestId('roster-auto-advance')).toBeNull();
  });

  it('n annonce rien sur une etape que le jury pilote', async () => {
    // L echeance ne doit jamais apparaitre ailleurs qu sur l effectif : c est
    // la seule etape qui parte seule, et une annonce sur une autre etape
    // apprendrait au jury a ignorer le texte.
    stubGet(matchDetailAvec({ stage: 'QUESTION', questionIndex: 0, questionCount: 2, stepNumber: 2, totalSteps: 10, canAdvance: true, canRewind: true, revealsAnswer: false, showsRoster: false, rosterUntil: new Date(Date.now() + 20_000).toISOString() }));

    render(<JuryDashboard />);

    await screen.findByText(/Question à l’écran/);
    expect(screen.queryByTestId('roster-auto-advance')).toBeNull();
  });

  it('disparait une fois l echeance depassee', async () => {
    // L ecran est deja parti : « dans 0 s » serait faux. L absence d annonce
    // vaut mieux qu un compte a rebours qui traine a zero.
    stubGet(matchDetailAvec({ stage: 'ROSTER', questionIndex: 0, questionCount: 2, stepNumber: 1, totalSteps: 10, canAdvance: true, canRewind: false, revealsAnswer: false, showsRoster: true, rosterUntil: new Date(Date.now() - 5_000).toISOString() }));

    render(<JuryDashboard />);

    await screen.findByText(/Effectif des équipes/);
    expect(screen.queryByTestId('roster-auto-advance')).toBeNull();
  });
});

describe('JuryDashboard — diffusion manuelle du résultat', () => {
  const detailFinal = (scoresHidden: boolean) =>
    makeDetail({
      status: 'FINISHED',
      scoresHidden,
      broadcast: {
        stage: 'FINAL',
        questionIndex: 7,
        questionCount: 8,
        stepNumber: 33,
        totalSteps: 33,
        canAdvance: false,
        canRewind: true,
        revealsAnswer: false,
        showsRoster: false,
        rosterUntil: null,
      },
    });

  it('propose « Diffuser le résultat » tant que l’écran public masque', async () => {
    // Ni l’étape FINAL ni la clôture ne diffusent par elles-mêmes : sans ce
    // bouton, les totaux resteraient masqués à jamais (aucune interface
    // n’appelait encore POST /diffuse-score).
    const { post } = await mountReady(detailFinal(true));

    const btn = byId('btn-match-diffuse-result');
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveTextContent('Diffuser le résultat');

    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/api/matches/5/diffuse-score');
  });

  it('bouton absent pendant le match, avant l’étape FINAL', async () => {
    await mountReady();
    expect(document.getElementById('btn-match-diffuse-result')).toBeNull();
  });

  it('bouton inactif quand le résultat est déjà diffusé', async () => {
    await mountReady(detailFinal(false));
    const btn = byId('btn-match-diffuse-result');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Résultat diffusé');
  });
});
