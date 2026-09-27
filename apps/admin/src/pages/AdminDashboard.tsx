import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLive } from '@shared/context/LiveContext.tsx';
import { APP_CONFIG } from '@shared/lib/config.ts';
import { api, errorMessage, isAbort } from '@shared/lib/api.ts';
import { Modal } from '@shared/components/Modal.tsx';
import { ConfirmDialog } from '@shared/components/ui.tsx';
import type {
  EventItem,
  ParticipantItem,
  TeamItem,
  CategoryItem,
  QuestionItem,
  MatchItem,
  AuditLogItem,
  TeamRanking,
} from '@shared/types.ts';
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  HelpCircle,
  Trophy,
  ClipboardList,
  CheckCircle2,
  Plus,
  Trash2,
  Play,
  RotateCw,
  Sparkles,
  AlertCircle,
  UserPlus,
} from 'lucide-react';
import { UsersManager } from '../components/UsersManager.tsx';

// Onglets réellement implémentés. 'events' et 'scores' figuraient dans l'union
// mais n'avaient aucune branche de rendu : deux valeurs inatteignables.
type AdminTab =
  | 'overview'
  | 'participants'
  | 'teams'
  | 'questions'
  | 'matches'
  | 'results'
  | 'audit'
  | 'users';

interface AdminTabDef {
  id: AdminTab;
  label: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** Pastille indicative. */
  badge?: 'count' | 'published';
}

/**
 * Barème de navigation. Le rendu est isolé dans le composant : auparavant les
 * 8 boutons étaient écrits en dur dans le JSX, chacun dupliquant ses classes
 * de style actif, ce qui rendait toute evolution visuelle_fastidieuse.
 */
const TAB_DEFS: AdminTabDef[] = [
  { id: 'overview', label: 'Aperçu & Pilotage', Icon: LayoutDashboard },
  { id: 'results', label: 'Résultats Officiels', Icon: Trophy, badge: 'published' },
  { id: 'matches', label: 'Matchs & Calendrier', Icon: Play, badge: 'count' },
  { id: 'teams', label: 'Équipes & Membres', Icon: Users, badge: 'count' },
  { id: 'questions', label: 'Banque de Questions', Icon: HelpCircle, badge: 'count' },
  { id: 'participants', label: 'Membres AEERKS', Icon: GraduationCap, badge: 'count' },
  { id: 'audit', label: "Journal d'Audit & Règles", Icon: ClipboardList },
  { id: 'users', label: 'Comptes & Membres du Jury', Icon: UserPlus },
];

