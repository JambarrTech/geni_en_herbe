import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { errorMessage } from '../lib/api.ts';
import { APP_CONFIG } from '../lib/config.ts';
import {
  Lock,
  Mail,
  ArrowRight,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  LogIn,
} from 'lucide-react';

/** Édition affichée dans le pied de page : issue de la configuration. */
const EDITION = APP_CONFIG.DEFAULT_EVENT_EDITION.replace(/^Édition\s+/i, '').trim();

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

  const busy = pending;

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

      <main className="relative z-10 w-full max-w-md my-auto">
        {/* Panneau identité retiré : la grille à deux colonnes qu'il occupait
            n'a plus lieu d'être, le formulaire est seul et centré. */}
        <div className="bg-white p-6 sm:p-8 rounded-3xl shadow-2xl shadow-black/40 ring-1 ring-white/15">
          <div className="text-center mb-8">
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
                {pending ? (
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
        </div>

        <p className="text-center text-xs text-blue-200/60 mt-6">
          Plateforme Officielle AEERKS • Journée d'Excellence {EDITION} — Keur Salla Mbatta, Sénégal
        </p>
      </main>
    </div>
  );
};

export default LoginPage;
