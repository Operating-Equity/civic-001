// The raster fields of the page's background, drawn off the page's thread (see field.js).
//
// The escape-time fractals: zₙ₊₁ = zₙ² + c, iterated until |z| leaves a circle of radius 8 or the cap is
// reached. For the Mandelbrot set c is the pixel and z₀ = 0; for the Julia set z₀ is the pixel and
// c = −0.8 + 0.156i. The escape time is smoothed (μ = n + 1 − log₂ ln|z|) so the bands are continuous, the
// level sets of μ are drawn as the thin lines a plotted figure has, and the inside is a flat tint.
//
// The point fields (25 October): the Barnsley fern, the Clifford attractor and the logistic map's cascade, each
// a map iterated from its own definition, its points counted per pixel and the counts shown on a log scale. The
// fern's chances are a fixed sequence, so it is the same fern every time.
//
// Every picture is opaque, over the page's own ground colour, and goes back as pixels for a canvas.
self.onmessage = (e) => {
  const { id, kind, w, h, colours, cap } = e.data;
  const px = kind === 'mandelbrot' || kind === 'julia' ? escape(kind, w, h, colours, cap) : points(kind, w, h, colours);
  self.postMessage({ id, w, h, buf: px.buffer }, [px.buffer]);
};

function escape(kind, w, h, colours, cap) {
  const px = new Uint8ClampedArray(w * h * 4);
  const G = colours.ground, B = colours.blue, Y = colours.gold, I = colours.ink;
  const mandel = kind === 'mandelbrot';
  const span = mandel ? 3.2 : 3.4, cx = mandel ? -0.6 : 0, cy = 0;
  const unit = span / Math.max(w, h);
  const left = cx - (w * unit) / 2, top = cy + (h * unit) / 2;
  const JR = -0.8, JI = 0.156;
  let p = 0;
  for (let j = 0; j < h; j++) {
    const y0 = top - j * unit;
    for (let i = 0; i < w; i++, p += 4) {
      const x0 = left + i * unit;
      let zr, zi, cr, ci, inside = false;
      if (mandel) {
        zr = 0; zi = 0; cr = x0; ci = y0;
        // The cardioid and the period-2 bulb are inside by their own equations: no iteration needed.
        const q = (cr - 0.25) * (cr - 0.25) + ci * ci;
        inside = q * (q + (cr - 0.25)) <= 0.25 * ci * ci || (cr + 1) * (cr + 1) + ci * ci <= 0.0625;
      } else { zr = x0; zi = y0; cr = JR; ci = JI; }
      let n = 0, zr2 = zr * zr, zi2 = zi * zi;
      if (!inside) {
        while (n < cap && zr2 + zi2 <= 64) { zi = 2 * zr * zi + ci; zr = zr2 - zi2 + cr; zr2 = zr * zr; zi2 = zi * zi; n++; }
        inside = n >= cap;
      }
      let r = G[0], g = G[1], b = G[2];
      if (inside) {
        r += (B[0] - r) * 0.2; g += (B[1] - g) * 0.2; b += (B[2] - b) * 0.2;
      } else {
        const mu = Math.max(0, n + 1 - Math.log(Math.log(zr2 + zi2) / 2) / Math.LN2);
        const t = Math.min(1, mu / cap);
        const a = 0.24 * Math.pow(t, 1.3);
        const u = t > 0.6 ? (t - 0.6) / 0.4 : 0;
        r += (B[0] + (Y[0] - B[0]) * u - r) * a; g += (B[1] + (Y[1] - B[1]) * u - g) * a; b += (B[2] + (Y[2] - B[2]) * u - b) * a;
        const lv = Math.log2(1 + mu) * 2, f = lv - Math.floor(lv);
        if (f < 0.1) { const la = 0.13 * (1 - f / 0.1) * (0.4 + 0.6 * t); r += (I[0] - r) * la; g += (I[1] - g) * la; b += (I[2] - b) * la; }
      }
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  }
  return px;
}

// A fixed sequence of chances (mulberry32), as field.js has it.
const chances = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function points(kind, w, h, C) {
  const count = new Float32Array(w * h);
  // A point of the fern or the attractor marks the 2 × 2 pixels it falls on, so a thin line of points reads as a line;
  // the cascade's points mark one pixel each, so its chaos keeps its grain.
  const fine = kind === 'logistic';
  const put = (x, y) => {
    const i = x | 0, j = y | 0;
    if (i < 0 || j < 0 || i >= w - 1 || j >= h - 1) return;
    const k = j * w + i;
    count[k]++;
    if (!fine) { count[k + 1]++; count[k + w]++; count[k + w + 1]++; }
  };
  if (kind === 'clifford') {
    // xₙ₊₁ = sin(a yₙ) + c cos(a xₙ), yₙ₊₁ = sin(b xₙ) + d cos(b yₙ), with a −1.4, b 1.6, c 1, d 0.7: |x| ≤ 2, |y| ≤ 1.7.
    const a = -1.4, b = 1.6, c = 1, d = 0.7, N = Math.round(Math.min(1200000, w * h * 0.6)), k = 1.08 * Math.min(w / 4.2, h / 3.5);
    let x = 0.1, y = 0.1;
    for (let n = 0; n < N; n++) {
      const nx = Math.sin(a * y) + c * Math.cos(a * x), ny = Math.sin(b * x) + d * Math.cos(b * y);
      x = nx; y = ny;
      if (n > 20) put(w / 2 + x * k, h / 2 - y * k);
    }
  } else if (kind === 'logistic') {
    // xₙ₊₁ = r xₙ (1 − xₙ) for r from 2.6 to 4, left to right: one value, then two, four, eight, then chaos and its
    // windows of order. Each r settles for 400 steps; the next 180 are counted.
    const top = h * 0.06, span = h * 0.88, per = 2;
    for (let i = 0; i < w * per; i++) {
      const r = 2.6 + 1.4 * i / (w * per - 1);
      let x = 0.5;
      for (let n = 0; n < 400; n++) x = r * x * (1 - x);
      for (let n = 0; n < 180; n++) { x = r * x * (1 - x); put(i / per, top + (1 - x) * span); }
    }
  } else {
    // The Barnsley fern: four affine maps, taken with chances 1, 85, 7 and 7 in 100; 0 ≤ y ≤ 10. It rises from the foot
    // of the window, leaning a little, as tall as the window.
    const N = Math.round(Math.min(500000, w * h * 0.35)), rand = chances(7), k = h * 1.02 / 10, lean = -0.18;
    const cs = Math.cos(lean), sn = Math.sin(lean), bx = w * 0.6, by = h * 1.03;
    let x = 0, y = 0;
    for (let n = 0; n < N; n++) {
      const p = rand();
      let nx, ny;
      if (p < 0.01) { nx = 0; ny = 0.16 * y; }
      else if (p < 0.86) { nx = 0.85 * x + 0.04 * y; ny = -0.04 * x + 0.85 * y + 1.6; }
      else if (p < 0.93) { nx = 0.2 * x - 0.26 * y; ny = 0.23 * x + 0.22 * y + 1.6; }
      else { nx = -0.15 * x + 0.28 * y; ny = 0.26 * x + 0.24 * y + 0.44; }
      x = nx; y = ny;
      if (n > 20) put(bx + k * (x * cs - y * sn), by - k * (x * sn + y * cs));
    }
  }
  // The counts on a log scale, against the count 98 in 100 marked pixels stay under (a few crowded spots never wash the
  // rest out), faint over the ground: at the densest .26, so the glass's text keeps its contrast.
  let max = 0, marked = 0;
  for (let i = 0; i < count.length; i++) if (count[i] > 0) { marked++; if (count[i] > max) max = count[i]; }
  const hist = new Uint32Array(Math.min(max, 65535) + 1);
  for (let i = 0; i < count.length; i++) if (count[i] > 0) hist[Math.min(count[i], 65535)]++;
  let seen = 0, q = 1;
  for (let v = 1; v < hist.length; v++) { seen += hist[v]; if (seen >= marked * 0.98) { q = v; break; } }
  const px = new Uint8ClampedArray(w * h * 4), G = C.ground, lq = Math.log(1 + q) || 1;
  const A = kind === 'fern' ? C.green : C.blue, B = kind === 'fern' ? C.green : C.gold;
  for (let j = 0, p = 0; j < h; j++) {
    for (let i = 0; i < w; i++, p += 4) {
      const v = count[j * w + i];
      let r = G[0], g = G[1], b = G[2];
      if (v > 0) {
        const t = Math.min(1, Math.log(1 + v) / lq), a = 0.09 + 0.17 * t;
        const u = kind === 'logistic' ? i / w : t;   // the cascade turns gold as order gives way; a cloud, where it is densest
        r += (A[0] + (B[0] - A[0]) * u - r) * a; g += (A[1] + (B[1] - A[1]) * u - g) * a; b += (A[2] + (B[2] - A[2]) * u - b) * a;
      }
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  }
  return px;
}
