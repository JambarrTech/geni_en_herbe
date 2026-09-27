import React from 'react';
import { LiveProvider } from '@shared/context/LiveContext.tsx';
import { LiveCompetitionPage } from './pages/LiveCompetitionPage.tsx';

const App: React.FC = () => {
  return (
    <LiveProvider>
      <LiveCompetitionPage />
    </LiveProvider>
  );
};

export default App;