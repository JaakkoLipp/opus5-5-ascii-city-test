// ============================================================================
// parallel.js — multi-threaded ray casting with Web Workers
// ----------------------------------------------------------------------------
// The whole engine is plain deterministic JavaScript, so a worker can simply
// run the same bundle and regenerate an identical city from the seed. Per
// frame the main thread only ships what changes:
//
//   camera, env (time of day, fog, signals, ...), animated light intensities
//   and colours, animated sign state, the dynamic primitives/objects emitted
//   by the entity system (cars, walkers, doors) and the dynamic light buckets.
//
// Each of N workers ray casts and shades an interleaved set of rows
// (row r goes to worker r mod N, which balances sky rows against street
// rows) and posts back packed glyph/colour/depth/key/luminance rows. The main
// thread keeps simulation, the edge pass, particles, persistence, HUD and the
// blit. Frames are pipelined: the image presented in frame N was dispatched in
// frame N-1, so the workers render while the main thread simulates.
//
// If workers are unavailable (e.g. running the unbundled dev page) the game
// silently falls back to single-threaded rendering.
// ============================================================================
AC.Parallel = (function () {
  'use strict';
  const World = AC.World, PS = World.PS, OS = World.OS;

  // ---------------------------------------------------------- worker side
  function workerMain() {
    let W = null, env = null;
    const scr = { cols: 0, rows: 0, CW: 1, CH: 1, glyph: null, fr: null, fg: null, fb: null, gT: null, gKey: null, gLum: null };
    self.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'init') {
        W = AC.WorldGen.generate(m.seed);
        AC.Raycaster.init(W);
        env = AC.Environment.create();
        AC.Shading.init(W, env, scr);
        self.postMessage({ type: 'ready' });
        return;
      }
      if (m.type !== 'job' || !W) return;
      if (scr.cols !== m.cols || scr.rows !== m.rows) {
        const n = m.cols * m.rows;
        scr.cols = m.cols; scr.rows = m.rows;
        scr.glyph = new Uint8Array(n); scr.fr = new Uint8ClampedArray(n); scr.fg = new Uint8ClampedArray(n); scr.fb = new Uint8ClampedArray(n);
        scr.gT = new Float32Array(n); scr.gKey = new Int32Array(n); scr.gLum = new Float32Array(n);
      }
      scr.CW = m.CW; scr.CH = m.CH;
      Object.assign(env, m.env);
      // animated static state
      W.lcur.set(m.lcur); W.lr.set(m.lr); W.lg.set(m.lg); W.lb.set(m.lb);
      const sd = m.signs;
      for (let k = 0; k < W.signs.length && k * 6 < sd.length; k++) {
        const sg = W.signs[k], o = k * 6;
        sg.cur = sd[o]; sg.scroll = sd[o + 1]; sg.colCur = sd[o + 2]; sg.chase = sd[o + 3]; sg.broken = sd[o + 4]; sg.brokenOn = sd[o + 5];
      }
      // dynamic geometry
      W.resetDynamic();
      W.prims.set(m.prims, W.nStaticPrims * PS); W.nPrims = W.nStaticPrims + m.prims.length / PS;
      W.objs.set(m.objs, W.nStaticObjs * OS); W.nObjs = W.nStaticObjs + m.objs.length / OS;
      for (let oi = W.nStaticObjs; oi < W.nObjs; oi++) W.registerDynamic(oi);
      // dynamic lights
      const D = AC.dynLights, dl = m.dl;
      D.n = dl.n;
      for (const k of ['x', 'y', 'z', 'dx', 'dy', 'dz', 'cos', 'r2', 'I', 'r', 'g', 'b', 'mono']) D[k].set(dl[k]);
      D.bStart.set(dl.bStart);
      D.bList = dl.bList;
      // render the interleaved rows
      AC.Shading.beginFrame(m.time, m.frame, m.cam, m.maxT);
      AC.Raycaster.castFrame(m.cam, scr, m.r0, m.r1, m.maxT, AC.Shading.shade, m.step, m.phase);
      const cols = scr.cols;
      let nr = 0;
      for (let r = m.r0 + m.phase; r < m.r1; r += m.step) nr++;
      const n = nr * cols;
      const out = {
        glyph: new Uint8Array(n), fr: new Uint8ClampedArray(n), fg: new Uint8ClampedArray(n), fb: new Uint8ClampedArray(n),
        gT: new Float32Array(n), gKey: new Int32Array(n), gLum: new Float32Array(n),
      };
      let w = 0;
      for (let r = m.r0 + m.phase; r < m.r1; r += m.step, w += cols) {
        const a = r * cols, b = a + cols;
        out.glyph.set(scr.glyph.subarray(a, b), w); out.fr.set(scr.fr.subarray(a, b), w); out.fg.set(scr.fg.subarray(a, b), w); out.fb.set(scr.fb.subarray(a, b), w);
        out.gT.set(scr.gT.subarray(a, b), w); out.gKey.set(scr.gKey.subarray(a, b), w); out.gLum.set(scr.gLum.subarray(a, b), w);
      }
      const st = AC.Raycaster.stats;
      self.postMessage({ type: 'done', id: m.id, phase: m.phase, cols, out, rays: st.rays, steps: st.steps },
        [out.glyph.buffer, out.fr.buffer, out.fg.buffer, out.fb.buffer, out.gT.buffer, out.gKey.buffer, out.gLum.buffer]);
    };
  }

  // ------------------------------------------------------------ main side
  const P = {
    active: false, supported: false, workers: [], n: 0, ready: 0, busy: 0, jobId: 0, complete: false,
    job: null, dispatchT: 0, latency: 0, rays: 0, steps: 0, failed: false,
  };

  function init(seed, src, count) {
    if (typeof Worker === 'undefined' || !src || src.indexOf('AC.WorldGen') < 0) return false;
    try {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      for (let k = 0; k < count; k++) {
        const w = new Worker(url);
        w.onmessage = (e) => onMessage(e.data);
        w.onerror = (e) => { P.failed = true; P.active = false; console.error('render worker failed, falling back to single thread:', e && e.message); if (e && e.preventDefault) e.preventDefault(); };
        w.postMessage({ type: 'init', seed });
        P.workers.push(w);
      }
      P.n = count; P.supported = true;
      return true;
    } catch (err) {
      P.failed = true;
      return false;
    }
  }

  let target = null; // screen buffers the results are unpacked into
  function onMessage(m) {
    if (m.type === 'ready') { if (++P.ready === P.n && !P.failed) P.active = true; return; }
    if (m.type !== 'done' || !P.job || m.id !== P.job.id) return;
    const scr = target;
    if (scr && m.cols === scr.cols && P.job.cols === scr.cols && P.job.rows === scr.rows) {
      const cols = scr.cols, o = m.out;
      let w = 0;
      for (let r = P.job.r0 + m.phase; r < P.job.r1; r += P.n, w += cols) {
        const a = r * cols;
        scr.glyph.set(o.glyph.subarray(w, w + cols), a); scr.fr.set(o.fr.subarray(w, w + cols), a); scr.fg.set(o.fg.subarray(w, w + cols), a); scr.fb.set(o.fb.subarray(w, w + cols), a);
        scr.gT.set(o.gT.subarray(w, w + cols), a); scr.gKey.set(o.gKey.subarray(w, w + cols), a); scr.gLum.set(o.gLum.subarray(w, w + cols), a);
      }
    } else P.job.stale = true;
    P.rays += m.rays; P.steps += m.steps;
    if (--P.busy === 0) {
      P.complete = !P.job.stale;
      P.latency += (performance.now() - P.dispatchT - P.latency) * 0.1;
      if (P.job.stale) P.job = null;
    }
  }

  function packSigns(W) {
    const n = W.signs.length, a = new Float32Array(n * 6);
    for (let k = 0; k < n; k++) {
      const s = W.signs[k], o = k * 6;
      a[o] = s.cur; a[o + 1] = s.scroll; a[o + 2] = s.colCur; a[o + 3] = s.chase; a[o + 4] = s.broken; a[o + 5] = s.brokenOn;
    }
    return a;
  }

  // Send the current frame to every worker. `W` must already contain this
  // frame's dynamic entities (ents.emit has run).
  function dispatch(W, env, cam, scr, time, frame, maxT) {
    target = scr;
    const id = ++P.jobId;
    const D = AC.dynLights, n = D.n;
    const dl = { n, bStart: D.bStart.slice(), bList: D.bList.slice(0, D.bStart[D.B * D.B]) };
    for (const k of ['x', 'y', 'z', 'dx', 'dy', 'dz', 'cos', 'r2', 'I', 'r', 'g', 'b', 'mono']) dl[k] = D[k].slice();
    const base = {
      type: 'job', id, r0: 1, r1: scr.rows - 1, step: P.n, cols: scr.cols, rows: scr.rows, CW: scr.CW, CH: scr.CH,
      cam, env, time, frame, maxT,
      prims: W.prims.slice(W.nStaticPrims * PS, W.nPrims * PS), objs: W.objs.slice(W.nStaticObjs * OS, W.nObjs * OS),
      lcur: W.lcur, lr: W.lr, lg: W.lg, lb: W.lb, signs: packSigns(W), dl,
    };
    P.job = { id, cam, r0: base.r0, r1: base.r1, cols: scr.cols, rows: scr.rows, time, frame };
    P.busy = P.n; P.complete = false; P.rays = 0; P.steps = 0;
    P.dispatchT = performance.now();
    for (let k = 0; k < P.n; k++) { base.phase = k; P.workers[k].postMessage(base); }
  }

  // Take the finished frame (returns its job record) or null.
  function take() {
    if (!P.complete) return null;
    P.complete = false;
    const j = P.job; P.job = null;
    return j;
  }

  if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined') workerMain();

  return { init, dispatch, take, state: P, get active() { return P.active; }, get busy() { return P.busy > 0; } };
})();
