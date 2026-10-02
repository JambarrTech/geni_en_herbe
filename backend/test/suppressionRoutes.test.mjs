/**
 * Suppression des ressources : ce que les routes promettent.
 *
 * POURQUOI CES TESTS LIRENT DES FICHIERS PLUTÔT QUE D'APPELER LES ROUTES
 * --------------------------------------------------------------------
 * Une suppression se valide sur ce que fait Postgres quand une clé étrangère
 * résiste, et il n'y a pas de base dans la suite. Une liste d'attente sur une
 * table réelle n'est pas plus vérifiable ici.
 *
 * Ce que ces tests font, alors, c'est garanter la PROMESSE formulée à
 * l'administrateur : que chaque route distinguishera un refus de clé étrangère
 * d'une panne. Le test précédent l'a Ignore : une question déjà jouée renvoyait
 * 500 « Erreur lors de la suppression », indiscernable d'un incident. Le message
 * existait, `FK_DELETE_MESSAGES.question`, écrit et testé — jamais importé.
 *
 * Une assertion qui ne lit que du code source ne prouve rien du comportement.
 * Elle CANNE ce qui s'est produit une fois : l'oubli d'un import, la route
 * revenue à un `catch` générique. C'est peu, et c'est mieux que rien.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');

/** Source du gestionnaire `DELETE /:id` d'un routeur. */
function sourceSuppression(fichier) {
  const source = readFileSync(join(RACINE, fichier), 'utf8');
  const debut = source.indexOf('Router.delete(\'/:id\'');
  assert.ok(debut !== -1, `${fichier} : aucune route DELETE /:id`);

  const fin = source.indexOf('\n});', debut);
  return source.slice(debut, fin === -1 ? undefined : fin);
}

/**
 * Les routes de suppression.
 *
 * `bloqueFk` : la route classe-t-elle une violation de clé étrangère ? C'est ce
 * qui distingue un refus utile d'un 500. Les cinq énumérées ici exigent `true`.
 */
const ROUTES = [
  { fichier: 'teams.routes.ts', entite: 'team' },
  { fichier: 'participants.routes.ts', entite: 'participant' },
  { fichier: 'categories.routes.ts', entite: 'category' },
  { fichier: 'events.routes.ts', entite: 'event' },
  { fichier: 'questions.routes.ts', entite: 'question' },
];

test('toute suppression distingue un refus de clé étrangère d\'une panne', () => {
  for (const { fichier, entite } of ROUTES) {
    const corps = sourceSuppression(fichier);

    assert.ok(
      corps.includes('isForeignKeyViolation(error)'),
      `${fichier} : une violation de clé étrangère ne serait pas reconnue, ` +
        `donc « ${entite} » encore utilisé renverrait 500 au lieu d'un message utile`
    );
    assert.ok(
      corps.includes(`FK_DELETE_MESSAGES.${entite}`),
      `${fichier} : le message de « ${entite} » n'est pas utilisé`
    );
    assert.ok(
      corps.includes('log.error'),
      `${fichier} : l'échec n'est pas journalisé, donc invisible en production`
    );
  }
});

test('supprimer une ressource inexistante ne s\'annonce pas comme un succès', () => {
  // Sans lecture préalable, `DELETE` sur un identifiant inconnu renvoyait
  // `{ success: true }`. L'interface affichait alors « équipe supprimée » pour
  // une équipe qui n'avait jamais existé — et un 200 encourage le client à ne
  // pas réessayer.
  //
  // Les six routes sont concernées, y compris celles sans écran de gestion
  // aujourd'hui : le jour où la catégorie ou l'événement gagne son onglet, le
  // défaut serait déjà là.
  for (const { fichier } of [...ROUTES, { fichier: 'events.routes.ts' }]) {
    const corps = sourceSuppression(fichier);
    assert.ok(
      /status\(404\)/.test(corps),
      `${fichier} : pas de 404 sur un identifiant inconnu`
    );
  }
});

test('la suppression d\'une équipe diffuse le nouvel état au public', () => {
  // Le classement est construit depuis la table `teams` : une équipe sans match
  // y figure à zéro point. Supprimer une équipe la retire donc du podium, et le
  // podium est projeté dans la salle. Sans diffusion, le fantôme tiendrait
  // jusqu'au rechargement — que personne ne fait pendant un tournoi.
  const corps = sourceSuppression('teams.routes.ts');
  assert.ok(corps.includes('broadcast('), "l'état n'est pas diffusé");
  assert.ok(
    corps.includes('team_deleted'),
    "l'événement attendu par LiveContext n'est pas émis"
  );
  assert.ok(
    corps.includes('getLiveState'),
    'le nouvel état ne vient pas du serveur, il est inventé'
  );
});

test('l\'état est demandé avec le classement, sans quoi le podium reste faux', () => {
  const corps = sourceSuppression('teams.routes.ts');
  assert.ok(
    /getLiveState\([^)]*,\s*true\)/.test(corps),
    'classement omis : le podium affiché garderait une équipe supprimée'
  );
});

test('un échec de diffusion ne se déguise pas en échec de suppression', () => {
  // À cet instant de la route, la ligne est DÉJÀ supprimée. Renvoyer une erreur
  // ferait croire à l'administrateur que l'opération a échoué alors qu'elle a
  // réussi — et sa relance obtiendrait un 404 sur une ressource déjà effacée.
  for (const { fichier } of [
    { fichier: 'teams.routes.ts' },
    { fichier: 'matches.routes.ts' },
  ]) {
    const corps = sourceSuppression(fichier);
    const diffusion = corps.indexOf('broadcast(');
    assert.ok(diffusion !== -1, `${fichier} : aucune diffusion`);

    const tryInterne = corps.lastIndexOf('try {', diffusion);
    assert.ok(
      tryInterne !== -1 && tryInterne > corps.indexOf('db.delete'),
      `${fichier} : la diffusion est dans le try principal, donc une panne de ` +
        `diffusion se présente comme un échec de suppression`
    );
  }
});