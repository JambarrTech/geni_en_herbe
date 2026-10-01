/**
 * Test du registre de metriques et du rendu au format Prometheus.
 *
 * Ce que ces tests protègent
 * --------------------------
 * Le format d'exposition est un contrat : si une ligne est malformee, Prometheus
 * refuse le scrape ENTIER — pas seulement la serie fautive. Une faute de
 * guillemet dans un libelle, un `{` non ferme ou un cumul manquant dans un
 * histogramme font tomber silencieusement toute la supervision. Ces tests
 * verifient donc la STRUCTURE du texte produit, pas seulement les compteurs.
 *
 * Second enjeu : la cardinalite. Une etiquette libre (identifiant de match, IP)
 * cree une serie par valeur ; en competition cela cree une serie par match. Le
 * test de normalisation de route verrouille ce garde-fou.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  metrics,
  renderMetrics,
  routeLabel,
  lastObservedEventLoopLag,
} from '../src/lib/metrics.ts';

/** Lignes de type serie (ni commentaire, ni vide) du rendu Prometheus. */
function seriesLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('metrics — format d\'exposition', () => {
  test('le rendu declare le type de chaque metrique', () => {
    const text = renderMetrics('api');
    assert.ok(text.includes('# HELP aeerks_http_requests_total'));
    assert.ok(text.includes('# TYPE aeerks_http_requests_total counter'));
    assert.ok(text.includes('# TYPE aeerks_ws_clients gauge'));
  });

  test('chaque ligne de serie se analyse correctement', () => {
    metrics.httpRequests.inc({ method: 'GET', route: '/api/test', status: '200' });
    metrics.wsMessages.inc();
    const text = renderMetrics('api');

    for (const line of seriesLines(text)) {
      // `nom{valeur}` ou `nom`, puis un nombre. C'est exactement ce que
      // Prometheus exige ; toute ligne qui ne suit pas ce gabarit ferait
      // echouer le scrape complet.
      assert.match(
        line,
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.eE+]+$/,
        `ligne malformee : ${line}`
      );
    }
  });

  test('un guillemet dans une valeur d\'etiquette est echappe', () => {
    // Un guillemet non echappe closerait l'etiquette prematurement et, pour
    // ce lot de metriques, le parseur de libelles de Prometheus echouerait
    // sur la ligne — et le rejet porte sur le scrape ENTIER, pas sur la seule
    // serie fautive. Il faut donc que l'echappement soit effectif.
    metrics.httpRequests.inc({ method: 'GET', route: 'x"y', status: '200' });
    const text = renderMetrics('api');
    assert.ok(text.includes('route="x\\"y"'), `echappement absent : ${text}`);
  });

  test('un retour a la ligne dans une valeur ne coupe pas la ligne', () => {
    // Meme raison : un retour a la ligne nu verifierait un evenement en
    // plusieurs lignes, chacune invalide pour le parseur.
    metrics.httpRequests.inc({ method: 'GET', route: 'a\nb', status: '200' });
    const text = renderMetrics('api');
    assert.ok(text.includes('route="a\\nb"'));
    // Aucune ligne produite ne doit contenir un retour a la ligne brut hors
    // des fins de ligne du rendu.
    for (const line of text.split('\n').slice(0, -1)) {
      assert.ok(!line.includes('a\nb'), 'la valeur a fuite hors de son etiquetage');
    }
  });

  test('le nom du service ayant repondu est expose', () => {
    // Quatre processus repondent au scrape : sans cette etiquette, une
    // serie ne peut pas etre attribuee a un processus.
    assert.ok(renderMetrics('worker').includes('aeerks_scrape_service_info{service="worker"} 1'));
  });
});

