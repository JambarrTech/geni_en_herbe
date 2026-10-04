import React, { useMemo } from 'react';
import { Plus, ChevronUp, ChevronDown } from 'lucide-react';
import { BoutonSuppression } from '@shared/components/BoutonSuppression.tsx';
import type { CategoryItem, QuestionItem } from '@shared/types.ts';

export interface QuestionsBankProps {
  categories: CategoryItem[];
  questions: QuestionItem[];
  onAddCategory: () => void;
  onAddQuestion: () => void;
  onMoveCategory: (catId: number, dir: -1 | 1) => void;
  onMoveQuestion: (questionId: number, dir: -1 | 1) => void;
  onDeleteCategory: (c: CategoryItem, questionCount: number) => void;
  onEditQuestion: (q: QuestionItem) => void;
  onDeleteQuestion: (q: QuestionItem) => void;
}

/**
 * Banque de questions groupée par catégorie (onglet « questions » de l'admin).
 *
 * Extrait de `AdminDashboard` : ce fichier dépassait 2500 lignes et chaque
 * modification de cette section risquait de casser le build (JSX noyé dans
 * la masse — déjà arrivé deux fois sur Render). Un seul gabarit de carte
 * (`renderQuestionCard`), un seul ordre de tri, au même endroit.
 *
 * Règle d'affichage : les catégories suivent l'ordre décidé par l'admin
 * (`position`), chacune avec SES questions. La première ouvre l'écran public.
 */
