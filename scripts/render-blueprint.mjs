/**
 * Audit du blueprint Render — logique pure, sans E/S.
 *
 * POURQUOI SÉPARER DU SCRIPT
 * --------------------------
 * `check-render-blueprint.mjs` se contente d'imprimer ; ce fichier décide.
 * La raison est celle du contrôle de cohérence de `vercel-backend.mjs` : une
 * branche qui n'est jamais exécutée ne protège de rien, et rien ne le signale.
 * Ce qui est ici teste automatiquement, ce qui est dans le script ne l'est pas.
 *
 * `doc` est l'objet déjà analysé par le parseur YAML : la fonction ne lit aucun
 * fichier, ce qui la rend testable sans Render et sans dépôt sur disque.
 *
 * @typedef {{ level: 'ok' | 'info' | 'warn' | 'ko', text: string }} Finding
 */

/** Niveau d'un constat, du plus grave au plus anodin. */
const OK = 'ok';
const INFO = 'info';
const WARN = 'warn';
const KO = 'ko';

/**
 * `buildCommand` compile-t-il le frontend ?
 *
 * Le motif cherche `vite` et le mot `build`, mais pas `buildCommand` lui-même
 * ni `npm ci` : c'est la seule façon de distinguer « installer » de « compiler ».
 * Une erreur ici a deux conséquences symétriques, l'une aussi muette que
 * l'autre — compiler pour rien, ou ne plus compiler en croyant encore servir.
 */
export function compileLeFrontend(buildCommand) {
  return /\bbuild\b|vite/i.test(buildCommand ?? '');
}

/**
 * Le service sert-il les interfaces, et est-ce cohérent avec son build ?
 *
 * Répond à la seule question qui compte pour Render : ce processus sert-il des
 * fichiers d'écran, oui ou non ? La réponse doit découler de la configuration
 * (`STATIC_SERVE_APPS`), jamais d'un artefact de build laissé sur le disque.
 */
export function auditRoleService({ buildCommand, serveApps }) {
  if (serveApps === 'false') {
    return compileLeFrontend(buildCommand)
      ? {
          level: WARN,
          text:
            "buildCommand compile encore le frontend alors que le service ne le sert " +
            "pas (STATIC_SERVE_APPS=false). Attendu : `npm ci` seul — les écrans sont " +
            "sur le CDN. Une minute et ~200 Mo par déploiement pour rien.",
        }
      : { level: OK, text: "Service en relais seul (/api, /ws, sonde), sans build frontend — cohérent." };
  }

  if (serveApps === 'true') {
    return compileLeFrontend(buildCommand)
      ? { level: OK, text: 'Service : interfaces + relais, et le build les produit — cohérent.' }
      : {
          level: KO,
          text:
            'INCOHÉRENT : STATIC_SERVE_APPS=true exige les trois interfaces, mais ' +
            'buildCommand n’en compile aucune. Le processus refusera de démarrer ' +
            '(build partiel détecté au boot).',
        };
  }

  return {
    level: WARN,
    text:
      'STATIC_SERVE_APPS absent : le mode sera DÉDUIT de la présence de apps/*/dist. ' +
      'Fonctionnel, mais l’intention reste implicite — un dist/ résiduel (build ' +
      'manuel, cache) ferait servir un écran par ce service alors qu’il est sur le CDN.',
  };
}

/**
 * `WS_ALLOWED_ORIGINS` décide si le WebSocket du jury sera accepté.
 *
 * C'est le piège du déploiement à deux origines : le navigateur envoie alors
 * l'origine Vercel, absente de la liste, et la connexion est refusée en code
 * 1008. Le jury voit un chrono qui ne descend pas, sans le moindre message.
 *
 * Chaque cas rend UN constat, pas deux : le tri par gravité réorganise la
 * liste, et un avertissement détaché de son sujet s'affiche avant la ligne qui
 * dit de quoi il parle.
 */
