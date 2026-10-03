import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { teamMembers, participants } from '../db/schema.ts';

/**
 * Effectif d'une équipe, dans la seule forme qui part sur l'écran PUBLIC.
 *
 * Ce type est volontairement plus pauvre que `TeamMemberItem` : il n'a ni
 * identifiant de participant, ni genre, ni photo, ni coordonnées. Une fonction
 * qui construit un `PublicTeamMember[]` ne peut donc pas, par construction,
 * exposer l'un de ces champs — la contrainte est dans le type, pas dans une
 * relecture attentive de la requête.
 */
export interface PublicTeamMember {
  firstName: string;
  lastName: string;
  /** `CAPTAIN` ou `MEMBER` — affiché comme « capitaine » sur l'écran. */
  role: string;
}

/**
 * Charge l'effectif des équipes en projeté minimal.
 *
 * POURQUOI CE MODULE EST SÉPARÉ
 * -----------------------------
 * `/api/teams` est en accès staff uniquement, et son commentaire le dit
 * expressément : « noms de participants, souvent mineurs ». La diffusion de
 * l'effectif sur l'écran public est une exception ASSUMÉE à cette règle, et une
 * exception de ce genre mérite un endroit unique où elle est écrite, prouvée et
 * réexaminée — pas une requête en dur au milieu de la construction de l'état
 * live, où elle passerait inaperçue.
 *
 * Le contrat tient en une phrase : on ne publie que le prénom et le nom. Pas le
 * genre, pas la date de naissance, pas la photo, pas le téléphone ni le
 * courriel. Si un jour l'écran doit montrer davantage, c'est ici que ça se
 * décide — et c'est ici qu'on voit ce qui a été tranché.
 *
 * La colonne est triée par nom puis prénom : sur un écran projeté, l'ordre
 * alphabétique est le seul qui reste lisible quand la liste défile.
 */
export async function loadPublicRosters(teamIds: Array<number | null | undefined>): Promise<Map<number, PublicTeamMember[]>> {
  const ids = teamIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0);
  const rosters = new Map<number, PublicTeamMember[]>();
  if (ids.length === 0) return rosters;

  const rows = await db
    .select({
      teamId: teamMembers.teamId,
      firstName: participants.firstName,
      lastName: participants.lastName,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(participants, eq(teamMembers.participantId, participants.id))
    .where(inArray(teamMembers.teamId, ids))
    .orderBy(participants.lastName, participants.firstName);

  for (const row of rows) {
    const member: PublicTeamMember = {
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.role,
    };
    const existing = rosters.get(row.teamId);
    if (existing) existing.push(member);
    else rosters.set(row.teamId, [member]);
  }

  return rosters;
}