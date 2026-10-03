#!/usr/bin/env node
/**
 * Vérifie que l'enum BroadcastStage est identique dans :
 * - backend/src/lib/broadcastFlow.ts (source de vérité serveur)
 * - shared/types.ts (consommé par les frontends)
 *
 * Toute divergence casse le build — l'oubli devient impossible au lieu d'être silencieux.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const BACKEND_PATH = path.join(PROJECT_ROOT, 'backend/src/lib/broadcastFlow.ts');
const SHARED_PATH = path.join(PROJECT_ROOT, 'shared/types.ts');

function extractBroadcastStages(filePath, label) {
  const content = readFileSync(filePath, 'utf-8');

  // Cherche l'objet BROADCAST_STAGE dans broadcastFlow.ts
  if (label === 'backend') {
    const match = content.match(/export const BROADCAST_STAGE = \{([\s\S]*?)\n\} as const;/);
    if (!match) throw new Error(`${label}: BROADCAST_STAGE object not found`);
    const objContent = match[1];
    const stages = objContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//') && !line.startsWith('/*'))
      .map(line => {
        // Format: ROSTER: 'ROSTER',
        const keyMatch = line.match(/^(\w+):/);
        return keyMatch ? keyMatch[1] : null;
      })
      .filter(Boolean);
    return stages.sort();
  }

  // Cherche le type BroadcastStage dans shared/types.ts
  if (label === 'shared') {
    const match = content.match(/export type BroadcastStage = '([^']+)'(?:\s*\|\s*'([^']+)')*;/);
    if (!match) throw new Error(`${label}: BroadcastStage type not found`);
    // Capture all alternatives
    const fullMatch = content.match(/export type BroadcastStage = ([^;]+);/);
    if (!fullMatch) throw new Error(`${label}: BroadcastStage type not found`);
    const typeDef = fullMatch[1];
    const stages = [...typeDef.matchAll(/'([^']+)'/g)].map(m => m[1]);
    return stages.sort();
  }

  throw new Error(`Unknown label: ${label}`);
}

try {
  const backendStages = extractBroadcastStages(BACKEND_PATH, 'backend');
  const sharedStages = extractBroadcastStages(SHARED_PATH, 'shared');

  console.log('Backend stages:', backendStages.join(', '));
  console.log('Shared stages:', sharedStages.join(', '));

  if (JSON.stringify(backendStages) !== JSON.stringify(sharedStages)) {
    console.error('❌ DIVERGENCE DÉTECTÉE : BroadcastStage diffère entre backend et shared !');
    console.error('Backend:', backendStages);
    console.error('Shared:', sharedStages);
    process.exit(1);
  }

  console.log('✅ BroadcastStage cohérent entre backend et shared');
  process.exit(0);
} catch (err) {
  console.error('❌ Erreur de vérification:', err.message);
  process.exit(1);
}