import React from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { useLive } from '../context/LiveContext.tsx';
import { AeerksLogo } from './AeerksLogo.tsx';
import { Trophy, ShieldCheck, Tv, LogOut, LogIn, ChevronDown } from 'lucide-react';

interface StaffNavbarProps {
  activeView: 'live' | 'jury' | 'admin' | 'login';
  appBase: '/jury' | '/admin';
}

interface NavItem {
  id: 'live' | 'jury' | 'admin';
  href: string;
  label: string;
  shortLabel: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  iconClass: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'live',
    href: '/',
    label: 'Écran Live Public',
    shortLabel: 'Live',
    Icon: Tv,
    iconClass: 'text-[#2563EB]',
  },
  {
    id: 'jury',
    href: '/jury',
    label: 'Espace Jury',
    shortLabel: 'Jury',
    Icon: Trophy,
    iconClass: 'text-amber-500',
  },
  {
    id: 'admin',
    href: '/admin',
    label: 'Administration',
    shortLabel: 'Admin',
    Icon: ShieldCheck,
    iconClass: 'text-[#0B3B82]',
  },
];

export const StaffNavbar: React.FC<StaffNavbarProps> = ({ activeView, appBase }) => {
  const { user, logout, isAdmin, isJury } = useAuth();
  const { isConnected, lastUpdateAt } = useLive();
  const menuRef = React.useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);

  // Non connecté : on propose les trois espaces, la garde de rôle se fera à
  // l'arrivée. Connecté : on ne montre que les espaces réellement accessibles.
  const visibleItems = NAV_ITEMS.filter(
    (item) => !user || (item.id === 'live' ? true : item.id === 'jury' ? isJury : isAdmin)
  );

  const connectionLabel = isConnected ? 'Connecté au serveur en direct' : 'Connexion au serveur perdue — tentative de reconnexion';

  // Le menu est un <details> natif : l'ouverture et la fermeture au clavier
  // fonctionnent déjà. On ne synchronise que l'état visuel (l'icône et le
  // libellé), et on ferme à la navigation ou à la déconnexion.
  const closeMenu = () => {
    setMenuOpen(false);
    if (menuRef.current) menuRef.current.open = false;
  };

  // Fermeture à la sortie du focus. Sans cela, le menu reste ouvert et
  // superposé au contenu lorsqu'on tabule vers le bas de la page : sur mobile,
  // il masque alors des contrôles sans aucun moyen de le fermer au clavier.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [menuOpen]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && menuOpen) {
      event.stopPropagation();
      closeMenu();
      // Le focus revient sur le déclencheur, sinon il se perd dans le corps.
      menuRef.current?.querySelector('summary')?.focus();
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
      {/* Lien d'évitement : première tabulation, indispensable en navigation clavier */}
      <a
        href="#contenu-principal"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[#0B3B82] focus:text-white focus:text-xs focus:font-semibold focus:shadow-lg"
      >
        Aller au contenu principal
      </a>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
        {/* Marque */}
        <a
          id="nav-brand-button"
          href="/"
          className="flex items-center gap-3 group min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
        >
          <AeerksLogo size="md" priority decorative />
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-bold tracking-widest text-[#0B3B82] uppercase">
                AEERKS
              </span>
              <span className="inline-block w-1 h-1 rounded-full bg-slate-300 shrink-0" aria-hidden="true" />
              <span className="text-[11px] font-semibold text-slate-500 uppercase truncate">
                Keur Salla Mbatta
              </span>
            </div>
            <h1 className="text-sm sm:text-base font-bold text-slate-900 leading-tight group-hover:text-[#2563EB] transition-colors truncate">
              Journée d'Excellence{' '}
              <span className="text-[#0B3B82]">— Génie en Herbe</span>
            </h1>
          </div>
        </a>

        {/* Navigation — devient un bandeau défilant horizontal sur petit écran,
            là où elle était simplement masquée (donc inaccessible) en dessous
            de 768 px. */}
        <nav
          aria-label="Navigation principale"
          className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 shrink-0 max-w-full overflow-x-auto md:overflow-visible"
        >
          {visibleItems.map(({ id, href, label, shortLabel, Icon, iconClass }) => {
            const isActive = activeView === id;
            return (
              <a
                key={id}
                id={`nav-tab-${id}`}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 sm:px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 ${
                  isActive
                    ? 'bg-white text-[#0B3B82] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${iconClass}`} aria-hidden="true" />
                <span className="md:hidden">{shortLabel}</span>
                <span className="hidden md:inline">{label}</span>
              </a>
            );
          })}
        </nav>

        {/* État temps réel + compte */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div
            id="live-status-pill"
            role="status"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-slate-50 text-slate-700 border-slate-200"
            title={connectionLabel}
          >
            <span
              aria-hidden="true"
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            {/* Le libellé est masqué visuellement sous 640 px, mais reste lu. */}
            <span className="sr-only">{connectionLabel}</span>
            <span className="hidden sm:inline" aria-hidden="true">
              {isConnected ? 'Direct' : 'Déconnecté'}
            </span>
            {lastUpdateAt != null && (
              <span className="sr-only">
                {`, dernière mise à jour il y a ${Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000))} seconde(s)`}
              </span>
            )}
          </div>

          {user ? (
            <div className="flex items-center gap-2">
              <div className="hidden lg:flex flex-col text-right min-w-0">
                <span className="text-xs font-bold text-slate-800 leading-none truncate max-w-[12rem]">
                  {user.name}
                </span>
                <span className="text-[10px] text-[#0B3B82] font-semibold mt-0.5">
                  {user.role === 'ADMIN' ? 'Comité d\'Organisation (Admin)' : 'Membre du Jury'}
                </span>
              </div>
              <button
                id="btn-logout"
                type="button"
                onClick={logout}
                title="Se déconnecter"
                aria-label={`Se déconnecter (${user.name})`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1"
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Déconnexion</span>
              </button>
            </div>
          ) : (
            <a
              id="btn-login-header"
              href={appBase}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#0B3B82] hover:bg-[#2563EB] shadow-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
            >
              <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Connexion</span>
            </a>
          )}

          {/* Sélecteur de profil mobile : le nom de l'utilisateur et les
              destinations sont masqués sur petit écran, ce menu les rend
              accessibles sans multiplier les barres. */}
          <details
            ref={menuRef}
            className="md:hidden relative"
            onKeyDown={onMenuKeyDown}
            // `toggle` est l'événement natif de <details> : il se déclenche
            // quelle que soit la cause de l'ouverture (clic, Entree, espace).
            // Passer par lui evite de dupliquer cette logique.
            onToggle={(event) => setMenuOpen(event.currentTarget.open)}
          >
            <summary
              className="list-none p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
              aria-expanded={menuOpen}
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </summary>
            <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-slate-200 bg-white shadow-lg p-1.5 z-50">
              {user && (
                <div className="px-3 py-2 border-b border-slate-100 mb-1">
                  <div className="text-xs font-bold text-slate-900 truncate">{user.name}</div>
                  <div className="text-[10px] text-[#0B3B82] font-semibold mt-0.5">
                    {user.role === 'ADMIN' ? 'Comité d\'Organisation' : 'Membre du Jury'}
                  </div>
                </div>
              )}
              {/* BUG CORRIGE : ce menu itérait sur NAV_ITEMS au lieu de
                  visibleItems. La garde de rôle, appliquée plus haut, était donc
                  contournée sur petit écran : un membre du jury y voyait le lien
                  « Administration », sur lequel il tombait ensuite sur une
                  erreur 403. Le même filtre doit governer les deux rendus, sinon
                  l'interface promet un accès que le serveur refuse. */}
              {visibleItems.map(({ id, href, label, Icon, iconClass }) => (
                <a
                  key={id}
                  href={href}
                  aria-current={activeView === id ? 'page' : undefined}
                  onClick={closeMenu}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
                    activeView === id
                      ? 'bg-slate-100 text-[#0B3B82]'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${iconClass}`} aria-hidden="true" />
                  {label}
                </a>
              ))}
              {user && (
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    logout();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  Se déconnecter
                </button>
              )}
            </div>
          </details>
        </div>
      </div>
    </header>
  );
};

export default StaffNavbar;
