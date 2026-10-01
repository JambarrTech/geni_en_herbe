# Décisions d'architecture (ADR)

Chaque document enregistre une décision technique, le **problème** qu'elle
résout, la **décision** prise et ses **conséquences** — y compris les
inconvénients acceptés. Le but n'est pas de décrire ce que fait le code (le code
le fait déjà) mais de conserver le *pourquoi*, qui est la seule chose que le code
ne peut pas dire de lui-même.

Un ADR n'est jamais modifié après acceptation. Si une décision change, on écrit
un nouvel ADR qui remplace l'ancien, et on met à jour le statut.

| Numéro | Titre | Statut |
| ------ | ----- | ------ |
| [ADR-0001](ADR-0001-sessions.md) | Stockage des sessions (PostgreSQL, hash SHA-256, cache borné) | Accepté |
| [ADR-0002](ADR-0002-observability.md) | Observabilité : logger structuré et métriques Prometheus, sans dépendance | Accepté |
| [ADR-0003](ADR-0003-tests-frontend.md) | Tests du front : un projet Vitest unique pour les trois applications | Accepté |
| [ADR-0004](ADR-0004-nettoyage-code-mort.md) | Nettoyage du code mort (intégration Firebase) | Accepté |
| [ADR-0005](ADR-0005-decomposition-fichiers.md) | Décomposition ciblée des gros fichiers (extraction, pas réécriture) | Accepté |
| [ADR-0006](ADR-0006-topologie-deploiement.md) | Topologie de déploiement : un projet Vercel, backend sur processus permanent | Accepté |
