import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './style.css';

import { DEFAULT_MACHINE, MACHINES, loadMachine, type MachineData } from './machines';
import type { ExploreView } from './explore/explore';
import { createTheory } from './pages/theory';
import { createPractice } from './pages/practice';

/*
 * Navigazione a schede con l'hash dell'indirizzo, così funziona su GitHub Pages senza configurazioni:
 *   #/esplora[/<macchina>][?c=<componente>]   #/esercitati[/<macchina>]   #/teoria[/<macchina>]
 */

const SECTIONS = [
  { id: 'esplora', label: 'Esplora', icon: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>' },
  { id: 'esercitati', label: 'Esercitati', icon: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>' },
  { id: 'teoria', label: 'Teoria', icon: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5c-.8 0-1.5-.7-1.5-1.5v-13Z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5v-13Z"/>' }
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

interface Route { section: SectionId; machine: string; component: string | null }

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [sec, machine] = path.split('/');
  const section = (SECTIONS.find(s => s.id === sec)?.id ?? 'esplora') as SectionId;
  const known = MACHINES.some(m => m.id === machine);
  return { section, machine: known ? machine : DEFAULT_MACHINE, component: new URLSearchParams(query).get('c') };
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#/esplora"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Platform STEM</span></a>
    <nav class="tabs" aria-label="Sezioni">
      ${SECTIONS.map(s => `<a class="tab" data-section="${s.id}" href="#/${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true">${s.icon}</svg><span>${s.label}</span></a>`).join('')}
    </nav>
    <div class="machine-name" data-ref="machine"></div>
  </header>
  <main class="views" data-ref="views"><div class="loading">Caricamento…</div></main>`;
const viewsEl = app.querySelector<HTMLElement>('[data-ref="views"]')!;
const machineEl = app.querySelector<HTMLElement>('[data-ref="machine"]')!;

interface View { el: HTMLElement; show?(): void; hide?(): void; explore?: ExploreView }
const views = new Map<string, Promise<View>>();
let current: View | null = null;
let seq = 0;

async function makeView(section: SectionId, data: MachineData): Promise<View> {
  if (section === 'esplora') {
    const { createExplore } = await import('./explore/explore');
    const explore = createExplore(data);
    return { el: explore.el, show: explore.show, hide: explore.hide, explore };
  }
  return { el: section === 'teoria' ? createTheory(data) : createPractice(data) };
}

async function navigate() {
  const route = parseHash();
  const my = ++seq;
  app.querySelectorAll<HTMLAnchorElement>('.tab').forEach(t => {
    const on = t.dataset.section === route.section;
    t.href = `#/${t.dataset.section}/${route.machine}`;
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });

  const key = `${route.section}:${route.machine}`;
  if (!views.has(key)) views.set(key, loadMachine(route.machine).then(d => makeView(route.section, d)));
  let view: View;
  try {
    view = await views.get(key)!;
  } catch (err) {
    console.error(err);
    views.delete(key);
    viewsEl.innerHTML = '<div class="loading">Impossibile caricare la macchina. Ricarica la pagina.</div>';
    return;
  }
  if (my !== seq) return; // nel frattempo è stata scelta un'altra scheda

  const data = await loadMachine(route.machine);
  const label = SECTIONS.find(s => s.id === route.section)!.label;
  document.title = `${label} · ${data.title} · Platform STEM`;
  machineEl.textContent = data.title;

  if (current !== view) {
    current?.hide?.();
    viewsEl.querySelector('.loading')?.remove();
    for (const child of [...viewsEl.children]) (child as HTMLElement).hidden = child !== view.el;
    if (!view.el.parentNode) viewsEl.appendChild(view.el);
    view.el.hidden = false;
    current = view;
    view.show?.();
    if (!view.explore) view.el.scrollTop = 0;
  }
  if (view.explore && route.component !== null) view.explore.select(route.component);
}

window.addEventListener('hashchange', navigate);
navigate();
