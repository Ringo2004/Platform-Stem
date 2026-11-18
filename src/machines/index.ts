import type { MachineData } from './types';

export type { MachineData } from './types';

export interface MachineEntry {
  id: string;
  /** etichetta del modulo, es. "Modulo 1" */
  module: string;
  /** tipo di macchina, es. "Turbogas" */
  kind: string;
  title: string;
  load: () => Promise<MachineData>;
}

/*
 * Elenco delle macchine disponibili. Per aggiungerne una:
 * 1. crea src/machines/<id>.json con lo stesso formato di lm2500.json (vedi types.ts);
 * 2. aggiungi qui una voce { id, module, kind, title, load }.
 */
export const MACHINES: MachineEntry[] = [
  { id: 'lm2500', module: 'Modulo 1', kind: 'Turbogas', title: 'GE LM2500', load: () => import('./lm2500.json').then(m => m.default as unknown as MachineData) },
  { id: 'fire12', module: 'Modulo 2', kind: 'Motore a benzina', title: 'FIAT FIRE 1.2 8V', load: () => import('./fire12.json').then(m => m.default as unknown as MachineData) },
  { id: 'eckardt', module: 'Modulo 3', kind: 'Compressore centrifugo', title: 'Compressore Eckardt O', load: () => import('./eckardt.json').then(m => m.default as unknown as MachineData) }
];

export const DEFAULT_MACHINE = MACHINES[0].id;

const cache = new Map<string, Promise<MachineData>>();
export function loadMachine(id: string): Promise<MachineData> {
  const entry = MACHINES.find(m => m.id === id) ?? MACHINES[0];
  let p = cache.get(entry.id);
  if (!p) { p = entry.load(); cache.set(entry.id, p); }
  return p;
}
