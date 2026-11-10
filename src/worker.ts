/// <reference lib="webworker" />
// Fait tourner la simulation (cœur Rust compilé en WebAssembly) hors du fil principal. Gère aussi la
// ligne du temps : instantanés réguliers, consultation du passé, branches (« et si… ») et repères
// (changements de politique). Les instantanés vivent dans la mémoire du module : on les compte pour
// libérer ceux qu'aucune branche n'utilise plus.
import { WasmSim, freeSnap, loadWasm, type AgentDetail } from './sim/wasm';
import type { AgentRow, DayStats, MapState, Snapshot } from './sim/types';
import type { EventKind, InitConfig, Job, Policy } from './sim/config';

export interface Mark {
  day: number;
  kind: 'politique' | 'evenement' | 'branche';
  text: string;
}

export interface BranchInfo {
  id: number;
  name: string;
  parent: number | null;
  forkDay: number;
  lastDay: number;
  color: string;
}

export type ToWorker =
  | { type: 'init'; init: Partial<InitConfig>; policy: Partial<Policy> }
  | { type: 'run'; running: boolean }
  | { type: 'speed'; daysPerSecond: number }
  | { type: 'step'; days: number }
  | { type: 'policy'; policy: Partial<Policy>; label: string }
  | { type: 'event'; kind: EventKind }
  | { type: 'agent'; id: number }
  | { type: 'agents'; sort: 'wealth' | 'income' | 'age' | 'health'; dir: 1 | -1; job: Job | ''; status: string; search: string; limit: number }
  | { type: 'want'; map: boolean }
  | { type: 'view'; day: number | null }
  | { type: 'fork'; day: number }
  | { type: 'branch'; id: number }
  | { type: 'compare'; id: number | null }
  | { type: 'rename'; id: number; name: string }
  | { type: 'deleteBranch'; id: number };

export type FromWorker =
  | { type: 'reset'; init: InitConfig; policy: Policy }
  | { type: 'history'; rows: DayStats[]; marks: Mark[]; branches: BranchInfo[]; current: number; snapDays: number[]; policy: Policy }
  | { type: 'tick'; rows: DayStats[]; snapshot: Snapshot; map: MapState | null; running: boolean; msPerDay: number; marks: Mark[]; snapDays: number[] }
  | { type: 'view'; day: number; snapshot: Snapshot; map: MapState; policy: Policy }
  | { type: 'compare'; id: number | null; name: string; color: string; rows: DayStats[] }
  | { type: 'branches'; branches: BranchInfo[]; current: number }
  | { type: 'agent'; detail: AgentDetail | null }
  | { type: 'agents'; rows: AgentRow[]; total: number }
  | { type: 'error'; message: string };

const BRANCH_COLORS = ['#1f6f8b', '#e07a2f', '#805ad5', '#38a169', '#d53f8c', '#b7791f', '#2b6cb0', '#c53030'];