export function auditOriginsWs(envVars) {
  const ws = (envVars ?? []).find((e) => e.key === 'WS_ALLOWED_ORIGINS');

  if (!ws) {
    return {
      level: KO,
      text:
        'WS_ALLOWED_ORIGINS : ABSENT de envVars. Rien ne décidera de l’origine ' +
        'autorisée et le WebSocket sera refusé par défaut.',
    };
  }

  if (ws.sync === false) {
    return {
      level: WARN,
      text:
        'WS_ALLOWED_ORIGINS : à définir dans le dashboard Render.\n' +
        "  Valeur attendue : l'origine Vercel, ex. https://aeerks.vercel.app\n" +
        '  VIDE = même origine uniquement. Sur un déploiement à deux origines,\n' +
        "  une valeur vide REFUSE le WebSocket de l'interface Vercel (code 1008),\n" +
        '  et le chrono du jury reste figé sans message d’erreur.',
    };
  }

  if (ws.value === '') {
    return {
      level: WARN,
      text:
        'WS_ALLOWED_ORIGINS : vide (même origine uniquement).\n' +
        "  ATTENTION si l'interface est sur Vercel : l'origine Vercel ne sera pas\n" +
        '  autorisée et la connexion sera refusée en code 1008.',
    };
  }

  return { level: OK, text: `WS_ALLOWED_ORIGINS : ${ws.value}` };
}

/**
 * Audit complet d'un blueprint déjà analysé.
 *
 * @param {any} doc objet renvoyé par le parseur YAML
 * @returns {{ service: any, findings: Finding[] }}
 */
export function auditBlueprint(doc) {
  const findings = [];
  const service = doc?.services?.[0];

  if (!service) {
    return {
      service: null,
      findings: [
        {
          level: KO,
          text: 'Aucun service dans render.yaml : Render ne déploiera rien.',
        },
      ],
    };
  }

  for (const champ of ['type', 'runtime', 'plan', 'healthCheckPath']) {
    findings.push({ level: INFO, text: `${champ.padEnd(12)}: ${service[champ] ?? '(absent)'}` });
  }

  // `rootDir` est ce qui restreint le service au backend. Son absence est
  // légitime (service à la racine), mais elle change ce qu'il installe et sert :
  // à afficher, jamais à supposer.
  findings.push({ level: INFO, text: `rootDir      : ${service.rootDir ?? '(racine du dépôt)'}` });

  if (service.rootDir && service.rootDir !== 'backend') {
    findings.push({
      level: WARN,
      text:
        `rootDir = "${service.rootDir}" : le superviseur partira de ce dossier, ` +
        'pas de backend/.',
    });
  }

  // `buildCommand` est la porte d'entrée du runtime natif : sans lui, Render
  // démarre un service sans `tsx`, et le superviseur ne peut même pas se charger.
  findings.push(
    service.buildCommand
      ? { level: INFO, text: `buildCommand : ${service.buildCommand}` }
      : { level: KO, text: 'buildCommand ABSENT : le service ne pourra pas installer ses dépendances.' }
  );

  findings.push(
    service.startCommand
      ? { level: INFO, text: `startCommand : ${service.startCommand}` }
      : { level: KO, text: 'startCommand ABSENT : Render ne saura pas quoi lancer.' }
  );

  findings.push({
    ...auditRoleService({
      buildCommand: service.buildCommand,
      serveApps: service.envVars?.find((e) => e.key === 'STATIC_SERVE_APPS')?.value,
    }),
  });

  findings.push(auditOriginsWs(service.envVars));

  return { service, findings };
}

/** Regroupe les constats par gravité, du plus grave au plus anodin. */
export function parGravite(findings) {
  const ordre = { ko: 0, warn: 1, info: 2, ok: 3 };
  return [...findings].sort((a, b) => ordre[a.level] - ordre[b.level]);
}

/** Un constat `ko` suffit à rendre le blueprint inutilisable. */
export function estIncoherent(findings) {
  return findings.some((f) => f.level === 'ko');
}