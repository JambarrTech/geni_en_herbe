/**
 * Bouton de corbeille d'une ligne de liste.
 *
 * Icône seule, comme les autres actions iconiques de l'application. Le nom
 * accessible porte le libellé de la cible : dans une grille de six questions,
 * un lecteur d'écran qui annonce seulement « bouton » laisse deviner laquelle
 * des six on va effacer.
 *
 * Le composant ne fait rien de plus : c'est `ConfirmDialog` qui demande, et
 * `useSuppression` qui envoie. Aucun de ces trois fichiers ne connaît l'API.
 */
import React from 'react';
import { Trash2 } from 'lucide-react';

export interface BoutonSuppressionProps {
  /** Identifiant stable, pour les tests et l'outillage. */
  id?: string;
  /** Nom accessible : « Supprimer l'équipe Alpha ». */
  label: string;
  /** Infobulle. Sert aussi à expliquer un bouton désactivé. */
  title?: string;
  /**
   * Le serveur refuse-t-il déjà cette suppression ?
   *
   * Un bouton gris SANS raison se lit comme un bug ; d'où `title` en plus du
   * nom accessible. Voir `suppressionBloquee` dans `AdminDashboard`.
   */
  disabled?: boolean;
  onClick: () => void;
}

export const BoutonSuppression: React.FC<BoutonSuppressionProps> = ({
  id,
  label,
  title,
  disabled = false,
  onClick,
}) => (
  <button
    type="button"
    id={id}
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={title ?? label}
    className={[
      'p-1.5 rounded-lg border transition-colors',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1',
      disabled
        ? 'border-slate-200 text-slate-400 opacity-35 cursor-not-allowed'
        : 'border-slate-200 text-slate-500 hover:text-rose-600 hover:bg-rose-50 hover:border-rose-200',
    ].join(' ')}
  >
    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
  </button>
);