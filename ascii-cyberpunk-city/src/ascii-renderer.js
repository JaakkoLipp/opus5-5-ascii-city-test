// ============================================================================
// ascii-renderer.js — the terminal: glyph atlas, character buffers, geometry
// edge pass, phosphor persistence and the software blitter
// ----------------------------------------------------------------------------
// The renderer owns a grid of `cols x rows` character cells. The raycaster and
// shader fill the SCENE buffers (glyph index, colour, depth, surface key,
// luminance). Post passes then operate on characters, not pixels:
//
//   edges()   — compares each cell's surface key / depth with its 8 neighbours
//               (a Sobel over "is this neighbour a different, farther surface")
//               and swaps in an oriented line glyph: _ ¯ | / \ . This outlines
//               silhouettes and creases using real geometry, not image colour.
//   compose() — phosphor persistence: a cell that was brighter last frame
//               keeps its old glyph, decaying, which leaves motion trails.
//   present() — blits every changed cell from a pre-rendered glyph atlas into
//               an ImageData (16-level alpha LUT per cell), then putImageData.
//               A downscaled copy feeds a CSS-blurred "glow" canvas.
// ============================================================================
AC.Glyphs = (function () {
  'use strict';
  // index 0 must be the space character
  let CHARS = '';
  for (let c = 32; c < 127; c++) CHARS += String.fromCharCode(c);
  CHARS += '¯·█▓▒░▀▄─│┌┐└┘═║╔╗╚╝■▌▐';
  const map = new Int16Array(0x2600);
  const list = Array.from(CHARS);
  list.forEach((ch, i) => { const c = ch.charCodeAt(0); if (c < map.length) map[c] = i; });
  function index(ch) { const c = ch.charCodeAt(0); return c < map.length ? map[c] : 0; }
  return { list, index, count: list.length };
})();

