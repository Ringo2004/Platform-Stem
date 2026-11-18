import type { MachineData } from '../machines/types';
import { esc } from '../util';

/* Sezione "Esercitati": pagina segnaposto. */
export function createPractice(data: MachineData): HTMLElement {
  const el = document.createElement('div');
  el.className = 'page practice';
  const planned = data.practice ?? [['Riconosci il componente', 'Il modello evidenzia un pezzo: scegli il nome giusto tra quelli proposti.']];
  el.innerHTML = `
  <div class="page-inner">
    <header class="page-head">
      <div class="eyebrow">${esc(data.eyebrow)} · Esercitati</div>
      <h1>Esercitati</h1>
      <p class="placeholder-note">Sezione in preparazione. Qui troverai gli esercizi sul ${esc(data.title)}.</p>
    </header>
    <div class="planned">
      ${planned.map(([t, d]) => `
        <article class="card soon">
          <div class="tag">In arrivo</div>
          <h3 class="card-title">${esc(t)}</h3>
          <p>${esc(d)}</p>
        </article>`).join('')}
    </div>
    <a class="btn primary" href="#/esplora/${data.id}">Intanto esplora il modello 3D</a>
  </div>`;
  return el;
}
