import './style.css';
import Chart from 'chart.js/auto';
import { SankeyController, Flow } from 'chartjs-chart-sankey';
import {
  DEFAULT_INIT, DEFAULT_POLICY, EVENT_DEFS, GOODS, GOOD_DEFS, JOBS, JOB_DEFS, RETAIL_GOODS,
  type EventKind, type Good, type InitConfig, type Job, type Policy,
} from './sim/config';
import type { AgentRow, DayStats, MapState, NewsItem, Snapshot } from './sim/sim';
import type { BranchInfo, FromWorker, Mark, ToWorker } from './worker';
import { IslandMap, RICHNESS_COLORS } from './ui/map';

/**
 * Repères verticaux sur les graphiques temporels : changements de politique, événements, début de
 * branche, et curseur quand on regarde le passé.
 */
const marksPlugin = {
  id: 'marks',
  afterDatasetsDraw(chart: Chart) {
    const o = (chart.options.plugins as any)?.marks;
    if (!o?.enabled) return;
    const x = chart.scales.x;
    const area = chart.chartArea;
    if (!x || !area) return;
    const g = chart.ctx;
    g.save();
    for (const mk of marks) {
      const px = x.getPixelForValue(mk.day / 360);
      if (px < area.left || px > area.right) continue;
      g.strokeStyle = mk.kind === 'evenement' ? 'rgba(220,38,38,.55)' : mk.kind === 'branche' ? 'rgba(224,122,47,.7)' : 'rgba(31,111,139,.5)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, area.top);
      g.lineTo(px, area.bottom);
      g.stroke();
    }
    if (viewDay !== null) {
      const px = x.getPixelForValue(viewDay / 360);
      g.setLineDash([]);
      g.strokeStyle = 'rgba(214,158,46,.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, area.top);
      g.lineTo(px, area.bottom);
      g.stroke();
    }
    g.restore();
  },
};
Chart.register(SankeyController, Flow, marksPlugin);

// ---------------------------------------------------------------------------- état de l'application

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

/** Historique de la branche courante (complet) et vue affichée (tronquée si on regarde le passé). */
let fullHistory: DayStats[] = [];
let history: DayStats[] = [];
let snap: Snapshot | null = null;
let liveSnap: Snapshot | null = null;
let liveMap: MapState | null = null;
let marks: Mark[] = [];
let branches: BranchInfo[] = [];
let currentBranch = 1;
let snapDays: number[] = [0];
let viewDay: number | null = null;
let compare: { name: string; color: string; rows: DayStats[] } | null = null;
let islandMap: IslandMap | null = null;
let policy: Policy = { ...DEFAULT_POLICY };
let init: InitConfig = { ...DEFAULT_INIT };
let running = false;
let currentTab = 'apercu';
let dirty = true;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`ile:${k}`);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`ile:${k}`, JSON.stringify(v));
    } catch {
      /* stockage indisponible */
    }
  },
};
policy = { ...DEFAULT_POLICY, ...store.get<Partial<Policy>>('policy', {}) };
init = { ...DEFAULT_INIT, ...store.get<Partial<InitConfig>>('init', {}) };

// ---------------------------------------------------------------------------- formatage

const nf = (d: number) => new Intl.NumberFormat('fr-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (x: number, d = 0) => (Number.isFinite(x) ? nf(d).format(x) : '—');
const pct = (x: number, d = 0) => `${fmt(x * 100, d)} %`;
const ecu = (x: number, d = 0) => `${fmt(x, d)} é`;
const dateLabel = (day: number) => `An ${Math.floor(day / 360) + 1}, jour ${(day % 360) + 1}`;
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const REV_LABELS: Record<string, string> = {
  tva: 'TVA', impotRevenu: 'Impôt sur le revenu', impotSocietes: 'Impôt sur les sociétés', impotFortune: 'Impôt sur la fortune',
  succession: 'Successions', loyers: 'Taxe sur les locaux', cotisationsSante: 'Cotisations santé', dividendes: 'Dividendes (parts publiques)',
};
const SPEND_LABELS: Record<string, string> = {
  salaires: 'Salaires (enseignants)', pensions: 'Pensions', aideSociale: 'Aide sociale', revenuUniversel: 'Revenu universel',
  remboursementsSante: 'Remboursements de soins', subsidesPrimes: 'Subsides aux primes', redistribution: 'Reversement de l’excédent',
};
const REV_COLORS = ['#1f6f8b', '#e07a2f', '#805ad5', '#d53f8c', '#718096', '#b7791f', '#e53e3e', '#38a169'];
const SPEND_COLORS = ['#319795', '#dd6b20', '#c53030', '#6b46c1', '#e53e3e', '#3182ce', '#a0aec0'];
const STATUS_LABEL: Record<string, string> = { enfant: 'Enfant', actif: 'Actif', chomeur: 'Sans emploi', retraite: 'Retraité' };
const FLOW_LABEL: Record<string, string> = {
  'menages>': 'Ménages (dépenses)', '>menages': 'Ménages (revenus)', 'etat>': 'État (dépenses)', '>etat': 'État (recettes)',
  production: 'Producteurs', transformation: 'Transformateurs', commerce: 'Commerçants', sante: 'Médecins', assurance: 'Assureurs santé',
};

// ---------------------------------------------------------------------------- séries

/** Indices échantillonnés pour ne pas dessiner plus de `max` points. */
function sampleIdx(n: number, max = 700): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.floor(i * step));
  out.push(n - 1);
  return out;
}

/** Série {x: années, y} à partir de l'historique, avec moyenne glissante optionnelle. */
function series(f: (r: DayStats) => number, smooth = 1): { x: number; y: number }[] {
  const n = history.length;
  const raw = smooth > 1 ? new Float64Array(n) : null;
  if (raw) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += f(history[i]);
      if (i >= smooth) acc -= f(history[i - smooth]);
      raw[i] = acc / Math.min(i + 1, smooth);
    }
  }
  return sampleIdx(n).map((i) => ({ x: history[i].day / 360, y: raw ? raw[i] : f(history[i]) }));
}

/** Agrégation par mois (somme ou moyenne). */
function monthly(f: (r: DayStats) => number, mode: 'sum' | 'avg' = 'sum'): { labels: string[]; values: number[] } {
  const labels: string[] = [];
  const values: number[] = [];
  for (let start = 1; start < history.length; start += 30) {
    const chunk = history.slice(start, start + 30);
    if (!chunk.length) break;
    const s = chunk.reduce((a, r) => a + f(r), 0);
    labels.push(`${Math.floor(chunk[0].day / 360) + 1}.${Math.floor((chunk[0].day % 360) / 30) + 1}`);
    values.push(mode === 'sum' ? s : s / chunk.length);
  }
  const keep = 48; // quatre dernières années
  return { labels: labels.slice(-keep), values: values.slice(-keep) };
}

// ---------------------------------------------------------------------------- graphiques

interface ChartDef {
  tab: string;
  title: string;
  desc?: string;
  wide?: boolean;
  tall?: boolean;
  tools?: (el: HTMLElement, redraw: () => void) => void;
  build: (ctx: HTMLCanvasElement) => Chart;
  update: (c: Chart) => void;
  chart?: Chart;
}

function baseOptions(extra: Record<string, unknown> = {}): any {
  const grid = css('--grid');
  const text = css('--muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { labels: { color: text, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
      tooltip: { callbacks: {} },
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'années', color: text }, ticks: { color: text }, grid: { color: grid } },
      y: { ticks: { color: text }, grid: { color: grid } },
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0.15 } },
    ...extra,
  };
}

function lineChart(ctx: HTMLCanvasElement, datasets: { label: string; color: string; fill?: boolean; axis?: string; dash?: boolean }[], opts: { yTitle?: string; y2Title?: string; percent?: boolean; stacked?: boolean; log?: boolean; y2percent?: boolean } = {}): Chart {
  const o = baseOptions();
  o.plugins.marks = { enabled: true };
  o.scales.y.title = { display: !!opts.yTitle, text: opts.yTitle, color: css('--muted') };
  if (opts.log) o.scales.y.type = 'logarithmic';
  if (opts.percent) o.scales.y.ticks.callback = (v: number) => `${Math.round(v * 100)} %`;
  if (opts.stacked) {
    o.scales.y.stacked = true;
    o.scales.y.beginAtZero = true;
  }
  if (opts.y2Title) {
    o.scales.y2 = { position: 'right', title: { display: true, text: opts.y2Title, color: css('--muted') }, ticks: { color: css('--muted') }, grid: { drawOnChartArea: false } };
    if (opts.y2percent) o.scales.y2.ticks.callback = (v: number) => `${Math.round(v * 100)} %`;
  }
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: datasets.map((d) => ({
        label: d.label, data: [], borderColor: d.color, backgroundColor: d.fill ? d.color + '99' : d.color,
        fill: d.fill ? (opts.stacked ? 'stack' : 'origin') : false, yAxisID: d.axis ?? 'y', borderDash: d.dash ? [5, 4] : undefined,
      })),
    },
    options: o,
  });
}

function barChart(ctx: HTMLCanvasElement, datasets: { label: string; color: string }[], opts: { stacked?: boolean; horizontal?: boolean; yTitle?: string } = {}): Chart {
  const o = baseOptions({ parsing: true, interaction: { mode: 'index', intersect: false } });
  o.scales.x = { type: 'category', stacked: opts.stacked, ticks: { color: css('--muted'), maxRotation: 0, autoSkip: true }, grid: { display: false } };
  o.scales.y.stacked = opts.stacked;
  o.scales.y.title = { display: !!opts.yTitle, text: opts.yTitle, color: css('--muted') };
  if (opts.horizontal) {
    o.indexAxis = 'y';
    [o.scales.x, o.scales.y] = [{ ...o.scales.y, stacked: opts.stacked }, { ...o.scales.x, ticks: { color: css('--muted'), autoSkip: false } }];
  }
  return new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: datasets.map((d) => ({ label: d.label, data: [], backgroundColor: d.color, borderWidth: 0 })) },
    options: o,
  });
}

let priceMode: 'retail' | 'wholesale' = 'retail';
let priceLog = true;
let goodsSel: Set<Good> = new Set(RETAIL_GOODS);

