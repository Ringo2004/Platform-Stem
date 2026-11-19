import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Card, MachineData, PlantDef, Station } from '../machines/types';
import { buildModel, temperatureScale, type MachineModel } from './model';
import { COLOR_INFO, FlowArrows, solveFlow, triangleSvg, type ColorInfo, type FlowPath, type FlowResult } from './flow';
import { PumpModel, plantCurves, solvePlant, type CurveRow, type OpResult, type PlantSettings } from './pump';
import { BubbleField, WATER_INFO, solvePumpFlow } from './pumpflow';
import { buildPlant, type PlantScene } from './plant';
import { attachHover, chartsHtml, niceMax } from './chart';
import { esc, factsHtml } from '../util';

/*
 * Sezione "Esplora": modello 3D sezionabile a tutto schermo con pannello dei comandi.
 * La vista si può nascondere/mostrare: quando è nascosta il ciclo di rendering si ferma.
 *
 * Un modulo può avere più "scene" (vedi SceneState): l'impianto di sollevamento ha la scena dell'impianto e
 * una scena per ciascuna macchina singola; gli altri moduli hanno una sola scena.
 */

const ACCENT = '#f0a43a';
/** separatore delle migliaia anche per i numeri di quattro cifre (1.450 giri/min, come nei testi) */
const group = (s: string) => s.replace(/^(-?\d)(\d{3})(?=,|$)/, '$1.$2');
const WHITE = new THREE.Color('#ffffff');

export interface ExploreView {
  el: HTMLElement;
  show(): void;
  hide(): void;
  select(id: string | null, opts?: { focus?: boolean }): void;
}

/** etichetta nel visore: stazione del ciclo o indicazione dinamica (kind = stile) */
interface Label extends Omit<Station, 'n'> { n: number | string; kind?: string }

interface SceneState {
  key: string;
  data: MachineData;
  model: MachineModel;
  /** stato del taglio (null = scena senza sezione) */
  cut: { alpha: number; center: number; extent: number } | null;
  angles: Record<string, number>;
  spoolIds: string[];
  roots: string[];
  labels: Label[];
  arrows: FlowArrows | null;
  bubbles: BubbleField | null;
  /** scala dei colori delle frecce e grandezze mostrate */
  colors?: Record<string, [number, string][]>;
  info?: Record<string, ColorInfo>;
}

