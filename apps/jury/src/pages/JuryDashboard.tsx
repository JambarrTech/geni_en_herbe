import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@shared/context/AuthContext.tsx';
import { useLive } from '@shared/context/LiveContext.tsx';
import type { MatchItem, QuestionItem, ScoreEventItem, TeamItem } from '@shared/types.ts';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { api, errorMessage, isAbort } from '@shared/lib/api.ts';
import { Modal } from '@shared/components/Modal.tsx';
import {
  SCORE_REASONS,
  hasModifier,
  isTypingTarget,
  resolveBroadcastShortcut,
  resolveNavShortcut,
  resolveScoreShortcut,
  type BroadcastAction,
} from '../lib/juryShortcuts.ts';
import {
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Award,
  Sliders,
  RefreshCw,
  Keyboard,
  Tv,
  SkipForward,
  Rewind,
} from 'lucide-react';
import type { BroadcastStage, MatchBroadcast } from '@shared/types.ts';

/**
 * Libellés des étapes du scénario de diffusion.
 *
 * Ils vivent ici, et non dans `backend/src/lib/broadcastFlow.ts`, pour une
 * raison simple : `apps/jury` ne compile pas le backend, donc aucune table
 * partagée n'est atteignable depuis les deux côtés. Les VALEURS sont typées par
 * `Record<BroadcastStage, string>`, ce qui fait échouer le typecheck si le
 * serveur ajoute une étape sans libellé — l'oubli devient impossible au lieu
 * d'être silencieux.
 */
const BROADCAST_STAGE_LABELS: Record<BroadcastStage, string> = {
  ROSTER: 'Effectif des équipes',
  QUESTION: 'Question à l’écran',
  ANSWER_A: 'Réponse de l’équipe A',
  ANSWER_B: 'Réponse de l’équipe B',
  REVEAL: 'Révélation de la bonne réponse',
  FINAL: 'Résultat final de la rencontre',
};

/**
 * Étapes qui n'appartiennent à aucune question.
 *
 * Le compteur « question 3 / 10 » n'a de sens que sur les quatre étapes de la
 * série : pendant l'effectif ou le résultat final, il ferait croire au jury que
 * le public regarde une question alors qu'il regarde autre chose.
 */
const STAGES_PER_MATCH: readonly BroadcastStage[] = ['ROSTER', 'FINAL'];

/** Détail complet d'un match tel que renvoyé par GET /api/matches/:id (jury). */
interface MatchDetail {
  id: number;
  eventId: number;
  phase: string;
  matchNumber: number;
  teamAId: number;
  teamBId: number;
  teamA?: TeamItem | null;
  teamB?: TeamItem | null;
  status: 'SCHEDULED' | 'READY' | 'LIVE' | 'PAUSED' | 'FINISHED' | 'CANCELLED';
  currentQuestionIndex: number;
  currentQuestionId?: number | null;
  scoreA: number;
  scoreB: number;
  timerSecondsLeft: number;
  timerIsRunning: boolean;
  currentQuestion?: (QuestionItem & { categoryName?: string }) | null;
  matchQuestions?: Array<{
    id: number;
    orderNumber: number;
    status: 'PENDING' | 'ACTIVE' | 'ANSWERED' | 'SKIPPED';
    pointsAwarded: number;
    winningTeamId?: number | null;
  }>;
  scoreEvents?: ScoreEventItem[];
  /** Scénario de diffusion de l'écran public — absent si le match n'a jamais été diffusé. */
  broadcast?: MatchBroadcast;
}

interface ScoreResponse {
  success: boolean;
  scoreA: number;
  scoreB: number;
}

