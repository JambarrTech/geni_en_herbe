/**
 * Politique de reconnexion du socket temps reel, verifiee sur le composant.
 *
 * POURQUOI CE TEST EST ICI, ET PAS SUR LES FONCTIONS PURES
 * --------------------------------------------------------
 * `wsLifecycle.ts` se teste trivially : deux fonctions sans etat. Ce test ne
 * verifie donc pas ces fonctions — il verifie ce qui les entoure, c'est-a-dire
 * le CÂBLAGE dans `LiveContext` : a quel moment le backoff est remis a zero.
 *
 * C'est precisement ce qui avait casse. Les deux fonctions etaient correctes,
 * la liste des codes « definitifs » aussi : c'est `onopen` qui remettait le
 * delai a 2 s, alors que la remise a zero n'a de sens qu'aprec un message
 * recu. Aucun test des fonctions pures n'aurait vu la difference.
 *
 * LE DEFAUT REEL
 * --------------
 * Le serveur ferme en 1011 quand la VERIFICATION DU JETON echoue, donc quand
 * la base ne repond pas. Traite comme definitif, l'ecran jury ne se
 * reconnectait plus jamais : un incident de base de quelques secondes suffisait
 * a laisser le jury face a une liste figee jusqu'au rechargement manuel de la
 * page, sans le moindre message.
 *
 * Le piege du remede est aussi couvert ici : reinitialiser sur `onopen` rend
 * le backoff INOPERANT, puisque chaque essai repart de 2 s. Le deuxieme test
 * verifie donc que le delai mesure DOUBLE a chaque echec, meme quand la socket
 * s'ouvre a chaque fois.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

import { LiveProvider, useLive } from '@shared/context/LiveContext.tsx';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { FakeWebSocket } from '../helpers/fakeWebSocket.ts';

// Le composant appelle `GET /api/live` au montage. Aucun réseau ici : le stub
// rejette, et le `catch` de `refreshLiveState` l'absorbe. Sans cela, le test
// émettrait des avertissements sans rapport avec ce qu'il vérifie.
vi.mock('@shared/lib/api.ts', () => ({
  api: { get: vi.fn().mockRejectedValue(new Error('aucun réseau dans ce test')) },
  getStoredToken: () => null,
  isAbort: () => true,
}));

/** Composant qui consomme le contexte : on observe la connexion, pas l'affichage. */
function Sonde() {
  const { isConnected } = useLive();
  return <span data-testid="etat">{isConnected ? 'connecte' : 'deconnecte'}</span>;
}

/** Avance l'horloge en laissant les callbacks s'exécuter. */
async function laisserCourir(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Mesure le délai réel avant la création du socket suivant.
 *
 * Avance par pas et s'arrête à l'apparition : mesurer « après 30 s, y en a-t-il
 * un de plus ? » ne distingue pas un délai de 2 s d'un délai de 15 s, alors que
 * toute la correction porte exactement sur cette différence.
 *
 * @returns le délai écoulé, ou null si aucun socket n'est apparu.
 */
async function mesurerDelai(maxMs = 40_000): Promise<number | null> {
  const avant = FakeWebSocket.instances.length;
  const debut = Date.now();
  for (let ecoule = 0; ecoule <= maxMs; ecoule += 100) {
    await laisserCourir(100);
    if (FakeWebSocket.instances.length > avant) return Date.now() - debut;
  }
  return null;
}

/** Simule un cycle complet : ouverture, puis fermeture côté serveur. */
async function ouvrirPuisFermer(socket: FakeWebSocket, code: number) {
  await act(async () => {
    socket.open();
    socket.emitClose(code);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fermeture non definitive : il faut réessayer', () => {
  test('1011 — la base ne répondait plus — reconnecte', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    await ouvrirPuisFermer(FakeWebSocket.instances[0], APP_CONFIG.WS_CLOSE_VERIFY_ERROR);

    // Le point central : un second socket doit apparaître. Avant la correction,
    // la boucle s'arrêtait ici et il n'y en avait jamais eu de second.
    await laisserCourir(APP_CONFIG.WS_RECONNECT_DELAY_MS);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  test('le délai double à chaque échec si le serveur n\'envoie rien', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    // Le cycle de la base en panne : la socket s'ouvre, ne reçoit AUCUN
    // message, et se fait refermer. C'est le cas qui rendait le backoff
    // inopérant — chaque `onopen` remettait le compteur à 2 s.
    const delais: (number | null)[] = [];
    for (let essai = 0; essai < 3; essai += 1) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await ouvrirPuisFermer(socket, APP_CONFIG.WS_CLOSE_VERIFY_ERROR);
      delais.push(await mesurerDelai());
    }

    // S'il n'y avait pas de croissance, le jury martelait la base toutes les
    // 2 s pendant toute la session — précisément ce que le backoff existe
    // pour empêcher.
    expect(delais).toEqual([
      APP_CONFIG.WS_RECONNECT_DELAY_MS,
      APP_CONFIG.WS_RECONNECT_DELAY_MS * 2,
      APP_CONFIG.WS_RECONNECT_DELAY_MS * 4,
    ]);
  });

  test('un message reçu remet le délai à 2 s', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    // Un échec, puis une reconnexion saine : le serveur confirme.
    await ouvrirPuisFermer(FakeWebSocket.instances[0], APP_CONFIG.WS_CLOSE_VERIFY_ERROR);
    await laisserCourir(APP_CONFIG.WS_RECONNECT_DELAY_MS);

    const sain = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => {
      sain.open();
      sain.emit({ type: 'connected', authenticated: true, timestamp: Date.now() });
    });

    // Puis une coupure réseau : la reconnexion doit repartir de 2 s, et non du
    // délai porté à 15 s. Une connexion revenue à la normale ne doit pas attendre.
    await act(async () => {
      sain.emitClose(1006);
    });

    expect(await mesurerDelai()).toBe(APP_CONFIG.WS_RECONNECT_DELAY_MS);
  });
});

describe('fermetures définitives : réessayer ne servirait à rien', () => {
  test('1008 — jeton invalide — ne reconnecte pas', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    await ouvrirPuisFermer(FakeWebSocket.instances[0], APP_CONFIG.WS_CLOSE_INVALID_AUTH);

    // Reboucler ici martellerait le serveur pendant toute la session, pour un
    // jeton qui ne sera pas plus valide au prochain essai.
    await laisserCourir(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  test('1000 — arrêt normal du serveur — ne reconnecte pas', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    await ouvrirPuisFermer(FakeWebSocket.instances[0], 1000);

    await laisserCourir(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

describe('redémarrage du service', () => {
  test('1001 reconnecte sans rechargement de page', async () => {
    render(
      <LiveProvider>
        <Sonde />
      </LiveProvider>
    );

    // Le cas le plus concret sur Render : le service est suspendu puis
    // redémarre. Les écrans doivent revenir tout seuls.
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.open();
      socket.emit({ type: 'connected', authenticated: true, timestamp: Date.now() });
      socket.emitClose(1001);
    });

    await laisserCourir(APP_CONFIG.WS_RECONNECT_DELAY_MS);
    expect(FakeWebSocket.instances.length).toBe(2);
  });
});