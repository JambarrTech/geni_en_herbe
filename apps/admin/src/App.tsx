import React from 'react';
import { AuthProvider, useAuth } from '@shared/context/AuthContext.tsx';
import { LiveProvider } from '@shared/context/LiveContext.tsx';
import { StaffNavbar } from '@shared/components/StaffNavbar.tsx';
import { LoginPage } from '@shared/pages/LoginPage.tsx';
import { AdminDashboard } from './pages/AdminDashboard.tsx';

const AccessDenied: React.FC = () => {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md text-center">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Accès réservé</h1>
        <p className="text-sm text-slate-600 mb-6">
          L'espace d'administration est réservé aux comptes <strong>ADMIN</strong>.
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
  // `isAdmin` est indispensable : sans ce garde, tout compte JURY ouvrant
  // `/admin` obtenait le shell complet — y compris la banque de questions
  // avec les réponses officielles. Le backend rejetait ensuite chaque appel, et
  // l'écran restait vide sans message (les 401 n'étaient pas gérés).
  const { user, isLoading, isAdmin } = useAuth();

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
      <StaffNavbar activeView={user ? 'admin' : 'login'} appBase="/admin" />
      <main>
        {!user ? <LoginPage /> : isAdmin ? <AdminDashboard /> : <AccessDenied />}
      </main>
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
