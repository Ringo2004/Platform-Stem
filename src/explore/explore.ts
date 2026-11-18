import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Card, MachineData } from '../machines/types';
import { buildModel, temperatureScale, type MachineModel } from './model';
import { COLOR_INFO, FlowArrows, solveFlow, triangleSvg, type ColorMode, type FlowResult } from './flow';
import { esc, factsHtml } from '../util';

/*
 * Sezione "Esplora": modello 3D sezionabile a tutto schermo con pannello dei comandi.
 * La vista si può nascondere/mostrare: quando è nascosta il ciclo di rendering si ferma.
 */

const ACCENT = '#f0a43a';
const WHITE = new THREE.Color('#ffffff');

export interface ExploreView {
  el: HTMLElement;
  show(): void;
  hide(): void;
  select(id: string | null, opts?: { focus?: boolean }): void;
}

export function createExplore(data: MachineData): ExploreView {
  const el = document.createElement('div');
  el.className = 'explore';
  const cycle = data.cycle;
  const flowDef = data.flow;
  const stops = data.temperature.stops;
  const tMin = stops[0][0], tMax = stops[stops.length - 1][0];
  const gradient = stops.map(([t, c]) => `${c} ${Math.round((t - tMin) / (tMax - tMin) * 100)}%`).join(', ');

  el.innerHTML = `
  <div class="viewer">
    <canvas class="c" aria-label="${esc(data.canvasLabel)}"></canvas>
    <div class="titleblock">
      <div class="eyebrow">${esc(data.eyebrow)}</div>
      <h1>${esc(data.title)}</h1>
      <p class="sub">${esc(data.subtitle)}</p>
    </div>
    <div class="viewbtns">
      <button class="btn" data-ref="resetView" type="button">Ripristina vista</button>
      <button class="btn" data-ref="togglePanel" type="button" aria-expanded="true">Nascondi comandi</button>
    </div>
    <div data-ref="stations"></div>
    <div class="legends">
      ${flowDef ? '<div class="legend on" data-ref="flowLegend"></div>' : ''}
      <div class="legend" data-ref="legend">
        <div>${esc(data.temperature.label)}</div>
        <div class="bar" style="background: linear-gradient(90deg, ${gradient})"></div>
        <div class="ticks">${stops.map(([t]) => `<span>${t}</span>`).join('')}</div>
      </div>
    </div>
    <div class="hint"><span class="tip">Trascina per ruotare · pizzica o scorri per lo zoom · tocca un componente</span><span class="rpm" data-ref="rpm"></span></div>
    <div class="err" data-ref="err">Questo browser non supporta WebGL: il modello 3D non può essere mostrato.</div>
  </div>

  <aside class="panel" data-ref="panel" aria-label="Comandi del modello">
    <section class="group">
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
        <label class="tg"><input type="checkbox" data-ref="tSpin"> ${esc(data.spinToggle ?? 'Rotori in moto')}</label>
        <label class="tg"><input type="checkbox" data-ref="tExplode"> Vista esplosa</label>
        <label class="tg"><input type="checkbox" data-ref="tTemp"> Mappa temperature</label>
        <label class="tg"><input type="checkbox" data-ref="tCasing" checked> Casse esterne</label>
        ${data.stations.length ? '<label class="tg"><input type="checkbox" data-ref="tStations" checked> Stazioni del ciclo</label>' : ''}
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

    <p class="note wide">${esc(data.note)}</p>
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

  const v = data.view;
  const camera = new THREE.PerspectiveCamera(v.fov, 1, v.near, v.far);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = v.minDistance;
  controls.maxDistance = v.maxDistance;
  controls.addEventListener('start', () => { camAnim.active = false; });

  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9ec3ff, 0.55); rim.position.set(-4, 2, -5); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a1410, 0.35));

  const grid = new THREE.GridHelper(v.grid.size, v.grid.divisions, 0x2b3a47, 0x1a242d);
  grid.position.set(...v.grid.position);
  scene.add(grid);

  /* ---------------- Piani di taglio (clipIntersection: si taglia solo il cuneo comune) */
  const planes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), new THREE.Plane(new THREE.Vector3(1, 0, 0), 1000)];
  const { xMin: X_MIN, xMax: X_MAX } = data.section;
  const cut = { alpha: data.section.alpha, center: data.section.center, extent: data.section.extent };
  function updatePlanes() {
    if (cut.alpha < 0.5) { planes[2].normal.set(1, 0, 0); planes[2].constant = 1000; return; }
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

  /* ---------------- Modello */
  const model: MachineModel = buildModel(data, planes);
  scene.add(model.root);
  const { comps, pickables, allMats } = model;
  const tempColor = temperatureScale(stops);

  /* ---------------- Stato e interfaccia */
  const state = { spin: !reduced, explode: false, temp: false, casing: true, stations: true, selected: null as string | null, isolate: false, panel: true };
  let ex = 0;
  let flowRes: FlowResult | null = null;
  let flowArrows: FlowArrows | null = null;
  let flowOn = true;
  const tSpin = $<HTMLInputElement>('tSpin'); tSpin.checked = state.spin;

  function applyColors() {
    allMats.forEach(m => {
      const col = state.temp ? tempColor(m.userData.T) : m.userData.base;
      m.color.copy(col);
      m.userData.cap.value.copy(col).lerp(WHITE, 0.28);
      m.metalness = state.temp ? 0.1 : m.userData.metal;
    });
    $('legend').classList.toggle('on', state.temp);
  }
  function applyHighlight() {
    Object.values(comps).forEach(c => {
      const sel = state.selected === c.id;
      const ghost = state.isolate && !!state.selected && !sel;
      c.mats.forEach(m => {
        m.emissive.set(sel ? ACCENT : '#000000');
        m.emissiveIntensity = sel ? 0.22 : 0;
        if (m.transparent !== ghost) { m.transparent = ghost; m.depthWrite = !ghost; m.needsUpdate = true; }
        m.opacity = ghost ? 0.1 : 1;
      });
    });
  }
  function applyCasing() { pickables.forEach(m => { if (m.userData.casing) m.visible = state.casing; }); }

  function renderInfo() {
    const id = state.selected;
    const d: Card = id ? comps[id].def : data.overview;
    const color = id ? comps[id].color : ACCENT;
    const actions = id
      ? `<button class="btn primary" type="button" data-act="iso">${state.isolate ? 'Mostra tutti i componenti' : 'Isola il componente'}</button><button class="btn" type="button" data-act="all">Vista d’insieme</button>`
      : '';
    $('info').innerHTML = `<div class="tag"><span class="dot" style="background:${color}"></span>${esc(d.section)}</div><h2>${esc(d.name)}</h2><p>${esc(d.text)}</p>${factsHtml(d.facts)}${d.course ? `<div class="course"><strong>Nel corso</strong>${esc(d.course)}</div>` : ''}<div class="actions">${actions}</div>`;
    el.querySelectorAll<HTMLElement>('.chip').forEach(ch => ch.setAttribute('aria-pressed', String(ch.dataset.id === id)));
  }
  $('info').addEventListener('click', e => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'iso') { state.isolate = !state.isolate; applyHighlight(); renderInfo(); }
    if (act === 'all') select(null);
  });

  function select(id: string | null, { focus = false, scroll = false } = {}) {
    if (id && !comps[id]) id = null;
    state.selected = id;
    if (!id) state.isolate = false;
    applyHighlight(); renderInfo();
    if (focus && id) focusOn(id);
    if (scroll && state.panel) $('info').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  }

  $('chips').innerHTML = data.components.map(c => `<button class="chip" type="button" data-id="${c.id}" aria-pressed="false"><span class="dot" style="background:${comps[c.id].color}"></span>${esc(c.short)}</button>`).join('');
  $('chips').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.chip'); if (!b) return;
    const id = b.dataset.id!;
    select(state.selected === id ? null : id, { focus: true, scroll: true });
  });

  // controlli di sezione
  const segBtns = [...el.querySelectorAll<HTMLButtonElement>('.seg button')];
  const rAlpha = $<HTMLInputElement>('rAlpha'), rCenter = $<HTMLInputElement>('rCenter'), rExtent = $<HTMLInputElement>('rExtent');
  rAlpha.value = String(cut.alpha); rCenter.value = String(cut.center); rExtent.value = String(cut.extent);
  function syncCut() {
    updatePlanes();
    $('oAlpha').textContent = `${cut.alpha}°`;
    $('oCenter').textContent = `${cut.center}°`;
    $('oExtent').textContent = cut.extent >= 100 ? 'tutta la macchina' : `x = ${((X_MIN + (X_MAX - X_MIN) * cut.extent / 100) * (data.section.scale ?? 1)).toFixed(data.section.unit ? 0 : 2).replace('.', ',')} ${data.section.unit ?? 'm'}`;
    segBtns.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === cut.alpha)));
  }
  segBtns.forEach(b => b.addEventListener('click', () => { cut.alpha = Number(b.dataset.preset); rAlpha.value = String(cut.alpha); syncCut(); }));
  rAlpha.addEventListener('input', () => { cut.alpha = Number(rAlpha.value); syncCut(); });
  rCenter.addEventListener('input', () => { cut.center = Number(rCenter.value); syncCut(); });
  rExtent.addEventListener('input', () => { cut.extent = Number(rExtent.value); syncCut(); });
  const checkbox = (ref: string, fn: (on: boolean) => void) => { const i = $<HTMLInputElement>(ref); i.addEventListener('change', () => fn(i.checked)); };
  checkbox('tSpin', on => { state.spin = on; updateRpm(); });
  checkbox('tExplode', on => { state.explode = on; fitView(state.explode); });
  checkbox('tTemp', on => { state.temp = on; applyColors(); });
  checkbox('tCasing', on => { state.casing = on; applyCasing(); });
  if (data.stations.length) checkbox('tStations', on => { state.stations = on; });
  $('resetView').addEventListener('click', () => fitView(state.explode));
  const togglePanel = $('togglePanel');
  togglePanel.addEventListener('click', () => {
    state.panel = !state.panel;
    el.classList.toggle('panel-hidden', !state.panel);
    togglePanel.textContent = state.panel ? 'Nascondi comandi' : 'Mostra comandi';
    togglePanel.setAttribute('aria-expanded', String(state.panel));
  });
  function updateRpm() {
    const label = flowRes ? `nella realtà ${flowRes.rpm.toLocaleString('it-IT')} giri/min` : data.spinLabel;
    $('rpm').innerHTML = state.spin ? `<span class="long">${esc(data.spinNote)} · </span>${esc(label)}` : '';
  }

  /* ---------------- Stazioni del ciclo */
  const stEls = data.stations.map(s => {
    const d = document.createElement('div');
    d.className = s.flip ? 'station rev' : 'station';
    d.innerHTML = `<b>${s.n}</b><span>${esc(s.label)}</span>`;
    $('stations').appendChild(d);
    return d;
  });
  const tmpV = new THREE.Vector3();
  function placeStations() {
    const show = state.stations && ex < 0.05;
    const w = viewer.clientWidth, h = viewer.clientHeight;
    data.stations.forEach((s, i) => {
      const d = stEls[i];
      tmpV.set(s.x, s.y, s.z ?? 0).project(camera);
      const vis = show && tmpV.z < 1 && Math.abs(tmpV.x) < 1.05 && Math.abs(tmpV.y) < 1.05;
      d.style.display = vis ? 'flex' : 'none';
      if (vis) d.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * w}px, ${(-tmpV.y * 0.5 + 0.5) * h - 16}px) translate(${s.flip ? 'calc(-100% + 10px)' : '-10px'}, -100%)`;
    });
  }

  /* ---------------- Camera: inquadratura, focus */
  const VIEW_DIR = new THREE.Vector3();
  const viewDir = () => (camera.aspect < 1 ? VIEW_DIR.set(...(v.dirPortrait ?? [1.15, 0.55, 0.85])).normalize() : VIEW_DIR.set(...(v.dir ?? [0.62, 0.42, 1.0])).normalize());
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
    const [a, b] = exploded ? v.fit.exploded : v.fit.assembled;
    const { pos, target } = fitPose(new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b)));
    if (instant) { camera.position.copy(pos); controls.target.copy(target); controls.update(); } else animateTo(pos, target);
  }
  function focusOn(id: string) {
    const box = new THREE.Box3().setFromObject(comps[id].group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const offset = camera.position.clone().sub(controls.target);
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = THREE.MathUtils.clamp(size * 1.6, v.focusMin ?? 2.2, offset.length());
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
    const hits = ray.intersectObjects(pickables, false).filter(h => {
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
  syncCut(); applyColors(); applyHighlight(); applyCasing(); renderInfo(); updateRpm();

  const clock = new THREE.Clock();
  /* ---------------- Alberi: angoli (rad). Gli alberi con "of" seguono un altro albero con un rapporto */
  const angles: Record<string, number> = {};
  const spoolIds = Object.keys(data.spools);
  spoolIds.forEach(id => { angles[id] = 0; });
  const roots = spoolIds.filter(id => !data.spools[id].of);

  /* ---------------- Simulazione del flusso (compressori) */
  const spoolSpeed = (id: string) =>
    flowDef && flowRes && id === flowDef.spool ? (flowRes.rpm * 2 * Math.PI) / 60 / flowDef.timeScale : data.spools[id].speed ?? 0;
  if (flowDef) {
    const fd = flowDef;
    flowArrows = new FlowArrows(fd);
    scene.add(flowArrows.mesh);
    const rRpm = $<HTMLInputElement>('rRpm'), rMdot = $<HTMLInputElement>('rMdot'), sel = $<HTMLSelectElement>('sFlowColor');
    const num = (v: number, d = 0) => v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
    const legend = () => {
      const mode = flowArrows!.mode, info = COLOR_INFO[mode], st = fd.colors[mode];
      const lo = st[0][0], hi = st[st.length - 1][0];
      const grad = st.map(([vv, c]) => `${c} ${Math.round((vv - lo) / (hi - lo) * 100)}%`).join(', ');
      $('flowLegend').innerHTML = `<div>${esc(info.label)} (${info.unit})</div><div class="bar" style="background: linear-gradient(90deg, ${grad})"></div><div class="ticks">${st.map(([vv]) => `<span>${num(vv)}</span>`).join('')}</div>`;
    };
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
    sel.addEventListener('change', () => { flowArrows!.mode = sel.value as ColorMode; legend(); flowArrows!.update(0); });
    $<HTMLInputElement>('tFlow').addEventListener('change', e => { flowOn = (e.target as HTMLInputElement).checked; $('flowLegend').classList.toggle('on', flowOn); });
    $('flowReset').addEventListener('click', () => { rRpm.value = String(fd.design.rpm); rMdot.value = String(fd.design.mdot); solve(); });
    legend();
    solve();
  }
  function resolveFollowers() {
    for (let pass = 0; pass < spoolIds.length; pass++) for (const id of spoolIds) {
      const sd = data.spools[id];
      if (sd.of) angles[id] = (angles[sd.of] ?? 0) * (sd.ratio ?? 1);
    }
  }

  /* ---------------- Fasi del ciclo (motori alternativi) */
  let lastTheta = -1;
  function updateCycle(force = false) {
    if (!cycle) return;
    const len = cycle.length;
    const theta = ((Math.round((angles[cycle.spool] ?? 0) / Math.PI * 180) % len) + len) % len;
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
      angles[cycle.spool] = Number(r.value) * Math.PI / 180;
      resolveFollowers(); updateCycle(true);
    });
    updateCycle(true);
  }

  let raf = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (state.spin) {
      for (const id of roots) angles[id] = (angles[id] + dt * spoolSpeed(id)) % (Math.PI * 8);
      resolveFollowers();
      updateCycle();
    }
    model.update(angles, state.selected);
    if (flowArrows) {
      flowArrows.mesh.visible = flowOn && ex < 0.05;
      if (state.spin && flowArrows.mesh.visible) flowArrows.update(dt);
    }
    const target = state.explode ? 1 : 0;
    ex += (target - ex) * Math.min(1, dt * (reduced ? 60 : 3.5));
    Object.values(comps).forEach(c => { c.group.position.copy(c.explode).multiplyScalar(ex); c.parts.forEach(p => p.obj.position.copy(p.dir).multiplyScalar(ex)); });
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
