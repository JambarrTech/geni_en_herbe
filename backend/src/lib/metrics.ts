/**
 * Metriques applicatives, au format d'exposition Prometheus.
 *
 * Sondes de vivacite repondent « ce processus vit ». Elles ne disent rien de la
 * sante du service : un processus qui repond 200 sur /api/health tout en renvoyant
 * 500 sur la moitie de ses requetes est « vivant » et totalement hors service.
 * Ces metriques couvrent ce que la vivacite ne voit pas.
 *
 * Ce qui est mesure, et pourquoi
 * ------------------------------
 * - HTTP : nombre, statut et latence par route. Le Cardinal est important :
 *   sans lui, `/api/matches/:id/score` et `/api/rankings` se cumulent en un seul
 *   `aeerks_http_requests_total{route="/api/*"}` et le second disparait dans le
 *   premier. On normalise donc le chemin sur le patron de la route Express,
 *   ce qui borne aussi le nombre de series (cf. `routeLabel`).
 * - WebSocket : clients connectes, messages diffuss, clients deconnectes par
 *   contre-pression. Une disconnection en rafale est le signe d'un ecran public
 *   qui ne suit plus.
 * - Limitation de debit : rejets par quota. Un pic ici n'est pas un incident,
 *   c'est souvent l'anti-double-clic qui fait son travail — mais un pic
 *   permanent signale un script.
 * - Sessions actives : depend directement du stockage de sessions choisi, et
 *   permeut de voir une purge de masse (redemarrage, incident) au lieu de la
 *   deduire d'une disconnection cote client.
 * - Sante du pool PostgreSQL et du processus : temps d'attente d'une connexion,
 *   requetes en erreur, retard de la boucle d'evenements, memoire et duress.
 *
 * Contrainte de cardinalite
 * -------------------------
 * Une metrique avec une etiquette libre (identifiant de match, IP, email) cree
 * une serie par valeur. En competition, un membre du jury peut participer a
 * plusieurs dizaines de matchs : on ne met JAMAIS d'identifiant metier en
 * etiquette. Seules des valeurs d'un ensemble fini sont utilisees, et
 * `routeLabel` garantit un ensemble fini cote route.
 *
 * Pas de dependance : le format d'exposition est un simple rendu de texte
 * (`nom{etiquette=valeur} valeur`). Un client Prometheus n'a besoin que de
 * cela, et le backend n'embarque pas `prom-client` pour autant.
 */

import { CONFIG } from '../config.ts';

type Labels = Record<string, string | number>;

/**
 * Compteur monotone.
 *
 * `inc` refuse une valeur negative. Un compteur qui peut redescendre casse les
 * fonctions de taux de Prometheus (`rate`, `increase`), qui supposent la
 * monotonie et calculeraient alors un debit negatif — plus obscure qu'une
 * absence de donnee. Refuser tot, au developpement, evite de deployer une
 * metrique qui affiche des valeurs absurdes sans lever la moindre erreur.
 */
