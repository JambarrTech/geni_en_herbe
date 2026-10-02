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
 * Répond à la seule question qui décide de la topologie : ce processus sert-il
 * des fichiers d'écran, oui ou non ?
 *
 * La réponse se déduit de `buildCommand` — le build produit ce que le service
 * sert — et non de `STATIC_SERVE_APPS`, qui ne figure plus dans le blueprint.
 * C'est le bon sens de lecture : une variable qui contredirait le build
 * décrirait une configuration impossible, alors que le build est ce qui
 * décide réellement.
 *
 * `STATIC_SERVE_APPS` reste honorée par `static.ts` comme dérogation
 * d'urgence, mais elle ne vit plus dans le blueprint : déduire le rôle des
 * fichiers présents est le comportement correct, et la figer ajouterait une
 * variable à maintenir sans rien apporter.
 */
export function auditRoleService({ buildCommand, serveApps }) {
  const compile = compileLeFrontend(buildCommand);

  if (serveApps === 'false' && compile) {
    return {
      level: WARN,
      text:
        'buildCommand compile les interfaces mais STATIC_SERVE_APPS=false les fait ' +
        'ignorer : les écrans seraient produits puis jamais servis, et chaque ' +
        'route répondrait 404. Retirez la variable, ou retirez le build.',
    };
  }

  if (compile) {
    return {
      level: OK,
      text:
        'Mono-origine : ce service sert les trois écrans ET relaie /api et /ws. ' +
        'Le canal temps réel suit l\'origine de la page — aucune variable à saisir.',
    };
  }

  return {
    level: WARN,
    text:
      "Le service ne compile aucune interface : il n'expose donc que /api, /ws " +
      'et la sonde.\n' +
      "  C'est le montage « CDN devant » (docs/DEPLOIEMENT-VERCEL.md). Possible, " +
      "mais alors WS_ALLOWED_ORIGINS doit porter l'origine du CDN, sans quoi le " +
      'canal est refusé en 1008.',
  };
}

/**
 * `WS_ALLOWED_ORIGINS` décide si le WebSocket du jury sera accepté.
 *
 * Sa valeur correcte dépend de la topologie, et c'est ce qui rend l'audit
 * intéressant :
 *
 *   MONO-ORIGINE (le service sert les écrans) — VIDE est juste. Le navigateur
 *   annonce l'origine de Render, qui est la seule autorisée, donc la connexion
 *   passe. Aucune saisie à faire.
 *
 *   CDN DEVANT (l'interface est ailleurs) — VIDE est FAUX, et le pire des cas.
 *   Le navigateur annonce l'origine du CDN, absente de la liste : refus en
 *   code 1008, le chrono du jury reste figé, sans le moindre message. Aucun
 *   test, aucune console, aucun code HTTP ne le signale.
 *
 * Ce contrôle est donc paramétré par `monoOrigine`, déduit du build. Sans ce
 * paramètre, l'audit cracherait un avertissement sur une configuration
 * parfaitement correcte — et l'on s'habitue à ignorer les avertissements.
 *
 * Chaque cas rend UN constat, pas deux : le tri par gravité réorganise la
 * liste, et un avertissement détaché de son sujet s'affiche avant la ligne qui
 * dit de quoi il parle.
 */
export function auditOriginsWs(envVars, { monoOrigine }) {
  const ws = (envVars ?? []).find((e) => e.key === 'WS_ALLOWED_ORIGINS');

  if (!ws) {
    return {
      level: 'warn',
      text:
        'WS_ALLOWED_ORIGINS : absent de envVars.\n' +
        '  Le serveur de diffusion retombe alors sur sa valeur par défaut ' +
        '(même origine), ce qui est correct ici — mais autant que la décision ' +
        'soit écrite dans le dépôt plutôt que laissée à un défaut.',
    };
  }

  if (ws.sync === false) {
    return {
      level: 'warn',
      text:
        'WS_ALLOWED_ORIGINS : à définir dans le dashboard Render.\n' +
        (monoOrigine
          ? '  Le service sert les écrans : une valeur VIDE suffit — même origine.\n'
          : "  ATTENTION : l'interface est sur un CDN. Mettez l'origine du CDN,\n" +
            "  sans barre oblique finale, ex. https://aeerks.vercel.app\n") +
        '  Une valeur fausse ne produit AUCUNE erreur visible : refus en 1008,\n' +
        '  et le chrono du jury reste figé sans message.',
    };
  }

  if (ws.value === '') {
    return monoOrigine
      ? {
          level: OK,
          text:
            'WS_ALLOWED_ORIGINS : vide — correct en mono-origine, l\'origine de la ' +
            'page est la seule autorisée.',
        }
      : {
          level: 'warn',
          text:
            'WS_ALLOWED_ORIGINS : vide alors que l\'interface est sur un CDN.\n' +
            "  Le navigateur annonce l'origine du CDN, qui n'est pas autorisée : " +
            'refus en 1008, chrono figé sans message. Renseignez-la.',
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

  // `rootDir` restreindrait le service à un sous-dossier. Le déploiement
  // retenu en mono-origine n'en a pas besoin — le service doit compiler les
  // interfaces, qui vivent à la racine — mais le champ reste affiché : s'il
  // réapparaît, il change ce que le service installe ET ce qu'il sert, et
  // c'est le genre de champ qu'on ne remarque pas.
  findings.push({ level: INFO, text: `rootDir      : ${service.rootDir ?? '(racine du dépôt)'}` });

  if (service.rootDir) {
    findings.push({
      level: WARN,
      text:
        `rootDir = "${service.rootDir}" : le service se restreint à ce dossier. ` +
        'Les interfaces étant à la racine, il ne peut plus les compiler — et ' +
        'plus les servir non plus. À retirer pour un déploiement mono-origine.',
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

  // Le rôle du service décide de la valeur CORRECTE de WS_ALLOWED_ORIGINS, donc
  // il est calculé une fois et partagé : l'audit des origines ne doit pas
  // redécouvrir la topologie par lui-même, sous peine de diverger d'un build.
  const buildCommand = service.buildCommand;
  const monoOrigine = compileLeFrontend(buildCommand);

  findings.push(
    auditRoleService({
      buildCommand,
      serveApps: service.envVars?.find((e) => e.key === 'STATIC_SERVE_APPS')?.value,
    })
  );

  findings.push(auditOriginsWs(service.envVars, { monoOrigine }));

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