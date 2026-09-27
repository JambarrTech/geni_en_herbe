import React from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';

/**
 * Primitives d'interface partagées par les trois apps.
 *
 * Rôle : garantir la coherence visuelle (rayons, ombres, echelles de typo,
 * couleurs) sans dupliquer les mêmes classes dans chaque page. C voluntarily
 * minimal : seulement ce qui revient dans les trois apps.
 *
 * Regles de composition retenues
 * ------------------------------
 * - Rayons : 12px (xl) cartes, 8px (lg) champs et boutons, pilule pour les
 *   badges. Un seul rayon par element, jamais deux.
 * - Ombres : `sm` au repos, `md` au survol. Les degrades et le flou d'arrière
 *   plan sont exclus (lisibilite sur videoprojecteur, rendu sur ecrans
 *   tactiles).
 * - Ambre (#F59E0B) : reserve aux distinctions (vainqueur, bonus). Jamais
 *   decoratif.
 * - Bleu #0B3B82 : action principale. #2563EB : survol.
 */

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

type SurfaceTone = 'default' | 'raised' | 'subtle' | 'outline';
type SurfaceRadius = 'sm' | 'md' | 'lg';

const SURFACE_TONE: Record<SurfaceTone, string> = {
  default: 'bg-white border border-slate-200',
  raised: 'bg-white border border-slate-200 shadow-sm',
  subtle: 'bg-slate-50 border border-slate-200',
  outline: 'bg-transparent border border-slate-300',
};

const SURFACE_RADIUS: Record<SurfaceRadius, string> = {
  sm: 'rounded-lg',
  md: 'rounded-xl',
  lg: 'rounded-2xl',
};

export interface SurfaceProps {
  as?: 'div' | 'section' | 'article' | 'aside' | 'li';
  tone?: SurfaceTone;
  radius?: SurfaceRadius;
  /** Ombre au survol : reserve aux elements cliquables. */
  hoverable?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/** Carte / section de base. Remplace les `bg-white/10 backdrop-blur rounded-3xl`. */
export const Surface: React.FC<SurfaceProps> = ({
  as: Tag = 'div',
  tone = 'raised',
  radius = 'lg',
  hoverable = false,
  className = '',
  children,
  ...rest
}) => (
  <Tag
    className={[
      SURFACE_TONE[tone],
      SURFACE_RADIUS[radius],
      hoverable
        ? 'transition-[box-shadow,border-color] duration-150 hover:shadow-md hover:border-slate-300'
        : '',
      className,
    ]
      .filter(Boolean)
      .join(' ')}
    {...rest}
  >
    {children}
  </Tag>
);

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-[#0B3B82] text-white shadow-sm hover:bg-[#2563EB] hover:shadow ' +
    'active:bg-[#0B3B82]',
  secondary:
    'bg-white text-slate-700 border border-slate-300 shadow-sm ' +
    'hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger:
    'bg-white text-rose-700 border border-rose-200 shadow-sm ' +
    'hover:bg-rose-50 hover:border-rose-300 active:bg-rose-100',
  accent:
    'bg-amber-500 text-slate-900 shadow-sm hover:bg-amber-400 hover:shadow active:bg-amber-600',
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0B3B82] focus-visible:ring-offset-2';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={[
      'inline-flex select-none items-center justify-center font-semibold',
      'transition-[background-color,border-color,box-shadow,transform] duration-150',
      'active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0',
      'disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none disabled:active:translate-y-0',
      BUTTON_VARIANT[variant],
      BUTTON_SIZE[size],
      fullWidth ? 'w-full' : '',
      FOCUS_RING,
      className,
    ]
      .filter(Boolean)
      .join(' ')}
    {...rest}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'primary' | 'accent' | 'success' | 'danger';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  primary: 'bg-[#0B3B82]/8 text-[#0B3B82] border-[#0B3B82]/20',
  accent: 'bg-amber-50 text-amber-800 border-amber-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  danger: 'bg-rose-50 text-rose-700 border-rose-200',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  className?: string;
  children?: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  className = '',
  children,
  ...rest
}) => (
  <span
    className={[
      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
      'text-[11px] font-semibold uppercase tracking-wide',
      BADGE_TONE[tone],
      className,
    ]
      .filter(Boolean)
      .join(' ')}
    {...rest}
  >
    {children}
  </span>
);

// ---------------------------------------------------------------------------
// Titres de section
// ---------------------------------------------------------------------------

export interface SectionTitleProps {
  /** Niveau de titre semantique : 1 = titre de page, 2 = section, 3 = bloc. */
  level?: 1 | 2 | 3;
  title: string;
  description?: string;
  className?: string;
  children?: React.ReactNode;
}

const TITLE_SIZE = {
  1: 'text-xl sm:text-2xl',
  2: 'text-base sm:text-lg',
  3: 'text-sm',
} as const;

const TITLE_WEIGHT = { 1: 'font-bold', 2: 'font-semibold', 3: 'font-semibold' } as const;

