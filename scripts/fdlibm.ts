// pow, log, log10, exp et cos de fdlibm (V8), sans multiplication-addition fusionnée : exactement les
// fonctions du cœur Rust (sim-rs/src/v8math.rs). Selon la machine, Node les calcule un peu autrement
// (copie de la glibc pour cos, instructions FMA sur ARM), avec un ulp d'écart dans de rares cas : pour
// comparer les deux versions du modèle au bit près, on remplace Math.* par celles-ci avant de lancer
// la simulation TypeScript.
const f64 = new Float64Array(1);
const i32 = new Int32Array(f64.buffer); // petit-boutiste : [1] = mot haut, [0] = mot bas
const u32 = new Uint32Array(f64.buffer);
const hi = (x: number) => ((f64[0] = x), i32[1]);
const lo = (x: number) => ((f64[0] = x), u32[0]);
const withHi = (x: number, h: number) => ((f64[0] = x), (i32[1] = h), f64[0]);
const withLo = (x: number, l: number) => ((f64[0] = x), (u32[0] = l), f64[0]);
const words = (h: number, l: number) => ((i32[1] = h), (u32[0] = l), f64[0]);

function kernelCos(x: number, y: number): number {
  const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5;
  const C4 = -2.75573143513906633035e-7, C5 = 2.08757232129817482790e-9, C6 = -1.13596475577881948265e-11;
  const ix = hi(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : words(ix - 0x00200000, 0);
  const iz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (iz - (z * r - x * y));
}

function kernelSin(x: number, y: number, iy: number): number {
  const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4;
  const S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
  const ix = hi(x) & 0x7fffffff;
  if (ix < 0x3e400000 && (x | 0) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a, 0x402f6a7a,
  0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a,
  0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb, 0x4046c6cb, 0x40478fdb,
  0x404858eb, 0x404921fb,
];

function remPio2(x: number): [number, number, number] | null {
  const INVPIO2 = 6.36619772367581382433e-1, PIO2_1 = 1.57079632673412561417, PIO2_1T = 6.07710050650619224932e-11;
  const PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21;
  const PIO2_3T = 8.47842766036889956997e-32;
  const hx = hi(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) return [0, x, 0];
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) { const y0 = z - PIO2_1T; return [1, y0, (z - y0) - PIO2_1T]; }
      z -= PIO2_2;
      const y0 = z - PIO2_2T;
      return [1, y0, (z - y0) - PIO2_2T];
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) { const y0 = z + PIO2_1T; return [-1, y0, (z - y0) + PIO2_1T]; }
    z += PIO2_2;
    const y0 = z + PIO2_2T;
    return [-1, y0, (z - y0) + PIO2_2T];
  }
  if (ix <= 0x413921fb) {
    let t = Math.abs(x);
    const n = (t * INVPIO2 + 0.5) | 0;
    const fn = n;
    let r = t - fn * PIO2_1;
    let w = fn * PIO2_1T;
    let y0: number;
    if (n < 32 && ix !== NPIO2_HW[n - 1]) y0 = r - w;
    else {
      const j = ix >> 20;
      y0 = r - w;
      let i = j - ((hi(y0) >> 20) & 0x7ff);
      if (i > 16) {
        t = r; w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); y0 = r - w;
        i = j - ((hi(y0) >> 20) & 0x7ff);
        if (i > 49) { t = r; w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); y0 = r - w; }
      }
    }
    const y1 = (r - y0) - w;
    return hx < 0 ? [-n, -y0, -y1] : [n, y0, y1];
  }
  return null;
}

