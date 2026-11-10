// Carte animée de l'île : zones de travail, habitants (couleur = richesse), pièces qui circulent.
import { JOBS, JOB_DEFS, type Job } from '../sim/config';
import { agentName, type FlowNode, type MapAgent, type MapState } from '../sim/types';

const W = 1000;
const H = 680;
const CX = 500;
const CY = 340;

interface Zone {
  x: number;
  y: number;
  r: number;
  label: string;
  icon: string;
  color: string;
}

/** Lieu de travail de chaque métier. */
const ZONES: Record<Job, Zone> = {
  cerealier: { x: 235, y: 345, r: 85, label: 'Champs de blé', icon: '🌾', color: '#e2c044' },
  eleveur: { x: 440, y: 140, r: 70, label: 'Pâturages', icon: '🐄', color: '#8fbf5a' },
  arboriculteur: { x: 690, y: 150, r: 65, label: 'Vergers', icon: '🍎', color: '#6aa84f' },
  aviculteur: { x: 815, y: 330, r: 55, label: 'Poulaillers', icon: '🐔', color: '#e69138' },
  bucheron: { x: 245, y: 185, r: 70, label: 'Forêt', icon: '🌲', color: '#38761d' },
  pecheur: { x: 470, y: 600, r: 45, label: 'Port', icon: '⚓', color: '#4fa3d1' },
  poissonnier: { x: 585, y: 560, r: 30, label: 'Poissonnerie', icon: '🐟', color: '#2b6cb0' },
  boulanger: { x: 395, y: 360, r: 32, label: 'Boulangeries', icon: '🥖', color: '#b7791f' },
  boucher: { x: 610, y: 445, r: 28, label: 'Boucheries', icon: '🥩', color: '#c53030' },
  fromager: { x: 420, y: 455, r: 28, label: 'Fromageries', icon: '🧀', color: '#d4b106' },
  charpentier: { x: 340, y: 255, r: 26, label: 'Charpentiers', icon: '🔨', color: '#718096' },
  artisan: { x: 655, y: 305, r: 40, label: 'Ateliers', icon: '🪑', color: '#d53f8c' },
  commercant: { x: 515, y: 385, r: 45, label: 'Marché', icon: '🏪', color: '#805ad5' },
  medecin: { x: 600, y: 225, r: 22, label: 'Cabinets médicaux', icon: '⚕️', color: '#e53e3e' },
  assureur: { x: 567, y: 125, r: 18, label: 'Assurances', icon: '📋', color: '#3182ce' },
  enseignant: { x: 455, y: 255, r: 22, label: 'École', icon: '🏫', color: '#319795' },
  petrolier: { x: 165, y: 470, r: 26, label: 'Puits de pétrole', icon: '🛢️', color: '#1a202c' },
  gazier: { x: 850, y: 215, r: 24, label: 'Gisement de gaz', icon: '🔥', color: '#a0aec0' },
  energieVerte: { x: 750, y: 575, r: 32, label: 'Éoliennes et panneaux', icon: '🌬️', color: '#38a169' },
  administrateur: { x: 565, y: 338, r: 14, label: 'Administration', icon: '🗂️', color: '#4a5568' },
  policier: { x: 378, y: 300, r: 16, label: 'Police et tribunal', icon: '⚖️', color: '#2c5282' },
  infirmier: { x: 645, y: 238, r: 16, label: 'Centre de santé', icon: '🩺', color: '#f687b3' },
  garde: { x: 165, y: 260, r: 18, label: 'Gardes nature', icon: '🦌', color: '#276749' },
  cantonnier: { x: 705, y: 398, r: 18, label: 'Travaux publics', icon: '🚧', color: '#975a16' },
};
const TOWN_HALL = { x: 530, y: 300, label: 'Mairie', icon: '🏛️' };
/** Quartiers d'habitation. */
const QUARTERS = [
  { x: 300, y: 480, r: 95 },
  { x: 740, y: 460, r: 90 },
  { x: 535, y: 500, r: 45 },
];

const RICH_COLORS = ['#c53030', '#dd6b20', '#d69e2e', '#38a169', '#2b6cb0'];

