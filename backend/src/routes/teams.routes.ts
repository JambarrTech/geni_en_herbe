import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { teams, teamMembers, participants } from '../db/schema.ts';
import { eq, and } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../lib/dbErrors.ts';
import { getSetting } from '../lib/settings.ts';
import { CONFIG, FLOW } from '../config.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';

export const teamsRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(teamsRouter);

const VALID_TEAM_STATUS: readonly string[] = Object.values(FLOW.TEAM_STATUS);

// Les équipes et leur effectif (noms de participants, souvent mineurs) :
// accès staff uniquement. Cette route était lisible par quiconque.
teamsRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const allTeams = await db
      .select({
        id: teams.id,
        eventId: teams.eventId,
        name: teams.name,
        code: teams.code,
        logo: teams.logo,
        status: teams.status,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .orderBy(teams.name);

    const allMembers = await db
      .select({
        id: teamMembers.id,
        teamId: teamMembers.teamId,
        participantId: teamMembers.participantId,
        role: teamMembers.role,
        firstName: participants.firstName,
        lastName: participants.lastName,
        gender: participants.gender,
      })
      .from(teamMembers)
      .innerJoin(participants, eq(teamMembers.participantId, participants.id));

    const membersByTeam = new Map<number, any[]>();
    for (const m of allMembers) {
      if (!membersByTeam.has(m.teamId)) membersByTeam.set(m.teamId, []);
      membersByTeam.get(m.teamId)!.push({
        id: m.id,
        teamId: m.teamId,
        participantId: m.participantId,
        role: m.role,
        participant: {
          id: m.participantId,
          firstName: m.firstName,
          lastName: m.lastName,
          gender: m.gender,
        },
      });
    }

    const result = allTeams.map((t) => ({
      ...t,
      membersCount: membersByTeam.get(t.id)?.length || 0,
      members: membersByTeam.get(t.id) || [],
    }));

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les équipes' });
  }
});

teamsRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { eventId, name, code, logo } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Nom et code d\'équipe requis' });

    if (!eventId) {
      return res.status(400).json({ error: 'Le champ eventId est requis pour créer une équipe' });
    }
    const targetEventId = parseInt(eventId, 10);

    const [newTeam] = await db
      .insert(teams)
      .values({
        eventId: targetEventId,
        name,
        code: code.toUpperCase().trim(),
        logo,
        status: FLOW.TEAM_STATUS.ACTIVE,
      })
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_TEAM', 'team', String(newTeam.id));
    res.status(201).json(newTeam);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la création de l\'équipe' });
  }
});

teamsRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, code, status } = req.body;

    if (status !== undefined && !VALID_TEAM_STATUS.includes(status)) {
      return res.status(400).json({
        error: `Statut d'équipe invalide (valides : ${VALID_TEAM_STATUS.join(', ')})`,
      });
    }

    const [updated] = await db
      .update(teams)
      .set({
        ...(name && { name }),
        ...(code && { code: code.toUpperCase().trim() }),
        ...(status && { status }),
        updatedAt: new Date(),
      })
      .where(eq(teams.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Équipe non trouvée' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour de l\'équipe' });
  }
});

teamsRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.delete(teams).where(eq(teams.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_TEAM', 'team', String(id));
    res.json({ success: true });
  } catch (error: any) {
    console.error('DELETE team error:', error);
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.team });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'équipe' });
  }
});

teamsRouter.post('/:id/members', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const teamId = parseInt(req.params.id, 10);
    const { participantId, role } = req.body;
    const parsedParticipantId = parseInt(participantId, 10);

    if (!parsedParticipantId) return res.status(400).json({ error: 'Participant requis' });

    // Limite de taille d'équipe, configurable via competition_settings
    const maxMembers = parseInt(await getSetting('MAX_TEAM_MEMBERS', String(CONFIG.DEFAULT_MAX_TEAM_MEMBERS)), 10) || CONFIG.DEFAULT_MAX_TEAM_MEMBERS;
    const membersCount = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));
    if (membersCount.length >= maxMembers) {
      return res.status(400).json({
        error: `Équipe complète : ${maxMembers} membres maximum autorisés`,
      });
    }

    const [existingInTeam] = await db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.participantId, parsedParticipantId)
        )
      );

    if (existingInTeam) {
      return res.status(400).json({ error: 'Ce participant fait déjà partie de cette équipe' });
    }

    // Un membre ne peut appartenir qu'à une seule équipe
    const [inAnotherTeam] = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.participantId, parsedParticipantId));
    if (inAnotherTeam) {
      return res.status(400).json({ error: 'Ce participant est déjà affecté à une autre équipe' });
    }

    const [newMember] = await db
      .insert(teamMembers)
      .values({
        teamId,
        participantId: parsedParticipantId,
        role: role || FLOW.TEAM_ROLE.MEMBER,
      })
      .returning();

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'ADD_TEAM_MEMBER',
      'team_member',
      String(newMember.id)
    );
    res.status(201).json(newMember);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de l\'affectation du membre' });
  }
});

teamsRouter.delete('/:id/members/:memberId', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const memberId = parseInt(req.params.memberId, 10);
    await db.delete(teamMembers).where(eq(teamMembers.id, memberId));
    await logAudit(req.user?.uid, req.user?.email, 'REMOVE_TEAM_MEMBER', 'team_member', String(memberId));
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de suppression du membre' });
  }
});

// Promote to captain: set this member as CAPTAIN, others in same team back to MEMBER
teamsRouter.post('/:id/members/:memberId/captain', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const teamId = parseInt(req.params.id, 10);
    const memberId = parseInt(req.params.memberId, 10);

    // Demote all existing captains in this team
    await db
      .update(teamMembers)
      .set({ role: FLOW.TEAM_ROLE.MEMBER })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, FLOW.TEAM_ROLE.CAPTAIN)));

    // Promote target (must belong to this team)
    const [updated] = await db
      .update(teamMembers)
      .set({ role: FLOW.TEAM_ROLE.CAPTAIN })
      .where(and(eq(teamMembers.id, memberId), eq(teamMembers.teamId, teamId)))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Membre non trouvé dans cette équipe' });

    await logAudit(req.user?.uid, req.user?.email, 'PROMOTE_CAPTAIN', 'team_member', String(memberId));
    res.json({ success: true, member: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la promotion en capitaine' });
  }
});

