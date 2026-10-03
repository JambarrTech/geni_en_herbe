// Helper for Postgres error classification (node-postgres / pg error codes)
export function isForeignKeyViolation(err: any): boolean {
  return err?.code === '23503' || err?.cause?.code === '23503';
}

export function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || err?.cause?.code === '23505';
}

// Human messages per entity for FK conflicts (linked records blocking deletion)
export const FK_DELETE_MESSAGES: Record<string, string> = {
  category: 'Impossible de supprimer : des questions sont associées à cette catégorie.',
  team: 'Impossible de supprimer : cette équipe est engagée dans un match.',
  event: 'Impossible de supprimer : des équipes, matchs ou questions sont rattachés à cet événement.',
  participant: 'Impossible de supprimer : ce membre est affecté à une équipe.',
  match: 'Impossible de supprimer : ce match comprend déjà des questions ou scores.',
  question: 'Impossible de supprimer : cette question est utilisée dans un match.',
  teamMember: 'Impossible de retirer ce membre de l\'équipe.',
  user: 'Impossible de supprimer : ce compte est lié à des éléments (jury, etc.).',
};

/**
 * Colonne ou table absente de la base (`undefined_column` / `undefined_table`).
 *
 * 42703 est le code que PostgreSQL renvoie quand une requête — ou son
 * `RETURNING` — cite une colonne que la base ne connaît pas. C'est donc
 * exactement ce que produit une migration non appliquée : le code attend une
 * colonne, la base ne l'a jamais vue.
 *
 * CE N'EST PAS une donnée invalide, et surtout pas une panne : la base
 * fonctionne parfaitement, c'est le schéma qui est en retard d'un cran sur le
 * code déployé. Le confondre avec une erreur de saisie fait perdre un temps
 * considerable à quelqu'un qui cherche du mauvais côté — un identifiant
 * d'équipe, une valeur de phase — alors que le correctif est une seule commande.
 */
export function isMissingSchemaError(err: any): boolean {
  // Les deux codes sont testés INDÉPENDAMMENT, comme dans
  // `isForeignKeyViolation` : pg peut envelopper l'erreur sous `cause`, et
  // `err.code || err.cause.code` ne retiendrait alors que le code extérieur —
  // typiquement `ECONNREFUSED`, qui parle du réseau et non du schéma, et ferait
  // passer à côté du vrai diagnostic.
  return (
    err?.code === '42703' ||
    err?.cause?.code === '42703' ||
    err?.code === '42P01' ||
    err?.cause?.code === '42P01'
  );
}

/**
 * Message à renvoyer quand le schéma est en retard sur le code.
 *
 * Volontairement actionnel : il nomme la commande, parce que l'appelant de l'API
 * est un humain devant un écran en plein concours, et qu'un diagnostic qu'il
 * faut aller chercher dans les journaux du serveur ne lui sert à rien.
 *
 * La commande se lance depuis `backend/`, où vit `drizzle.config.ts` et
 * `drizzle-kit`. Le drapeau `-w backend` qui ferait croire le contraire est
 * invalide ici : les workspaces de ce dépôt ne couvrent que `apps/*`, `backend`
 * en est absent, et npm répond « No workspaces found ».
 */
export function missingSchemaMessage(): string {
  return (
    'Base de données non à jour : une migration n\'a pas été appliquée. ' +
    'Depuis le dossier backend/, exécutez `npm run db:migrate`.'
  );
}