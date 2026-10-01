import React, { useCallback, useEffect, useId, useRef } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Empêche la fermeture (opération en cours). */
  busy?: boolean;
  /** Classes Tailwind supplémentaires sur la boîte de dialogue. */
  className?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Amène le focus sur `target` en garantissant qu'il reste dans la boîte.
 *
 * `focus()` peut échouer silencieusement : sur un élément `display: none`, le
 * navigateur retire le focus du document. Le focus partirait alors sur `body`,
 * donc HORS de la modale — l'inverse exact de ce que le piège cherche à
 * empêcher, et de façon invisible : rien ne signale que l'utilisateur a été
 * éjecté.
 *
 * On retombe donc sur le panneau lui-même, qui est focusable (`tabIndex={-1}`).
 * Le focus reste alors dans la boîte, ce qui est l'unique garantie utile.
 */
function focusInside(target: HTMLElement, panel: HTMLElement): void {
  target.focus();
  if (!panel.contains(document.activeElement)) {
    panel.focus();
  }
}

/**
 * Boîte de dialogue accessible.
 *
 * Remplace les 9 copies « fixed inset-0 z-50 bg-slate-900/40 … » qui
 * n'avaient ni role="dialog", ni piège de focus, ni fermeture par Échap :
 * un utilisateur clavier sortait de la modale et continuait à tabuler dans la
 * page restée montée derrière.
 *
 * - role="dialog" + aria-modal + aria-labelledby
 * - focus déplacé à l'ouverture, restauré à la fermeture
 * - Tab/Shift+Tab piégé dans la modale
 * - Échap ferme (sauf si `busy`)
 * - défilement de la page arrière bloqué
 */
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  busy = false,
  className = 'max-w-md',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Focus à l'ouverture + restauration à la fermeture + blocage du scroll
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Premier champ interactif, sinon la boîte elle-même
    const focusTarget =
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panelRef.current;
    focusTarget?.focus();

    return () => {
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!busy) onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        // Filtre de visibilité.
        //
        // Le test classique est `offsetParent !== null`. On ne l'utilise PAS :
        // `offsetParent` dépend d'une mise en page réelle et vaut TOUJOURS
        // null hors navigateur (jsdom, et tout environnement de test). Le
        // piège de focus disparaissait alors entièrement — c'est-à-dire que
        // la garantie d'accessibilité n'était vérifiable nulle part, alors
        // qu'elle est justement le motif d'être de ce composant.
        //
        // On s'en tient donc aux attributs, qui ont le même sens partout :
        // `hidden` (HTML) et `aria-hidden` (ARIA) sont les deux seules
        // manières standard de retirer un élément du parcours de tabulation.
        (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        focusInside(last, panel);
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        focusInside(first, panel);
      }
    },
    [busy, onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4"
      onMouseDown={(e) => {
        // Clic sur le fond (et non sur la boîte) => fermeture
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`bg-white rounded-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto ${className}`}
      >
        <h4 id={titleId} className="text-lg font-bold text-slate-900 mb-4">
          {title}
        </h4>
        {children}
      </div>
    </div>
  );
};

export default Modal;
