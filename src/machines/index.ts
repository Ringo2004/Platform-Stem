import type { MachineData } from './types';

export type { MachineData } from './types';

export interface MachineEntry {
  id: string;
  title: string;
  load: () => Promise<MachineData>;
}

/*
 * Elenco delle macchine disponibili. Per aggiungerne una:
 * 1. crea src/machines/<id>.json con lo stesso formato di lm2500.json (vedi types.ts);
 * 2. aggiungi qui una voce { id, title, load }.
 */
export const MACHINES: MachineEntry[] = [
  { id: 'lm2500', title: 'GE LM2500', load: () => import('./lm2500.json').then(m => m.default as unknown as MachineData) }
];

export const DEFAULT_MACHINE = MACHINES[0].id;

const cache = new Map<string, Promise<MachineData>>();
export function loadMachine(id: string): Promise<MachineData> {
  const entry = MACHINES.find(m => m.id === id) ?? MACHINES[0];
  let p = cache.get(entry.id);
  if (!p) { p = entry.load(); cache.set(entry.id, p); }
  return p;
}
