// ============================================================================
// environment.js — time of day, weather and global render parameters
// ----------------------------------------------------------------------------
// A single mutable `env` object carries everything that varies over time and
// is read by the shader: sun/moon direction, ambient levels, sky colours, fog,
// wetness, window/lamp activity, traffic signal phase and the phosphor colour.
// ============================================================================
AC.Environment = (function () {
  'use strict';
  const { smoothstep, hash1, clamp } = AC.util;

  const PALETTES = [
    { name: 'P1 GREEN', rgb: [0.52, 1.0, 0.7] },
    { name: 'P3 AMBER', rgb: [1.0, 0.7, 0.32] },
    { name: 'P4 WHITE', rgb: [0.78, 0.9, 1.0] },
    { name: 'CYAN', rgb: [0.35, 0.95, 1.0] },
  ];

  function create() {
    const env = {
      hour: 23.2, timeScale: 0.012, paused: false,
      ambient: 0.04, bounce: 0.01, sunI: 0, sunX: 0, sunY: 0, sunZ: 1,
      moonX: -0.45, moonY: 0.62, moonZ: 0.64,
      skyZenith: 0.01, skyHorizon: 0.06, cityGlow: 0.12, cloudLight: 0.06,
      night: 1, daylight: 0, fogStart: 8, fogDensity: 0.02, fogM: 0.03, fogR: 0, fogG: 0, fogB: 0,
      exposure: 2.3, gain: 1, wet: 0.8, rain: 1, windowsLit: 1, windowGain: 1,
      lampsOn: 1, lampLevel: 1, blinkOn: false, signal: [0, 2], pedWalk: [false, true], pedFlash: false,
      phosphor: PALETTES[0].rgb.slice(), palette: 0, dataStreams: true, headlightGain: 1, reflections: true, reflDist: 38,
      signalT: 0, flicker: 0, glitch: 0,
    };
    // moon direction normalised
    const m = Math.hypot(env.moonX, env.moonY, env.moonZ);
    env.moonX /= m; env.moonY /= m; env.moonZ /= m;
    return env;
  }

  function setPalette(env, i) {
    env.palette = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
    env.phosphor = PALETTES[env.palette].rgb.slice();
    return PALETTES[env.palette].name;
  }

  // Traffic signal cycle (seconds): NS green 11, yellow 3, all-red 1,
  // EW green 10, yellow 3, all-red 1  -> 29 s
  const CYCLE = 29;
  function signals(env, t) {
    const c = ((t % CYCLE) + CYCLE) % CYCLE;
    env.signalT = c;
    if (c < 11) env.signal = [0, 2]; else if (c < 14) env.signal = [1, 2]; else if (c < 15) env.signal = [2, 2];
    else if (c < 25) env.signal = [2, 0]; else if (c < 28) env.signal = [2, 1]; else env.signal = [2, 2];
    // pedestrians crossing the N-S road walk while E-W traffic has green, and vice versa
    const walk0 = c >= 15 && c < 21, flash0 = c >= 21 && c < 25;
    const walk1 = c < 7, flash1 = c >= 7 && c < 11;
    env.pedWalk[0] = walk0; env.pedWalk[1] = walk1;
    env.pedFlash = flash0 || flash1;
    env.pedFlashAxis = flash0 ? 0 : flash1 ? 1 : -1;
  }

  function update(env, dt, t, frame) {
    if (!env.paused) env.hour = (env.hour + dt * env.timeScale + 24) % 24;
    const h = env.hour;
    const ang = ((h - 6) / 12) * Math.PI;           // 0 at sunrise, PI at sunset
    const el = Math.sin(ang);
    const ce = Math.cos(Math.asin(clamp(el, -1, 1)));
    let sx = Math.cos(ang) * ce, sy = -0.35 * ce, sz = el;
    const sl = Math.hypot(sx, sy, sz) || 1;
    env.sunX = sx / sl; env.sunY = sy / sl; env.sunZ = sz / sl;
    const day = smoothstep(-0.06, 0.3, el);
    const night = 1 - smoothstep(-0.18, 0.08, el);
    const dusk = clamp(1 - Math.abs(el) * 5, 0, 1);
    env.daylight = day; env.night = night;
    env.ambient = 0.04 + 0.4 * day + 0.03 * dusk;
    env.bounce = 0.01 + 0.08 * day;
    env.sunI = 0.95 * day;
    env.skyZenith = 0.012 + 0.28 * day + 0.03 * dusk;
    env.skyHorizon = 0.05 + 0.5 * day + 0.12 * dusk;
    env.cityGlow = 0.1 * night + 0.14 * dusk;
    env.cloudLight = 0.05 + 0.35 * day + 0.1 * dusk;
    // fog is the colour of the horizon: violet city glow at night, grey haze by day
    env.fogM = 0.035 + 0.3 * day + 0.04 * dusk;
    const glow = env.cityGlow;
    env.fogR = glow * 0.75; env.fogG = glow * 0.12; env.fogB = glow * 0.62;
    env.fogStart = 8;
    env.fogDensity = 0.026 + 0.01 * env.rain;
    env.windowsLit = 0.22 + 0.78 * (1 - day);
    env.windowGain = 1 - 0.45 * day;
    env.lampLevel = 1 - smoothstep(-0.02, 0.16, el);
    env.lampsOn = env.lampLevel > 0.5 ? 1 : 0;
    env.exposure = 2.6 - 0.9 * day;
    env.headlightGain = 0.35 + 0.65 * (1 - day);
    // wet streets follow the rain
    const target = env.rain > 0 ? 0.6 + 0.4 * env.rain : 0.15;
    env.wet += (target - env.wet) * Math.min(1, dt * 0.08);
    env.blinkOn = (t % 0.8) < 0.4;
    // subtle global flicker (mains hum + random dips)
    const r = hash1(frame * 7919);
    env.gain = 1 - 0.035 * r * r - (r > 0.985 ? 0.12 : 0) + 0.015 * Math.sin(t * 50);
  }

  function timeString(env) {
    const h = Math.floor(env.hour), m = Math.floor((env.hour - h) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function phaseName(env) {
    if (env.daylight > 0.6) return 'DAY';
    if (env.night > 0.85) return 'NIGHT';
    return env.hour < 12 ? 'DAWN' : 'DUSK';
  }

  return { create, update, signals, setPalette, timeString, phaseName, PALETTES };
})();
