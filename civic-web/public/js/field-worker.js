// The two fractal fields of the page's background, drawn off the page's thread (see field.js).
//
// zₙ₊₁ = zₙ² + c, iterated until |z| leaves a circle of radius 8 or the cap is reached. For the
// Mandelbrot set c is the pixel and z₀ = 0; for the Julia set z₀ is the pixel and c = −0.8 + 0.156i.
// The escape time is smoothed (μ = n + 1 − log₂ ln|z|) so the bands are continuous, the level sets of
// μ are drawn as the thin lines a plotted figure has, and the inside is a flat tint. The picture is
// opaque, over the page's own ground colour, and goes back as pixels for a canvas.
self.onmessage = (e) => {
  const { id, kind, w, h, colours, cap } = e.data;
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
  self.postMessage({ id, w, h, buf: px.buffer }, [px.buffer]);
};
