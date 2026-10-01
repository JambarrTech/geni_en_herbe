import { describe, it, expect } from 'vitest';

import {
  SCORE_REASONS,
  SCORE_SHORTCUTS,
  hasModifier,
  isTypingTarget,
  resolveNavShortcut,
  resolveScoreShortcut,
} from '@apps/jury/src/lib/juryShortcuts.ts';

/**
 * Le contexte de référence : deux équipes, question à 10 points, bonus à 5.
 * Ces valeurs viennent de `APP_CONFIG`, mais les fixer ici est délibéré — un
 * test qui lirait la configuration ne vérifierait pas que les points
 * proviennent du bon champ.
 */
const CTX = { teamAId: 10, teamBId: 20, questionPoints: 10, bonusPoints: 5 };

describe('SCORE_SHORTCUTS — la table elle-même', () => {
  it('décrit six touches, sans doublon de clé', () => {
    // Une clé écrite deux fois dans un littéral objet écrase la première
    // SILENCIEUSEMENT : `{ a: X, a: Y }` ne déclenche aucune erreur. Vérifier
    // le nombre de clés est donc le seul moyen d'attraper le cas.
    expect(Object.keys(SCORE_SHORTCUTS)).toHaveLength(6);
    expect(Object.keys(SCORE_SHORTCUTS).sort()).toEqual(['1', '2', 'a', 'e', 's', 'z']);
  });

  it('couvre les deux équipes pour chacun des trois types', () => {
    const pairs = Object.values(SCORE_SHORTCUTS).map((s) => `${s.type}:${s.team}`);
    expect(pairs.sort()).toEqual([
      'ANSWER:A',
      'ANSWER:B',
      'BONUS:A',
      'BONUS:B',
      'PENALTY:A',
      'PENALTY:B',
    ]);
  });
});

