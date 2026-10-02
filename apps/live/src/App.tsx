import React from 'react';
import { LiveProvider } from '@shared/context/LiveContext.tsx';
import { LiveCompetitionPage } from './pages/LiveCompetitionPage.tsx';

const App: React.FC = () => {
  return (
    // `sendToken={false}` : l'écran public n'a besoin d'aucun droit particulier,
    // et `/` partage son `localStorage` avec `/jury`. Sans cette précision, un
    // poste ayant arbitré renverrait son jeton de session dans l'URL du socket.
    <LiveProvider sendToken={false}>
      <LiveCompetitionPage />
    </LiveProvider>
  );
};

export default App;