const charts: ChartDef[] = [
  // ------------------------------------------------------------------ aperçu
  {
    tab: 'apercu', title: 'Population et faim', desc: 'Habitants (gauche) et part des habitants nourris à moins de 90 % de leur besoin (droite).',
    build: (c) => lineChart(c, [
      { label: 'Population', color: css('--accent') },
      { label: 'Enfants', color: '#a0aec0', dash: true },
      { label: 'Faim (%)', color: css('--bad'), axis: 'y2' },
    ], { yTitle: 'habitants', y2Title: 'faim', y2percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.population);
      c.data.datasets[1].data = series((r) => r.enfants);
      c.data.datasets[2].data = series((r) => r.hungerRate, 10);
    },
  },
  {
    tab: 'apercu', title: 'Activité et prix', desc: 'Ventes au détail par jour, moyenne sur 30 jours (gauche) ; indice des prix à la consommation, base 100 au jour 1 (droite).',
    build: (c) => lineChart(c, [
      { label: 'Ventes au détail (é/jour)', color: css('--accent') },
      { label: 'IPC', color: css('--accent-2'), axis: 'y2' },
    ], { yTitle: 'écus / jour', y2Title: 'IPC' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.gdp, 30);
      c.data.datasets[1].data = series((r) => r.cpi, 7);
    },
  },
  {
    tab: 'apercu', title: 'Inégalités', desc: 'Coefficients de Gini des adultes : 0 = égalité parfaite, 1 = une personne a tout.',
    build: (c) => lineChart(c, [
      { label: 'Gini du patrimoine', color: '#805ad5' },
      { label: 'Gini des revenus', color: '#d69e2e' },
    ]),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.giniWealth);
      c.data.datasets[1].data = series((r) => r.giniIncome);
    },
  },
  {
    tab: 'apercu', title: 'Où est l’argent ?', desc: 'Répartition de la masse monétaire (fixe) entre ménages, entreprises et État.',
    build: (c) => lineChart(c, [
      { label: 'Ménages', color: '#3182ce', fill: true },
      { label: 'Entreprises', color: '#dd6b20', fill: true },
      { label: 'État', color: '#38a169', fill: true },
    ], { stacked: true, yTitle: 'écus' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.moneyHouseholds);
      c.data.datasets[1].data = series((r) => r.moneyBusinesses);
      c.data.datasets[2].data = series((r) => r.treasury);
    },
  },
  {
    tab: 'apercu', wide: true, tall: true, title: 'Circulation de l’argent (mois écoulé)',
    desc: 'Flux monétaires entre groupes. Les ménages et l’État apparaissent deux fois (ce qu’ils dépensent à gauche, ce qu’ils reçoivent à droite). Les échanges entre producteurs et transformateurs sont comptés en net.',
    build: (c) => new Chart(c, {
      type: 'sankey' as any,
      data: { datasets: [{ data: [], colorFrom: (x: any) => nodeColor(x.dataset.data[x.dataIndex]?.from), colorTo: (x: any) => nodeColor(x.dataset.data[x.dataIndex]?.to), colorMode: 'gradient', labels: {}, size: 'max', font: { size: 12 }, color: css('--text') } as any] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x: any) => `${x.raw.from} → ${x.raw.to} : ${ecu(x.raw.flow)}` } } } } as any,
    }),
    update: (c) => {
      if (!snap) return;
      const ds = c.data.datasets[0] as any;
      ds.data = snap.flows.map((f) => ({
        from: f.from === 'menages' || f.from === 'etat' ? FLOW_LABEL[`${f.from}>`] : FLOW_LABEL[f.from],
        to: f.to === 'menages' || f.to === 'etat' ? FLOW_LABEL[`>${f.to}`] : FLOW_LABEL[f.to],
        flow: Math.round(f.value),
      }));
      ds.color = css('--text');
    },
  },
  // ------------------------------------------------------------------ inégalités
  {
    tab: 'inegalites', title: 'Courbe de Lorenz', desc: 'Part cumulée du patrimoine (ou du revenu) détenue par la part cumulée des adultes, du plus pauvre au plus riche. La diagonale = égalité parfaite.',
    build: (c) => {
      const ch = lineChart(c, [
        { label: 'Égalité', color: '#a0aec0', dash: true },
        { label: 'Patrimoine', color: '#805ad5' },
        { label: 'Revenu', color: '#d69e2e' },
      ], { percent: true });
      const o = ch.options as any;
      o.scales.x.title.text = 'part de la population';
      o.plugins.marks.enabled = false;
      (ch as any).$noCompare = true;
      o.scales.x.max = 1;
      o.scales.x.ticks.callback = (v: number) => `${Math.round(v * 100)} %`;
      o.elements.line.tension = 0;
      return ch;
    },
    update: (c) => {
      if (!snap) return;
      c.data.datasets[0].data = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      c.data.datasets[1].data = snap.lorenzWealth.map(([x, y]) => ({ x, y }));
      c.data.datasets[2].data = snap.lorenzIncome.map(([x, y]) => ({ x, y }));
    },
  },
  {
    tab: 'inegalites', title: 'Distribution du patrimoine', desc: 'Nombre d’adultes par tranche de patrimoine (argent + parts d’entreprises), en écus.',
    build: (c) => barChart(c, [{ label: 'Adultes', color: '#805ad5' }]),
    update: (c) => {
      if (!snap) return;
      c.data.labels = snap.wealthHist.map((h) => h.label);
      c.data.datasets[0].data = snap.wealthHist.map((h) => h.count);
    },
  },
  {
    tab: 'inegalites', title: 'Concentration', desc: 'Part du patrimoine total détenue par les 10 % les plus riches et par la moitié la plus pauvre.',
    build: (c) => lineChart(c, [
      { label: '10 % les plus riches', color: css('--bad') },
      { label: '50 % les plus pauvres', color: css('--good') },
    ], { percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.top10Wealth);
      c.data.datasets[1].data = series((r) => r.bottom50Wealth);
    },
  },
  {
    tab: 'inegalites', title: 'Écart des revenus', desc: 'Revenu d’un actif du 90e centile divisé par celui du 10e centile : « les riches gagnent N fois plus que les pauvres ».',
    build: (c) => lineChart(c, [{ label: 'P90 / P10', color: '#d69e2e' }], { yTitle: 'rapport' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.p90p10 ?? NaN, 30);
    },
  },
  {
    tab: 'inegalites', title: 'Patrimoine moyen par métier', desc: 'Écus, actifs uniquement.',
    build: (c) => barChart(c, [{ label: 'Patrimoine moyen', color: '#805ad5' }], { horizontal: true }),
    update: (c) => {
      if (!snap) return;
      const rows = snap.jobs.filter((j) => j.workers > 0).sort((a, b) => b.avgWealth - a.avgWealth);
      c.data.labels = rows.map((j) => j.label);
      c.data.datasets[0].data = rows.map((j) => Math.round(j.avgWealth));
      (c.data.datasets[0] as any).backgroundColor = rows.map((j) => JOB_DEFS[j.job].color);
    },
  },
  // ------------------------------------------------------------------ marchés
  {
    tab: 'marches', wide: true, tall: true, title: 'Prix',
    desc: 'Prix d’équilibre des enchères quotidiennes (moyenne sur 7 jours). Au détail : prix TTC payé par les ménages. En gros : entre producteurs, transformateurs et commerçants.',
    tools: (el, redraw) => {
      el.innerHTML = `<select id="priceMode"><option value="retail">Détail</option><option value="wholesale">Gros</option></select>
        <label><input type="checkbox" id="priceLog" ${priceLog ? 'checked' : ''}/> échelle log</label>
        <span id="goodChecks"></span>`;
      const gc = el.querySelector('#goodChecks')!;
      const renderChecks = () => {
        const list = priceMode === 'retail' ? RETAIL_GOODS : GOODS;
        gc.innerHTML = list.map((g) => `<label style="color:${GOOD_DEFS[g].color}"><input type="checkbox" data-g="${g}" ${goodsSel.has(g) ? 'checked' : ''}/> ${GOOD_DEFS[g].label}</label>`).join(' ');
        gc.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => {
          const g = (i as HTMLInputElement).dataset.g as Good;
          if ((i as HTMLInputElement).checked) goodsSel.add(g);
          else goodsSel.delete(g);
          redraw();
        }));
      };
      renderChecks();
      (el.querySelector('#priceMode') as HTMLSelectElement).addEventListener('change', (e) => {
        priceMode = (e.target as HTMLSelectElement).value as 'retail' | 'wholesale';
        goodsSel = new Set(priceMode === 'retail' ? RETAIL_GOODS : GOODS);
        renderChecks();
        redraw();
      });
      (el.querySelector('#priceLog') as HTMLInputElement).addEventListener('change', (e) => {
        priceLog = (e.target as HTMLInputElement).checked;
        redraw();
      });
    },
    build: (c) => lineChart(c, GOODS.map((g) => ({ label: GOOD_DEFS[g].label, color: GOOD_DEFS[g].color })), { yTitle: 'écus / unité', log: true }),
    update: (c) => {
      (c.options as any).scales.y.type = priceLog ? 'logarithmic' : 'linear';
      GOODS.forEach((g, i) => {
        const ds = c.data.datasets[i];
        const show = goodsSel.has(g) && (priceMode === 'wholesale' || GOOD_DEFS[g].retail);
        ds.hidden = !show;
        ds.data = show ? series((r) => (priceMode === 'retail' ? r.retailPrice[g] : r.wholesalePrice[g]) ?? NaN, 7) : [];
      });
    },
  },
  {
    tab: 'marches', title: 'Volumes vendus au détail', desc: 'Unités par jour (moyenne sur 30 jours).',
    build: (c) => lineChart(c, RETAIL_GOODS.map((g) => ({ label: GOOD_DEFS[g].label, color: GOOD_DEFS[g].color }))),
    update: (c) => RETAIL_GOODS.forEach((g, i) => (c.data.datasets[i].data = series((r) => r.retailVolume[g] ?? 0, 30))),
  },
  {
    tab: 'marches', title: 'Pénuries et gaspillage', desc: 'Demande des ménages restée sans vendeur, et produits jetés car périmés (unités nutritives par jour, moyenne 30 jours).',
    build: (c) => lineChart(c, [
      { label: 'Demande non servie', color: css('--bad') },
      { label: 'Gaspillage', color: css('--warn') },
    ], { yTitle: 'unités nutritives / jour' }),
    update: (c) => {
      const nut = (rec: Partial<Record<Good, number>>) => GOODS.reduce((s, g) => s + (rec[g] ?? 0) * GOOD_DEFS[g].nutrition, 0);
      c.data.datasets[0].data = series((r) => nut(r.unmetDemand), 30);
      c.data.datasets[1].data = series((r) => nut(r.waste), 30);
    },
  },
  // ------------------------------------------------------------------ emploi
  {
    tab: 'emploi', wide: true, title: 'Actifs par métier', desc: 'Les habitants changent de métier quand un autre rapporte nettement plus.',
    build: (c) => lineChart(c, JOBS.map((j) => ({ label: JOB_DEFS[j].label, color: JOB_DEFS[j].color, fill: true })), { stacked: true, yTitle: 'actifs' }),
    update: (c) => JOBS.forEach((j, i) => (c.data.datasets[i].data = series((r) => r.workersByJob[j]))),
  },
  {
    tab: 'emploi', title: 'Revenu moyen par métier', desc: 'Écus par jour, mois écoulé (salaires, bénéfices distribués, dividendes).',
    build: (c) => barChart(c, [{ label: 'Revenu / jour', color: css('--accent') }], { horizontal: true }),
    update: (c) => {
      if (!snap) return;
      const rows = snap.jobs.filter((j) => j.workers > 0).sort((a, b) => b.avgIncome - a.avgIncome);
      c.data.labels = rows.map((j) => `${j.label} (${j.workers})`);
      c.data.datasets[0].data = rows.map((j) => +j.avgIncome.toFixed(2));
      (c.data.datasets[0] as any).backgroundColor = rows.map((j) => JOB_DEFS[j.job].color);
    },
  },
  {
    tab: 'emploi', title: 'Concentration par métier', desc: 'Part des actifs d’un métier qui travaillent dans sa plus grande entreprise (100 % = monopole).',
    build: (c) => {
      const ch = barChart(c, [{ label: 'Part de la plus grande entreprise', color: '#805ad5' }], { horizontal: true });
      (ch.options as any).scales.x.max = 1;
      (ch.options as any).scales.x.ticks.callback = (v: number) => `${Math.round(v * 100)} %`;
      return ch;
    },
    update: (c) => {
      if (!snap) return;
      const rows = snap.jobs.filter((j) => j.workers > 0 && JOB_DEFS[j.job].cat !== 'service').sort((a, b) => b.topShare - a.topShare);
      c.data.labels = rows.map((j) => j.label);
      c.data.datasets[0].data = rows.map((j) => j.topShare);
      (c.data.datasets[0] as any).backgroundColor = rows.map((j) => JOB_DEFS[j.job].color);
    },
  },
  {
    tab: 'emploi', title: 'Entreprises', desc: 'Nombre d’entreprises d’au moins deux personnes (gauche) et salariés du privé (droite).',
    build: (c) => lineChart(c, [
      { label: 'Entreprises (≥ 2 pers.)', color: '#dd6b20' },
      { label: 'Plus grande entreprise', color: '#805ad5', dash: true },
      { label: 'Salariés', color: css('--accent'), axis: 'y2' },
    ], { yTitle: 'entreprises', y2Title: 'salariés' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.firms);
      c.data.datasets[1].data = series((r) => r.biggestFirm);
      c.data.datasets[2].data = series((r) => r.employees);
    },
  },
  // ------------------------------------------------------------------ démographie
  {
    tab: 'demographie', title: 'Pyramide des âges', desc: 'Habitants par tranche de 5 ans et par statut.',
    build: (c) => barChart(c, [
      { label: 'Enfants', color: '#a0aec0' },
      { label: 'Actifs', color: '#3182ce' },
      { label: 'Sans emploi', color: '#e53e3e' },
      { label: 'Retraités', color: '#d69e2e' },
    ], { stacked: true, horizontal: true }),
    update: (c) => {
      if (!snap) return;
      const p = [...snap.pyramid].reverse().filter((x, i, arr) => x.actifs + x.enfants + x.retraites + x.chomeurs > 0 || i > arr.length - 15);
      c.data.labels = p.map((x) => x.age);
      c.data.datasets[0].data = p.map((x) => x.enfants);
      c.data.datasets[1].data = p.map((x) => x.actifs);
      c.data.datasets[2].data = p.map((x) => x.chomeurs);
      c.data.datasets[3].data = p.map((x) => x.retraites);
    },
  },
  {
    tab: 'demographie', title: 'Naissances et décès', desc: 'Par mois, selon la cause.',
    build: (c) => barChart(c, [
      { label: 'Naissances', color: '#38a169' },
      { label: 'Décès (âge)', color: '#a0aec0' },
      { label: 'Décès (maladie)', color: '#d69e2e' },
      { label: 'Décès (faim)', color: '#e53e3e' },
    ]),
    update: (c) => {
      const b = monthly((r) => r.births);
      c.data.labels = b.labels;
      c.data.datasets[0].data = b.values;
      c.data.datasets[1].data = monthly((r) => -r.deaths.age).values;
      c.data.datasets[2].data = monthly((r) => -r.deaths.maladie).values;
      c.data.datasets[3].data = monthly((r) => -r.deaths.faim).values;
      (c.options as any).scales.x.stacked = true;
      (c.options as any).scales.y.stacked = true;
    },
  },
  {
    tab: 'demographie', title: 'Santé et éducation', desc: 'Santé moyenne (0–100, gauche) ; niveau d’éducation moyen des adultes et part de malades (droite).',
    build: (c) => lineChart(c, [
      { label: 'Santé moyenne', color: css('--good') },
      { label: 'Éducation des adultes', color: '#319795', axis: 'y2' },
      { label: 'Malades', color: css('--bad'), axis: 'y2' },
    ], { yTitle: 'santé', y2Title: 'part', y2percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.avgHealth);
      c.data.datasets[1].data = series((r) => r.avgEduAdults);
      c.data.datasets[2].data = series((r) => r.sickRate, 10);
    },
  },
  {
    tab: 'demographie', title: 'Statuts', desc: 'Enfants, actifs, sans emploi, retraités.',
    build: (c) => lineChart(c, [
      { label: 'Enfants', color: '#a0aec0', fill: true },
      { label: 'Actifs', color: '#3182ce', fill: true },
      { label: 'Sans emploi', color: '#e53e3e', fill: true },
      { label: 'Retraités', color: '#d69e2e', fill: true },
    ], { stacked: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.enfants);
      c.data.datasets[1].data = series((r) => r.actifs);
      c.data.datasets[2].data = series((r) => r.chomeurs);
      c.data.datasets[3].data = series((r) => r.retraites);
    },
  },
  // ------------------------------------------------------------------ santé
  {
    tab: 'sante', title: 'Soins réalisés et renoncements', desc: 'Journées de soin par mois : réalisées, refusées par le patient faute de pouvoir ou de vouloir payer, impossibles faute de médecin libre (un malade en attente compte chaque jour).',
    build: (c) => barChart(c, [
      { label: 'Soins réalisés', color: '#38a169' },
      { label: 'Renoncement (prix)', color: '#dd6b20' },
      { label: 'Pas de médecin libre', color: '#e53e3e' },
    ], { stacked: true }),
    update: (c) => {
      const a = monthly((r) => r.careActs ?? 0);
      c.data.labels = a.labels;
      c.data.datasets[0].data = a.values;
      c.data.datasets[1].data = monthly((r) => r.careDenied ?? 0).values;
      c.data.datasets[2].data = monthly((r) => r.careNoDoctor ?? 0).values;
    },
  },
  {
    tab: 'sante', title: 'Qui paie les soins', desc: 'Honoraires versés aux médecins par mois, selon le payeur : les ménages (reste à charge), la sécurité sociale, les assureurs privés.',
    build: (c) => barChart(c, [
      { label: 'Ménages', color: '#dd6b20' },
      { label: 'Sécurité sociale', color: '#e53e3e' },
      { label: 'Assurances privées', color: '#3182ce' },
    ], { stacked: true, yTitle: 'écus' }),
    update: (c) => {
      const a = monthly((r) => r.careSpend?.menages ?? 0);
      c.data.labels = a.labels;
      c.data.datasets[0].data = a.values;
      c.data.datasets[1].data = monthly((r) => r.careSpend?.secu ?? 0).values;
      c.data.datasets[2].data = monthly((r) => r.careSpend?.assurance ?? 0).values;
    },
  },
  {
    tab: 'sante', title: 'Médecins et honoraires', desc: 'Médecins libéraux (gauche) ; honoraires moyens d’une journée de soin, en écus (droite). Des cabinets pleins font monter les prix, ce qui attire de nouveaux médecins.',
    build: (c) => lineChart(c, [
      { label: 'Médecins', color: '#e53e3e' },
      { label: 'Honoraires par acte', color: '#805ad5', axis: 'y2' },
    ], { yTitle: 'médecins', y2Title: 'écus' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.workersByJob.medecin);
      c.data.datasets[1].data = series((r) => r.avgFee ?? 0, 7);
    },
  },
  {
    tab: 'sante', title: 'Assurance privée', desc: 'Prime moyenne par mois pour un adulte de 40 à 59 ans, en écus (gauche) ; part des habitants assurés (droite).',
    build: (c) => lineChart(c, [
      { label: 'Prime mensuelle', color: '#3182ce' },
      { label: 'Assurés', color: '#38a169', axis: 'y2' },
    ], { yTitle: 'écus / mois', y2Title: 'part', y2percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.avgPremium ?? 0);
      c.data.datasets[1].data = series((r) => r.insuredRate ?? 0);
    },
  },
  {
    tab: 'sante', title: 'Comptes publics de la santé', desc: 'Par mois : cotisations encaissées par la sécurité sociale, remboursements de soins et subsides aux primes versés par l’État.',
    build: (c) => barChart(c, [
      { label: 'Cotisations', color: '#38a169' },
      { label: 'Remboursements', color: '#e53e3e' },
      { label: 'Subsides aux primes', color: '#3182ce' },
    ], { yTitle: 'écus' }),
    update: (c) => {
      const a = monthly((r) => r.revenue.cotisationsSante ?? 0);
      c.data.labels = a.labels;
      c.data.datasets[0].data = a.values;
      c.data.datasets[1].data = monthly((r) => r.spending.remboursementsSante ?? 0).values;
      c.data.datasets[2].data = monthly((r) => r.spending.subsidesPrimes ?? 0).values;
    },
  },
  {
    tab: 'sante', title: 'Malades sans soins', desc: 'Habitants malades et, parmi eux, ceux qui n’ont pas été soignés dans la journée (moyenne sur 7 jours). Une maladie grave non soignée tue souvent : voir les décès dans l’onglet Démographie.',
    build: (c) => lineChart(c, [
      { label: 'Malades', color: '#e53e3e' },
      { label: 'dont non soignés', color: '#dd6b20', fill: true },
    ], { yTitle: 'habitants' }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.sickRate * r.population, 7);
      c.data.datasets[1].data = series((r) => r.sickUntreated ?? 0, 7);
    },
  },
  // ------------------------------------------------------------------ État
  {
    tab: 'etat', title: 'Recettes par mois', desc: 'Écus encaissés par l’État.',
    build: (c) => barChart(c, Object.keys(REV_LABELS).map((k, i) => ({ label: REV_LABELS[k], color: REV_COLORS[i] })), { stacked: true }),
    update: (c) => {
      const keys = Object.keys(REV_LABELS);
      keys.forEach((k, i) => {
        const m = monthly((r) => (r.revenue as Record<string, number>)[k] ?? 0);
        if (i === 0) c.data.labels = m.labels;
        c.data.datasets[i].data = m.values;
      });
    },
  },
  {
    tab: 'etat', title: 'Dépenses par mois', desc: 'Écus versés par l’État.',
    build: (c) => barChart(c, Object.keys(SPEND_LABELS).map((k, i) => ({ label: SPEND_LABELS[k], color: SPEND_COLORS[i] })), { stacked: true }),
    update: (c) => {
      const keys = Object.keys(SPEND_LABELS);
      keys.forEach((k, i) => {
        const m = monthly((r) => (r.spending as Record<string, number>)[k] ?? 0);
        if (i === 0) c.data.labels = m.labels;
        c.data.datasets[i].data = m.values;
      });
    },
  },
  {
    tab: 'etat', title: 'Trésorerie et capacité de paiement', desc: 'Trésor public (gauche) ; part des dépenses prévues que l’État a pu payer (droite, 100 % = tout payé).',
    build: (c) => lineChart(c, [
      { label: 'Trésorerie', color: '#38a169' },
      { label: 'Dépenses payées', color: css('--bad'), axis: 'y2' },
    ], { yTitle: 'écus', y2Title: 'payé', y2percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.treasury);
      c.data.datasets[1].data = series((r) => r.paidRatio, 7);
    },
  },
  {
    tab: 'etat', title: 'Fonction publique', desc: 'Enseignants employés par l’État (les médecins sont libéraux).',
    build: (c) => lineChart(c, [
      { label: 'Enseignants', color: '#319795' },
    ]),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.workersByJob.enseignant);
    },
  },
  // ------------------------------------------------------------------ ressources
  {
    tab: 'ressources', title: 'Ressources naturelles', desc: 'Stock de poissons et de forêt (part de la capacité maximale). En dessous de 50 %, les prises baissent et la ressource se renouvelle moins vite.',
    build: (c) => lineChart(c, [
      { label: 'Poissons', color: '#4fa3d1' },
      { label: 'Forêt', color: '#744210' },
    ], { percent: true }),
    update: (c) => {
      c.data.datasets[0].data = series((r) => r.fishStock / 24000);
      c.data.datasets[1].data = series((r) => r.forestStock / 60000);
    },
  },
  {
    tab: 'ressources', title: 'Production', desc: 'Unités produites par jour (moyenne 30 jours).',
    build: (c) => lineChart(c, (['ble', 'poisson', 'lait', 'oeufs', 'fruits', 'bois', 'outils', 'artisanat'] as Good[]).map((g) => ({ label: GOOD_DEFS[g].label, color: GOOD_DEFS[g].color })), { log: true }),
    update: (c) => (['ble', 'poisson', 'lait', 'oeufs', 'fruits', 'bois', 'outils', 'artisanat'] as Good[]).forEach((g, i) => (c.data.datasets[i].data = series((r) => Math.max(0.01, r.production[g] ?? 0), 30))),
  },
];