export const JuryDashboard: React.FC = () => {
  const { user: _staffUser } = useAuth();
  const { liveState, refreshLiveState, timerLeft, timerRunning } = useLive();

  const [matchesList, setMatchesList] = useState<MatchItem[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  // Plus de `any` : la table de score est l'outil qui décide des points.
  const [matchDetails, setMatchDetails] = useState<MatchDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [adjustTeamId, setAdjustTeamId] = useState<number | null>(null);
  const [adjustPoints, setAdjustPoints] = useState<number>(APP_CONFIG.DEFAULT_ADJUST_POINTS);
  const [adjustReason, setAdjustReason] = useState<string>('');

  // --- Garde-fous contre les réponses hors ordre -----------------------------
  // Deux chargements de détails qui se chevauchent (changement de match rapide,
  // ou diffusion live) se résolvent dans un ordre quelconque : la dernière
  // réponse arrivée l'emportait, même si elle portait l'AUTRE match. Le panneau
  // affichait alors les scores et la réponse officielle du match A pendant que
  // le <select> indique le match B.
  const detailsSeq = useRef(0);
  const detailsAbort = useRef<AbortController | null>(null);

  // Verrou d'action : le délai client doit être >= celui du serveur, sinon
  // l'interface se déverrouille avant la fin de la protection anti-double-clic.
  const actionUnlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Confirmation de clôture : action irréversible, donc deux temps.
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(
    () => () => {
      detailsAbort.current?.abort();
      if (actionUnlockTimer.current) clearTimeout(actionUnlockTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  // Audio tone generation for tournament atmosphere
  const playTone = useCallback((type: 'correct' | 'wrong' | 'bonus') => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'correct') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'bonus') {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.08); // E5
        osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.16); // G5
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.start();
        osc.stop(ctx.currentTime + 0.45);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, ctx.currentTime);
        osc.frequency.setValueAtTime(164.81, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
      // Libère le contexte : un AudioContext par point cumulé les ressources.
      void ctx.close().catch(() => undefined);
    } catch {
      // Le contexte audio peut être restreint avant une geste utilisateur.
    }
  }, []);

  const showFeedback = useCallback(
    (text: string, type: 'success' | 'error' = 'success') => {
      setFeedbackMsg({ type, text });
      // Annule le minuteur précédent : sinon deux actions à 1 s d'intervalle
      // voyaient le second message effacé par le premier.
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(
        () => setFeedbackMsg(null),
        APP_CONFIG.FEEDBACK_DISMISS_MS
      );
    },
    []
  );

  // --- Chargements -----------------------------------------------------------
  const loadMatches = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api.get<MatchItem[]>('/api/matches', { signal });
      setMatchesList(list);
      setSelectedMatchId((current) => {
        if (current && list.some((m) => m.id === current)) return current;
        if (list.length === 0) return null;
        const live = list.find(
          (m) => m.status === 'LIVE' || m.status === 'PAUSED' || m.status === 'READY'
        );
        return live ? live.id : list[0].id;
      });
    } catch (e) {
      if (!isAbort(e)) {
        console.error('Erreur chargement des matchs:', e);
        showFeedback(errorMessage(e, 'Impossible de charger les matchs'), 'error');
      }
    }
  }, [showFeedback]);

  const loadMatchDetails = useCallback(
    async (id: number) => {
      const seq = ++detailsSeq.current;
      detailsAbort.current?.abort();
      const controller = new AbortController();
      detailsAbort.current = controller;

      setLoading(true);
      try {
        const data = await api.get<MatchDetail>(`/api/matches/${id}`, {
          signal: controller.signal,
        });
        // Réponse périmée (une requête plus récente a pris la main) : on l'ignore.
        if (seq !== detailsSeq.current) return;
        setMatchDetails(data);
      } catch (e) {
        if (isAbort(e) || seq !== detailsSeq.current) return;
        console.error('Erreur détails match:', e);
        setMatchDetails(null);
        showFeedback(errorMessage(e, 'Impossible de charger le détail du match'), 'error');
      } finally {
        if (seq === detailsSeq.current) setLoading(false);
      }
    },
    [showFeedback]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadMatches(controller.signal);
    return () => controller.abort();
  }, [loadMatches]);

  // Signatures scalaires à surveiller. Dépendre de `liveState` lui-même
  // relançait un refetch complet à CHAQUE diffusion (identité neuve de l'objet
  // à chaque score_updated / question_changed / timer_synced).
  const liveMatch = liveState?.activeMatch;
  const liveMatchId = liveMatch?.id ?? null;
  const liveQuestionId = liveMatch?.currentQuestionId ?? null;
  const liveScoreA = liveMatch?.scoreA ?? null;
  const liveScoreB = liveMatch?.scoreB ?? null;

  useEffect(() => {
    if (selectedMatchId == null) return;
    void loadMatchDetails(selectedMatchId);
  }, [selectedMatchId, liveMatchId, liveQuestionId, liveScoreA, liveScoreB, loadMatchDetails]);

  // --- Actions ---------------------------------------------------------------
  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (actionLoading) return;
      setActionLoading(true);
      try {
        await fn();
      } catch (e) {
        if (!isAbort(e)) showFeedback(errorMessage(e, `${label} : échec`), 'error');
      } finally {
        // Verrou local aligné sur la protection serveur (1,5 s), pas 500 ms.
        if (actionUnlockTimer.current) clearTimeout(actionUnlockTimer.current);
        actionUnlockTimer.current = setTimeout(
          () => setActionLoading(false),
          APP_CONFIG.ANTI_DOUBLE_CLICK_MS
        );
      }
    },
    [actionLoading, showFeedback]
  );

  const handleStartMatch = () => {
    if (selectedMatchId == null) return;
    void runAction('Démarrage du match', async () => {
      await api.post(`/api/matches/${selectedMatchId}/start`);
      showFeedback('Le match a démarré avec succès !');
      await loadMatchDetails(selectedMatchId);
      void refreshLiveState();
    });
  };

  const handlePauseMatch = () => {
    if (selectedMatchId == null) return;
    void runAction('Mise en pause', async () => {
      await api.post(`/api/matches/${selectedMatchId}/pause`);
      showFeedback('Match mis en pause');
      await loadMatchDetails(selectedMatchId);
      void refreshLiveState();
    });
  };

  const handleResumeMatch = () => {
    if (selectedMatchId == null) return;
    void runAction('Reprise du match', async () => {
      await api.post(`/api/matches/${selectedMatchId}/resume`);
      showFeedback('Match repris');
      await loadMatchDetails(selectedMatchId);
      void refreshLiveState();
    });
  };

  const handleTimerAction = (action: 'start' | 'pause' | 'reset') => {
    if (selectedMatchId == null) return;
    void runAction('Chrono', async () => {
      await api.post(`/api/matches/${selectedMatchId}/timer-action`, { action });
    });
  };

  const handleNextQuestion = useCallback(() => {
    if (selectedMatchId == null) return;
    void runAction('Question suivante', async () => {
      await api.post(`/api/matches/${selectedMatchId}/next-question`);
      showFeedback('Question suivante chargée');
      await loadMatchDetails(selectedMatchId);
    });
  }, [selectedMatchId, runAction, showFeedback, loadMatchDetails]);

  const handlePrevQuestion = useCallback(() => {
    if (selectedMatchId == null) return;
    void runAction('Question précédente', async () => {
      await api.post(`/api/matches/${selectedMatchId}/previous-question`);
      showFeedback('Question précédente');
      await loadMatchDetails(selectedMatchId);
    });
  }, [selectedMatchId, runAction, showFeedback, loadMatchDetails]);

  /**
   * Pilotage du scénario de diffusion affiché au public.
   *
   * Volontairement une action par elle-même, distincte d'attribuer des points
   * ou de changer de question : c'est elle qui décide du moment où la bonne
   * réponse part sur l'écran projeté. Liée à un clic de score, la réponse
   * partirait au moment d'une décision de notation, et plus personne à la table
   * ne saurait dire à coup sûr ce que le public regarde.
   */
  const handleBroadcastStep = useCallback(
    (action: BroadcastAction) => {
      if (selectedMatchId == null) return;
      void runAction('Diffusion', async () => {
        await api.post(`/api/matches/${selectedMatchId}/broadcast-step`, { action });
        await loadMatchDetails(selectedMatchId);
        void refreshLiveState();
      });
    },
    [selectedMatchId, runAction, loadMatchDetails, refreshLiveState]
  );

  /**
   * Attribution de points.
   *
   * L'identifiant de match provient désormais de `matchDetails` — la MÊME
   * source que le `questionId` envoyé. Auparavant l'URL portait
   * `selectedMatchId` et le corps `matchDetails.currentQuestion.id` : après un
   * changement de match, les deux pouvaient désigner des matchs différents.
   */
  const handleScore = useCallback((
    teamId: number,
    pts: number,
    type: 'ANSWER' | 'BONUS' | 'PENALTY',
    reason: string
  ) => {
    if (!matchDetails || actionLoading) return;
    const matchId = matchDetails.id;
    const questionId = matchDetails.currentQuestion?.id;

    void runAction('Attribution', async () => {
      await api.post<ScoreResponse>(`/api/matches/${matchId}/score`, {
        teamId,
        questionId,
        points: pts,
        type,
        reason,
      });

      const teamName =
        teamId === matchDetails.teamAId ? matchDetails.teamA?.name : matchDetails.teamB?.name;
      showFeedback(`${pts > 0 ? '+' : ''}${pts} pts validés pour ${teamName} (${reason})`);
      playTone(pts > 0 ? (type === 'BONUS' ? 'bonus' : 'correct') : 'wrong');

      await loadMatchDetails(matchId);
      void refreshLiveState();
    });
  }, [matchDetails, actionLoading, runAction, showFeedback, playTone, loadMatchDetails, refreshLiveState]);

  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matchDetails || !adjustTeamId || adjustReason.trim().length < 3) return;
    const matchId = matchDetails.id;

    try {
      await api.post<ScoreResponse>(`/api/matches/${matchId}/adjust-score`, {
        teamId: adjustTeamId,
        points: adjustPoints,
        reason: adjustReason.trim(),
      });
      showFeedback("Ajustement enregistré avec motif d'audit.");
      setShowAdjustModal(false);
      setAdjustReason('');
      await loadMatchDetails(matchId);
      void refreshLiveState();
    } catch (err) {
      if (!isAbort(err)) showFeedback(errorMessage(err, 'Erreur ajustement'), 'error');
    }
  };

  /**
   * Clôture du match.
   *
   * L'action est destructive et IRRÉVERSIBLE : elle fige les scores finaux.
   * D'où une confirmation explicite.
   *
   * `window.confirm` est remplacé par un dialogue natif de l'application, pour
   * trois raisons concrètes :
   *  - la boîte native ignore le design system, apparaît dans la langue du
   *    navigateur au milieu d'une interface en français, et rompt l'immersion
   *    en plein direct, devant un public ;
   *  - son rendu varie selon le système : impossible d'y loger l'état du match
   *    (équipes, score), qui est précisément ce qui rend la décision éclairée ;
   *  - le focus et le piège de tabulation n'y sont pas maîtrisés.
   *
   * L'ouverture est déjà gérée par `requestCloseMatch` : ce handler n'est
   * appelé qu'UNE fois la confirmation donnée.
   */
  const confirmFinishMatch = () => {
    if (selectedMatchId == null) return;
    void runAction('Clôture', async () => {
      await api.post(`/api/matches/${selectedMatchId}/finish`);
      showFeedback('Le match est officiellement terminé !');
      await loadMatchDetails(selectedMatchId);
      void loadMatches();
      void refreshLiveState();
    });
  };

  const requestCloseMatch = () => {
    if (selectedMatchId == null) return;
    setConfirmClose(true);
  };

  const currentQ: (QuestionItem & { categoryName?: string }) | null =
    matchDetails?.currentQuestion ?? null;
  const matchQuestionsList = matchDetails?.matchQuestions ?? [];
  const currentIdx = matchDetails?.currentQuestionIndex ?? 0;
  const currentPoints = currentQ?.points || APP_CONFIG.DEFAULT_QUESTION_POINTS;

  const isRunning =
    matchDetails?.status === 'LIVE' || matchDetails?.status === 'PAUSED';

  // --- Scénario de diffusion -------------------------------------------------
  //
  // Tout est lu, rien n'est recalculé : le serveur envoie la position du
  // scénario déjà normalisée (`matchDetails.broadcast`). Le jury voit donc
  // littéralement ce que voit le public, sans qu'une règle de séquence soit
  // dupliquée ici — et sans qu'un désaccord entre les deux écrans soit possible.
  const broadcast = matchDetails?.broadcast ?? null;
  const broadcastStage: BroadcastStage | null = broadcast?.stage ?? null;
  // Le pilotage n'a de sens que sur un match démarré : la route refuse avant, et
  // un bouton actif qui échoue à chaque clic apprend au jury à ne pas s'en servir.
  const canBroadcast = isRunning && !actionLoading;
  const broadcastQuestionLabel =
    broadcast && broadcastStage && !STAGES_PER_MATCH.includes(broadcastStage)
      ? `Question ${broadcast.questionIndex + 1} / ${broadcast.questionCount}`
      : null;

  // On ne peut pas scorer un match non démarré, ni sans question courante :
  // le bouton « Faux (0 pt) » envoyait alors `questionId: undefined` et
  // chaque clic valait 10 points.
  const canScore = Boolean(isRunning && currentQ) && !actionLoading;
  const scoreHint = !matchDetails
    ? null
    : !isRunning
      ? matchDetails.status === 'FINISHED'
        ? 'Match clôturé : attribution de points désactivée.'
        : matchDetails.status === 'CANCELLED'
          ? 'Match annulé : attribution de points désactivée.'
          : 'Démarrez le match pour attribuer des points.'
      : !currentQ
        ? 'Aucune question courante : impossible d\'attribuer des points.'
        : null;

  const closeAdjust = () => {
    setShowAdjustModal(false);
    setAdjustReason('');
  };

  /**
   * Raccourcis clavier.
   *
   * La traduction touche -> action vit dans `lib/juryShortcuts.ts` (pure, donc
   * éprouvable sans monter l'écran ni la connexion WebSocket). Ce bloc ne
   * s'occupe plus que du câblage DOM : écouter, filtrer, traduire, agir.
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ne jamais capter une frappe destinée à un champ de saisie : le motif
      // d'ajustement contient des lettres qui sont aussi des raccourcis.
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      if (hasModifier(e)) return;
      if (!matchDetails) return;

      const outcome = resolveScoreShortcut(e.key, {
        teamAId: matchDetails.teamAId,
        teamBId: matchDetails.teamBId,
        questionPoints: currentQ?.points || APP_CONFIG.DEFAULT_QUESTION_POINTS,
        bonusPoints: APP_CONFIG.BONUS_POINTS,
      });
      if (outcome) {
        // Le verrou est testé après la traduction : `canScore` dépend de
        // `actionLoading`, donc le lire ici évite de le figer dans les
        // dépendances de l'effet juste pour ce test.
        if (canScore) {
          handleScore(outcome.teamId, outcome.points, outcome.type, outcome.reason);
        }
        return;
      }

      const nav = resolveNavShortcut(e.key, {
        currentIndex: currentIdx,
        questionCount: matchQuestionsList.length,
      });
      if (nav && !actionLoading) {
        e.preventDefault();
        if (nav === 'next') handleNextQuestion();
        else handlePrevQuestion();
        return;
      }

      // Pilotage de la diffusion. Placé APRÈS la navigation : les flèches restent
      // la navigation entre questions, même quand le scénario est le bouton le
      // plus utilisé — sinon `→` piloterait l'écran au lieu de la question, et un
      // jury habitué à son clavier avancerait la liste de questions d'un cran
      // par question jouée au lieu de diffuser l'étape.
      //
      // `canBroadcast` suffit comme garde : il contient déjà `!actionLoading`,
      // testé ici par ailleurs pour la notation.
      if (canBroadcast) {
        const step = resolveBroadcastShortcut(e.key);
        if (step) {
          e.preventDefault();
          handleBroadcastStep(step);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    matchDetails,
    canScore,
    canBroadcast,
    actionLoading,
    currentIdx,
    matchQuestionsList.length,
    currentQ,
    handleScore,
    handleNextQuestion,
    handlePrevQuestion,
    handleBroadcastStep,
  ]);

  return (
    <main id="contenu-principal" className="min-h-[calc(100vh-4rem)] bg-slate-100/70 p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Top Control Bar: Match Selector & Quick Status */}
        <div className="bg-white rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#0B3B82] text-white flex items-center justify-center">
              <Award className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-[#0B3B82]">
                Espace Officiel d'Arbitrage &amp; Jury
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                Table de Contrôle du Génie en Herbe
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label
              htmlFor="select-jury-match"
              className="text-xs font-semibold text-slate-600"
            >
              Match actif :
            </label>
            <select
              id="select-jury-match"
              value={selectedMatchId ?? ''}
              onChange={(e) => setSelectedMatchId(Number(e.target.value))}
              className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 focus:ring-2 focus:ring-[#2563EB] max-w-[22rem]"
            >
              {matchesList.length === 0 && <option value="">Aucun match</option>}
              {matchesList.map((m) => (
                <option key={m.id} value={m.id}>
                  Match #{m.matchNumber} ({m.phase}) — {m.teamA?.name || 'A'} vs{' '}
                  {m.teamB?.name || 'B'} [{m.status}]
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => selectedMatchId != null && void loadMatchDetails(selectedMatchId)}
              title="Rafraîchir"
              aria-label="Rafraîchir le match"
              className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Floating Notification — annoncé aux lecteurs d'écran */}
        {feedbackMsg && (
          <div
            id="jury-toast-alert"
            role="status"
            aria-live="polite"
            className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between shadow-md transition-all ${
              feedbackMsg.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {feedbackMsg.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-rose-600" aria-hidden="true" />
              )}
              <span>{feedbackMsg.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackMsg(null)}
              aria-label="Fermer la notification"
              className="text-slate-400 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
        )}

        {matchDetails ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Team A Card */}
              <div
                id="jury-card-team-a"
                className={`lg:col-span-5 bg-white rounded-2xl border-2 p-6 shadow-xs flex flex-col justify-between transition-all ${
                  matchDetails.status === 'LIVE' ? 'border-[#2563EB]/40' : 'border-slate-200'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase px-2.5 py-1 rounded-md bg-blue-50 text-[#0B3B82] border border-blue-100">
                      Équipe A • {matchDetails.teamA?.code || 'EQ-A'}
                    </span>
                    <span className="text-xs text-slate-500 font-medium">
                      {matchDetails.teamA?.code || 'Équipe A'}
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-slate-900 leading-snug">
                    {matchDetails.teamA?.name}
                  </h3>
                </div>

                <div className="my-6 text-center">
                  <span
                    aria-label={`Score équipe A : ${matchDetails.scoreA} points`}
                    className="text-6xl sm:text-7xl font-bold tabular-nums tracking-tight text-[#0B3B82]"
                  >
                    {matchDetails.scoreA}
                  </span>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mt-1">
                    Points cumulés
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    id="btn-jury-valider-team-a"
                    type="button"
                    disabled={!canScore}
                    aria-keyshortcuts="A"
                    title={canScore ? 'Valider la bonne réponse (raccourci : A)' : undefined}
                    onClick={() =>
                      handleScore(
                        matchDetails.teamAId,
                        currentPoints,
                        'ANSWER',
                        SCORE_REASONS.answer(currentPoints)
                      )
                    }
                    className="w-full py-3 px-4 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] active:scale-[0.98] text-white font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-5 h-5 text-emerald-300" aria-hidden="true" />
                    <span>Valider Bonne Réponse (+{currentPoints} pts)</span>
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      id="btn-jury-bonus-team-a"
                      type="button"
                      disabled={!canScore}
                      onClick={() =>
                        handleScore(
                          matchDetails.teamAId,
                          APP_CONFIG.BONUS_POINTS,
                          'BONUS',
                          SCORE_REASONS.bonus(APP_CONFIG.BONUS_POINTS)
                        )
                      }
                      className="py-2 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 font-semibold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span>★ Bonus (+{APP_CONFIG.BONUS_POINTS} pts)</span>
                    </button>
                    <button
                      id="btn-jury-penalty-team-a"
                      type="button"
                      disabled={!canScore}
                      onClick={() =>
                        handleScore(
                          matchDetails.teamAId,
                          0,
                          'PENALTY',
                          SCORE_REASONS.penalty()
                        )
                      }
                      className="py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 font-semibold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <XCircle className="w-3.5 h-3.5 text-rose-500" aria-hidden="true" />
                      <span>Faux (0 pt)</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Match Central Info & Authoritative Timer */}
              <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col items-center justify-between text-center">
                <div className="w-full">
                  <span
                    className={`inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                      matchDetails.status === 'LIVE'
                        ? 'bg-emerald-100 text-emerald-800 animate-pulse'
                        : matchDetails.status === 'PAUSED'
                          ? 'bg-amber-100 text-amber-800'
                          : matchDetails.status === 'FINISHED'
                            ? 'bg-slate-100 text-slate-700'
                            : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {matchDetails.status === 'LIVE'
                      ? '● EN COURS'
                      : matchDetails.status === 'PAUSED'
                        ? '❚❚ EN PAUSE'
                        : matchDetails.status === 'FINISHED'
                          ? 'TERMINÉ'
                          : 'PRÊT'}
                  </span>
                  <div className="text-xs font-semibold text-slate-500 mt-1">
                    {matchDetails.phase}
                  </div>
                </div>

                <div className="my-4">
                  <div
                    role="timer"
                    aria-live="off"
                    aria-label={`Chronomètre : ${timerLeft} secondes`}
                    className={`w-28 h-28 mx-auto rounded-full border-4 flex flex-col items-center justify-center shadow-inner transition-colors ${
                      timerRunning
                        ? timerLeft <= APP_CONFIG.TIMER_WARNING_SECONDS
                          ? 'border-rose-500 bg-rose-50/50 text-rose-600 animate-pulse'
                          : 'border-[#0B3B82] bg-blue-50/40 text-[#0B3B82]'
                        : 'border-slate-300 bg-slate-50 text-slate-600'
                    }`}
                  >
                    <span className="text-4xl font-bold tabular-nums tracking-tight">{timerLeft}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      secondes
                    </span>
                  </div>

                  <div className="flex items-center justify-center gap-1.5 mt-3">
                    {timerRunning ? (
                      <button
                        id="btn-timer-pause"
                        type="button"
                        onClick={() => handleTimerAction('pause')}
                        title="Mettre en pause le chrono"
                        aria-label="Mettre en pause le chrono"
                        className="p-2 rounded-xl bg-amber-500 hover:bg-amber-600 text-white shadow-xs"
                      >
                        <Pause className="w-4 h-4" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        id="btn-timer-start"
                        type="button"
                        onClick={() => handleTimerAction('start')}
                        title="Démarrer le chrono"
                        aria-label="Démarrer le chrono"
                        className="p-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs"
                      >
                        <Play className="w-4 h-4 fill-white" aria-hidden="true" />
                      </button>
                    )}

                    <button
                      id="btn-timer-reset"
                      type="button"
                      onClick={() => handleTimerAction('reset')}
                      title="Réinitialiser à la durée normale"
                      aria-label="Réinitialiser le chrono"
                      className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700"
                    >
                      <RotateCcw className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="w-full space-y-2 pt-2 border-t border-slate-100">
                  {matchDetails.status === 'READY' || matchDetails.status === 'SCHEDULED' ? (
                    <button
                      id="btn-match-start-global"
                      type="button"
                      disabled={actionLoading}
                      onClick={handleStartMatch}
                      className="w-full py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <Play className="w-3.5 h-3.5 fill-white" aria-hidden="true" />
                      <span>Lancer le Match</span>
                    </button>
                  ) : matchDetails.status === 'LIVE' ? (
                    <button
                      id="btn-match-pause-global"
                      type="button"
                      disabled={actionLoading}
                      onClick={handlePauseMatch}
                      className="w-full py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold shadow-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Mettre en pause</span>
                    </button>
                  ) : matchDetails.status === 'PAUSED' ? (
                    <button
                      id="btn-match-resume-global"
                      type="button"
                      disabled={actionLoading}
                      onClick={handleResumeMatch}
                      className="w-full py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
                    >
                      <Play className="w-3.5 h-3.5 fill-white" aria-hidden="true" />
                      <span>Reprendre le match</span>
                    </button>
                  ) : null}

                  {matchDetails.status !== 'FINISHED' &&
                    matchDetails.status !== 'CANCELLED' && (
                      <button
                        id="btn-match-finish-global"
                        type="button"
                        disabled={actionLoading}
                        onClick={requestCloseMatch}
                        className="w-full py-1.5 px-3 rounded-xl border border-slate-300 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700 text-slate-600 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1 disabled:opacity-40"
                      >
                        Clôturer le match
                      </button>
                    )}
                </div>
              </div>

              {/* Team B Card */}
              <div
                id="jury-card-team-b"
                className={`lg:col-span-5 bg-white rounded-2xl border-2 p-6 shadow-xs flex flex-col justify-between transition-all ${
                  matchDetails.status === 'LIVE' ? 'border-[#2563EB]/40' : 'border-slate-200'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase px-2.5 py-1 rounded-md bg-blue-50 text-[#0B3B82] border border-blue-100">
                      Équipe B • {matchDetails.teamB?.code || 'EQ-B'}
                    </span>
                    <span className="text-xs text-slate-500 font-medium">
                      {matchDetails.teamB?.code || 'Équipe B'}
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-slate-900 leading-snug">
                    {matchDetails.teamB?.name}
                  </h3>
                </div>

                <div className="my-6 text-center">
                  <span
                    aria-label={`Score équipe B : ${matchDetails.scoreB} points`}
                    className="text-6xl sm:text-7xl font-bold tabular-nums tracking-tight text-[#0B3B82]"
                  >
                    {matchDetails.scoreB}
                  </span>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mt-1">
                    Points cumulés
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    id="btn-jury-valider-team-b"
                    type="button"
                    disabled={!canScore}
                    aria-keyshortcuts="E"
                    title={canScore ? 'Valider la bonne réponse (raccourci : E)' : undefined}
                    onClick={() =>
                      handleScore(
                        matchDetails.teamBId,
                        currentPoints,
                        'ANSWER',
                        SCORE_REASONS.answer(currentPoints)
                      )
                    }
                    className="w-full py-3 px-4 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] active:scale-[0.98] text-white font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-5 h-5 text-emerald-300" aria-hidden="true" />
                    <span>Valider Bonne Réponse (+{currentPoints} pts)</span>
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      id="btn-jury-bonus-team-b"
                      type="button"
                      disabled={!canScore}
                      onClick={() =>
                        handleScore(
                          matchDetails.teamBId,
                          APP_CONFIG.BONUS_POINTS,
                          'BONUS',
                          SCORE_REASONS.bonus(APP_CONFIG.BONUS_POINTS)
                        )
                      }
                      className="py-2 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 font-semibold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span>★ Bonus (+{APP_CONFIG.BONUS_POINTS} pts)</span>
                    </button>
                    <button
                      id="btn-jury-penalty-team-b"
                      type="button"
                      disabled={!canScore}
                      onClick={() =>
                        handleScore(
                          matchDetails.teamBId,
                          0,
                          'PENALTY',
                          SCORE_REASONS.penalty()
                        )
                      }
                      className="py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 font-semibold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <XCircle className="w-3.5 h-3.5 text-rose-500" aria-hidden="true" />
                      <span>Faux (0 pt)</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {scoreHint && (
              <p
                role="note"
                className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5"
              >
                {scoreHint}
              </p>
            )}

            {/* Aide aux raccourcis : sans rappel visuel, personne ne les trouve. */}
            <details className="bg-white rounded-xl border border-slate-200 text-xs">
              <summary className="cursor-pointer select-none px-4 py-2.5 font-semibold text-slate-600 hover:text-slate-900 list-none flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563EB] rounded-xl">
                <Keyboard className="w-3.5 h-3.5 text-[#0B3B82]" aria-hidden="true" />
                Raccourcis clavier
                <ChevronDown
                  className="w-3.5 h-3.5 ml-auto text-slate-400"
                  aria-hidden="true"
                />
              </summary>
              <div className="px-4 pb-3.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-slate-600">
                {[
                  ['A', 'Bonne réponse — Équipe A'],
                  ['E', 'Bonne réponse — Équipe B'],
                  ['1', 'Points bonus — Équipe A'],
                  ['2', 'Points bonus — Équipe B'],
                  ['Z', 'Réponse fausse — Équipe A (0 pt)'],
                  ['S', 'Réponse fausse — Équipe B (0 pt)'],
                  ['←', 'Question précédente'],
                  ['→', 'Question suivante'],
                  ['N', 'Diffuser l’étape suivante à l’écran public'],
                  ['R', 'Reculer d’une étape à l’écran public'],
                ].map(([key, label]) => (
                  <div key={key} className="flex items-center gap-2.5">
                    <kbd className="shrink-0 min-w-[1.6rem] text-center px-1.5 py-0.5 rounded-md border border-slate-300 bg-slate-50 font-mono text-[11px] font-bold text-slate-700">
                      {key}
                    </kbd>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </details>

            {/* ---------- Scénario de diffusion sur l'écran public ----------
                Placé juste au-dessus de l'énoncé, parce que c'est là que se
                trouve l'information que le jury manipule le plus souvent en
                direct : « qu'est-ce que le public regarde en ce moment ? ». */}
            {isRunning && (
              <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                <div className="bg-[#0B3B82] px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white">
                      <Tv className="w-4 h-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-blue-200">
                        Scénario de diffusion — écran public
                      </div>
                      {/* `aria-live` SANS `role="status"`, volontairement.

                          L'étape affichée est un état permanent, pas une annonce
                          éphémère : `role="status"` conviendrait à un message qui
                          s'efface, et surtout il ferait de ce bloc une DEUXIÈME
                          région live à côté du bandeau de retour d'action — deux
                          lecteurs d'écran annonces simultanées pour un seul clic,
                          et les tests qui cherchent le retour d'attribution
                          trouveraient deux correspondances.

                          Le contenu ne changeant que lorsque le jury change
                          d'étape, `aria-live="polite"` suffit à prévenir, et
                          l'élément existe en permanence dans le DOM — condition
                          pour que l'annonce soit fiable. */}
                      <div
                        aria-live="polite"
                        className="text-base font-bold text-white truncate"
                      >
                        {broadcastStage
                          ? BROADCAST_STAGE_LABELS[broadcastStage]
                          : 'Diffusion non démarrée'}
                      </div>
                    </div>
                  </div>

                  {broadcast && (
                    <div className="flex items-center gap-2.5">
                      {broadcastQuestionLabel && (
                        <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white">
                          {broadcastQuestionLabel}
                        </span>
                      )}
                      <span className="text-xs font-bold tabular-nums text-blue-200">
                        Étape {broadcast.stepNumber} / {broadcast.totalSteps}
                      </span>
                    </div>
                  )}
                </div>

                <div className="p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      L'écran affiche
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-700">
                      {broadcastStage === 'REVEAL'
                        ? 'La bonne réponse est diffusée au public.'
                        : broadcastStage === 'ROSTER'
                          ? 'La liste des participants des deux équipes.'
                          : broadcastStage === 'ANSWER_A' || broadcastStage === 'ANSWER_B'
                            ? `La prise de parole de l'équipe ${broadcastStage === 'ANSWER_A' ? 'A' : 'B'}.`
                            : broadcastStage === 'FINAL'
                              ? 'Le score final des deux équipes.'
                              : currentQ
                                ? `L'énoncé de la question ${(broadcast?.questionIndex ?? currentIdx) + 1}, sans sa réponse.`
                                : 'L\'écran d\'attente, le jury prépare la suite.'}
                    </p>
                    {broadcastStage === 'REVEAL' && (
                      <p className="mt-1.5 text-xs font-semibold text-amber-800">
                        Les scores et points se valident depuis les boutons des
                        équipes ci-dessus, comme d'habitude.
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      id="btn-broadcast-restart"
                      type="button"
                      disabled={!canBroadcast}
                      onClick={() => handleBroadcastStep('restart')}
                      title="Revenir au début du scénario (effectif des équipes)"
                      className="px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Reprendre au début</span>
                    </button>

                    <button
                      id="btn-broadcast-previous"
                      type="button"
                      disabled={!canBroadcast}
                      aria-keyshortcuts="R"
                      onClick={() => handleBroadcastStep('previous')}
                      title="Reculer d'une étape (raccourci : R)"
                      className="px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                    >
                      <Rewind className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Reculer</span>
                    </button>

                    <button
                      id="btn-broadcast-next"
                      type="button"
                      disabled={!canBroadcast}
                      aria-keyshortcuts="N"
                      onClick={() => handleBroadcastStep('next')}
                      title={
                        broadcast?.canAdvance === false
                          ? 'Dernière étape atteinte : terminez le match'
                          : 'Diffuser l\'étape suivante (raccourci : N)'
                      }
                      className="px-5 py-2.5 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-bold shadow-xs flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
                    >
                      <span>
                        {broadcast?.canAdvance === false ? 'Scénario terminé' : 'Étape suivante'}
                      </span>
                      <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Current Question & Official Answer Display (Jury Only) */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="bg-slate-50/80 px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="px-3 py-1 rounded-lg bg-[#0B3B82] text-white text-xs font-bold uppercase tracking-wider">
                    Question #{currentIdx + 1}
                  </span>
                  <span className="text-xs font-bold text-slate-700">
                    sur {matchQuestionsList.length || 1} questions
                  </span>
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-50 text-[#0B3B82] border border-blue-200 font-semibold">
                    {currentQ?.categoryName || 'Catégorie'}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">
                    {currentQ?.difficulty || 'MOYEN'}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                    {currentQ?.points || APP_CONFIG.DEFAULT_QUESTION_POINTS} points
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    id="btn-prev-question"
                    type="button"
                    onClick={handlePrevQuestion}
                    disabled={currentIdx <= 0 || actionLoading}
                    aria-keyshortcuts="ArrowLeft"
                    title="Question précédente (raccourci : ←)"
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                  >
                    <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                    <span>Précédente</span>
                  </button>

                  <button
                    id="btn-next-question"
                    type="button"
                    onClick={handleNextQuestion}
                    disabled={currentIdx >= matchQuestionsList.length - 1 || actionLoading}
                    aria-keyshortcuts="ArrowRight"
                    title="Question suivante (raccourci : →)"
                    className="flex items-center gap-1 px-3.5 py-1.5 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
                  >
                    <span>Suivante</span>
                    <ChevronRight className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="p-6 sm:p-8 space-y-6">
                {currentQ ? (
                  <>
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                        Énoncé officiel lu aux candidats :
                      </div>
                      <p className="text-xl sm:text-2xl font-bold text-slate-900 leading-relaxed">
                        {currentQ.text}
                      </p>
                    </div>

                    {currentQ.options && Array.isArray(currentQ.options) && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                        {currentQ.options.map((opt, i) => (
                          <div
                            key={i}
                            className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/50 text-slate-800 text-sm font-medium flex items-center gap-2"
                          >
                            <span className="w-6 h-6 rounded-lg bg-white border border-slate-300 flex items-center justify-center text-xs font-bold text-[#0B3B82]">
                              {String.fromCharCode(65 + i)}
                            </span>
                            <span>{opt}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="p-4 sm:p-5 rounded-2xl bg-emerald-50 border-2 border-emerald-300">
                      <div className="flex items-center gap-2 text-xs font-semibold text-emerald-900 uppercase tracking-wider mb-1">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                        <span>Réponse Officielle Attendue du Jury</span>
                      </div>
                      <div className="text-lg sm:text-xl font-bold text-emerald-900">
                        {currentQ.answer}
                      </div>
                      {currentQ.explanation && (
                        <p className="text-xs text-emerald-800 mt-2 italic">
                          Note pédagogique : {currentQ.explanation}
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-center py-10 text-slate-400 text-sm">
                    Aucune question sélectionnée pour ce match.
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Tools: Manual Audit Adjustment & Score Log */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    <Sliders className="w-4 h-4 text-[#0B3B82]" aria-hidden="true" />
                    <span>Ajustement Arbitral Exceptionnel</span>
                  </div>
                  <h4 className="text-sm font-bold text-slate-900">
                    Correction Manuelle avec Audit
                  </h4>
                  <p className="text-xs text-slate-500 mt-1">
                    Permet d'ajouter ou retirer des points en cas de contestation ou décision du
                    jury. Tout ajustement nécessite un motif obligatoire consigné au journal
                    d'audit.
                  </p>
                </div>

                <button
                  id="btn-open-adjust-modal"
                  type="button"
                  disabled={actionLoading}
                  onClick={() => {
                    setAdjustTeamId(matchDetails.teamAId);
                    setShowAdjustModal(true);
                  }}
                  className="mt-4 w-full py-2.5 px-4 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-800 font-semibold text-xs transition-colors flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Ouvrir le panneau d'ajustement</span>
                </button>
              </div>

              <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Historique des attributions de score (Traçabilité)
                  </div>
                  <span className="text-[11px] font-semibold text-slate-400">
                    {matchDetails.scoreEvents?.length || 0} événements enregistrés
                  </span>
                </div>

                <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 text-xs">
                  {matchDetails.scoreEvents && matchDetails.scoreEvents.length > 0 ? (
                    matchDetails.scoreEvents.map((ev) => {
                      const isTeamA = ev.teamId === matchDetails.teamAId;
                      return (
                        <div key={ev.id} className="py-2.5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={`w-2 h-2 rounded-full ${
                                isTeamA ? 'bg-[#0B3B82]' : 'bg-[#2563EB]'
                              }`}
                            />
                            <span className="font-bold text-slate-800">
                              {isTeamA
                                ? matchDetails.teamA?.name
                                : matchDetails.teamB?.name}
                            </span>
                            <span className="text-slate-400" aria-hidden="true">
                              •
                            </span>
                            <span className="text-slate-600">{ev.reason}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span
                              className={`font-bold tabular-nums px-2 py-0.5 rounded-md ${
                                ev.points > 0
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : ev.points < 0
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {ev.points > 0 ? `+${ev.points}` : ev.points} pts
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {new Date(ev.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-6 text-center text-slate-400">
                      Aucun point encore attribué dans ce match.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="bg-white rounded-2xl p-12 text-center text-slate-400 border border-slate-200">
            {loading ? 'Chargement des données du match...' : 'Aucun match sélectionné.'}
          </div>
        )}
      </div>

      <Modal
        open={showAdjustModal}
        onClose={closeAdjust}
        title="Ajustement arbitral du score"
        busy={actionLoading}
      >
        {matchDetails && (
          <>
            <p className="text-xs text-slate-500 mb-4">
              L'arbitrage doit obligatoirement consigner le motif de la décision pour le rapport
              officiel.
            </p>

            <form onSubmit={handleAdjustSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="adjust-team"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Équipe concernée
                </label>
                <select
                  id="adjust-team"
                  value={adjustTeamId ?? ''}
                  onChange={(e) => setAdjustTeamId(Number(e.target.value))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-800"
                >
                  <option value={matchDetails.teamAId}>
                    Équipe A : {matchDetails.teamA?.name}
                  </option>
                  <option value={matchDetails.teamBId}>
                    Équipe B : {matchDetails.teamB?.name}
                  </option>
                </select>
              </div>

              <fieldset>
                <legend className="block text-xs font-semibold text-slate-700 mb-1">
                  Points à attribuer (+ ou -)
                </legend>
                <div className="grid grid-cols-4 gap-2">
                  {APP_CONFIG.ADJUST_QUICK_VALUES.map((val) => (
                    <button
                      key={val}
                      type="button"
                      aria-pressed={adjustPoints === val}
                      onClick={() => setAdjustPoints(val)}
                      className={`py-2 rounded-xl text-xs font-bold border transition-colors ${
                        adjustPoints === val
                          ? 'bg-[#0B3B82] text-white border-[#0B3B82]'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {val > 0 ? `+${val}` : val}
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <label htmlFor="adjust-points" className="sr-only">
                    Valeur personnalisée de points
                  </label>
                  <input
                    id="adjust-points"
                    type="number"
                    value={adjustPoints}
                    onChange={(e) => setAdjustPoints(Number(e.target.value))}
                    className="w-full p-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-800"
                    placeholder="Valeur personnalisée..."
                  />
                </div>
              </fieldset>

              <div>
                <label
                  htmlFor="adjust-reason"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Motif obligatoire de l'ajustement (Audit AEERKS) *
                </label>
                <textarea
                  id="adjust-reason"
                  required
                  minLength={3}
                  rows={3}
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="ex: Décision collégiale du jury suite à réclamation..."
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800 focus:ring-2 focus:ring-[#2563EB]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeAdjust}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={actionLoading || adjustReason.trim().length < 3}
                  className="px-4 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-bold shadow-xs disabled:opacity-40"
                >
                  Confirmer et consigner
                </button>
              </div>
            </form>
          </>
        )}
      </Modal>

      {/* Confirmation de clôture.
          L'état du match est rappelé ici parce que c'est lui qui rend la
          décision éclairée : « clôturer » n'a pas le même sens à 3–3 en
          question 12 qu'à 18–4 en question 3. Le score est donc affiché, pas
          seulement la formule d'avertissement. */}
      <Modal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Clôturer officiellement ce match ?"
        busy={actionLoading}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Cette action est <strong className="text-slate-800">irréversible</strong> : elle
            fige les scores finaux du match.
          </p>

          {matchDetails && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between text-sm font-semibold text-slate-800">
                <span>{matchDetails.teamA?.name ?? 'Équipe A'}</span>
                <span className="tabular-nums text-[#0B3B82]">{matchDetails.scoreA}</span>
              </div>
              <div className="flex items-center justify-between text-sm font-semibold text-slate-800 mt-1">
                <span>{matchDetails.teamB?.name ?? 'Équipe B'}</span>
                <span className="tabular-nums text-[#0B3B82]">{matchDetails.scoreB}</span>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-200 text-[11px] text-slate-500">
                Match #{matchDetails.matchNumber} — {matchDetails.phase} — question{' '}
                {currentIdx + 1}/{matchQuestionsList.length || '—'}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              disabled={actionLoading}
              className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] disabled:opacity-40"
            >
              Continuer le match
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmClose(false);
                confirmFinishMatch();
              }}
              disabled={actionLoading}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-1 disabled:opacity-40"
            >
              {actionLoading ? 'Clôture…' : 'Clôturer définitivement'}
            </button>
          </div>
        </div>
      </Modal>
    </main>
  );
};
