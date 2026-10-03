import React, { useCallback, useEffect, useState } from 'react';
import { useLive } from '@shared/context/LiveContext.tsx';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { AeerksLogo } from '@shared/components/AeerksLogo.tsx';
import { Badge, EmptyState } from '@shared/components/ui.tsx';
import confetti from 'canvas-confetti';
import {
  Trophy,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Maximize,
  Timer,
  Tv,
  HelpCircle,
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

/**
 * Panneau de l'écran public.
 *
 * L'ecran est destine a un videoprojecteur : la lisibilite a distance prime
 * sur la decoracion. D'ou les choix suivants :
 * - surfaces pleines et borders fines, pas de `backdrop-blur` ni de verre :
 *   le flou d'arriere-plan est illisible a 3 metres et coute cher au rendu ;
 * - une seule couleur d'accent (ambre) reservee au vainqueur et a l'etat en
 *   pause ; le reste joue sur trois niveaux de bleu ardoise ;
 * - un seul rayon par element, une seule graisse par role, pour que la
 *   hierarchie se lise sans avoir a decoder les styles.
 */
export const LiveCompetitionPage: React.FC = () => {
  const { liveState, timerLeft, timerRunning, isConnected, lastUpdateAt } = useLive();
  const [showRankings, setShowRankings] = useState(true);

  // L'horloge du pied de page doit avancer meme sans nouveau message WebSocket,
  // sinon l'age affiche resterait fige.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const activeMatch = liveState?.activeMatch;
  const rankings = liveState?.rankings || [];
  const resultsPublished = liveState?.resultsPublished;
  const eventName = liveState?.event?.name ?? null;
  // L'edition vient de l'evenement, plus d'une annee codee en dur dans l'ecran.
  const edition = liveState?.event?.edition ?? null;

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

  /* ------------------------------------------------------------------ */
  /* Fragments                                                          */
  /* ------------------------------------------------------------------ */

  /** Bandeau d'état d'un match (pause). */
  const PausedBanner = (
    <div
      role="status"
      className="flex items-center justify-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-200"
    >
      <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>Match en pause — reprise imminente par le jury</span>
    </div>
  );

  /** Grande carte de score d'une equipe. */
  const TeamScoreCard = ({
    team,
    score,
    accent,
  }: {
    team?: { code?: string | null; name?: string | null } | null;
    score: number;
    accent: 'a' | 'b';
  }) => (
    <div
      className={[
        'relative overflow-hidden rounded-2xl border border-white/12 bg-slate-900/40',
        'flex flex-col justify-between p-5 sm:p-7',
      ].join(' ')}
    >
      {/* Liseré de couleur : indique l'équipe sans dependen du nom. */}
      <span
        aria-hidden="true"
        className={[
          'absolute inset-y-0 w-1',
          accent === 'a' ? 'left-0 bg-[#2563EB]' : 'right-0 bg-[#0B3B82]',
        ].join(' ')}
      />
      <div className="min-w-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {team?.code || (accent === 'a' ? 'Équipe A' : 'Équipe B')}
        </span>
        <h3 className="mt-1 truncate text-xl font-bold text-white sm:text-2xl">
          {team?.name || '—'}
        </h3>
      </div>
      <p
        className="my-5 text-center text-6xl font-bold tabular-nums tracking-tight text-white sm:text-7xl lg:text-8xl"
        aria-label={`${team?.name ?? 'Équipe'} : ${score} points`}
      >
        {score}
      </p>
    </div>
  );

  /** Podium : la marche la plus haute est mise en avant par la couleur, pas par l'echelle. */
  const PodiumCard = ({
    rank,
    team,
    score,
    label,
    winner,
  }: {
    rank: number;
    team?: { teamName?: string; totalScore?: number } | null;
    score: number;
    label: string;
    winner?: boolean;
  }) => {
    if (!team) return null;
    return (
      <div
        className={[
          'relative flex min-h-[18rem] w-full max-w-sm flex-col items-center justify-between rounded-2xl border p-7 text-center sm:min-h-[20rem] sm:p-8 lg:min-h-[22rem]',
          winner
            ? 'border-amber-400/50 bg-amber-400/10'
            : 'border-white/12 bg-slate-900/40',
          rank === 2 ? 'order-1 md:order-1 md:self-end' : rank === 1 ? 'order-2 md:order-2 md:z-10 md:-mb-2' : 'order-3 md:order-3 md:self-end',
        ].join(' ')}
      >
        {winner && (
          <span className="absolute -top-3.5 inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-900">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Grand vainqueur
          </span>
        )}
        <span
          aria-hidden="true"
          className={[
            'mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-xl font-bold lg:h-14 lg:w-14 lg:text-2xl',
            winner
              ? 'bg-amber-400 text-slate-900'
              : rank === 3
                ? 'bg-amber-700/70 text-amber-50'
                : 'bg-slate-700 text-slate-100',
          ].join(' ')}
        >
          {rank}
        </span>
        <span
          className={[
            'text-xs font-semibold uppercase tracking-[0.16em]',
            winner ? 'text-amber-300' : 'text-slate-400',
          ].join(' ')}
        >
          {label}
        </span>
        <h4 className="mt-1 text-xl font-bold text-white text-balance sm:text-2xl lg:text-3xl">
          {team.teamName}
        </h4>
        <p
          className={[
            'mt-4 text-3xl font-bold tabular-nums sm:text-4xl lg:text-5xl',
            winner ? 'text-amber-300' : 'text-white',
          ].join(' ')}
        >
          {score}
          <span className="ml-1.5 text-base font-medium text-slate-400">pts</span>
        </p>
      </div>
    );
  };

  /* ------------------------------------------------------------------ */
  /* Rendu                                                               */
  /* ------------------------------------------------------------------ */

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-slate-950 p-4 sm:p-6 lg:p-8">
      {/* Fond : une seule nappe ardoise, pas de trame ni de halo. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70rem_32rem_at_50%_-10rem,rgba(11,59,130,0.35),transparent_70%)]"
      />

      {/* ---------- En-tête ---------- */}
      <header className="relative z-10 flex items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <AeerksLogo size={36} priority decorative />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-300">
              AEERKS
            </p>
            <p className="truncate text-sm font-bold text-white sm:text-base">
              Journée d'Excellence
              <span className="mx-1.5 text-slate-600" aria-hidden="true">
                —
              </span>
              <span className="text-blue-300">Génie en Herbe</span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {(eventName || edition) && (
            <span className="hidden truncate rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200 md:inline-block md:max-w-[18rem]">
              {eventName}
              {eventName && edition ? ' · ' : ''}
              {edition}
            </span>
          )}

          <div
            role="status"
            title={connectionLabel}
            className="flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1.5"
          >
            <span
              aria-hidden="true"
              className={[
                'h-2 w-2 rounded-full',
                isConnected ? 'bg-emerald-400' : 'bg-rose-400',
                isConnected ? 'motion-safe:animate-pulse' : '',
              ].join(' ')}
            />
            <span className="sr-only">{connectionLabel}</span>
            <span aria-hidden="true" className="text-[11px] font-medium text-slate-200">
              {isConnected ? 'Direct' : 'Hors ligne'}
            </span>
          </div>

          <button
            type="button"
            onClick={toggleFullscreen}
            title="Passer en plein écran"
            aria-label="Passer en plein écran"
            className="rounded-lg border border-white/12 bg-white/5 p-1.5 text-slate-200 transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Maximize className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* ---------- Contenu ---------- */}
      <main
        id="contenu-principal"
        className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-6"
      >
        {/* CAS A : résultats publiés */}
        {resultsPublished ? (
          <section
            id="screen-results-published"
            className="space-y-8 text-center"
            aria-labelledby="podium-title"
          >
            <Badge tone="accent" className="px-3.5 py-1.5 text-xs">
              <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
              Résultats officiels
            </Badge>

            <h2
              id="podium-title"
              className="text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl"
            >
              Tableau d'honneur de l'Excellence
            </h2>

            {rankings.length === 0 ? (
              <EmptyState
                className="text-slate-300"
                icon={Trophy}
                title="Classement en cours de consolidation"
                description="Les résultats officiels sont publiés mais aucune équipe n'est encore classée."
              />
            ) : (
              <div className="mx-auto flex max-w-5xl flex-col items-stretch justify-center gap-6 pt-8 md:flex-row md:items-end lg:max-w-6xl lg:gap-8">
                <PodiumCard
                  rank={2}
                  team={rankings[1]}
                  score={rankings[1]?.totalScore ?? 0}
                  label="Vice-champion"
                />
                <PodiumCard
                  rank={1}
                  team={rankings[0]}
                  score={rankings[0]?.totalScore ?? 0}
                  label="Champion"
                  winner
                />
                <PodiumCard
                  rank={3}
                  team={rankings[2]}
                  score={rankings[2]?.totalScore ?? 0}
                  label="3ᵉ marche"
                />
              </div>
            )}
          </section>
        ) : !activeMatch || activeMatch.status === 'SCHEDULED' ? (
          /* CAS B : avant le match / intermission */
          <section id="screen-before-match" className="space-y-6 text-center">
            <Badge tone="primary" className="border-blue-400/30 bg-blue-500/10 text-blue-200">
              Génie en Herbe — Journée d'Excellence
            </Badge>

            <h2 className="mx-auto max-w-3xl text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Le concours commence bientôt
            </h2>

            {activeMatch ? (
              <div className="mx-auto mt-6 flex max-w-2xl items-center justify-center gap-5 rounded-2xl border border-white/12 bg-slate-900/40 p-6 sm:gap-10">
                <p className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-300">
                    Équipe A
                  </span>
                  <span className="mt-1 block text-balance text-base font-semibold text-white sm:text-lg">
                    {activeMatch.teamA?.name}
                  </span>
                </p>
                <span className="shrink-0 text-sm font-bold uppercase tracking-widest text-amber-400">
                  vs
                </span>
                <p className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-300">
                    Équipe B
                  </span>
                  <span className="mt-1 block text-balance text-base font-semibold text-white sm:text-lg">
                    {activeMatch.teamB?.name}
                  </span>
                </p>
              </div>
            ) : (
              <EmptyState
                className="mx-auto max-w-lg text-slate-300"
                icon={Tv}
                title="En attente du prochain match"
                description="L'écran affichera automatiquement le duel dès que le jury lancera la rencontre."
              />
            )}

            <p className="mx-auto max-w-xl text-pretty text-sm leading-relaxed text-slate-400">
              Bienvenue aux équipes participantes, aux professeurs, aux membres du jury et à la
              communauté de Keur Salla Mbatta.
            </p>
          </section>
        ) : activeMatch.status === 'FINISHED' ? (
          /* CAS C : fin du match */
          <section id="screen-match-finished" className="space-y-6 text-center">
            <Badge tone="accent" className="px-3.5 py-1.5 text-xs">
              Match officiellement terminé
            </Badge>

            <h2 className="text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Score final de la rencontre
            </h2>

            <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5 sm:grid-cols-2">
              <TeamScoreCard
                team={activeMatch.teamA}
                score={activeMatch.scoreA}
                accent="a"
              />
              <TeamScoreCard
                team={activeMatch.teamB}
                score={activeMatch.scoreB}
                accent="b"
              />
            </div>

            <div className="mx-auto mt-2 max-w-xl rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5">
              <p className="text-sm font-semibold text-amber-200">
                Génie en Herbe — délibérations en cours
              </p>
              <p className="mt-1.5 text-pretty text-xs leading-relaxed text-slate-300">
                Merci aux participants. Les résultats officiels et le classement général seront
                proclamés dès validation par le jury et l'administration de l'AEERKS.
              </p>
            </div>
          </section>
        ) : (
          /* CAS D : pendant le match */
          <section id="screen-match-live" className="space-y-5">
            {activeMatch.status === 'PAUSED' && PausedBanner}

            <div className="grid grid-cols-1 items-center gap-5 md:grid-cols-12">
              <div className="md:col-span-5">
                <TeamScoreCard team={activeMatch.teamA} score={activeMatch.scoreA} accent="a" />
              </div>

              {/* Chrono */}
              <div className="flex flex-col items-center justify-center md:col-span-2">
                <div
                  role="timer"
                  aria-label={`Chronomètre : ${timerLeft} secondes`}
                  className={[
                    'flex h-32 w-32 flex-col items-center justify-center rounded-full border-2 sm:h-36 sm:w-36',
                    'transition-colors duration-300 motion-reduce:transition-none',
                    timerRunning
                      ? timerLeft <= APP_CONFIG.TIMER_WARNING_SECONDS
                        ? 'animate-pulse border-rose-400 bg-rose-500/15 text-rose-200 motion-reduce:animate-none'
                        : 'border-amber-400/70 bg-amber-400/10 text-amber-200'
                      : 'border-white/15 bg-slate-900/40 text-slate-400',
                  ].join(' ')}
                >
                  <span className="text-5xl font-bold tabular-nums tracking-tight sm:text-6xl">
                    {timerLeft}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">
                    sec
                  </span>
                </div>
                <span className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Chronomètre
                </span>
              </div>

              <div className="md:col-span-5">
                <TeamScoreCard team={activeMatch.teamB} score={activeMatch.scoreB} accent="b" />
              </div>
            </div>

            {/* Question lue aux candidats — la réponse n'est JAMAIS affichée ici. */}
            {currentQ ? (
              <div className="rounded-2xl border border-white/12 bg-slate-900/50 p-5 sm:p-7">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="primary" className="border-[#2563EB]/40 bg-[#2563EB]/20 text-blue-100">
                      Question {activeMatch.currentQuestionIndex + 1}
                    </Badge>
                    {currentQ.categoryName && (
                      <Badge className="border-white/15 bg-white/5 text-slate-200">
                        {currentQ.categoryName}
                      </Badge>
                    )}
                  </div>
                  <Badge tone="accent" className="px-3 py-1">
                    {currentQ.points} points en jeu
                  </Badge>
                </div>

                <p className="text-pretty text-center text-xl font-semibold leading-relaxed text-white sm:text-2xl lg:text-3xl">
                  {currentQ.text}
                </p>

                {currentQ.options && Array.isArray(currentQ.options) && (
                  <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {currentQ.options.map((opt, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded-xl border border-white/12 bg-slate-900/40 px-4 py-3 text-base font-medium text-white"
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#2563EB] text-xs font-bold"
                        >
                          {String.fromCharCode(65 + i)}
                        </span>
                        <span className="min-w-0 flex-1">{opt}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/12 px-5 py-8 text-center">
                <p className="flex items-center justify-center gap-2 text-sm text-slate-400">
                  <HelpCircle className="h-4 w-4" aria-hidden="true" />
                  Aucune question affichée — le jury prépare la suite.
                </p>
              </div>
            )}
          </section>
        )}
      </main>

      {/* ---------- Classement ---------- */}
      <footer className="relative z-10 border-t border-white/10 pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowRankings((v) => !v)}
            aria-expanded={showRankings}
            aria-controls="classement-tournoi"
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-semibold text-blue-300 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <span>{showRankings ? 'Masquer' : 'Afficher'} le classement du tournoi</span>
            {showRankings ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            )}
          </button>

          <div className="flex items-center gap-3 text-xs text-slate-500">
            {lastUpdateAt != null && (
              <span className="tabular-nums">
                Actualisé {formatAge(Date.now() - lastUpdateAt)}
              </span>
            )}
            <span className="hidden lg:inline">
              Amicale des Élèves et Étudiants Ressortissants de Keur Salla Mbatta
            </span>
          </div>
        </div>

        {showRankings &&
          (rankings.length > 0 ? (
            <div
              id="classement-tournoi"
              className="grid grid-cols-2 gap-2.5 pt-1 sm:grid-cols-3 lg:grid-cols-4"
            >
              {rankings.map((r) => (
                <div
                  key={r.teamId}
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/10 text-xs font-bold tabular-nums text-amber-300"
                    >
                      {r.position}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-white">
                        {r.teamName}
                      </span>
                      <span className="block text-[10px] text-slate-500">{r.teamCode}</span>
                    </span>
                  </div>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-white">
                    {r.totalScore}
                    <span className="ml-1 text-[10px] font-medium text-slate-500">pts</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p
              id="classement-tournoi"
              className="py-3 text-center text-xs text-slate-500"
            >
              Le classement s'affichera dès la clôture des premiers matchs.
            </p>
          ))}
      </footer>
    </div>
  );
};

export default LiveCompetitionPage;