export function createExplore(data: MachineData): ExploreView {
  const el = document.createElement('div');
  el.className = 'explore';
  const cycle = data.cycle;
  const flowDef = data.flow;
  const plantDef: PlantDef | undefined = data.plant && data.pumpMachines?.length ? data.plant : undefined;
  const pumpDatas = plantDef ? data.pumpMachines! : [];
  const temp = data.temperature;
  const stops = temp?.stops ?? [[0, '#000000'], [1, '#ffffff']] as [number, string][];
  const tMin = stops[0][0], tMax = stops[stops.length - 1][0];
  const gradient = stops.map(([t, c]) => `${c} ${Math.round((t - tMin) / (tMax - tMin) * 100)}%`).join(', ');
  const hasStations = data.stations.length > 0 || !!plantDef;

  const pumpPanel = plantDef ? `
    <section class="group wide pumping">
      <h3>${esc(plantDef.title)}</h3>
      <div class="seg seg2" role="group" aria-label="Vista" data-ref="pView">
        <button type="button" data-view="plant" aria-pressed="true">Impianto</button>
        <button type="button" data-view="pump" aria-pressed="false">Pompa singola</button>
      </div>
      <div class="field"><span class="flabel">Macchina</span>
        <div class="seg seg2" role="group" aria-label="Macchina" data-ref="pMachine">
          ${pumpDatas.map((d, i) => `<button type="button" data-m="${i}" aria-pressed="false">${esc(d.pump!.label)}</button>`).join('')}
        </div>
      </div>
      <div class="field"><span class="flabel">Numero di pompe</span>
        <div class="seg seg4" role="group" aria-label="Numero di pompe" data-ref="pN">
          ${Array.from({ length: plantDef.limits.pumps }, (_, i) => `<button type="button" data-n="${i + 1}" aria-pressed="false">${i + 1}</button>`).join('')}
        </div>
      </div>
      <div class="field"><span class="flabel">Collegamento</span>
        <div class="seg seg2" role="group" aria-label="Collegamento delle pompe" data-ref="pConn">
          <button type="button" data-c="par" aria-pressed="true">In parallelo</button>
          <button type="button" data-c="ser" aria-pressed="false">In serie</button>
        </div>
      </div>
      <div class="range">
        <label><span>Velocità di rotazione</span><output data-ref="oPrpm"></output></label>
        <input type="range" data-ref="rPrpm" step="10" aria-label="Velocità di rotazione delle pompe">
      </div>
      <div class="range">
        <label><span>Salto geodetico H<sub>g</sub></span><output data-ref="oHg"></output></label>
        <input type="range" data-ref="rHg" min="${plantDef.limits.Hg[0]}" max="${plantDef.limits.Hg[1]}" step="0.5" aria-label="Salto geodetico">
      </div>
      <div class="range">
        <label><span>Quota della pompa sul pelo libero di valle</span><output data-ref="oZ"></output></label>
        <input type="range" data-ref="rZ" min="${plantDef.limits.z[0]}" max="${plantDef.limits.z[1]}" step="0.1" aria-label="Quota della pompa sul pelo libero di valle">
        <div class="scale-ends"><span>sotto battente</span><span>in aspirazione</span></div>
      </div>
      <div class="toggles one">
        <label class="tg"><input type="checkbox" data-ref="tThrottle"> Portata imposta con la valvola di regolazione</label>
      </div>
      <div class="range" data-ref="qBox">
        <label><span>Portata richiesta</span><output data-ref="oQ"></output></label>
        <input type="range" data-ref="rQ" min="0" step="1" aria-label="Portata richiesta">
      </div>
      <div class="pstatus" data-ref="pStatus" role="status"></div>
      <div class="flow-warn" data-ref="pWarn" hidden></div>
      <div class="pcharts" data-ref="pCharts"></div>
      <dl class="facts" data-ref="pFacts"></dl>
      <div class="toggles">
        <label class="tg"><input type="checkbox" data-ref="tPflow" checked> Frecce del flusso</label>
        <label class="tg tg-select"><span>Colore</span>
          <select data-ref="sPcolor" aria-label="Grandezza mostrata dal colore delle frecce">
            <option value="p">Pressione</option><option value="c">Velocità</option>
          </select>
        </label>
      </div>
      <div class="tris">
        <figure><figcaption data-ref="triInCap">Triangolo in ingresso alla girante</figcaption><div data-ref="pTriIn"></div></figure>
        <figure><figcaption data-ref="triOutCap">Triangolo in uscita dalla girante</figcaption><div data-ref="pTriOut"></div></figure>
        <div class="tri-key"><span class="tc">c velocità assoluta</span><span class="tw">w velocità relativa</span><span class="tu">u velocità periferica</span><span class="tb">direzione della pala</span></div>
      </div>
      <dl class="facts" data-ref="pLosses"></dl>
      <div class="actions"><button class="btn" type="button" data-ref="pReset">Torna al punto di progetto</button></div>
      <p class="note">${esc(plantDef.note)}</p>
    </section>` : '';

  el.innerHTML = `
  <div class="viewer">
    <canvas class="c" aria-label="${esc(data.canvasLabel)}"></canvas>
    <div class="titleblock">
      <div class="eyebrow" data-ref="eyebrow">${esc(data.eyebrow)}</div>
      <h1 data-ref="title">${esc(data.title)}</h1>
      <p class="sub" data-ref="subtitle">${esc(data.subtitle)}</p>
    </div>
    <div class="viewbtns">
      <button class="btn" data-ref="resetView" type="button">Ripristina vista</button>
      <button class="btn" data-ref="togglePanel" type="button" aria-expanded="true">Nascondi comandi</button>
    </div>
    <div data-ref="stations"></div>
    <div class="legends">
      ${flowDef || plantDef ? '<div class="legend on" data-ref="flowLegend"></div>' : ''}
      ${temp ? `<div class="legend" data-ref="legend">
        <div>${esc(temp.label)}</div>
        <div class="bar" style="background: linear-gradient(90deg, ${gradient})"></div>
        <div class="ticks">${stops.map(([t]) => `<span>${t}</span>`).join('')}</div>
      </div>` : ''}
    </div>
    <div class="hint"><span class="tip">Trascina per ruotare · pizzica o scorri per lo zoom · tocca un componente</span><span class="rpm" data-ref="rpm"></span></div>
    <div class="err" data-ref="err">Questo browser non supporta WebGL: il modello 3D non può essere mostrato.</div>
  </div>

  <aside class="panel" data-ref="panel" aria-label="Comandi del modello">
    ${pumpPanel}
    <section class="group" data-ref="secGroup">
      <h3>Sezione</h3>
      <div class="seg" role="group" aria-label="Preset di sezione">
        <button type="button" data-preset="0" aria-pressed="false">Intera</button>
        <button type="button" data-preset="90" aria-pressed="false">Spaccato 90°</button>
        <button type="button" data-preset="180" aria-pressed="false">Metà sezione</button>
      </div>
      <div class="range">
        <label><span>Apertura del taglio</span><output data-ref="oAlpha"></output></label>
        <input type="range" data-ref="rAlpha" min="0" max="180" step="1" aria-label="Apertura del taglio">
      </div>
      <div class="range">
        <label><span>Orientamento del taglio</span><output data-ref="oCenter"></output></label>
        <input type="range" data-ref="rCenter" min="0" max="360" step="1" aria-label="Orientamento del taglio">
      </div>
      <div class="range">
        <label><span>Taglio fino a</span><output data-ref="oExtent"></output></label>
        <input type="range" data-ref="rExtent" min="0" max="100" step="1" aria-label="Taglio fino a">
      </div>
    </section>

    <section class="group">
      <h3>Visualizzazione</h3>
      <div class="toggles">
        <label class="tg"><input type="checkbox" data-ref="tSpin"> <span data-ref="spinLabel">${esc(data.spinToggle ?? 'Rotori in moto')}</span></label>
        <label class="tg"><input type="checkbox" data-ref="tExplode"> Vista esplosa</label>
        ${temp ? '<label class="tg"><input type="checkbox" data-ref="tTemp"> Mappa temperature</label>' : ''}
        <label class="tg"><input type="checkbox" data-ref="tCasing" checked> Casse esterne</label>
        ${hasStations ? `<label class="tg"><input type="checkbox" data-ref="tStations" checked> ${esc(data.stationsToggle ?? 'Stazioni del ciclo')}</label>` : ''}
      </div>
    </section>

    ${cycle ? `
    <section class="group wide cycle">
      <h3>${esc(cycle.title)}</h3>
      <div class="range">
        <label><span>Angolo di manovella</span><output data-ref="oTheta"></output></label>
        <input type="range" data-ref="rTheta" min="0" max="${cycle.length}" step="1" aria-label="Angolo di manovella">
      </div>
      <div class="cyls">
        ${cycle.cylinders.map((cy, i) => `<div class="cyl" data-cyl="${i}"><span class="cyl-n">${esc(cy.label)}</span><span class="stroke"><span class="dot"></span><span class="stroke-name"></span></span><span class="cyl-bar"><i></i></span></div>`).join('')}
      </div>
      <div class="strokes">${cycle.strokes.map(st => `<span><span class="dot" style="background:${st.color}"></span>${esc(st.name)}</span>`).join('')}</div>
      ${cycle.note ? `<p class="note">${esc(cycle.note)}</p>` : ''}
    </section>` : ''}

    ${flowDef ? `
    <section class="group wide flow">
      <h3>${esc(flowDef.title)}</h3>
      <div class="toggles">
        <label class="tg"><input type="checkbox" data-ref="tFlow" checked> Frecce del flusso</label>
        <label class="tg tg-select"><span>Colore</span>
          <select data-ref="sFlowColor" aria-label="Grandezza mostrata dal colore delle frecce">
            <option value="T">Temperatura</option><option value="p">Pressione</option><option value="c">Velocità</option>
          </select>
        </label>
      </div>
      <div class="range">
        <label><span>Velocità di rotazione</span><output data-ref="oRpm"></output></label>
        <input type="range" data-ref="rRpm" min="${flowDef.limits.rpm[0]}" max="${flowDef.limits.rpm[1]}" step="100" aria-label="Velocità di rotazione">
      </div>
      <div class="range">
        <label><span>Portata</span><output data-ref="oMdot"></output></label>
        <input type="range" data-ref="rMdot" min="${flowDef.limits.mdot[0]}" max="${flowDef.limits.mdot[1]}" step="0.01" aria-label="Portata">
      </div>
      <div class="flow-warn" data-ref="flowWarn" role="status" hidden></div>
      <dl class="facts" data-ref="flowFacts"></dl>
      <div class="tris">
        <figure><figcaption>Triangolo in ingresso alla girante (raggio medio)</figcaption><div data-ref="triIn"></div></figure>
        <figure><figcaption>Triangolo in uscita dalla girante</figcaption><div data-ref="triOut"></div></figure>
        <div class="tri-key"><span class="tc">c velocità assoluta</span><span class="tw">w velocità relativa</span><span class="tu">u velocità periferica</span><span class="tb">direzione della pala</span></div>
      </div>
      <div class="actions"><button class="btn" type="button" data-ref="flowReset">Torna al punto di progetto</button></div>
      <p class="note">${esc(flowDef.note)}</p>
    </section>` : ''}

    <section class="info wide" data-ref="info" aria-live="polite"></section>

    <section class="group wide">
      <h3>Componenti</h3>
      <div class="chips" data-ref="chips"></div>
    </section>

    <p class="note wide" data-ref="dataNote">${esc(data.note)}</p>
  </aside>`;

  const $ = <T extends HTMLElement = HTMLElement>(ref: string) => el.querySelector(`[data-ref="${ref}"]`) as T;
  const viewer = el.querySelector('.viewer') as HTMLElement;
  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // pizzico su Safari/iPad: lo zoom lo gestisce il modello, non la pagina
  viewer.addEventListener('gesturestart', e => e.preventDefault());

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    $('err').style.display = 'grid';
    el.querySelector('.panel')!.remove();
    return { el, show() {}, hide() {}, select() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(data.view.fov, 1, data.view.near, data.view.far);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // userCam: la camera è stata mossa a mano (allora l'inquadratura non segue i cambiamenti dell'impianto)
  let userCam = false;
  controls.addEventListener('start', () => { camAnim.active = false; userCam = true; });

  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ec3ff, 0.55); rim.position.set(-4, 2, -5); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a1410, 0.35));

  let grid: THREE.GridHelper | null = null;

  /* ---------------- Piani di taglio (clipIntersection: si taglia solo il cuneo comune) */
  const planes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), new THREE.Plane(new THREE.Vector3(1, 0, 0), 1000)];
  let X_MIN = 0, X_MAX = 1;
  function updatePlanes() {
    const cut = S.cut;
    if (!cut || cut.alpha < 0.5) { planes[2].normal.set(1, 0, 0); planes[2].constant = 1000; return; }
    const a = Math.min(cut.alpha, 180);
    const t0 = THREE.MathUtils.degToRad(cut.center - a / 2);
    const tb = THREE.MathUtils.degToRad(cut.center + a / 2);
    // angolo φ misurato nel piano (y, z) a partire da +y
    planes[0].normal.set(0, Math.sin(t0), -Math.cos(t0)); planes[0].constant = 0;
    planes[1].normal.set(0, -Math.sin(tb), Math.cos(tb)); planes[1].constant = 0;
    const x0 = X_MIN + (X_MAX - X_MIN) * cut.extent / 100;
    planes[2].normal.set(1, 0, 0); planes[2].constant = -x0;
  }
  const isClipped = (p: THREE.Vector3) => planes.every(pl => pl.distanceToPoint(p) < 0);

  /* ---------------- Scene */
  const makeScene = (k: string, d: MachineData, model: MachineModel): SceneState => {
    const spoolIds = Object.keys(d.spools);
    const angles: Record<string, number> = {};
    spoolIds.forEach(id => { angles[id] = 0; });
    model.root.visible = false;
    scene.add(model.root);
    return {
      key: k, data: d, model, angles, spoolIds, roots: spoolIds.filter(id => !d.spools[id].of),
      cut: d.section ? { alpha: d.section.alpha, center: d.section.center, extent: d.section.extent } : null,
      labels: d.stations, arrows: null, bubbles: null
    };
  };
  const scenes = new Map<string, SceneState>();
  let plantScene: PlantScene | null = null;
  if (plantDef) {
    const pumpScenes = pumpDatas.map(d => makeScene(d.id, d, buildModel(d, planes)));
    plantScene = buildPlant(data, pumpScenes.map(s => ({ model: s.model, data: s.data })));
    scenes.set('impianto', makeScene('impianto', data, plantScene));
    pumpScenes.forEach(s => scenes.set(s.key, s));
  } else {
    scenes.set('main', makeScene('main', data, buildModel(data, planes)));
  }
  const mainScene = [...scenes.values()][0];
  let S: SceneState = mainScene;
  S.model.root.visible = true;
  const tempColor = temperatureScale(stops);

  /* ---------------- Stato e interfaccia */
  const state = { spin: !reduced, explode: false, temp: false, casing: true, stations: true, selected: null as string | null, isolate: false, panel: true };
  let ex = 0;
  let flowRes: FlowResult | null = null;
  let flowOn = true;
  const tSpin = $<HTMLInputElement>('tSpin'); tSpin.checked = state.spin;

  function applyColors() {
    S.model.allMats.forEach(m => {
      const col = state.temp ? tempColor(m.userData.T) : m.userData.base;
      m.color.copy(col);
      m.userData.cap.value.copy(col).lerp(WHITE, 0.28);
      m.metalness = state.temp ? 0.1 : m.userData.metal;
    });
    if (temp) $('legend').classList.toggle('on', state.temp);
  }
  function applyHighlight() {
    Object.values(S.model.comps).forEach(c => {
      const sel = state.selected === c.id;
      const ghost = state.isolate && !!state.selected && !sel;
      c.mats.forEach(m => {
        m.emissive.set(sel ? ACCENT : '#000000');
        m.emissiveIntensity = sel ? 0.22 : 0;
        // i materiali trasparenti di natura (acqua, tubazioni) restano tali
        const base = m.userData.opacity ?? 1, tr = ghost || base < 1;
        if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
        m.depthWrite = !tr;
        m.opacity = ghost ? Math.min(0.1, base) : base;
      });
    });
  }
  function applyCasing() { S.model.pickables.forEach(m => { if (m.userData.casing) m.visible = state.casing; }); }

  function renderInfo() {
    const id = state.selected, comps = S.model.comps;
    const d: Card = id ? comps[id].def : S.data.overview;
    const color = id ? comps[id].color : ACCENT;
    const actions = id
      ? `<button class="btn primary" type="button" data-act="iso">${state.isolate ? 'Mostra tutti i componenti' : 'Isola il componente'}</button><button class="btn" type="button" data-act="all">Vista d’insieme</button>`
      : '';
    $('info').innerHTML = `<div class="tag"><span class="dot" style="background:${color}"></span>${esc(d.section)}</div><h2>${esc(d.name)}</h2><p>${esc(d.text)}</p>${factsHtml(d.facts)}${d.course ? `<div class="course"><strong>Nel corso</strong>${esc(d.course)}</div>` : ''}<div class="actions">${actions}</div>`;
    el.querySelectorAll<HTMLElement>('[data-ref="chips"] .chip').forEach(ch => ch.setAttribute('aria-pressed', String(ch.dataset.id === id)));
  }
  $('info').addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'iso') { state.isolate = !state.isolate; applyHighlight(); renderInfo(); }
    if (act === 'all') select(null);
  });

  function select(id: string | null, { focus = false, scroll = false } = {}) {
    if (id && !S.model.comps[id]) {
      // il componente può appartenere a un'altra scena (es. una pompa dell'impianto)
      const other = [...scenes.values()].find(sc => sc.model.comps[id!]);
      if (other) setScene(other.key); else id = null;
    }
    state.selected = id;
    if (!id) state.isolate = false;
    applyHighlight(); renderInfo();
    if (focus && id) focusOn(id);
    if (scroll && state.panel) $('info').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  }

  function renderChips() {
    $('chips').innerHTML = S.data.components.map(c => `<button class="chip" type="button" data-id="${c.id}" aria-pressed="false"><span class="dot" style="background:${S.model.comps[c.id].color}"></span>${esc(c.short)}</button>`).join('');
  }
  $('chips').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.chip'); if (!b) return;
    const id = b.dataset.id!;
    select(state.selected === id ? null : id, { focus: true, scroll: true });
  });

  // controlli di sezione
  const segBtns = [...el.querySelectorAll<HTMLButtonElement>('[data-ref="secGroup"] .seg button')];
  const rAlpha = $<HTMLInputElement>('rAlpha'), rCenter = $<HTMLInputElement>('rCenter'), rExtent = $<HTMLInputElement>('rExtent');
  function syncCut() {
    updatePlanes();
    const cut = S.cut, sec = S.data.section;
    if (!cut || !sec) return;
    $('oAlpha').textContent = `${cut.alpha}°`;
    $('oCenter').textContent = `${cut.center}°`;
    $('oExtent').textContent = cut.extent >= 100 ? 'tutta la macchina' : `x = ${((X_MIN + (X_MAX - X_MIN) * cut.extent / 100) * (sec.scale ?? 1)).toFixed(sec.unit ? 0 : 2).replace('.', ',')} ${sec.unit ?? 'm'}`;
    segBtns.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === cut.alpha)));
  }
  segBtns.forEach(b => b.addEventListener('click', () => { if (!S.cut) return; S.cut.alpha = Number(b.dataset.preset); rAlpha.value = String(S.cut.alpha); syncCut(); }));
  rAlpha.addEventListener('input', () => { if (S.cut) { S.cut.alpha = Number(rAlpha.value); syncCut(); } });
  rCenter.addEventListener('input', () => { if (S.cut) { S.cut.center = Number(rCenter.value); syncCut(); } });
  rExtent.addEventListener('input', () => { if (S.cut) { S.cut.extent = Number(rExtent.value); syncCut(); } });
  const checkbox = (ref: string, fn: (on: boolean) => void) => { const i = $<HTMLInputElement>(ref); i.addEventListener('change', () => fn(i.checked)); };
  checkbox('tSpin', on => { state.spin = on; updateRpm(); });
  checkbox('tExplode', on => { state.explode = on; fitView(state.explode); });
  if (temp) checkbox('tTemp', on => { state.temp = on; applyColors(); });
  checkbox('tCasing', on => { state.casing = on; applyCasing(); });
  if (hasStations) checkbox('tStations', on => { state.stations = on; });
  $('resetView').addEventListener('click', () => fitView(state.explode));
  const togglePanel = $('togglePanel');
  togglePanel.addEventListener('click', () => {
    state.panel = !state.panel;
    el.classList.toggle('panel-hidden', !state.panel);
    togglePanel.textContent = state.panel ? 'Nascondi comandi' : 'Mostra comandi';
    togglePanel.setAttribute('aria-expanded', String(state.panel));
  });
  const fmtInt = (v: number) => group(Math.round(v).toLocaleString('it-IT'));
  function updateRpm() {
    let label = S.data.spinLabel;
    if (flowRes) label = `nella realtà ${flowRes.rpm.toLocaleString('it-IT')} giri/min`;
    if (plantDef) label = S === mainScene ? `pompe a ${fmtInt(ps.rpm)} giri/min` : `nella realtà ${fmtInt(ps.rpm)} giri/min`;
    $('rpm').innerHTML = state.spin ? `<span class="long">${esc(S.data.spinNote)} · </span>${esc(label)}` : '';
  }

  /* ---------------- Stazioni ed etichette */
  let stEls: HTMLElement[] = [];
  let stKey = '';
  function renderLabels() {
    const list = S.labels;
    const k = JSON.stringify(list.map(s => [s.n, s.label, s.flip, s.kind]));
    if (k === stKey) return;
    stKey = k;
    $('stations').innerHTML = '';
    stEls = list.map(s => {
      const d = document.createElement('div');
      d.className = `station${s.flip ? ' rev' : ''}${s.kind ? ' ' + s.kind : ''}`;
      d.innerHTML = `<b>${esc(String(s.n))}</b><span>${esc(s.label)}</span>`;
      $('stations').appendChild(d);
      return d;
    });
  }
  const tmpV = new THREE.Vector3();
  function placeStations() {
    const show = state.stations && ex < 0.05;
    const w = viewer.clientWidth, h = viewer.clientHeight;
    S.labels.forEach((s, i) => {
      const d = stEls[i]; if (!d) return;
      tmpV.set(s.x, s.y, s.z ?? 0).project(camera);
      const vis = (show || (s.kind && s.kind.startsWith('cav') && ex < 0.05)) && tmpV.z < 1 && Math.abs(tmpV.x) < 1.05 && Math.abs(tmpV.y) < 1.05;
      d.style.display = vis ? 'flex' : 'none';
      if (vis) d.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * w}px, ${(-tmpV.y * 0.5 + 0.5) * h - 16}px) translate(${s.flip ? 'calc(-100% + 10px)' : '-10px'}, -100%)`;
    });
  }

  /* ---------------- Camera: inquadratura, focus */
  const VIEW_DIR = new THREE.Vector3();
  const viewDir = () => { const v = S.data.view; return camera.aspect < 1 ? VIEW_DIR.set(...(v.dirPortrait ?? [1.15, 0.55, 0.85])).normalize() : VIEW_DIR.set(...(v.dir ?? [0.62, 0.42, 1.0])).normalize(); };
  const camAnim = { active: false, t: 0, fromP: new THREE.Vector3(), toP: new THREE.Vector3(), fromT: new THREE.Vector3(), toT: new THREE.Vector3() };
  function animateTo(pos: THREE.Vector3, target: THREE.Vector3) {
    camAnim.fromP.copy(camera.position); camAnim.toP.copy(pos);
    camAnim.fromT.copy(controls.target); camAnim.toT.copy(target);
    camAnim.t = reduced ? 1 : 0; camAnim.active = true;
  }
  function fitPose(box: THREE.Box3) {
    const center = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const d = viewDir().clone();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
    const up = new THREE.Vector3().crossVectors(d, right).normalize();
    const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    let hw = 0, hh = 0, hd = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const p = new THREE.Vector3(sx * half.x, sy * half.y, sz * half.z);
      hw = Math.max(hw, Math.abs(p.dot(right))); hh = Math.max(hh, Math.abs(p.dot(up))); hd = Math.max(hd, p.dot(d));
    }
    const dist = Math.max(hw / Math.tan(hf / 2), hh / Math.tan(vf / 2)) * 1.02 + hd * 0.4;
    return { pos: center.clone().addScaledVector(d, dist), target: center };
  }
  function fitView(exploded: boolean, instant = false) {
    const v = S.data.view;
    const [a, b] = plantScene && S.model === plantScene ? plantScene.box : exploded ? v.fit.exploded : v.fit.assembled;
    const { pos, target } = fitPose(new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b)));
    userCam = false;
    if (instant) { camera.position.copy(pos); controls.target.copy(target); controls.update(); } else animateTo(pos, target);
  }
  function focusOn(id: string) {
    const box = new THREE.Box3().setFromObject(S.model.comps[id].group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const offset = camera.position.clone().sub(controls.target);
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = THREE.MathUtils.clamp(size * 1.6, S.data.view.focusMin ?? 2.2, offset.length());
    animateTo(center.clone().add(offset.setLength(dist)), center);
  }

  /* ---------------- Selezione con tocco/clic */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number; id: number } | null = null;
  let touches = 0;
  const worldVisible = (o: THREE.Object3D | null) => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
  canvas.addEventListener('pointerdown', e => {
    touches++;
    // con due dita (zoom/spostamento) non si seleziona
    down = touches === 1 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
  });
  const release = () => { touches = Math.max(0, touches - 1); };
  canvas.addEventListener('pointercancel', () => { release(); down = null; });
  canvas.addEventListener('pointerup', e => {
    release();
    if (!down || down.id !== e.pointerId || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(S.model.pickables, false).filter(h => {
      const id = h.object.userData.comp as string;
      if (!worldVisible(h.object)) return false;
      if (state.isolate && state.selected && id !== state.selected) return false;
      // le parti che il taglio non seziona restano selezionabili anche dentro il cuneo
      const mat = (h.object as THREE.Mesh).material as THREE.Material;
      return !mat.clippingPlanes?.length || !isClipped(h.point);
    });
    if (hits.length) { const id = hits[0].object.userData.comp as string; select(state.selected === id ? null : id, { scroll: true }); }
    else select(null);
  });

  /* ---------------- Cambio di scena */
  function setScene(k: string) {
    const next = scenes.get(k);
    if (!next) return;
    const changed = next !== S;
    S.model.root.visible = false;
    if (S.arrows) S.arrows.mesh.visible = false;
    if (S.bubbles) S.bubbles.mesh.visible = false;
    S = next;
    S.model.root.visible = true;
    const d = S.data, v = d.view;
    $('eyebrow').textContent = d.eyebrow;
    $('title').textContent = d.title;
    $('subtitle').textContent = d.subtitle;
    $('dataNote').textContent = d.note;
    canvas.setAttribute('aria-label', d.canvasLabel);
    $('spinLabel').textContent = d.spinToggle ?? 'Rotori in moto';
    // sezione
    $('secGroup').hidden = !S.cut;
    if (S.cut && d.section) {
      X_MIN = d.section.xMin; X_MAX = d.section.xMax;
      rAlpha.value = String(S.cut.alpha); rCenter.value = String(S.cut.center); rExtent.value = String(S.cut.extent);
    }
    syncCut();
    // griglia e camera
    if (grid) { scene.remove(grid); grid.dispose(); }
    grid = new THREE.GridHelper(v.grid.size, v.grid.divisions, 0x2b3a47, 0x1a242d);
    grid.position.set(...v.grid.position);
    scene.add(grid);
    camera.fov = v.fov; camera.near = v.near; camera.far = v.far; camera.updateProjectionMatrix();
    controls.minDistance = v.minDistance; controls.maxDistance = v.maxDistance;
    if (changed) { state.selected = null; state.isolate = false; }
    renderChips(); applyColors(); applyHighlight(); applyCasing(); renderInfo();
    stKey = ''; renderLabels();
    updateLegend();
    updateRpm();
    if (fitted) fitView(state.explode, true);
    if (plantDef) onScene();
  }

  /* ---------------- Ciclo di rendering */
  let fitted = false;
  function resize() {
    const w = viewer.clientWidth, h = viewer.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const wasPortrait = camera.aspect < 1;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (!fitted) { fitView(false, true); fitted = true; }
    else if (wasPortrait !== camera.aspect < 1) fitView(state.explode, true);
  }
  new ResizeObserver(resize).observe(viewer);

  const clock = new THREE.Clock();

  /* ---------------- Simulazione del flusso (compressori) */
  let flowArrows: FlowArrows | null = null;
  let updateLegend = () => {};
  const num = (v: number, d = 0) => group(v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const legendHtml = (info: ColorInfo, st: [number, string][]) => {
    const lo = st[0][0], hi = st[st.length - 1][0];
    const grad = st.map(([vv, c]) => `${c} ${Math.round((vv - lo) / (hi - lo) * 100)}%`).join(', ');
    return `<div>${esc(info.label)} (${info.unit})</div><div class="bar" style="background: linear-gradient(90deg, ${grad})"></div><div class="ticks">${st.map(([vv]) => `<span>${num(vv, vv % 1 ? 2 : 0)}</span>`).join('')}</div>`;
  };
  if (flowDef) {
    const fd = flowDef;
    flowArrows = new FlowArrows({
      size: fd.arrows.size, timeScale: fd.timeScale, capacity: fd.arrows.spans.length * fd.arrows.angles * fd.arrows.perPath,
      perPath: fd.arrows.perPath, scales: fd.colors, info: COLOR_INFO, mode: 'T'
    });
    mainScene.arrows = flowArrows;
    scene.add(flowArrows.mesh);
    const rRpm = $<HTMLInputElement>('rRpm'), rMdot = $<HTMLInputElement>('rMdot'), sel = $<HTMLSelectElement>('sFlowColor');
    updateLegend = () => { $('flowLegend').innerHTML = legendHtml(COLOR_INFO[flowArrows!.mode as 'T'], fd.colors[flowArrows!.mode as 'T']); };
    const solve = () => {
      const rpm = Number(rRpm.value), mdot = Number(rMdot.value);
      flowRes = solveFlow(fd, rpm, mdot);
      flowArrows!.setResult(flowRes);
      const r = flowRes;
      $('oRpm').textContent = `${num(rpm)} giri/min`;
      $('oMdot').textContent = `${num(mdot, 2)} kg/s`;
      $('flowFacts').innerHTML = ([
        ['Rapporto di compressione (totale)', `${num(r.pr, 2)} : 1`],
        ['Pressione totale di mandata', `${num(r.p04 / 1e5, 2)} bar`],
        ['Temperatura totale di mandata', `${num(r.T02 - 273.15)} °C`],
        ['Lavoro (equazione di Eulero)', `${num(r.work / 1000, 1)} kJ/kg`],
        ['Potenza assorbita', `${num(r.power / 1000)} kW`],
        ['Rendimento dello stadio', `${num(r.etaStage * 100, 1)} %`],
        ['Velocità periferica u₂', `${num(r.u2)} m/s`],
        ['Fattore di scorrimento σ', num(r.sigma, 3)],
        ['Incidenza al raggio medio', `${r.incidence >= 0 ? '+' : '−'}${num(Math.abs(r.incidence), 1)}°`],
        ['Mach relativo all’apice d’ingresso', num(r.machRelTip, 2)]
      ] as [string, string][]).map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
      $('triIn').innerHTML = triangleSvg(r.inlet, 'in');
      $('triOut').innerHTML = triangleSvg(r.outlet, 'out');
      const warn = $('flowWarn');
      const msgs: string[] = [];
      if (r.surge) msgs.push('Portata troppo bassa per questi giri: l’incidenza è elevata e la macchina è vicina al pompaggio (flusso instabile, inversioni di portata).');
      if (r.choke) msgs.push('Velocità vicine a quella del suono: la macchina è vicina al blocco sonico e la portata non può crescere oltre.');
      if (!r.surge && r.incidence < -8) msgs.push('Incidenza negativa elevata: portata alta per questi giri, il rendimento cala.');
      warn.hidden = !msgs.length;
      warn.innerHTML = msgs.map(m => `<p>${esc(m)}</p>`).join('');
      updateRpm();
    };
    rRpm.value = String(fd.design.rpm); rMdot.value = String(fd.design.mdot);
    rRpm.addEventListener('input', solve);
    rMdot.addEventListener('input', solve);
    sel.addEventListener('change', () => { flowArrows!.mode = sel.value; updateLegend(); flowArrows!.update(0); });
    $<HTMLInputElement>('tFlow').addEventListener('change', e => { flowOn = (e.target as HTMLInputElement).checked; $('flowLegend').classList.toggle('on', flowOn); });
    $('flowReset').addEventListener('click', () => { rRpm.value = String(fd.design.rpm); rMdot.value = String(fd.design.mdot); solve(); });
    updateLegend();
    solve();
  }

  /* ---------------- Impianto di sollevamento */
  const ps = { m: 0, N: 1, series: false, rpm: 1450, Hg: 20, z: 2, throttle: false, Qreq: 0 };
  let onScene = () => {};
  let pumpLabels: Label[] = [];
  if (plantDef && plantScene) {
    const pd = plantDef, plantS = scenes.get('impianto')!;
    const { rho, pv } = pd.water, g = pd.g;
    const models = pumpDatas.map(d => new PumpModel(d.pump!, rho, g));
    const pumpScene = (i: number) => scenes.get(pumpDatas[i].id)!;
    let colorMode = 'p';
    let rows: CurveRow[] = [];
    let op: OpResult | null = null;

    // frecce dell'impianto e delle pompe, bolle di cavitazione
    const pathLen = (p: FlowPath) => { let L = 0; for (let i = 1; i < p.s.length; i++) L += Math.hypot(p.s[i].x - p.s[i - 1].x, p.s[i].y - p.s[i - 1].y, p.s[i].z - p.s[i - 1].z); return L; };
    plantS.arrows = new FlowArrows({ size: pd.arrows.size, timeScale: pd.arrows.timeScale, capacity: 1400, perPath: p => pathLen(p) / pd.arrows.spacing, scales: pd.colors, info: WATER_INFO, mode: colorMode });
    plantS.colors = pd.colors; plantS.info = WATER_INFO;
    scene.add(plantS.arrows.mesh);
    pumpDatas.forEach((d, i) => {
      const f = d.pump!.flow, sc = pumpScene(i);
      sc.arrows = new FlowArrows({ size: f.arrows.size, timeScale: f.timeScale, capacity: f.arrows.spans.length * f.arrows.angles * f.arrows.perPath, perPath: f.arrows.perPath, scales: f.colors, info: WATER_INFO, mode: colorMode });
      sc.bubbles = new BubbleField(f.arrows.size * 0.24, 500, f.timeScale);
      sc.colors = f.colors; sc.info = WATER_INFO;
      sc.arrows.mesh.visible = false; sc.bubbles.mesh.visible = false;
      scene.add(sc.arrows.mesh, sc.bubbles.mesh);
    });
    updateLegend = () => {
      const cols = S.colors;
      if (!cols || !S.info) { $('flowLegend').innerHTML = ''; return; }
      $('flowLegend').innerHTML = legendHtml(S.info[colorMode], cols[colorMode]);
    };

    const rPrpm = $<HTMLInputElement>('rPrpm'), rHg = $<HTMLInputElement>('rHg'), rZ = $<HTMLInputElement>('rZ'), rQ = $<HTMLInputElement>('rQ');
    const tThrottle = $<HTMLInputElement>('tThrottle');
    const pressSet = (ref: string, attr: string, val: string) => el.querySelectorAll<HTMLButtonElement>(`[data-ref="${ref}"] button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === val)));
    const settings = (): PlantSettings => ({ N: ps.N, series: ps.series, rpm: ps.rpm, Hg: ps.Hg, z: ps.z, Qreq: ps.throttle ? ps.Qreq / 1000 : null });
    const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), d)}`;

    const syncControls = () => {
      const d = pumpDatas[ps.m].pump!;
      rPrpm.min = String(d.limits.rpm[0]); rPrpm.max = String(d.limits.rpm[1]);
      rPrpm.value = String(ps.rpm); rHg.value = String(ps.Hg); rZ.value = String(ps.z);
      pressSet('pMachine', 'm', String(ps.m));
      pressSet('pN', 'n', String(ps.N));
      pressSet('pConn', 'c', ps.series ? 'ser' : 'par');
      el.querySelectorAll<HTMLButtonElement>('[data-ref="pConn"] button').forEach(b => { b.disabled = ps.N === 1; });
      tThrottle.checked = ps.throttle;
      $('qBox').hidden = !ps.throttle;
    };
    onScene = () => {
      pressSet('pView', 'view', S === plantS ? 'plant' : 'pump');
      // aperta la scheda di una macchina (ad esempio da un collegamento): il pannello passa a quella macchina
      const i = pumpDatas.findIndex(d => d.id === S.key);
      if (i >= 0 && i !== ps.m) { ps.m = i; ps.rpm = pumpDatas[i].pump!.n0; syncControls(); recompute(); }
    };

    const applyDesign = (m: number) => {
      const d = pumpDatas[m], des = pd.design[d.id];
      ps.m = m; ps.rpm = d.pump!.n0;
      if (des) { ps.N = des.pumps; ps.series = des.series; ps.Hg = des.Hg; ps.z = des.z; }
      ps.throttle = false;
    };

    let pending = false;
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; recompute(); }); } };

    function recompute() {
      const pm = models[ps.m], pdata = pumpDatas[ps.m], def = pdata.pump!;
      const s = settings();
      const QmaxGroup = pm.Qmax(ps.rpm) * (ps.series ? 1 : ps.N);
      // cursore della portata richiesta: fino alla portata massima del gruppo
      rQ.max = String(Math.round(QmaxGroup * 1000));
      if (ps.Qreq > QmaxGroup * 1000) ps.Qreq = Math.round(QmaxGroup * 1000);
      rQ.value = String(ps.Qreq);
      const o = solvePlant(pd, pm, s);
      op = o;
      const oldBox = JSON.stringify(plantScene!.box);
      plantScene!.rebuild(s, ps.m, o);
      // l'impianto ha cambiato dimensioni: si reinquadra, se la camera non è stata mossa a mano
      if (S === plantS && fitted && !userCam && JSON.stringify(plantScene!.box) !== oldBox) fitView(state.explode);
      if (S === plantS) { applyHighlight(); applyCasing(); }
      plantS.labels = plantScene!.labels;
      plantS.arrows!.setResult({ paths: plantScene!.paths });

      // pompa singola (in serie: la prima, quella esposta alla cavitazione)
      const sc = pumpScene(ps.m);
      if (o.Q > 1e-4) {
        const pf = solvePumpFlow(def, {
          Qp: o.Qp, rpm: ps.rpm, pt1: rho * g * o.npsha + pv, H: o.Hp, Hth: o.tri.Hth, cu2: o.tri.out.cu,
          npsha: o.npsha, npshi: o.npshi, rho, g, pv
        });
        sc.arrows!.setResult(pf);
        sc.bubbles!.setPaths(pf.paths);
      } else { sc.arrows!.setResult({ paths: [] }); sc.bubbles!.setPaths([]); }
      const eye = def.kind === 'centrifuga' ? { x: 0.02, y: -0.125, z: 0 } : { x: 0.05, y: -0.17, z: 0 };
      pumpLabels = o.cav >= 1 && o.Q > 1e-4 ? [{ n: '!', label: o.cav === 1 ? 'Bolle di vapore: cavitazione incipiente' : 'Cavitazione sviluppata', ...eye, kind: o.cav === 1 ? 'cav1' : 'cav2' }] : [];
      pumpDatas.forEach((d, i) => { const sci = pumpScene(i); sci.labels = [...d.stations, ...(i === ps.m ? pumpLabels : [])]; });
      renderLabels();

      // uscite numeriche
      $('oPrpm').textContent = `${num(ps.rpm)} giri/min`;
      $('oHg').textContent = `${num(ps.Hg, 1)} m`;
      $('oZ').textContent = `${signed(ps.z)} m${ps.z < 0 ? ' · sotto battente' : ps.z > 0 ? ' · in aspirazione' : ''}`;
      $('oQ').textContent = `${num(ps.Qreq)} L/s`;

      // diagrammi
      const Qaxis = niceMax(QmaxGroup * 1000, 5) / 1000;
      rows = plantCurves(pd, pm, s, o, Qaxis);
      $('pCharts').innerHTML = chartsHtml(rows, o, { N: ps.N, series: ps.series, label: def.label, Qbep: pm.Qbep(ps.rpm), por: def.por, throttled: ps.throttle && o.Hvalve > 0.01 });

      // stato della cavitazione (icona + testo)
      const st = $('pStatus');
      const lv = o.noFlow ? 'none' : ['good', 'warning', 'serious', 'critical'][o.cav];
      const icon = { good: '<circle cx="8" cy="8" r="7"/><path d="m4.8 8.2 2.2 2.2 4.4-4.6"/>', warning: '<path d="M8 1.5 15 14H1z"/><path d="M8 6v3.6M8 11.4v.4"/>', serious: '<path d="M8 1.5 15 14H1z"/><path d="M8 6v3.6M8 11.4v.4"/>', critical: '<circle cx="8" cy="8" r="7"/><path d="m5.2 5.2 5.6 5.6m0-5.6-5.6 5.6"/>', none: '<circle cx="8" cy="8" r="7"/><path d="M4.5 8h7"/>' }[lv];
      const title = o.noFlow ? 'Nessuna portata' : ['Nessuna cavitazione', 'Cavitazione incipiente', 'Cavitazione sviluppata', 'La pompa non funziona più'][o.cav];
      const text = o.noFlow
        ? (o.npsha <= 0.2 ? `La pompa è oltre il limite teorico d’aspirazione (${num(o.npsha + ps.z, 1)} m): l’acqua non può risalire fino a lei.` : 'Le pompe non riescono a vincere il salto geodetico: la valvola di ritegno resta chiusa.')
        : [
          `NPSH disponibile ${num(o.npsha, 1)} m, maggiore di quello di inizio cavitazione (${num(o.npshi, 1)} m).`,
          `NPSH disponibile ${num(o.npsha, 1)} m: compaiono le prime bolle (inizio a ${num(o.npshi, 1)} m). La prevalenza non cala ancora, ma rumore ed erosione rovinano le pale nel tempo.`,
          `NPSH disponibile ${num(o.npsha, 1)} m < NPSH richiesto ${num(o.npsh3, 1)} m: la prevalenza cala del ${num(o.drop * 100)} %, la portata diminuisce, la pompa vibra.`,
          `NPSH disponibile ${num(o.npsha, 1)} m, molto sotto il richiesto (${num(o.npsh3, 1)} m): il vapore blocca il flusso, la curva della pompa è troncata.`
        ][o.cav];
      st.className = `pstatus ${lv}`;
      st.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg><div><b>${esc(title)}</b><span>${esc(text)}</span></div>`;

      // avvisi
      const msgs: string[] = [];
      const q = o.q * 100, other = pumpDatas.find((_, i) => i !== ps.m)?.pump?.label.toLowerCase();
      if (o.noFlow && o.npsha > 0.2) msgs.push(`La prevalenza a portata nulla (${num(o.H, 1)} m) non supera il salto geodetico di ${num(ps.Hg, 1)} m. Prova ad aumentare i giri, a mettere le pompe in serie${other ? ` o a usare la pompa ${other}` : ''}. Una pompa che gira senza portata scalda l’acqua che contiene.`);
      if (o.unreachable) msgs.push(`Con la valvola si può solo ridurre la portata: a valvola aperta il gruppo dà ${num(o.Qfree * 1000)} L/s. ${o.rpmNeeded ? `Per ${num(ps.Qreq)} L/s servirebbero circa ${num(Math.round(o.rpmNeeded / 10) * 10)} giri/min${o.rpmNeeded > def.limits.rpm[1] ? ', oltre il limite del motore: servono più pompe' : ''}.` : 'Questa portata non si raggiunge nemmeno aumentando i giri: servono più pompe in parallelo.'}`);
      if (!o.noFlow && o.q < def.por[0]) msgs.push(`Portata pari al ${num(q)} % di quella di massimo rendimento: ricircolo all’ingresso e all’uscita della girante, vibrazioni e rendimento basso.${def.kind === 'assiale' ? ' Nella pompa assiale la potenza assorbita cresce quando la portata cala.' : ''}`);
      if (!o.noFlow && o.q > def.por[1]) msgs.push(`Portata pari al ${num(q)} % di quella di massimo rendimento: la pompa lavora “in fondo alla curva”, con rendimento basso e NPSH richiesto alto.`);
      if (o.unstable) msgs.push('Il punto di funzionamento cade nella “sella” della curva della pompa assiale, dove la prevalenza cresce con la portata: funzionamento instabile (stallo delle pale), portata e pressione oscillano.');
      if (o.multiple) msgs.push('La curva dell’impianto incontra quella delle pompe in più punti: il funzionamento può saltare dall’uno all’altro.');
      if (ps.throttle && def.kind === 'assiale' && o.Hvalve > 0.5) msgs.push('Strozzando una pompa assiale la potenza assorbita aumenta: conviene regolarla con i giri o con l’angolo delle pale.');
      const warn = $('pWarn');
      warn.hidden = !msgs.length;
      warn.innerHTML = msgs.map(m => `<p>${esc(m)}</p>`).join('');

      // valori
      const m3h = (Q: number) => num(Q * 3600);
      const facts: [string, string][] = o.noFlow ? [
        ['Portata', '0 L/s'],
        ['Prevalenza a portata nulla', `${num(o.H, 1)} m`],
        ['Potenza assorbita (a portata nulla)', `${num(o.P / 1000, 1)} kW`],
        ['NPSH disponibile', `${num(o.npsha, 1)} m`]
      ] : [
        ['Portata', `${num(o.Q * 1000)} L/s (${m3h(o.Q)} m³/h)`],
        ...(ps.N > 1 && !ps.series ? [['Portata di ogni pompa', `${num(o.Qp * 1000)} L/s`] as [string, string]] : []),
        ['Prevalenza del gruppo', `${num(o.H, 1)} m`],
        ...(ps.N > 1 && ps.series ? [['Prevalenza della prima pompa', `${num(o.Hp, 1)} m`] as [string, string]] : []),
        ['Rendimento', `${num(o.eta * 100, 1)} %`],
        ['Potenza assorbita', `${num(o.P / 1000, 1)} kW${ps.N > 1 ? ` (${num(o.Pp / 1000, 1)} kW per pompa)` : ''}`],
        ['Potenza resa all’acqua ρgQH', `${num(o.Pw / 1000, 1)} kW`],
        ['Energia per m³ sollevato', `${num(o.P / 1000 / (o.Q * 3600), 3)} kWh/m³`],
        ['Rispetto al massimo rendimento', `${num(q)} % della portata`],
        ['NPSH disponibile', `${num(o.npsha, 1)} m`],
        ['NPSH richiesto (3 %)', `${num(o.npsh3, 1)} m`],
        ['NPSH di inizio cavitazione', `${num(o.npshi, 1)} m`],
        ['Quota massima consigliata', `${signed(o.zMax)} m`],
        ['Quota senza bolle', `${signed(o.zFree)} m`]
      ];
      facts.push(['Numero di giri caratteristico', `n_q ≈ ${num(o.nq)} (${def.kind === 'assiale' ? 'assiale' : 'radiale'})`]);
      $('pFacts').innerHTML = facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
      const lossFacts: [string, string][] = [
        ['Salto geodetico H_g', `${num(ps.Hg, 1)} m`],
        [`Perdite in aspirazione${ps.series ? '' : ' (una pompa)'}`, `${num(o.losses.suction, 2)} m · v = ${num(o.v.suction, 2)} m/s`],
        [`Perdite nella mandata di ${ps.series ? 'gruppo' : 'una pompa'}`, `${num(o.losses.branch, 2)} m`],
        ...(ps.series && ps.N > 1 ? [['Perdite nei collegamenti in serie', `${num(o.losses.link, 2)} m`] as [string, string]] : []),
        ['Perdite nella condotta di mandata', `${num(o.losses.main, 2)} m · v = ${num(o.v.main, 2)} m/s`],
        ['Perdita nella valvola di regolazione', `${num(o.Hvalve, 2)} m${o.Hvalve > 0.01 ? ` (${num(rho * g * o.Q * o.Hvalve / 1000, 1)} kW dissipati)` : ''}`],
        ['Prevalenza di Eulero di una pompa', `${num(o.tri.Hth, 1)} m`]
      ];
      $('pLosses').innerHTML = lossFacts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');

      // triangoli di velocità
      const t = o.tri, axial = def.kind === 'assiale';
      const vmax = Math.max(t.in.u, t.out.u, Math.abs(t.out.cu - t.out.u), t.in.cm * 2, t.out.cm * 2, 1);
      const sc2 = 190 / vmax;
      $('pTriIn').innerHTML = o.Q > 1e-4 ? triangleSvg(t.in, 'in', sc2, false, '-pp') : '<p class="note">Nessuna portata.</p>';
      $('pTriOut').innerHTML = o.Q > 1e-4 ? triangleSvg(t.out, 'out', sc2, axial, '-pp') : '';
      $('triInCap').textContent = axial ? 'Triangolo in ingresso all’elica (raggio medio)' : 'Triangolo in ingresso alla girante (raggio medio)';
      $('triOutCap').textContent = axial ? 'Triangolo in uscita dall’elica (raggio medio)' : 'Triangolo in uscita dalla girante';

      updateRpm();
      if (S === plantS || S === sc) updateLegend();
    }

    // eventi
    el.querySelector('[data-ref="pView"]')!.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return;
      setScene(b.dataset.view === 'plant' ? 'impianto' : pumpDatas[ps.m].id);
    });
    el.querySelector('[data-ref="pMachine"]')!.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return;
      const m = Number(b.dataset.m);
      if (m === ps.m) return;
      ps.m = m; ps.rpm = pumpDatas[m].pump!.n0;
      syncControls(); recompute();
      if (S !== plantS) setScene(pumpDatas[m].id);
    });
    el.querySelector('[data-ref="pN"]')!.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return;
      ps.N = Number(b.dataset.n); syncControls(); recompute();
    });
    el.querySelector('[data-ref="pConn"]')!.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b || b.disabled) return;
      ps.series = b.dataset.c === 'ser'; syncControls(); recompute();
    });
    rPrpm.addEventListener('input', () => { ps.rpm = Number(rPrpm.value); schedule(); });
    rHg.addEventListener('input', () => { ps.Hg = Number(rHg.value); schedule(); });
    rZ.addEventListener('input', () => { ps.z = Number(rZ.value); schedule(); });
    rQ.addEventListener('input', () => { ps.Qreq = Number(rQ.value); schedule(); });
    tThrottle.addEventListener('change', () => {
      ps.throttle = tThrottle.checked;
      // si parte dalla portata attuale: la valvola comincia a chiudersi da lì
      if (ps.throttle && op) ps.Qreq = Math.round(op.Q * 1000 * 0.85);
      syncControls(); recompute();
    });
    $('pReset').addEventListener('click', () => { applyDesign(ps.m); syncControls(); recompute(); });
    $<HTMLSelectElement>('sPcolor').addEventListener('change', e => {
      colorMode = (e.target as HTMLSelectElement).value;
      for (const sc of scenes.values()) if (sc.arrows) { sc.arrows.mode = colorMode; sc.arrows.update(0); }
      updateLegend();
    });
    $<HTMLInputElement>('tPflow').addEventListener('change', e => { flowOn = (e.target as HTMLInputElement).checked; $('flowLegend').classList.toggle('on', flowOn); });
    attachHover($('pCharts'), () => rows);

    applyDesign(0);
    syncControls();
    recompute();
  }

  /* ---------------- Alberi: angoli (rad). Gli alberi con "of" seguono un altro albero con un rapporto */
  const spoolSpeed = (sc: SceneState, id: string) => {
    if (flowDef && flowRes && id === flowDef.spool) return (flowRes.rpm * 2 * Math.PI) / 60 / flowDef.timeScale;
    const pf = sc.data.pump?.flow;
    if (pf && id === pf.spool) return (ps.rpm * 2 * Math.PI) / 60 / pf.timeScale;
    return sc.data.spools[id].speed ?? 0;
  };
  function resolveFollowers(sc: SceneState) {
    for (let pass = 0; pass < sc.spoolIds.length; pass++) for (const id of sc.spoolIds) {
      const sd = sc.data.spools[id];
      if (sd.of) sc.angles[id] = (sc.angles[sd.of] ?? 0) * (sd.ratio ?? 1);
    }
  }

  /* ---------------- Fasi del ciclo (motori alternativi) */
  let lastTheta = -1;
  function updateCycle(force = false) {
    if (!cycle) return;
    const len = cycle.length;
    const theta = ((Math.round((mainScene.angles[cycle.spool] ?? 0) / Math.PI * 180) % len) + len) % len;
    if (theta === lastTheta && !force) return;
    lastTheta = theta;
    $<HTMLInputElement>('rTheta').value = String(theta);
    $('oTheta').textContent = `θ = ${theta}°`;
    const n = cycle.strokes.length, span = len / n;
    el.querySelectorAll<HTMLElement>('.cyl').forEach(row => {
      const cy = cycle.cylinders[Number(row.dataset.cyl)];
      const local = (((theta - cy.offset) % len) + len) % len, k = Math.floor(local / span);
      const st = cycle.strokes[k];
      (row.querySelector('.stroke .dot') as HTMLElement).style.background = st.color;
      row.querySelector('.stroke-name')!.textContent = st.name;
      const bar = row.querySelector('.cyl-bar i') as HTMLElement;
      bar.style.width = `${((local % span) / span * 100).toFixed(1)}%`;
      bar.style.background = st.color;
    });
  }
  if (cycle) {
    const r = $<HTMLInputElement>('rTheta');
    r.addEventListener('input', () => {
      // muovendo il cursore il motore si ferma: si studia una posizione alla volta
      if (state.spin) { state.spin = false; tSpin.checked = false; updateRpm(); }
      mainScene.angles[cycle.spool] = Number(r.value) * Math.PI / 180;
      resolveFollowers(mainScene); updateCycle(true);
    });
    updateCycle(true);
  }

  setScene(mainScene.key);

  let raf = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (state.spin) {
      for (const id of S.roots) S.angles[id] = (S.angles[id] + dt * spoolSpeed(S, id)) % (Math.PI * 8);
      resolveFollowers(S);
      updateCycle();
    }
    S.model.update(S.angles, state.selected);
    for (const fx of [S.arrows, S.bubbles]) {
      if (!fx) continue;
      fx.mesh.visible = flowOn && ex < 0.05;
      if (state.spin && fx.mesh.visible) fx.update(dt);
    }
    const target = state.explode ? 1 : 0;
    ex += (target - ex) * Math.min(1, dt * (reduced ? 60 : 3.5));
    Object.values(S.model.comps).forEach(c => { c.group.position.copy(c.explode).multiplyScalar(ex); c.parts.forEach(p => p.obj.position.copy(p.dir).multiplyScalar(ex)); });
    if (camAnim.active) {
      camAnim.t = Math.min(1, camAnim.t + dt * 1.8);
      const k = 1 - Math.pow(1 - camAnim.t, 3);
      camera.position.lerpVectors(camAnim.fromP, camAnim.toP, k);
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, k);
      if (camAnim.t >= 1) camAnim.active = false;
    }
    controls.update();
    if (fitted) { renderer.render(scene, camera); placeStations(); }
    raf = requestAnimationFrame(frame);
  }

  return {
    el,
    show() {
      if (raf) return;
      clock.getDelta();
      resize();
      raf = requestAnimationFrame(frame);
    },
    hide() { cancelAnimationFrame(raf); raf = 0; },
    select(id, { focus = true } = {}) {
      select(id, { focus: focus && !!id });
    }
  };
}
