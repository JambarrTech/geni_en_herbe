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
        (el) => el.offsetParent !== null || el === document.activeElement
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
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
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
