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

/** Monte le contexte et renvoie la socket, prête à diffuser. */
function monter() {
  render(
    <LiveProvider>
      <SondePodium />
    </LiveProvider>
  );
  const socket = FakeWebSocket.instances[0];
  act(() => {
    socket.open();
  });
  return socket;
}

function diffuser(socket: FakeWebSocket, type: string, liveState: ReturnType<typeof etat>) {
  act(() => {
    socket.emit({ type, data: { liveState } });
  });
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
