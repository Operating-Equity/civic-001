// The field: a drawn layer of mathematics behind the glass.
//
// The operator's brief (2 October): keep and enhance the glass; behind it, mathematics rather than a
// photograph; light, never dark, because light clears darkness and reveals truth, and glass because
// truth has two factors, light and transparency; the whole should read as a proof that the truth has
// been made. So: ten fields of four kinds, drawn here from their own definitions (no picture file is
// loaded), fixed to the window so every panel at every scroll depth has structure and light behind
// it, and changing with the run: a visit opens on one field, extraction shifts to a second, testing to
// a third, and done settles on a fourth. Which deck a visit draws is decided once from a random word,
// so the page is never the same twice. Nothing is stored or sent, and the run is never touched.
//
// The kinds: proofs typeset by KaTeX (Euclid's infinitude of primes, the irrationality of √2, Euclid
// I.47 as the windmill figure, Euler's identity); the golden rectangle and its spiral; the fractals
// (the Mandelbrot set and a Julia set as rasters drawn by field-worker.js off the page's thread, the
// Koch snowflake as a path); chaos and primes (the Lorenz attractor, a double pendulum's trace, the
// Ulam spiral). Everything is faint ink and long strokes: a design, never reading matter.
//
// Rules: the layer is aria-hidden and inert; reduced motion makes every change instant and stops the
// slow zoom; a field that cannot be drawn (no worker, no KaTeX, a slow machine) gives way to one that
// can; a raster is drawn at half resolution, which the glass blurs away, and kept for the next visit
// of the same phase.

const FIELD = document.getElementById('field');
const LAYERS = FIELD ? [...FIELD.querySelectorAll('.field-layer')] : [];
const PROOFS = ['euclid', 'sqrt2', 'pythagoras', 'euler'];
const RASTER = new Set(['mandelbrot', 'julia']);
const ZOOMS = new Set(['mandelbrot', 'julia', 'koch']);
const PHI = (1 + Math.sqrt(5)) / 2;
const NS = 'http://www.w3.org/2000/svg';
const WATCHDOG_MS = 1500;    // a raster that takes longer than this gives way to the snowflake
const FADE_MS = 1200;        // the cross-fade, as civic.css has it
const ITERATIONS = 160;      // the fractals' cap

const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const still = () => Boolean(motion && motion.matches);
const narrow = (w) => w <= 600;

// ---- colours: the page's own tokens, read once from the stylesheet ----
const token = (name, fallback) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };
const rgb = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const COLOURS = {
  ground: rgb(token('--ground', '#eef3f7')) || [238, 243, 247],
  ink: rgb(token('--ink', '#15181d')) || [21, 24, 29],
  blue: rgb(token('--blue', '#4874e4')) || [72, 116, 228],
  gold: rgb(token('--gold-ink', '#b8860b')) || [184, 134, 11],
};
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const r1 = (n) => Math.round(n * 10) / 10;
let uid = 0;

// ---- SVG ----
function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of children) n.append(c);
  return n;
}
/** A sheet with a 1000-unit short side at the window's aspect; it keeps covering the window if that changes. */
function sheet(w, h) {
  const vw = w >= h ? 1000 * w / h : 1000, vh = w >= h ? 1000 : 1000 * h / w;
  const s = svg('svg', { viewBox: `0 0 ${r1(vw)} ${r1(vh)}`, preserveAspectRatio: 'xMidYMid slice', focusable: 'false' });
  return { s, vw, vh };
}
const stroke = (cls, opacity, width, extra = {}) => ({ fill: 'none', stroke: 'currentColor', 'stroke-opacity': opacity, 'stroke-width': width, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: cls, ...extra });
const fill = (cls, opacity) => ({ fill: 'currentColor', 'fill-opacity': opacity, stroke: 'none', class: cls });