AC.Screen = (function () {
  'use strict';
  const Gl = AC.Glyphs;
  const FONT = '"DejaVu Sans Mono", "Cascadia Mono", Consolas, "Liberation Mono", Menlo, "Courier New", monospace';

  const scr = {
    cols: 0, rows: 0, CW: 0, CH: 0, W: 0, H: 0,
    // scene buffers
    glyph: null, fr: null, fg: null, fb: null, gT: null, gKey: null, gLum: null,
    // display buffers (after persistence + HUD)
    dGlyph: null, dR: null, dG: null, dB: null, dBgR: null, dBgG: null, dBgB: null,
    persist: true, glowOn: true, edgeOn: true,
  };
  let canvas = null, ctx = null, glowCanvas = null, gctx = null, img = null, fb32 = null;
  let atlas = null;                       // Uint8Array nGlyphs * CW * CH, values 0..15
  let pLum, pGlyph, pR, pG, pB;           // persistence state
  let lastG, lastR, lastG2, lastB, lastBg; // what is currently on the canvas
  const lut = new Uint32Array(16);

  function init(canvasEl, glowEl) {
    canvas = canvasEl; ctx = canvas.getContext('2d', { alpha: false });
    glowCanvas = glowEl; gctx = glowCanvas ? glowCanvas.getContext('2d', { alpha: false }) : null;
  }

  function configure(cols, rows, CW, CH) {
    scr.cols = cols; scr.rows = rows; scr.CW = CW; scr.CH = CH;
    scr.W = cols * CW; scr.H = rows * CH;
    canvas.width = scr.W; canvas.height = scr.H;
    if (glowCanvas) { glowCanvas.width = Math.max(1, (cols * CW) >> 2); glowCanvas.height = Math.max(1, (rows * CH) >> 2); }
    const n = cols * rows;
    scr.glyph = new Uint8Array(n); scr.fr = new Uint8ClampedArray(n); scr.fg = new Uint8ClampedArray(n); scr.fb = new Uint8ClampedArray(n);
    scr.gT = new Float32Array(n); scr.gKey = new Int32Array(n); scr.gLum = new Float32Array(n);
    scr.dGlyph = new Uint8Array(n); scr.dR = new Uint8ClampedArray(n); scr.dG = new Uint8ClampedArray(n); scr.dB = new Uint8ClampedArray(n);
    scr.dBgR = new Uint8ClampedArray(n); scr.dBgG = new Uint8ClampedArray(n); scr.dBgB = new Uint8ClampedArray(n);
    pLum = new Float32Array(n); pGlyph = new Uint8Array(n); pR = new Float32Array(n); pG = new Float32Array(n); pB = new Float32Array(n);
    lastG = new Int16Array(n).fill(-1); lastR = new Uint8Array(n); lastG2 = new Uint8Array(n); lastB = new Uint8Array(n); lastBg = new Uint32Array(n);
    img = ctx.createImageData(scr.W, scr.H);
    fb32 = new Uint32Array(img.data.buffer);
    fb32.fill(0xff000000);
    buildAtlas();
  }

  // Render every glyph once with the browser's monospace font (box/block
  // characters are drawn procedurally so they tile seamlessly).
  function buildAtlas() {
    const CW = scr.CW, CH = scr.CH, n = Gl.count;
    const c = document.createElement('canvas');
    c.width = CW * n; c.height = CH;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    const fs = Math.max(6, Math.round(CH * 0.8));
    g.font = `bold ${fs}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const special = {
      '█': (x) => g.fillRect(x, 0, CW, CH),
      '▀': (x) => g.fillRect(x, 0, CW, CH >> 1),
      '▄': (x) => g.fillRect(x, CH >> 1, CW, CH - (CH >> 1)),
      '▌': (x) => g.fillRect(x, 0, CW >> 1, CH),
      '▐': (x) => g.fillRect(x + (CW >> 1), 0, CW - (CW >> 1), CH),
      '─': (x) => g.fillRect(x, CH >> 1, CW, 1),
      '│': (x) => g.fillRect(x + (CW >> 1), 0, 1, CH),
      '═': (x) => { g.fillRect(x, (CH >> 1) - 2, CW, 1); g.fillRect(x, (CH >> 1) + 1, CW, 1); },
      '║': (x) => { g.fillRect(x + (CW >> 1) - 2, 0, 1, CH); g.fillRect(x + (CW >> 1) + 1, 0, 1, CH); },
      '┌': (x) => { g.fillRect(x + (CW >> 1), CH >> 1, CW - (CW >> 1), 1); g.fillRect(x + (CW >> 1), CH >> 1, 1, CH - (CH >> 1)); },
      '┐': (x) => { g.fillRect(x, CH >> 1, (CW >> 1) + 1, 1); g.fillRect(x + (CW >> 1), CH >> 1, 1, CH - (CH >> 1)); },
      '└': (x) => { g.fillRect(x + (CW >> 1), CH >> 1, CW - (CW >> 1), 1); g.fillRect(x + (CW >> 1), 0, 1, (CH >> 1) + 1); },
      '┘': (x) => { g.fillRect(x, CH >> 1, (CW >> 1) + 1, 1); g.fillRect(x + (CW >> 1), 0, 1, (CH >> 1) + 1); },
      '¯': (x) => g.fillRect(x, 1, CW, Math.max(1, CH >> 4) + 1),
      '■': (x) => g.fillRect(x + 1, CH >> 2, CW - 2, CH >> 1),
    };
    Gl.list.forEach((ch, i) => {
      const x = i * CW;
      if (special[ch]) special[ch](x);
      else if (ch === '▓' || ch === '▒' || ch === '░') {
        const k = ch === '▓' ? 3 : ch === '▒' ? 2 : 1;
        for (let yy = 0; yy < CH; yy++) for (let xx = 0; xx < CW; xx++) if (((xx + yy * 3) % 4) < k) g.fillRect(x + xx, yy, 1, 1);
      } else if (ch !== ' ') {
        g.save(); g.beginPath(); g.rect(x, 0, CW, CH); g.clip();
        g.fillText(ch, x + CW / 2, CH / 2 + 1);
        g.restore();
      }
    });
    const data = g.getImageData(0, 0, c.width, c.height).data;
    atlas = new Uint8Array(n * CW * CH);
    for (let i = 0; i < n; i++) {
      let o = i * CW * CH;
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const a = data[(y * c.width + i * CW + x) * 4];
        atlas[o++] = Math.min(15, Math.round((a / 255) * 15 * 1.15));
      }
    }
  }

  // ------------------------------------------------------------- edge pass
  const G_UND = Gl.index('_'), G_OVR = Gl.index('¯'), G_BAR = Gl.index('|'), G_SL = Gl.index('/'), G_BS = Gl.index('\\');
  // A cell is an outline cell if a neighbour belongs to a different surface
  // that is clearly FARTHER away (a silhouette), or — for creases between two
  // faces at the same depth — if the differing neighbour is to its right or
  // below (so a crease is drawn one character thick, not two).
  function edges(r0, r1, maxDist, floorLum) {
    const cols = scr.cols, gT = scr.gT, gKey = scr.gKey, gLum = scr.gLum;
    const glyph = scr.glyph, fr = scr.fr, fg = scr.fg, fb = scr.fb;
    for (let r = r0 + 1; r < r1 - 1; r++) {
      let i = r * cols + 1;
      for (let c = 1; c < cols - 1; c++, i++) {
        const t = gT[i];
        if (t > maxDist) continue;
        const k = gKey[i];
        const far = t * 1.12 + 0.3, near = t * 0.97;
        const crease = k > 0 && (k >> 26) !== 1;   // floors never form creases
        let ul = 0, u = 0, ur = 0, l = 0, rr = 0, dl = 0, d = 0, dr = 0, j, kj;
        j = i - cols - 1; kj = gKey[j]; if (kj !== k && gT[j] > far) ul = 1;
        j = i - cols; kj = gKey[j]; if (kj !== k && gT[j] > far) u = 1;
        j = i - cols + 1; kj = gKey[j]; if (kj !== k && gT[j] > far) ur = 1;
        j = i - 1; kj = gKey[j]; if (kj !== k && gT[j] > far) l = 1;
        j = i + 1; kj = gKey[j]; if (kj !== k && (gT[j] > far || (crease && (kj >> 26) !== 1 && gT[j] >= near))) rr = 1;
        j = i + cols - 1; kj = gKey[j]; if (kj !== k && gT[j] > far) dl = 1;
        j = i + cols; kj = gKey[j]; if (kj !== k && (gT[j] > far || (crease && kj !== 0 && gT[j] >= near))) d = 1;
        j = i + cols + 1; kj = gKey[j]; if (kj !== k && gT[j] > far) dr = 1;
        if (!(ul | u | ur | l | rr | dl | d | dr)) continue;
        const v = gLum[i];
        if (v > 0.7) continue; // keep bright emissive glyphs (neon letters)
        const gx = (ur + 2 * rr + dr) - (ul + 2 * l + dl);
        const gy = (dl + 2 * d + dr) - (ul + 2 * u + ur);
        const ax = gx < 0 ? -gx : gx, ay = gy < 0 ? -gy : gy;
        if (ax === 0 && ay === 0) continue;
        let g;
        if (ay >= ax * 2) g = gy > 0 ? G_UND : G_OVR;
        else if (ax >= ay * 2) g = G_BAR;
        else g = gx * gy > 0 ? G_SL : G_BS;
        glyph[i] = g;
        // brighten the outline a little, with a floor so dark silhouettes still read
        const fade = 1 - t / maxDist;
        const ev = Math.max(v * 1.15, floorLum * fade * fade);
        const s = (0.2 + 0.8 * ev) / (0.2 + 0.8 * v);
        fr[i] = fr[i] * s; fg[i] = fg[i] * s; fb[i] = fb[i] * s;
        gLum[i] = ev;
      }
    }
  }

  // ----------------------------------------------------- persistence/compose
  function compose(dt) {
    const n = scr.cols * scr.rows;
    const decay = scr.persist ? Math.pow(0.42, dt * 60) : 0;
    const glyph = scr.glyph, fr = scr.fr, fg = scr.fg, fb = scr.fb, gLum = scr.gLum;
    const dGlyph = scr.dGlyph, dR = scr.dR, dG = scr.dG, dB = scr.dB, bR = scr.dBgR, bG = scr.dBgG, bB = scr.dBgB;
    for (let i = 0; i < n; i++) {
      const v = gLum[i];
      const pv = pLum[i] * decay;
      if (pv > v + 0.1) {
        pLum[i] = pv;
        const r = (pR[i] *= decay * 1.1 > 1 ? 1 : decay * 1.1), g = (pG[i] *= decay * 1.1 > 1 ? 1 : decay * 1.1), b = (pB[i] *= decay * 1.1 > 1 ? 1 : decay * 1.1);
        dGlyph[i] = pGlyph[i]; dR[i] = r; dG[i] = g; dB[i] = b;
      } else {
        pLum[i] = v; pGlyph[i] = glyph[i]; pR[i] = fr[i]; pG[i] = fg[i]; pB[i] = fb[i];
        dGlyph[i] = glyph[i]; dR[i] = fr[i]; dG[i] = fg[i]; dB[i] = fb[i];
      }
      // bright cells get a faint coloured cell background (phosphor bloom)
      if (v > 0.8) { const k = (v - 0.8) * 0.5; bR[i] = dR[i] * k; bG[i] = dG[i] * k; bB[i] = dB[i] * k; }
      else { bR[i] = 0; bG[i] = 0; bB[i] = 0; }
    }
  }

  // HUD text writer (display buffers)
  function text(col, row, str, r, g, b, bgr, bgg, bgb) {
    const cols = scr.cols;
    if (row < 0 || row >= scr.rows) return;
    for (let k = 0; k < str.length; k++) {
      const c = col + k;
      if (c < 0 || c >= cols) continue;
      const i = row * cols + c;
      scr.dGlyph[i] = Gl.index(str[k]);
      scr.dR[i] = r; scr.dG[i] = g; scr.dB[i] = b;
      if (bgr !== undefined) { scr.dBgR[i] = bgr; scr.dBgG[i] = bgg; scr.dBgB[i] = bgb; }
    }
  }
  function fill(col, row, w, h, ch, r, g, b, bgr, bgg, bgb) {
    for (let y = row; y < row + h; y++) text(col, y, ch.repeat(w), r, g, b, bgr, bgg, bgb);
  }

  // ------------------------------------------------------------------ blit
  function present() {
    const cols = scr.cols, rows = scr.rows, CW = scr.CW, CH = scr.CH, W = scr.W;
    const dGlyph = scr.dGlyph, dR = scr.dR, dG = scr.dG, dB = scr.dB, bR = scr.dBgR, bG = scr.dBgG, bB = scr.dBgB;
    const cellPx = CW * CH;
    let drawn = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const g = dGlyph[i], R = dR[i], Gc = dG[i], B = dB[i];
        const bg = (bR[i]) | (bG[i] << 8) | (bB[i] << 16);
        if (lastG[i] === g && lastR[i] === R && lastG2[i] === Gc && lastB[i] === B && lastBg[i] === bg) continue;
        lastG[i] = g; lastR[i] = R; lastG2[i] = Gc; lastB[i] = B; lastBg[i] = bg;
        drawn++;
        const br = bR[i], bgc = bG[i], bb = bB[i];
        for (let k = 0; k < 16; k++) {
          const a = k / 15;
          lut[k] = 0xff000000 | (((bb + (B - bb) * a) & 255) << 16) | (((bgc + (Gc - bgc) * a) & 255) << 8) | ((br + (R - br) * a) & 255);
        }
        let ao = g * cellPx;
        let p = r * CH * W + c * CW;
        for (let y = 0; y < CH; y++, p += W) {
          for (let x = 0; x < CW; x++) fb32[p + x] = lut[atlas[ao++]];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    if (scr.glowOn && gctx) {
      gctx.imageSmoothingEnabled = true;
      gctx.drawImage(canvas, 0, 0, glowCanvas.width, glowCanvas.height);
    }
    return drawn;
  }

  function invalidate() { if (lastG) lastG.fill(-1); }

  return { scr, init, configure, edges, compose, text, fill, present, invalidate };
})();