interface Branch {
  id: number;
  name: string;
  parent: number | null;
  forkDay: number;
  color: string;
  sim: WasmSim;
  /** Instantanés par jour (numéros dans le module) ; partagés avec les branches filles. */
  snaps: Map<number, number>;
  marks: Mark[];
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let branches: Branch[] = [];
let cur: Branch | null = null;
let nextId = 1;
let running = false;
let speed = 30;
let sent = 0;
let lastPost = 0;
let budget = 0;
let lastTick = performance.now();
let msPerDay = 0;
let wantMap = true;
let viewing: number | null = null;

const sim = () => cur!.sim;
/** Nombre de branches qui utilisent chaque instantané. */
const snapRefs = new Map<number, number>();
function keepSnap(id: number): number {
  snapRefs.set(id, (snapRefs.get(id) ?? 0) + 1);
  return id;
}
function dropSnap(id: number) {
  const n = (snapRefs.get(id) ?? 1) - 1;
  if (n > 0) snapRefs.set(id, n);
  else {
    snapRefs.delete(id);
    freeSnap(id);
  }
}
function dropBranch(b: Branch) {
  for (const id of b.snaps.values()) dropSnap(id);
  b.snaps.clear();
  b.sim.free();
}
const post = (msg: FromWorker) => ctx.postMessage(msg);
const info = (b: Branch): BranchInfo => ({ id: b.id, name: b.name, parent: b.parent, forkDay: b.forkDay, lastDay: b.sim.day, color: b.color });

/**
 * Instantané mensuel. Pour la mémoire : on garde chaque mois de la dernière année, puis un
 * instantané par an au-delà (un instantané pèse 3 à 5 Mo).
 */
function snapshotIfNeeded() {
  const s = sim();
  const day = s.day;
  if (day % 30 !== 0) return;
  const old = cur!.snaps.get(day);
  cur!.snaps.set(day, keepSnap(s.save()));
  if (old !== undefined) dropSnap(old);
  for (const [d, id] of [...cur!.snaps]) {
    if (d === 0 || d === cur!.forkDay) continue;
    if (d < day - 360 && d % 360 !== 0) {
      cur!.snaps.delete(d);
      dropSnap(id);
    }
  }
}

function snapDays(): number[] {
  return [...cur!.snaps.keys()].sort((a, b) => a - b);
}

function sendHistory() {
  if (!cur) return;
  const rows = cur.sim.history(0);
  sent = rows.length;
  post({ type: 'history', rows, marks: cur.marks, branches: branches.map(info), current: cur.id, snapDays: snapDays(), policy: cur.sim.policy });
  flush(true);
}

function flush(force = false) {
  if (!cur || viewing !== null) return;
  const now = performance.now();
  if (!force && now - lastPost < 250) return;
  lastPost = now;
  const s = sim();
  const rows = s.history(sent);
  sent += rows.length;
  post({ type: 'tick', rows, snapshot: s.snapshot(), map: wantMap ? s.mapState() : null, running, msPerDay, marks: cur.marks, snapDays: snapDays() });
}

function stepDays(n: number) {
  if (!cur) return;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    sim().step();
    snapshotIfNeeded();
  }
  if (n > 0) msPerDay = msPerDay * 0.8 + ((performance.now() - t0) / n) * 0.2;
}

function loop() {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (running && cur && viewing === null) {
    try {
      if (speed >= 1000) {
        const t0 = performance.now();
        while (performance.now() - t0 < 40) stepDays(1);
      } else {
        budget = Math.min(budget + dt * speed, 30);
        const n = Math.floor(budget);
        budget -= n;
        stepDays(n);
      }
      if (sim().allDead()) running = false;
    } catch (e) {
      running = false;
      post({ type: 'error', message: String((e as Error)?.stack ?? e) });
    }
    flush();
  }
  setTimeout(loop, 16);
}

/** Instantané le plus récent au plus tard le jour `day`. */
function snapAt(b: Branch, day: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [d, st] of b.snaps) if (d <= day && (!best || d > best[0])) best = [d, st];
  return best;
}

function addMark(m: Mark) {
  cur!.marks.push(m);
}

const ready = loadWasm().then(loop);
ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  await ready;
  try {
    handle(m);
  } catch (e) {
    post({ type: 'error', message: String((e as Error)?.stack ?? e) });
  }
};