// ---- the proofs: lines of TeX, placed in window units, rotated a little, running off the edges ----
const STATEMENT = 'clamp(40px, 7vw, 110px)';
const PROOF_LINES = {
  euclid: [   // Elements IX.20: the primes are more than any assigned multitude
    { tex: 'p_1,\\; p_2,\\; \\ldots,\\; p_n', x: 2, y: 3, rot: -2, minor: true },
    { tex: 'N \\equiv 1 \\pmod{p_i}', x: 64, y: 2, rot: 2, minor: true },
    { tex: 'N = p_1 p_2 \\cdots p_n + 1', x: -2, y: 72, rot: -3, size: STATEMENT },
    { tex: '\\therefore\\; \\exists\\, q \\mid N,\\quad q \\notin \\{p_1, \\ldots, p_n\\}', x: 22, y: 90, rot: -2, tone: 'f-blue' },
    { tex: '\\blacksquare', x: 91, y: 89, rot: 0, tone: 'f-gold', size: 'clamp(26px, 3.6vw, 52px)' },
  ],
  sqrt2: [    // √2 is not a ratio of whole numbers
    { tex: '\\sqrt{2} = \\tfrac{p}{q},\\qquad \\gcd(p, q) = 1', x: 2, y: 2, rot: -2, minor: true },
    { tex: '\\Rightarrow\\; 2 \\mid p,\\quad p = 2k', x: 66, y: 2, rot: 2, minor: true },
    { tex: 'p^2 = 2q^2', x: 56, y: 70, rot: -3, size: STATEMENT },
    { tex: 'q^2 = 2k^2 \\;\\Rightarrow\\; 2 \\mid q', x: -2, y: 89, rot: -2, tone: 'f-gold' },
    { tex: '\\sqrt{2} \\notin \\mathbb{Q}\\quad\\blacksquare', x: 52, y: 88, rot: -3, tone: 'f-blue', size: 'clamp(34px, 5.5vw, 84px)' },
  ],
  pythagoras: [   // Elements I.47, drawn (the windmill); one line says what the figure proves
    { tex: 'a^2 + b^2 = c^2', x: 58, y: 86, rot: -4, tone: 'f-blue', size: 'clamp(34px, 5.5vw, 84px)' },
  ],
  euler: [    // Euler's identity, and the formula and series it comes from
    { tex: '\\cos x = \\sum_{n=0}^{\\infty} (-1)^n \\frac{x^{2n}}{(2n)!}', x: 1, y: 1, rot: -2, minor: true },
    { tex: 'e^{i\\theta} = \\cos\\theta + i\\sin\\theta', x: 60, y: 2, rot: 2, tone: 'f-blue' },
    { tex: 'e^{x} = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}', x: -3, y: 40, rot: -6, minor: true },
    { tex: '\\sin x = \\sum_{n=0}^{\\infty} (-1)^n \\frac{x^{2n+1}}{(2n+1)!}', x: 76, y: 44, rot: 3, tone: 'f-gold', minor: true },
    { tex: 'e^{i\\pi} + 1 = 0', x: 3, y: 71, rot: -4, size: 'clamp(64px, 14vw, 240px)' },
  ],
};
function line(tex, { x, y, rot = 0, size = 'clamp(28px, 4.2vw, 64px)', tone = 'f-ink', minor = false }) {
  const d = document.createElement('div');
  d.className = `field-line ${tone}${minor ? ' f-minor' : ''}`;
  d.style.cssText = `left:${x}vw;top:${y}vh;font-size:${size};transform:rotate(${rot}deg)`;
  d.innerHTML = window.katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: false });
  return d;
}
const proof = (id) => (w, h) => {
  if (!window.katex) return golden(w, h);
  const box = document.createElement('div');
  box.className = 'field-proof';
  if (id === 'pythagoras') box.append(windmill(w, h));
  for (const l of PROOF_LINES[id]) box.append(line(l.tex, l));
  return box;
};

/** Euclid I.47: a 300 : 400 : 500 right triangle, the squares on its sides, the altitude carried through
    the square on the hypotenuse, and the two congruence lines of the proof. The two rectangles that
    altitude makes are filled like the squares on the legs they equal. A y-up frame, flipped once. */