describe('resolveScoreShortcut — touches de score', () => {
  it("'a' valide la bonne réponse pour l'équipe A, aux points de la question", () => {
    expect(resolveScoreShortcut('a', CTX)).toEqual({
      teamId: 10,
      points: 10,
      type: 'ANSWER',
      reason: 'Bonne réponse directe (10 pts)',
    });
  });

  it("'e' valide la bonne réponse pour l'équipe B", () => {
    expect(resolveScoreShortcut('e', CTX)).toEqual({
      teamId: 20,
      points: 10,
      type: 'ANSWER',
      reason: 'Bonne réponse directe (10 pts)',
    });
  });

  it('accepte la majuscule, ce que produirait Verr. Maj.', () => {
    // Sans normalisation de la casse, un jury ayant Verr. Maj. activé ne
    // pouvait attribuer aucun point au clavier.
    expect(resolveScoreShortcut('A', CTX)).toEqual(resolveScoreShortcut('a', CTX));
    expect(resolveScoreShortcut('E', CTX)).toEqual(resolveScoreShortcut('e', CTX));
    expect(resolveScoreShortcut('Z', CTX)).toEqual(resolveScoreShortcut('z', CTX));
    expect(resolveScoreShortcut('S', CTX)).toEqual(resolveScoreShortcut('s', CTX));
  });

  it("'1' et '2' attribuent le bonus, pas les points de la question", () => {
    // Le piège : une question passée à 20 points ne doit pas transformer le
    // bonus en +20.
    const ctx = { ...CTX, questionPoints: 20 };
    expect(resolveScoreShortcut('1', ctx)).toEqual({
      teamId: 10,
      points: 5,
      type: 'BONUS',
      reason: 'Points Bonus (+5 pts)',
    });
    expect(resolveScoreShortcut('2', ctx)).toEqual({
      teamId: 20,
      points: 5,
      type: 'BONUS',
      reason: 'Points Bonus (+5 pts)',
    });
  });

  it("'z' et 's' marquent la réponse erronée à 0 point", () => {
    // Le piège d'origine : un `questionId` absent valait 10 points par clic.
    // Le type PENALTY doit toujours valoir 0.
    const ctx = { ...CTX, questionPoints: 42 };
    expect(resolveScoreShortcut('z', ctx)).toEqual({
      teamId: 10,
      points: 0,
      type: 'PENALTY',
      reason: 'Réponse erronée (0 pt)',
    });
    expect(resolveScoreShortcut('s', ctx)).toEqual({
      teamId: 20,
      points: 0,
      type: 'PENALTY',
      reason: 'Réponse erronée (0 pt)',
    });
  });

  it('renvoie null pour une touche qui ne score pas', () => {
    for (const key of ['b', 'q', 'Enter', ' ', 'Escape', 'F5', 'Tab', 'ArrowUp']) {
      expect(resolveScoreShortcut(key, CTX)).toBeNull();
    }
  });

  it('ne confond pas les touches de navigation avec des touches de score', () => {
    expect(resolveScoreShortcut('ArrowLeft', CTX)).toBeNull();
    expect(resolveScoreShortcut('ArrowRight', CTX)).toBeNull();
  });

  it('renvoie un objet neuf à chaque appel', () => {
    // Deux appels successifs ne doivent pas partager de référence : un
    // appelant qui modifierait le résultat corromprait les suivants.
    const first = resolveScoreShortcut('a', CTX);
    const second = resolveScoreShortcut('a', CTX);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('resolveNavShortcut — bornes de navigation', () => {
  it('avance quand il reste une question', () => {
    expect(resolveNavShortcut('ArrowRight', { currentIndex: 0, questionCount: 3 })).toBe('next');
    expect(resolveNavShortcut('ArrowRight', { currentIndex: 1, questionCount: 3 })).toBe('next');
  });

  it('ne dépasse pas la dernière question', () => {
    // Sans cette borne, `ArrowRight` sur la dernière question déclenchait un
    // appel serveur pour une question inexistante.
    expect(resolveNavShortcut('ArrowRight', { currentIndex: 2, questionCount: 3 })).toBeNull();
  });

  it('recule quand il reste une question avant', () => {
    expect(resolveNavShortcut('ArrowLeft', { currentIndex: 2, questionCount: 3 })).toBe('prev');
  });

  it('ne recule pas avant la première question', () => {
    expect(resolveNavShortcut('ArrowLeft', { currentIndex: 0, questionCount: 3 })).toBeNull();
  });

  it('ne navigue pas sur une liste vide', () => {
    // `currentIndex: 0` sur `questionCount: 0` : avancer donnerait -1, reculer
    // est déjà impossible. Aucun des deux ne doit être déclenché.
    expect(resolveNavShortcut('ArrowRight', { currentIndex: 0, questionCount: 0 })).toBeNull();
    expect(resolveNavShortcut('ArrowLeft', { currentIndex: 0, questionCount: 0 })).toBeNull();
  });

  it('renvoie null pour une touche non directionnelle', () => {
    expect(resolveNavShortcut('a', { currentIndex: 1, questionCount: 3 })).toBeNull();
    expect(resolveNavShortcut('ArrowUp', { currentIndex: 1, questionCount: 3 })).toBeNull();
  });
});

describe('isTypingTarget — le garde-fou des champs de saisie', () => {
  it('reconnaît les champs de formulaire', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
  });

  it('reconnaît un élément contenteditable', () => {
    // Un `div` éditable n'est ni INPUT ni TEXTAREA : sans ce test, écrire un
    // motif d'ajustement dans un éditeur riche scorerait à chaque lettre.
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('laisse passer le reste, y compris une cible absente', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe('hasModifier — les raccourcis sont des lettres nues', () => {
  it('détecte chaque modificateur', () => {
    expect(hasModifier({ ctrlKey: true })).toBe(true);
    expect(hasModifier({ metaKey: true })).toBe(true);
    expect(hasModifier({ altKey: true })).toBe(true);
  });

  it('laisse passer une frappe sans modificateur', () => {
    expect(hasModifier({})).toBe(false);
    expect(hasModifier({ ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });

  it('la touche Maj n\'est pas un modificateur bloquant', () => {
    // Volontaire : `A` doit scorer. Seul Ctrl/Meta/Alt bloque.
    const withShift = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: true };
    expect(hasModifier(withShift)).toBe(false);
  });
});

describe('SCORE_REASONS — motifs partagés clic / clavier', () => {
  it('produit exactement les libellés attendus par l\'historique', () => {
    // Ces chaînes sont enregistrées en base comme motif d'audit et affichées
    // dans l'historique : ce sont des libellés durables. Le test les fige pour
    // qu'une reformulation ne passe pas inaperçue.
    expect(SCORE_REASONS.answer(10)).toBe('Bonne réponse directe (10 pts)');
    expect(SCORE_REASONS.bonus(5)).toBe('Points Bonus (+5 pts)');
    expect(SCORE_REASONS.penalty()).toBe('Réponse erronée (0 pt)');
  });

  it('est la seule source : le clavier et le bouton produisent le même motif', () => {
    // C'est la garantie centrale de l'extraction. Le bouton appelle
    // `SCORE_REASONS.answer(currentPoints)` ; le raccourci appelle
    // `SCORE_REASONS.answer(questionPoints)` via `resolveScoreShortcut`. Avec
    // la même entrée, les deux chemins DOIVENT produire la même chaîne — sans
    // quoi la même action apparaîtrait sous deux libellés dans l'audit.
    const viaRaccourci = resolveScoreShortcut('a', CTX);
    expect(viaRaccourci?.reason).toBe(SCORE_REASONS.answer(CTX.questionPoints));

    const viaBonus = resolveScoreShortcut('1', CTX);
    expect(viaBonus?.reason).toBe(SCORE_REASONS.bonus(CTX.bonusPoints));

    const viaPenalty = resolveScoreShortcut('z', CTX);
    expect(viaPenalty?.reason).toBe(SCORE_REASONS.penalty());
  });
});
