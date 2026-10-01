import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';

import { Modal } from '@shared/components/Modal';

describe('Modal', () => {
  let onClose: () => void;

  beforeEach(() => {
    onClose = vi.fn();
  });

  it('est accessible sans violation axe', async () => {
    const { container } = render(
      <Modal open title="Test modal" onClose={onClose}>
        <button>Continuer</button>
      </Modal>
    );

    // Premier test d'accessibilité : axe détecte les violations structurelles
    // (role dialog absent, aria-labelledby manquant, focus piégé non déclaré...)
    // avant même de tester le comportement.
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('ferme au clic sur le fond', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Test modal" onClose={onClose}>
        <p>Contenu</p>
      </Modal>
    );

    // Le fond est l'overlay (premier div) : un clic dessus ferme la boîte.
    // Ce test verrouille le comportement historique — important car beaucoup
    // d'appels l'attendaient.
    const overlay = screen.getByRole('dialog').parentElement;
    expect(overlay).toBeTruthy();
    await user.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ne ferme pas sur le fond si busy', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="En cours" onClose={onClose} busy>
        <p>Opération en cours</p>
      </Modal>
    );

    const overlay = screen.getByRole('dialog').parentElement;
    await user.click(overlay!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ferme avec Échap', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Esc" onClose={onClose}>
        <input placeholder="focus" />
      </Modal>
    );

    // Échap doit déclencher onClose (sauf busy) — exigence WCAG pour les
    // dialogues modaux.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('garde le focus piégé (Tab circulaire)', async () => {
    const user = userEvent.setup();
    render(
      <Modal open title="Focus trap" onClose={onClose}>
        <button>Premier</button>
        <button>Dernier</button>
      </Modal>
    );

    const dernier = screen.getByText('Dernier');
    dernier.focus();
    await user.keyboard('{Tab}');

    // Depuis le dernier élément focusable, Tab doit ramener au premier.
    expect(document.activeElement).toBe(screen.getByText('Premier'));
  });

  it('rétablit le focus à la fermeture', async () => {
    const { rerender } = render(
      <>
        <button>Declencheur</button>
        <Modal open title="Focus restore" onClose={onClose}>
          <button>Fermer</button>
        </Modal>
      </>
    );

    const declencheur = screen.getByText('Declencheur');
    declencheur.focus();
    expect(document.activeElement).toBe(declencheur);

    rerender(
      <>
        <button>Declencheur</button>
        <Modal open={false} title="Focus restore" onClose={onClose}>
          <button>Fermer</button>
        </Modal>
      </>
    );

    // À la fermeture, le focus doit revenir sur l'élément qui l'avait.
    // C'est ce qui évite à un utilisateur clavier de se retrouver « perdu »
    // au début de la page.
    await waitFor(() => {
      expect(document.activeElement).toBe(declencheur);
    });
  });
});