function windmill(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const A = [-250, 0], B = [250, 0], C = [-70, 240], D = [-70, 0], L = [-70, -500], A2 = [-250, -500], B2 = [250, -500];
  const F = [-490, 180], G = [-310, 420];   // the square on CA
  const K = [490, 320], J = [170, 560];     // the square on CB
  const sc = Math.max(vw / 1500, vh / 980), cx = vw / 2, cy = vh / 2 + 30 * sc;
  const g = svg('g', { transform: `translate(${r1(cx)} ${r1(cy)}) scale(${r1(sc)} ${r1(-sc)})` });
  const pts = (list) => list.map(([x, y]) => `${x} ${y}`).join(' ');
  const poly = (list, attrs) => svg('polygon', { points: pts(list), ...attrs });
  const seg = (p, q, attrs) => svg('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], ...attrs });
  const edge = stroke('f-ink', .18, 1.4);
  g.append(
    poly([A, D, L, A2], fill('f-blue', .1)), poly([C, A, F, G], fill('f-blue', .1)),
    poly([D, B, B2, L], fill('f-gold', .12)), poly([C, B, K, J], fill('f-gold', .12)),
    poly([A, B, B2, A2], edge), poly([C, A, F, G], edge), poly([C, B, K, J], edge),
    poly([A, B, C], stroke('f-ink', .26, 1.6)),
    svg('polyline', { points: pts([[-80.8, 225.6], [-66.4, 214.8], [-55.6, 229.2]]), ...edge }),   // the right angle
    seg(C, L, stroke('f-ink', .18, 1.2, { 'stroke-dasharray': '7 7' })),
    seg(B, F, stroke('f-blue', .26, 1.4)), seg(C, A2, stroke('f-blue', .26, 1.4)),
    seg(A, K, stroke('f-gold', .28, 1.4)), seg(C, B2, stroke('f-gold', .28, 1.4)),
  );
  s.append(g);
  return s;
}

/** The golden rectangle: twelve steps of the recurrence (cut the square, keep the rest, turn), the
    quarter circles joined into the spiral, the two diagonals that meet at its pole. */
function golden(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const W = 1000, H = 1000 / PHI, portrait = vh > vw;
  const sc = portrait ? vh / W : vw / W;   // the whole rectangle across the window's long side
  const g = svg('g', { transform: `translate(${r1(vw / 2)} ${r1(vh / 2)})${portrait ? ' rotate(-90)' : ''} scale(${r1(sc)}) translate(${-W / 2} ${r1(-H / 2)})` });
  let x = 0, y = 0, rw = W, rh = H, d = `M0 ${r1(H)}`;
  for (let i = 0; i < 12; i++) {
    const k = i % 4; let a, sx, sy, ex, ey;
    if (k === 0) { a = rh; sx = x; sy = y; ex = x + a; ey = y; x += a; rw -= a; }
    else if (k === 1) { a = rw; sx = x; sy = y; ex = x + a; ey = y + a; y += a; rh -= a; }
    else if (k === 2) { a = rh; sx = x + rw - a; sy = y; ex = sx; ey = y + a; rw -= a; }
    else { a = rw; sx = x; sy = y + rh - a; ex = x; ey = sy; rh -= a; }
    if (i % 2 === 0) g.append(svg('rect', { x: r1(sx), y: r1(sy), width: r1(a), height: r1(a), ...fill('f-blue', .05) }));
    g.append(svg('rect', { x: r1(sx), y: r1(sy), width: r1(a), height: r1(a), ...stroke('f-ink', .18, 1.2) }));
    d += ` A${r1(a)} ${r1(a)} 0 0 1 ${r1(ex)} ${r1(ey)}`;
  }
  g.append(svg('line', { x1: 0, y1: 0, x2: W, y2: r1(H), ...stroke('f-gold', .28, 1.4) }));
  g.append(svg('line', { x1: r1(H), y1: r1(H), x2: W, y2: 0, ...stroke('f-gold', .28, 1.4) }));
  g.append(svg('path', { d, ...stroke('f-blue', .26, 2.4) }));
  const text = (str, attrs) => { const t = svg('text', { ...fill('f-ink', .14), 'text-anchor': 'middle', ...attrs }); t.textContent = str; return t; };
  g.append(text('φ', { x: r1(H / 2), y: r1(H / 2 + 120), style: 'font-family: var(--font-display); font-weight: 700; font-size: 340px' }));
  g.append(text('1.618 033 988 749…', { x: r1(H / 2), y: r1(H - 36), style: 'font-family: var(--font-display); font-weight: 600; font-size: 54px; letter-spacing: .04em' }));
  g.append(text('φ² = φ + 1', { x: r1(H + (W - H) / 2), y: r1((W - H) / 2 + 24), style: 'font-family: var(--font-display); font-weight: 600; font-size: 64px' }));
  s.append(g);
  return s;
}

/** The Koch snowflake, five iterations: 3 072 segments, the same at every zoom. */
function koch(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const side = 1100, r = side / Math.sqrt(3), cx = vw / 2, cy = vh / 2;
  let pts = [0, 1, 2].map((k) => { const a = -Math.PI / 2 + k * 2 * Math.PI / 3; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const bump = (p, q, sign) => {
    const dx = (q[0] - p[0]) / 3, dy = (q[1] - p[1]) / 3, c = Math.cos(sign * Math.PI / 3), sn = Math.sin(sign * Math.PI / 3);
    return [[p[0] + dx, p[1] + dy], [p[0] + dx + dx * c - dy * sn, p[1] + dy + dx * sn + dy * c], [p[0] + 2 * dx, p[1] + 2 * dy]];
  };
  const iterate = (poly, sign) => { const out = []; for (let i = 0; i < poly.length; i++) out.push(poly[i], ...bump(poly[i], poly[(i + 1) % poly.length], sign)); return out; };
  const width = (poly) => Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]));
  const sign = width(iterate(pts, 1)) > width(iterate(pts, -1)) ? 1 : -1;   // the bumps point outward
  for (let i = 0; i < 5; i++) pts = iterate(pts, sign);
  const d = 'M' + pts.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L') + 'Z';
  s.append(svg('path', { d, ...fill('f-blue', .06) }), svg('path', { d, ...stroke('f-blue', .22, 1.2) }));
  return s;
}

