import { useEffect, useState } from 'react';

/**
 * Secondes restantes avant une échéance, ou `null` s'il n'y en a pas.
 *
 * POURQUOI UN COMPTAGE LOCAL, ET NON UN SECONDES TRANSMISES
 * ---------------------------------------------------------
 * Le serveur envoie une date, pas un nombre. C'est volontaire : une date reste
 * juste même si le poste du jury s'est mis en veille ou a chargé trois onglets
 * pendant l'attente, alors qu'un compteur décompté en mémoire perdrait ce temps
 * et afficherait « 14 s » au moment où il en reste 3.
 *
 * L'affichage n'a pas à être exact au tick près — l'échéance affichée est
 * exactement celle que le serveur compare, et c'est lui qui bascule. Cette
 * horloge sert uniquement à rafraîchir le texte une fois par seconde.
 *
 * `null` plutôt que `0` quand le temps est écoulé : le texte « bascule
 * automatique dans 0 s » serait faux, l'écran étant déjà parti. Et une absence
 * de compte à rebours est un fait, pas un zéro à afficher.
 */
export function useRosterCountdown(rosterUntil?: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!rosterUntil) {
      setRemaining(null);
      return;
    }

    const cible = new Date(rosterUntil).getTime();
    if (Number.isNaN(cible)) {
      setRemaining(null);
      return;
    }

    const recalculer = () => {
      const reste = Math.ceil((cible - Date.now()) / 1000);
      setRemaining(reste > 0 ? reste : null);
    };

    recalculer();
    const id = setInterval(recalculer, 1000);
    return () => clearInterval(id);
  }, [rosterUntil]);

  return remaining;
}