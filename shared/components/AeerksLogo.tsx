import React from 'react';
import aeerksLogo from '../assets/aeerks-logo.png';
import aeerksLogoDark from '../assets/aeerks-logo-dark.png';

export type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Hauteur en px par taille. Le logo officiel est un lockup **paysage**
 * (wordmark + 3 lignes de texte), pas un sceau carré : la largeur est déduite
 * de `ASPECT_RATIO` pour ne jamais déformer l'image.
 *
 * Les attributs `width`/`height` permettent au navigateur de réserver la place
 * exacte avant le chargement : sans eux, chaque apparition du logo provoquait un
 * saut de mise en page (CLS) dans la barre de navigation et sur l'écran de
 * connexion.
 */
const SIZE_MAP: Record<LogoSize, number> = {
  xs: 24,
  sm: 32,
  md: 44,
  lg: 64,
  xl: 96,
};

/** Ratio réel du fichier source `aeerks-logo.png` (320 x 246 px). */
const ASPECT_RATIO = 320 / 246;

interface LogoProps {
  className?: string;
  /** Hauteur affichée. Un nombre est interprété comme une hauteur en px. */
  size?: LogoSize | number;
  /**
   * `false` par défaut : le logo est décoratif et répété, on ne le charge pas
   * en priorité. Passé `true` pour le logo principal d'un écran.
   */
  priority?: boolean;
  /** Rend le logo décoratif (pas d'annonce lecteur d'écran). */
  decorative?: boolean;
  /**
   * Déclinaison pour fond sombre. Le lockup officiel comporte deux lignes de
   * texte noires, invisibles sur un fond ardoise : sur `bg-slate-950` (page
   * live) il faut la variante dont l'encre neutre est repassée en blanc et le
   * bleu éclairci, faute de quoi le logo se réduit à une tache bleue.
   */
  onDark?: boolean;
}

export const AeerksLogo: React.FC<LogoProps> = ({
  className = '',
  size = 'md',
  priority = false,
  decorative = false,
  onDark = false,
}) => {
  const height = typeof size === 'number' ? size : (SIZE_MAP[size] ?? SIZE_MAP.md);
  const width = Math.round(height * ASPECT_RATIO);

  return (
    <img
      src={onDark ? aeerksLogoDark : aeerksLogo}
      // Le fichier source fait 320 x 246 px : au-delà, on n'ajoute que du
      // poids sans gain de netteté.
      width={width}
      height={height}
      style={{ width: `${width}px`, height: `${height}px` }}
      alt={decorative ? '' : 'Logo AEERKS — Amicale des Élèves et Étudiants Ressortissants de Keur Salla Mbatta'}
      aria-hidden={decorative || undefined}
      role={decorative ? 'presentation' : undefined}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      draggable={false}
      className={`select-none object-contain shrink-0 ${className}`}
    />
  );
};

export default AeerksLogo;