/** The Lorenz attractor: σ 10, ρ 28, β 8/3 from (0.1, 0, 0), integrated by RK4, the x–z projection
    as one path (so its own crossings never stack), blue running to gold, with a soft glow. */
function lorenz(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const sigma = 10, rho = 28, beta = 8 / 3, dt = 0.01, steps = 20000, every = narrow(w) ? 8 : 4;
  const f = (x, y, z) => [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
  const k = 1.1 * vh / 50, cx = vw / 2, cy = vh / 2;
  let x = 0.1, y = 0, z = 0, d = '';
  for (let i = 0; i < steps; i++) {
    const a = f(x, y, z);
    const b = f(x + dt / 2 * a[0], y + dt / 2 * a[1], z + dt / 2 * a[2]);
    const c = f(x + dt / 2 * b[0], y + dt / 2 * b[1], z + dt / 2 * b[2]);
    const e = f(x + dt * c[0], y + dt * c[1], z + dt * c[2]);
    x += dt / 6 * (a[0] + 2 * b[0] + 2 * c[0] + e[0]); y += dt / 6 * (a[1] + 2 * b[1] + 2 * c[1] + e[1]); z += dt / 6 * (a[2] + 2 * b[2] + 2 * c[2] + e[2]);
    if (i >= 200 && i % every === 0) d += `${d ? 'L' : 'M'}${Math.round(cx + x * k)} ${Math.round(cy - (z - 25) * k)}`;
  }
  const id = `fg${++uid}`;
  const grad = svg('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 0 }, [
    svg('stop', { offset: 0, 'stop-color': rgba(COLOURS.blue, 1) }), svg('stop', { offset: 1, 'stop-color': rgba(COLOURS.gold, 1) }),
  ]);
  s.append(svg('defs', {}, [grad]),
    svg('path', { d, fill: 'none', stroke: `url(#${id})`, 'stroke-opacity': .08, 'stroke-width': 9, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }),
    svg('path', { d, fill: 'none', stroke: `url(#${id})`, 'stroke-opacity': .22, 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  return s;
}

/** A double pendulum, equal masses and unit arms, released from rest at θ₁ = θ₂ = 2.6: the second
    bob's trace over 32 seconds (RK4), and the arms where they stopped. */
function pendulum(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const g = 9.81, dt = 0.004, steps = 8000, every = 2;
  const acc = ([t1, w1, t2, w2]) => {
    const dl = t2 - t1, sd = Math.sin(dl), cd = Math.cos(dl), den = 2 - cd * cd;
    const a1 = (w1 * w1 * sd * cd + g * Math.sin(t2) * cd + w2 * w2 * sd - 2 * g * Math.sin(t1)) / den;
    const a2 = (-w2 * w2 * sd * cd + 2 * g * Math.sin(t1) * cd - 2 * w1 * w1 * sd - 2 * g * Math.sin(t2)) / den;
    return [w1, a1, w2, a2];
  };
  const add = (u, v, m) => u.map((n, i) => n + v[i] * m);
  const px = vw / 2, py = vh * 0.44, L = vh * 0.3;
  const at = ([t1, , t2]) => { const x1 = px + L * Math.sin(t1), y1 = py + L * Math.cos(t1); return [[x1, y1], [x1 + L * Math.sin(t2), y1 + L * Math.cos(t2)]]; };
  let u = [2.6, 0, 2.6, 0], d = '';
  for (let i = 0; i < steps; i++) {
    const a = acc(u), b = acc(add(u, a, dt / 2)), c = acc(add(u, b, dt / 2)), e = acc(add(u, c, dt));
    u = u.map((n, j) => n + dt / 6 * (a[j] + 2 * b[j] + 2 * c[j] + e[j]));
    if (i % every === 0) { const [, p2] = at(u); d += `${d ? 'L' : 'M'}${Math.round(p2[0])} ${Math.round(p2[1])}`; }
  }
  const [p1, p2] = at(u);
  s.append(svg('path', { d, ...stroke('f-ink', .2, 1.3) }),
    svg('polyline', { points: `${r1(px)} ${r1(py)} ${r1(p1[0])} ${r1(p1[1])} ${r1(p2[0])} ${r1(p2[1])}`, ...stroke('f-blue', .28, 3) }),
    svg('circle', { cx: r1(px), cy: r1(py), r: 5, ...fill('f-blue', .28) }),
    svg('circle', { cx: r1(p1[0]), cy: r1(p1[1]), r: 11, ...fill('f-blue', .28) }),
    svg('circle', { cx: r1(p2[0]), cy: r1(p2[1]), r: 11, ...fill('f-gold', .32) }));
  return s;
}

/** The Ulam spiral: the whole numbers wound from the centre, the primes marked, 4k+1 in blue and 4k+3
    in gold, and the diagonals appear by themselves. */
function ulam(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
  const ctx = c.getContext('2d');
  const N = 40000, cell = Math.max(w, h) / 200, cx = w / 2, cy = h / 2, dot = cell * 0.6, half = dot / 2;
  const composite = new Uint8Array(N + 1);
  for (let i = 2; i * i <= N; i++) if (!composite[i]) for (let j = i * i; j <= N; j += i) composite[j] = 1;
  const blue = rgba(COLOURS.blue, .22), gold = rgba(COLOURS.gold, .26), ink = rgba(COLOURS.ink, .22);
  let x = 0, y = 0, dx = 1, dy = 0, len = 1, run = 0, turns = 0;
  for (let n = 1; n <= N; n++) {
    if (n > 1 && !composite[n]) {
      ctx.fillStyle = n === 2 ? ink : (n % 4 === 1 ? blue : gold);
      ctx.fillRect(cx + x * cell - half, cy - y * cell - half, dot, dot);
    }
    x += dx; y += dy; run++;
    if (run === len) { run = 0; [dx, dy] = [-dy, dx]; turns++; if (turns % 2 === 0) len++; }
  }
  return c;
}

// ---- the rasters: the worker draws the pixels, the page keeps them ----
let worker = null, seq = 0;
const waiting = new Map();
const bitmaps = new Map();   // `${kind}:${w}x${h}` → pixels, at most two
function getWorker() {
  if (worker) return worker;
  try { worker = new Worker(new URL('./field-worker.js', import.meta.url)); } catch { return null; }
  worker.onmessage = (e) => { const p = waiting.get(e.data.id); waiting.delete(e.data.id); if (p) p.resolve(e.data); };
  worker.onerror = () => { for (const p of waiting.values()) p.reject(new Error('worker')); waiting.clear(); try { worker.terminate(); } catch { /* gone */ } worker = null; };
  return worker;
}
function pixels(kind, w, h) {
  const key = `${kind}:${w}x${h}`;
  if (bitmaps.has(key)) return Promise.resolve(bitmaps.get(key));
  const wk = getWorker();
  if (!wk) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    wk.postMessage({ id, kind, w, h, colours: COLOURS, cap: ITERATIONS });
  }).then((got) => {
    if (bitmaps.size >= 2) bitmaps.delete(bitmaps.keys().next().value);
    bitmaps.set(key, got);
    return got;
  });
}
const rasterSize = (w, h) => [Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2))];
async function raster(kind, w, h) {
  const [rw, rh] = rasterSize(w, h);
  const got = await pixels(kind, rw, rh);
  const c = document.createElement('canvas');
  c.width = got.w; c.height = got.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(got.buf), got.w, got.h), 0, 0);
  return c;
}

