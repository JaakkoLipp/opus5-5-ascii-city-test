// ============================================================================
// audio.js — tiny procedural soundscape (WebAudio, no samples)
// ----------------------------------------------------------------------------
// Rain hiss (filtered noise), a low city drone, footsteps and UI blips. Starts
// on the first click (browser autoplay rules) and can be muted with N.
// ============================================================================
AC.Audio = (function () {
  'use strict';
  let ctx = null, master = null, rainGain = null, droneGain = null, noiseBuf = null, on = true;

  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC_ = window.AudioContext || window.webkitAudioContext;
    if (!AC_) return;
    ctx = new AC_();
    master = ctx.createGain(); master.gain.value = on ? 0.5 : 0; master.connect(ctx.destination);
    // noise buffer
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s / 0x7fffffff) * 2 - 1; }
    // rain
    const rn = ctx.createBufferSource(); rn.buffer = noiseBuf; rn.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
    rainGain = ctx.createGain(); rainGain.gain.value = 0.0;
    rn.connect(bp); bp.connect(lp); lp.connect(rainGain); rainGain.connect(master); rn.start();
    // drone
    droneGain = ctx.createGain(); droneGain.gain.value = 0.05;
    const dl = ctx.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 160;
    for (const f of [41.2, 41.7, 61.8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(dl); o.start();
    }
    dl.connect(droneGain); droneGain.connect(master);
  }

  function setRain(level) { if (rainGain) rainGain.gain.setTargetAtTime(0.09 * level, ctx.currentTime, 0.5); }

  function step(speed) {
    if (!ctx || !on) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500 + speed * 60;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.005); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 1.5, 0.1);
  }

  function blip(freq, dur) {
    if (!ctx || !on) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq || 880;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + (dur || 0.12));
    o.connect(g); g.connect(master); o.start(t); o.stop(t + (dur || 0.12) + 0.02);
  }

  function toggle() { on = !on; if (master) master.gain.value = on ? 0.5 : 0; return on; }

  return { start, setRain, step, blip, toggle, get on() { return on; } };
})();