export const AdminDashboard: React.FC = () => {
  // Le jeton est lu par le client HTTP (shared/lib/api.ts) : inutile ici.
  const { refreshLiveState } = useLive();

  const [currentTab, setCurrentTab] = useState<AdminTab>('overview');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // minuteur de toast : sans annulation du précédent, deux actions à 1 s
  // d'intervalle voyaient le second message effacé par le premier.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entities state
  const [eventsList, setEventsList] = useState<EventItem[]>([]);
  const [participantsList, setParticipantsList] = useState<ParticipantItem[]>([]);
  const [teamsList, setTeamsList] = useState<TeamItem[]>([]);
  const [categoriesList, setCategoriesList] = useState<CategoryItem[]>([]);
  const [questionsList, setQuestionsList] = useState<QuestionItem[]>([]);
  const [matchesList, setMatchesList] = useState<MatchItem[]>([]);
  const [rankingsList, setRankingsList] = useState<TeamRanking[]>([]);
  const [auditLogsList, setAuditLogsList] = useState<AuditLogItem[]>([]);
  // NB: la liste des comptes n'est PAS gérée ici — UsersManager est son seul
  // propriétaire (il la charge et la rafraîchit lui-même).

  // Modals state
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newEventEdition, setNewEventEdition] = useState<string>(
    APP_CONFIG.DEFAULT_EVENT_EDITION
  );
  const [newEventLocation, setNewEventLocation] = useState<string>(APP_CONFIG.DEFAULT_EVENT_LOCATION);

  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [newPartFirstName, setNewPartFirstName] = useState('');
  const [newPartLastName, setNewPartLastName] = useState('');
  const [newPartGender, setNewPartGender] = useState('M');

  const [showManageTeamMembers, setShowManageTeamMembers] = useState(false);
  const [membersTeamId, setMembersTeamId] = useState<number | ''>('');
  const [memberParticipantId, setMemberParticipantId] = useState<number | ''>('');
  const [memberRole, setMemberRole] = useState<'CAPTAIN' | 'MEMBER'>('MEMBER');

  const [showAddTeam, setShowAddTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamCode, setNewTeamCode] = useState('');

  const [showAddQuestion, setShowAddQuestion] = useState(false);
  const [newQText, setNewQText] = useState('');
  const [newQAnswer, setNewQAnswer] = useState('');
  const [newQCatId, setNewQCatId] = useState<number | ''>('');
  const [newQPoints, setNewQPoints] = useState<number>(APP_CONFIG.DEFAULT_QUESTION_POINTS);
  const [newQTime, setNewQTime] = useState<number>(APP_CONFIG.DEFAULT_TIMER_SECONDS);
  const [newQDifficulty, setNewQDifficulty] = useState<'FACILE' | 'MOYEN' | 'DIFFICILE'>('MOYEN');
  const [newQType, setNewQType] = useState<'DIRECT' | 'QCM' | 'TRUE_FALSE' | 'RAPID' | 'BONUS'>('DIRECT');
  const [newQOptions, setNewQOptions] = useState('');

  const [showAddMatch, setShowAddMatch] = useState(false);
  const [newMatchPhase, setNewMatchPhase] = useState<string>(APP_CONFIG.DEFAULT_MATCH_PHASE);
  // Numéro de match : il était initialisé à 1 et envoyé tel quel, SANS qu'aucun
  // champ de saisie n'existe dans la modale. Tous les matchs programmés depuis
  // l'UI recevaient donc matchNumber = 1, alors que l'ordre du tournoi s'appuie
  // dessus (getLiveState trie par matchNumber).
  const [newMatchNumber, setNewMatchNumber] = useState(1);
  const [newMatchTeamA, setNewMatchTeamA] = useState<number | ''>('');
  const [newMatchTeamB, setNewMatchTeamB] = useState<number | ''>('');

  // Confirmations d'actions à conséquence officielle. Auparavant, ces actions
  // demandaient une validation par `window.confirm` : dialogue hors système,
  // sans l'état de l'événement, et dont le rendu varie d'une machine à l'autre
  // pour un acte qui engage la compétition entière.
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  /**
   * Matchs non clôturés, pour l'aperçu du dialogue de publication.
   *
   * Le serveur refuse (409) de publier tant qu'un match n'est pas terminé.
   * Afficher ce décompte AVANT l'envoi évite au comité d'ouvrir une confirmation
   * pour une opération qui échouera : l'information est disponible, autant la
   * donner au bon moment.
   */
  const unfinishedMatches = matchesList.filter(
    (m) => m.status !== 'FINISHED' && m.status !== 'CANCELLED'
  ).length;

  const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    setMessage({ type, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(null), APP_CONFIG.FEEDBACK_DISMISS_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  /**
   * Chargement de toutes les collections.
   *
   * Le client HTTP lève une ApiError : plus de `if (res.ok)` sans branche
   * `else`, qui faisait qu'un 401 de session expirée laissait des tableaux
   * vides sans aucun message. Chaque collection est traitée indépendamment
   * pour qu'une erreur isolée n'efface pas tout l'écran.
   */
  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      const load = async <T,>(
        path: string,
        apply: (data: T) => void,
        opts: { public?: boolean } = {}
      ): Promise<string | null> => {
        try {
          const data = await api.get<T>(path, { signal, ...(opts.public ? { token: null } : {}) });
          apply(data);
          return null;
        } catch (e) {
          if (isAbort(e)) return null;
          return errorMessage(e, `Chargement de ${path} impossible`);
        }
      };

      const [errEvents, errPart, errTeams, errCat, errQuestions, errMatches, errRankings, errAud] =
        await Promise.all([
          load<EventItem[]>('/api/events', setEventsList),
          load<ParticipantItem[]>('/api/participants', setParticipantsList),
          load<TeamItem[]>('/api/teams', setTeamsList),
          load<CategoryItem[]>('/api/categories', setCategoriesList),
          load<QuestionItem[]>('/api/questions', setQuestionsList),
          load<MatchItem[]>('/api/matches', setMatchesList),
          load<TeamRanking[]>('/api/rankings', setRankingsList, { public: true }),
          load<AuditLogItem[]>('/api/audit-logs', setAuditLogsList),
        ]);

      // On ne remonte que la PREMIÈRE erreur : un pavé de 8 toasts n'aide personne.
      // Le classement (/api/rankings) reste public : son échec n'est pas bloquant.
      const firstError =
        errEvents || errPart || errTeams || errCat || errQuestions || errMatches || errAud;
      if (firstError) showToast(firstError, 'error');
      else if (errRankings) console.warn('Classement indisponible:', errRankings);

      if (!signal?.aborted) setLoading(false);
    },
    [showToast]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // Publication of results (Section 24)
  // Événement "courant" : l'événement actif le plus plausible, sinon le plus récent
  const currentEvent = useMemo<EventItem | null>(() => {
    if (!Array.isArray(eventsList) || eventsList.length === 0) return null;
    return (
      eventsList.find((e) =>
        ['READY', 'RUNNING', 'PAUSED', 'REGISTRATION'].includes(e?.status)
      ) ?? eventsList.slice().sort((a, b) => (b?.id ?? 0) - (a?.id ?? 0))[0]
    );
  }, [eventsList]);

  const handlePublishResults = async () => {
    if (!currentEvent) {
      showToast('Aucun événement courant sélectionné', 'error');
      return;
    }
    // La confirmation est portée par un dialogue de l'application, pas par
    // `window.confirm` : elle affiche le nombre de matchs concerned et le
    // caractère officiel de l'acte. Publier un podium est un acte
    // institutionnel, pas un réglage.
    setConfirmPublish(true);
  };

  const confirmPublishResults = async () => {
    if (!currentEvent) return;
    setConfirmPublish(false);
    try {
      await api.post(`/api/events/${currentEvent.id}/publish-results`);
      showToast("Résultats officiels publiés sur l'écran Live !");
      void fetchData();
      void refreshLiveState();
    } catch (e) {
      // 409 = publication refusée car des matchs ne sont pas clôturés.
      showToast(errorMessage(e, 'Publication impossible'), 'error');
    }
  };

  const handleUnpublishResults = async () => {
    if (!currentEvent) {
      showToast('Aucun événement courant sélectionné', 'error');
      return;
    }
    // Confirmation explicite : un clic unique retirait les résultats officiels
    // de l'écran public, sans confirmation.
    setConfirmUnpublish(true);
  };

  const confirmUnpublishResults = async () => {
    if (!currentEvent) return;
    setConfirmUnpublish(false);
    try {
      await api.post(`/api/events/${currentEvent.id}/unpublish-results`);
      showToast('Publication des résultats retirée.');
      void fetchData();
      void refreshLiveState();
    } catch (e) {
      showToast(errorMessage(e, 'Retrait de la publication impossible'), 'error');
    }
  };

  // Add Team
  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName || !newTeamCode) return;
    try {
      await api.post('/api/teams', {
        name: newTeamName,
        code: newTeamCode,
        eventId: currentEvent?.id,
      });
      showToast('Équipe enregistrée avec succès');
      setNewTeamName('');
      setNewTeamCode('');
      setShowAddTeam(false);
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur création équipe'), 'error');
    }
  };

  // Add Question
  const handleCreateQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQText || !newQAnswer || !newQCatId) return;
    try {
      await api.post('/api/questions', {
        categoryId: newQCatId,
        text: newQText,
        answer: newQAnswer,
        points: newQPoints,
        timeLimitSeconds: newQTime,
        difficulty: newQDifficulty,
        type: newQType,
        options:
          newQType === 'QCM'
            ? newQOptions.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
      });
      showToast('Question enregistrée dans la banque');
      setNewQText('');
      setNewQAnswer('');
      setNewQOptions('');
      setShowAddQuestion(false);
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur enregistrement question'), 'error');
    }
  };

  // Add Match
  const handleCreateMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMatchTeamA || !newMatchTeamB || newMatchTeamA === newMatchTeamB) {
      showToast('Sélectionnez deux équipes distinctes', 'error');
      return;
    }
    if (!currentEvent) {
      showToast('Aucun événement courant : impossible de programmer un match', 'error');
      return;
    }
    try {
      await api.post('/api/matches', {
        phase: newMatchPhase,
        matchNumber: newMatchNumber,
        teamAId: newMatchTeamA,
        teamBId: newMatchTeamB,
        eventId: currentEvent.id,
      });
      showToast('Match programmé avec succès');
      setShowAddMatch(false);
      void fetchData();
      void refreshLiveState();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur programmation du match'), 'error');
    }
  };

  // Create Event
  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEventName || !newEventEdition) return;
    try {
      await api.post('/api/events', {
        name: newEventName,
        edition: newEventEdition,
        location: newEventLocation,
      });
      showToast('Événement créé avec succès');
      setNewEventName('');
      setShowAddEvent(false);
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur création événement'), 'error');
    }
  };

  // Create Category
  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName) return;
    try {
      await api.post('/api/categories', { name: newCategoryName });
      showToast('Catégorie créée avec succès');
      setNewCategoryName('');
      setShowAddCategory(false);
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur création catégorie'), 'error');
    }
  };

  // Create Participant
  const handleCreateParticipant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPartFirstName || !newPartLastName) return;
    try {
      await api.post('/api/participants', {
        firstName: newPartFirstName,
        lastName: newPartLastName,
        gender: newPartGender,
      });
      showToast('Membre enregistré avec succès');
      setNewPartFirstName('');
      setNewPartLastName('');
      setShowAddParticipant(false);
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur enregistrement du membre'), 'error');
    }
  };

  const selectedTeamForMembers = teamsList.find((t) => t.id === membersTeamId);

  // Add member to a team
  const handleAddTeamMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!membersTeamId || !memberParticipantId) return;
    try {
      await api.post(`/api/teams/${membersTeamId}/members`, {
        participantId: memberParticipantId,
        role: memberRole,
      });
      showToast("Membre affecté à l'équipe");
      setMemberParticipantId('');
      setMemberRole('MEMBER');
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur affectation'), 'error');
    }
  };

  const handleRemoveTeamMember = async (memberId: number) => {
    if (!membersTeamId) return;
    try {
      await api.delete(`/api/teams/${membersTeamId}/members/${memberId}`);
      showToast("Membre retiré de l'équipe");
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur retrait du membre'), 'error');
    }
  };

  const handlePromoteCaptain = async (memberId: number) => {
    if (!membersTeamId) return;
    try {
      await api.post(`/api/teams/${membersTeamId}/members/${memberId}/captain`);
      showToast('Capitaine désigné avec succès');
      void fetchData();
    } catch (err) {
      showToast(errorMessage(err, 'Erreur désignation du capitaine'), 'error');
    }
  };

  const unassignedParticipants = participantsList.filter(
    (p) => !selectedTeamForMembers?.members?.some((m) => m.participantId === p.id)
  );

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-50 flex flex-col md:flex-row md:h-[calc(100vh-4rem)] md:overflow-hidden">
      {/*
        Navigation. Sur mobile elle occupait un bloc de 8 boutons pleine
        largeur qui repoussait le contenu hors de l'écran : la première vue
        d'un téléphone était uniquement de la navigation. Elle devient un
        bandeau horizontal défilant sous 768 px, et une colonne ensuite.
      */}
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-200 p-3 md:p-4 shrink-0">
        <div className="mb-3 md:mb-6 px-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#0B3B82]">
            Comité d'Organisation
          </div>
          <h2 className="text-base font-bold text-slate-900 leading-tight">
            Administration AEERKS
          </h2>
        </div>

        <nav
          aria-label="Sections de l'administration"
          className="flex md:block gap-1 md:space-y-1 overflow-x-auto md:overflow-visible pb-1 md:pb-0 -mx-1 px-1 md:mx-0 md:px-0"
        >
          {TAB_DEFS.map(({ id, label, Icon, badge }) => {
            const isActive = currentTab === id;
            // Compteurs vivants, précédemment écrits en dur dans chaque bouton.
            const count =
              badge === 'count'
                ? ({
                    matches: matchesList.length,
                    teams: teamsList.length,
                    questions: questionsList.length,
                    participants: participantsList.length,
                  }[id as 'matches'] ?? 0)
                : null;
            return (
              <button
                key={id}
                id={`tab-${id}`}
                type="button"
                onClick={() => setCurrentTab(id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full shrink-0 flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 ${
                  isActive
                    ? 'bg-[#0B3B82] text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
                {count != null && (
                  <span
                    className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-md ${
                      isActive ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {count}
                  </span>
                )}
                {badge === 'published' && currentEvent?.resultsPublished && (
                  <span
                    className="ml-auto w-2 h-2 rounded-full bg-emerald-400 shrink-0"
                    aria-label="résultats publiés"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Accès rapide à la table d'arbitrage */}
        <div className="hidden md:block mt-8 pt-6 border-t border-slate-200">
          <a
            id="btn-goto-jury-from-admin"
            href="/jury"
            className="w-full py-2.5 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 text-xs font-bold flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <Trophy className="w-4 h-4 text-amber-600" aria-hidden="true" />
            <span>Ouvrir la Table du Jury</span>
          </a>
        </div>
      </aside>

      {/* Contenu */}
      <div className="flex-1 flex flex-col min-h-0">
      <main id="contenu-principal" className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
        {/* Indicateur de chargement : `loading` était alimenté par fetchData
            mais jamais consommé — l'écran restait vide sans feedback. */}
        <div
          role="status"
          aria-live="polite"
          aria-busy={loading}
          className="sr-only"
        >
          {loading ? 'Chargement des données en cours…' : ''}
        </div>
        {loading && (
          <div
            data-testid="admin-loading"
            className="mb-6 flex items-center gap-2 text-xs font-semibold text-slate-500"
          >
            <span
              className="w-3.5 h-3.5 border-2 border-[#0B3B82] border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
            Actualisation des données…
          </div>
        )}

        {/* Toast — annoncé aux lecteurs d'écran */}
        {message && (
          <div
            id="admin-toast-alert"
            role="status"
            aria-live="polite"
            className={`mb-6 p-4 rounded-xl border text-xs font-semibold flex items-center justify-between shadow-xs ${
              message.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {message.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600" aria-hidden="true" />
              )}
              <span>{message.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setMessage(null)}
              aria-label="Fermer la notification"
              className="text-slate-400 hover:text-slate-600"
            >
              ✕
            </button>
          </div>
        )}

        {/* TAB 1: OVERVIEW */}
        {currentTab === 'overview' && (
          <div className="space-y-6">
            {/* Header / Event banner */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-wrap items-center justify-between gap-4">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-[#0B3B82]">
                  {currentEvent?.edition || APP_CONFIG.DEFAULT_EVENT_EDITION}
                </span>
                <h2 className="text-2xl font-bold text-slate-900 mt-1">
                  {currentEvent?.name || "Journée d'Excellence AEERKS"}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {currentEvent?.location || APP_CONFIG.DEFAULT_EVENT_LOCATION} • Statut :{' '}
                  <span className="font-bold text-slate-800">{currentEvent?.status}</span>
                </p>
              </div>

              {/* Publication button */}
              <div>
                {!currentEvent ? (
                  <button
                    id="btn-create-event-overview"
                    onClick={() => setShowAddEvent(true)}
                    className="px-4 py-2.5 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white font-bold text-xs shadow-md flex items-center gap-2 transition-all"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Créer l'Événement / l'Édition</span>
                  </button>
                ) : currentEvent.resultsPublished ? (
                  <div className="flex items-center gap-3">
                    <span className="px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Résultats Publiés en Direct</span>
                    </span>
                    <button
                      id="btn-unpublish-overview"
                      onClick={handleUnpublishResults}
                      className="px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700"
                    >
                      Masquer du public
                    </button>
                  </div>
                ) : (
                  <button
                    id="btn-publish-overview"
                    onClick={handlePublishResults}
                    className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md flex items-center gap-2 transition-all"
                  >
                    <Trophy className="w-4 h-4" />
                    <span>Publier les Résultats Officiels</span>
                  </button>
                )}
              </div>
            </div>

            {/* Stat Cards Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
                <div className="text-xs font-bold text-slate-500 uppercase">Équipes en lice</div>
                <div className="text-3xl font-bold tabular-nums text-[#0B3B82] mt-2">
                  {teamsList.length}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">4 membres par équipe</div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
                <div className="text-xs font-bold text-slate-500 uppercase">Membres AEERKS</div>
                <div className="text-3xl font-bold tabular-nums text-slate-900 mt-2">
                  {participantsList.length}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">Élèves & étudiants de l'association</div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
                <div className="text-xs font-bold text-slate-500 uppercase">Banque de Questions</div>
                <div className="text-3xl font-bold tabular-nums text-slate-900 mt-2">
                  {questionsList.length}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">{categoriesList.length} catégories</div>
              </div>

              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
                <div className="text-xs font-bold text-slate-500 uppercase">Matchs au programme</div>
                <div className="text-3xl font-bold tabular-nums text-slate-900 mt-2">
                  {matchesList.length}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">Qualification & Finale</div>
              </div>
            </div>

            {/* Tournament Standings Snapshot */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Classement Provisoire de la Compétition
                  </h3>
                  <p className="text-xs text-slate-500">
                    Calculé en temps réel à partir des scores officiels validés par le jury
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchData()}
                  title="Rafraîchir les données"
                  aria-label="Rafraîchir les données"
                  className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600"
                >
                  <RotateCw className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-500 font-bold uppercase border-y border-slate-200">
                    <tr>
                      <th className="py-3 px-4">Rang</th>
                      <th className="py-3 px-4">Équipe</th>
                      <th className="py-3 px-4 text-center">Joués</th>
                      <th className="py-3 px-4 text-center">Victoires</th>
                      <th className="py-3 px-4 text-center">Points Marqués</th>
                      <th className="py-3 px-4 text-right">Total Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rankingsList.map((r) => (
                      <tr key={r.teamId} className="hover:bg-slate-50/50">
                        <td className="py-3.5 px-4 font-bold tabular-nums text-[#0B3B82]">
                          #{r.position}
                        </td>
                        <td className="py-3.5 px-4 font-bold text-slate-900">
                          {r.teamName} ({r.teamCode})
                        </td>
                        <td className="py-3.5 px-4 text-center text-slate-700">{r.matchesPlayed}</td>
                        <td className="py-3.5 px-4 text-center text-emerald-600 font-bold">{r.wins}</td>
                        <td className="py-3.5 px-4 text-center text-slate-700">{r.pointsScored}</td>
                        <td className="py-3.5 px-4 text-right font-bold tabular-nums text-[#0B3B82] text-sm">
                          {r.totalScore} pts
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: RÉSULTATS OFFICIELS (Section 23 & 24) */}
        {currentTab === 'results' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-[#0B3B82]">
                    Processus de Proclamation des Vainqueurs
                  </div>
                  <h3 className="text-xl font-bold text-slate-900">
                    Contrôle de Publication des Résultats Officiels
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                    Conformément aux règles de l'AEERKS : le calcul des scores est automatique mais la publication sur l'écran Live reste sous le contrôle exclusif du comité d'organisation.
                  </p>
                </div>

                <div>
                  {currentEvent?.resultsPublished ? (
                    <button
                      id="btn-cancel-publication"
                      onClick={handleUnpublishResults}
                      className="px-4 py-2.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-700 text-xs font-bold hover:bg-rose-100 transition-colors"
                    >
                      Annuler la publication en direct
                    </button>
                  ) : (
                    <button
                      id="btn-publish-results-tab"
                      onClick={handlePublishResults}
                      className="px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-lg flex items-center gap-2 transition-all"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Publier Officiellement les Résultats</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Status Banner */}
              <div
                className={`mt-6 p-4 rounded-2xl border flex items-center gap-3 ${
                  currentEvent?.resultsPublished
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-amber-50 border-amber-200 text-amber-800'
                }`}
              >
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div className="text-xs">
                  <span className="font-bold">
                    {currentEvent?.resultsPublished
                      ? 'État actuel : PUBLIÉ EN DIRECT'
                      : 'État actuel : PRIVÉ (Non publié)'}
                  </span>
                  <p className="mt-0.5 opacity-90">
                    {currentEvent?.resultsPublished
                      ? 'Le public et les spectateurs visualisent actuellement le podium officiel et les scores certifiés.'
                      : 'L\'écran live public affiche « Génie en Herbe terminé - Les résultats officiels seront annoncés prochainement ».'}
                  </p>
                </div>
              </div>
            </div>

            {/* Official Podium Preview */}
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
              <h4 className="text-sm font-bold text-slate-900 mb-4">
                Aperçu du Palmarès Officiel
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {rankingsList.slice(0, 3).map((r, idx) => (
                  <div
                    key={r.teamId}
                    className={`p-5 rounded-2xl border ${
                      idx === 0
                        ? 'bg-amber-50/60 border-amber-200'
                        : idx === 1
                        ? 'bg-slate-50 border-slate-200'
                        : 'bg-amber-900/5 border-amber-800/20'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`w-8 h-8 rounded-xl font-bold tabular-nums text-sm flex items-center justify-center ${
                          idx === 0
                            ? 'bg-amber-400 text-slate-900 shadow-xs'
                            : idx === 1
                            ? 'bg-slate-300 text-slate-800'
                            : 'bg-amber-700 text-amber-100'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <span className="text-xs font-bold uppercase text-slate-400">
                        {idx === 0 ? '1er Prix' : idx === 1 ? '2ème Prix' : '3ème Prix'}
                      </span>
                    </div>
                    <h5 className="text-lg font-bold text-slate-900 mt-3">{r.teamName}</h5>
                    <div className="mt-3 text-2xl font-bold tabular-nums text-[#0B3B82]">
                      {r.totalScore} <span className="text-xs font-bold text-slate-400">pts</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: MATCHS & PROGRAMMATION */}
        {currentTab === 'matches' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  Programmation des Matchs de Génie en Herbe
                </h3>
                <p className="text-xs text-slate-500">
                  Gestion des rencontres, affectation du jury et lancement
                </p>
              </div>
              <button
                id="btn-add-match"
                onClick={() => setShowAddMatch(true)}
                className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Programmer un Match</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {matchesList.map((m) => (
                <div
                  key={m.id}
                  className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold uppercase px-2 py-0.5 rounded-md bg-blue-50 text-[#0B3B82]">
                        Match #{m.matchNumber}
                      </span>
                      <span
                        className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                          m.status === 'LIVE'
                            ? 'bg-emerald-100 text-emerald-800 animate-pulse'
                            : m.status === 'FINISHED'
                            ? 'bg-slate-100 text-slate-700'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {m.status}
                      </span>
                    </div>

                    <div className="text-xs font-bold text-slate-400 mb-1">{m.phase}</div>

                    <div className="space-y-2 my-4">
                      <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50">
                        <span className="text-xs font-bold text-slate-800">{m.teamA?.name}</span>
                        <span className="text-sm font-bold tabular-nums text-[#0B3B82]">{m.scoreA}</span>
                      </div>
                      <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50">
                        <span className="text-xs font-bold text-slate-800">{m.teamB?.name}</span>
                        <span className="text-sm font-bold tabular-nums text-[#0B3B82]">{m.scoreB}</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">
                      Jury : {m.juryName || 'Non assigné'}
                    </span>
                    <a
                      href="/jury"
                      className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold"
                    >
                      Arbitrer
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: TEAMS */}
        {currentTab === 'teams' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Équipes Constituées</h3>
                  <p className="text-xs text-slate-500">
                    Équipes de membres AEERKS participantes et composition
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    id="btn-manage-members"
                    onClick={() => setShowManageTeamMembers(true)}
                    className="px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs flex items-center gap-1.5"
                  >
                    <Users className="w-4 h-4 text-[#0B3B82]" />
                    <span>Composition des Équipes</span>
                  </button>
                  <button
                    id="btn-add-team"
                    onClick={() => setShowAddTeam(true)}
                    className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nouvelle Équipe</span>
                  </button>
                </div>
              </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {teamsList.map((t) => (
                <div
                  key={t.id}
                  className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase px-2.5 py-1 rounded-md bg-blue-50 text-[#0B3B82]">
                      {t.code}
                    </span>
                  </div>
                  <h4 className="text-base font-bold text-slate-900">{t.name}</h4>

                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                      Membres de l'équipe ({t.members?.length || 0}/4)
                    </div>
                    <div className="space-y-1.5">
                      {t.members && t.members.length > 0 ? (
                        t.members.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-50"
                          >
                            <span className="font-semibold text-slate-800">
                              {m.participant?.firstName} {m.participant?.lastName}
                            </span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                m.role === 'CAPTAIN'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-slate-200 text-slate-700'
                              }`}
                            >
                              {m.role === 'CAPTAIN' ? 'Capitaine' : 'Titulaire'}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-slate-400 py-2">
                          Aucun membre affecté pour l'instant.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 5: QUESTIONS */}
        {currentTab === 'questions' && (
          <div className="space-y-6">
<div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Banque de Questions</h3>
                  <p className="text-xs text-slate-500">
                    Questions officielles classées par disciplines et difficultés
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    id="btn-add-category"
                    onClick={() => setShowAddCategory(true)}
                    className="px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4 text-[#0B3B82]" />
                    <span>Nouvelle Catégorie</span>
                  </button>
                  <button
                    id="btn-add-question"
                    onClick={() => setShowAddQuestion(true)}
                    className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Ajouter une Question</span>
                  </button>
                </div>
              </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs divide-y divide-slate-100">
              {questionsList.map((q) => (
                <div key={q.id} className="p-5 hover:bg-slate-50/50 transition-colors">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-md bg-blue-50 text-[#0B3B82] text-xs font-bold">
                        {q.categoryName}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
                        {q.difficulty}
                      </span>
                    </div>
                    <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                      {q.points} points • {q.timeLimitSeconds}s
                    </span>
                  </div>

                  <p className="text-sm font-bold text-slate-900 mt-1">{q.text}</p>

                  <div className="mt-3 p-3 rounded-xl bg-emerald-50/80 border border-emerald-200 text-xs">
                    <span className="font-semibold text-emerald-900">Réponse officielle : </span>
                    <span className="text-emerald-900 font-semibold">{q.answer}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 6: PARTICIPANTS */}
        {currentTab === 'participants' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Participants Enregistrés</h3>
                <p className="text-xs text-slate-500">
                  Membres de l'association en lice pour le Génie en Herbe ({participantsList.length})
                </p>
              </div>
              <button
                id="btn-add-participant"
                onClick={() => setShowAddParticipant(true)}
                className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Enregistrer un Membre</span>
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 font-bold uppercase border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">Nom et Prénom</th>
                    <th className="py-3 px-4">Genre</th>
                    <th className="py-3 px-4">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {participantsList.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/50">
                      <td className="py-3 px-4 font-bold text-slate-900">
                        {p.firstName} {p.lastName}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{p.gender === 'F' ? 'Féminin' : 'Masculin'}</td>
                      <td className="py-3 px-4 text-slate-600">{p.phone || p.email || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 8: AUDIT & REGLES */}
        {currentTab === 'audit' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-bold text-slate-900">Journal d'Audit & Traçabilité</h3>
              <p className="text-xs text-slate-500">
                Historique certifié de chaque action critique, score attribué et ajustement
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 text-xs">
                {auditLogsList.map((log) => (
                  <div key={log.id} className="p-4 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-[#0B3B82] uppercase">{log.action}</span>
                        <span className="text-slate-400">•</span>
                        <span className="text-slate-600">{log.entity} #{log.entityId}</span>
                      </div>
                      {log.metadata && (
                        <p className="text-slate-500 mt-1">{log.metadata}</p>
                      )}
                    </div>
                    <div className="text-right text-slate-400">
                      <div>{log.userEmail || 'Système'}</div>
                      <div className="text-[10px]">{new Date(log.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 9: COMPTES & JURY */}
        {currentTab === 'users' && (
          <UsersManager
            onMessage={(text, type) => {
              showToast(text, type);
            }}
          />
        )}
      </main>

      {/* MODAL ADD TEAM */}
      <Modal
        open={showAddTeam}
        onClose={() => setShowAddTeam(false)}
        title="Nouvelle Équipe"
        className="max-w-md"
      >
            <form onSubmit={handleCreateTeam} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nom de l'équipe</label>
                <input
                  required
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="ex: Les Prodiges du Baol"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Code (court)</label>
                <input
                  required
                  value={newTeamCode}
                  onChange={(e) => setNewTeamCode(e.target.value)}
                  placeholder="ex: PRO-BAOL"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddTeam(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Créer l'équipe
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL ADD QUESTION */}
      <Modal
        open={showAddQuestion}
        onClose={() => setShowAddQuestion(false)}
        title="Nouvelle Question"
        className="max-w-lg"
      >
            <form onSubmit={handleCreateQuestion} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Catégorie *</label>
                <select
                  required
                  value={newQCatId}
                  onChange={(e) => setNewQCatId(Number(e.target.value))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                >
                  <option value="">Sélectionner une discipline...</option>
                  {categoriesList.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Énoncé de la question *</label>
                <textarea
                  required
                  rows={3}
                  value={newQText}
                  onChange={(e) => setNewQText(e.target.value)}
                  placeholder="Énoncé lu à haute voix..."
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Réponse officielle certifiée *</label>
                <input
                  required
                  value={newQAnswer}
                  onChange={(e) => setNewQAnswer(e.target.value)}
                  placeholder="Réponse exacte attendue..."
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800 font-bold"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Points</label>
                  <input
                    type="number"
                    value={newQPoints}
                    onChange={(e) => setNewQPoints(Number(e.target.value))}
                    className="w-full p-2 rounded-xl border border-slate-300 text-xs text-slate-800 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Temps (sec)</label>
                  <input
                    type="number"
                    value={newQTime}
                    onChange={(e) => setNewQTime(Number(e.target.value))}
                    className="w-full p-2 rounded-xl border border-slate-300 text-xs text-slate-800 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Difficulté</label>
                  <select
                    value={newQDifficulty}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNewQDifficulty(
                        v === 'FACILE' || v === 'DIFFICILE' ? v : 'MOYEN'
                      );
                    }}
                    className="w-full p-2 rounded-xl border border-slate-300 text-xs text-slate-800 font-semibold"
                  >
                    <option value="FACILE">Facile</option>
                    <option value="MOYEN">Moyen</option>
                    <option value="DIFFICILE">Difficile</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Type de question</label>
                <select
                  value={newQType}
                  onChange={(e) => {
                    const v = e.target.value;
                    setNewQType(
                      v === 'QCM' || v === 'TRUE_FALSE' || v === 'RAPID' || v === 'BONUS'
                        ? v
                        : 'DIRECT'
                    );
                  }}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800 font-semibold"
                >
                  <option value="DIRECT">Directe (énoncé oral)</option>
                  <option value="QCM">QCM (choix multiples)</option>
                  <option value="TRUE_FALSE">Vrai / Faux</option>
                  <option value="RAPID">Rapidité (vitesse)</option>
                  <option value="BONUS">Bonus</option>
                </select>
              </div>
              {newQType === 'QCM' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Options (séparées par des virgules) * — 2 minimum
                  </label>
                  <textarea
                    required
                    rows={2}
                    value={newQOptions}
                    onChange={(e) => setNewQOptions(e.target.value)}
                    placeholder="ex: Dakar, Saint-Louis, Thiès, Ziguinchor"
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddQuestion(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Enregistrer la question
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL ADD MATCH */}
      <Modal
        open={showAddMatch}
        onClose={() => setShowAddMatch(false)}
        title="Programmer un Match"
        className="max-w-md"
      >
            <form onSubmit={handleCreateMatch} className="space-y-3">
              <div>
                <label
                  htmlFor="match-phase"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Phase
                </label>
                <input
                  id="match-phase"
                  required
                  value={newMatchPhase}
                  onChange={(e) => setNewMatchPhase(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              {/* Ce champ manquait : `newMatchNumber` partait à 1 et était
                  envoyé tel quel à l'API. Tous les matchs programmés depuis
                  l'UI recevaient donc matchNumber = 1, alors que l'ordre du
                  tournoi et le tri de l'écran live s'appuient sur cette valeur. */}
              <div>
                <label
                  htmlFor="match-number"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Numéro du match *
                </label>
                <input
                  id="match-number"
                  type="number"
                  min={1}
                  required
                  value={newMatchNumber}
                  onChange={(e) => setNewMatchNumber(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800 font-bold"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Détermine l'ordre d'affichage des matchs (écran public et jury).
                </p>
              </div>
              <div>
                <label
                  htmlFor="match-team-a"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Équipe A *
                </label>
                <select
                  id="match-team-a"
                  required
                  value={newMatchTeamA}
                  onChange={(e) => setNewMatchTeamA(Number(e.target.value))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                >
                  <option value="">Sélectionner l'Équipe A...</option>
                  {teamsList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="match-team-b"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Équipe B *
                </label>
                <select
                  id="match-team-b"
                  required
                  value={newMatchTeamB}
                  onChange={(e) => setNewMatchTeamB(Number(e.target.value))}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                >
                  <option value="">Sélectionner l'Équipe B...</option>
                  {teamsList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddMatch(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Créer le match
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL ADD EVENT */}
      <Modal
        open={showAddEvent}
        onClose={() => setShowAddEvent(false)}
        title="Créer l'Événement / l'Édition"
        className="max-w-md"
      >
            <form onSubmit={handleCreateEvent} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nom de l'événement *</label>
                <input
                  required
                  value={newEventName}
                  onChange={(e) => setNewEventName(e.target.value)}
                  placeholder="ex: Journée d'Excellence AEERKS"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Édition *</label>
                <input
                  required
                  value={newEventEdition}
                  onChange={(e) => setNewEventEdition(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Localisation</label>
                <input
                  value={newEventLocation}
                  onChange={(e) => setNewEventLocation(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddEvent(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Créer l'événement
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL ADD CATEGORY */}
      <Modal
        open={showAddCategory}
        onClose={() => setShowAddCategory(false)}
        title="Nouvelle Catégorie / Discipline"
        className="max-w-md"
      >
            <form onSubmit={handleCreateCategory} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nom *</label>
                <input
                  required
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="ex: Histoire du Sénégal"
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddCategory(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Créer la catégorie
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL ADD PARTICIPANT */}
      <Modal
        open={showAddParticipant}
        onClose={() => setShowAddParticipant(false)}
        title="Enregistrer un Membre AEERKS"
        className="max-w-md"
      >
            <form onSubmit={handleCreateParticipant} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Prénom *</label>
                  <input
                    required
                    value={newPartFirstName}
                    onChange={(e) => setNewPartFirstName(e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Nom *</label>
                  <input
                    required
                    value={newPartLastName}
                    onChange={(e) => setNewPartLastName(e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Genre</label>
                <select
                  value={newPartGender}
                  onChange={(e) => setNewPartGender(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
                >
                  <option value="M">Masculin</option>
                  <option value="F">Féminin</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddParticipant(false)}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
                >
                  Enregistrer le membre
                </button>
              </div>
            </form>
      </Modal>

      {/* MODAL MANAGE TEAM MEMBERS */}
      <Modal
        open={showManageTeamMembers}
        onClose={() => setShowManageTeamMembers(false)}
        title="Composition de l'Équipe"
        className="max-w-2xl"
      >

            <div className="mb-4">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Équipe</label>
              <select
                value={membersTeamId}
                onChange={(e) => {
                  setMembersTeamId(Number(e.target.value));
                  setMemberParticipantId('');
                }}
                className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
              >
                <option value="">Sélectionner une équipe...</option>
                {teamsList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.code})
                  </option>
                ))}
              </select>
            </div>

            {selectedTeamForMembers && (
              <>
                {/* Current members */}
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl mb-3">
                  <div className="px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 bg-slate-50 rounded-t-xl">
                    Membres actuels ({selectedTeamForMembers.members?.length || 0}/4)
                  </div>
                  {selectedTeamForMembers.members && selectedTeamForMembers.members.length > 0 ? (
                    selectedTeamForMembers.members.map((m) => (
                      <div key={m.id} className="px-3.5 py-2.5 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800">
                            {m.participant?.firstName} {m.participant?.lastName}
                          </span>
                          {m.role === 'CAPTAIN' && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                              Capitaine
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {m.role !== 'CAPTAIN' && (
                            <button
                              onClick={() => handlePromoteCaptain(m.id)}
                              className="px-2 py-1 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-[11px] font-bold hover:bg-amber-100"
                            >
                              Désigner capitaine
                            </button>
                          )}
                          <button
                            onClick={() => handleRemoveTeamMember(m.id)}
                            className="p-1.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="px-3.5 py-3 text-xs text-slate-400">Aucun membre affecté.</div>
                  )}
                </div>

                {/* Add member form */}
                <form onSubmit={handleAddTeamMember} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="sm:col-span-1">
                    <select
                      required
                      value={memberParticipantId}
                      onChange={(e) => setMemberParticipantId(Number(e.target.value))}
                      className="w-full p-2 rounded-xl border border-slate-300 text-xs text-slate-800"
                    >
                      <option value="">Membre...</option>
                      {unassignedParticipants.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.firstName} {p.lastName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <select
                      value={memberRole}
                      onChange={(e) =>
                        setMemberRole(e.target.value === 'CAPTAIN' ? 'CAPTAIN' : 'MEMBER')
                      }
                      className="w-full p-2 rounded-xl border border-slate-300 text-xs text-slate-800"
                    >
                      <option value="MEMBER">Titulaire</option>
                      <option value="CAPTAIN">Capitaine</option>
                    </select>
                  </div>
                  <button
                    type="submit"
                    disabled={!memberParticipantId}
                    className="p-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-bold disabled:opacity-40"
                  >
                    Affecter
                  </button>
                </form>
              </>
            )}

            <div className="flex justify-end pt-4">
              <button
                type="button"
                onClick={() => setShowManageTeamMembers(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-bold"
              >
                Fermer
              </button>
            </div>
      </Modal>

      {/* Publication des résultats.
          Le nombre de matchs et l'indicateur d'état sont rappeles dans le
          dialogue : c'est ce qui permet de refuser une publication launched trop
          tôt, au lieu de la découvrir refusée par le serveur (409). */}
      <ConfirmDialog
        open={confirmPublish}
        title="Publier officiellement les résultats ?"
        message="Le podium d'honneur s'affichera instantanément sur l'écran public. Cet acte engage l'ensemble de la compétition."
        confirmLabel="Publier au public"
        onConfirm={() => void confirmPublishResults()}
        onCancel={() => setConfirmPublish(false)}
      >
        {currentEvent && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-semibold text-slate-700">Événement</span>
              <span className="text-slate-900">{currentEvent.name}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[13px]">
              <span className="font-semibold text-slate-700">Matchs joués</span>
              <span className="tabular-nums text-slate-900">{matchesList.length}</span>
            </div>
            {unfinishedMatches > 0 && (
              <p className="mt-1.5 text-[11px] text-amber-700">
                {unfinishedMatches} match(s) ne sont pas encore clôturés : la publication sera refusée.
              </p>
            )}
          </div>
        )}
      </ConfirmDialog>

      {/* Retrait des résultats. Ton non destructif — l'acte est réversible —
          mais visible du public, d'où la confirmation. */}
      <ConfirmDialog
        open={confirmUnpublish}
        title="Retirer les résultats de l'écran public ?"
        message="Le podium cessera d'être affiché au public. L'opération reste réversible : vous pourrez republier."
        confirmLabel="Retirer du public"
        onConfirm={() => void confirmUnpublishResults()}
        onCancel={() => setConfirmUnpublish(false)}
      />
      </div>
    </div>
  );
};
