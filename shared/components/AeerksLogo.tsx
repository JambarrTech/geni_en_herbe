import React from 'react';
import aeerksLogo from '../assets/aeerks-logo.png';

export type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Dimensions réelles par taille. Les attributs `width`/`height` permettent au
 * navigateur de réserver la place exacte avant le chargement de l'image :
 * sans eux, chaque apparition du logo provoquait un saut de mise en page
 * (CLS) dans la barre de navigation et sur l'écran de connexion.
 */
const SIZE_MAP: Record<LogoSize, number> = {
  xs: 24,
  sm: 32,
  md: 44,
  lg: 64,
  xl: 96,
};

interface LogoProps {
  className?: string;
  size?: LogoSize | number;
  /**
   * `false` par défaut : le logo est décoratif et repeté, on ne le charge pas
   * en priorité. Passed `true` pour le logo principal d'un écran.
   */
  priority?: boolean;
  /** Rend le logo décoratif (pas d'annonce lecteur d'écran). */
  decorative?: boolean;
}

export const AeerksLogo: React.FC<LogoProps> = ({
  className = '',
  size = 'md',
  priority = false,
  decorative = false,
}) => {
  const px = typeof size === 'number' ? size : (SIZE_MAP[size] ?? SIZE_MAP.md);
  const dimension = `${px}px`;

  return (
    <img
      src={aeerksLogo}
      // Le fichier source est un sceau circulaire à 256 px : au-delà, on n'ajoute
      // que du poids sans gain de netteté.
      width={px}
      height={px}
      alt={decorative ? '' : 'Logo AEERKS — Amicale des Élèves et Étudiants Ressortissants de Keur Salla Mbatta'}
      aria-hidden={decorative || undefined}
      role={decorative ? 'presentation' : undefined}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      draggable={false}
      className={`select-none object-contain shrink-0 ${dimension} ${className}`}
    />
  );
};

export default AeerksLogo;
