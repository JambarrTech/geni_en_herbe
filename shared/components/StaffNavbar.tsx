import React from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { useLive } from '../context/LiveContext.tsx';
import { AeerksLogo } from './AeerksLogo.tsx';
import {
  Trophy,
  ShieldCheck,
  Tv,
  LogOut,
  LogIn,
} from 'lucide-react';

interface StaffNavbarProps {
  activeView: 'live' | 'jury' | 'admin' | 'login';
  appBase: '/jury' | '/admin';
}

export const StaffNavbar: React.FC<StaffNavbarProps> = ({ activeView, appBase }) => {
  const { user, logout, isAdmin, isJury } = useAuth();
  const { isConnected } = useLive();

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Left: Logo and Brand */}
        <a
          id="nav-brand-button"
          href="/"
          className="flex items-center gap-3 cursor-pointer group min-w-0"
        >
          <AeerksLogo size="md" className="shrink-0" />
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-bold tracking-widest text-[#0B3B82] uppercase">
                AEERKS
              </span>
              <span className="inline-block w-1 h-1 rounded-full bg-slate-300 shrink-0" />
              <span className="text-[11px] font-semibold text-slate-500 uppercase truncate">
                Keur Salla Mbatta
              </span>
            </div>
            <h1 className="text-sm sm:text-base font-bold text-slate-900 leading-tight group-hover:text-[#2563EB] transition-colors truncate">
              Journée d'Excellence <span className="text-[#0B3B82]">— Génie en Herbe</span>
            </h1>
          </div>
        </a>

        {/* Center / Navigation items */}
        <nav className="hidden md:flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl border border-slate-200/60 shrink-0">
          <a
            id="nav-tab-live"
            href="/"
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeView === 'live'
                ? 'bg-white text-[#0B3B82] shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            }`}
          >
            <Tv className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Écran Live Public</span>
          </a>

          {(isJury || !user) && (
            <a
              id="nav-tab-jury"
              href="/jury"
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeView === 'jury'
                  ? 'bg-white text-[#0B3B82] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <Trophy className="w-3.5 h-3.5 text-amber-500" />
              <span>Espace Jury</span>
            </a>
          )}

          {(isAdmin || !user) && (
            <a
              id="nav-tab-admin"
              href="/admin"
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeView === 'admin'
                  ? 'bg-white text-[#0B3B82] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#0B3B82]" />
              <span>Administration</span>
            </a>
          )}
        </nav>

        {/* Right: Live indicator & User profile */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Live sync pulse */}
          <div
            id="live-status-pill"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border bg-slate-50 text-slate-700 border-slate-200"
            title={isConnected ? 'Connecté au serveur en direct' : 'Reconnexion au serveur...'}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="hidden sm:inline">
              {isConnected ? 'Direct' : 'Déconnecté'}
            </span>
          </div>

          {user ? (
            <div className="flex items-center gap-2">
              <div className="hidden lg:flex flex-col text-right">
                <span className="text-xs font-bold text-slate-800 leading-none">
                  {user.name}
                </span>
                <span className="text-[10px] text-[#0B3B82] font-semibold mt-0.5">
                  {user.role === 'ADMIN' ? 'Comité d\'Organisation (Admin)' : 'Membre du Jury'}
                </span>
              </div>
              <button
                id="btn-logout"
                onClick={logout}
                title="Se déconnecter"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Déconnexion</span>
              </button>
            </div>
          ) : (
            <a
              id="btn-login-header"
              href={appBase}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-[#0B3B82] hover:bg-[#2563EB] shadow-xs transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Connexion</span>
            </a>
          )}
        </div>
      </div>
    </header>
  );
};