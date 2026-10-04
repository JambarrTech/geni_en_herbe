import { describe, it, expect } from 'vitest';

import { repliqueOfferFor } from '@apps/jury/src/lib/juryShortcuts.ts';

/**
 * Le bouton « Réplique » crédite l'équipe adverse après un échec — jamais
 * l'équipe qui vient de répondre, jamais deux fois, jamais après une bonne
 * réponse. Ces cas se testent ici plutôt que sur l'écran du jury, où ils
 * exigeraient un match, des équipes et un journal simulés.
 */
const TEAM_A = 10;
const TEAM_B = 20;
const Q1 = 101;

function ev(id: number, teamId: number, points: number, questionId: number | null = Q1) {
  return { id, teamId, points, questionId };
}

describe('repliqueOfferFor — ouverture du droit', () => {
  it('sans question courante : aucun droit', () => {
    expect(repliqueOfferFor([ev(1, TEAM_A, 0)], null, TEAM_A, TEAM_B)).toBeNull();
  });

  it('sans événement sur la question : aucun droit', () => {
    expect(repliqueOfferFor([ev(1, TEAM_A, 0, 999)], Q1, TEAM_A, TEAM_B)).toBeNull();
  });

  it('après un échec de A : réplique pour B', () => {
    expect(repliqueOfferFor([ev(1, TEAM_A, 0)], Q1, TEAM_A, TEAM_B)).toEqual({
      forTeamId: TEAM_B,
      failedTeamId: TEAM_A,
    });
  });

  it('après un échec de B (pénalité négative) : réplique pour A', () => {
    expect(repliqueOfferFor([ev(1, TEAM_B, -5)], Q1, TEAM_A, TEAM_B)).toEqual({
      forTeamId: TEAM_A,
      failedTeamId: TEAM_B,
    });
  });

  it('après une bonne réponse : aucun droit', () => {
    expect(repliqueOfferFor([ev(1, TEAM_A, 10)], Q1, TEAM_A, TEAM_B)).toBeNull();
  });

  it('seule la DERNIÈRE attribution compte (correction par ajustement)', () => {
    expect(
      repliqueOfferFor([ev(1, TEAM_A, 0), ev(2, TEAM_A, 10)], Q1, TEAM_A, TEAM_B)
    ).toBeNull();
  });

  it('si le vis-à-vis a déjà marqué : droit consommé', () => {
    expect(
      repliqueOfferFor([ev(1, TEAM_A, 0), ev(2, TEAM_B, 10)], Q1, TEAM_A, TEAM_B)
    ).toBeNull();
  });

  it('une équipe hors match n’ouvre aucun droit', () => {
    expect(repliqueOfferFor([ev(1, 999, 0)], Q1, TEAM_A, TEAM_B)).toBeNull();
  });

  it('les autres questions n’interfèrent pas', () => {
    expect(
      repliqueOfferFor([ev(1, TEAM_A, 10, 999), ev(2, TEAM_A, 0)], Q1, TEAM_A, TEAM_B)
    ).toEqual({ forTeamId: TEAM_B, failedTeamId: TEAM_A });
  });
});

describe('SCORE_REASONS.replique — libellé unique', () => {
  it('nomme les points, comme les autres motifs', async () => {
    const { SCORE_REASONS } = await import('@apps/jury/src/lib/juryShortcuts.ts');
    expect(SCORE_REASONS.replique(10)).toBe('Réplique du vis-à-vis (+10 pts)');
  });
});