export const QuestionsBank: React.FC<QuestionsBankProps> = ({
  categories,
  questions,
  onAddCategory,
  onAddQuestion,
  onMoveCategory,
  onMoveQuestion,
  onDeleteCategory,
  onEditQuestion,
  onDeleteQuestion,
}) => {
  const orderedCategories = useMemo(
    () =>
      [...categories].sort(
        (a, b) =>
          (a.position ?? 0) - (b.position ?? 0) ||
          a.name.localeCompare(b.name, 'fr') ||
          a.id - b.id
      ),
    [categories]
  );

  const questionsByCategory = useMemo(() => {
    const grouped = new Map<number, QuestionItem[]>();
    for (const q of questions) {
      const list = grouped.get(q.categoryId) ?? [];
      list.push(q);
      grouped.set(q.categoryId, list);
    }
    return grouped;
  }, [questions]);

  const orphanQuestions = useMemo(
    () => {
      const known = new Set(categories.map((c) => c.id));
      return questions.filter((q) => !known.has(q.categoryId));
    },
    [questions, categories]
  );

  // Carte d'une question (énoncé + réponse officielle + actions) : un seul
  // gabarit pour tous les groupes, au lieu d'un par groupe. `index`/`total`
  // placent la question dans SON groupe : la première ouvre le groupe — donc
  // l'écran public quand sa catégorie passe.
  const renderQuestionCard = (q: QuestionItem, index: number, total: number) => (
    <div key={q.id} className="p-5 hover:bg-slate-50/50 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-0.5 rounded-md bg-blue-50 text-[#0B3B82] text-xs font-bold">
            {q.categoryName}
          </span>
          <span
            title={`Question ${index + 1} sur ${total} dans cette catégorie`}
            className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-bold tabular-nums"
          >
            #{index + 1}
          </span>
          <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-semibold">
            {q.difficulty}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
            {q.points} points • {q.timeLimitSeconds}s
          </span>
          <button
            type="button"
            id={`btn-question-up-${q.id}`}
            onClick={() => onMoveQuestion(q.id, -1)}
            disabled={index === 0}
            aria-label={`Monter la question ${q.id}`}
            title="Afficher cette question plus tôt dans sa catégorie"
            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-[#0B3B82] hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
          >
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            id={`btn-question-down-${q.id}`}
            onClick={() => onMoveQuestion(q.id, 1)}
            disabled={index === total - 1}
            aria-label={`Descendre la question ${q.id}`}
            title="Afficher cette question plus tard dans sa catégorie"
            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-[#0B3B82] hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            id={`btn-edit-question-${q.id}`}
            onClick={() => onEditQuestion(q)}
            aria-label={`Modifier la question ${q.id}`}
            title="Modifier l'énoncé, la réponse et les informations de cette question"
            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-[#0B3B82] hover:bg-blue-50 hover:border-blue-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 text-xs font-semibold px-2.5"
          >
            Modifier
          </button>
          <BoutonSuppression
            id={`btn-delete-question-${q.id}`}
            label={`Supprimer la question ${q.text.slice(0, 60)}`}
            onClick={() => onDeleteQuestion(q)}
          />
        </div>
      </div>

      <p className="text-sm font-bold text-slate-900 mt-1">{q.text}</p>

      <div className="mt-3 p-3 rounded-xl bg-emerald-50/80 border border-emerald-200 text-xs">
        <span className="font-semibold text-emerald-900">Réponse officielle : </span>
        <span className="text-emerald-900 font-semibold">{q.answer}</span>
      </div>
    </div>
  );

  return (
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
            onClick={onAddCategory}
            className="px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4 text-[#0B3B82]" />
            <span>Nouvelle Catégorie</span>
          </button>
          <button
            id="btn-add-question"
            onClick={onAddQuestion}
            className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Ajouter une Question</span>
          </button>
        </div>
      </div>

      {/* Ordre des catégories : la première ouvre l'écran public. */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-5">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-bold text-slate-900">Ordre des catégories</h4>
          <span className="text-[11px] text-slate-500">La première ouvre l'écran public</span>
        </div>
        <div className="divide-y divide-slate-100">
          {orderedCategories.map((c, idx) => {
            const count = questionsByCategory.get(c.id)?.length ?? 0;
            return (
              <div key={c.id} className="flex items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-6 h-6 rounded-lg bg-[#0B3B82] text-white text-xs font-bold flex items-center justify-center shrink-0 tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="text-sm font-bold text-slate-900 truncate">{c.name}</span>
                  {idx === 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[11px] font-bold shrink-0">
                      Affiche en premier
                    </span>
                  )}
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {count} question{count > 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    id={`btn-category-up-${c.id}`}
                    onClick={() => onMoveCategory(c.id, -1)}
                    disabled={idx === 0}
                    aria-label={`Monter la catégorie ${c.name}`}
                    title="Afficher cette catégorie plus tôt"
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-[#0B3B82] hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
                  >
                    <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    id={`btn-category-down-${c.id}`}
                    onClick={() => onMoveCategory(c.id, 1)}
                    disabled={idx === orderedCategories.length - 1}
                    aria-label={`Descendre la catégorie ${c.name}`}
                    title="Afficher cette catégorie plus tard"
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-[#0B3B82] hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-35 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1"
                  >
                    <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <BoutonSuppression
                    id={`btn-delete-category-${c.id}`}
                    label={`Supprimer la catégorie ${c.name}`}
                    onClick={() => onDeleteCategory(c, count)}
                  />
                </div>
              </div>
            );
          })}
          {orderedCategories.length === 0 && (
            <div className="text-xs text-slate-400 py-2">Aucune catégorie pour l'instant.</div>
          )}
        </div>
      </div>

      {/* Banque groupée : chaque catégorie avec SES questions, dans l'ordre d'affichage. */}
      {orderedCategories.map((cat, catIdx) => {
        // Tri défensif : le serveur renvoie déjà cet ordre, mais la banque
        // ne doit jamais dépendre de l'ordre d'une réponse HTTP.
        const qs = [...(questionsByCategory.get(cat.id) ?? [])].sort(
          (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id
        );
        return (
          <div key={cat.id} className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200">
              <div className="flex items-center gap-2 min-w-0">
                <span className="px-2.5 py-0.5 rounded-md bg-blue-50 text-[#0B3B82] text-xs font-bold truncate">
                  {cat.name}
                </span>
                <span className="text-[11px] text-slate-500 shrink-0">
                  {qs.length} question{qs.length > 1 ? 's' : ''}
                </span>
              </div>
              <span className="text-[11px] font-bold text-slate-400 shrink-0 tabular-nums">
                #{catIdx + 1}
              </span>
            </div>
            <div className="divide-y divide-slate-100">
              {qs.map((q, idx) => renderQuestionCard(q, idx, qs.length))}
              {qs.length === 0 && (
                <div className="p-5 text-xs text-slate-400">
                  Aucune question dans cette catégorie.
                </div>
              )}
            </div>
          </div>
        );
      })}
      {orphanQuestions.length > 0 && (
        <div className="bg-white rounded-2xl border border-amber-200 shadow-xs overflow-hidden">
          <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 text-xs font-bold text-amber-800">
            Questions sans catégorie connue ({orphanQuestions.length})
          </div>
          <div className="divide-y divide-slate-100">
            {orphanQuestions.map((q, idx) => renderQuestionCard(q, idx, orphanQuestions.length))}
          </div>
        </div>
      )}
    </div>
  );
};
