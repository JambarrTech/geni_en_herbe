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