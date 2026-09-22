// ============================================================================
// util.js — shared namespace, deterministic RNG, integer hashing, value noise
// ----------------------------------------------------------------------------
// Everything in the engine that needs randomness goes through either a seeded
// RNG (world generation, AI decisions) or a stateless hash (per-surface texture
// variation). Nothing calls Math.random(), so a given seed always produces the
// same city and the same traffic.
// ============================================================================
const AC = {};

AC.util = (function () {
  'use strict';

  // Small, fast 32-bit PRNG (mulberry32 variant). Deterministic per seed.
  class RNG {
    constructor(seed) { this.s = (seed >>> 0) || 1; }
    next() {
      let t = (this.s = (this.s + 0x6D2B79F5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor((b - a + 1) * this.next()); } // inclusive
    chance(p) { return this.next() < p; }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    fork(salt) { return new RNG(ihash((this.s ^ Math.imul(salt | 0, 0x9E3779B1)) | 0)); }
  }

  // Integer avalanche hash -> uint32
  function ihash(x) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  }
  const INV32 = 1 / 4294967296;
  function hash1(x) { return ihash(x | 0) * INV32; }
  function hash2(x, y) { return ihash(Math.imul(x | 0, 0x27d4eb2d) ^ ihash(y | 0)) * INV32; }
  function hash3(x, y, z) {
    return ihash(Math.imul(x | 0, 0x27d4eb2d) ^ ihash(Math.imul(y | 0, 0x165667b1) ^ ihash(z | 0))) * INV32;
  }

  // 2D value noise. `period` (optional, integer) makes the lattice tile so that
  // textures stay seamless across the wrap-around edge of the world.
  function vnoise2(x, y, period) {
    let xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    let xj = xi + 1, yj = yi + 1;
    if (period) {
      xi = ((xi % period) + period) % period; yi = ((yi % period) + period) % period;
      xj = xi + 1 === period ? 0 : xi + 1; yj = yi + 1 === period ? 0 : yi + 1;
    }
    const a = hash2(xi, yi), b = hash2(xj, yi), c = hash2(xi, yj), d = hash2(xj, yj);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  // Wrap a coordinate into [0, S)
  function wrap(x, S) { x %= S; return x < 0 ? x + S : x; }
  // Shortest signed delta on a ring of size S
  function wrapDelta(d, S) {
    d %= S;
    if (d > S * 0.5) d -= S; else if (d < -S * 0.5) d += S;
    return d;
  }

  return { RNG, ihash, hash1, hash2, hash3, vnoise2, clamp, lerp, smoothstep, wrap, wrapDelta };
})();