class Counter {
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  /** @returns la nouvelle valeur du compteur. */
  inc(labels: Labels = {}, by = 1): number {
    if (by < 0) {
      throw new RangeError(
        `${this.name} est un compteur : il ne peut pas diminuer (tentative de ${by}). ` +
          'Utilisez une jauge si la valeur doit pouvoir redescendre.'
      );
    }
    const key = serializeLabels(labels);
    const next = (this.values.get(key) ?? 0) + by;
    this.values.set(key, next);
    return next;
  }

  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`].concat(
      [...this.values.entries()].map(([labels, v]) => `${this.name}${labels} ${v}`)
    );
  }
}

/** Jauge : valeur qui monte et descend. */
class Gauge {
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    private read: () => number = () => 0
  ) {}

  set(value: number): void {
    this.values.set('', value);
  }

  setWithLabels(value: number, labels: Labels): void {
    this.values.set(serializeLabels(labels), value);
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = serializeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    // La lecture dynamique est evaluee a chaque exposition : c'est ce qui permet
    // de publier la memoire ou le retard d'evenements sans que quiconque ait
    // pense a les mettre a jour.
    const live = this.read();
    if (this.values.size === 0 && live === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labels, v] of this.values.entries()) lines.push(`${this.name}${labels} ${v}`);
      if (!this.values.has('')) lines.push(`${this.name} ${live}`);
    }
    return lines;
  }
}

/**
 * Histogramme a frontieres exponentielles en secondes.
 *
 * Choix des frontieres : 5 ms / 50 ms / 250 ms / 1 s / 5 s / 30 s.
 * L'echelle est etiree vers les fortes valeurs parce qu'une attribution de
 * score pose un `SELECT ... FOR UPDATE` puis un recalcul depuis
 * `score_events` : la latence utile n'est pas le temps d'un aller-retour simple,
 * et une frontiere unique a 100 ms masquerait completement la queue.
 *
 * Le cumul (`_sum`, `_count`) est ce qu'on lit pour un debut d'incident ; les
 * `bucket` servent a calculer des quantiles via `histogram_quantile`.
 */
class Histogram {
  private bounds: number[];
  /**
   * Comptage par jeu d'etiquettes, et NON par metrique.
   *
   * Un tableau de compteurs unique partage par tous les jeux d'etiquettes
   * attribuerait a `/api/matches/:id` les latences mesurees sur
   * `/api/rankings` : chaque serie afficherait le cumul global, et tous les
   * quantiles par route seraient faux — precisement ce que l'histogramme
   * existe pour mesurer.
   */
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    bounds: number[]
  ) {
    this.bounds = [...bounds].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = serializeLabels(labels);
    let agg = this.series.get(key);
    if (!agg) {
      // Un emplacement de plus que le nombre de frontieres : le dernier
      // recoit tout ce qui depasse la derniere, et constitue le seau +Inf.
      agg = { counts: new Array(this.bounds.length + 1).fill(0), sum: 0, count: 0 };
      this.series.set(key, agg);
    }

    let idx = this.bounds.findIndex((b) => value <= b);
    if (idx === -1) idx = this.bounds.length;
    agg.counts[idx] += 1;
    agg.sum += value;
    agg.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [labels, agg] of this.series.entries()) {
      // Prometheus exige des seaux CUMULES : chaque seuil vaut le total des
      // observations qui lui sont inferieures OU egales. Rendre le compteur
      // d'un seul intervalle donnerait un +Inf inferieur au seuil precedent,
      // et `histogram_quantile` — qui interpole entre seuils — renverrait
      // alors une latence fantome, voire negative.
      let cumulative = 0;
      for (let i = 0; i < this.bounds.length; i += 1) {
        cumulative += agg.counts[i];
        lines.push(
          `${this.name}_bucket${withExtra(labels, { le: String(this.bounds[i]) })} ${cumulative}`
        );
      }
      // +Inf englobe le dernier intervalle : c'est le total des observations,
      // qui doit egaler `_count`. C'est ce point d'egalite que Prometheus
      // utilise pour detecter une serie incomplete ou un seau manquant.
      cumulative += agg.counts[this.bounds.length];
      lines.push(`${this.name}_bucket${withExtra(labels, { le: '+Inf' })} ${cumulative}`);
      lines.push(`${this.name}_sum${labels} ${agg.sum}`);
      lines.push(`${this.name}_count${labels} ${agg.count}`);
    }
    return lines;
  }
}

function serializeLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(',')}}`;
}

function withExtra(labels: string, extra: Labels): string {
  const merged = labels === '' ? '' : labels.slice(1, -1);
  const extraStr = Object.entries(extra)
    .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
    .join(',');
  return merged === '' ? `{${extraStr}}` : `{${merged},${extraStr}}`;
}

