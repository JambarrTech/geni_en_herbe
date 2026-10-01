/**
 * Configuration Vitest â€” tests du front (recommandations 3 et 8).
 *
 * POURQUOI UN SEUL PROJET POUR LES TROIS APPS
 * ------------------------------------------
 * `shared/` est le code que les trois applications partagent, et c'est
 * prÃ©cisÃ©ment lÃ  que se situent les piÃ¨ges : `api.ts` porte la gestion du
 * jeton et des erreurs, `AuthContext` la dÃ©connexion, `Modal` le piÃ¨ge de
 * focus. Les tester trois fois â€” une fois par app â€” donnerait trois suites
 * quasi identiques pour un mÃªme fichier, et le signal de couverture serait
 * trompeur. Une suite unique teste le module une fois, depuis la perspective
 * de ce qu'il promet.
 *
 * `environment: jsdom` : le rendu de composants a besoin d'un DOM. Les trois
 * apps sont des SPA React â€” il n'y a pas de rendu serveur Ã  respecter.
 *
 * `globals: false` : les helpers sont importÃ©s explicitement (`import { test }
 * from 'vitest'`). C'est plus verbeux dans les fichiers, mais un test ne
 * peut alors pas utiliser une fonction qui n'est plus dans le pÃ©rimÃ¨tre, et
 * l'IDE ne peut pas suggÃ©rer un global inexistant. La contrepartie â€” les
 * types Vitest n'arrivent pas par la configuration `types` de TypeScript :
 * d'oÃ¹ `tests/tsconfig.json`, distinct des quatre projets applicatifs.
 *
 * ALIAS `@shared`
 * ---------------
 * Les applications importent le code partagÃ© via `@shared/...` (configurÃ© dans
 * les trois `vite.config.ts`). Vitest rÃ©sout les modules par sa propre
 * chaÃ®ne, pas par celle de l'app : sans cet alias, importer
 * `apps/jury/src/pages/JuryDashboard.tsx` Ã©chouerait dÃ¨s son premier import.
 * Les deux listes doivent rester alignÃ©es.
 *
 * ALIAS `@apps`
 * -------------
 * SymÃ©trique : les tests d'un dashboard ont besoin de ses composants Appeal,
 * qui vivent sous `apps/admin/src`. L'alias Ã©vite d'Ã©crire des chemins relatifs
 * Ã  six niveaux.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],

  resolve: {
    // L'ordre reprend celui des trois vite.config.ts : sans l'extension, Vite
    // ne tenterait pas `.tsx` pour un import sans suffixe.
    extensions: ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json'],
    alias: {
      '@shared': fileURLToPath(new URL('./shared/', import.meta.url)),
      '@apps': fileURLToPath(new URL('./apps/', import.meta.url)),
    },
  },

  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],

    // `threads` et non `forks` (le dÃ©faut) : sur cette machine Windows, le
    // dÃ©marrage du worker `forks` dÃ©passe le dÃ©lai d'attente de la sonde
    // interne de Vitest et le fichier est signalÃ© Â« jamais exÃ©cutÃ© Â» alors
    // qu'aucun code n'a Ã©tÃ© chargÃ©. Les threads partagent l'environnement de
    // globals, ce qui convient ici : chaque fichier de test a son propre
    // environnement jsdom, et le seul Ã©tat rÃ©ellement partagÃ© (localStorage)
    // est vidÃ© explicitement dans `tests/setup.ts`.
    pool: 'threads',

    // Un test qui fuit d'un Ã©tat global vers le suivant produit un Ã©chec
    // dÃ©pendant de l'ordre d'exÃ©cution â€” le pire genre de flaque, car il
    // passe en local et casse en CI selon la parallÃ©lisation.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubglobals: false,

    // jsdom ne sait pas faire de mise en page. `pretendToBeVisual` active
    // `requestAnimationFrame`, indispensable aux animations CSS de l'Ã©cran
    // live ; et surtout le fichier de mise en place dÃ©clare explicitement que
    // rien n'est mesurÃ©, plutÃ´t que de laisser chaque test le dÃ©couvrir.
    environmentOptions: {
      jsdom: { pretendToBeVisual: true },
    },
  },

  // Silence du bundle de test sur la sortie standard : un `console.log`
  // oubliÃ© dans un composant ne doit pas noyer le rapport de la suite.
  logLevel: 'warn',
});


