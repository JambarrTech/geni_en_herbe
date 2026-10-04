/**
 * Annulation et rétablissement d'un résultat de match.
 *
 * POURQUOI CETTE ROUTE EXISTE
 * --------------------------
 * `DELETE /api/matches/:id` refuse (409) tout match ayant un historique de
 * score, parce que `score_events` est en ON DELETE CASCADE : supprimer le match
 * effacerait le journal d'audit. Refus légitime. Mais le message d'erreur
 * promettait « Annulez le match », et cette route n'existait pas — le comité
 * n'avait donc AUCUNE façon de retirer un résultat dont il s'aperçoit après
 * coup. Le message d'erreur seule mentait.
 *
 * CE QUE CES TESTS PROTÈGENT, ET CE QU'ILS NE PEUVENT PAS PROUVER
 * ---------------------------------------------------------------
 * Comme `suppressionRoutes.test.mjs`, ces assertions lisent des sources. Elles
 * ne font tourner ni Postgres ni le routeur : une annulation qui écrirait le
 * mauvais statut passerait si le statut écrit était le bon.
 *
 * Elles gardent en revanche trois propriétés qu'une régression rendrait
 * silencieuses, parce que chacune se paie en écran trompeur :
 *
 *  1. l'annulation ne peut rien effacer (sinon : « match » disparaît des
 *     résultats ET de l'audit, la version « il n'a jamais eu lieu » du mensonge) ;
 *  2. elle se diffuse, podium compris (sinon : le classement affiché en salle
 *     continue de compter un match retiré, jusqu'au prochain rechargement) ;
 *  3. ses effets sont réversibles par la route suivante (sinon : on a remplacé
 *     « impossible de retirer un résultat » par « une annulation de trop est
 *     définitive », ce qui est un piège plus grave que le problème initial).
 *
 * Le comportement de fond — `CANCELLED` hors classement et hors blocage de
 * publication — était déjà acquis avant ces routes ; les tests de la fin
 * documentent cette dépendance pour que la suppression d'un de ces filtres
 * soit visible ici.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FLOW } from '../src/config.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Le corps du gestionnaire, commentaires retirés.
 *
 * Ils expliquent pourquoi le code est écrit ainsi ; ils ne l'exécutent pas. Les
 * garder rendrait les assertions fausses dans les deux sens : le test « le score
 * survit » échouerait parce qu'un commentaire MENTIONNE `endedAt` pour dire
 * qu'on le laisse en place.
 *
 * Le garde `[^:]` évite de couper une URL — `https://…` n'est pas un début de
 * commentaire.
 */
function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Corps du gestionnaire d'une route, du routeur jusqu'à sa fermeture. */
function sourceRoute(fichier, methode, chemin) {
  const source = readFileSync(join(SRC, 'routes', fichier), 'utf8');
  const debut = source.indexOf(`${methode}('${chemin}'`);
  assert.ok(debut !== -1, `${fichier} : aucune route ${methode} ${chemin}`);
  const fin = source.indexOf('\n});', debut);
  return sansCommentaires(source.slice(debut, fin === -1 ? undefined : fin));
}

/**
 * Les champs que la route écrit réellement, par nom.
 *
 * C'est le seul endroit où une donnée peut disparaître : lire, valider et
 * diffuser ne changent rien à la ligne. Une assertion sur le corps entier ne le
 * prouverait pas, et c'est pourtant tout l'enjeu de l'annulation.
 *
 * La comparaison se fait sur les NOMS et dans l'ordre, jamais sur le texte du
 * `set` : reformater une indentation ne doit pas casser le test, et ajouter une
 * colonne doit le casser.
 */
function champsEcrits(corps) {
  const debut = corps.indexOf('.set({');
  assert.ok(debut !== -1, "la route n'écrit rien du tout");
  const fin = corps.indexOf('})', debut);
  return [...corps.slice(debut, fin === -1 ? undefined : fin).matchAll(/^\s*(\w+):/gm)].map(
    (m) => m[1]
  );
}

const ANNULER = () => sourceRoute('matches.routes.ts', 'post', '/:id/cancel');
const RETABLIR = () => sourceRoute('matches.routes.ts', 'post', '/:id/restore');

