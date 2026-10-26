// The field: a drawn layer of mathematics behind the glass.
//
// The operator's brief (2 October): keep and enhance the glass; behind it, mathematics rather than a
// photograph; light, never dark, because light clears darkness and reveals truth, and glass because
// truth has two factors, light and transparency; the whole should read as a proof that the truth has
// been made. So: twenty-seven fields of four kinds, drawn here from their own definitions (no picture file
// is loaded), fixed to the window so every panel at every scroll depth has structure and light behind
// it, and changing with the run: a visit opens on one field, extraction shifts to a second, testing to
// a third, and done settles on a fourth. The fields come in six sets, each with one field of every kind
// (the operator, 25 October: "at least 4 different sets", rotating, "user independent", with "no
// memory of prior visitors' experiences"): which set a visit draws is decided once from a random word,
// so the page is never the same twice. Nothing is stored or sent, and the run is never touched.
//
// The kinds: proofs typeset by KaTeX (Euclid's infinitude of primes, the irrationality of √2, Euclid
// I.47 as the windmill figure, Euler's identity, Gauss's sum with its count of squares, the Basel sum,
// Cantor's diagonal over the digits of known numbers, Bayes's rule with its square of chances); designs
// known in mathematics (the golden rectangle and its spiral, the sunflower's golden angle, a Penrose
// tiling, the caustic that light makes in a round mirror, the regular 17-gon with its every diagonal);
// the fractals (the Mandelbrot set, a Julia set, the Barnsley fern, as rasters drawn by field-worker.js
// off the page's thread; the Koch snowflake, the Sierpinski triangle, the Heighway dragon and the
// Hilbert curve as paths); chaos, chance and number (the Lorenz attractor, a double pendulum's trace, the
// Clifford attractor, the logistic map's cascade, Buffon's needles, the Ulam spiral, the Ford circles of the fractions).
// Everything is faint ink and long strokes: a design, never reading matter.
//
// Rules: the layer is aria-hidden and inert; reduced motion makes every change instant and stops the
// slow zoom; a field that cannot be drawn (no worker, no KaTeX, a slow machine) gives way to one that
// can; the escape-time rasters are drawn at half resolution, which the glass blurs away, and every
// raster is kept for the next visit of the same phase.