const nativeCos = Math.cos;
const nativePow = Math.pow;
export function fdlibmCos(x: number): number {
  const ix = hi(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const r = remPio2(x);
  if (!r) return nativeCos(x);
  const [n, y0, y1] = r;
  switch (n & 3) {
    case 0: return kernelCos(y0, y1);
    case 1: return -kernelSin(y0, y1, 1);
    case 2: return -kernelCos(y0, y1);
    default: return kernelSin(y0, y1, 1);
  }
}
export function fdlibmExp(x: number): number {
  const HALF = [0.5, -0.5];
  const LN2_HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
  const LN2_LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
  const INVLN2 = 1.44269504088896338700;
  const P1 = 1.66666666666666019037e-1, P2 = -2.77777777770155933842e-3, P3 = 6.61375632143793436117e-5;
  const P4 = -1.65339022054652515390e-6, P5 = 4.13813679705723846039e-8;
  const HUGE = 1.0e300, TWOM1000 = 9.33263618503218878990e-302, TWO1023 = 8.988465674311579539e307;
  let hx = hi(x) >>> 0;
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) return Number.isNaN(x) ? x + x : xsb === 0 ? x : 0;
    if (x > 7.09782712893383973096e2) return HUGE * HUGE;
    if (x < -7.45133219101941108420e2) return TWOM1000 * TWOM1000;
  }
  let hi_ = 0, lo_ = 0, k = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      if (x === 1) return 2.718281828459045;
      hi_ = x - LN2_HI[xsb];
      lo_ = LN2_LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = (INVLN2 * x + HALF[xsb]) | 0;
      const t = k;
      hi_ = x - t * LN2_HI[0];
      lo_ = t * LN2_LO[0];
    }
    x = hi_ - lo_;
  } else if (hx < 0x3e300000) {
    if (HUGE + x > 1) return 1 + x;
  } else k = 0;
  const t = x * x;
  const twopk = k >= -1021 ? words((0x3ff00000 + (k << 20)) | 0, 0) : words((0x3ff00000 + ((k + 1000) << 20)) | 0, 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo_ - (x * c) / (2 - c)) - hi_);
  if (k >= -1021) return k === 1024 ? y * 2 * TWO1023 : y * twopk;
  return y * twopk * TWOM1000;
}

export function fdlibmLog(x: number): number {
  const LN2_HI = 6.93147180369123816490e-1, LN2_LO = 1.90821492927058770002e-10, TWO54 = 1.80143985094819840000e16;
  const LG1 = 6.666666666666735130e-1, LG2 = 3.999999999940941908e-1, LG3 = 2.857142874366239149e-1, LG4 = 2.222219843214978396e-1;
  const LG5 = 1.818357216161805012e-1, LG6 = 1.531383769920937332e-1, LG7 = 1.479819860511658591e-1;
  let hx = hi(x);
  const lx = lo(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = hi(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i0 ^ 0x3ff00000));
  k += i0 >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2 + f);
  const dk = k;
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

