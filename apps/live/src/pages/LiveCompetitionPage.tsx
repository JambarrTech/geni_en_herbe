import React, { useCallback, useEffect, useState } from 'react';
import { useLive } from '@shared/context/LiveContext.tsx';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { AeerksLogo } from '@shared/components/AeerksLogo.tsx';
import confetti from 'canvas-confetti';
import {
  Trophy,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Maximize,
} from 'lucide-react';

/** Ancienneté d'une donnée, en français, de façon compacte. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export const LiveCompetitionPage: React.FC = () => {
  const { liveState, timerLeft, timerRunning, isConnected, lastUpdateAt } = useLive();
  const [showRankings, setShowRankings] = useState(true);

  // L'horloge du pied de page doit avancer même sans nouveau message WebSocket,
  // sinon l'âge affiché resterait figé.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const activeMatch = liveState?.activeMatch;
  const rankings = liveState?.rankings || [];
  const resultsPublished = liveState?.resultsPublished;
  const eventName = liveState?.event?.name ?? null;

  const connectionLabel = isConnected
    ? 'Connecté au serveur en direct'
    : 'Connexion au serveur perdue — reconnexion en cours';

  // Plein écran pour vidéoprojecteur.
  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, []);

  // Trigger celebration confetti when results are published
  useEffect(() => {
    if (resultsPublished) {
      try {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 },
          colors: ['#0B3B82', '#2563EB', '#F59E0B', '#10B981'],
        });
      } catch (e) {
        // Le confetti est décoratif : un échec (contexte sans animation,
        // navigateur restreint) ne doit jamais interrompre la diffusion.
        console.warn('Confetti indisponible:', e);
      }
    }
  }, [resultsPublished]);

  const currentQ = activeMatch?.currentQuestion;

  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-900 via-[#071E42] to-[#0A2558] text-white flex flex-col p-4 sm:p-6 lg:p-8 relative">
      {/* `overflow-hidden` ici tronquait le bas de l'écran sur un projecteur bas
          ou en format portrait, sans aucun moyen de faire défiler. On défile
          verticalement et on coupe seulement le débordement horizontal. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(#2563EB_1px,transparent_1px)] [background-size:24px_24px] opacity-15 pointer-events-none"
      />

      {/* En-tête : identité AEERKS + état de la connexion.
          L'écran public n'affichait aucune marque AEERKS. */}
      <header className="relative z-10 flex items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-0">
          <AeerksLogo size="sm" priority decorative />
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-300">
              AEERKS
            </div>
            <div className="text-sm sm:text-base font-black text-white leading-tight truncate">
              Journée d'Excellence <span className="text-blue-300">— Génie en Herbe</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {eventName && (
            <span className="hidden sm:inline px-3 py-1.5 rounded-full bg-white/10 border border-white/15 text-[11px] font-bold text-blue-100 max-w-[16rem] truncate">
              {eventName}
            </span>
          )}
          <div
            role="status"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold border border-white/15 bg-white/5"
            title={connectionLabel}
          >
            <span
              aria-hidden="true"
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
              }`}
            />
            <span className="sr-only">{connectionLabel}</span>
            <span aria-hidden="true" className="text-blue-100">
              {isConnected ? 'Direct' : 'Reconnexion'}
            </span>
          </div>
          {/* Plein écran : sur un vidéoprojecteur, l'opérateur ne peut pas
              mettre en plein écran manuellement de façon fiable. */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title="Passer en plein écran"
            aria-label="Passer en plein écran"
            className="p-1.5 rounded-lg border border-white/15 bg-white/5 text-blue-100 hover:bg-white/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <Maximize className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* MAIN SCREEN DYNAMICS */}
      <main
        id="contenu-principal"
        className="relative z-10 flex-1 py-6 flex flex-col justify-center max-w-7xl w-full mx-auto"
      >
        {/* CASE A: RESULTS PUBLISHED (Official Podium Section 24) */}
        {resultsPublished ? (
          <div id="screen-results-published" className="text-center py-6 animate-fade-in space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-400/20 border border-amber-300/40 text-amber-300 text-sm font-black uppercase tracking-widest">
              <Trophy className="w-5 h-5 text-amber-400" />
              <span>PALMARÈS & RÉSULTATS OFFICIELS DE L'ÉDITION</span>
            </div>

            <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
              Tableau d'Honneur de l'Excellence
            </h2>

            {/* Official Podium */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto items-end pt-8">
              {/* 2nd Place */}
              {rankings[1] && (
                <div className="bg-white/10 backdrop-blur-md rounded-3xl p-6 border border-white/20 order-2 md:order-1 flex flex-col items-center shadow-xl">
                  <div className="w-14 h-14 rounded-2xl bg-slate-300 text-slate-900 font-black text-2xl flex items-center justify-center mb-4 shadow-md">
                    2
                  </div>
                  <span className="text-xs font-bold uppercase text-slate-300">
                    Vice-Champion
                  </span>
                  <h4 className="text-xl font-bold text-white mt-1 text-center">
                    {rankings[1].teamName}
                  </h4>
                  <div className="mt-4 px-4 py-1.5 rounded-full bg-slate-400/20 border border-slate-300/30 text-white font-black text-lg">
                    {rankings[1].totalScore} points
                  </div>
                </div>
              )}

              {/* 1st Place (Winner) */}
              {rankings[0] && (
                <div className="bg-gradient-to-b from-amber-500/30 to-amber-600/10 backdrop-blur-md rounded-3xl p-8 border-2 border-amber-400 order-1 md:order-2 flex flex-col items-center shadow-2xl relative scale-105">
                  <div className="absolute -top-6 px-4 py-1 rounded-full bg-amber-400 text-slate-900 font-extrabold text-xs uppercase tracking-widest shadow-lg flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4" />
                    <span>GRAND VAINQUEUR 2026</span>
                  </div>

                  <div className="w-20 h-20 rounded-2xl bg-amber-400 text-slate-900 font-black text-4xl flex items-center justify-center mb-4 shadow-lg">
                    1
                  </div>
                  <span className="text-sm font-bold uppercase tracking-wider text-amber-300">
                    Champion du Génie en Herbe
                  </span>
                  <h3 className="text-2xl sm:text-3xl font-black text-white mt-1 text-center">
                    {rankings[0].teamName}
                  </h3>
                  <div className="mt-5 px-6 py-2 rounded-full bg-amber-400 text-slate-900 font-black text-2xl shadow-md">
                    {rankings[0].totalScore} points
                  </div>
                </div>
              )}

              {/* 3rd Place */}
              {rankings[2] && (
                <div className="bg-white/10 backdrop-blur-md rounded-3xl p-6 border border-white/20 order-3 flex flex-col items-center shadow-xl">
                  <div className="w-14 h-14 rounded-2xl bg-amber-700 text-amber-100 font-black text-2xl flex items-center justify-center mb-4 shadow-md">
                    3
                  </div>
                  <span className="text-xs font-bold uppercase text-amber-300">
                    3ème Marche
                  </span>
                  <h4 className="text-xl font-bold text-white mt-1 text-center">
                    {rankings[2].teamName}
                  </h4>
                  <div className="mt-4 px-4 py-1.5 rounded-full bg-amber-800/30 border border-amber-600/30 text-white font-black text-lg">
                    {rankings[2].totalScore} points
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : !activeMatch || activeMatch.status === 'SCHEDULED' ? (
          /* CASE B: BEFORE MATCH / INTERMISSION (Section 22) */
          <div id="screen-before-match" className="text-center py-12 space-y-6">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-200 text-xs font-bold uppercase tracking-widest">
              GÉNIE EN HERBE — JOURNÉE D'EXCELLENCE
            </div>

            <h2 className="text-3xl sm:text-5xl font-black tracking-tight text-white max-w-3xl mx-auto">
              Le concours commencera bientôt
            </h2>

            {activeMatch ? (
              <div className="max-w-2xl mx-auto mt-8 p-6 rounded-3xl bg-white/10 backdrop-blur border border-white/20 flex items-center justify-around">
                <div className="text-center">
                  <div className="text-xs font-bold text-blue-300 uppercase">Équipe A</div>
                  <div className="text-xl font-bold text-white mt-1">
                    {activeMatch.teamA?.name}
                  </div>
                </div>
                <span className="text-2xl font-black text-amber-400">VS</span>
                <div className="text-center">
                  <div className="text-xs font-bold text-blue-300 uppercase">Équipe B</div>
                  <div className="text-xl font-bold text-white mt-1">
                    {activeMatch.teamB?.name}
                  </div>
                </div>
              </div>
            ) : null}

            <p className="text-sm text-blue-200 max-w-lg mx-auto">
              Bienvenue aux équipes participantes, aux professeurs, aux membres du jury et à la communauté de Keur Salla Mbatta.
            </p>
          </div>
        ) : activeMatch.status === 'FINISHED' ? (
          /* CASE C: FIN DU MATCH (Section 22 & 23) */
          <div id="screen-match-finished" className="text-center py-8 space-y-6">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/20 border border-amber-400/30 text-amber-300 text-xs font-black uppercase tracking-widest">
              MATCH OFFICIELLEMENT TERMINÉ
            </div>

            <h2 className="text-3xl sm:text-5xl font-black text-white">
              Score Final de la Rencontre
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
              <div className="bg-white/10 backdrop-blur rounded-3xl p-8 border border-white/20">
                <div className="text-sm font-bold uppercase text-blue-300">
                  {activeMatch.teamA?.name}
                </div>
                <div className="text-6xl sm:text-7xl font-black text-white mt-2">
                  {activeMatch.scoreA}
                </div>
                <div className="text-xs text-blue-200 mt-2 font-medium">points obtenus</div>
              </div>

              <div className="bg-white/10 backdrop-blur rounded-3xl p-8 border border-white/20">
                <div className="text-sm font-bold uppercase text-blue-300">
                  {activeMatch.teamB?.name}
                </div>
                <div className="text-6xl sm:text-7xl font-black text-white mt-2">
                  {activeMatch.scoreB}
                </div>
                <div className="text-xs text-blue-200 mt-2 font-medium">points obtenus</div>
              </div>
            </div>

            {/* Respecting Section 23: Results not yet published notification */}
            <div className="p-6 rounded-2xl bg-white/5 border border-white/10 max-w-xl mx-auto text-center mt-6">
              <div className="text-base font-bold text-amber-300">
                Génie en Herbe — Délibérations en cours
              </div>
              <p className="text-xs text-blue-200/80 mt-1">
                Merci aux participants. Les résultats officiels et le classement général seront proclamés dès validation par le jury et l'administration de l'AEERKS.
              </p>
            </div>
          </div>
        ) : (
          /* CASE D: PENDANT LE MATCH (LIVE ou PAUSE - Section 21 & 22) */
          <div id="screen-match-live" className="space-y-6">
            {/* Pause Banner if Paused */}
            {activeMatch.status === 'PAUSED' && (
              <div className="p-3.5 rounded-2xl bg-amber-500/20 border border-amber-400 text-amber-200 text-center font-bold text-sm tracking-wide flex items-center justify-center gap-2 animate-pulse">
                <span>❚❚ MATCH EN PAUSE — Reprise imminente par le jury</span>
              </div>
            )}

            {/* Dual Scoreboard Display */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
              {/* Team A Giant Score */}
              <div className="md:col-span-5 bg-white/10 backdrop-blur-md rounded-3xl p-6 sm:p-8 border border-white/20 flex flex-col justify-between shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-2 h-full bg-[#2563EB]" />
                <div>
                  <span className="text-xs font-black uppercase tracking-widest text-blue-300">
                    {activeMatch.teamA?.code || 'EQ-A'}
                  </span>
                  <h3 className="text-2xl sm:text-3xl font-black text-white mt-1 truncate">
                    {activeMatch.teamA?.name}
                  </h3>
                </div>

                <div className="my-6 text-center">
                  <span className="text-7xl sm:text-8xl lg:text-9xl font-black tracking-tight text-white drop-shadow-md">
                    {activeMatch.scoreA}
                  </span>
                  <div className="text-xs font-bold uppercase tracking-widest text-blue-300 mt-1">
                    points
                  </div>
                </div>
              </div>

              {/* Central Giant Chrono */}
              <div className="md:col-span-2 flex flex-col items-center justify-center">
                <div
                  className={`w-32 h-32 sm:w-36 sm:h-36 rounded-full border-4 flex flex-col items-center justify-center shadow-2xl transition-all ${
                    timerRunning
                      ? timerLeft <= APP_CONFIG.TIMER_WARNING_SECONDS
                        ? 'border-rose-500 bg-rose-500/20 text-rose-300 animate-pulse'
                        : 'border-amber-400 bg-amber-400/10 text-amber-300'
                      : 'border-white/20 bg-white/5 text-slate-300'
                  }`}
                >
                  <span className="text-5xl sm:text-6xl font-black tracking-tighter">
                    {timerLeft}
                  </span>
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-70">
                    sec
                  </span>
                </div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-blue-200 mt-2">
                  Chronomètre
                </div>
              </div>

              {/* Team B Giant Score */}
              <div className="md:col-span-5 bg-white/10 backdrop-blur-md rounded-3xl p-6 sm:p-8 border border-white/20 flex flex-col justify-between shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-2 h-full bg-[#0B3B82]" />
                <div>
                  <span className="text-xs font-black uppercase tracking-widest text-blue-300">
                    {activeMatch.teamB?.code || 'EQ-B'}
                  </span>
                  <h3 className="text-2xl sm:text-3xl font-black text-white mt-1 truncate">
                    {activeMatch.teamB?.name}
                  </h3>
                </div>

                <div className="my-6 text-center">
                  <span className="text-7xl sm:text-8xl lg:text-9xl font-black tracking-tight text-white drop-shadow-md">
                    {activeMatch.scoreB}
                  </span>
                  <div className="text-xs font-bold uppercase tracking-widest text-blue-300 mt-1">
                    points
                  </div>
                </div>
              </div>
            </div>

            {/* Question Screen (For Audience & Candidates) */}
            {currentQ && (
              <div className="bg-white/15 backdrop-blur-lg rounded-3xl p-6 sm:p-8 border border-white/25 shadow-2xl">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-1 rounded-lg bg-[#2563EB] text-white text-xs font-black uppercase tracking-wider">
                      Question #{activeMatch.currentQuestionIndex + 1}
                    </span>
                    <span className="px-3 py-1 rounded-lg bg-white/10 border border-white/20 text-blue-200 text-xs font-bold">
                      {currentQ.categoryName}
                    </span>
                  </div>
                  <span className="px-3 py-1 rounded-lg bg-amber-400/20 border border-amber-300/40 text-amber-300 text-xs font-extrabold">
                    {currentQ.points} Points en jeu
                  </span>
                </div>

                <p className="text-2xl sm:text-3xl lg:text-4xl font-black text-white leading-relaxed tracking-wide text-center py-2">
                  « {currentQ.text} »
                </p>

                {/* QCM Options if present (Answers are NEVER shown here on live screen) */}
                {currentQ.options && Array.isArray(currentQ.options) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
                    {currentQ.options.map((opt, i) => (
                      <div
                        key={i}
                        className="p-4 rounded-2xl bg-white/10 border border-white/20 text-white text-base sm:text-lg font-bold flex items-center gap-3"
                      >
                        <span className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-sm font-black">
                          {String.fromCharCode(65 + i)}
                        </span>
                        <span>{opt}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Collapsible Rankings Drawer / Footer Ribbon */}
      <footer className="relative z-10 pt-4 border-t border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <button
            type="button"
            onClick={() => setShowRankings((v) => !v)}
            aria-expanded={showRankings}
            aria-controls="classement-tournoi"
            className="flex items-center gap-2 text-xs font-bold text-blue-300 hover:text-white transition-colors rounded px-1.5 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <span>{showRankings ? 'Masquer' : 'Afficher'} le classement du tournoi</span>
            {showRankings ? (
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            )}
          </button>

          <div className="flex items-center gap-3 text-xs text-blue-200/60">
            {/* Indique depuis quand l'état n'a pas été rafraîchi : sur un
                écran qui tourne des heures, un état figé est immédiatement
                repérable. */}
            {lastUpdateAt != null && (
              <span className="tabular-nums">
                Actualisé {formatAge(Date.now() - lastUpdateAt)}
              </span>
            )}
            <span className="hidden sm:inline">
              Association des Élèves et Étudiants Ressortissants de Keur Salla Mbatta
            </span>
          </div>
        </div>

        {showRankings && rankings.length > 0 && (
          <div
            id="classement-tournoi"
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2"
          >
            {rankings.map((r) => (
              <div
                key={r.teamId}
                className="p-3 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-lg bg-white/10 flex items-center justify-center font-bold text-amber-300">
                    #{r.position}
                  </span>
                  <div>
                    <div className="font-bold text-white truncate max-w-[120px]">
                      {r.teamName}
                    </div>
                    <div className="text-[10px] text-blue-200/70">{r.teamCode}</div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="font-black text-white text-sm">{r.totalScore}</span>
                  <span className="text-[10px] text-blue-300 ml-1">pts</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
};