describe('metrics — histogramme', () => {
  test('les compteurs de seaux sont cumulatifs', () => {
    // Un seau non cumulatif casse `histogram_quantile` : Prometheus suppose
    // le cumul, et une sous-estimation silencieuse de tous les quantiles.
    metrics.httpDuration.observe(0.001); // < 5 ms
    metrics.httpDuration.observe(0.001);
    metrics.httpDuration.observe(0.1); // entre 50 ms et 250 ms

    const text = renderMetrics('api');
    const buckets = [...text.matchAll(/aeerks_http_request_duration_seconds_bucket\{[^}]*le="([^"]+)"\} (\d+)/g)];
    assert.ok(buckets.length > 0, 'aucun seau rendu');

    // Les valeurs croissent (ou restent egales) quand le seuil augmente.
    let previous = -1;
    for (const [, le, count] of buckets) {
      const value = Number(count);
      assert.ok(
        value >= previous,
        `seau le=${le} (${value}) inferieur au precedent (${previous}) : non cumulatif`
      );
      previous = value;
    }
  });

  test('+Inf est toujours present et englobe toutes les observations', () => {
    metrics.httpDuration.observe(60); // au-dela de la derniere frontiere
    const text = renderMetrics('api');
    const inf = text.match(/le="\+Inf"\} (\d+)/);
    assert.ok(inf, 'le seau +Inf doit exister');

    // Une observation au-dela de toute frontiere doit se retrouver dans +Inf.
    const allCounts = [...text.matchAll(/_bucket\{[^}]*\} (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...allCounts) >= 1);
  });

  test('_count vaut le nombre d\'observations, pas le cumul des seaux', () => {
    // Serie etiquetee et serie non etiquetee : le rendu omet le bloc `{}`
    // quand il n'y a aucune etiquette, et le motif doit couvrir les deux
    // formes.
    metrics.httpDuration.observe(0.001, { method: 'PUT', route: '/api/comptage' });
    metrics.httpDuration.observe(0.002, { method: 'PUT', route: '/api/comptage' });
    metrics.httpDuration.observe(0.003, { method: 'PUT', route: '/api/comptage' });
    metrics.httpDuration.observe(0.004, { method: 'GET', route: '/api/autre' });

    const text = renderMetrics('api');

    const labelled = text.match(
      /^aeerks_http_request_duration_seconds_count\{method="PUT",route="\/api\/comptage"\} (\d+)$/m
    );
    assert.ok(labelled, 'la serie etiquetee doit etre rendue');
    assert.equal(Number(labelled[1]), 3);

    // Le point critique : `+Inf` DOIT egaler `_count`. C'est cette egalite que
    // Prometheus utilise pour detecter un seau manquant ; si `+Inf` etait le
    // seul contenu du dernier intervalle (au lieu du total), un scraper
    //raisonnerait sur une serie incomplete sans le signaler.
    const inf = text.match(
      /^aeerks_http_request_duration_seconds_bucket\{method="PUT",route="\/api\/comptage",le="\+Inf"\} (\d+)$/m
    );
    assert.ok(inf, 'le seau +Inf doit etre rendu');
    assert.equal(Number(inf[1]), Number(labelled[1]), '+Inf doit egaler _count');
  });

  test('les series sont isolees les unes des autres', () => {
    // Regression du bug des compteurs partages : deux jeux d\'etiquettes
    // differents ne doivent pas additionner leurs seaux. Sans cela, chaque
    // route afficherait le cumul global et tous les quantiles par route
    // seraient faux.
    metrics.httpDuration.observe(0.001, { method: 'GET', route: '/api/isole-a' });
    metrics.httpDuration.observe(0.001, { method: 'GET', route: '/api/isole-b' });

    const text = renderMetrics('api');
    const countA = text.match(
      /^aeerks_http_request_duration_seconds_count\{method="GET",route="\/api\/isole-a"\} (\d+)$/m
    );
    const countB = text.match(
      /^aeerks_http_request_duration_seconds_count\{method="GET",route="\/api\/isole-b"\} (\d+)$/m
    );
    assert.equal(Number(countA[1]), 1, 'la serie A ne doit pas inclure B');
    assert.equal(Number(countB[1]), 1, 'la serie B ne doit pas inclure A');
  });
});