const FIELD = document.getElementById('field');
const LAYERS = FIELD ? [...FIELD.querySelectorAll('.field-layer')] : [];
const PROOFS = ['euclid', 'sqrt2', 'pythagoras', 'euler'];
const RASTER = new Set(['mandelbrot', 'julia', 'fern', 'clifford', 'logistic']);
const HALF = new Set(['mandelbrot', 'julia']);   // the escape-time rasters, drawn at half resolution
const ZOOMS = new Set(['mandelbrot', 'julia', 'koch', 'fern', 'sierpinski', 'dragon', 'hilbert']);
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
  green: rgb(token('--green-ink', '#2f9a64')) || [47, 154, 100],
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
  gauss: [    // the first n whole numbers, written forwards and backwards and added in pairs; the figure counts them
    { tex: 'S = 1 + 2 + 3 + \\cdots + n', x: 2, y: 3, rot: -2, minor: true },
    { tex: 'S = n + (n - 1) + \\cdots + 1', x: 62, y: 3, rot: 2, minor: true },
    { tex: '2S = n\\,(n + 1)', x: 70, y: 40, rot: 3, tone: 'f-gold' },
    { tex: '1 + 2 + \\cdots + n = \\tfrac{1}{2}\\,n\\,(n + 1)', x: -2, y: 72, rot: -3, size: STATEMENT },
    { tex: '\\blacksquare', x: 91, y: 89, rot: 0, tone: 'f-gold', size: 'clamp(26px, 3.6vw, 52px)' },
  ],
  basel: [    // Euler's sum of the reciprocal squares: the product and the series of sin x / x, their x² terms set equal
    { tex: '\\frac{\\sin x}{x} = \\prod_{n=1}^{\\infty} \\Bigl(1 - \\frac{x^2}{n^2 \\pi^2}\\Bigr)', x: 2, y: 2, rot: -2, minor: true },
    { tex: '\\frac{\\sin x}{x} = 1 - \\frac{x^2}{3!} + \\frac{x^4}{5!} - \\cdots', x: 60, y: 4, rot: 2, minor: true },
    { tex: '[x^2]\\colon\\quad \\sum_{n=1}^{\\infty} \\frac{1}{n^2 \\pi^2} = \\frac{1}{3!}', x: 3, y: 38, rot: -4, tone: 'f-gold' },
    { tex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', x: 48, y: 56, rot: -3, size: 'clamp(46px, 8.5vw, 140px)' },
    { tex: '\\blacksquare', x: 91, y: 89, rot: 0, tone: 'f-gold', size: 'clamp(26px, 3.6vw, 52px)' },
  ],
  cantor: [   // no list of the reals is complete: the diagonal, changed digit by digit, is on no row (the figure)
    { tex: 'f\\colon \\mathbb{N} \\to (0, 1)', x: 2, y: 3, rot: -2, minor: true },
    { tex: 'd_n = \\begin{cases} 4, & f(n)_n = 5 \\\\ 5, & f(n)_n \\neq 5 \\end{cases}', x: 72, y: 3, rot: 2, minor: true },
    { tex: 'd \\neq f(n)\\ \\text{for every}\\ n', x: 3, y: 88, rot: -2, tone: 'f-blue' },
    { tex: '|\\mathbb{N}| < |\\mathbb{R}|', x: 58, y: 68, rot: -3, size: STATEMENT },
    { tex: '\\blacksquare', x: 91, y: 89, rot: 0, tone: 'f-gold', size: 'clamp(26px, 3.6vw, 52px)' },
  ],
  bayes: [    // the chance of a hypothesis after the evidence: one joint chance written two ways; the figure is its square
    { tex: 'P(H \\cap E) = P(H \\mid E)\\,P(E)', x: 2, y: 3, rot: -2, minor: true, size: 'clamp(20px, 2.8vw, 44px)' },
    { tex: 'P(H \\cap E) = P(E \\mid H)\\,P(H)', x: 64, y: 3, rot: 2, minor: true, size: 'clamp(20px, 2.8vw, 44px)' },
    { tex: 'P(E) = \\sum_i P(E \\mid H_i)\\,P(H_i)', x: 4, y: 40, rot: -4, tone: 'f-gold', minor: true },
    { tex: 'P(H \\mid E) = \\frac{P(E \\mid H)\\,P(H)}{P(E)}', x: -1, y: 66, rot: -3, size: STATEMENT },
    { tex: '\\blacksquare', x: 91, y: 89, rot: 0, tone: 'f-gold', size: 'clamp(26px, 3.6vw, 52px)' },
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
  if (FIGURES[id]) box.append(FIGURES[id](w, h));
  for (const l of PROOF_LINES[id]) box.append(line(l.tex, l));
  return box;
};

/** Gauss's sum, counted: the staircase 1 + 2 + … + 10 in blue and the same staircase turned in gold fill the
    10 × 11 rectangle, so twice the sum is 10 · 11. */
function staircase(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const n = 10, u = 44, x0 = vw * 0.58 - (n + 1) * u / 2, y0 = vh * 0.36 - n * u / 2;
  let blue = '', gold = '';
  for (let r = 0; r < n; r++) for (let c = 0; c <= n; c++) {
    const sq = `M${r1(x0 + c * u)} ${r1(y0 + r * u)}h${u}v${u}h${-u}Z`;
    if (c <= r) blue += sq; else gold += sq;
  }
  let grid = '';
  for (let c = 0; c <= n + 1; c++) grid += `M${r1(x0 + c * u)} ${r1(y0)}v${n * u}`;
  for (let r = 0; r <= n; r++) grid += `M${r1(x0)} ${r1(y0 + r * u)}h${(n + 1) * u}`;
  let stair = `M${r1(x0)} ${r1(y0)}`;
  for (let r = 0; r < n; r++) stair += `h${u}v${u}`;
  s.append(svg('path', { d: blue, ...fill('f-blue', .12) }), svg('path', { d: gold, ...fill('f-gold', .12) }),
    svg('path', { d: grid, ...stroke('f-ink', .14, 1) }), svg('path', { d: stair, ...stroke('f-blue', .3, 2.4) }));
  return s;
}

// The digits of known numbers, worked out here with whole-number arithmetic to the places asked for, so every digit
// the diagonal shows is true: π − 3, e − 2, √2 − 1, φ − 1, ln 2, √3 − 1, 1/7, Champernowne's number, 1/√2, √5 − 2,
// 1/3 and √7 − 2.
function knownDigits(D) {
  const ONE = 10n ** BigInt(D + 10);
  const isqrt = (n) => { if (n < 2n) return n; let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; } };
  const root = (k) => isqrt(k * ONE * ONE);
  const arccot = (x) => { let sum = 0n, term = ONE / x, n = 1n, sign = 1n; const x2 = x * x; while (term) { sum += sign * term / n; term /= x2; n += 2n; sign = -sign; } return sum; };
  let e = 0n, t = ONE, k = 0n; while (t) { e += t; k++; t /= k; }
  let ln2 = 0n, p = ONE / 2n, j = 1n; while (p) { ln2 += p / j; j++; p /= 2n; }
  let champ = '', m = 1; while (champ.length < D) champ += String(m++);
  const digits = (v) => (v % ONE).toString().padStart(D + 10, '0').slice(0, D);
  return [
    digits(4n * (4n * arccot(5n) - arccot(239n))), digits(e), digits(root(2n)), digits((ONE + root(5n)) / 2n), digits(ln2),
    digits(root(3n)), digits(ONE / 7n), champ.slice(0, D), digits(root(2n) / 2n), digits(root(5n)), digits(ONE / 3n), digits(root(7n)),
  ];
}
/** Cantor's diagonal: twelve rows of a list, each a known number's digits; the n-th digit of the n-th row in gold;
    under them, in blue, the number d whose n-th digit is 4 where that digit is 5 and 5 elsewhere, on no row. */
