# ADR-0003 : Tests du front — un projet Vitest unique pour les trois applications

## Statut
Accepté

## Contexte
Les trois applications (`live`, `jury`, `admin`) partagent du code dans `shared/`. Ce code partagé porte les points sensibles :
- `shared/lib/api.ts` : jeton d'authentification, chemins publics, normalisation des erreurs, signalement global du 401 ;
- `shared/context/AuthContext.tsx` : connexion / déconnexion ;
- `shared/components/Modal.tsx` : piège de focus, rôle ARIA, fermeture par Échap ;
- `shared/pages/LoginPage.tsx` : formulaire d'authentification.

Il n'y avait AUCUN test de front. Le risque n'est pas seulement la non-régression : c'est aussi que des garanties annoncées dans les commentaires (« focus piégé », « aria-modal », « jeton non envoyé sur une route publique ») n'étaient pas vérifiées. Une garantie d'accessibilité non testée est une garantie qu'on ne peut pas défendre.

## Décision
1. **Un seul projet Vitest** à la racine (`vitest.config.mjs`), avec `environment: 'jsdom'`, `globals: false`, plugin React, alias `@shared` et `@apps`.
   - Un seul projet (et non trois) : `shared/` est testé une fois, depuis la perspective de ce qu'il promet. Le tester trois fois donnerait trois suites quasi identiques pour un même fichier et un taux de couverture trompeur.
2. **Dossier `tests/` dédié à la racine**, avec son propre `tsconfig.json`. Raisons :
   - les tests n'entrent ni dans le bundle des apps, ni dans l'audit CSS (`scripts/verify-build-output.mjs` parcourt `apps/*/src` et `shared/`) ;
   - les applications n'ont pas à connaître les types Vitest.
3. **Assertions explicites** : `test`, `expect`, etc. importés de `vitest` (pas de globals). Un test ne peut pas utiliser une fonction hors périmètre, et l'IDE ne suggère pas de global inexistant.
4. **Matchers étendus explicitement** dans `tests/setup.ts` : `@testing-library/jest-dom/vitest` et `vitest-axe` (via `expect.extend`). Deux détails appris à l'usage :
   - `vitest-axe/extend-expect` cible un `expect` global (absent ici) — on enregistre donc nous-mêmes sur l'instance importée ;
   - dans Vitest 5, il faut passer l'espace de noms ENTIER (`expect.extend(matchers)`), pas un objet à une clé, sinon la propriété n'est pas créée et l'erreur « Invalid Chai property » pointe à tort vers un problème de version.
   - `tests/vitest-axe.d.ts` déclare les types des matchers (la fusion de namespaces Jest/Vitest n'est pas faite par la lib).
5. **Doublures d'environnement explicites** (`tests/setup.ts`) : `localStorage` vidé entre les tests, `matchMedia` déclaré explicitement, `WebSocket` doublé (`tests/helpers/fakeWebSocket.ts`, ne simule PAS le protocole — laisse le test décider quoi répondre), `AudioContext` muet.
6. **`pool: 'threads'`** : sur cette machine Windows, le démarrage du worker `forks` (défaut) dépasse le délai de la sonde interne et le fichier est signalé « jamais exécuté » sans qu'aucun code n'ait été chargé.
7. **Couverture** : `tests/components/Modal.test.tsx` (comportement + a11y axe), `tests/pages/LoginPage.test.tsx` (libellés, role=alert, aria-describedby, permutation mot de passe), `tests/lib/api.test.ts` (injection jeton sur route privée, PAS sur route publique, chemins publics, 401, 204, annulation, classification d'erreurs).

## Défauts réels découverts et corrigés pendant cette mise en place
- **Piège de focus du `Modal` inopérant hors navigateur** : le filtre de visibilité des éléments focusables utilisait `offsetParent !== null`, qui vaut TOUJOURS `null` sans mise en page réelle (jsdom). La garantie d'accessibilité qui est le motif d'être du composant n'était donc vérifiable nulle part. Le filtre repose désormais sur `hidden` / `aria-hidden` (sémantique standard, valide partout). Ajout de `focusInside()` : si `focus()` échoue (élément masqué), on retombe sur le panneau — sinon le focus part sur `body`, HORS de la modale.
- **Config ESLint : chaque `tsconfig.json` du dépôt produisait une erreur de lint** (`no-unused-expressions` sur la ligne 1), invisible jusqu'ici car `npm run lint` ne passait que des répertoires de sources. Le bloc `files: ['**/*.json']` rendait les JSON éligibles au lint tout en leur laissant les règles JavaScript. Corrigé : JSON ignorés explicitement, `*.d.ts` exempts des règles inapplicables à la fusion de déclarations.
- **`npm run typecheck` couvre maintenant `tests/`** (5 projets) ; `npm test` enchaîne backend (`node --test`) puis front (`vitest run`).

## Conséquences
- 25 tests de front + 88 tests de back = 113 tests. Le `lint` inclut `tests`.
- Une régression sur une garantie d'accessibilité ou sur la gestion du jeton échoue désormais en CI.
- Le coût est un dossier de tests racine, une config Vitest, et lattention à garder les doublures d'environnement synchronisées.

## Références
- `vitest.config.mjs`, `tests/setup.ts`, `tests/vitest-axe.d.ts`, `tests/helpers/fakeWebSocket.ts`
- `shared/components/Modal.tsx` (`focusInside`)
- `package.json` (scripts `test`, `test:back`, `test:front`), `scripts/typecheck.mjs`