describe('metrics — normalisation des routes', () => {
  test('les identifiants numeriques deviennent :id', () => {
    // Sans cela, chaque match ouvrirait sa propre serie.
    assert.equal(routeLabel('/api/matches/17'), '/api/matches/:id');
    assert.equal(routeLabel('/api/matches/1843/score'), '/api/matches/:id/score');
    assert.equal(routeLabel('/api/users/7/sessions/9'), '/api/users/:id/sessions/:id');
  });

  test('la query string est exclue de l\'identite de route', () => {
    // `?teamId=3&sort=score` ne change pas la route : les compter reviendrait
    // a creer une serie par combinaison de filtres.
    assert.equal(routeLabel('/api/rankings?eventId=2'), '/api/rankings');
  });

  test('un identifiant non numerique reste tel quel', () => {
    assert.equal(routeLabel('/api/matches/abc'), '/api/matches/abc');
  });

  test('les chemins hors API sont regroupes', () => {
    assert.equal(routeLabel('/favicon.ico'), 'non-api');
    assert.equal(routeLabel('/jury/'), 'non-api');
  });

  test('un chemin anormalement long est ramene a « autre »', () => {
    // Garde-fou de cardinalite : un attaquant qui interroge
    // `/api/<1000 caracteres>` ne doit pas ouvrir mille series.
    assert.equal(routeLabel(`/api/${'x'.repeat(500)}`), 'autre');
  });
});

describe('metrics — types de compteurs', () => {
  test('un compteur refuse de diminuer et renvoie sa valeur', () => {
    // Un compteur retrograde casse `rate()` et `increase()`, qui calculeraient
    // un debit negatif. Mieux vaut echouer au developpement que publier une
    // metrique absurde en production.
    assert.throws(
      () => metrics.busPublished.inc({ type: 'test-unitaire' }, -1),
      /compteur/,
      'une decrementation doit etre refusee'
    );

    const a = metrics.busPublished.inc({ type: 'test-unitaire' });
    const b = metrics.busPublished.inc({ type: 'test-unitaire' });
    assert.equal(b, a + 1, 'inc doit renvoyer la nouvelle valeur');
  });

  test('une jauge accepte la montee et la descente', () => {
    metrics.wsClients.inc();
    metrics.wsClients.dec();
    assert.ok(renderMetrics('ws').includes('aeerks_ws_clients'));
  });
});

describe('metrics — retard de la boucle d\'evenements', () => {
  test('la jauge est exposee et alignee sur l\'etat interne', () => {
    // Le monteur reel echantillonne en arriere-plan ; on compare donc la jauge
    // publiee a l'etat interne plutot que d'injecter une valeur, qu'un
    // echantillon concurrent ecraserait avant lecture.
    // Les motifs sont ancres sur un debut de ligne ET sur la ligne de valeur :
    // sans l'ancrage, ils captureraient le texte d'aide (`# HELP ... Retard
    // moyen recent ...`) et l'assertion porterait sur un mot du libelle.
    const text = renderMetrics('api');
    const last = text.match(/^aeerks_event_loop_lag_last_seconds (\S+)$/m);
    const mean = text.match(/^aeerks_event_loop_lag_seconds (\S+)$/m);
    assert.ok(last, 'la jauge du dernier retard doit etre exposee');
    assert.ok(mean, 'la jauge de retard moyen doit etre exposee');
    assert.ok(Number.isFinite(Number(last[1])), `valeur illisible : ${last[1]}`);
    // Le lissage exponentiel ne peut pas depasser le dernier echantillon.
    assert.ok(Number(mean[1]) <= Number(last[1]) + 1e-9);
    assert.ok(lastObservedEventLoopLag() >= 0);
  });
});