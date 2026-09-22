// ============================================================================
// player.js — first-person body and camera
// ----------------------------------------------------------------------------
// Movement is velocity-smoothed (a little inertia), sub-stepped against the
// collision system, and the camera adds game-feel on top: head bob tied to
// stride, a gentle roll into strafes, and a field-of-view kick when sprinting.
// The player also tracks how many times it has wrapped around the world tile
// so the HUD can report an ever-changing block address.
// ============================================================================
AC.Player = (function () {
  'use strict';
  const { wrapDelta } = AC.util;

  class Player {
    constructor(W, spawn) {
      this.W = W; this.S = W.S;
      this.x = spawn.x; this.y = spawn.y; this.yaw = spawn.yaw; this.pitch = 0.03;
      this.zFeet = AC.Physics.groundAt(this.x, this.y);
      this.vx = 0; this.vy = 0; this.speed = 0;
      this.r = 0.28; this.eye = 1.62;
      this.stepPhase = 0; this.bobAmp = 0; this.fovKick = 0; this.roll = 0;
      this.baseFov = 88 * Math.PI / 180;
      this.tileX = 0; this.tileY = 0;       // wrap counters (for block naming)
      this.sprinting = false; this.onStep = null;
      this.sens = 0.0022;
    }

    update(dt, input, dynColliders) {
      const S = this.S;
      // --- look
      this.yaw -= input.mdx * this.sens;
      this.pitch -= input.mdy * this.sens;
      if (input.key('ArrowLeft')) this.yaw += 2.2 * dt;
      if (input.key('ArrowRight')) this.yaw -= 2.2 * dt;
      if (input.key('ArrowUp')) this.pitch += 1.4 * dt;
      if (input.key('ArrowDown')) this.pitch -= 1.4 * dt;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));

      // --- move
      const f = (input.key('KeyW') ? 1 : 0) - (input.key('KeyS') ? 1 : 0);
      const s = (input.key('KeyD') ? 1 : 0) - (input.key('KeyA') ? 1 : 0);
      this.sprinting = input.key('ShiftLeft') || input.key('ShiftRight');
      const maxV = this.sprinting ? 7.0 : 3.4;
      const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw), rx = Math.sin(this.yaw), ry = -Math.cos(this.yaw);
      let wx = fx * f + rx * s, wy = fy * f + ry * s;
      const wl = Math.hypot(wx, wy);
      if (wl > 0) { wx = (wx / wl) * maxV; wy = (wy / wl) * maxV; }
      const k = 1 - Math.exp(-dt * (wl > 0 ? 9 : 12));
      this.vx += (wx - this.vx) * k; this.vy += (wy - this.vy) * k;

      const ox = this.x, oy = this.y;
      const dist = Math.hypot(this.vx, this.vy) * dt;
      const n = Math.max(1, Math.ceil(dist / 0.15));
      const pos = { x: this.x, y: this.y };
      for (let i = 0; i < n; i++) {
        pos.x += this.vx * dt / n; pos.y += this.vy * dt / n;
        AC.Physics.collide(pos, this.r, this.zFeet, dynColliders, false, null);
      }
      // wrap + tile counters
      if (pos.x >= S) { pos.x -= S; this.tileX++; } else if (pos.x < 0) { pos.x += S; this.tileX--; }
      if (pos.y >= S) { pos.y -= S; this.tileY++; } else if (pos.y < 0) { pos.y += S; this.tileY--; }
      this.x = pos.x; this.y = pos.y;
      const mvx = wrapDelta(this.x - ox, S) / Math.max(dt, 1e-4), mvy = wrapDelta(this.y - oy, S) / Math.max(dt, 1e-4);
      this.speed = Math.min(12, Math.hypot(mvx, mvy));

      // --- ground following (kerbs, thresholds)
      const g = AC.Physics.groundAt(this.x, this.y);
      if (g > this.zFeet) this.zFeet += (g - this.zFeet) * Math.min(1, dt * 16);
      else this.zFeet = Math.max(g, this.zFeet - dt * 3.5);

      // --- game feel: bob, roll, FOV kick
      const prev = this.stepPhase;
      this.stepPhase += this.speed * dt * (Math.PI / 0.78);
      if (this.onStep && Math.floor(prev / Math.PI) !== Math.floor(this.stepPhase / Math.PI) && this.speed > 0.8) this.onStep(this.speed);
      const targetAmp = Math.min(1.2, this.speed / 3.4);
      this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
      const kick = this.sprinting && this.speed > 4 ? 1 : 0;
      this.fovKick += (kick - this.fovKick) * Math.min(1, dt * 5);
      const sway = Math.sin(this.stepPhase) * 0.012 * this.bobAmp;
      this.roll += (-s * 0.03 - input.mdx * 0.00025 + sway - this.roll) * Math.min(1, dt * 7);
    }

    camera() {
      const bob = (0.035 - Math.abs(Math.cos(this.stepPhase)) * 0.07) * this.bobAmp;
      const fov = this.baseFov + this.fovKick * (14 * Math.PI / 180);
      return {
        x: this.x, y: this.y, z: this.zFeet + this.eye + bob,
        yaw: this.yaw, pitch: this.pitch + bob * 0.08, roll: this.roll, tanH: Math.tan(fov / 2),
      };
    }
  }

  return Player;
})();