function diagonal(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const rows = knownDigits(34), size = 34, lh = 50, x0 = vw * 0.07, y0 = vh * 0.15, step = size * 0.6, at = x0 + size * 4.2;
  const text = (str, x, y, cls, opacity, attrs = {}) => { const t = svg('text', { x: r1(x), y: r1(y), ...fill(cls, opacity), style: `font-family: var(--font-mono); font-size: ${size}px`, ...attrs }); t.textContent = str; return t; };
  const span = (str, cls, opacity, attrs = {}) => { const t = svg('tspan', { ...fill(cls, opacity), ...attrs }); t.textContent = str; return t; };
  const g = svg('g');
  let d = '';
  rows.forEach((row, n) => {
    const y = y0 + n * lh;
    // One line of text a row, the diagonal's digit a span within it, so it stands in its place in any font.
    const digits = text('', at - step * 2, y, 'f-ink', .15);
    digits.append(span('0.', 'f-ink', .16), span(row.slice(0, n), 'f-ink', .15), span(row[n], 'f-gold', .3, { 'font-weight': 600 }), span(row.slice(n + 1), 'f-ink', .15));
    g.append(text(`f(${n + 1})`, x0 - size * 0.4, y, 'f-ink', .12), digits);
    d += row[n] === '5' ? '4' : '5';
  });
  const yd = y0 + rows.length * lh + lh * 0.5;
  g.append(text('d =', x0 - size * 0.4, yd, 'f-blue', .26), text(`0.${d}…`, at - step * 2, yd, 'f-blue', .26, { 'font-weight': 600 }));
  g.append(svg('line', { x1: r1(at - step * 0.2), y1: r1(y0 - size), x2: r1(at + rows.length * step), y2: r1(y0 + (rows.length - 1) * lh + size * 0.3), ...stroke('f-gold', .22, 1.4, { 'stroke-dasharray': '6 8' }) }));
  s.append(g);
  return s;
}