function handle(m: ToWorker) {
  switch (m.type) {
    case 'init': {
      for (const b of branches) dropBranch(b);
      const s = WasmSim.create(m.init, m.policy);
      branches = [];
      nextId = 1;
      cur = { id: nextId++, name: 'Principale', parent: null, forkDay: 0, color: BRANCH_COLORS[0], sim: s, snaps: new Map([[0, keepSnap(s.save())]]), marks: [] };
      branches.push(cur);
      viewing = null;
      running = false;
      post({ type: 'reset', init: s.init, policy: s.policy });
      sendHistory();
      break;
    }
    case 'run':
      running = m.running;
      if (running) viewing = null;
      lastTick = performance.now();
      flush(true);
      break;
    case 'speed':
      speed = m.daysPerSecond;
      break;
    case 'step':
      viewing = null;
      stepDays(m.days);
      flush(true);
      break;
    case 'policy':
      if (!cur) break;
      sim().setPolicy(m.policy);
      if (m.label) {
        // regroupe les réglages successifs d'un même jour en un seul repère
        const last = cur.marks[cur.marks.length - 1];
        if (last && last.day === sim().day && last.kind === 'politique') last.text = m.label;
        else addMark({ day: sim().day, kind: 'politique', text: m.label });
        sim().say('politique', `Décision publique : ${m.label}.`);
      }
      break;
    case 'event':
      if (!cur) break;
      sim().triggerEvent(m.kind);
      addMark({ day: sim().day, kind: 'evenement', text: sim().lastNews() || m.kind });
      flush(true);
      break;
    case 'want':
      wantMap = m.map;
      break;
    case 'view': {
      if (!cur) break;
      if (m.day === null || m.day >= sim().day) {
        viewing = null;
        flush(true);
        break;
      }
      running = false;
      viewing = m.day;
      const sn = snapAt(cur, m.day);
      if (!sn) break;
      const tmp = WasmSim.restore(sn[1], sim(), sn[0] + 1);
      post({ type: 'view', day: sn[0], snapshot: tmp.snapshot(), map: tmp.mapState(), policy: tmp.policy });
      tmp.free();
      break;
    }
    case 'fork': {
      if (!cur) break;
      const sn = snapAt(cur, m.day);
      if (!sn) break;
      const [day, st] = sn;
      const parent = cur;
      const s = WasmSim.restore(st, parent.sim, day + 1);
      const snaps = new Map<number, number>();
      for (const [d, x] of parent.snaps) if (d <= day) snaps.set(d, keepSnap(x));
      const id = nextId++;
      const b: Branch = {
        id, name: `Branche ${id}`, parent: parent.id, forkDay: day, color: BRANCH_COLORS[(id - 1) % BRANCH_COLORS.length],
        sim: s, snaps, marks: [...parent.marks.filter((x) => x.day <= day), { day, kind: 'branche', text: `Nouvelle branche depuis « ${parent.name} »` }],
      };
      s.say('politique', `Retour au jour ${day} : début de la branche « ${b.name} ».`);
      branches.push(b);
      cur = b;
      viewing = null;
      running = false;
      sendHistory();
      break;
    }
    case 'branch': {
      const b = branches.find((x) => x.id === m.id);
      if (!b) break;
      cur = b;
      viewing = null;
      running = false;
      sendHistory();
      break;
    }
    case 'compare': {
      const b = m.id === null ? null : branches.find((x) => x.id === m.id);
      post({ type: 'compare', id: b?.id ?? null, name: b?.name ?? '', color: b?.color ?? '', rows: b ? b.sim.history(0) : [] });
      break;
    }
    case 'rename': {
      const b = branches.find((x) => x.id === m.id);
      if (b) b.name = m.name.slice(0, 40) || b.name;
      post({ type: 'branches', branches: branches.map(info), current: cur!.id });
      break;
    }
    case 'deleteBranch': {
      if (branches.length <= 1 || m.id === cur?.id) break;
      const gone = branches.find((x) => x.id === m.id);
      if (gone) dropBranch(gone);
      branches = branches.filter((x) => x.id !== m.id);
      post({ type: 'branches', branches: branches.map(info), current: cur!.id });
      break;
    }
    case 'agent':
      if (cur) post({ type: 'agent', detail: sim().agentDetail(m.id) });
      break;
    case 'agents': {
      if (!cur) break;
      const { rows, total } = sim().agents({ sort: m.sort, dir: m.dir, job: m.job, status: m.status, search: m.search, limit: m.limit });
      post({ type: 'agents', rows, total });
      break;
    }
  }
}
