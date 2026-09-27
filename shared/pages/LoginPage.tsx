import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { errorMessage } from '../lib/api.ts';
import { APP_CONFIG } from '../lib/config.ts';
import { AeerksLogo } from '../components/AeerksLogo.tsx';
import {
  Lock,
  Mail,
  ArrowRight,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Tv,
  Sparkles,
  Eye,
  EyeOff,
  LogIn,
} from 'lucide-react';

/** Édition affichée : issue de la configuration, plus de « 2026 » en dur. */
const EDITION = APP_CONFIG.DEFAULT_EVENT_EDITION.replace(/^Édition\s+/i, '').trim();

export const LoginPage: React.FC = () => {
  const { login, loginWithGoogle } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quelle action est en cours : le spinner doit être sur le bouton réellement
  // pressé, pas sur les deux.
  const [pending, setPending] = useState<'email' | 'google' | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending('email');

    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err, 'Identifiants incorrects'));
    } finally {
      setPending(null);
    }
  };

  const handleGoogleLogin = async () => {
    if (pending) return;
    setError(null);
    setPending('google');
    try {
      await loginWithGoogle();
    } catch (err) {
      setError(errorMessage(err, 'Échec de connexion Google'));
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;

  return (
    <div className="min-h-[calc(100vh-4rem)] relative flex items-center justify-center p-4 sm:p-6 lg:p-10 bg-gradient-to-br from-slate-900 via-[#071E42] to-[#0A2558] overflow-y-auto">
      {/* Ambiance : grille + halos décoratifs */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(#2563EB_1px,transparent_1px)] [background-size:26px_26px] opacity-15 pointer-events-none"
      />
      <div
        aria-hidden="true"
        className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#2563EB]/20 blur-3xl pointer-events-none"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-amber-500/10 blur-3xl pointer-events-none"
      />

      <main className="relative z-10 w-full max-w-5xl my-auto">
        <div className="grid lg:grid-cols-[1fr_1.1fr] overflow-hidden rounded-3xl border border-white/15 shadow-2xl shadow-black/40 bg-white/5">
          {/* ============ PANNEAU IDENTITÉ ============ */}
          <aside className="relative flex flex-col justify-between gap-8 p-8 sm:p-10 bg-gradient-to-br from-[#0B3B82]/90 to-[#071E42] border-b lg:border-b-0 lg:border-r border-white/10 overflow-hidden">
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(#2563EB_1px,transparent_1px)] [background-size:18px_18px] opacity-20 pointer-events-none"
            />

            <div className="relative flex items-center gap-4">
              <AeerksLogo size="lg" priority />
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-200">
                  AEERKS
                </div>
                <div className="text-lg font-black text-white leading-tight">
                  Journée d'Excellence
                </div>
                <div className="text-xs font-semibold text-blue-300">Génie en Herbe</div>
              </div>
            </div>

            {/* Sur mobile le panneau reste visible (il était masqué en
                `hidden lg:flex`) : c'est là que se trouve l'identité AEERKS,
                qui disparaissait purement et simplement sur téléphone. */}
            <div className="relative space-y-5">
              <div>
                <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-400/15 border border-amber-300/30 text-amber-300 text-[11px] font-black uppercase tracking-widest">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  Plateforme Officielle {EDITION}
                </span>
                <h2 className="mt-4 text-xl sm:text-2xl font-black text-white leading-snug">
                  Les coulisses de la compétition, à portée de main.
                </h2>
              </div>

              <ul className="hidden sm:grid sm:gap-3.5 sm:text-sm">
                <li className="flex items-start gap-3">
                  <span className="w-8 h-8 shrink-0 rounded-xl bg-[#2563EB]/25 border border-[#2563EB]/30 flex items-center justify-center">
                    <ShieldCheck className="w-4 h-4 text-blue-300" aria-hidden="true" />
                  </span>
                  <span className="text-blue-100/90">
                    <span className="block font-bold text-white">Arbitrage &amp; scores</span>
                    Chrono maîtrisé et résultats signés par le jury
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-8 h-8 shrink-0 rounded-xl bg-[#2563EB]/25 border border-[#2563EB]/30 flex items-center justify-center">
                    <Tv className="w-4 h-4 text-blue-300" aria-hidden="true" />
                  </span>
                  <span className="text-blue-100/90">
                    <span className="block font-bold text-white">Diffusion en direct</span>
                    Tout s'affiche instantanément sur l'écran public
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-8 h-8 shrink-0 rounded-xl bg-amber-400/15 border border-amber-300/30 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-amber-300" aria-hidden="true" />
                  </span>
                  <span className="text-blue-100/90">
                    <span className="block font-bold text-white">Traçabilité totale</span>
                    Chaque décision est consignée au journal d'audit
                  </span>
                </li>
              </ul>
            </div>

            <p className="relative text-[11px] leading-relaxed text-blue-300/70">
              Amicale des Élèves et Étudiants Ressortissants de Keur Salla Mbatta
            </p>
          </aside>

          {/* ============ FORMULAIRE ============ */}
          <div className="bg-white p-6 sm:p-10">
            <div className="text-center lg:text-left mb-8">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[#0B3B82] mb-2">
                Espace de Connexion
              </div>
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">Bienvenue</h2>
              <p className="text-sm text-slate-500 mt-1">
                Accédez à votre espace jury ou à l'administration de la compétition.
              </p>
            </div>

            {error && (
              <div
                id="login-error-alert"
                // role="alert" : sans lui, l'erreur n'est pas annoncée et
                // l'utilisateur clique pour rien.
                role="alert"
                className="mb-6 p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-3"
              >
                <AlertCircle
                  className="w-4 h-4 shrink-0 mt-0.5 text-rose-600"
                  aria-hidden="true"
                />
                <span>{error}</span>
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="space-y-4"
              noValidate={false}
              aria-busy={busy}
              aria-describedby={error ? 'login-error-alert' : undefined}
            >
              <div>
                <label
                  htmlFor="email"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  Adresse email
                </label>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400"
                  >
                    <Mail className="w-4 h-4" />
                  </span>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    autoFocus
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={busy}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@aeerks.sn"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-300 text-slate-900 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  Mot de passe
                </label>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400"
                  >
                    <Lock className="w-4 h-4" />
                  </span>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    disabled={busy}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-10 pr-11 py-2.5 rounded-xl border border-slate-300 text-slate-900 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent transition-all disabled:bg-slate-50 disabled:text-slate-500"
                  />
                  {/* Afficher/masquer : absent auparavant, alors que la saisie
                      du mot de passe est l'action la plus fréquente de cet
                      écran (fautes de frappe sur clavier AZERTY/QWERTY). */}
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    disabled={busy}
                    aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    aria-pressed={showPassword}
                    title={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 disabled:opacity-40 rounded-r-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563EB]"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <Eye className="w-4 h-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <button
                id="btn-submit-login"
                type="submit"
                disabled={busy}
                className="w-full mt-2 py-3 px-4 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white font-semibold text-sm shadow-md shadow-blue-900/10 flex items-center justify-center gap-2 transition-all disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
              >
                {pending === 'email' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Vérification en cours...</span>
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    <span>Accéder à la plateforme</span>
                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </>
                )}
              </button>
            </form>

            <div className="flex items-center gap-3 my-6" aria-hidden="true">
              <span className="h-px flex-1 bg-slate-200" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                ou
              </span>
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              id="btn-google-login"
              type="button"
              disabled={busy}
              onClick={handleGoogleLogin}
              className="w-full py-2.5 px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
            >
              {pending === 'google' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Connexion en cours...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span>Connexion avec Google</span>
                </>
              )}
            </button>

            <div className="text-center mt-6">
              <a
                id="btn-return-live"
                href="/"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B3B82] hover:text-[#2563EB] transition-colors rounded px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                <ArrowRight className="w-3.5 h-3.5 rotate-180" aria-hidden="true" />
                Retourner à l'écran Live public
              </a>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-blue-200/60 mt-6">
          Plateforme Officielle AEERKS • Journée d'Excellence {EDITION} — Keur Salla Mbatta, Sénégal
        </p>
      </main>
    </div>
  );
};

export default LoginPage;