function hash(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function inDisk(seed: number, cx: number, cy: number, r: number): [number, number] {
  const a = hash(seed) * Math.PI * 2;
  const d = Math.sqrt(hash(seed + 7919)) * r;
  return [cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8];
}
function islandRadius(t: number): number {
  return 1 + 0.07 * Math.sin(3 * t + 1) + 0.045 * Math.sin(5 * t + 2) + 0.025 * Math.sin(9 * t + 0.5);
}
function homeOf(head: number): [number, number] {
  const q = QUARTERS[Math.floor(hash(head * 31) * 100) % 100 < 44 ? 0 : hash(head * 31) < 0.88 ? 1 : 2];
  return inDisk(head * 13 + 1, q.x, q.y, q.r);
}

interface Dot {
  x: number;
  y: number;
  tx: number;
  ty: number;
  a: MapAgent;
}
interface Coin {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  color: string;
}

export class IslandMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private dots = new Map<number, Dot>();
  private coins: Coin[] = [];
  private state: MapState | null = null;
  private visible = false;
  private animating = false;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private last = performance.now();
  private spawnAcc = 0;
  private hover: Dot | null = null;
  private island: Path2D;
  private trees: [number, number][] = [];
  live = true;

  constructor(
    host: HTMLElement,
    private opts: { onAgent: (id: number) => void; onZone: (job: Job | 'mairie') => void; isRunning: () => boolean },
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'island';
    host.appendChild(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    host.appendChild(this.tip);
    this.ctx = this.canvas.getContext('2d')!;
    this.island = new Path2D();
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      const r = islandRadius(t);
      const x = CX + Math.cos(t) * 430 * r;
      const y = CY + Math.sin(t) * 290 * r;
      if (i === 0) this.island.moveTo(x, y);
      else this.island.lineTo(x, y);
    }
    const f = ZONES.bucheron;
    for (let i = 0; i < 26; i++) this.trees.push(inDisk(i * 97 + 3, f.x, f.y, f.r * 0.95));
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.style.display = 'none';
    });
    this.canvas.addEventListener('click', (e) => this.onClick(e));
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v && !this.animating) {
      this.animating = true;
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const w = Math.max(280, r.width);
    const h = Math.min(window.innerHeight * 0.72, (w * H) / W);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = Math.min(w / W, h / H) * dpr;
    this.ox = (w * dpr - W * this.scale) / 2;
    this.oy = (h * dpr - H * this.scale) / 2;
  }

  /** Nouvel état de l'île (toutes les ~250 ms pendant la simulation). */
  update(m: MapState, instant = false) {
    this.state = m;
    const seen = new Set<number>();
    for (const a of m.agents) {
      seen.add(a.id);
      const [tx, ty] = this.target(a);
      let d = this.dots.get(a.id);
      if (!d) {
        d = { x: tx, y: ty, tx, ty, a };
        this.dots.set(a.id, d);
      }
      d.a = a;
      d.tx = tx;
      d.ty = ty;
      if (instant) {
        d.x = tx;
        d.y = ty;
      }
    }
    for (const id of [...this.dots.keys()]) if (!seen.has(id)) this.dots.delete(id);
    if (instant) this.coins = [];
  }

  private target(a: MapAgent): [number, number] {
    if (a.status === 1 && a.job >= 0) {
      const z = ZONES[JOBS[a.job]];
      if (a.publicJob) return inDisk(a.id * 3 + 11, z.x, z.y, z.r * 0.7);
      const [bx, by] = inDisk(a.biz * 17 + 5, z.x, z.y, z.r * 0.75);
      const k = hash(a.id * 5 + 2) * Math.PI * 2;
      return [bx + Math.cos(k) * 5, by + Math.sin(k) * 5];
    }
    const [hx, hy] = homeOf(a.home);
    const k = hash(a.id * 7 + 1) * Math.PI * 2;
    return [hx + Math.cos(k) * 4, hy + Math.sin(k) * 4];
  }

  private nodePos(n: FlowNode): [number, number] {
    const r = Math.random();
    switch (n) {
      case 'menages': {
        const q = QUARTERS[r < 0.45 ? 0 : r < 0.9 ? 1 : 2];
        return inDisk(Math.floor(Math.random() * 1e6), q.x, q.y, q.r);
      }
      case 'commerce':
        return inDisk(Math.floor(Math.random() * 1e6), ZONES.commercant.x, ZONES.commercant.y, 30);
      case 'etat':
        return [TOWN_HALL.x, TOWN_HALL.y];
      case 'production': {
        const z = ZONES[(['cerealier', 'eleveur', 'arboriculteur', 'aviculteur', 'bucheron', 'pecheur'] as Job[])[Math.floor(r * 6)]];
        return [z.x, z.y];
      }
      case 'transformation': {
        const z = ZONES[(['boulanger', 'boucher', 'fromager', 'poissonnier', 'charpentier', 'artisan'] as Job[])[Math.floor(r * 6)]];
        return [z.x, z.y];
      }
      case 'sante':
        return [ZONES.medecin.x, ZONES.medecin.y];
      case 'assurance':
        return [ZONES.assureur.x, ZONES.assureur.y];
    }
  }

  private spawnCoins(dt: number) {
    const m = this.state;
    if (!m || !m.flows.length || !this.opts.isRunning() || !this.live) return;
    this.spawnAcc += dt * 45;
    const total = m.flows.reduce((s, f) => s + f.value, 0);
    if (total <= 0) return;
    while (this.spawnAcc >= 1 && this.coins.length < 260) {
      this.spawnAcc -= 1;
      let r = Math.random() * total;
      const f = m.flows.find((x) => (r -= x.value) <= 0) ?? m.flows[0];
      const [x0, y0] = this.nodePos(f.from);
      const [x1, y1] = this.nodePos(f.to);
      const color = f.to === 'etat' ? '#2f9e5a' : f.from === 'etat' ? '#3b82f6' : '#e8b923';
      this.coins.push({ x0, y0, x1, y1, t: 0, dur: 1 + Math.random() * 0.6, color });
    }
    this.spawnAcc = Math.min(this.spawnAcc, 5);
  }

  private frame(now: number) {
    if (!this.visible) {
      this.animating = false;
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.spawnCoins(dt);
    const k = 1 - Math.pow(0.02, dt);
    for (const d of this.dots.values()) {
      d.x += (d.tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
    }
    for (const c of this.coins) c.t += dt / c.dur;
    this.coins = this.coins.filter((c) => c.t < 1);
    this.draw(now);
    requestAnimationFrame((t) => this.frame(t));
  }

  private draw(now: number) {
    const g = this.ctx;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = dark ? '#0d2a3a' : '#a9d6ee';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    const m = this.state;
    const ev = new Set(m?.events ?? []);

    // vagues et poissons
    g.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.35)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) {
      const y = 20 + i * 50 + Math.sin(now / 1500 + i) * 4;
      g.beginPath();
      for (let x = -20; x <= W + 20; x += 20) g.lineTo(x, y + Math.sin(x / 40 + now / 900 + i) * 3);
      g.stroke();
    }
    const nFish = Math.round((m?.fish ?? 0.6) * 16);
    g.font = '15px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < nFish; i++) {
      const bx = 120 + hash(i * 11) * 760;
      const by = 640 + hash(i * 13) * 35;
      g.fillText('🐟', bx + Math.sin(now / 1200 + i) * 12, by + Math.cos(now / 1500 + i) * 4);
    }
    if (!ev.has('tempete')) {
      const boats = Math.min(6, Math.ceil(((m?.agents.filter((a) => a.job === JOBS.indexOf('pecheur')).length ?? 0) / 12)));
      g.font = '20px system-ui';
      for (let i = 0; i < boats; i++) g.fillText('⛵', 330 + i * 70 + Math.sin(now / 2000 + i) * 10, 658 + Math.sin(now / 1300 + i * 2) * 3);
    }

    // île
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.25)';
    g.shadowBlur = 18;
    g.fillStyle = dark ? '#c9b98a' : '#efe0b0';
    g.fill(this.island);
    g.restore();
    g.save();
    g.translate(CX, CY);
    g.scale(0.955, 0.94);
    g.translate(-CX, -CY);
    g.fillStyle = dark ? '#2f4a2c' : '#b9d99a';
    g.fill(this.island);
    g.restore();

    // routes vers le marché
    g.strokeStyle = dark ? 'rgba(230,210,170,0.25)' : 'rgba(150,120,70,0.35)';
    g.lineWidth = 6;
    g.lineCap = 'round';
    for (const j of JOBS) {
      const z = ZONES[j];
      g.beginPath();
      g.moveTo(ZONES.commercant.x, ZONES.commercant.y);
      g.quadraticCurveTo((z.x + ZONES.commercant.x) / 2 + 20, (z.y + ZONES.commercant.y) / 2 - 20, z.x, z.y);
      g.stroke();
    }

    // zones
    const prod = m?.production ?? {};
    for (const j of JOBS) {
      const z = ZONES[j];
      let alpha = 0.28;
      if (j === 'cerealier') alpha = 0.2 + Math.min(0.5, ((prod.ble ?? 0) / 600) * 0.5);
      if (j === 'cerealier' && ev.has('mauvaise_recolte')) g.fillStyle = '#8a6d3b66';
      else g.fillStyle = z.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      g.beginPath();
      g.ellipse(z.x, z.y, z.r, z.r * 0.8, 0, 0, Math.PI * 2);
      g.fill();
    }
    // forêt : un arbre par ~4 % de stock
    const nTrees = Math.round((m?.forest ?? 0.7) * this.trees.length);
    g.font = '18px system-ui';
    for (let i = 0; i < nTrees; i++) g.fillText(ev.has('incendie') && i % 3 === 0 ? '🔥' : '🌲', this.trees[i][0], this.trees[i][1]);
    // maisons
    g.fillStyle = dark ? '#b08968' : '#c08457';
    const homes = new Set<number>();
    for (const d of this.dots.values()) homes.add(d.a.home);
    for (const h of homes) {
      const [x, y] = homeOf(h);
      g.fillRect(x - 2, y - 1, 4, 3.5);
      g.beginPath();
      g.moveTo(x - 3, y - 1);
      g.lineTo(x, y - 4);
      g.lineTo(x + 3, y - 1);
      g.fill();
    }
    // étals du marché
    const shops = Math.min(40, m?.shops ?? 0);
    for (let i = 0; i < shops; i++) {
      const [x, y] = inDisk(i * 41 + 9, ZONES.commercant.x, ZONES.commercant.y, ZONES.commercant.r * 0.9);
      g.fillStyle = ['#e53e3e', '#3182ce', '#d69e2e', '#805ad5'][i % 4];
      g.fillRect(x - 4, y - 3, 8, 3);
      g.fillStyle = dark ? '#ddd' : '#fff';
      g.fillRect(x - 4, y, 8, 3);
    }

    // libellés
    g.font = '600 12px system-ui';
    for (const j of JOBS) {
      const z = ZONES[j];
      if (j === 'bucheron') continue;
      g.font = '20px system-ui';
      g.fillText(z.icon, z.x, z.y - z.r * 0.8 - 2);
    }
    g.font = '24px system-ui';
    g.fillText(TOWN_HALL.icon, TOWN_HALL.x, TOWN_HALL.y);
    if (ev.has('epidemie')) g.fillText('🦠', ZONES.medecin.x + 26, ZONES.medecin.y - 10);
    g.font = '600 11px system-ui';
    g.fillStyle = dark ? 'rgba(255,255,255,0.8)' : 'rgba(30,30,30,0.75)';
    for (const j of JOBS) {
      const z = ZONES[j];
      g.fillText(z.label, z.x, z.y + z.r * 0.8 + 9);
    }
    g.fillText(TOWN_HALL.label, TOWN_HALL.x, TOWN_HALL.y + 18);

    // pièces
    for (const c of this.coins) {
      const t = c.t;
      const x = c.x0 + (c.x1 - c.x0) * t;
      const y = c.y0 + (c.y1 - c.y0) * t - Math.sin(t * Math.PI) * 30;
      g.fillStyle = c.color;
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fill();
    }

    // habitants
    for (const d of this.dots.values()) {
      const a = d.a;
      const r = a.status === 0 ? 1.7 : a.boss ? 3.6 : 2.5;
      g.globalAlpha = a.sick ? 0.4 : 1;
      g.fillStyle = RICH_COLORS[Math.min(4, Math.floor(a.rank * 5))];
      g.beginPath();
      g.arc(d.x, d.y, r, 0, Math.PI * 2);
      g.fill();
      if (a.boss) {
        g.strokeStyle = '#f6c90e';
        g.lineWidth = 1.2;
        g.stroke();
      }
      if (a.hunger > 0.25) {
        g.strokeStyle = `rgba(220,38,38,${0.5 + 0.5 * Math.sin(now / 200 + a.id)})`;
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(d.x, d.y, r + 2.2, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (this.hover) {
      g.strokeStyle = dark ? '#fff' : '#000';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(this.hover.x, this.hover.y, 6, 0, Math.PI * 2);
      g.stroke();
    }
    // pluie de tempête
    if (ev.has('tempete')) {
      g.strokeStyle = 'rgba(80,100,140,0.45)';
      g.lineWidth = 1;
      for (let i = 0; i < 120; i++) {
        const x = (hash(i) * W + now / 3) % W;
        const y = (hash(i + 500) * H + now / 2) % H;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - 4, y + 10);
        g.stroke();
      }
    }
  }

  private toLogical(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [((e.clientX - r.left) * dpr - this.ox) / this.scale, ((e.clientY - r.top) * dpr - this.oy) / this.scale];
  }

  private nearest(x: number, y: number, max = 8): Dot | null {
    let best: Dot | null = null;
    let bd = max * max;
    for (const d of this.dots.values()) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  private zoneAt(x: number, y: number): Job | 'mairie' | null {
    if ((x - TOWN_HALL.x) ** 2 + (y - TOWN_HALL.y) ** 2 < 18 * 18) return 'mairie';
    for (const j of JOBS) {
      const z = ZONES[j];
      if (((x - z.x) / z.r) ** 2 + ((y - z.y) / (z.r * 0.8)) ** 2 < 1) return j;
    }
    return null;
  }

  private onMove(e: MouseEvent) {
    const [x, y] = this.toLogical(e);
    this.hover = this.nearest(x, y);
    const z = this.hover ? null : this.zoneAt(x, y);
    if (this.hover) {
      const a = this.hover.a;
      const st = ['Enfant', 'Actif', 'Sans emploi', 'Retraité'][a.status];
      this.tip.innerHTML = `<b>${agentName(a.id)}</b><br>${a.job >= 0 ? JOB_DEFS[JOBS[a.job]].label : st}${a.boss ? ' — patron·ne' : ''}<br>Plus riche que ${Math.round(a.rank * 100)} % des adultes${a.hunger > 0.25 ? '<br><span style="color:#e53e3e">A faim</span>' : ''}${a.sick ? '<br>Malade' : ''}`;
    } else if (z) {
      this.tip.innerHTML = `<b>${z === 'mairie' ? 'Mairie (État)' : ZONES[z].label}</b><br><span class="muted">Cliquer pour le détail</span>`;
    }
    if (this.hover || z) {
      const r = this.canvas.getBoundingClientRect();
      this.tip.style.display = 'block';
      this.tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 190)}px`;
      this.tip.style.top = `${e.clientY - r.top + 14}px`;
      this.canvas.style.cursor = 'pointer';
    } else {
      this.tip.style.display = 'none';
      this.canvas.style.cursor = 'default';
    }
  }

  private onClick(e: MouseEvent) {
    const [x, y] = this.toLogical(e);
    const d = this.nearest(x, y, 10);
    if (d) return this.opts.onAgent(d.a.id);
    const z = this.zoneAt(x, y);
    if (z) this.opts.onZone(z);
  }
}

export const RICHNESS_COLORS = RICH_COLORS;