describe('annulation — un acte administratif, pas une lecture', () => {
  test('ni le jury ni un anonyme ne peuvent annuler un résultat', () => {
    for (const [nom, corps] of [
      ['annulation', ANNULER()],
      ['rétablissement', RETABLIR()],
    ]) {
      // Un résultat Decide du podium. Le jury rend les résultats d'un match en
      // cours ; il ne décide pas qu'un match joué n'a pas compté. `requireAdmin`
      // avant toute écriture, donc avant même la lecture.
      assert.ok(corps.includes('requireAuth'), `${nom} : accessible sans session`);
      assert.ok(corps.includes('requireAdmin'), `${nom} : accessible au jury`);
    }
  });

  test('un identifiant inconnu ne s\'annonce pas comme une annulation', () => {
    for (const [nom, corps] of [
      ['annulation', ANNULER()],
      ['rétablissement', RETABLIR()],
    ]) {
      // Sans lecture préalable, la route répond 200 et l'administrateur croit
      // avoir retiré un match qui, lui, est toujours au classement.
      assert.ok(/status\(404\)/.test(corps), `${nom} : pas de 404 sur un identifiant inconnu`);
    }
  });

  test('seul un match terminé s\'annule', () => {
    // Le refus n'est pas une précaution de style : il empêche d'annuler un match
    // en cours, dont le score bouge encore et dont l'état public est en train
    // d'être diffusé. « Terminer » puis « annuler » laisse deux écritures
    // successives dans le journal ; c'est ce qui rend l'acte traçable.
    assert.ok(
      ANNULER().includes('match.status !== FLOW.MATCH_STATUS.FINISHED'),
      "l'annulation ne refuse pas un match qui n'est pas terminé"
    );
  });

  test('un match déjà annulé ne se ré-annule pas', () => {
    // Sans cette garde, un second appel réécrit `updatedAt` et reproduit une
    // entrée d'audit : le journal dirait deux annulations pour un seul geste.
    assert.ok(ANNULER().includes('FLOW.MATCH_STATUS.CANCELLED'), "l'état déjà annulé n'est pas écarté");
    assert.ok(
      RETABLIR().includes('match.status !== FLOW.MATCH_STATUS.CANCELLED'),
      "le rétablissement s'applique à un match qui n'est pas annulé"
    );
  });
});

describe('annulation — ce qui est conservé, ce qui disparaît', () => {
  test('le score et la fin du match survivent à l\'annulation', () => {
    const ecrit = champsEcrits(ANNULER());

    // Le point de conception, et le seul endroit où il peut se défaire. Une
    // annulation qui remettait les scores à zéro, ou qui effaçait `endedAt`,
    // dirait « ce match n'a jamais eu lieu ». C'est faux : il a été joué, il est
    // archivé, il ne compte pas. C'est ce qui la distingue d'une suppression,
    // et la seule raison pour laquelle le comité peut l'employer sans craindre
    // une perte sèche.
    assert.deepEqual(
      ecrit,
      ['status', 'updatedAt'],
      'l\'annulation écrit des colonnes inattendues : un statut et une date, rien d\'autre'
    );

    // L'audit le dit explicitement, en citant les deux valeurs conservées.
    assert.match(ANNULER(), /score conservé/, "le journal d'audit ne mentionne pas la conservation");
  });

  test('l\'annulation écrit bien le statut que tout le reste du code attend', () => {
    // `CANCELLED` n'est pas un mot gratuit : `calculateRankings` ne compte que
    // les `FINISHED`, la publication écarte `FINISHED` ET `CANCELLED`, et
    // `getLiveState` n'expose ni l'un ni l'autre comme terminé. Écrire un autre
    // statut, ou une chaîne libre, ferait rester le match au classement en
    // affichant « Annulé » dans l'administration.
    assert.ok(ANNULER().includes('status: FLOW.MATCH_STATUS.CANCELLED'));
    assert.ok(RETABLIR().includes('status: FLOW.MATCH_STATUS.FINISHED'));
    assert.equal(FLOW.MATCH_STATUS.CANCELLED, 'CANCELLED');
    assert.equal(FLOW.MATCH_STATUS.FINISHED, 'FINISHED');
  });

  test('le rétablissement ne remet que le statut', () => {
    // Symétrique du point précédent : un rétablissement qui réécrivait le score
    // ferait réapparaître au classement un résultat différent de celui qui a été
    // joué. Il n'y a rien d'autre à rétablir : rien n'avait bougé ailleurs.
    assert.deepEqual(
      champsEcrits(RETABLIR()),
      ['status', 'updatedAt'],
      'le rétablissement écrit des colonnes inattendues'
    );
  });

  test('les deux gestes sont journalisés', () => {
    for (const [nom, corps] of [
      ['annulation', ANNULER()],
      ['rétablissement', RETABLIR()],
    ]) {
      assert.ok(corps.includes('logAudit'), `${nom} : geste non journalisé`);
    }
    // Un journal d'audit où figure une décision de podium sans trace : c'est le
    // contrôleFormats disciplinaire.
    assert.ok(ANNULER().includes('CANCEL_MATCH'));
    assert.ok(RETABLIR().includes('RESTORE_MATCH'));
  });
});