/** Bayes's square: the whole of chance, split at P(H) = 0.3; the evidence E holds 0.8 of H and 0.2 of not-H. What
    is known once E is seen is the gold, and the share of it inside H is P(H | E) = 0.24 / 0.38. */
function bayesSquare(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const S = 380, x0 = vw * 0.62 - S / 2, y0 = vh * 0.24, pH = 0.3, eH = 0.8, eN = 0.2;
  const rect = (x, y, rw, rh, attrs) => svg('rect', { x: r1(x), y: r1(y), width: r1(rw), height: r1(rh), ...attrs });
  const label = (str, x, y) => { const t = svg('text', { x: r1(x), y: r1(y), ...fill('f-ink', .16), 'text-anchor': 'middle', style: 'font-family: var(--font-display); font-weight: 600; font-size: 40px' }); t.textContent = str; return t; };
  s.append(
    rect(x0, y0, S * pH, S, fill('f-blue', .08)),
    rect(x0, y0 + S * (1 - eH), S * pH, S * eH, fill('f-gold', .16)),
    rect(x0 + S * pH, y0 + S * (1 - eN), S * (1 - pH), S * eN, fill('f-gold', .16)),
    rect(x0, y0, S, S, stroke('f-ink', .22, 1.6)),
    svg('line', { x1: r1(x0 + S * pH), y1: r1(y0), x2: r1(x0 + S * pH), y2: r1(y0 + S), ...stroke('f-ink', .2, 1.4) }),
    svg('path', { d: `M${r1(x0)} ${r1(y0 + S * (1 - eH))}h${r1(S * pH)}V${r1(y0 + S * (1 - eN))}H${r1(x0 + S)}`, ...stroke('f-gold', .3, 1.8) }),
    label('H', x0 + S * pH / 2, y0 - 16), label('¬H', x0 + S * (pH + (1 - pH) / 2), y0 - 16), label('E', x0 - 30, y0 + S * (1 - eN / 2) + 14),
  );
  return s;
}
const FIGURES = { pythagoras: (w, h) => windmill(w, h), gauss: staircase, cantor: diagonal, bayes: bayesSquare };

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

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h)); return c; };
// A fixed sequence of chances (mulberry32), so a field drawn from chance is the same field every time it is drawn.
const chances = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** The sunflower (Vogel's model): seed n at the golden angle 360°/φ² ≈ 137.508° times n, at a distance √n from the
    centre. Every 13th seed in gold and every 21st in ink trace two of the Fibonacci spirals the eye finds. */
function phyllotaxis(w, h) {
  const c = canvasOf(w, h), ctx = c.getContext('2d');
  const N = narrow(w) ? 1500 : 2600, angle = 2 * Math.PI / (PHI * PHI), k = 0.56 * Math.max(w, h) / Math.sqrt(N), dot = k * 0.42;
  const blue = rgba(COLOURS.blue, .2), gold = rgba(COLOURS.gold, .3), ink = rgba(COLOURS.ink, .2);
  for (let n = 1; n <= N; n++) {
    const r = k * Math.sqrt(n), a = n * angle;
    ctx.fillStyle = n % 21 === 0 ? ink : n % 13 === 0 ? gold : blue;
    ctx.beginPath(); ctx.arc(w / 2 + r * Math.cos(a), h / 2 + r * Math.sin(a), dot, 0, 2 * Math.PI); ctx.fill();
  }
  return c;
}

/** A Penrose tiling of thin and thick rhombs, from a wheel of ten Robinson triangles cut seven times by the golden
    ratio: never repeating, never disordered. Each rhomb is two triangles; the line between them is not drawn. */
function penrose(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const R = 0.6 * Math.hypot(vw, vh), cx = vw / 2, cy = vh / 2;
  const mix = (P, Q, t) => [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
  let tris = [];
  for (let i = 0; i < 10; i++) {
    let B = [Math.cos((2 * i - 1) * Math.PI / 10), Math.sin((2 * i - 1) * Math.PI / 10)];
    let C = [Math.cos((2 * i + 1) * Math.PI / 10), Math.sin((2 * i + 1) * Math.PI / 10)];
    if (i % 2 === 0) [B, C] = [C, B];
    tris.push([0, [0, 0], B, C]);
  }
  for (let k = 0; k < 7; k++) {
    const next = [];
    for (const [kind, A, B, C] of tris) {
      if (kind === 0) { const P = mix(A, B, 1 / PHI); next.push([0, C, P, B], [1, P, C, A]); }
      else { const Q = mix(B, A, 1 / PHI), S = mix(B, C, 1 / PHI); next.push([1, S, C, A], [1, Q, S, B], [0, S, Q, A]); }
    }
    tris = next;
  }
  const at = ([x, y]) => `${r1(cx + R * x)} ${r1(cy + R * y)}`;
  let thin = '', thick = '', edges = '';
  for (const [kind, A, B, C] of tris) {
    const tri = `M${at(A)}L${at(B)}L${at(C)}Z`;
    if (kind === 0) thin += tri; else thick += tri;
    edges += `M${at(C)}L${at(A)}L${at(B)}`;
  }
  s.append(svg('path', { d: thin, ...fill('f-gold', .09) }), svg('path', { d: thick, ...fill('f-blue', .06) }), svg('path', { d: edges, ...stroke('f-ink', .14, 1) }));
  return s;
}

/** The caustic of a round mirror: parallel light comes in from the left and reflects off the far wall; the reflected
    rays crowd onto a nephroid, the bright curve seen in a cup of coffee in the sun, its cusp at half the radius. */
function caustic(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const R = 560, cx = vw / 2, cy = vh / 2, N = narrow(w) ? 110 : 180;
  let rays = '', inside = '', back = '', curve = '';
  for (let i = 1; i < N; i++) {
    const a = -Math.PI / 2 + Math.PI * i / N, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a), len = 2 * R * Math.cos(a);
    rays += `M0 ${r1(y)}H${r1(cx - R * Math.cos(a))}`;
    inside += `M${r1(cx - R * Math.cos(a))} ${r1(y)}H${r1(x)}`;
    back += `M${r1(x)} ${r1(y)}l${r1(-len * Math.cos(2 * a))} ${r1(-len * Math.sin(2 * a))}`;
  }
  for (let i = 0; i <= 360; i++) {   // the envelope: R cos φ / 2 along each reflected ray
    const a = -Math.PI / 2 + Math.PI * i / 360, t = R * Math.cos(a) / 2;
    curve += `${i ? 'L' : 'M'}${r1(cx + R * Math.cos(a) - t * Math.cos(2 * a))} ${r1(cy + R * Math.sin(a) - t * Math.sin(2 * a))}`;
  }
  s.append(svg('path', { d: rays, ...stroke('f-ink', .05, 1) }), svg('path', { d: inside, ...stroke('f-ink', .07, 1) }),
    svg('path', { d: back, ...stroke('f-gold', .15, 1) }), svg('path', { d: curve, ...stroke('f-gold', .08, 16) }),
    svg('circle', { cx: r1(cx), cy: r1(cy), r: R, ...stroke('f-blue', .28, 2.4) }), svg('path', { d: curve, ...stroke('f-blue', .3, 2.4) }));
  return s;
}

/** The regular 17-gon, which Gauss showed in 1796 can be drawn with compass and straightedge, and every one of its 136
    diagonals: eight stars nested in one another. Its cosine, in square roots alone, runs along the foot. */
function rose17(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const n = 17, R = 470, cx = vw / 2, cy = vh / 2;
  const pts = Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / n; return [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  const steps = new Map();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const k = Math.min(j - i, n - (j - i));
    steps.set(k, (steps.get(k) || '') + `M${r1(pts[i][0])} ${r1(pts[i][1])}L${r1(pts[j][0])} ${r1(pts[j][1])}`);
  }
  s.append(svg('circle', { cx: r1(cx), cy: r1(cy), r: R, ...stroke('f-ink', .12, 1) }));
  for (const [k, d] of steps) s.append(svg('path', { d, ...(k === 1 ? stroke('f-blue', .3, 2.2) : k === 8 ? stroke('f-gold', .26, 1.2) : stroke('f-ink', .08 + .012 * k, 1)) }));
  for (const [x, y] of pts) s.append(svg('circle', { cx: r1(x), cy: r1(y), r: 6, ...fill('f-blue', .28) }));
  if (!window.katex) return s;
  const box = document.createElement('div');
  box.className = 'field-proof';
  box.append(s, line('16\\cos\\frac{2\\pi}{17} = -1 + \\sqrt{17} + \\sqrt{34 - 2\\sqrt{17}} + 2\\sqrt{17 + 3\\sqrt{17} - \\sqrt{34 - 2\\sqrt{17}} - 2\\sqrt{34 + 2\\sqrt{17}}}',
    { x: 2, y: 89, rot: -2, minor: true, size: 'clamp(16px, 1.9vw, 30px)' }));
  return box;
}

/** The Sierpinski triangle: a triangle with its middle taken out, and again in each of the three left, seven times:
    2 187 triangles, the same at every zoom. The holes of the first three cuts are drawn in gold. */
function sierpinski(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const side = Math.min(1.15 * vw, 1.12 * vh * 2 / Math.sqrt(3)), hgt = side * Math.sqrt(3) / 2, cx = vw / 2, cy = vh / 2 + hgt * 0.04;
  let solid = '', holes = '';
  const tri = (a, b, c) => `M${r1(a[0])} ${r1(a[1])}L${r1(b[0])} ${r1(b[1])}L${r1(c[0])} ${r1(c[1])}Z`;
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const cut = (a, b, c, depth) => {
    if (depth === 0) { solid += tri(a, b, c); return; }
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    if (depth > 4) holes += tri(ab, bc, ca);
    cut(a, ab, ca, depth - 1); cut(ab, b, bc, depth - 1); cut(ca, bc, c, depth - 1);
  };
  const A = [cx, cy - hgt / 2], B = [cx + side / 2, cy + hgt / 2], C = [cx - side / 2, cy + hgt / 2];
  cut(A, B, C, 7);
  s.append(svg('path', { d: solid, ...fill('f-blue', .12) }), svg('path', { d: holes, ...stroke('f-gold', .26, 1.4) }), svg('path', { d: tri(A, B, C), ...stroke('f-ink', .2, 1.4) }));
  return s;
}

/** The Heighway dragon: a strip folded in half twelve times and opened to right angles, 4 095 turns. Four dragons
    turned a quarter about one point fit together and tile the plane around it. */
function dragon(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const order = 12, N = 1 << order;
  const pts = [[0, 0]];
  let x = 0, y = 0, dir = 0;
  for (let i = 1; i <= N; i++) {
    x += [1, 0, -1, 0][dir]; y += [0, 1, 0, -1][dir];
    pts.push([x, y]);
    dir = (dir + ((((i & -i) << 1) & i) ? 3 : 1)) % 4;
  }
  const span = Math.max(...pts.map(([px, py]) => Math.max(Math.abs(px), Math.abs(py))));
  const u = 0.62 * Math.max(vw, vh) / span, cx = vw / 2, cy = vh / 2;
  const tones = [stroke('f-blue', .26, 1.2), stroke('f-gold', .26, 1.2), stroke('f-ink', .16, 1.2), stroke('f-green', .22, 1.2)];
  for (let q = 0; q < 4; q++) {
    const [c, sn] = [[1, 0], [0, 1], [-1, 0], [0, -1]][q];
    const d = 'M' + pts.map(([px, py]) => `${r1(cx + u * (px * c - py * sn))} ${r1(cy + u * (px * sn + py * c))}`).join('L');
    s.append(svg('path', { d, ...tones[q] }));
  }
  return s;
}

/** The Hilbert curve: one line through every cell of a 64 × 64 grid, never crossing itself; beneath it, in blue, the
    same curve at 8 × 8, the shape every block of the finer one repeats. */
function hilbert(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const side = 1.04 * Math.max(vw, vh), x0 = (vw - side) / 2, y0 = (vh - side) / 2;
  const curve = (n) => {
    const cell = side / n;
    let d = '';
    for (let i = 0; i < n * n; i++) {
      let t = i, x = 0, y = 0;
      for (let k = 1; k < n; k *= 2) {
        const rx = 1 & (t >> 1), ry = 1 & (t ^ rx);
        if (ry === 0) { if (rx === 1) { x = k - 1 - x; y = k - 1 - y; } [x, y] = [y, x]; }
        x += k * rx; y += k * ry; t >>= 2;
      }
      d += `${i ? 'L' : 'M'}${r1(x0 + (x + 0.5) * cell)} ${r1(y0 + (y + 0.5) * cell)}`;
    }
    return d;
  };
  s.append(svg('path', { d: curve(8), ...stroke('f-blue', .16, 9) }), svg('path', { d: curve(64), ...stroke('f-ink', .14, 1.1) }));
  return s;
}

/** Ford circles: at every fraction p/q in lowest terms, a circle of diameter 1/q² standing on the line. No two
    overlap, and two touch exactly when their fractions are neighbours, |ps − qr| = 1. Here the line is the window's
    edge and its mirror the opposite edge, one apart, so the circles of the whole numbers touch both and meet each other
    along the middle; the rest stand on the one edge or hang from the other. */
function ford(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const D = Math.min(vw, vh), long = Math.max(vw, vh), across = vh > vw;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const at = (u, v) => (across ? [v, u] : [u, v]);
  const circle = (u, v, r) => { const [x, y] = at(u, v); return `M${r1(x - r)} ${r1(y)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0`; };
  let whole = '', halves = '', rest = '';
  for (let n = -1; n * D <= long + D; n++) {
    for (let q = 1; D / (2 * q * q) >= 1.2; q++) {
      const r = D / (2 * q * q);
      for (let p = 0; p < q; p++) {
        if (gcd(p, q) !== 1) continue;
        const u = (n + p / q) * D;
        if (q === 1) { whole += circle(u, D / 2, r); continue; }
        const both = circle(u, D - r, r) + circle(u, r, r);
        if (q <= 3) halves += both; else rest += both;
      }
    }
  }
  s.append(svg('path', { d: whole, ...fill('f-blue', .04) }), svg('path', { d: halves, ...fill('f-gold', .05) }),
    svg('path', { d: whole, ...stroke('f-blue', .26, 2) }), svg('path', { d: halves, ...stroke('f-gold', .28, 1.6) }), svg('path', { d: rest, ...stroke('f-ink', .15, 1.1) }));
  return s;
}

/** Buffon's needle: needles of one length dropped at random across lines a little further apart; a needle crosses a
    line with chance 2ℓ/(πt), so chance alone, counted, gives π. The needles that cross are in gold. The drop is the
    same every time (its chances are seeded with 1777, the year Buffon published it). */
function buffon(w, h) {
  const { s, vw, vh } = sheet(w, h);
  const t = 100, l = 76, N = narrow(w) ? 220 : 380, rand = chances(1777);
  let lines = '', cross = '', rest = '';
  for (let y = t / 2; y < vh; y += t) lines += `M0 ${r1(y)}H${r1(vw)}`;
  for (let i = 0; i < N; i++) {
    const x = rand() * vw, y = rand() * vh, a = rand() * Math.PI, dx = l / 2 * Math.cos(a), dy = l / 2 * Math.sin(a);
    const seg = `M${r1(x - dx)} ${r1(y - dy)}L${r1(x + dx)} ${r1(y + dy)}`;
    if (Math.floor((y - dy - t / 2) / t) !== Math.floor((y + dy - t / 2) / t)) cross += seg; else rest += seg;
  }
  s.append(svg('path', { d: lines, ...stroke('f-blue', .2, 1.2) }), svg('path', { d: rest, ...stroke('f-ink', .14, 1.5) }), svg('path', { d: cross, ...stroke('f-gold', .28, 1.7) }));
  if (!window.katex) return s;
  const box = document.createElement('div');
  box.className = 'field-proof';
  box.append(s, line('P(\\text{cross}) = \\frac{2\\ell}{\\pi t}', { x: 64, y: 84, rot: -3, tone: 'f-blue', minor: true }));
  return box;
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
const rasterSize = (kind, w, h) => (HALF.has(kind) ? [Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2))] : [Math.max(2, Math.round(w)), Math.max(2, Math.round(h))]);
async function raster(kind, w, h) {
  const [rw, rh] = rasterSize(kind, w, h);
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
  gauss: proof('gauss'), basel: proof('basel'), cantor: proof('cantor'), bayes: proof('bayes'),
  phyllotaxis, penrose, caustic, rose17,
  fern: (w, h) => raster('fern', w, h), sierpinski, dragon, hilbert,
  clifford: (w, h) => raster('clifford', w, h), logistic: (w, h) => raster('logistic', w, h), ford, buffon,
};
const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms));
async function build(id, w, h) {
  try {
    if (RASTER.has(id)) return await Promise.race([BUILDERS[id](w, h), timeout(WATCHDOG_MS)]);
    return BUILDERS[id](w, h);
  } catch { return koch(w, h); }
}

