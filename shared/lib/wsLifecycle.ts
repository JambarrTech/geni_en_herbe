/**
 * Politique de fermeture et de reconnexion du socket temps réel.
 *
 * Isolee et eprouvee dans ses tests, volontairement
 * --------------------------------------------------
 * Ces deux regles decident si un ecran survit a un incident. Ecrites au
 * milieu d'un `useEffect`, elles sont invisibles : on ne les relit pas, et le
 * pire moment pour decouvrir qu'une est fausse est le jour du tournoi.
 */
import { APP_CONFIG } from './config.ts';

/**
 * Un code de fermeture apres lequel il ne faut PAS recommencer.
 *
 * 1000 — fermeture normale : le serveur a decide, c'est fini.
 * 1008 — authentification refusee : le jeton ne sera pas plus valide au
 *        prochain essai. Reboucler toutes les 2 s pendant les heures de
 *        session n'inonderait que les journaux.
 *
 * 1011 n'en fait DELIBEREMENT PAS partie. Le serveur l'emploie quand la
 * VERIFICATION DU JETON A ECHOUE (cf. `backend/src/server/ws.ts`), c'est-a-dire
 * quand la base n'a pas repondu : la condition est transitoire.
 *
 * Ce qu'il en coutait de la traiter comme definitive : un simple incident de
 * base suffisait a condamner l'ecran jury jusqu'au rechargement manuel de la
 * page. Aucun message, aucun code HTTP, et le jury faisait face a une liste
 * figee pendant tout le reste de la session.
 *
 * Le jeton lui-meme n'est pas en cause : `verifySession` renvoie `null` — donc
 * 1008 — pour un jeton inconnu, echu ou revoque. Une valeur aberrante ne leve
 * jamais. 1011 dit donc bien « ressaye », pas « ton jeton est mauvais ».
 *
 * @param code le code de fermeture recu par le client.
 */
export function estFermetureDefinitive(code: number): boolean {
  return code === 1000 || code === APP_CONFIG.WS_CLOSE_INVALID_AUTH;
}

/**
 * Delai avant la tentative suivante : double, puis borne.
 *
 * @param precedent le delai utilise pour la tentative qui vient d'echouer.
 * @returns le delai a appliquer, en millisecondes.
 */
export function delaiDeReconnexion(precedent: number): number {
  return Math.min(precedent * 2, APP_CONFIG.WS_RECONNECT_MAX_DELAY_MS);
}