/**
 * Met à jour un graphique ; en mode comparaison, ajoute en pointillés les mêmes séries calculées
 * sur l'autre branche (graphiques temporels uniquement).
 */
function updateWithCompare(def: ChartDef) {
  const c = def.chart!;
  const anyc = c as any;
  anyc.$baseN ??= c.data.datasets.length;
  c.data.datasets.length = anyc.$baseN;
  const temporal = (c.config as any).type === 'line' && !anyc.$noCompare && !(c.options.scales as any)?.y?.stacked;
  (c.options.plugins as any).legend.labels.filter = compare ? (item: any) => !String(item.text).endsWith(`(${compare!.name})`) : undefined;
  if (compare && temporal && compare.rows.length) {
    const saved = history;
    history = viewDay !== null ? compare.rows.filter((r) => r.day <= viewDay!) : compare.rows;
    def.update(c);
    const ghosts = c.data.datasets.map((d: any) => ({
      ...d, data: d.data, label: `${d.label} (${compare!.name})`, borderDash: [6, 4], fill: false,
      borderColor: d.borderColor, backgroundColor: 'transparent', borderWidth: 1.4, hidden: d.hidden,
    }));
    history = saved;
    def.update(c);
    c.data.datasets.push(...ghosts);
  } else {
    def.update(c);
  }
  c.update('none');
}

