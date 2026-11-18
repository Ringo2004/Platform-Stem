import type { Card, MachineData } from '../machines/types';
import { esc, factsHtml } from '../util';

/*
 * Sezione "Teoria" (provvisoria): raccoglie i testi delle schede della macchina,
 * raggruppati per sezione, con un collegamento al componente nel modello 3D.
 */
export function createTheory(data: MachineData): HTMLElement {
  const el = document.createElement('div');
  el.className = 'page theory';

  const groups = new Map<string, typeof data.components>();
  for (const c of data.components) {
    if (!groups.has(c.section)) groups.set(c.section, []);
    groups.get(c.section)!.push(c);
  }
  const slug = (s: string) => 'sez-' + s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-');
  const color = (c: string) => (c.startsWith('#') ? c : data.palette[c] ?? '#888');

  const card = (d: Card, extra = '', dot = '#f0a43a') => `
    <article class="card">
      <div class="tag"><span class="dot" style="background:${dot}"></span>${esc(d.section)}</div>
      <h3 class="card-title">${esc(d.name)}</h3>
      <p>${esc(d.text)}</p>
      ${factsHtml(d.facts)}
      ${d.course ? `<div class="course"><strong>Nel corso</strong>${esc(d.course)}</div>` : ''}
      ${extra}
    </article>`;

  el.innerHTML = `
  <div class="page-inner">
    <header class="page-head">
      <div class="eyebrow">${esc(data.eyebrow)} · Teoria</div>
      <h1>${esc(data.title)}</h1>
      <p class="placeholder-note">Pagina provvisoria: qui arriveranno le lezioni di teoria. Per ora raccoglie i testi delle schede del modello 3D.</p>
      <nav class="toc" aria-label="Sezioni della macchina">
        ${[...groups.keys()].map(s => `<button type="button" class="chip" data-target="${slug(s)}">${esc(s)}</button>`).join('')}
      </nav>
    </header>
    ${card(data.overview, `<a class="btn" href="#/esplora/${data.id}">Apri il modello 3D</a>`)}
    ${[...groups].map(([sec, list]) => `
      <section class="theory-group" id="${slug(sec)}">
        <h2>${esc(sec)}</h2>
        ${list.map(c => card(c, `<a class="btn" href="#/esplora/${data.id}?c=${encodeURIComponent(c.id)}">Vedi nel modello 3D</a>`, color(c.color))).join('')}
      </section>`).join('')}
    <p class="note">${esc(data.note)}</p>
  </div>`;

  el.querySelector('.toc')!.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-target]');
    if (t) el.querySelector(`#${t.dataset.target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return el;
}
