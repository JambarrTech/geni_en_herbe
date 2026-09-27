/**
 * Initialisation Firebase — chargée à la demande.
 *
 * Avant, ce module était importé au sommet de AuthContext, donc
 * `initializeApp()` + tout le SDK `firebase/auth` (popup, persistance
 * IndexedDB/localStorage, chargeur gapi) étaient dans le chunk initial des
 * apps jury et admin. Or Firebase ne sert qu'à la connexion Google : les
 * comptes email/mot de passe n'en ont pas besoin.
 *
 * Le module est donc importé dynamiquement, au moment du clic sur
 * « Se connecter avec Google ». Il reste absent du chemin critique.
 */

// Configuration par variables d'environnement, avec repli sur le fichier de
// configuration versionné (qui reste une source non secrète : une apiKey web
// Firebase n'est pas une clé de service). L'indirection par env permet
// however de cibler un projet différent par environnement de déploiement.
// Les annotations de type `import('firebase/auth')` sont délibérées : le module
// est chargé dynamiquement, et ces types sont la seule façon de typer sa
// valeur de retour sans réintroduire un import statique (qui replacerait le SDK
// dans le chunk initial).
/* eslint-disable @typescript-eslint/consistent-type-imports */
import type { FirebaseOptions } from 'firebase/app';

interface FirebaseAppletConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}

let appletConfig: FirebaseAppletConfig | null = null;

async function loadAppletConfig(): Promise<FirebaseAppletConfig> {
  if (!appletConfig) {
    const url = new URL('../../firebase-applet-config.json', import.meta.url).href;
    appletConfig = (await import(/* @vite-ignore */ url)).default as FirebaseAppletConfig;
  }
  return appletConfig;
}

async function resolveConfig(): Promise<FirebaseOptions> {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const fromEnv: FirebaseAppletConfig = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };

  if (fromEnv.apiKey && fromEnv.projectId) return fromEnv as FirebaseOptions;
  return (await loadAppletConfig()) as FirebaseOptions;
}

let authPromise: Promise<import('firebase/auth').Auth> | null = null;

/**
 * Retourne l'instance Auth, en chargeant le SDK Firebase au premier appel.
 * Idempotent et concurrent-safe : plusieurs clics partagent le même import.
 */
export async function getFirebaseAuth(): Promise<import('firebase/auth').Auth> {
  if (!authPromise) {
    authPromise = (async () => {
      const { initializeApp, getApps } = await import('firebase/app');
      const { getAuth, GoogleAuthProvider } = await import('firebase/auth');
      const config = await resolveConfig();
      const app = getApps().length ? getApps()[0] : initializeApp(config);
      const auth = getAuth(app);
      (auth as unknown as { __googleProvider?: unknown }).__googleProvider =
        new GoogleAuthProvider();
      return auth;
    })().catch((err) => {
      // On remet l'état à null pour permettre un nouvel essai.
      authPromise = null;
      throw err;
    });
  }
  return authPromise;
}

export async function getGoogleAuthProvider() {
  const auth = await getFirebaseAuth();
  return (auth as unknown as { __googleProvider: import('firebase/auth').GoogleAuthProvider })
    .__googleProvider;
}