/** Echappe le caractere d'echappement et les guillemets, comme l'exige le format. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Normalisation des routes
// ---------------------------------------------------------------------------

/**
 * Associe un chemin reel a un patron de route stable.
 *
 * Deux raisons de ne pas utiliser le chemin brut :
 *  - cardinalite : `/api/matches/17`, `/api/matches/18`... creeraient une
 *    serie par match, donc une serie par competition ;
 *  - lisibilite : `route="/api/matches/17"` n'est pas exploitable dans un
 *    tableau de bord, `route="/api/matches/:id"` si.
 *
 * On ne s'appuie pas sur `req.route.path` seul : il est indefini quand aucune
 * route ne correspond (404), et ne contient pas le prefixe de montage. On
 * reconstruit donc un patron en remplacant les segments numeriques.
 */
const PARAM_RE = /\/(?:\d+)(?=\/|$)/g;

export function routeLabel(path: string): string {
  // Les query strings ne font pas partie de l'identite d'une route.
  const clean = path.split('?')[0];
  const normalized = clean.replace(PARAM_RE, '/:id');
  // Garde-fou de cardinalite : un chemin qui n'a pas ete reconnu (ou un
  // identifiant non numerique) ne doit pas ouvrir une serie par valeur.
  if (normalized.length > CONFIG.METRICS_MAX_ROUTE_LABEL_LENGTH) return 'autre';
  if (!normalized.startsWith('/api')) return 'non-api';
  return normalized;
}

// ---------------------------------------------------------------------------
// Collecte
// ---------------------------------------------------------------------------

let eventLoopLagSeconds = 0;
let eventLoopTimer: NodeJS.Timeout | null = null;
/** Dernier retard observe : alimente une jauge exposee au scrape. */
let lastEventLoopLagSeconds = 0;

/**
 * Mesure le retard de la boucle d'evenements.
 *
 * Une latence HTTP peut sembler correcte alors que la boucle est saturee : dix
 * requetes en parallele se serialisent. Le retard de boucle est le seul signal
 * qui distingue « la base est lente » de « le processus ne s'execute plus »,
 * et c'est celui qui explique un decrochage du chrono sur l'ecran public.
 */
function startEventLoopMonitor(): void {
  if (eventLoopTimer) return;
  let last = process.hrtime.bigint();
  eventLoopTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const delta = Number(now - last) / 1e9 - 1;
    last = now;
    if (delta > 0) {
      lastEventLoopLagSeconds = delta;
      // Lissage exponentiel : un pic isole (GC, compilation JIT) ne doit pas
      // faire cavaler la jauge, mais une saturation continue doit se voir.
      eventLoopLagSeconds = eventLoopLagSeconds * 0.9 + delta * 0.1;
    }
  }, 1000);
  eventLoopTimer.unref();
}

