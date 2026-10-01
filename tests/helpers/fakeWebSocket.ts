/**
 * Doublure de WebSocket pour les tests.
 *
 * jsdom n'implémente pas WebSocket, et `LiveContext` en ouvre un au montage :
 * le simple fait de monter un composant levait une `ReferenceError` avant même
 * d'atteindre la première assertion.
 *
 * CE QUE CETTE DOUBLURE NE FAIT PAS, DELIBEREMENT
 * -----------------------------------------------
 * Elle ne simule pas le protocole. Elle enregistre ce qu'on lui demande et
 * laisse le test décider quoi répondre, via `emit()`. Un faux « serveur » qui
 * enverrait spontanément des données testerait autre chose que le composant —
 * typiquement la robustesse du composant face à des données qu'il n'a pas
 * demandées, ce qui n'est pas ce qu'on cherche à prouver ici.
 *
 * L'historique des instances est réinitialisé avant chaque test : sans cela,
 * le composant d'un test.Bytes précédent resterait dans la liste et un test
 * consultant `instances[0]` lirait une socket morte.
 */
import { vi } from 'vitest';

export class FakeWebSocket {
  /** Toutes les sockets créées depuis le dernier test. */
  static instances: FakeWebSocket[] = [];

  /** Remet le compteur global à zéro. Appelé par le fichier de mise en place. */
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED (valeurs de l'API WebSocket). */
  readyState = 0;

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();

  /** Simule l'ouverture de la connexion. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Simule une trame reçue du serveur. */
  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  /** Simule une fermeture. */
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Dernière socket ouverte. Pratique quand un composant en ouvre plusieurs. */
  static get last(): FakeWebSocket | undefined {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}
