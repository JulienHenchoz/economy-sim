// Enveloppe du cœur Rust compilé en WebAssembly (sim-rs/src/wasm.rs) : la simulation et les
// instantanés de la ligne du temps vivent dans la mémoire du module, les échanges se font en JSON.
import wasmUrl from '../wasm/ile.wasm?url';
import type { InitConfig, Policy } from './config';
import type { AgentRow, DayStats, MapState, NewsItem, Snapshot } from './types';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  out_ptr(): number;
  sim_new(ptr: number, len: number): number;
  sim_free(id: number): void;
  sim_step(id: number, days: number): void;
  sim_day(id: number): number;
  sim_all_dead(id: number): number;
  sim_history_len(id: number): number;
  sim_history(id: number, from: number): number;
  sim_snapshot(id: number): number;
  sim_map(id: number): number;
  sim_policy(id: number): number;
  sim_init(id: number): number;
  sim_set_policy(id: number, ptr: number, len: number): void;
  sim_say(id: number, ptr: number, len: number): void;
  sim_event(id: number, ptr: number, len: number): void;
  sim_last_news(id: number): number;
  sim_agent(id: number, agent: number): number;
  sim_agents(id: number, ptr: number, len: number): number;
  snap_save(id: number): number;
  snap_free(snap: number): void;
  sim_restore(snap: number, src: number, rows: number): number;
}

let w: Exports;
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function loadWasm(): Promise<void> {
  const res = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
  w = res.instance.exports as unknown as Exports;
}

/** Copie un texte dans la mémoire du module (libéré par la fonction appelée). */
function send(s: string): [number, number] {
  const b = enc.encode(s);
  const p = w.alloc(b.length);
  new Uint8Array(w.memory.buffer, p, b.length).set(b);
  return [p, b.length];
}
const text = (len: number) => dec.decode(new Uint8Array(w.memory.buffer, w.out_ptr(), len));
const json = <T>(len: number): T => JSON.parse(text(len)) as T;

export type AgentDetail = AgentRow & Record<string, unknown>;
export interface AgentsQuery {
  sort: 'wealth' | 'income' | 'age' | 'health';
  dir: 1 | -1;
  job: string;
  status: string;
  search: string;
  limit: number;
}

export class WasmSim {
  private constructor(readonly id: number) {}

  static create(init: Partial<InitConfig>, policy: Partial<Policy>): WasmSim {
    return new WasmSim(w.sim_new(...send(JSON.stringify({ init, policy }))));
  }
  /** Simulation vivante reprise d'un instantané, avec les `rows` premières lignes d'historique de `src`. */
  static restore(snap: number, src: WasmSim, rows: number): WasmSim {
    return new WasmSim(w.sim_restore(snap, src.id, rows));
  }
  free(): void {
    w.sim_free(this.id);
  }
  step(days = 1): void {
    w.sim_step(this.id, days);
  }
  get day(): number {
    return w.sim_day(this.id);
  }
  allDead(): boolean {
    return w.sim_all_dead(this.id) !== 0;
  }
  historyLength(): number {
    return w.sim_history_len(this.id);
  }
  history(from = 0): DayStats[] {
    return json(w.sim_history(this.id, from));
  }
  snapshot(): Snapshot {
    return json(w.sim_snapshot(this.id));
  }
  mapState(): MapState {
    return json(w.sim_map(this.id));
  }
  get policy(): Policy {
    return json(w.sim_policy(this.id));
  }
  get init(): InitConfig {
    return json(w.sim_init(this.id));
  }
  setPolicy(p: Partial<Policy>): void {
    w.sim_set_policy(this.id, ...send(JSON.stringify(p)));
  }
  say(kind: NewsItem['kind'], text: string): void {
    w.sim_say(this.id, ...send(JSON.stringify({ kind, text })));
  }
  triggerEvent(kind: string): void {
    w.sim_event(this.id, ...send(kind));
  }
  lastNews(): string {
    return text(w.sim_last_news(this.id));
  }
  agentDetail(id: number): AgentDetail | null {
    return json(w.sim_agent(this.id, id));
  }
  agents(q: AgentsQuery): { rows: AgentRow[]; total: number } {
    return json(w.sim_agents(this.id, ...send(JSON.stringify(q))));
  }
  /** Instantané de l'état (sans l'historique) ; à libérer avec `freeSnap`. */
  save(): number {
    return w.snap_save(this.id);
  }
}

export function freeSnap(snap: number): void {
  w.snap_free(snap);
}