export const metrics = {
  httpRequests: new Counter(
    'aeerks_http_requests_total',
    'Requetes HTTP servies, par methode, route et statut'
  ),
  httpDuration: new Histogram(
    'aeerks_http_request_duration_seconds',
    'Latence des requetes HTTP, en secondes',
    [0.005, 0.05, 0.25, 1, 5, 30]
  ),
  httpInFlight: new Gauge(
    'aeerks_http_requests_in_flight',
    'Requetes HTTP en cours de traitement'
  ),
  httpRejected: new Counter(
    'aeerks_http_rejected_total',
    'Requetes refusees avant traitement (limitation de debit), par motif'
  ),
  rateLimitRejected: new Counter(
    'aeerks_rate_limit_rejections_total',
    'Requets refuses par quota, par libelle de quota'
  ),
  wsClients: new Gauge('aeerks_ws_clients', 'Clients WebSocket connectes'),
  wsMessages: new Counter('aeerks_ws_messages_total', 'Messages diffusés aux clients'),
  wsBackpressureDrops: new Counter(
    'aeerks_ws_backpressure_drops_total',
    'Clients deconnectes pour file d\'envoi saturée (contre-pression)'
  ),
  // Un compteur, et non une jauge : un refus d'origine est un evenement
  // ponctuel, et un total nul n'a pas de « moment present » a surveiller.
  wsOriginRejected: new Counter(
    'aeerks_ws_origin_rejected_total',
    'Connexions WebSocket refusees a la poignee de main, par raison'
  ),
  busPublished: new Counter('aeerks_bus_published_total', 'Evenements publies sur le bus'),
  busErrors: new Counter('aeerks_bus_errors_total', 'Echecs de publication sur le bus'),
  sessionsActive: new Gauge('aeerks_sessions_active', 'Sessions ouvertes'),
  sessionsCreated: new Counter('aeerks_sessions_created_total', 'Sessions creees'),
  sessionsRevoked: new Counter('aeerks_sessions_revoked_total', 'Sessions revoquees'),
  dbErrors: new Counter('aeerks_db_errors_total', 'Erreurs base de donnees, par operation'),
  dbPoolWaiting: new Gauge(
    'aeerks_db_pool_waiting',
    'Connexions en attente dans le pool PostgreSQL'
  ),
  processResidentBytes: new Gauge(
    'aeerks_process_resident_bytes',
    'Memoire residente du processus',
    () => process.memoryUsage().rss
  ),
  processHeapUsedBytes: new Gauge(
    'aeerks_process_heap_used_bytes',
    'Memoire utilisee par le tas V8',
    () => process.memoryUsage().heapUsed
  ),
  eventLoopLagSeconds: new Gauge(
    'aeerks_event_loop_lag_seconds',
    'Retard moyen recent de la boucle d\'evenements, en secondes',
    () => eventLoopLagSeconds
  ),
  eventLoopLagLastSeconds: new Gauge(
    'aeerks_event_loop_lag_last_seconds',
    'Dernier retard mesure de la boucle d\'evenements, en secondes',
    () => lastEventLoopLagSeconds
  ),
};

startEventLoopMonitor();

/** Rendu complet au format d'exposition Prometheus. */
export function renderMetrics(service: string, extraGauges: Record<string, () => number> = {}): string {
  const sections: string[] = [
    ...metrics.httpRequests.render(),
    ...metrics.httpDuration.render(),
    ...metrics.httpInFlight.render(),
    ...metrics.httpRejected.render(),
    ...metrics.rateLimitRejected.render(),
    ...metrics.wsClients.render(),
    ...metrics.wsMessages.render(),
    ...metrics.wsBackpressureDrops.render(),
    ...metrics.wsOriginRejected.render(),
    ...metrics.busPublished.render(),
    ...metrics.busErrors.render(),
    ...metrics.sessionsActive.render(),
    ...metrics.sessionsCreated.render(),
    ...metrics.sessionsRevoked.render(),
    ...metrics.dbErrors.render(),
    ...metrics.dbPoolWaiting.render(),
    ...metrics.processResidentBytes.render(),
    ...metrics.processHeapUsedBytes.render(),
    ...metrics.eventLoopLagSeconds.render(),
    ...metrics.eventLoopLagLastSeconds.render(),
  ];

  for (const [name, read] of Object.entries(extraGauges)) {
    sections.push(
      `# HELP aeerks_${name} Valeur propre au service ${name}`,
      `# TYPE aeerks_${name} gauge`,
      `aeerks_${name} ${read()}`
    );
  }

  sections.push(
    '# HELP aeerks_scrape_service_info Service ayant repondu au scrape',
    '# TYPE aeerks_scrape_service_info gauge',
    `aeerks_scrape_service_info{service="${escapeLabel(service)}"} 1`
  );

  return `${sections.join('\n')}\n`;
}

/**
 * Retard observe le plus recemment, pour les tests.
 *
 * Le moniteur reel echantillonne toutes les secondes et ecraserait une valeur
 * injectee par un test avant que celui-ci ne puisse la lire : la lecture de cet
 * etat depuis un test serait donc une course, pas une assertion. On expose
 * l'etat courant plutot qu'un moyen de le fabricer.
 */
export function lastObservedEventLoopLag(): number {
  return lastEventLoopLagSeconds;
}