export const SectionTitle: React.FC<SectionTitleProps> = ({
  level = 2,
  title,
  description,
  className = '',
  children,
}) => {
  const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1';
  return (
    <div className={['flex flex-wrap items-start justify-between gap-3', className].join(' ')}>
      <div className="min-w-0">
        <Tag
          className={[
            'tracking-tight text-slate-900 text-balance',
            TITLE_SIZE[level],
            TITLE_WEIGHT[level],
          ].join(' ')}
        >
          {title}
        </Tag>
        {description && (
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Donnee chiffree
// ---------------------------------------------------------------------------

export interface StatProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'primary' | 'accent';
  className?: string;
}

const STAT_VALUE = {
  default: 'text-slate-900',
  primary: 'text-[#0B3B82]',
  accent: 'text-amber-600',
} as const;

export const Stat: React.FC<StatProps> = ({
  label,
  value,
  hint,
  tone = 'default',
  className = '',
}) => (
  <div className={className}>
    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {label}
    </div>
    <div className={['mt-1 text-2xl font-bold tabular-nums tracking-tight', STAT_VALUE[tone]].join(' ')}>
      {value}
    </div>
    {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// Etats
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}) => (
  <div
    className={[
      'flex flex-col items-center justify-center px-6 py-12 text-center',
      className,
    ].join(' ')}
  >
    {Icon && (
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
    )}
    <p className="text-sm font-semibold text-slate-700">{title}</p>
    {description && (
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-slate-500 text-balance">
        {description}
      </p>
    )}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Une erreur est survenue',
  message,
  onRetry,
  retryLabel = 'Réessayer',
  className = '',
}) => (
  <div
    role="alert"
    className={[
      'flex flex-col items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3.5',
      className,
    ].join(' ')}
  >
    <div className="min-w-0">
      <p className="text-[13px] font-semibold text-rose-900">{title}</p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-rose-800">{message}</p>
    </div>
    {onRetry && (
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Confirmation d'action
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Conséquence énoncée sans détour : c'est ce qui rend la décision éclairée. */
  message: string;
  /** Contenu additionnel : score en cours, nom du compte visé, consequences… */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` pour une action irréversible, `primary` sinon. */
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation d'une action à conséquence.
 *
 * Remplace les `window.confirm` de l'interface.
 *
 * Pourquoi ce n'était pas un détail cosmétique :
 *  - la boîte native s'affiche dans la langue du navigateur, au milieu d'une
 *    interface en français, et son rendu change d'une machine à l'autre ;
 *  - elle n'affiche qu'une chaîne : impossible d'y montrer l'état qui rend la
 *    décision éclairée (le score qu'on s'apprête à figer, le nom du compte
 *    qu'on supprime). Or c'est précisément ce qui fait la différence entre
 *    un clic reflexe et une décision réfléchie ;
 *  - le piège de tabulation et la restitution du focus n'y sont pas maîtrisés,
 *    alors qu'on y est sur un écran de service, en direct.
 *
 * Le `<dialog>` natif est préféré à une `div` superposée : le comportement de
 * focus et le rôle modal sont fournis par le navigateur.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  children,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  /**
   * L'événement natif `close` couvre les DEUX issues possibles : Échap, et
   * notre propre bouton d'annulation.
   *
   * On appelle donc `onCancel` sans condition. Un premier jet le gardait par
   * `if (open) return`, ce qui était un piège : à la fermeture par Échap, `open`
   * valait encore `true`, l'appel était ignoré, l'état ne changeait pas, et le
   * dialogue restait fermé alors que React le croyait ouvert — sans aucune
   * action pour le rouvrir.
   *
   * Appeler `onCancel` deux fois n'a pas de conséquence : c'est un `setState`
   * vers la même valeur, que React neutralise.
   *
   * La restauration du focus, elle, est fournie par le navigateur pour
   * `<dialog>` en mode modal : inutile de la réimplémenter.
   */
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => onCancel();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onCancel]);

  const handleCancel = () => {
    if (busy) return;
    onCancel();
    ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      className={[
        'm-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-0',
        'shadow-2xl backdrop:bg-slate-900/40',
        // Le fond n'est pas NRé de flou : le flou de fond coûte cher sur les
        // écrans de projection et n'apporte rien à la lisibilité.
      ].join(' ')}
      // Un clic sur le fond annule, comme dans le reste de l'application.
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div className="p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              tone === 'danger' ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-[#2563EB]',
            ].join(' ')}
          >
            {tone === 'danger' ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <HelpCircle className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-base font-bold text-slate-900">
              {title}
            </h2>
            <p id="confirm-dialog-message" className="mt-1 text-[13px] leading-relaxed text-slate-600">
              {message}
            </p>
          </div>
        </div>

        {children && <div className="mt-3">{children}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'En cours…' : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
};

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

/** Squelette de chargement, respecte `prefers-reduced-motion`. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = 'h-4 w-32' }) => (
  <div
    aria-hidden="true"
    className={['animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none', className].join(
      ' '
    )}
  />
);

export interface LoadingBlockProps {
  label?: string;
  className?: string;
  rows?: number;
}

export const LoadingBlock: React.FC<LoadingBlockProps> = ({
  label = 'Chargement…',
  className = '',
  rows = 3,
}) => (
  <div
    role="status"
    aria-live="polite"
    className={['space-y-3', className].join(' ')}
  >
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }).map((_, i) => (
      <Skeleton key={i} className={i === 0 ? 'h-5 w-2/5' : 'h-3.5 w-full'} />
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Champs de formulaire
// ---------------------------------------------------------------------------

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Field: React.FC<FieldProps> = ({
  id,
  label,
  hint,
  error,
  required,
  className = '',
  children,
}) => {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-rose-600" aria-hidden="true">
            *
          </span>
        )}
        {!required && <span className="ml-1.5 text-slate-400">(facultatif)</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
};

/** Classes d'un champ, à réutiliser sur `<input>` / `<select>` / `<textarea>`. */
export const fieldClass = (
  invalid = false,
  extra = ''
): string =>
  [
    'w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900',
    'placeholder:text-slate-400',
    'transition-[border-color,box-shadow] duration-150',
    'focus:outline-none focus:ring-2 focus:ring-offset-0',
    'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
    invalid
      ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-500/20'
      : 'border-slate-300 hover:border-slate-400 focus:border-[#0B3B82] focus:ring-[#0B3B82]/20',
    extra,
  ].join(' ');
