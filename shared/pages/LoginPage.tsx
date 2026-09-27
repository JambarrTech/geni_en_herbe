import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { errorMessage } from '../lib/api.ts';
import { APP_CONFIG } from '../lib/config.ts';
import { AeerksLogo } from '../components/AeerksLogo.tsx';
import {
  Lock,
  Mail,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  LogIn,
  ArrowRight,
} from 'lucide-react';

/** Édition affichée dans le pied de page : issue de la configuration. */
const EDITION = APP_CONFIG.DEFAULT_EVENT_EDITION.replace(/^Édition\s+/i, '').trim();

/**
 * Écran de connexion.
 *
 * Contexte : ce composant n'est rendu QUE lorsque l'utilisateur n'est pas
 * authentifié (voir `AppShell` de /jury et /admin). Les tableaux de bord
 * jury/admin ne s'affichent que dans le cas inverse : les deux sont mutuellement
 * exclusifs, aucune modification ici ne peut donc affecter leur apparence.
 *
 * Parti pris visuel
 * ----------------
 * Fond clair. La barre de navigation juste au-dessus est blanche, et les écrans
 * jury/admin reposent sur `bg-slate-50` : l'ancien panneau bleu nuit sous une
 * barre blanche créait une cassure, et empilait quatre couches décoratives
 * (dégradé + trame de points + deux halos flous) sur un formulaire qui n'en a
 * pas besoin. On garde une seule touche de teinte AEERKS, en fond de page.
 */
export const LoginPage: React.FC = () => {
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err, 'Identifiants incorrects'));
    } finally {
      setPending(false);
    }
  };

  const errorId = 'login-error-alert';

  return (
    <div className="relative min-h-[calc(100vh-4rem)] w-full overflow-hidden bg-slate-50 px-4 py-10 sm:px-6 sm:py-14 lg:py-20">
      {/* Teinte de fond : une seule, très légère, pour rattacher la page à la
          charte sans concurrencer le formulaire. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[26rem] bg-[radial-gradient(60rem_22rem_at_50%_-8rem,rgba(11,59,130,0.09),transparent_70%)]"
      />

      <div className="relative z-10 mx-auto w-full max-w-[26rem]">
        {/* ---------- Identité ---------- */}
        <div className="mb-7 flex flex-col items-center text-center">
          <AeerksLogo size={44} priority className="mb-4" />
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0B3B82]">
            AEERKS
          </p>
          <p className="mt-1.5 text-sm font-semibold leading-snug text-slate-700">
            Journée d'Excellence
            <span className="mx-1.5 text-slate-300" aria-hidden="true">
              —
            </span>
            <span className="text-[#0B3B82]">Génie en Herbe</span>
          </p>
        </div>

        {/* ---------- Carte ---------- */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          {/* Un seul titre : l'ancien doublon « Espace de Connexion » +
              « Bienvenue » disait deux fois la même chose. */}
          <div className="mb-6">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-[1.375rem]">
              Connexion
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
              Accédez à votre espace jury ou à l'administration de la compétition.
            </p>
          </div>

          {error && (
            <div
              id={errorId}
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-[13px] leading-snug text-rose-800"
            >
              <AlertCircle
                className="mt-px h-4 w-4 shrink-0 text-rose-600"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* ---------- Email ---------- */}
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-[13px] font-medium text-slate-700"
              >
                Adresse email
              </label>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  required
                  autoComplete="email"
                  autoFocus
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={pending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@aeerks.sn"
                  className={`w-full rounded-lg border py-2.5 pl-10 pr-3.5 text-sm text-slate-900
                    placeholder:text-slate-400
                    transition-[border-color,box-shadow] duration-150
                    focus:outline-none focus:ring-2 focus:ring-offset-0
                    disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500
                    ${
                      error
                        ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-500/20'
                        : 'border-slate-300 hover:border-slate-400 focus:border-[#0B3B82] focus:ring-[#0B3B82]/20'
                    }`}
                />
              </div>
            </div>

            {/* ---------- Mot de passe ---------- */}
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-[13px] font-medium text-slate-700"
              >
                Mot de passe
              </label>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  disabled={pending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className={`w-full rounded-lg border py-2.5 pl-10 pr-11 text-sm text-slate-900
                    placeholder:text-slate-400
                    transition-[border-color,box-shadow] duration-150
                    focus:outline-none focus:ring-2 focus:ring-offset-0
                    disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500
                    ${
                      error
                        ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-500/20'
                        : 'border-slate-300 hover:border-slate-400 focus:border-[#0B3B82] focus:ring-[#0B3B82]/20'
                    }`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={pending}
                  aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  aria-pressed={showPassword}
                  title={showPassword ? 'Masquer' : 'Afficher'}
                  className="absolute right-0 top-0 flex h-full w-11 items-center justify-center
                    rounded-r-lg text-slate-400 transition-colors duration-150
                    hover:text-slate-600
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0B3B82]
                    disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {/* ---------- Action principale ---------- */}
            <button
              id="btn-submit-login"
              type="submit"
              disabled={pending}
              className="group mt-2 flex w-full items-center justify-center gap-2 rounded-lg
                bg-[#0B3B82] px-4 py-2.5 text-sm font-semibold text-white
                shadow-sm
                transition-[background-color,box-shadow,transform] duration-150
                hover:bg-[#2563EB] hover:shadow
                active:translate-y-px
                focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0B3B82] focus-visible:ring-offset-2
                disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:active:translate-y-0"
            >
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Vérification en cours…</span>
                </>
              ) : (
                <>
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  <span>Accéder à la plateforme</span>
                  <ArrowRight
                    className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </>
              )}
            </button>
          </form>

          <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
            Connexion réservée aux membres du jury et au comité d'organisation.
          </p>
        </div>

        {/* ---------- Pied de page ---------- */}
        <p className="mt-6 text-balance text-center text-xs leading-relaxed text-slate-400">
          Plateforme Officielle AEERKS
          <span className="px-1.5" aria-hidden="true">
            ·
          </span>
          Journée d'Excellence {EDITION}
          <span className="px-1.5" aria-hidden="true">
            ·
          </span>
          Keur Salla Mbatta, Sénégal
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
