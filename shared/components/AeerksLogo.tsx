import React from 'react';
import aeerksLogo from '../assets/aeerks-logo.png';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'light' | 'dark' | 'white';
}

export const AeerksLogo: React.FC<LogoProps> = ({
  className = '',
  size = 'md',
  variant = 'dark',
}) => {
  const sizeMap = {
    sm: 'w-8 h-8',
    md: 'w-11 h-11',
    lg: 'w-16 h-16',
    xl: 'w-24 h-24',
  };

  const ringColor =
    variant === 'white'
      ? 'border-white/30'
      : 'border-[#0B3B82]/20';

  return (
    <img
      id="aeerks-official-logo"
      src={aeerksLogo}
      alt="Logo AEERKS"
      className={`select-none object-contain rounded-xl ${ringColor} ${sizeMap[size]} ${className}`}
    />
  );
};