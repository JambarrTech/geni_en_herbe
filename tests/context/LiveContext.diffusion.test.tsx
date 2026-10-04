/**
 * Ce que le contexte fait d'un message diffusé.
 *
 * POURQUOI CE FICHIER EST SÉPARÉ DE CELUI DE LA RECONNEXION
 * ---------------------------------------------------------
 * `LiveContext.reconnexion.test.tsx` prouve une politique : quand reconnecter, et
 * quand le délai repart de zéro. Ce qui suit est une autre question — quand le
 * message reçu remplace-t-il l'état affiché ? — et les deux se vérifient sur le
 * même composant sans partager le même sujet.
 *
 * LE POINT PRÉCIS, ET LE PIÈGE QU'IL ÉVITE
 * ----------------------------------------
 * Un message qui porte `liveState` n'est PAS traité comme une invalidation : le
 * contexte fusionne l'état reçu au lieu de redemander `/api/live`. Le classement
 * n'est donc jamais rechargé par le réseau, il vient du message.
 *
 * D'où le test : il vérifie la VALEUR-affichée après une annulation. Un test qui
 * se contenterait de compter les appels à `api.get` passerait dans les deux
 * sens — il ne voit ni une fusion juste, ni une fusion qui garde un podium
 * périmé, puisque dans les deux cas il n'y a aucun appel réseau.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';

import { LiveProvider, useLive } from '@shared/context/LiveContext.tsx';
import { api } from '@shared/lib/api.ts';
import type { TeamRanking } from '@shared/types.ts';
import { FakeWebSocket } from '../helpers/fakeWebSocket.ts';

// Le composant appelle `GET /api/live` au montage. Aucun réseau ici : le stub
// rejette, et le `catch` de `refreshLiveState` l'absorbe. La relecture est
// VOLONTAIREMENT en échec — si l'une des diffusions testées déclenchait une
// relecture HTTP, elle échouerait aussi, le podium resterait vide et le test le
// verrait. Une doublure qui renvoyait un état plausible masquerait ce défaut.
vi.mock('@shared/lib/api.ts', () => ({
  api: { get: vi.fn().mockRejectedValue(new Error('aucun reseau dans ce test')) },
  getStoredToken: () => null,
  isAbort: () => true,
}));

/** Une equipe au classement, avec les seules lignes qui comptent pour l'affichage. */
function equipe(position: number, teamName: string): TeamRanking {
  return {
    position,
    teamId: position,
    teamName,
    teamCode: `E${position}`,
    matchesPlayed: 1,
    wins: 1,
    draws: 0,
    losses: 0,
    pointsScored: 40,
    pointsConceded: 10,
    pointsDifference: 30,
    totalScore: 40,
  };
}

/** État minimal mais complet : `LiveContext` lit `rankings`, `activeMatch`, `event`. */
function etat(rankings: TeamRanking[]) {
  return {
    event: { id: 1, name: 'Journée AEERKS', status: 'LIVE', resultsPublished: false },
    activeMatch: null,
    upcomingMatches: [],
    completedMatches: [],
    rankings,
    resultsPublished: false,
    serverTimestamp: 1,
  };
}

/** Sonde le podium affiché — l'écran projeté dans la salle, pas la connexion. */
function SondePodium() {
  const { liveState } = useLive();
  const noms = (liveState?.rankings ?? []).map((r) => r.teamName).join(', ');
  return <span data-testid="podium">{noms}</span>;
}

/**
 * Sonde l'étape du scénario de diffusion affichée au public.
 *
 * Sert à prouver que le message `broadcast_step` est traité comme les autres
 * diffusions — c'est-à-dire qu'il REMPLACE l'état, au lieu d'être ignoré ou de
 * déclencher une relecture réseau.
 */
function SondeDiffusion() {
  const { liveState } = useLive();
  const broadcast = liveState?.activeMatch?.broadcast;
  return (
    <span data-testid="diffusion">
      {broadcast ? `${broadcast.stage}@${broadcast.stepNumber}/${broadcast.totalSteps}` : 'aucune'}
    </span>
  );
}