// ---- the decks: which field each phase of the run shows, decided once per visit ----
// Six sets, each one field of each kind; a visit draws one set, and within the first two a proof and a variant, from
// random words of its own, the same for everyone: nothing about any visit is kept or consulted.
const words = (() => { const r = new Uint32Array(3); try { crypto.getRandomValues(r); } catch { for (let i = 0; i < 3; i++) r[i] = Math.floor(Math.random() * 4294967296); } return r; })();
const PROOF = PROOFS[words[1] % PROOFS.length], VARIANT = words[2] & 1;
const SETS = [
  { idle: PROOF, extracting: 'golden', evaluating: VARIANT ? 'julia' : 'mandelbrot', done: 'ulam' },
  { idle: 'golden', extracting: 'koch', evaluating: VARIANT ? 'pendulum' : 'lorenz', done: PROOF },
  { idle: 'bayes', extracting: 'phyllotaxis', evaluating: 'fern', done: 'buffon' },
  { idle: 'caustic', extracting: 'hilbert', evaluating: 'clifford', done: 'gauss' },
  { idle: 'cantor', extracting: 'rose17', evaluating: 'dragon', done: 'ford' },
  { idle: 'penrose', extracting: 'sierpinski', evaluating: 'logistic', done: 'basel' },
];
const DECK = SETS[words[0] % SETS.length];

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
  sets: () => SETS.map((set) => ({ ...set })),
};

if (FIELD && LAYERS.length === 2) {
  // The home field is drawn before the page's first paint settles; the next ones warm up while the
  // page is idle, so a change of phase never waits on a drawing.
  show(FIELD.dataset.still || DECK.idle, { instant: true });
  const idle = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 2000 }) : (fn) => setTimeout(fn, 600);
  for (const id of FIELD.dataset.still ? [] : [DECK.extracting, DECK.evaluating, DECK.done].filter((x) => RASTER.has(x))) {
    idle(() => { const [rw, rh] = rasterSize(id, window.innerWidth, window.innerHeight); pixels(id, rw, rh).catch(() => { /* the snowflake stands in */ }); });
  }
  let timer = 0;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(redraw, 200); });
  if (motion && motion.addEventListener) motion.addEventListener('change', () => LAYERS[state.on].classList.toggle('is-zoom', zoomable(state.id, state.w)));
  window.__field = field;   // for a console or a check, never a product surface
}
