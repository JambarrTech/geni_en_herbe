import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@shared/context/AuthContext.tsx';
import type { UserItem } from '@shared/types.ts';
import { api, errorMessage, isAbort } from '@shared/lib/api.ts';
import { Modal } from '@shared/components/Modal.tsx';
import { ConfirmDialog } from '@shared/components/ui.tsx';
import { Plus, Trash2, ShieldCheck, ShieldOff, Key } from 'lucide-react';

export const UsersManager: React.FC<{
  onMessage?: (msg: string, type: 'success' | 'error') => void;
}> = ({ onMessage }) => {
  const { user: currentUser } = useAuth();
  const [usersList, setUsersList] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Compte visé par la suppression, en attente de confirmation.
  const [userToDelete, setUserToDelete] = useState<UserItem | null>(null);
  const [showResetPw, setShowResetPw] = useState<number | null>(null);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'ADMIN' | 'JURY'>('JURY');
  const [resetPw, setResetPw] = useState('');

  const fetchUsers = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        // Client HTTP commun : jeton injecté, erreurs normalisées, 401 géré
        // globalement (une session expirée vide la liste sans laisser deviner
        // qu'il s'agit d'un problème d'authentification).
        setUsersList(await api.get<UserItem[]>('/api/users', { signal }));
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          onMessage?.(errorMessage(e, 'Impossible de charger les comptes'), 'error');
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [onMessage]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchUsers(controller.signal);
    return () => controller.abort();
  }, [fetchUsers]);

  const closeCreate = () => {
    setShowCreate(false);
    setNewName('');
    setNewEmail('');
    setNewPassword('');
    setNewRole('JURY');
  };

  const closeReset = () => {
    setShowResetPw(null);
    setResetPw('');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/users', {
        name: newName,
        email: newEmail,
        password: newPassword,
        role: newRole,
      });
      closeCreate();
      onMessage?.('Compte créé avec succès', 'success');
      void fetchUsers();
    } catch (err) {
      onMessage?.(errorMessage(err, 'Erreur création'), 'error');
    }
  };

  const handleToggleActive = async (u: UserItem) => {
    if (u.id === currentUser?.id) {
      return onMessage?.('Vous ne pouvez pas désactiver votre propre compte', 'error');
    }
    try {
      await api.patch(`/api/users/${u.id}`, { active: !u.active });
      onMessage?.(`${u.name} ${!u.active ? 'activé' : 'désactivé'}`, 'success');
      // Rappel : la désactivation révoque immédiatement toutes les sessions
      // ouvertes de ce compte côté serveur.
      void fetchUsers();
    } catch (err) {
      onMessage?.(errorMessage(err, 'Erreur'), 'error');
    }
  };

  const handleRoleToggle = async (u: UserItem) => {
    if (u.id === currentUser?.id) return;
    try {
      await api.patch(`/api/users/${u.id}`, { role: u.role === 'ADMIN' ? 'JURY' : 'ADMIN' });
      onMessage?.(`Rôle de ${u.name} mis à jour`, 'success');
      void fetchUsers();
    } catch (err) {
      onMessage?.(errorMessage(err, 'Erreur'), 'error');
    }
  };

  const handleResetPassword = async (userId: number) => {
    if (resetPw.length < 6) {
      return onMessage?.('Mot de passe trop court (min 6 caractères)', 'error');
    }
    try {
      await api.post(`/api/users/${userId}/password`, { password: resetPw });
      closeReset();
      onMessage?.('Mot de passe réinitialisé', 'success');
    } catch (err) {
      onMessage?.(errorMessage(err, 'Erreur'), 'error');
    }
  };

  /**
   * Demande de suppression : ouvre le dialogue de confirmation.
   *
   * La garde « pas son propre compte » est vérifiée ICI, avant d'ouvrir quoi
   * que ce soit. Elle était placée APRÈS la confirmation : l'administrateur
   * prenait le temps de lire une confirmation, saisissait « Supprimer », et
   * discoverait alors que l'action était refusée. Une confirmation ne doit
   * jamais porter sur une opération vouée à échouer.
   */
  const requestDelete = (u: UserItem) => {
    if (u.id === currentUser?.id) {
      onMessage?.('Vous ne pouvez pas supprimer votre propre compte', 'error');
      return;
    }
    setUserToDelete(u);
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;
    const u = userToDelete;
    setUserToDelete(null);
    try {
      await api.delete(`/api/users/${u.id}`);
      onMessage?.('Compte supprimé', 'success');
      void fetchUsers();
    } catch (err) {
      onMessage?.(errorMessage(err, 'Erreur'), 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Comptes Utilisateurs</h3>
          <p className="text-xs text-slate-500">
            Gestion des comptes administrateurs et membres du jury
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="px-3.5 py-2 rounded-xl bg-[#0B3B82] hover:bg-[#2563EB] text-white text-xs font-semibold shadow-xs flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>Nouveau Compte</span>
        </button>
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-busy={loading}
        className="sr-only"
      >
        {loading ? 'Chargement des comptes…' : ''}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="max-h-[600px] overflow-y-auto divide-y divide-slate-100">
          {usersList.map((u) => (
            <div
              key={u.id}
              className={`p-4 flex items-center justify-between transition-colors ${
                !u.active ? 'bg-slate-50 opacity-70' : ''
              }`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">{u.name}</span>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                      u.role === 'ADMIN' ? 'bg-[#0B3B82] text-white' : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {u.role}
                  </span>
                  {!u.active && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">
                      Inactif
                    </span>
                  )}
                  {u.id === currentUser?.id && (
                    <span className="text-[10px] text-blue-600 font-semibold">(vous)</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{u.email}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleRoleToggle(u)}
                  title={u.role === 'ADMIN' ? 'Rétrograder en JURY' : 'Promouvoir ADMIN'}
                  aria-label={
                    u.role === 'ADMIN'
                      ? `Rétrograder ${u.name} en JURY`
                      : `Promouvoir ${u.name} en ADMIN`
                  }
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 disabled:opacity-30"
                  disabled={u.id === currentUser?.id}
                >
                  {u.role === 'ADMIN' ? (
                    <ShieldOff className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5 text-[#0B3B82]" aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowResetPw(u.id);
                    setResetPw('');
                  }}
                  title="Réinitialiser le mot de passe"
                  aria-label={`Réinitialiser le mot de passe de ${u.name}`}
                  className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600"
                >
                  <Key className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleActive(u)}
                  title={u.active ? 'Désactiver' : 'Activer'}
                  aria-label={`${u.active ? 'Désactiver' : 'Activer'} le compte de ${u.name}`}
                  className={`p-1.5 rounded-lg border text-slate-600 ${
                    u.active
                      ? 'border-amber-200 hover:bg-amber-50 text-amber-700'
                      : 'border-emerald-200 hover:bg-emerald-50 text-emerald-700'
                  }`}
                >
                  <span className="text-xs font-bold" aria-hidden="true">
                    {u.active ? 'OFF' : 'ON'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => requestDelete(u)}
                  title="Supprimer"
                  aria-label={`Supprimer le compte de ${u.name}`}
                  className="p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-600 disabled:opacity-30"
                  disabled={u.id === currentUser?.id}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
          {usersList.length === 0 && !loading && (
            <div className="p-8 text-center text-slate-400 text-sm">
              Aucun compte utilisateur trouvé.
            </div>
          )}
        </div>
      </div>

      {/* Create User Modal */}
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="Nouveau Compte Utilisateur"
        className="max-w-md"
      >
        <p className="text-xs text-slate-500 mb-4">
          Le compte pourra se connecter via email + mot de passe.
        </p>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label htmlFor="new-user-name" className="block text-xs font-semibold text-slate-700 mb-1">
              Nom complet *
            </label>
            <input
              id="new-user-name"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="ex: Amadou Diop"
              className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
            />
          </div>
          <div>
            <label htmlFor="new-user-email" className="block text-xs font-semibold text-slate-700 mb-1">
              Email *
            </label>
            <input
              id="new-user-email"
              required
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="jury1@aeerks.sn"
              className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
            />
          </div>
          <div>
            <label
              htmlFor="new-user-password"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Mot de passe * (min 6 caractères)
            </label>
            <input
              id="new-user-password"
              required
              type="password"
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
            />
          </div>
          <div>
            <label htmlFor="new-user-role" className="block text-xs font-semibold text-slate-700 mb-1">
              Rôle *
            </label>
            <select
              id="new-user-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value === 'ADMIN' ? 'ADMIN' : 'JURY')}
              className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
            >
              <option value="JURY">Membre du Jury</option>
              <option value="ADMIN">Administrateur</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={closeCreate}
              className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold"
            >
              Créer le compte
            </button>
          </div>
        </form>
      </Modal>

      {/* Reset Password Modal */}
      <Modal
        open={showResetPw !== null}
        onClose={closeReset}
        title="Réinitialiser le mot de passe"
        className="max-w-sm"
      >
        <p className="text-xs text-slate-500 mb-4">
          Nouveau mot de passe pour{' '}
          <span className="font-bold">
            {usersList.find((u) => u.id === showResetPw)?.email}
          </span>
        </p>
        <label htmlFor="reset-password" className="sr-only">
          Nouveau mot de passe
        </label>
        <input
          id="reset-password"
          type="password"
          required
          minLength={6}
          value={resetPw}
          onChange={(e) => setResetPw(e.target.value)}
          placeholder="Nouveau mot de passe..."
          className="w-full p-2.5 rounded-xl border border-slate-300 text-xs text-slate-800"
        />
        <div className="flex justify-end gap-2 pt-4">
          <button
            type="button"
            onClick={closeReset}
            className="px-3 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => showResetPw !== null && handleResetPassword(showResetPw)}
            disabled={resetPw.length < 6}
            className="px-4 py-1.5 rounded-xl bg-[#0B3B82] text-white text-xs font-bold disabled:opacity-40"
          >
            Confirmer
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={userToDelete !== null}
        title="Supprimer ce compte ?"
        message="Cette action est irréversible. Le compte ne pourra plus se connecter et son historique de décisions sera rattaché à un compte supprimé."
        tone="danger"
        confirmLabel="Supprimer définitivement"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setUserToDelete(null)}
      >
        {userToDelete && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
            <div className="text-[13px] font-semibold text-slate-900">{userToDelete.name}</div>
            <div className="text-[13px] text-slate-600">{userToDelete.email}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              Rôle :{' '}
              {userToDelete.role === 'ADMIN' ? 'Comité d\'Organisation' : 'Membre du Jury'}
              {userToDelete.active ? '' : ' — déjà désactivé'}
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
};
