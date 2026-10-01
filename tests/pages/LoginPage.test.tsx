import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';

import LoginPage from '@shared/pages/LoginPage';

const mockLogin = vi.fn();

vi.mock('@shared/context/AuthContext.tsx', () => ({
  useAuth: () => ({
    login: mockLogin,
  }),
}));

describe('LoginPage', () => {
  it('est accessible sans violation axe', async () => {
    const { container } = render(<LoginPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('affiche les libellés d\'accessibilité requis', () => {
    render(<LoginPage />);

    // Libellés exacts, et non « contient » : le bouton « Afficher le mot de
    // passe » contient lui aussi la suite /mot de passe/i, et une requête
    // large l'aurait fait correspondre au champ. Le test passerait par
    // accident sur le mauvais élément.
    expect(screen.getByLabelText('Adresse email')).toBeInTheDocument();
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password');

    // Bouton d'action principal identifiable
    expect(screen.getByRole('button', { name: /accéder à la plateforme/i })).toBeInTheDocument();
  });

  it('affiche un message d\'erreur accessible avec role=alert', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Identifiants incorrects'));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Adresse email'), 'admin@aeerks.sn');
    await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
    await user.click(screen.getByRole('button', { name: /accéder à la plateforme/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/identifiants incorrects/i);

    // Le message doit être rattaché au champ par aria-describedby, sans quoi
    // un lecteur d'écran Announces « erreur » en annonçant le champ, mais ne
    // sait pas QUE c'est de ce champ qu'il s'agit.
    expect(screen.getByLabelText('Adresse email')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('login-error-alert')
    );
  });

  it('permute la visibilité du mot de passe et annonce l\'état', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    const toggle = screen.getByRole('button', {
      name: /afficher le mot de passe/i,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /masquer le mot de passe/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'text');
  });
});
