import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint wasn't configured anywhere. That's the root cause of the defects this
 * linter now catches:
 *   - 13 unused imports surviving across the three apps
 *   - a `useEffect` depending on `[liveState]`, which refetched the full match
 *     detail on every single broadcast
 *   - `matchDetails` typed `any` on the scoring screen
 *   - two values of the `AdminTab` union with no matching render branch
 *   - a state variable written but never read (`loading`)
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'backend/drizzle/**',
      '**/vite.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        DOMException: 'readonly',
        AudioContext: 'readonly',
        WebSocket: 'readonly',
        NodeJS: 'readonly',
      },
    },
    rules: {
      // Hook rules : c'est exactement ce qui manquait.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Le code mort est une erreur, pas un avertissement.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // `catch (e) {}` sans usage est très fréquent et sans conséquence ici.
          caughtErrors: 'none',
        },
      ],

      // `any` sur les données métier est precisely ce qui a permis au panneau
      // de score jury de manipuler des matchs incohérents.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',

      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Le backend n'est pas du React : pas de règles de hooks.
  {
    files: ['backend/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  // Les fichiers de DÉCLARATIONS ne font qu'une chose : fusionner des
  // interfaces avec des interfaces existantes. Un corps vide y est donc la
  // forme normale et obligatoire — TypeScript exige que les paramètres de type
  // soient identiques des deux côtés de la fusion, d'où le paramètre `T` jamais
  // utilisé dans le corps.
  //
  // Les deux règles se déclenchent donc systématiquement et ne signalent
  // jamais un vrai défaut. Désactivation recommandée par la documentation de
  // `typescript-eslint` pour les `*.d.ts`.
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Les fichiers JSON ne sont pas du code JavaScript, et on ne les lint pas.
  //
  // HISTORIQUE
  // ---------
  // Un bloc `files: ['**/*.json']` existait ici, destiné à la configuration
  // Firebase. Deux défauts : (1) `disableTypeChecked` ne désactive que les
  // règles *typées* — les règles de base de JavaScript continuaient de
  // s'appliquer ; (2) il rendait les JSON éligibles au lint.
  //
  // Conséquence, restée invisible : le premier `npm run lint` qui passait un
  // répertoire contenant un `tsconfig.json` faisait remonter
  //   `Expected an assignment or function call ... no-unused-expressions`
  // sur la ligne 1 de CHAQUE tsconfig du dépôt. La règle lisait `{` comme une
  // expression JavaScript parasite.
  //
  // On ignore donc explicitement les JSON, plutôt que de compter sur le fait
  // qu'aucun bloc ne les réclame : c'est ce qui avait fait échouer.
  { ignores: ['**/*.json'] }
);
