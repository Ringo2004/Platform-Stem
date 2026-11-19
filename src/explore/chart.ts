import type { CurveRow, OpResult } from './pump';
import { esc } from '../util';

/*
 * Diagrammi dell'impianto (SVG): prevalenza (curva del gruppo di pompe e curva dell'impianto con il punto di
 * funzionamento), rendimento, potenza assorbita e NPSH. Tutti condividono la scala delle portate, così il
 * cursore che segue il puntatore li attraversa insieme. Un asse verticale per grafico (niente doppi assi).
 */

// colori delle serie (palette validata per il tema scuro): la pompa è arancio, l'impianto è blu
export const SERIES = { pump: '#d95926', plant: '#3987e5', eta: '#199e70', critical: '#d03b3b', good: '#0ca30c' };

const W = 340, PL = 38, PR = 12, PT = 18, PB = 28;
const PW = W - PL - PR;
const num = (v: number, d = 0) => v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^(-?\d)(\d{3})(?=,|$)/, '$1.$2');

function niceStep(range: number, target = 5) {
  const raw = range / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
export function niceMax(v: number, target = 5) { const s = niceStep(v, target); return Math.ceil(v / s - 1e-9) * s; }

interface Axes { xMax: number; yMax: number; yMin: number; H: number }
const sx = (a: Axes, q: number) => PL + (q / a.xMax) * PW;
const sy = (a: Axes, y: number) => PT + (1 - (y - a.yMin) / (a.yMax - a.yMin)) * (a.H - PT - PB);

let clipSeq = 0;
/** area del grafico: le curve che escono dal campo vengono tagliate */
function clipOpen(a: Axes) {
  const id = `pc${++clipSeq}`;
  return `<clipPath id="${id}"><rect x="${PL}" y="${PT}" width="${PW}" height="${a.H - PT - PB}"/></clipPath><g clip-path="url(#${id})">`;
}

function frame(a: Axes, yLabel: string, xLabel = 'Q (L/s)') {
  const xs = niceStep(a.xMax), ys = niceStep(a.yMax - a.yMin, 4);
  let g = '';
  for (let v = 0; v <= a.xMax + 1e-9; v += xs) {
    const X = sx(a, v).toFixed(1);
    g += `<line class="gl" x1="${X}" x2="${X}" y1="${PT}" y2="${a.H - PB}"/><text class="tk" x="${X}" y="${a.H - PB + 13}" text-anchor="middle">${num(v)}</text>`;
  }
  for (let v = a.yMin; v <= a.yMax + 1e-9; v += ys) {
    const Y = sy(a, v).toFixed(1);
    g += `<line class="gl" x1="${PL}" x2="${W - PR}" y1="${Y}" y2="${Y}"/><text class="tk" x="${PL - 5}" y="${(+Y + 3.5).toFixed(1)}" text-anchor="end">${num(v, ys < 1 ? 1 : 0)}</text>`;
  }
  g += `<line class="ax" x1="${PL}" x2="${W - PR}" y1="${a.H - PB}" y2="${a.H - PB}"/><line class="ax" x1="${PL}" x2="${PL}" y1="${PT}" y2="${a.H - PB}"/>`;
  g += `<text class="al" x="${W - PR}" y="${a.H - 3}" text-anchor="end">${esc(xLabel)}</text><text class="al" x="${PL - 5}" y="${PT - 7}" text-anchor="end">${esc(yLabel)}</text>`;
  return g;
}

function line(a: Axes, rows: CurveRow[], key: keyof CurveRow, cls: string, color: string, xKey: keyof CurveRow = 'Q') {
  let d = '', pen = false;
  for (const r of rows) {
    const y = r[key] as number, x = r[xKey] as number;
    if (!isFinite(y) || y < a.yMin - (a.yMax - a.yMin) * 0.5 || y > a.yMax * 1.5) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${sx(a, x * 1000).toFixed(1)} ${sy(a, Math.min(Math.max(y, a.yMin - 1e3), a.yMax * 1.5)).toFixed(1)}`;
    pen = true;
  }
  return d ? `<path class="${cls}" d="${d}" style="stroke:${color}"/>` : '';
}

/** zone di portata in cui vale cond, come rettangoli */
function bands(a: Axes, rows: CurveRow[], cond: (r: CurveRow) => boolean, fill: string, label: string) {
  let out = '', start: number | null = null;
  const close = (end: number) => {
    if (start === null) return;
    const x0 = sx(a, start * 1000), x1 = sx(a, end * 1000);
    if (x1 - x0 > 1) {
      out += `<rect x="${x0.toFixed(1)}" y="${PT}" width="${(x1 - x0).toFixed(1)}" height="${a.H - PT - PB}" fill="${fill}" fill-opacity="0.13"/>`;
      if (label && x1 - x0 > 46) out += `<text class="bl" x="${((x0 + x1) / 2).toFixed(1)}" y="${PT + 11}" text-anchor="middle">${esc(label)}</text>`;
    }
    start = null;
  };
  rows.forEach(r => { if (cond(r)) { if (start === null) start = r.Q; } else close(r.Q); });
  close(rows[rows.length - 1].Q);
  return out;
}

function point(a: Axes, q: number, y: number, hollow = false) {
  const X = sx(a, q * 1000), Y = sy(a, y);
  return `<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="5" class="${hollow ? 'opt hollow' : 'opt'}"/>`;
}

export interface ChartInfo { N: number; series: boolean; label: string; Qbep: number; por: [number, number]; throttled: boolean }

export function chartsHtml(rows: CurveRow[], op: OpResult, info: ChartInfo) {
  const xMax = rows[rows.length - 1].Q * 1000;
  const finite = (k: keyof CurveRow) => rows.map(r => r[k] as number).filter(v => isFinite(v));
  const hMax = niceMax(Math.max(...finite('group'), ...finite('single'), rows[0].plant + 2, op.H) * 1.08, 5);
  const A: Axes = { xMax, yMax: hMax, yMin: 0, H: 230 };
  const cav = (r: CurveRow) => isFinite(r.npsh3) && r.npsha < r.npsh3;
  const porLo = info.Qbep * info.por[0] * (info.series ? 1 : info.N), porHi = info.Qbep * info.por[1] * (info.series ? 1 : info.N);
  const por = (r: CurveRow) => r.Q >= porLo && r.Q <= porHi;

  // differenza tra curva con e senza cavitazione: la curva "teorica" si disegna solo dove serve
  const nomRows = rows.map(r => ({ ...r, groupNom: Math.abs(r.groupNom - r.group) > 0.01 * r.groupNom ? r.groupNom : NaN }));
  const opQ = op.Q, Hlabel = `Q = ${num(op.Q * 1000)} L/s · H = ${num(op.H, 1)} m`;
  const Xop = sx(A, opQ * 1000), Yop = sy(A, op.H);
  const lblRight = Xop < PL + PW * 0.55;
  let hSvg = frame(A, 'H (m)') + clipOpen(A);
  hSvg += bands(A, rows, cav, SERIES.critical, 'cavitazione');
  hSvg += line(A, rows, 'plant', 'cv', SERIES.plant);
  if (info.throttled) hSvg += line(A, rows, 'throttled', 'cv dash', SERIES.plant);
  if (info.N > 1) hSvg += line(A, rows, 'single', 'cv dash thin', SERIES.pump);
  hSvg += line(A, nomRows, 'groupNom', 'cv dot thin', SERIES.pump);
  hSvg += line(A, rows, 'group', 'cv', SERIES.pump) + '</g>';
  hSvg += `<text class="dl" x="${(PL + 4).toFixed(1)}" y="${(sy(A, rows[0].plant) + 14).toFixed(1)}">H_g = ${num(rows[0].plant, 1)} m</text>`;
  if (!op.noFlow) {
    hSvg += `<line class="guide" x1="${Xop.toFixed(1)}" x2="${Xop.toFixed(1)}" y1="${Yop.toFixed(1)}" y2="${A.H - PB}"/><line class="guide" x1="${PL}" x2="${Xop.toFixed(1)}" y1="${Yop.toFixed(1)}" y2="${Yop.toFixed(1)}"/>`;
    if (info.throttled && op.Qfree > opQ) {
      // punto di funzionamento che si avrebbe a valvola tutta aperta
      const rf = rows.reduce((b, r) => (Math.abs(r.Q - op.Qfree) < Math.abs(b.Q - op.Qfree) ? r : b));
      hSvg += point(A, op.Qfree, rf.plant, true);
    }
    hSvg += point(A, opQ, op.H);
    hSvg += `<text class="dl strong" x="${(Xop + (lblRight ? 9 : -9)).toFixed(1)}" y="${(Yop - 9).toFixed(1)}" text-anchor="${lblRight ? 'start' : 'end'}">${esc(Hlabel)}</text>`;
  }
  const legend = [
    `<span><i class="sw" style="background:${SERIES.pump}"></i>${info.N > 1 ? `${info.N} pompe in ${info.series ? 'serie' : 'parallelo'}` : 'Pompa'}</span>`,
    info.N > 1 ? `<span><i class="sw dash" style="--c:${SERIES.pump}"></i>Una pompa</span>` : '',
    `<span><i class="sw" style="background:${SERIES.plant}"></i>Impianto</span>`,
    info.throttled ? `<span><i class="sw dash" style="--c:${SERIES.plant}"></i>Impianto con valvola strozzata</span>` : '',
    `<span><i class="pt"></i>Punto di funzionamento</span>`,
    rows.some(cav) ? `<span><i class="sw band" style="background:${SERIES.critical}"></i>Zona di cavitazione</span>` : ''
  ].join('');

  const small = (key: 'eta' | 'P', title: string, unit: string, color: string, scale: number, yMaxIn?: number) => {
    const vals = finite(key).map(v => v * scale);
    const a: Axes = { xMax, yMax: yMaxIn ?? niceMax(Math.max(...vals, 1) * 1.1, 4), yMin: 0, H: 122 };
    const rs = rows.map(r => ({ ...r, [key]: (r[key] as number) * scale }));
    let g = frame(a, unit) + clipOpen(a);
    if (key === 'eta') g += bands(a, rows, por, SERIES.good, 'zona consigliata');
    g += bands(a, rows, cav, SERIES.critical, '');
    g += line(a, rs, key, 'cv', color) + '</g>';
    if (!op.noFlow) {
      const v = key === 'eta' ? op.eta * 100 : op.P / 1000;
      g += `<line class="guide" x1="${sx(a, opQ * 1000).toFixed(1)}" x2="${sx(a, opQ * 1000).toFixed(1)}" y1="${PT}" y2="${a.H - PB}"/>` + point(a, opQ, v);
    }
    return `<figure class="pchart"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${a.H}" role="img" aria-label="${esc(title)}" data-h="${a.H}">${g}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${a.H - PB}" visibility="hidden"/></svg></figure>`;
  };

  // NPSH
  // scala: quanto basta per vedere NPSH disponibile e richiesto attorno al punto di funzionamento
  const nTop = Math.max(rows[0].npsha, op.npshi, op.npsh3, 4) * 1.5;
  const nA: Axes = { xMax, yMax: niceMax(Math.min(nTop, 40), 4), yMin: Math.min(0, Math.floor(Math.min(...finite('npsha')) / 5) * 5), H: 150 };
  let nSvg = frame(nA, 'NPSH (m)') + clipOpen(nA);
  nSvg += bands(nA, rows, cav, SERIES.critical, 'cavitazione');
  nSvg += line(nA, rows, 'npsha', 'cv', SERIES.plant);
  nSvg += line(nA, rows, 'npshi', 'cv dash thin', SERIES.pump);
  nSvg += line(nA, rows, 'npsh3', 'cv', SERIES.pump) + '</g>';
  if (!op.noFlow) nSvg += `<line class="guide" x1="${sx(nA, opQ * 1000).toFixed(1)}" x2="${sx(nA, opQ * 1000).toFixed(1)}" y1="${PT}" y2="${nA.H - PB}"/>` + point(nA, opQ, Math.max(nA.yMin, Math.min(op.npsha, nA.yMax)));
  const nLegend = `<span><i class="sw" style="background:${SERIES.plant}"></i>NPSH disponibile (impianto)</span><span><i class="sw" style="background:${SERIES.pump}"></i>NPSH richiesto (3 %)</span><span><i class="sw dash" style="--c:${SERIES.pump}"></i>Inizio cavitazione</span>`;

  // tabella dei valori (accessibilità e lettura precisa)
  const step = Math.max(1, Math.round(rows.length / 12));
  const tRows = rows.filter((_, i) => i % step === 0).map(r => `<tr><td>${num(r.Q * 1000)}</td><td>${isFinite(r.group) ? num(r.group, 1) : '—'}</td><td>${num(r.plant, 1)}</td><td>${isFinite(r.eta) ? num(r.eta * 100) : '—'}</td><td>${isFinite(r.P) ? num(r.P / 1000, 1) : '—'}</td><td>${num(r.npsha, 1)}</td><td>${isFinite(r.npsh3) ? num(r.npsh3, 1) : '—'}</td></tr>`).join('');

  return `
    <figure class="pchart main"><figcaption>Curva della macchina e curva dell’impianto</figcaption>
      <div class="plegend">${legend}</div>
      <svg viewBox="0 0 ${W} ${A.H}" role="img" aria-label="Prevalenza in funzione della portata: curva delle pompe, curva dell'impianto e punto di funzionamento">${hSvg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${A.H - PB}" visibility="hidden"/></svg>
    </figure>
    ${small('eta', 'Rendimento della pompa', 'η (%)', SERIES.eta, 100, 100)}
    ${small('P', 'Potenza assorbita dal gruppo', 'P (kW)', SERIES.pump, 0.001)}
    <figure class="pchart"><figcaption>NPSH e cavitazione (${info.series ? 'prima pompa' : 'ogni pompa'})</figcaption>
      <div class="plegend">${nLegend}</div>
      <svg viewBox="0 0 ${W} ${nA.H}" role="img" aria-label="NPSH disponibile e richiesto in funzione della portata">${nSvg}<line class="xh" x1="0" x2="0" y1="${PT}" y2="${nA.H - PB}" visibility="hidden"/></svg>
    </figure>
    <div class="ptip" hidden></div>
    <details class="ptable"><summary>Tabella dei valori</summary>
      <table><thead><tr><th>Q (L/s)</th><th>H pompe (m)</th><th>H impianto (m)</th><th>η (%)</th><th>P (kW)</th><th>NPSHa (m)</th><th>NPSH3 (m)</th></tr></thead><tbody>${tRows}</tbody></table>
    </details>`;
}

/** cursore che segue il puntatore su tutti i diagrammi */
export function attachHover(host: HTMLElement, getRows: () => CurveRow[]) {
  const tip = () => host.querySelector<HTMLElement>('.ptip');
  const hide = () => { host.querySelectorAll('.xh').forEach(l => l.setAttribute('visibility', 'hidden')); const t = tip(); if (t) t.hidden = true; };
  host.addEventListener('pointerleave', hide);
  host.addEventListener('pointermove', e => {
    const svg = (e.target as Element).closest?.('svg');
    const rows = getRows();
    if (!svg || !rows.length || !host.contains(svg)) { hide(); return; }
    const r = svg.getBoundingClientRect();
    const xv = ((e.clientX - r.left) / r.width) * W;
    if (xv < PL || xv > W - PR) { hide(); return; }
    const Q = ((xv - PL) / PW) * rows[rows.length - 1].Q;
    const row = rows.reduce((b, q) => (Math.abs(q.Q - Q) < Math.abs(b.Q - Q) ? q : b));
    const X = (PL + (row.Q / rows[rows.length - 1].Q) * PW).toFixed(1);
    host.querySelectorAll('.xh').forEach(l => { l.setAttribute('x1', X); l.setAttribute('x2', X); l.setAttribute('visibility', 'visible'); });
    const t = tip(); if (!t) return;
    const v = (x: number, d = 1, u = 'm') => (isFinite(x) ? `${num(x, d)} ${u}` : '—');
    t.innerHTML = `<b>Q = ${num(row.Q * 1000)} L/s</b>
      <span><i class="sw" style="background:${SERIES.pump}"></i>H pompe ${v(row.group)}</span>
      <span><i class="sw" style="background:${SERIES.plant}"></i>H impianto ${v(row.plant)}</span>
      <span><i class="sw" style="background:${SERIES.eta}"></i>η ${v(row.eta * 100, 0, '%')}</span>
      <span><i class="sw" style="background:${SERIES.pump}"></i>P ${v(row.P / 1000, 1, 'kW')}</span>
      <span><i class="sw" style="background:${SERIES.plant}"></i>NPSHa ${v(row.npsha)} · <i class="sw" style="background:${SERIES.pump}"></i>NPSH3 ${v(row.npsh3)}</span>`;
    t.hidden = false;
    const hr = host.getBoundingClientRect();
    const left = Math.min(e.clientX - hr.left + 14, hr.width - 190);
    t.style.left = `${Math.max(0, left)}px`;
    t.style.top = `${e.clientY - hr.top + 14}px`;
  });
}
