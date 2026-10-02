/**
 * Suppression d'une ressource depuis l'interface d'administration.
 *
 * Un seul etat, un seul dialogue
 * ------------------------------
 * L'administration supprime des matchs, des equipes, des questions et des
 * membres. Chaque suppression a son bouton, son dialogue et son gestionnaire ;
 * recopier le trio quatre fois fait quatre endroits a corriger le jour ou le
 * serveur repond 409 au lieu de 400.
 *
 * Ce module ne tient donc que l'etat de la suppression EN COURS - et c'est un
 * objet, pas un booleen. Il faut l'objet entier : le dialogue doit nommer la
 * cible, et un identifiant nu ne dit ni « Alpha contre Bravo » ni le numero du
 * match. Un « Supprimer ? » sans nom ne permet pas de verifier qu'on a choisi la
 * bonne ligne.
 *
 * Le rendu du dialogue reste chez l'appelant : lui seul sait a quoi ressemble une
 * question.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api.ts';

/** Ce qu'un bouton de corbeille doit declarer pour ouvrir le dialogue. */
export interface CibleSuppression {
  /** Chemin de la ressource, identifiant deja interpole : `/api/teams/7`. */
  ressource: string;
  /** Intitule du dialogue : « Supprimer le match n° 3 ? » */
  titre: string;
  /** Ce qui disparait, sans detour. C'est ce qui rend la decision eclairee. */
  message: string;
  /** Ce qu'on annonce quand le serveur accepte. */
  succes: string;
  /** Rappel de la cible, rendu sous le message. */
  details?: ReactNode;
}

export interface OptionsSuppression {
  /** Apres un refus du serveur. Le message du serveur est transmis tel quel. */
  onEchec: (message: string) => void;
  /** Apres un succes : rechargements, diffusion, compteurs a rafraichir. */
  onSucces: (message: string) => void;
}

export interface Suppression {
  /** La suppression en attente de confirmation, ou `null`. */
  cible: CibleSuppression | null;
  /** Ouvre le dialogue sur la cible designee. */
  demander: (cible: CibleSuppression) => void;
  /** Ferme le dialogue sans rien envoyer. */
  annuler: () => void;
  /** Envoie la suppression de la cible en attente. Sans effet s'il n'y en a pas. */
  confirmer: () => Promise<void>;
}

/**
 * @param options reactions de l'appelant ; volontairement deux callbacks plutot
 * qu'un `setMessage` passe ici : le module ne doit pas savoir ce qu'est un toast.
 */
export function useSuppression({ onEchec, onSucces }: OptionsSuppression): Suppression {
  const [cible, setCible] = useState<CibleSuppression | null>(null);

  const demander = useCallback((suivante: CibleSuppression) => {
    setCible(suivante);
  }, []);

  const annuler = useCallback(() => {
    setCible(null);
  }, []);

  const confirmer = useCallback(async () => {
    const enCours = cible;
    if (!enCours) return;

    // On referme AVANT d'envoyer, comme le fait deja la publication des
    // resultats dans cet ecran. Le dialogue n'a rien a afficher pendant
    // l'aller-retour, et le garder ouvert exposerait a une fermeture par Echap
    // en cours de requete - le composant perdrait alors son etat pendant que la
    // suppression, elle, est deja partie.
    setCible(null);

    try {
      await api.delete(enCours.ressource);
      onSucces(enCours.succes);
    } catch (err) {
      // Le refus du serveur est la seule source de verite sur ce qui bloque une
      // suppression. La raison n'est pas calculable ici - elle depend de l'etat
      // de la base - donc le message est transmis tel quel plutot que remplace
      // par un texte generique qui masquerait la cause.
      onEchec(errorMessage(err, 'Suppression impossible'));
    }
  }, [cible, onEchec, onSucces]);

  return { cible, demander, annuler, confirmer };
}