const BUILDERS = {
  euclid: proof('euclid'), sqrt2: proof('sqrt2'), pythagoras: proof('pythagoras'), euler: proof('euler'),
  golden, mandelbrot: (w, h) => raster('mandelbrot', w, h), julia: (w, h) => raster('julia', w, h), koch,
  lorenz, pendulum, ulam,
};
const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms));
async function build(id, w, h) {
  try {
    if (RASTER.has(id)) return await Promise.race([BUILDERS[id](w, h), timeout(WATCHDOG_MS)]);
    return BUILDERS[id](w, h);
  } catch { return koch(w, h); }
}

// ---- the decks: which field each phase of the run shows, decided once per visit ----
const seed = (() => { try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return Date.now() >>> 0; } })();
const PROOF = PROOFS[(seed >>> 1) % PROOFS.length], VARIANT = (seed >>> 3) & 1;
const DECK = (seed & 1) === 0
  ? { idle: PROOF, extracting: 'golden', evaluating: VARIANT ? 'julia' : 'mandelbrot', done: 'ulam' }
  : { idle: 'golden', extracting: 'koch', evaluating: VARIANT ? 'pendulum' : 'lorenz', done: PROOF };

// ---- the scheduler: two layers, one on; a newer request supersedes a pending build ----
const state = { id: '', phase: 'idle', on: 0, token: 0, w: 0, h: 0 };
function release(layer) {
  for (const c of layer.children) if (c.tagName === 'CANVAS') { c.width = 0; c.height = 0; }
  layer.replaceChildren();
  layer.classList.remove('is-zoom');
}
function zoomable(id, w) { return ZOOMS.has(id) && !still() && !narrow(w); }
async function show(id, { instant = false } = {}) {
  if (!FIELD || !BUILDERS[id] || id === state.id) return;
  const token = ++state.token;
  state.id = id; state.w = window.innerWidth; state.h = window.innerHeight;
  const node = await build(id, state.w, state.h);
  if (token !== state.token) return;
  const next = LAYERS[state.on ^ 1], prev = LAYERS[state.on];
  release(next);
  next.append(node);
  next.classList.toggle('is-zoom', zoomable(id, state.w));
  FIELD.dataset.field = id;
  const atOnce = instant || still();
  if (atOnce) { next.style.transition = 'none'; prev.style.transition = 'none'; }
  next.classList.add('is-on');
  prev.classList.remove('is-on');
  if (atOnce) {
    void next.offsetWidth;
    next.style.transition = ''; prev.style.transition = '';
    release(prev);
  } else {
    const gone = () => { prev.removeEventListener('transitionend', gone); clearTimeout(timer); if (!prev.classList.contains('is-on')) release(prev); };
    const timer = setTimeout(gone, FADE_MS + 300);
    prev.addEventListener('transitionend', gone);
  }
  state.on ^= 1;
}
/** The window changed size: the field on show is drawn again for it (a phone's address bar is not a change). */
async function redraw() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!state.id || (Math.abs(w - state.w) < 1 && Math.abs(h - state.h) < 160)) return;
  const token = ++state.token;
  state.w = w; state.h = h;
  const node = await build(state.id, w, h);
  if (token !== state.token) return;
  const layer = LAYERS[state.on];
  for (const c of layer.children) if (c.tagName === 'CANVAS') { c.width = 0; c.height = 0; }
  layer.replaceChildren(node);
  layer.classList.toggle('is-zoom', zoomable(state.id, w));
}