/** Monte le contexte et renvoie la socket, prête à diffuser. */
function monter() {
  render(
    <LiveProvider>
      <SondePodium />
      <SondeDiffusion />
    </LiveProvider>
  );
  const socket = FakeWebSocket.instances[0];
  act(() => {
    socket.open();
  });
  return socket;
}

/**
 * État minimal capable de contenir — ou non — un match en cours de diffusion.
 *
 * Le type est une union des deux constructeurs, et non `ReturnType<typeof etat>` :
 * ce dernier fixait `activeMatch: null`, ce qui aurait fait échouer le
 * typecheck sur toute diffusion où il y a un match à l'écran — c'est-à-dire sur
 * toutes celles qui nous intéressent.
 */
type EtatDiffuse = ReturnType<typeof etat> | ReturnType<typeof matchEnDiffusion>;

function diffuser(socket: FakeWebSocket, type: string, liveState: EtatDiffuse) {
  act(() => {
    socket.emit({ type, data: { liveState } });
  });
}

/**
 * État d'un match au milieu d'une série, à l'étape de diffusion demandée.
 *
 * `broadcast` reproduit la forme que le serveur joint à l'état live : c'est cette
 * forme que `LiveContext` doit laisser passer telle quelle jusqu'à l'écran.
 */
function matchEnDiffusion(
  stage: 'ROSTER' | 'QUESTION' | 'ANSWER_A' | 'ANSWER_B' | 'REVEAL' | 'FINAL',
  stepNumber: number
) {
  return {
    ...etat([]),
    activeMatch: {
      id: 1,
      scoreA: 20,
      scoreB: 10,
      broadcast: {
        stage,
        questionIndex: 0,
        questionCount: 2,
        stepNumber,
        totalSteps: 10,
        canAdvance: stage !== 'FINAL',
        canRewind: stepNumber > 1,
        revealsAnswer: stage === 'REVEAL',
        showsRoster: stage === 'ROSTER',
      },
    },
  };
}