function nodeColor(label?: string): string {
  if (!label) return '#888';
  if (label.startsWith('Ménages')) return '#3182ce';
  if (label.startsWith('État')) return '#38a169';
  if (label === 'Producteurs') return '#d4a72c';
  if (label === 'Transformateurs') return '#c53030';
  if (label === 'Commerçants') return '#805ad5';
  return '#888';
}

// ---------------------------------------------------------------------------- tableaux

interface TableDef {
  tab: string;
  title: string;
  desc?: string;
  wide?: boolean;
  render: (el: HTMLElement) => void;
}

const agentTable = (rows: AgentRow[]) => `<div class="table-wrap"><table><thead><tr><th>Nom</th><th class="num">Âge</th><th>Métier</th><th>Rôle</th><th class="num">Patrimoine</th><th class="num">Revenu/j</th><th class="num">Santé</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="click" data-agent="${r.id}"><td>${esc(r.name)}</td><td class="num">${r.age}</td><td>${esc(r.job)}</td><td>${esc(r.role)}</td><td class="num">${ecu(r.wealth)}</td><td class="num">${fmt(r.income, 2)}</td><td class="num">${fmt(r.health)}</td></tr>`).join('')}
  </tbody></table></div>`;

const tables: TableDef[] = [
  {
    tab: 'inegalites', title: 'Mobilité sociale',
    desc: 'Où sont aujourd’hui les adultes selon leur rang de patrimoine il y a quelques années ? Ligne = quintile de départ, colonne = quintile actuel, en % de la ligne. Une diagonale forte = société figée.',
    render: (el) => {
      if (!snap) return;
      if (!snap.mobilityYears) {
        el.innerHTML = '<p class="desc">Disponible après deux ans de simulation (relevé annuel).</p>';
        return;
      }
      const Q = ['20 % + pauvres', '2e', '3e', '4e', '20 % + riches'];
      const cell = (v: number) => {
        const a = Math.min(0.85, v * 1.4);
        return `<td style="background:rgba(128,90,213,${a.toFixed(2)});color:${a > 0.45 ? '#fff' : 'inherit'}">${Math.round(v * 100)} %</td>`;
      };
      const diag = snap.mobility.reduce((x, row, i) => x + row[i], 0);
      const tot = snap.mobility.flat().reduce((x, y) => x + y, 0) || 1;
      el.innerHTML = `<table class="matrix"><tr><th>Il y a ${snap.mobilityYears} an(s) ↓ / aujourd’hui →</th>${Q.map((q) => `<th>${q}</th>`).join('')}</tr>
        ${snap.mobility.map((row, i) => { const n = row.reduce((x, y) => x + y, 0) || 1; return `<tr><th>${Q[i]}</th>${row.map((v) => cell(v / n)).join('')}</tr>`; }).join('')}</table>
        <p class="desc">${pct(diag / tot)} des adultes sont restés dans le même quintile. Les 20 % les plus pauvres restés pauvres : ${pct(snap.mobility[0][0] / (snap.mobility[0].reduce((x, y) => x + y, 0) || 1))}.</p>`;
    },
  },
  { tab: 'inegalites', title: 'Les 15 plus riches', render: (el) => snap && (el.innerHTML = agentTable(snap.richest)) },
  { tab: 'inegalites', title: 'Les 15 plus pauvres', render: (el) => snap && (el.innerHTML = agentTable(snap.poorest)) },
  {
    tab: 'marches', wide: true, title: 'Biens', desc: 'Situation du jour : prix, volumes, stocks (entreprises et ménages), production et gaspillage.',
    render: (el) => {
      if (!snap) return;
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Bien</th><th class="num">Prix détail</th><th class="num">Prix gros</th><th class="num">Produit/j</th><th class="num">Vendu gros/j</th><th class="num">Vendu détail/j</th><th class="num">Stock entreprises</th><th class="num">Stock ménages</th><th class="num">Périmé/j</th></tr></thead><tbody>
      ${snap.goods.map((g) => `<tr><td><span class="pill" style="background:${GOOD_DEFS[g.good].color}33">${g.label}</span></td><td class="num">${g.retail === null ? '—' : fmt(g.retail, 2)}</td><td class="num">${fmt(g.wholesale ?? NaN, 2)}</td><td class="num">${fmt(g.production)}</td><td class="num">${fmt(g.wholesaleVol)}</td><td class="num">${fmt(g.retailVol)}</td><td class="num">${fmt(g.stockBiz)}</td><td class="num">${fmt(g.stockHouseholds)}</td><td class="num">${fmt(g.waste)}</td></tr>`).join('')}
      </tbody></table></div>`;
    },
  },
  {
    tab: 'emploi', title: 'Métiers', desc: 'Indépendants, entreprises et salariés par métier.',
    render: (el) => {
      if (!snap) return;
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Métier</th><th class="num">Actifs</th><th class="num">Indépendants</th><th class="num">Entreprises</th><th class="num">Salariés</th><th class="num">Revenu/j</th></tr></thead><tbody>
      ${snap.jobs.map((j) => `<tr><td>${j.label}</td><td class="num">${j.workers}</td><td class="num">${j.independents}</td><td class="num">${j.firms}</td><td class="num">${j.employees}</td><td class="num">${fmt(j.avgIncome, 2)}</td></tr>`).join('')}
      </tbody></table></div>`;
    },
  },
  {
    tab: 'emploi', title: 'Plus grandes entreprises', desc: 'Le patron est l’actionnaire qui a apporté le plus de capital. Salaire offert = 70 % de la valeur ajoutée par travailleur, jamais sous le salaire minimum.',
    render: (el) => {
      if (!snap) return;
      if (!snap.firmsTable.length) {
        el.innerHTML = '<p class="desc">Aucune entreprise de plus d’une personne pour l’instant : tout le monde est indépendant.</p>';
        return;
      }
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>Métier</th><th>Patron</th><th class="num">Pers.</th><th class="num">Actionnaires</th><th class="num">Trésorerie</th><th class="num">Salaire/j</th><th class="num">VA/trav./j</th><th class="num">Créée</th></tr></thead><tbody>
      ${snap.firmsTable.map((f) => `<tr class="click" data-agent="${f.patron}"><td>${f.id}</td><td>${f.job}</td><td>${esc(f.patronName)}</td><td class="num">${f.workers}</td><td class="num">${f.shareholders}</td><td class="num">${ecu(f.cash)}</td><td class="num">${fmt(f.wage, 2)}</td><td class="num">${fmt(f.va, 2)}</td><td class="num">${dateLabel(f.founded)}</td></tr>`).join('')}
      </tbody></table></div>`;
    },
  },
  {
    tab: 'etat', wide: true, title: 'Budget du mois écoulé',
    render: (el) => {
      if (!snap) return;
      const r = snap.stateMonth.revenue as Record<string, number>;
      const s = snap.stateMonth.spending as Record<string, number>;
      const tr = Object.values(r).reduce((a, b) => a + b, 0);
      const ts = Object.values(s).reduce((a, b) => a + b, 0);
      el.innerHTML = `<div class="form-grid"><div><table><thead><tr><th>Recettes</th><th class="num">Écus</th></tr></thead><tbody>
        ${Object.keys(REV_LABELS).map((k) => `<tr><td>${REV_LABELS[k]}</td><td class="num">${fmt((r[k] ?? 0) / 100)}</td></tr>`).join('')}
        <tr><th>Total</th><th class="num">${fmt(tr / 100)}</th></tr></tbody></table></div>
        <div><table><thead><tr><th>Dépenses</th><th class="num">Écus</th></tr></thead><tbody>
        ${Object.keys(SPEND_LABELS).map((k) => `<tr><td>${SPEND_LABELS[k]}</td><td class="num">${fmt((s[k] ?? 0) / 100)}</td></tr>`).join('')}
        <tr><th>Total</th><th class="num">${fmt(ts / 100)}</th></tr></tbody></table></div></div>
        <p class="desc">Solde : <b>${ecu((tr - ts) / 100)}</b>. Une monnaie fixe : tout excédent de l’État est de l’argent retiré du circuit, tout déficit est puisé dans sa trésorerie.</p>`;
    },
  },
];

// ---------------------------------------------------------------------------- vues

const TABS: [string, string][] = [
  ['ile', 'L’île'], ['apercu', 'Vue d’ensemble'], ['inegalites', 'Inégalités'], ['marches', 'Marchés'], ['emploi', 'Emploi et entreprises'],
  ['demographie', 'Démographie'], ['sante', 'Santé'], ['etat', 'État'], ['ressources', 'Ressources'], ['habitants', 'Habitants'], ['modele', 'Le modèle'],
];

function buildViews() {
  const tabs = $('tabs');
  const views = $('views');
  for (const [id, label] of TABS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.tab = id;
    b.addEventListener('click', () => showTab(id));
    tabs.appendChild(b);
    const v = document.createElement('section');
    v.className = 'view';
    v.dataset.tab = id;
    views.appendChild(v);
  }
  for (const def of charts) {
    const v = views.querySelector(`.view[data-tab="${def.tab}"]`)!;
    const card = document.createElement('div');
    card.className = `card${def.wide ? ' wide' : ''}`;
    card.innerHTML = `<h3>${def.title}</h3>${def.desc ? `<p class="desc">${def.desc}</p>` : ''}<div class="tools"></div><div class="chart${def.tall ? ' tall' : ''}"><canvas></canvas></div>`;
    v.appendChild(card);
    const redraw = () => {
      if (def.chart) {
        def.update(def.chart);
        def.chart.update('none');
      }
    };
    const toolsEl = card.querySelector('.tools') as HTMLElement;
    if (def.tools) def.tools(toolsEl, redraw);
    else toolsEl.remove();
    def.chart = def.build(card.querySelector('canvas')!);
  }
  for (const t of tables) {
    const v = views.querySelector(`.view[data-tab="${t.tab}"]`)!;
    const card = document.createElement('div');
    card.className = `card${t.wide ? ' wide' : ''}`;
    card.innerHTML = `<h3>${t.title}</h3>${t.desc ? `<p class="desc">${t.desc}</p>` : ''}<div class="tbl"></div>`;
    (card as any)._render = () => t.render(card.querySelector('.tbl') as HTMLElement);
    card.dataset.table = '1';
    v.appendChild(card);
  }
  buildIsland(views.querySelector('.view[data-tab="ile"]') as HTMLElement);
  buildCitizens(views.querySelector('.view[data-tab="habitants"]') as HTMLElement);
  buildModel(views.querySelector('.view[data-tab="modele"]') as HTMLElement);
  views.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('[data-agent]') as HTMLElement | null;
    if (tr) openAgent(Number(tr.dataset.agent));
  });
  showTab(store.get('tab', 'ile'));
}

function showTab(id: string) {
  if (!TABS.some(([t]) => t === id)) id = 'ile';
  currentTab = id;
  islandMap?.setVisible(id === 'ile');
  send({ type: 'want', map: id === 'ile' });
  store.set('tab', id);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tab === id));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', (v as HTMLElement).dataset.tab === id));
  if (id === 'habitants') requestCitizens();
  dirty = true;
  render();
}

// ---------------------------------------------------------------------------- l'île (carte + gazette)

const ZONE_JOBS: Record<string, Job[]> = {};
function buildIsland(v: HTMLElement) {
  const card = document.createElement('div');
  card.className = 'card wide';
  card.innerHTML = `<div class="map-card"><div><div class="map-host" id="mapHost"></div>
    <div class="legend">Patrimoine : ${['20 % les plus pauvres', '', '', '', '20 % les plus riches'].map((l, i) => `<span><i style="background:${RICHNESS_COLORS[i]}"></i>${l}</span>`).join('')}
      <span><i style="background:transparent;border:2px solid #f6c90e"></i>patron</span>
      <span><i style="background:transparent;border:2px solid #e53e3e"></i>a faim</span>
      <span>pâle = malade · petits points = enfants</span>
      <span><i style="background:#e8b923"></i>achats et salaires</span><span><i style="background:#2f9e5a"></i>impôts</span><span><i style="background:#3b82f6"></i>dépenses publiques</span>
    </div>
    <p class="desc">Survolez un habitant ou un lieu ; cliquez pour le détail. Les habitants se déplacent quand ils changent de métier ou prennent leur retraite.</p></div>
    <div class="gazette"><h3>📰 La Gazette de l’île</h3><div id="gazette"></div></div></div>`;
  v.appendChild(card);
  islandMap = new IslandMap($('mapHost'), {
    onAgent: (id) => openAgent(id),
    onZone: (z) => openZone(z),
    isRunning: () => running && viewDay === null,
  });
}