describe('annulation — le podium projeté dans la salle', () => {
  test('les deux gestes diffusent le nouvel état', () => {
    for (const [nom, corps, evenement] of [
      ['annulation', ANNULER(), 'match_cancelled'],
      ['rétablissement', RETABLIR(), 'match_restored'],
    ]) {
      assert.ok(corps.includes(`broadcast('${evenement}'`), `${nom} : rien n'est diffusé`);
      assert.ok(corps.includes('getLiveState'), `${nom} : l'état diffusé est inventé, pas relu`);
    }
  });

  test('le classement accompagne l\'état diffusé', () => {
    // C'est LA raison d'être de l'annulation : un podium projeté qui garde le
    // match retiré est pire que l'absence de mise à jour, parce qu'il paraît
    // frais. Sans `true`, `getLiveState` renvoie `rankings: []` et le podium
    // vidé sur les écrans de la salle jusqu'au rechargement.
    for (const [nom, corps] of [
      ['annulation', ANNULER()],
      ['rétablissement', RETABLIR()],
    ]) {
      assert.ok(
        /getLiveState\([^)]*,\s*true\)/.test(corps),
        `${nom} : classement omis, le podium affiché resterait faux`
      );
    }
  });

  test('une panne de diffusion ne se déguise pas en échec d\'annulation', () => {
    // À cet instant de la route, l'écriture est FAITE. Renvoyer une erreur
    // ferait croire à un échec alors que le match est bien retiré — et la
    // relance enverrait un 400 sur un match déjà annulé, ce qui achèverait de
    // perdre l'administrateur. Même règle que sur les suppressions.
    for (const [nom, corps] of [
      ['annulation', ANNULER()],
      ['rétablissement', RETABLIR()],
    ]) {
      const diffusion = corps.indexOf('broadcast(');
      assert.ok(diffusion !== -1, `${nom} : aucune diffusion`);
      const tryInterne = corps.lastIndexOf('try {', diffusion);
      assert.ok(
        tryInterne !== -1 && tryInterne > corps.indexOf('.update('),
        `${nom} : la diffusion est dans le try principal`
      );
    }
  });

});

/*
 * CE QUI N'EST PAS TESTÉ ICI, ET OÙ
 * --------------------------------
 * Que `LiveContext` prenne en charge `match_cancelled` et `match_restored` — et
 * que le podium affiché suive réellement la fusion — n'est pas vérifié ici, et
 * l'y vérifier par lecture de source aurait été une erreur.
 *
 * Premier essai de ce fichier : une assertion sur la présence des deux noms dans
 * la liste de types de `LiveContext`. Elle affirmait que le client se
 * « rafraîchissait » sur ces événements. C'est FAUX : un message qui porte
 * `liveState` est fusionné, il ne déclenche aucune relecture de `/api/live`.
 * L'assertion était donc fausse quand elle passait, et n'aurait rien vu passer
 * quand le podium restait faux.
 *
 * Elle est remplacée par un test qui monte le composant et observe le podium :
 * `tests/context/LiveContext.diffusion.test.tsx`. Un test backend qui lit du
 * source frontend était de toute façon à la mauvaise place.
 */

describe('annulation — les dépendances déjà en place', () => {
  // Ces trois filtres existaient avant les routes d'annulation. Ils sont la
  // raison pour laquelle `CANCELLED` est un statut cohérent plutôt qu'un mot de
  // plus ; les retirer casserait la fonctionnalité sans qu'aucune des routes
  // ci-dessus ne soit modifiée.

  test('un match annulé ne compte pas au classement', () => {
    const source = readFileSync(join(SRC, 'server', 'matchEngine.ts'), 'utf8');
    assert.match(
      source,
      /if \(m\.status !== FLOW\.MATCH_STATUS\.FINISHED\) continue;/,
      'le classement ne filtre plus sur FINISHED : un match annulé remonterait au podium'
    );
  });

  test('un match annulé ne bloque pas la publication', () => {
    const source = readFileSync(join(SRC, 'routes', 'events.routes.ts'), 'utf8');
    assert.ok(
      source.includes('not(eq(matches.status, FLOW.MATCH_STATUS.CANCELLED))'),
      "la publication ne pardonne plus les matchs annulés : impossible de clôturer un événement"
    );
  });

  test('un match annulé ne figure ni parmi les matchs à venir ni parmi les résultats', () => {
    // Conséquence à assumer : l'annulation efface le match des écrans public et
    // jury. C'est le but — un résultat retiré ne doit pas rester affiché — mais
    // c'est aussi pourquoi l'annulation est réversible et non une suppression :
    // seule l'administration garde la trace.
    const source = readFileSync(join(SRC, 'server', 'matchEngine.ts'), 'utf8');
    assert.match(
      source,
      /const completedRaw = allMatches\.filter\(\(m\) => m\.status === FLOW\.MATCH_STATUS\.FINISHED\)/,
      'les matchs terminés ne sont plus filtrés : un match annulé resterait affiché au public'
    );
    // Les résultats clôturés restent masqués tant que le jury ne les diffuse
    // pas : le filtre seul ne suffit plus, le masquage suit la même règle que
    // le match en cours (sinon `/api/live` exposerait les totaux définitifs
    // dès la clôture, bouton « Diffuser le résultat » contourné).
    assert.match(
      source,
      /winnerTeamId: hidden \? null : winnerTeamId\(m\)/,
      'les matchs clôturés affichent le vainqueur sans diffusion : la fin de match redevient automatique'
    );
  });
});
