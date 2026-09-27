import React from 'react';
import { AuthProvider, useAuth } from '@shared/context/AuthContext.tsx';
import { LiveProvider } from '@shared/context/LiveContext.tsx';
import { StaffNavbar } from '@shared/components/StaffNavbar.tsx';
import { LoginPage } from '@shared/pages/LoginPage.tsx';
import { JuryDashboard } from './pages/JuryDashboard.tsx';

const AccessDenied: React.FC = () => {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md text-center">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Accès réservé</h1>
        <p className="text-sm text-slate-600 mb-6">
          L'espace jury est réservé aux membres du jury et aux administrateurs.
          {user ? ` Votre compte est enregistré comme ${user.role}.` : ''}
        </p>
        <button
          type="button"
          onClick={logout}
          className="px-4 py-2 rounded-lg bg-[#0B3B82] text-white text-sm font-semibold hover:bg-[#0a3270] transition-colors"
        >
          Changer de compte
        </button>
      </div>
    </div>
  );
};

const AppShell: React.FC = () => {
  // `isJury` : un compte ADMIN est autorisé ici (il peut arbitrer), un simple
  // rôle non reconnu ne doit pas atteindre la table de score.
  const { user, isLoading, isJury } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-[#0B3B82] text-sm font-semibold">
          <span className="w-4 h-4 border-2 border-[#0B3B82] border-t-transparent rounded-full animate-spin" />
          Vérification de la session...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <StaffNavbar activeView={user ? 'jury' : 'login'} appBase="/jury" />
      <main>{!user ? <LoginPage /> : isJury ? <JuryDashboard /> : <AccessDenied />}</main>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <LiveProvider>
        <AppShell />
      </LiveProvider>
    </AuthProvider>
  );
};

export default App;