const NEWS_LABEL: Record<NewsItem['kind'], string> = {
  politique: 'Politique', evenement: 'Événement', prix: 'Prix', entreprise: 'Entreprises', deces: 'Décès', crise: 'Crise', ressource: 'Nature', societe: 'Société',
};
let lastGazette = '';
function renderGazette() {
  if (!snap) return;
  const items = [...snap.news].reverse().slice(0, 40);
  const key = items.length ? `${items[0].day}-${items[0].text}-${items.length}` : '';
  if (key === lastGazette) return;
  lastGazette = key;
  $('gazette').innerHTML = items.length
    ? items.map((n) => `<div class="news"><span class="d">${dateLabel(n.day)}</span><br><span class="k k-${n.kind}">${NEWS_LABEL[n.kind]}</span>${esc(n.text)}</div>`).join('')
    : '<p class="desc">Rien à signaler pour l’instant. Lancez la simulation !</p>';
}

function openZone(z: Job | 'mairie') {
  if (!snap) return;
  let html = '';
  if (z === 'mairie') {
    const r = snap.stateMonth.revenue as Record<string, number>;
    const sp = snap.stateMonth.spending as Record<string, number>;
    html = `<h3>🏛️ Mairie — l’État</h3><dl class="kv"><dt>Trésorerie</dt><dd>${ecu(snap.kpi.treasury)}</dd>
      <dt>Recettes du mois</dt><dd>${ecu(Object.values(r).reduce((a, b) => a + b, 0) / 100)}</dd>
      <dt>Dépenses du mois</dt><dd>${ecu(Object.values(sp).reduce((a, b) => a + b, 0) / 100)}</dd>
      <dt>Fonctionnaires</dt><dd>${snap.jobs.find((j) => j.job === 'enseignant')?.workers ?? 0} enseignants</dd></dl>
      <p class="desc">Détail dans l’onglet État. Les leviers sont dans la barre de gauche.</p>`;
  } else {
    const j = snap.jobs.find((x) => x.job === z)!;
    const firms = snap.firmsTable.filter((f) => f.job === JOB_DEFS[z].label);
    const goods = Object.keys(JOB_DEFS[z].outputs) as Good[];
    html = `<h3>${JOB_DEFS[z].label}s</h3><dl class="kv">
      <dt>Actifs</dt><dd>${j.workers} (${j.independents} indépendants, ${j.firms} entreprises, ${j.employees} salariés)</dd>
      <dt>Revenu moyen</dt><dd>${fmt(j.avgIncome, 2)} é / jour</dd>
      <dt>Patrimoine moyen</dt><dd>${ecu(j.avgWealth)}</dd>
      <dt>Plus grande entreprise</dt><dd>${pct(j.topShare)} des actifs du métier</dd>
      ${goods.map((g) => { const x = snap!.goods.find((y) => y.good === g)!; return `<dt>${GOOD_DEFS[g].label}</dt><dd>produit ${fmt(x.production)}/j, prix de gros ${fmt(x.wholesale ?? NaN, 2)} é${x.retail !== null ? `, détail ${fmt(x.retail, 2)} é` : ''}</dd>`; }).join('')}
      ${z === 'pecheur' ? `<dt>Stock de poissons</dt><dd>${pct(snap.kpi.fish)}</dd>` : ''}
      ${z === 'bucheron' ? `<dt>Forêt</dt><dd>${pct(snap.kpi.forest)}</dd>` : ''}
    </dl>${firms.length ? `<h4>Entreprises</h4><table><tr><th>Patron</th><th class="num">Pers.</th><th class="num">Salaire</th></tr>${firms.slice(0, 8).map((f) => `<tr class="click" data-zagent="${f.patron}"><td>${esc(f.patronName)}</td><td class="num">${f.workers}</td><td class="num">${fmt(f.wage, 2)}</td></tr>`).join('')}</table>` : ''}`;
  }
  $('zoneBody').innerHTML = html;
  $('zoneBody').querySelectorAll('[data-zagent]').forEach((tr) => tr.addEventListener('click', () => {
    ($('zoneDialog') as HTMLDialogElement).close();
    openAgent(Number((tr as HTMLElement).dataset.zagent));
  }));
  ($('zoneDialog') as HTMLDialogElement).showModal();
}
void ZONE_JOBS;

// ---------------------------------------------------------------------------- ligne du temps

function renderTimeline() {
  const last = fullHistory[fullHistory.length - 1]?.day ?? 0;
  const range = $('tlRange') as HTMLInputElement;
  range.max = String(last);
  if (viewDay === null) range.value = String(last);
  $('tlDay').textContent = viewDay === null ? `Présent : ${dateLabel(last)}` : `Passé : ${dateLabel(viewDay)} (présent : ${dateLabel(last)})`;
  const key = `${last}|${marks.length}`;
  if ((renderTimeline as any).key !== key) {
    (renderTimeline as any).key = key;
    $('tlMarks').innerHTML = marks
      .map((mk) => `<span class="tl-mark ${mk.kind}" style="left:${last ? (mk.day / last) * 100 : 0}%" title="${esc(dateLabel(mk.day))} — ${esc(mk.text)}"></span>`)
      .join('');
  }
  const view = $('tlView');
  view.classList.toggle('on', viewDay !== null);
  if (viewDay !== null) $('tlViewText').textContent = `Vous regardez l’île au ${dateLabel(viewDay)}. Les graphiques s’arrêtent à cette date.`;
}

function renderBranches() {
  const sel = $('branchSel') as HTMLSelectElement;
  sel.innerHTML = branches.map((b) => `<option value="${b.id}" ${b.id === currentBranch ? 'selected' : ''}>${esc(b.name)}${b.parent ? ` (depuis j${b.forkDay})` : ''}</option>`).join('');
  const cmp = $('compareSel') as HTMLSelectElement;
  const v = cmp.value;
  cmp.innerHTML = `<option value="">—</option>` + branches.filter((b) => b.id !== currentBranch).map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  cmp.value = branches.some((b) => String(b.id) === v && b.id !== currentBranch) ? v : '';
}

let viewTimer = 0;
$('tlRange').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  const last = fullHistory[fullHistory.length - 1]?.day ?? 0;
  clearTimeout(viewTimer);
  if (v >= last - 1) {
    viewDay = null;
    send({ type: 'view', day: null });
    refreshView();
    return;
  }
  // on se cale sur l'instantané disponible le plus proche (avant)
  const d = snapDays.filter((x) => x <= v).pop() ?? 0;
  viewDay = d;
  running = false;
  updatePlay();
  refreshView();
  viewTimer = window.setTimeout(() => send({ type: 'view', day: d }), 120);
});
$('tlPresent').addEventListener('click', () => {
  viewDay = null;
  send({ type: 'view', day: null });
  refreshView();
});
$('tlFork').addEventListener('click', () => {
  if (viewDay === null) return;
  send({ type: 'fork', day: viewDay });
});
$('branchSel').addEventListener('change', (e) => send({ type: 'branch', id: Number((e.target as HTMLSelectElement).value) }));
$('compareSel').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  send({ type: 'compare', id: v ? Number(v) : null });
});
$('branchRename').addEventListener('click', () => {
  const b = branches.find((x) => x.id === currentBranch);
  const name = prompt('Nom de la branche', b?.name ?? '');
  if (name) send({ type: 'rename', id: currentBranch, name });
});
$('branchDelete').addEventListener('click', () => {
  const others = branches.filter((b) => b.id !== currentBranch);
  if (!others.length) return alert('Il n’y a pas d’autre branche à supprimer.');
  const name = prompt(`Supprimer quelle branche ? (${others.map((b) => b.name).join(', ')})`);
  const b = others.find((x) => x.name === name);
  if (b) send({ type: 'deleteBranch', id: b.id });
});