export const field = {
  /** Called by the page after each change of the run's phase: idle, extracting, evaluating, done. */
  setPhase(phase) {
    if (!FIELD || FIELD.dataset.still) return;
    const p = DECK[phase] ? phase : 'idle';
    state.phase = p;
    FIELD.dataset.phase = p;
    show(DECK[p]);
  },
  show,
  ids: Object.keys(BUILDERS),
  current: () => state.id,
  deck: () => ({ ...DECK }),
};

if (FIELD && LAYERS.length === 2) {
  // The home field is drawn before the page's first paint settles; the next ones warm up while the
  // page is idle, so a change of phase never waits on a drawing.
  show(FIELD.dataset.still || DECK.idle, { instant: true });
  const idle = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 2000 }) : (fn) => setTimeout(fn, 600);
  if (!FIELD.dataset.still && RASTER.has(DECK.evaluating)) idle(() => { const [rw, rh] = rasterSize(window.innerWidth, window.innerHeight); pixels(DECK.evaluating, rw, rh).catch(() => { /* the snowflake stands in */ }); });
  let timer = 0;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(redraw, 200); });
  if (motion && motion.addEventListener) motion.addEventListener('change', () => LAYERS[state.on].classList.toggle('is-zoom', zoomable(state.id, state.w)));
  window.__field = field;   // for a console or a check, never a product surface
}