beforeEach(() => {
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('une diffusion qui retire un résultat du podium', () => {
  test('le podium affiche la nouvelle valeur, pas celle d\'avant', () => {
    const socket = monter();

    // Point de départ : deux équipes classées. C'est l'état après le premier
    // match terminé d'une journée.
    diffuser(socket, 'match_finished', etat([equipe(1, 'Alpha'), equipe(2, 'Bravo')]));
    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha, Bravo');

    // Annulation : le match retiré du classement. Le serveur renvoie le podium
    // recalculé — ici les mêmes équipes, revenues à zéro, puisque le serveur
    // classe TOUTES les équipes de l'événement et pas seulement celles qui ont
    // joué. C'est ce fait qui rend la fusion sûre : le tableau n'est jamais vide
    // tant que l'événement a des équipes.
    diffuser(socket, 'match_cancelled', etat([equipe(1, 'Alpha'), equipe(2, 'Bravo')]));

    // La fusion a bien remplacé le classement. Pour le voir, il faut une
    // différence : on compare après un changement de composition.
    diffuser(socket, 'match_restored', etat([equipe(1, 'Alpha')]));
    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('podium')).not.toHaveTextContent('Bravo');
  });

  test('un résultat rétabli revient au podium', () => {
    const socket = monter();

    diffuser(socket, 'match_cancelled', etat([equipe(1, 'Alpha')]));
    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha');

    diffuser(socket, 'match_restored', etat([equipe(1, 'Alpha'), equipe(2, 'Bravo')]));
    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha, Bravo');
  });

  test('le rétablissement ne déclenche pas de relecture réseau', () => {
    const socket = monter();
    const getApi = vi.mocked(api.get);
    const lecturesAvant = getApi.mock.calls.length;

    diffuser(socket, 'match_restored', etat([equipe(1, 'Alpha')]));

    // Le classement vient du message. Une relecture ici serait invisible à
    // l'utilisateur — elle coûterait seulement un aller-retour — mais elle
    // prouverait qu'on se fie à un état local périmé plutôt qu'à celui du
    // serveur. Le réseau étant muet dans ce test, un podium vide trahirait
    // exactement cette relecture.
    expect(getApi.mock.calls.length).toBe(lecturesAvant);
    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha');
  });
});

describe('le pilotage de la diffusion atteint l\'écran public', () => {
  test('chaque étape diffusée remplace celle affichée', () => {
    const socket = monter();

    // Le déroulé complet d'une question. Sans ce test, l'erreur la plus probable
    // — `broadcast_step` absent de la liste des messages à traiter — passerait
    // inaperçue : le jury verrait son bouton changer d'état, l'écran public
    // resterait figé sur l'effectif des équipes, et rien ne signalerait l'écart.
    for (const [stage, step] of [
      ['ROSTER', 1],
      ['QUESTION', 2],
      ['ANSWER_A', 3],
      ['ANSWER_B', 4],
      ['REVEAL', 5],
      ['FINAL', 10],
    ] as const) {
      diffuser(socket, 'broadcast_step', matchEnDiffusion(stage, step));
      expect(screen.getByTestId('diffusion')).toHaveTextContent(`${stage}@${step}/10`);
    }
  });

  test('une étape de diffusion ne provoque pas de relecture réseau', () => {
    const socket = monter();
    const getApi = vi.mocked(api.get);
    const lecturesAvant = getApi.mock.calls.length;

    diffuser(socket, 'broadcast_step', matchEnDiffusion('REVEAL', 5));

    // La position du scénario fait partie de l'état : elle arrive avec le
    // message. Une relecture ici serait d'autant plus Vicieuse que la décision
    // elle-même — ce que le public a le droit de voir — a déjà été prise côté
    // serveur.
    expect(getApi.mock.calls.length).toBe(lecturesAvant);
    expect(screen.getByTestId('diffusion')).toHaveTextContent('REVEAL@5/10');
  });

  test('un réordonnancement de série atteint l’écran public sans relecture réseau', () => {
    const socket = monter();
    const getApi = vi.mocked(api.get);
    const lecturesAvant = getApi.mock.calls.length;

    // Le comité réordonne la série d'un match non démarré (bouton admin
    // « réordonner selon les priorités »). Sans `questions_reordered` dans la
    // liste des messages traités, l'écran restait figé sur l'ancien ordre
    // jusqu'au prochain événement — sans aucun signal d'écart.
    diffuser(socket, 'broadcast_step', matchEnDiffusion('QUESTION', 2));
    diffuser(socket, 'questions_reordered', matchEnDiffusion('QUESTION', 1));

    expect(getApi.mock.calls.length).toBe(lecturesAvant);
    expect(screen.getByTestId('diffusion')).toHaveTextContent('QUESTION@1/10');
  });

  test('un type inconnu ne fait pas non plus bouger le scénario', () => {
    const socket = monter();

    diffuser(socket, 'broadcast_step', matchEnDiffusion('ANSWER_A', 3));
    // N'importe quel autre événement ne doit pas réécrire l'étape affichée :
    // l'écran public ne se resynchronise que sur ce que le serveur a décidé.
    diffuser(socket, 'evenement_inconnu', matchEnDiffusion('FINAL', 10));

    expect(screen.getByTestId('diffusion')).toHaveTextContent('ANSWER_A@3/10');
  });
});

describe('ce qui ne doit pas bouger', () => {
  test('un type inconnu laisse le podium intact', () => {
    const socket = monter();
    diffuser(socket, 'match_finished', etat([equipe(1, 'Alpha'), equipe(2, 'Bravo')]));

    // La liste de `LiveContext` est un filtre explicite, pas un « rafraîchis-moi
    // tout ». Un type qui n'y est pas ne doit rien déclencher : sinon la
    // prochaine diffusion ajoutée à la liste n'importe plus, puisque tout
    // déclencherait déjà.
    diffuser(socket, 'evenement_inconnu', etat([equipe(1, 'Charlie')]));

    expect(screen.getByTestId('podium')).toHaveTextContent('Alpha, Bravo');
    expect(screen.getByTestId('podium')).not.toHaveTextContent('Charlie');
  });
});