/** Recalcule la vue (présent ou passé) et redessine. */
function refreshView() {
  history = viewDay === null ? fullHistory : fullHistory.slice(0, viewDay + 1);
  if (viewDay === null) {
    snap = liveSnap;
    if (liveMap) islandMap?.update(liveMap, true);
  }
  dirty = true;
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------- habitants

let citizenQuery = { sort: 'wealth' as 'wealth' | 'income' | 'age' | 'health', dir: -1 as 1 | -1, job: '' as Job | '', status: '', search: '' };
function buildCitizens(v: HTMLElement) {
  const card = document.createElement('div');
  card.className = 'card wide';
  card.innerHTML = `<h3>Habitants</h3><p class="desc">Cliquez sur une ligne pour voir la fiche d’un habitant. Liste rafraîchie toutes les secondes pendant la simulation.</p>
    <div class="tools">
      <input type="search" id="cSearch" placeholder="Nom ou numéro" />
      <select id="cJob"><option value="">Tous les métiers</option>${JOBS.map((j) => `<option value="${j}">${JOB_DEFS[j].label}</option>`).join('')}</select>
      <select id="cStatus"><option value="">Tous les statuts</option>${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <select id="cSort"><option value="wealth">Tri : patrimoine</option><option value="income">Tri : revenu</option><option value="age">Tri : âge</option><option value="health">Tri : santé</option></select>
      <select id="cDir"><option value="-1">décroissant</option><option value="1">croissant</option></select>
      <span id="cTotal" class="desc"></span>
    </div><div id="cTable"></div>`;
  v.appendChild(card);
  const upd = () => {
    citizenQuery = {
      search: ($('cSearch') as HTMLInputElement).value,
      job: ($('cJob') as HTMLSelectElement).value as Job | '',
      status: ($('cStatus') as HTMLSelectElement).value,
      sort: ($('cSort') as HTMLSelectElement).value as typeof citizenQuery.sort,
      dir: Number(($('cDir') as HTMLSelectElement).value) as 1 | -1,
    };
    requestCitizens();
  };
  ['cSearch', 'cJob', 'cStatus', 'cSort', 'cDir'].forEach((id) => $(id).addEventListener('input', upd));
}
let lastCitizenReq = 0;
function requestCitizens() {
  lastCitizenReq = performance.now();
  send({ type: 'agents', ...citizenQuery, limit: 200 });
}

// ---------------------------------------------------------------------------- fiche habitant

function openAgent(id: number) {
  send({ type: 'agent', id });
  $('agentBody').innerHTML = '<p>Chargement…</p>';
  ($('agentDialog') as HTMLDialogElement).showModal();
}

function renderAgent(d: any) {
  if (!d) {
    $('agentBody').innerHTML = '<p>Habitant introuvable.</p>';
    return;
  }
  const link = (p: { id: number; name: string; alive: boolean; age?: number }) => `<a href="#" data-open="${p.id}">${esc(p.name)}</a>${p.alive ? (p.age !== undefined ? ` (${p.age} ans)` : '') : ' †'}`;
  $('agentBody').innerHTML = `
    <h3>${esc(d.name)} <span class="pill">#${d.id}</span> ${d.alive ? '' : `<span class="pill">décédé·e (${d.deathCause}, ${dateLabel(d.deathDay)})</span>`}</h3>
    <dl class="kv">
      <dt>Âge</dt><dd>${d.age} ans — ${STATUS_LABEL[d.status] ?? d.status}</dd>
      <dt>Métier</dt><dd>${esc(d.job)} — ${esc(d.role)}</dd>
      <dt>Argent</dt><dd>${ecu(d.money, 2)}</dd>
      <dt>Patrimoine</dt><dd>${ecu(d.wealth, 2)} (dont hérité : ${ecu(d.inherited)})</dd>
      <dt>Revenu</dt><dd>${fmt(d.income, 2)} é / jour (mois écoulé)</dd>
      <dt>Santé</dt><dd>${fmt(d.health)} / 100 ${d.sick ? '— malade' : ''} ${d.hunger > 0.1 ? `— faim ${pct(d.hunger)}` : ''} — ${d.insured ? 'assuré·e' : 'sans assurance privée'}</dd>
      <dt>Éducation</dt><dd>${pct(d.edu)}</dd>
      ${d.business ? `<dt>Entreprise</dt><dd>#${d.business.id} ${esc(d.business.job)}, ${d.business.workers} pers., patron ${d.business.owner >= 0 ? `<a href="#" data-open="${d.business.owner}">${esc(d.business.ownerName)}</a>` : 'État'}, trésorerie ${ecu(d.business.cash)}, outils ${fmt(d.business.tools, 1)}${d.business.wage ? `, salaire ${fmt(d.business.wage, 2)} é/j` : ''}</dd>` : ''}
      ${d.shares.length ? `<dt>Parts</dt><dd>${d.shares.map((s: any) => `#${s.biz} ${esc(s.job)} : ${pct(s.share)} (${ecu(s.value)})`).join('<br>')}</dd>` : ''}
      ${d.parent ? `<dt>Parent</dt><dd>${link(d.parent)}</dd>` : ''}
      ${d.children.length ? `<dt>Enfants</dt><dd>${d.children.map(link).join(', ')}</dd>` : ''}
      ${d.food.length ? `<dt>Garde-manger</dt><dd>${d.food.map((f: any) => `${esc(f.good)} ${fmt(f.qty, 1)}`).join(', ')}</dd>` : ''}
    </dl>`;
  $('agentBody').querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    send({ type: 'agent', id: Number((a as HTMLElement).dataset.open) });
  }));
}

// ---------------------------------------------------------------------------- politique publique

interface SliderDef {
  key: keyof Policy;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  help?: string;
}
const pctF = (v: number) => `${fmt(v * 100, v * 100 % 1 ? 1 : 0)} %`;
const POLICY_GROUPS: [string, SliderDef[]][] = [
  ['Impôts', [
    { key: 'incomeTaxLow', label: 'Impôt sur le revenu (tranche basse)', min: 0, max: 0.6, step: 0.01, fmt: pctF },
    { key: 'incomeTaxHigh', label: 'Impôt sur le revenu (tranche haute)', min: 0, max: 0.9, step: 0.01, fmt: pctF },
    { key: 'incomeTaxThreshold', label: 'Seuil de la tranche haute', min: 0, max: 1000, step: 10, fmt: (v) => `${v} é/mois` },
    { key: 'vat', label: 'TVA', min: 0, max: 0.4, step: 0.01, fmt: pctF, help: 'Prélevée sur chaque vente au détail.' },
    { key: 'corporateTax', label: 'Impôt sur les sociétés', min: 0, max: 0.6, step: 0.01, fmt: pctF, help: 'Sur le bénéfice mensuel des entreprises.' },
    { key: 'wealthTax', label: 'Impôt sur la fortune (annuel)', min: 0, max: 0.1, step: 0.005, fmt: pctF },
    { key: 'wealthTaxThreshold', label: 'Seuil de l’impôt sur la fortune', min: 0, max: 20000, step: 100, fmt: (v) => ecu(v) },
    { key: 'inheritanceTax', label: 'Droits de succession', min: 0, max: 1, step: 0.05, fmt: pctF, help: 'Sur l’argent légué ; les parts d’entreprises passent aux enfants.' },
  ]],
  ['Dépenses publiques', [
    { key: 'teachersPer1000', label: 'Enseignants pour 1000 habitants', min: 0, max: 40, step: 1, fmt: (v) => `${v}`, help: 'Chaque enseignant instruit 25 enfants ; l’éducation augmente la productivité future.' },
    { key: 'publicSalary', label: 'Salaire des fonctionnaires', min: 0, max: 20, step: 0.5, fmt: (v) => `${fmt(v, 1)} é/j` },
    { key: 'pension', label: 'Pension de retraite', min: 0, max: 10, step: 0.25, fmt: (v) => `${fmt(v, 2)} é/j` },
    { key: 'retirementAge', label: 'Âge de la retraite', min: 50, max: 80, step: 1, fmt: (v) => `${v} ans` },
    { key: 'ubi', label: 'Revenu universel', min: 0, max: 10, step: 0.25, fmt: (v) => `${fmt(v, 2)} é/j`, help: 'Versé chaque jour à chaque adulte.' },
    { key: 'socialAidThreshold', label: 'Seuil de l’aide sociale', min: 0, max: 30, step: 1, fmt: (v) => `${v} é/pers.`, help: 'Un foyer dont l’épargne passe sous ce seuil (par membre) reçoit l’aide.' },
    { key: 'socialAidAmount', label: 'Montant de l’aide sociale', min: 0, max: 10, step: 0.25, fmt: (v) => `${fmt(v, 2)} é/j/pers.` },
    { key: 'surplusDays', label: 'Réserve avant reversement', min: 0, max: 720, step: 30, fmt: (v) => (v ? `${v} j` : 'jamais'), help: 'Au-delà de N jours de dépenses, l’excédent est reversé à parts égales aux adultes. « Jamais » : l’État thésaurise.' },
  ]],
  ['Santé : sécurité sociale', [
    { key: 'secuContribution', label: 'Cotisation santé', min: 0, max: 0.15, step: 0.005, fmt: pctF, help: 'Prélevée chaque mois sur tous les revenus (y compris pensions).' },
    { key: 'secuRate', label: 'Taux de remboursement', min: 0, max: 1, step: 0.05, fmt: pctF, help: 'Part du tarif de référence payée par la sécu. 0 % = pas de sécurité sociale.' },
    { key: 'secuRatePoor', label: 'Remboursement des foyers modestes', min: 0, max: 1, step: 0.05, fmt: pctF, help: 'Part des honoraires réels payée par la sécu pour un foyer dont l’épargne est sous 4 × le seuil de l’aide sociale (comme la CMU).' },
    { key: 'secuTariff', label: 'Tarif de référence', min: 0.5, max: 30, step: 0.5, fmt: (v) => `${fmt(v, 1)} é/acte`, help: 'Base de remboursement d’une journée de soin (indexée). Au-delà, le dépassement d’honoraires reste à la charge du patient ou de son assureur.' },
  ]],
  ['Santé : assurance privée', [
    { key: 'insuranceCoverage', label: 'Couverture du contrat', min: 0, max: 1, step: 0.05, fmt: pctF, help: 'Part du reste à charge (après sécu) payée par l’assureur. En dessous de 100 %, l’assuré garde une quote-part.' },
    { key: 'insuranceRiskRating', label: 'Primes selon l’âge', min: 0, max: 1, step: 0.05, fmt: pctF, help: '0 % : même prime pour tous (les jeunes paient pour les vieux, risque d’antisélection). 100 % : prime selon le risque de la classe d’âge.' },
    { key: 'premiumIncomeCap', label: 'Subside : prime au plus', min: 0, max: 0.3, step: 0.01, fmt: (v) => (v ? `${pctF(v)} du revenu` : 'pas de subside'), help: 'L’État paie la part de la prime qui dépasse ce pourcentage du revenu du foyer.' },
    { key: 'insuranceMinLossRatio', label: 'Primes reversées en soins (min.)', min: 0, max: 1, step: 0.05, fmt: (v) => (v ? pctF(v) : 'libre'), help: 'Si un assureur reverse moins que cette part de ses primes en soins, il rembourse l’excédent aux assurés.' },
  ]],
  ['Réglementation', [
    { key: 'minWage', label: 'Salaire minimum', min: 0, max: 15, step: 0.25, fmt: (v) => `${fmt(v, 2)} é/j`, help: 'Une entreprise qui ne peut pas le payer licencie.' },
    { key: 'shopRent', label: 'Taxe sur les locaux commerciaux', min: 0, max: 10, step: 0.25, fmt: (v) => `${fmt(v, 2)} é/j` },
    { key: 'fishingQuota', label: 'Quota de pêche', min: 0, max: 800, step: 10, fmt: (v) => (v ? `${v} /j` : 'aucun') },
    { key: 'loggingQuota', label: 'Quota d’abattage', min: 0, max: 600, step: 10, fmt: (v) => (v ? `${v} /j` : 'aucun') },
  ]],
];

const PRESETS: Record<string, { label: string; p: Partial<Policy> }> = {
  defaut: { label: 'Par défaut', p: DEFAULT_POLICY },
  laisser: {
    label: 'Laisser-faire',
    p: { incomeTaxLow: 0.03, incomeTaxHigh: 0.03, vat: 0.03, corporateTax: 0, wealthTax: 0, inheritanceTax: 0, teachersPer1000: 3, pension: 0, ubi: 0, socialAidAmount: 0, minWage: 0, shopRent: 0.5, secuRate: 0, secuRatePoor: 0, secuContribution: 0, insuranceMandatory: false, insuranceRiskRating: 1, premiumIncomeCap: 0, insuranceMinLossRatio: 0 },
  },
  providence: {
    label: 'État-providence',
    p: { incomeTaxLow: 0.15, incomeTaxHigh: 0.45, incomeTaxThreshold: 120, vat: 0.12, corporateTax: 0.3, wealthTax: 0.02, wealthTaxThreshold: 1500, inheritanceTax: 0.5, teachersPer1000: 14, pension: 3.5, socialAidThreshold: 10, socialAidAmount: 3, minWage: 3.5, ubi: 0.5, secuRate: 1, secuTariff: 12, secuContribution: 0.05 },
  },
  assurance: {
    label: 'Assurance obligatoire',
    p: { secuRate: 0, secuRatePoor: 0, secuContribution: 0, insuranceMandatory: true, insuranceCoverage: 0.9, insuranceRiskRating: 0, premiumIncomeCap: 0.08, insuranceMinLossRatio: 0.85 },
  },
};

function buildSidebar() {
  const sb = $('sidebar');
  let html = `<h2>Préréglages</h2><div class="presets">${Object.entries(PRESETS).map(([k, v]) => `<button class="small" data-preset="${k}">${v.label}</button>`).join('')}</div>`;
  for (const [group, defs] of POLICY_GROUPS) {
    html += `<h2>${group}</h2>`;
    for (const d of defs) {
      html += `<div class="slider"><div class="row"><span class="name">${d.label}</span><span class="val" id="v_${d.key}"></span></div>
        <input type="range" id="s_${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" />${d.help ? `<div class="help">${d.help}</div>` : ''}</div>`;
    }
    if (group === 'Dépenses publiques') {
      html += `<label class="check"><input type="checkbox" id="s_indexation" /> <span>Indexation sur les prix<br><span class="help" style="color:var(--muted);font-size:11.5px">Pensions, aides, salaires publics et minimum suivent l’IPC.</span></span></label>`;
    }
    if (group === 'Santé : assurance privée') {
      html += `<label class="check"><input type="checkbox" id="s_insuranceMandatory" /> <span>Assurance obligatoire<br><span class="help" style="color:var(--muted);font-size:11.5px">Chaque foyer prend le contrat le moins cher. Sinon, on s’assure si la prime vaut le risque perçu.</span></span></label>`;
    }
  }
  html += `<h2>Événements</h2><div class="events">${(Object.keys(EVENT_DEFS) as EventKind[]).map((k) => `<button data-event="${k}" title="${EVENT_DEFS[k].desc}">${EVENT_DEFS[k].label}</button>`).join('')}</div><div class="active-events" id="activeEvents"></div>`;
  sb.innerHTML = html;
  for (const [, defs] of POLICY_GROUPS) {
    for (const d of defs) {
      const input = $(`s_${d.key}`) as HTMLInputElement;
      input.addEventListener('input', () => {
        (policy as any)[d.key] = Number(input.value);
        $(`v_${d.key}`).textContent = d.fmt(Number(input.value));
        pushPolicy();
      });
      input.addEventListener('change', () => pushPolicy(true));
    }
  }
  ($('s_indexation') as HTMLInputElement).addEventListener('change', (e) => {
    policy.indexation = (e.target as HTMLInputElement).checked;
    pushPolicy(true);
  });
  ($('s_insuranceMandatory') as HTMLInputElement).addEventListener('change', (e) => {
    policy.insuranceMandatory = (e.target as HTMLInputElement).checked;
    pushPolicy(true);
  });
  sb.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const k = (b as HTMLElement).dataset.preset!;
    policy = { ...DEFAULT_POLICY, ...PRESETS[k].p };
    syncSidebar();
    pushPolicy(true, `Préréglage « ${PRESETS[k].label} »`);
  }));
  sb.querySelectorAll('[data-event]').forEach((b) => b.addEventListener('click', () => send({ type: 'event', kind: (b as HTMLElement).dataset.event as EventKind })));
  syncSidebar();
}

function syncSidebar() {
  for (const [, defs] of POLICY_GROUPS) {
    for (const d of defs) {
      ($(`s_${d.key}`) as HTMLInputElement).value = String(policy[d.key]);
      $(`v_${d.key}`).textContent = d.fmt(policy[d.key] as number);
    }
  }
  ($('s_indexation') as HTMLInputElement).checked = policy.indexation;
  ($('s_insuranceMandatory') as HTMLInputElement).checked = policy.insuranceMandatory;
}

let policyTimer = 0;
let sentPolicy: Policy = { ...policy };
/** Décrit ce qui a changé depuis le dernier envoi, pour le repère sur les graphiques. */
function policyDiff(): string {
  const out: string[] = [];
  for (const [, defs] of POLICY_GROUPS) {
    for (const d of defs) {
      if (policy[d.key] !== sentPolicy[d.key]) out.push(`${d.label} ${d.fmt(sentPolicy[d.key] as number)} → ${d.fmt(policy[d.key] as number)}`);
    }
  }
  if (policy.indexation !== sentPolicy.indexation) out.push(`indexation ${policy.indexation ? 'activée' : 'désactivée'}`);
  if (policy.insuranceMandatory !== sentPolicy.insuranceMandatory) out.push(`assurance ${policy.insuranceMandatory ? 'obligatoire' : 'facultative'}`);
  return out.join(' ; ');
}
/**
 * Envoie la politique au worker. Les valeurs suivent le curseur en direct ; le repère (texte) est
 * posé quand on relâche. Modifier un levier en regardant le passé crée une branche depuis ce jour.
 */
function pushPolicy(commit = false, label?: string) {
  clearTimeout(policyTimer);
  if (!commit && viewDay !== null) return; // dans le passé : on attend que le curseur soit relâché
  policyTimer = window.setTimeout(() => {
    const text = commit ? (label ?? policyDiff()) : '';
    if (commit && viewDay !== null) {
      send({ type: 'fork', day: viewDay });
      viewDay = null;
    }
    send({ type: 'policy', policy, label: text });
    if (commit) sentPolicy = { ...policy };
    store.set('policy', policy);
  }, commit ? 0 : 120);
}

// ---------------------------------------------------------------------------- indicateurs

function renderKpis() {
  if (!snap || !history.length) return;
  const k = snap.kpi;
  const last30 = history.slice(-30);
  const gdp30 = last30.reduce((s, r) => s + r.gdp, 0) / last30.length;
  const hunger30 = last30.reduce((s, r) => s + r.hungerRate, 0) / last30.length;
  const year = history.slice(-360);
  const cpiYearAgo = year[0]?.cpi ?? k.cpi;
  const infl = cpiYearAgo > 0 ? k.cpi / cpiYearAgo - 1 : 0;
  const cards: [string, string, string, string?][] = [
    ['Population', fmt(k.population), `${fmt(history[history.length - 1].enfants)} enfants, ${fmt(history[history.length - 1].retraites)} retraités`],
    ['Ventes au détail', ecu(gdp30), 'par jour (moy. 30 j)'],
    ['Prix (IPC)', fmt(k.cpi), `${infl >= 0 ? '+' : ''}${pct(infl, 1)} sur un an`, Math.abs(infl) > 0.3 ? 'bad' : ''],
    ['Gini patrimoine', fmt(k.giniWealth, 2), `top 10 % : ${pct(k.top10)}`],
    ['Gini revenus', fmt(k.giniIncome, 2), 'adultes, mois écoulé'],
    ['Faim', pct(hunger30, 1), 'nourris à moins de 90 %', hunger30 > 0.05 ? 'bad' : hunger30 < 0.01 ? 'good' : ''],
    ['Santé moyenne', fmt(k.avgHealth), 'sur 100'],
    ['Trésor public', ecu(k.treasury), `payé ${pct(history[history.length - 1].paidRatio)}`],
    ['Entreprises', fmt(k.firms), `≥ 2 personnes`],
    ['Masse monétaire', ecu(k.moneyTotal), k.moneyError === 0 ? 'conservée ✓' : `écart ${fmt(k.moneyError, 2)} !`, k.moneyError === 0 ? '' : 'bad'],
  ];
  $('kpis').innerHTML = cards.map(([l, v, s, cls]) => `<div class="kpi ${cls ?? ''}"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
  const ev = snap.events.map((e) => `${e.label} (${e.daysLeft} j)`).join(', ');
  $('activeEvents').textContent = ev ? `En cours : ${ev}` : '';
  const banner = $('banner');
  if (k.population === 0) {
    banner.innerHTML = '<b>L’île est déserte.</b> Toute la population a disparu. Créez une nouvelle île ou essayez une autre politique.';
    banner.classList.add('on');
  } else if (hunger30 > 0.15) {
    banner.innerHTML = `<b>Crise alimentaire :</b> ${pct(hunger30)} des habitants ont faim. Regardez l’onglet Emploi : les producteurs ont-ils quitté l’agriculture ?`;
    banner.classList.add('on');
  } else banner.classList.remove('on');
}

// ---------------------------------------------------------------------------- rendu

let lastRender = 0;
function render() {
  if (!dirty) return;
  const now = performance.now();
  if (now - lastRender < 400) {
    requestAnimationFrame(render);
    return;
  }
  lastRender = now;
  dirty = false;
  const last = history[history.length - 1];
  $('date').textContent = last ? dateLabel(last.day) : 'Jour 0';
  renderTimeline();
  renderKpis();
  if (currentTab === 'ile') renderGazette();
  if (!history.length) return;
  for (const def of charts) {
    if (def.tab !== currentTab || !def.chart) continue;
    updateWithCompare(def);
  }
  document.querySelectorAll(`.view[data-tab="${currentTab}"] [data-table]`).forEach((c) => (c as any)._render?.());
  if (currentTab === 'habitants' && performance.now() - lastCitizenReq > 1000 && running) requestCitizens();
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'reset':
      fullHistory = [];
      history = fullHistory;
      init = m.init;
      policy = m.policy;
      sentPolicy = { ...policy };
      compare = null;
      viewDay = null;
      syncSidebar();
      break;
    case 'history':
      fullHistory = m.rows;
      marks = m.marks;
      branches = m.branches;
      currentBranch = m.current;
      snapDays = m.snapDays;
      policy = m.policy;
      sentPolicy = { ...policy };
      viewDay = null;
      syncSidebar();
      renderBranches();
      refreshView();
      if (compare) send({ type: 'compare', id: Number(($('compareSel') as HTMLSelectElement).value) || null });
      break;
    case 'branches':
      branches = m.branches;
      currentBranch = m.current;
      renderBranches();
      break;
    case 'compare':
      compare = m.id === null ? null : { name: m.name, color: m.color, rows: m.rows };
      dirty = true;
      requestAnimationFrame(render);
      break;
    case 'view':
      if (viewDay === null) break;
      viewDay = m.day;
      snap = m.snapshot;
      islandMap?.update(m.map, true);
      policy = m.policy;
      syncSidebar();
      refreshView();
      break;
    case 'tick':
      for (const r of m.rows) fullHistory.push(r);
      marks = m.marks;
      snapDays = m.snapDays;
      liveSnap = m.snapshot;
      if (m.map) liveMap = m.map;
      if (viewDay === null) {
        history = fullHistory;
        snap = m.snapshot;
        if (m.map) islandMap?.update(m.map);
      }
      {
        const b = branches.find((x) => x.id === currentBranch);
        if (b && fullHistory.length) b.lastDay = fullHistory[fullHistory.length - 1].day;
      }
      running = m.running;
      updatePlay();
      $('perf').textContent = m.msPerDay ? `${fmt(m.msPerDay, 1)} ms/jour` : '';
      dirty = true;
      requestAnimationFrame(render);
      break;
    case 'agent':
      renderAgent(m.detail);
      break;
    case 'agents':
      $('cTotal').textContent = `${m.total} habitant(s)${m.total > m.rows.length ? `, ${m.rows.length} affichés` : ''}`;
      $('cTable').innerHTML = agentTable(m.rows);
      break;
    case 'error':
      $('banner').innerHTML = `<b>Erreur de simulation :</b> <code>${esc(m.message)}</code>`;
      $('banner').classList.add('on');
      break;
  }
};

// ---------------------------------------------------------------------------- contrôles

function updatePlay() {
  $('play').textContent = running ? '⏸ Pause' : '▶ Lancer';
}
$('play').addEventListener('click', () => {
  if (viewDay !== null) {
    viewDay = null;
    refreshView();
  }
  running = !running;
  updatePlay();
  send({ type: 'run', running });
});
const stepTo = (days: number) => {
  if (viewDay !== null) {
    viewDay = null;
    refreshView();
  }
  send({ type: 'step', days });
};
$('stepDay').addEventListener('click', () => stepTo(1));
$('stepMonth').addEventListener('click', () => stepTo(30));
$('stepYear').addEventListener('click', () => stepTo(360));
$('zoneClose').addEventListener('click', () => ($('zoneDialog') as HTMLDialogElement).close());
($('speed') as HTMLSelectElement).value = String(store.get('speed', 30));
send({ type: 'speed', daysPerSecond: Number(($('speed') as HTMLSelectElement).value) });
$('speed').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLSelectElement).value);
  store.set('speed', v);
  send({ type: 'speed', daysPerSecond: v });
});
$('toggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
$('agentClose').addEventListener('click', () => ($('agentDialog') as HTMLDialogElement).close());
$('reset').addEventListener('click', () => {
  ($('rSeed') as HTMLInputElement).value = String(Math.floor(Math.random() * 1e6));
  ($('rPop') as HTMLInputElement).value = String(init.population);
  ($('rMoney') as HTMLInputElement).value = String(init.moneyPerInhabitant);
  ($('rState') as HTMLInputElement).value = String(Math.round(init.stateShare * 100));
  ($('resetDialog') as HTMLDialogElement).showModal();
});
$('rCancel').addEventListener('click', () => ($('resetDialog') as HTMLDialogElement).close());
$('rGo').addEventListener('click', () => {
  init = {
    seed: Number(($('rSeed') as HTMLInputElement).value) || 1,
    population: Math.max(100, Math.min(3000, Number(($('rPop') as HTMLInputElement).value) || 1000)),
    moneyPerInhabitant: Math.max(10, Number(($('rMoney') as HTMLInputElement).value) || 300),
    stateShare: Math.max(0, Math.min(0.8, Number(($('rState') as HTMLInputElement).value) / 100)),
  };
  store.set('init', init);
  ($('resetDialog') as HTMLDialogElement).close();
  running = false;
  updatePlay();
  send({ type: 'run', running: false });
  send({ type: 'init', init, policy });
});
$('export').addEventListener('click', () => {
  const cols: [string, (r: DayStats) => number][] = [
    ['jour', (r) => r.day], ['population', (r) => r.population], ['enfants', (r) => r.enfants], ['actifs', (r) => r.actifs], ['retraites', (r) => r.retraites],
    ['naissances', (r) => r.births], ['deces_age', (r) => r.deaths.age], ['deces_maladie', (r) => r.deaths.maladie], ['deces_faim', (r) => r.deaths.faim],
    ['ventes_detail', (r) => r.gdp], ['ventes_gros', (r) => r.wholesaleValue], ['ipc', (r) => r.cpi], ['gini_patrimoine', (r) => r.giniWealth], ['gini_revenu', (r) => r.giniIncome],
    ['top10', (r) => r.top10Wealth], ['bottom50', (r) => r.bottom50Wealth], ['faim', (r) => r.hungerRate], ['sante', (r) => r.avgHealth], ['tresor', (r) => r.treasury],
    ['argent_menages', (r) => r.moneyHouseholds], ['argent_entreprises', (r) => r.moneyBusinesses], ['entreprises', (r) => r.firms], ['salaries', (r) => r.employees],
    ['poissons', (r) => r.fishStock], ['foret', (r) => r.forestStock],
    ['soins_realises', (r) => r.careActs], ['soins_renonces', (r) => r.careDenied], ['soins_sans_medecin', (r) => r.careNoDoctor], ['malades_non_soignes', (r) => r.sickUntreated],
    ['soins_menages', (r) => r.careSpend?.menages ?? NaN], ['soins_secu', (r) => r.careSpend?.secu ?? NaN], ['soins_assurances', (r) => r.careSpend?.assurance ?? NaN],
    ['honoraires', (r) => r.avgFee], ['prime_moyenne', (r) => r.avgPremium], ['assures', (r) => r.insuredRate],
    ...RETAIL_GOODS.map((g) => [`prix_detail_${g}`, (r: DayStats) => r.retailPrice[g] ?? NaN] as [string, (r: DayStats) => number]),
    ...GOODS.map((g) => [`prix_gros_${g}`, (r: DayStats) => r.wholesalePrice[g] ?? NaN] as [string, (r: DayStats) => number]),
    ...JOBS.map((j) => [`actifs_${j}`, (r: DayStats) => r.workersByJob[j]] as [string, (r: DayStats) => number]),
  ];
  const lines = [cols.map((c) => c[0]).join(';'), ...fullHistory.map((r) => cols.map((c) => { const v = c[1](r); return Number.isFinite(v) ? String(+v.toFixed(4)) : ''; }).join(';'))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ile-graine${init.seed}-${(branches.find((b) => b.id === currentBranch)?.name ?? 'branche').replace(/\W+/g, '_')}-jour${fullHistory[fullHistory.length - 1]?.day ?? 0}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------------------------------------------------------------------------- le modèle (texte)

function buildModel(v: HTMLElement) {
  const card = document.createElement('div');
  card.className = 'card wide prose';
  card.innerHTML = `
  <h3>Comment fonctionne l’île</h3>
  <p>Un pas de simulation = un jour (un mois = 30 jours, un an = 360). L’île démarre avec ${init.population} habitants et une <b>masse monétaire fixe</b> : ${init.moneyPerInhabitant} écus par habitant, distribués à égalité (${Math.round(init.stateShare * 100)} % vont à l’État). Aucun écu n’est créé ni détruit ; l’indicateur « masse monétaire » le vérifie à chaque jour.</p>
  <h3>Les filières</h3>
  <ul>
    <li><b>Producteurs</b> : céréaliers (blé), pêcheurs (poisson frais), éleveurs (lait + bétail), aviculteurs (œufs), arboriculteurs (fruits), bûcherons (bois). La terre a une capacité limitée (rendements décroissants au-delà) ; le poisson et la forêt sont des stocks qui se renouvellent (croissance logistique) et peuvent être surexploités.</li>
    <li><b>Transformateurs</b> : boulanger (blé → pain), poissonnier (poisson frais → préparé), boucher (bétail → viande), fromager (lait → fromage), charpentier (bois → outils), artisan (bois → artisanat : meubles, vêtements…).</li>
    <li><b>Commerçants</b> : seuls à vendre aux ménages. Ils achètent en gros, paient une taxe sur leurs locaux, ont une capacité de vente limitée par travailleur (et par leurs outils), et fixent leur prix = coût d’achat × marge.</li>
    <li><b>Santé</b> : médecins libéraux (vendent des journées de soin) et assureurs santé (vendent des contrats).</li>
    <li><b>Service public</b> : enseignants (instruisent les enfants), payés par l’État.</li>
  </ul>
  <p>Les produits frais périment (pain 3 j, poisson 2 j, viande 4 j…) : ce qui n’est pas vendu à temps est gaspillé. Les outils augmentent la productivité (+50 % avec un outil par travailleur) et s’usent de 1 % par jour.</p>
  <h3>Les marchés : des enchères quotidiennes</h3>
  <p>Chaque jour, pour chaque bien, deux enchères à prix uniforme se tiennent : le <b>marché de gros</b> (entre entreprises) puis le <b>marché de détail</b> (commerçants → ménages). Les ordres d’achat sont classés du plus offrant au moins offrant, les ordres de vente du moins cher au plus cher ; on apparie tant que l’acheteur offre au moins le prix demandé, et tout s’échange au même prix d’équilibre.</p>
  <p>Les vendeurs apprennent : s’ils ont tout vendu ils montent leur prix ; si leur stock dépasse quelques jours de production ils le baissent. Un transformateur ne vend pas sous le coût de ses intrants plus un revenu de référence, et ne paie jamais un intrant plus que ce que rapporte le produit fini. Les transformateurs ne produisent que ce qu’ils pensent vendre.</p>
  <h3>Les ménages</h3>
  <p>Un adulte a besoin d’une unité de nutrition par jour (un enfant 0,7). Chaque foyer garde environ deux jours de nourriture et choisit ses aliments selon ses goûts et le rapport nutrition / prix. La nourriture passe avant tout ; ensuite vient le chauffage (bois, au plus 10 % du budget), puis l’artisanat avec une part du revenu et de l’épargne au-delà d’un matelas de précaution. À l’aise, on mange un peu plus et mieux (loi d’Engel). Les indépendants qui produisent de la nourriture en gardent pour leur foyer.</p>
  <h3>Travail, entreprises, patrons</h3>
  <p>Au départ tout le monde est indépendant. Chaque mois :</p>
  <ul>
    <li>une entreprise prospère qui a de la trésorerie <b>recrute</b> ; un indépendant en difficulté du même métier la rejoint en apportant son affaire (stock, outils, trésorerie) contre des parts ;</li>
    <li>deux indépendants en difficulté peuvent <b>se regrouper</b> : chacun apporte son affaire et un quart de son épargne. <b>Le patron est celui qui apporte le plus de capital</b>, les parts sont proportionnelles aux apports ;</li>
    <li>les salariés touchent 70 % de la valeur ajoutée par travailleur (jamais moins que le salaire minimum) ; le reste va aux actionnaires sous forme de dividendes ; une entreprise qui ne couvre plus ses salaires licencie ;</li>
    <li>chaque jour, un trentième des actifs réexamine son métier et peut se <b>reconvertir</b> si un autre métier rapporte nettement plus (plus l’écart est grand, plus c’est probable).</li>
  </ul>
  <p>Les entreprises ont un bonus d’échelle (+5 % par travailleur supplémentaire, jusqu’à +25 %), ce qui favorise la concentration.</p>
  <h3>Démographie et santé</h3>
  <p>La santé baisse en cas de sous-alimentation, de froid ou de maladie non soignée ; elle tombe à zéro = décès. Le risque de mourir de vieillesse croît avec l’âge (loi de Gompertz). Les adultes de 18 à 42 ans en bonne santé, nourris et pas trop pauvres ont des enfants. À 16 ans on choisit un métier, à l’âge de la retraite on touche une pension. Au décès, l’argent (après droits de succession) et les parts d’entreprises vont aux enfants, sinon à l’État.</p>
  <h3>Le système de santé</h3>
  <p>On tombe malade plus souvent avec l’âge, une santé fragile ou la faim (huit fois plus pendant une épidémie). Une maladie sur dix environ est <b>grave</b> (plus souvent chez les âgés) : elle demande dix journées de soin, et sans soins elle fait perdre 2,5 points de santé par jour et ne guérit d’elle-même que rarement (4 % de chances par jour). Une maladie bénigne guérit en une journée de soin. Dès 60 ans, on consulte aussi pour un <b>suivi</b> tous les mois : il rattrape une partie de la santé perdue avec l’âge et réduit donc la mortalité.</p>
  <p>Les <b>médecins sont libéraux</b> : chacun soigne environ une personne par jour et fixe ses honoraires. Un cabinet plein qui refuse des patients augmente ses prix, un cabinet peu occupé les baisse ; des honoraires élevés attirent de nouveaux médecins (il faut un bon niveau d’éducation). Chaque jour, les malades (les plus atteints d’abord) puis les personnes suivies vont chez le médecin le moins cher qui a de la place.</p>
  <p>La facture est partagée : la <b>sécurité sociale</b> paie un pourcentage d’un tarif de référence (financée par une cotisation sur tous les revenus), et peut prendre en charge les honoraires des foyers modestes ; l’<b>assureur</b> du foyer paie une part de ce qui reste ; le foyer paie le solde. Pour une maladie, il accepte d’y consacrer une grosse part de son épargne ; pour un suivi, seulement une petite part de ce qui dépasse son épargne de précaution. Sinon il <b>renonce aux soins</b>.</p>
  <p>Les <b>assureurs</b> fixent une prime par unité de risque (un adulte de 40 à 59 ans = 1 ; un enfant 0,5, un jeune adulte 0,6, 60–74 ans 2,2, 75 ans et plus 3,5 ; la réglementation peut écraser ces écarts). Leur prime couvre les sinistres attendus (statistiques de la population, puis leur propre expérience), leurs frais (un assureur gère environ 1000 personnes) et une marge, qui monte quand ils sont pleins et baisse quand ils perdent des clients. Ils gardent deux mois de sinistres en réserve. Chaque mois, un foyer sur quatre réexamine son contrat : il s’assure si la prime ne dépasse pas ce qu’il espère se faire rembourser, majoré de son aversion au risque (plus forte s’il est pauvre face à une maladie grave), et s’il peut la payer. Il connaît son risque mieux que l’assureur : avec une prime unique, les jeunes en bonne santé partent, les primes montent, d’autres partent… c’est l’<b>antisélection</b>. L’assurance obligatoire l’empêche ; le subside rend la prime abordable aux revenus modestes.</p>
  <h3>L’État</h3>
  <p>Il prélève impôt sur le revenu (deux tranches, mensuel), cotisation santé, TVA, impôt sur les sociétés, impôt sur la fortune, droits de succession et taxe sur les locaux. Il paie les enseignants, les pensions, l’aide sociale et le revenu universel, dans cet ordre de priorité ; s’il manque d’argent, il paie au prorata. Les remboursements de soins et les subsides aux primes sont payés au fil de l’eau, tant que la caisse le permet. Avec la règle de reversement, l’excédent au-delà de N jours de dépenses est rendu aux adultes : sans elle, un État excédentaire retire de la monnaie du circuit et provoque une déflation.</p>
  <h3>Remonter le temps, comparer des scénarios</h3>
  <p>La simulation garde un instantané complet de l’île chaque mois pendant la dernière année, puis un par an. Faites glisser la <b>ligne du temps</b> pour revoir l’île et les graphiques à une date passée. « Reprendre d’ici » crée une <b>branche</b> : l’histoire repart de ce jour, et l’ancienne reste intacte. Modifier un levier pendant qu’on regarde le passé crée aussi une branche. Choisissez une autre branche dans « Comparer avec » pour voir ses courbes en pointillés sur les mêmes graphiques.</p>
  <p>Chaque décision (levier relâché, préréglage) et chaque événement posent un repère vertical sur les graphiques et sur la ligne du temps, pour lire l’avant et l’après. Les instantanés tiennent en mémoire dans l’onglet du navigateur : recharger la page repart de zéro.</p>
  <h3>Ce qu’on peut observer</h3>
  <ul>
    <li>Même avec une distribution égale au départ, les inégalités apparaissent vite (chance, métier, héritage, capital).</li>
    <li>Les cycles « du porc » : un métier mal payé se vide, le produit se raréfie, son prix monte, le métier se remplit, etc.</li>
    <li>Des <b>crises alimentaires</b> peuvent émerger quand trop de producteurs partent vers des métiers mieux payés : les pauvres sont touchés en premier.</li>
    <li>La surpêche quand le poisson est cher, l’effet des quotas, l’effet des impôts et des aides sur la pauvreté et la concentration du capital.</li>
  </ul>
  <p class="desc">Limites de la v1 : pas de crédit ni de banque, pas de logement, pas de commerce extérieur, un seul type d’artisanat, des comportements simples (pas d’anticipation).</p>`;
  v.appendChild(card);
}

// ---------------------------------------------------------------------------- démarrage

buildSidebar();
buildViews();
send({ type: 'init', init, policy });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