export function fdlibmLog10(x: number): number {
  const TWO54 = 1.80143985094819840000e16, IVLN10 = 4.34294481903251816668e-1;
  const LOG10_2HI = 3.01029995663611771306e-1, LOG10_2LO = 3.69423907715893078616e-13;
  let hx = hi(x);
  let lx = lo(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = hi(x);
    lx = lo(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx === 0x3ff00000 && lx === 0) return 0;
  k += (hx >> 20) - 1023;
  const i = (k & 0x80000000) >>> 31;
  hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
  const y = k + i;
  const z = y * LOG10_2LO + IVLN10 * fdlibmLog(words(hx, lx));
  return z + y * LOG10_2HI;
}

export function fdlibmPow(x: number, y: number): number {
  if (Number.isNaN(y)) return NaN;
  if (!Number.isFinite(y) && (x === 1 || x === -1)) return NaN;
  const BP = [1, 1.5], DP_H = [0, 5.84962487220764160156e-1], DP_L = [0, 1.35003920212974897128e-8];
  const TWO53 = 9007199254740992, HUGE = 1e300, TINY = 1e-300;
  const L1 = 5.99999999999994648725e-1, L2 = 4.28571428578550184252e-1, L3 = 3.33333329818377432918e-1;
  const L4 = 2.72728123808534006489e-1, L5 = 2.30660745775561754067e-1, L6 = 2.06975017800338417784e-1;
  const P1 = 1.66666666666666019037e-1, P2 = -2.77777777770155933842e-3, P3 = 6.61375632143793436117e-5;
  const P4 = -1.65339022054652515390e-6, P5 = 4.13813679705723846039e-8;
  const LG2 = 6.93147180559945286227e-1, LG2_H = 6.93147182464599609375e-1, LG2_L = -1.90465429995776804525e-9;
  const OVT = 8.0085662595372944372e-17, CP = 9.61796693925975554329e-1, CP_H = 9.61796700954437255859e-1;
  const CP_L = -7.02846165095275826516e-9, IVLN2 = 1.44269504088896338700, IVLN2_H = 1.44269502162933349609;
  const IVLN2_L = 1.92596299112661746887e-8;
  const hx = hi(x), lx = lo(x), hy = hi(y), ly = lo(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  if ((iy | ly) === 0) return 1;
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y;
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2;
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      if (((ix - 0x3ff00000) | lx) === 0) return y - y;
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0;
      return hy < 0 ? -y : 0;
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x;
    if (hy === 0x40000000) return x * x;
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
  }
  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = NaN;
      else if (yisint === 1) z = -z;
    }
    return z;
  }
  const n0 = hx < 0 ? 0 : 1;
  if ((n0 | yisint) === 0) return NaN;
  let s = 1;
  if ((n0 | (yisint - 1)) === 0) s = -1;
  let t1: number, t2: number;
  if (iy > 0x41e00000) {
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    const t = ax - 1;
    const w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = withLo(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    let n = 0;
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = hi(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    ix = j | 0x3ff00000;
    let k: number;
    if (j <= 0x3988e) k = 0;
    else if (j < 0xbb67a) k = 1;
    else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHi(ax, ix);
    let u = ax - BP[k];
    let v = 1 / (ax + BP[k]);
    const ss = u * v;
    const s_h = withLo(ss, 0);
    let t_h = words(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let t_l = ax - (t_h - BP[k]);
    const s_l = v * ((u - s_h * t_h) - s_h * t_l);
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += s_l * (s_h + ss);
    s2 = s_h * s_h;
    t_h = withLo(3.0 + s2 + r, 0);
    t_l = r - ((t_h - 3.0) - s2);
    u = s_h * t_h;
    v = s_l * t_h + t_l * ss;
    const p_h = withLo(u + v, 0);
    const p_l = v - (p_h - u);
    const z_h = CP_H * p_h;
    const z_l = CP_L * p_h + p_l * CP + DP_L[k];
    const t = n;
    t1 = withLo(((z_h + z_l) + DP_H[k]) + t, 0);
    t2 = z_l - (((t1 - t) - DP_H[k]) - z_h);
  }
  const y1 = withLo(y, 0);
  const p_l = (y - y1) * t1 + y * t2;
  let p_h = y1 * t1;
  let z = p_l + p_h;
  const j = hi(z);
  const i0 = lo(z) | 0;
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i0) !== 0) return s * HUGE * HUGE;
    if (p_l + OVT > z - p_h) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    if ((((j >>> 0) - 0xc090cc00) | i0) !== 0) return s * TINY * TINY;
    if (p_l <= z - p_h) return s * TINY * TINY;
  }
  const i = j & 0x7fffffff;
  let k = (i >> 20) - 0x3ff;
  let n = 0;
  if (i > 0x3fe00000) {
    n = (j + (0x00100000 >> (k + 1))) | 0;
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = words(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    p_h -= t;
  }
  let t = withLo(p_l + p_h, 0);
  const u = t * LG2_H;
  const v = (p_l - (t - p_h)) * LG2 + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  t = z * z;
  const tt1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  const r = (z * tt1) / ((tt1 - 2) - (w + z * w));
  z = 1 - (r - z);
  const jj = (hi(z) + (n << 20)) | 0;
  if (jj >> 20 <= 0) return s * z * nativePow(2, n); // sous-normal (jamais atteint ici)
  return s * withHi(z, (hi(z) + (n << 20)) | 0);
}

void withHi;
Math.cos = fdlibmCos;
Math.exp = fdlibmExp;
Math.log = fdlibmLog;
Math.log10 = fdlibmLog10;
Math.pow = fdlibmPow;
