# ADR-0004 : Nettoyage du code mort

## Statut
Accepté

## Contexte
Le dépôt contenait des vestiges d'une intégration Firebase retirée de l'interface (et de la vérification des rôles côté serveur) :
- `backend/src/lib/firebase-admin.ts`
- `firebase-applet-config.json`
- `metadata.json`
- dépendance `firebase-admin` (dans `backend/package.json`)

Ces fichiers n'étaient importés nulle part. Ils embarquaient :
- une dépendance de production lourde (`firebase-admin`) non utilisée, qui alourdissait l'image Docker et la surface d'attaque ;
- des fichiers de configuration contenant des clés/identifiants de projet (surface de fuite inutile) ;
- du bruit qui donne l'impression que le chemin Firebase est « peut-être encore actif », ce qui rend l'analyse du chemin d'authentification réelle plus difficile.

Ils étaient également référencés dans des fichiers de documentation et d'exemple (`.env.example`, `backend/.env.example`, `.dockerignore`, `README.md`), ce qui consolidait l'illusion.

## Décision
Supprimer entièrement le code mort Firebase :
- suppression de `backend/src/lib/firebase-admin.ts`, `firebase-applet-config.json`, `metadata.json` ;
- suppression de la dépendance `firebase-admin` via `npm install` (arbre de dépendances de prod : 23 paquets directs) ;
- nettoyage des références dans `.env.example`, `backend/.env.example`, `.dockerignore`, `README.md`.

Le chemin d'authentification réel est le seul qui subsiste : jeton de session stocké côté serveur (voir ADR-0001). L'interface a explicitement retiré la connexion Google.

## Conséquences
- Image Docker de production allégée (moins de couches npm, moins de surface d'attaque).
- Aucune clé de projet Firebase à gérer ni à faire tourner dans l'environnement.
- Le README reflète la réalité : l'authentification est par email/mot de passe avec session serveur.
- Si Firebase devait revenir un jour, cela se ferait via une nouvelle décision explicitement documentée.

## Références
- ADR-0001 (sessions serveur, qui remplace le stockage local pour l'état de session)
- `backend/package.json` (firebase-admin supprimé)
