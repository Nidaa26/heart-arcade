/* ==========================================================================
   
   The gameplay: a soft mochi character (which doubles as your cursor)
   drifts around catching floating hearts ❤ and dodging the broken ones 💔.

   Sections:
     1. CONFIG          — every tunable number lives here
     2. helpers         — tiny math + DOM utilities
     3. AudioManager    — all sound effects, synthesised with the Web Audio API
     4. Game            — state machine, spawning, physics, rendering, HUD
     5. bootstrap       — wire everything together on load

   Relies on window.HF (from particles.js) for the shared heart-drawing math,
   the ambient background and the burst/confetti layer.
   
   ========================================================================== */
(function () {
  "use strict";

  const { rand, traceHeart, fitCanvas, PALETTE, reduceMotion } = window.HF;

  /* ======================================================================
     1. CONFIG — tweak the feel of the game from one place
     ====================================================================== */
  const CONFIG = {
    storage: { high: "heartful.highScore", muted: "heartful.muted" },
    startLives: 3,
    pointsPerHeart: 5,
    milestoneEvery: 50,

    player: {
      baseRadius: 30,     // scaled by screen size at runtime
      ease: 0.2,          // how snappily the mochi follows the pointer
      touchOffsetY: -48,  // lift the mochi above a finger so it stays visible
      trailMax: 10,
    },

    spawn: {
      baseInterval: 1.15, // seconds between spawns at level 1
      minInterval: 0.42,  // fastest it ever gets
      perLevel: 0.07,     // interval shaved off per level
    },

    difficulty: {
      secondsPerLevel: 16,
      maxLevel: 12,
      speedPerLevel: 0.14, // movement speed multiplier added per level
    },

    broken: { base: 0.16, perLevel: 0.022, max: 0.42 },

    combo: { windowMs: 1150, max: 6 },
  };

  // Cheerful, universal praise — nothing romance-specific.
  const PRAISE = ["lovely!", "so cozy!", "sweet!", "you're glowing!", "wonderful!", "warm fuzzies!", "delightful!"];
  const OVER_MESSAGES = [
    "that was lovely.",
    "what a cozy run.",
    "the hearts had fun too.",
    "warm and well played.",
    "take a little stretch ☕",
  ];

  // Canvas can't read CSS variables, so mirror the handwritten font stack here.
  const HAND_FONT = '"Bradley Hand", "Segoe Print", "Comic Sans MS", "Marker Felt", cursive';

  const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
                  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

  /* ======================================================================
     2. helpers
     ====================================================================== */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const choice = (arr) => arr[(Math.random() * arr.length) | 0];
  const $ = (id) => document.getElementById(id);

  const Store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : v; }
      catch (e) { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, val); } catch (e) { /* private mode: ignore */ }
    },
  };

  /** Re-trigger a CSS animation by toggling a class with a forced reflow. */
  function retrigger(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // flush
    el.classList.add(cls);
  }

  /* ======================================================================
     3. AudioManager — Web Audio API synthesis (no audio files needed)
     ====================================================================== */
  class AudioManager {
    constructor(muted) {
      this.muted = muted;
      this.ctx = null;
      this.master = null;
    }

    /** Lazily create the audio context (must follow a user gesture). */
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    }

    setMuted(m) { this.muted = m; }

    /** Play a single enveloped tone, optionally gliding to another pitch. */
    note(freq, start, dur, vol, type = "triangle", glideTo = null) {
      const ctx = this.ensure();
      if (!ctx || this.muted) return;
      const t0 = ctx.currentTime + start;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    // ---- named effects -------------------------------------------------
    collect(combo = 1) {
      const base = 523.25 * Math.pow(1.0595, Math.min(combo, 8) - 1); // rises with combos
      this.note(base, 0, 0.16, 0.16, "triangle", base * 1.18);
      this.note(base * 1.5, 0.05, 0.14, 0.10, "sine");
    }
    hurt() {
      this.note(196, 0, 0.22, 0.16, "square", 120);
      this.note(140, 0.06, 0.2, 0.10, "square", 90);
    }
    gameOver() {
      const seq = [415, 349, 294, 233];
      seq.forEach((f, i) => this.note(f, i * 0.13, 0.24, 0.16, "triangle"));
    }
    click() { this.note(520, 0, 0.05, 0.1, "triangle", 460); }
    milestone() {
      [659, 784, 988, 1319].forEach((f, i) => this.note(f, i * 0.07, 0.16, 0.13, "triangle"));
    }
    levelUp() { [523, 659, 784].forEach((f, i) => this.note(f, i * 0.06, 0.14, 0.13, "triangle")); }
  }

  /* ======================================================================
     4. Game
     ====================================================================== */
  class Game {
    constructor(fx) {
      this.fx = fx;                 // BurstLayer for confetti/sparkles
      this.canvas = $("game-canvas");
      this.ctx = this.canvas.getContext("2d");

      this.state = "menu";          // menu | playing | paused | over
      this.audio = new AudioManager(Store.get(CONFIG.storage.muted, "0") === "1");
      this.best = parseInt(Store.get(CONFIG.storage.high, "0"), 10) || 0;

      // entities & counters
      this.hearts = [];
      this.floaters = [];           // floating "+15" score pops
      this.player = {
        x: 0, y: 0, tx: 0, ty: 0,
        vx: 0, vy: 0, r: CONFIG.player.baseRadius,
        happy: 0, hurt: 0, trail: [],
      };
      this.pointer = { x: 0, y: 0, touch: false };

      this.score = 0;
      this.lives = CONFIG.startLives;
      this.level = 1;
      this.combo = 0;
      this.lastCollect = 0;
      this.elapsed = 0;
      this.spawnTimer = 0;
      this.shake = 0;

      this.konamiIdx = 0;
      this.brandClicks = 0;
      this._toastTimer = null;
      this._comboTimer = null;

      this.loop = this.loop.bind(this);
      this.resize = this.resize.bind(this);
    }

    /* ---- setup --------------------------------------------------------- */
    init() {
      this.resize();
      window.addEventListener("resize", this.resize);
      this.bindDom();
      this.bindInput();
      this.renderHud();
      $("best").textContent = this.best;
      this.applyMuteUi();
    }

    resize() {
      const fit = fitCanvas(this.canvas);
      this.ctx = fit.ctx;
      this.w = fit.w;
      this.h = fit.h;
      this.scale = clamp(Math.min(this.w, this.h) / 720, 0.72, 1.3);
      this.player.r = CONFIG.player.baseRadius * this.scale;
      // keep the mochi on-screen after a resize
      this.player.x = clamp(this.player.x || this.w / 2, 0, this.w);
      this.player.y = clamp(this.player.y || this.h / 2, 0, this.h);
    }

    bindDom() {
      const onClick = (id, fn) => {
        const el = $(id);
        if (el) el.addEventListener("click", () => { this.audio.click(); fn(); });
      };
      onClick("btn-play", () => this.start());
      onClick("btn-again", () => this.start());
      onClick("btn-resume", () => this.resume());
      onClick("btn-pause", () => this.togglePause());
      onClick("btn-pause-restart", () => this.start());
      onClick("btn-restart", () => this.start());
      onClick("btn-mute", () => this.toggleMute());

      // brand logo easter egg
      $("brand").addEventListener("click", () => this.brandEgg());
    }

    bindInput() {
      // The mochi follows the pointer everywhere (mouse, trackpad, touch, pen).
      const onMove = (e) => {
        this.pointer.touch = e.pointerType === "touch";
        this.pointer.x = clamp(e.clientX, 0, this.w);
        const offset = this.pointer.touch ? CONFIG.player.touchOffsetY * this.scale : 0;
        this.pointer.y = clamp(e.clientY + offset, 0, this.h);
        if (this.state === "playing") { this.player.tx = this.pointer.x; this.player.ty = this.pointer.y; }
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerdown", (e) => {
        onMove(e);
        this.audio.ensure(); // unlock audio on first gesture
      }, { passive: true });

      // Keyboard shortcuts + konami easter egg
      window.addEventListener("keydown", (e) => this.onKey(e));

      // Auto-pause if the tab loses focus mid-game.
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.state === "playing") this.pause();
      });
    }

    /* ---- state transitions -------------------------------------------- */
    closeOverlays() {
      ["menu", "pause", "gameover"].forEach((id) => $(id).classList.remove("is-open"));
    }

    reset() {
      this.hearts = [];
      this.floaters = [];
      this.score = 0;
      this.lives = CONFIG.startLives;
      this.level = 1;
      this.combo = 0;
      this.lastCollect = 0;
      this.elapsed = 0;
      this.spawnTimer = 0.6;
      this.shake = 0;
      // start the mochi wherever the pointer is (avoids a jarring glide)
      this.player.x = this.player.tx = this.pointer.x || this.w / 2;
      this.player.y = this.player.ty = this.pointer.y || this.h / 2;
      this.player.trail = [];
      this.player.happy = 0.35;
      this.player.hurt = 0;
      this.ctx.clearRect(0, 0, this.w, this.h);
      this.renderHud();
    }

    start() {
      this.closeOverlays();
      this.reset();
      this.state = "playing";
      document.body.classList.add("playing");
      $("btn-pause").querySelector(".ctrl__icon").textContent = "❚❚";
      // a little welcome sparkle for the "smooth restart" feel
      this.fx.ring(this.player.x, this.player.y, PALETTE.blush);
      this.fx.sparkle(this.player.x, this.player.y, PALETTE.white, 10);
      this.lastTime = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.loop);
    }

    pause() {
      if (this.state !== "playing") return;
      this.state = "paused";
      cancelAnimationFrame(this.raf);
      document.body.classList.remove("playing");
      $("btn-pause").querySelector(".ctrl__icon").textContent = "▶";
      $("pause").classList.add("is-open");
    }

    resume() {
      if (this.state !== "paused") return;
      this.state = "playing";
      document.body.classList.add("playing");
      $("btn-pause").querySelector(".ctrl__icon").textContent = "❚❚";
      $("pause").classList.remove("is-open");
      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this.loop);
    }

    togglePause() {
      if (this.state === "playing") this.pause();
      else if (this.state === "paused") this.resume();
    }

    gameOver() {
      this.state = "over";
      cancelAnimationFrame(this.raf);
      document.body.classList.remove("playing");
      this.audio.gameOver();

      const isBest = this.score > this.best;
      if (isBest) {
        this.best = this.score;
        Store.set(CONFIG.storage.high, String(this.best));
        $("best").textContent = this.best;
      }

      $("final-score").textContent = this.score;
      $("final-best").textContent = this.best;
      $("over-message").textContent = choice(OVER_MESSAGES);
      const newbest = $("newbest");
      newbest.classList.toggle("show", isBest);

      $("gameover").classList.add("is-open");
      if (isBest) {
        // celebrate a new record
        setTimeout(() => {
          this.fx.confetti(this.w / 2, this.h * 0.32, 46);
          this.fx.hearts(this.w / 2, this.h * 0.32, 16);
          this.audio.milestone();
        }, 250);
      }
    }

    /* ---- difficulty & spawning ---------------------------------------- */
    speedMul() { return 1 + (this.level - 1) * CONFIG.difficulty.speedPerLevel; }
    brokenChance() {
      return Math.min(CONFIG.broken.max, CONFIG.broken.base + (this.level - 1) * CONFIG.broken.perLevel);
    }
    spawnInterval() {
      return Math.max(CONFIG.spawn.minInterval, CONFIG.spawn.baseInterval - (this.level - 1) * CONFIG.spawn.perLevel);
    }

    updateDifficulty() {
      const lvl = Math.min(CONFIG.difficulty.maxLevel, 1 + Math.floor(this.elapsed / CONFIG.difficulty.secondsPerLevel));
      if (lvl !== this.level) {
        this.level = lvl;
        this.showToast("level " + lvl + " ✦");
        this.audio.levelUp();
        this.fx.confetti(this.w / 2, 90 * this.scale, 16);
      }
    }

    /** Create one heart entering from a random edge, drifting across. */
    spawnHeart(forceType) {
      const type = forceType || (Math.random() < this.brokenChance() ? "broken" : "good");
      const size = rand(34, 46) * this.scale;
      const margin = size + 40;
      const speed = rand(58, 92) * this.speedMul() * (0.7 + 0.3 * this.scale);

      // pick an edge and an aim point on the far side for a natural crossing
      const edge = (Math.random() * 4) | 0; // 0 top,1 right,2 bottom,3 left
      let x, y;
      if (edge === 0)      { x = rand(0, this.w); y = -margin; }
      else if (edge === 1) { x = this.w + margin; y = rand(0, this.h); }
      else if (edge === 2) { x = rand(0, this.w); y = this.h + margin; }
      else                 { x = -margin; y = rand(0, this.h); }

      const aimX = rand(this.w * 0.2, this.w * 0.8);
      const aimY = rand(this.h * 0.2, this.h * 0.8);
      const ang = Math.atan2(aimY - y, aimX - x);

      this.hearts.push({
        type, x, y, size,
        r: size * 0.42,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        wobblePhase: rand(0, Math.PI * 2),
        wobbleAmp: rand(10, 26) * this.scale,
        wobbleSpeed: rand(1.6, 3.2),
        bobPhase: rand(0, Math.PI * 2),
        baseRot: rand(-0.2, 0.2),
        rx: x, ry: y,
        age: 0,
        value: CONFIG.pointsPerHeart,
      });
    }

    /* ---- update -------------------------------------------------------- */
    update(dt) {
      this.elapsed += dt;
      this.updateDifficulty();

      // spawning
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnHeart();
        if (this.level >= 4 && Math.random() < 0.25) this.spawnHeart(); // occasional pair
        this.spawnTimer = this.spawnInterval() * rand(0.7, 1.25);
      }

      this.updatePlayer(dt);
      this.updateHearts(dt);

      // floaters (score pops)
      for (let i = this.floaters.length - 1; i >= 0; i--) {
        const f = this.floaters[i];
        f.y += f.vy * dt;
        f.vy *= 0.94;
        f.life -= dt * 1.1;
        if (f.life <= 0) this.floaters.splice(i, 1);
      }

      // combo cools down if you take too long between catches
      if (this.combo > 0 && performance.now() - this.lastCollect > CONFIG.combo.windowMs) {
        this.combo = 0;
      }

      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.5);
    }

    updatePlayer(dt) {
      const p = this.player;
      const nx = lerp(p.x, p.tx, CONFIG.player.ease);
      const ny = lerp(p.y, p.ty, CONFIG.player.ease);
      p.vx = nx - p.x;
      p.vy = ny - p.y;
      p.x = nx; p.y = ny;

      // movement trail
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > CONFIG.player.trailMax) p.trail.shift();

      if (p.happy > 0) p.happy -= dt;
      if (p.hurt > 0) p.hurt -= dt;
    }

    updateHearts(dt) {
      const p = this.player;
      for (let i = this.hearts.length - 1; i >= 0; i--) {
        const hh = this.hearts[i];
        hh.age += dt;
        hh.x += hh.vx * dt;
        hh.y += hh.vy * dt;
        hh.wobblePhase += hh.wobbleSpeed * dt;
        hh.bobPhase += dt * 3;

        // weave perpendicular to the direction of travel
        const len = Math.hypot(hh.vx, hh.vy) || 1;
        const px = -hh.vy / len, py = hh.vx / len;
        const off = Math.sin(hh.wobblePhase) * hh.wobbleAmp;
        hh.rx = hh.x + px * off;
        hh.ry = hh.y + py * off;

        // collision with the mochi
        if (dist(p.x, p.y, hh.rx, hh.ry) < p.r + hh.r) {
          if (hh.type === "good") this.onCatch(hh);
          else this.onBroken(hh);
          this.hearts.splice(i, 1);
          continue;
        }

        // cull once it has fully left the stage
        const m = hh.size + 80;
        if (hh.age > 0.5 && (hh.rx < -m || hh.rx > this.w + m || hh.ry < -m || hh.ry > this.h + m)) {
          this.hearts.splice(i, 1);
        }
      }
    }

    /* ---- collisions / scoring ----------------------------------------- */
    onCatch(hh) {
      const now = performance.now();
      this.combo = (now - this.lastCollect < CONFIG.combo.windowMs) ? Math.min(this.combo + 1, CONFIG.combo.max) : 1;
      this.lastCollect = now;

      const gained = hh.value * this.combo;
      const prev = this.score;
      this.score += gained;

      this.player.happy = 0.32;
      this.audio.collect(this.combo);
      this.fx.sparkle(hh.rx, hh.ry, PALETTE.rose, 12);
      this.fx.ring(hh.rx, hh.ry, PALETTE.blush);
      this.addFloater(hh.rx, hh.ry, "+" + gained, PALETTE.rose);

      this.renderHud(true);
      if (this.combo >= 2) this.showCombo(this.combo);

      // milestone crossing(s)
      if (Math.floor(this.score / CONFIG.milestoneEvery) > Math.floor(prev / CONFIG.milestoneEvery)) {
        this.showToast(choice(PRAISE));
        this.audio.milestone();
        this.fx.confetti(hh.rx, hh.ry, 30);
        this.fx.hearts(this.player.x, this.player.y, 10);
      }
    }

    onBroken(hh) {
      this.lives -= 1;
      this.combo = 0;
      this.player.hurt = 0.5;
      this.shake = 1;
      this.audio.hurt();
      this.fx.sparkle(hh.rx, hh.ry, "#a2868f", 10);
      this.addFloater(hh.rx, hh.ry, "ow!", "#a2868f");
      retrigger($("hurt-flash"), "show");
      this.renderHud();

      if (this.lives <= 0) this.gameOver();
    }

    addFloater(x, y, text, color) {
      this.floaters.push({ x, y, text, color, vy: -52, life: 1 });
    }

    /* ---- rendering ----------------------------------------------------- */
    render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.save();
      if (this.shake > 0) {
        const m = 8 * this.shake;
        ctx.translate(rand(-m, m), rand(-m, m));
      }
      this.drawHearts(ctx);
      this.drawPlayer(ctx);
      this.drawFloaters(ctx);
      ctx.restore();
    }

    drawHearts(ctx) {
      for (const hh of this.hearts) {
        const bob = 1 + Math.sin(hh.bobPhase) * 0.07;            // gentle bounce
        const rot = hh.baseRot + Math.sin(hh.wobblePhase) * 0.16; // soft wobble
        ctx.save();
        ctx.translate(hh.rx, hh.ry);
        ctx.rotate(rot);
        ctx.scale(bob, 1 / bob * 1.0 + (bob - 1)); // squash & stretch

        // soft shadow
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = PALETTE.rose;
        traceHeart(ctx, 2, 4, hh.size);
        ctx.fill();
        ctx.restore();

        if (hh.type === "good") this.drawGoodHeart(ctx, hh.size);
        else this.drawBrokenHeart(ctx, hh.size);

        ctx.restore();
      }
    }

    drawGoodHeart(ctx, size) {
      // warm, glossy pink heart
      const g = ctx.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
      g.addColorStop(0, "#ffe1ea");
      g.addColorStop(0.5, PALETTE.blush);
      g.addColorStop(1, PALETTE.deep);
      traceHeart(ctx, 0, 0, size);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.strokeStyle = PALETTE.rose;
      ctx.stroke();
      // glossy highlight
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(-size * 0.16, -size * 0.08, size * 0.12, size * 0.18, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawBrokenHeart(ctx, size) {
      // desaturated, cracked heart — clearly "avoid me"
      traceHeart(ctx, 0, 0, size);
      ctx.fillStyle = "#d4c4cb";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, size * 0.05);
      ctx.strokeStyle = "#a2868f";
      ctx.stroke();
      // jagged crack down the middle
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.18);
      ctx.lineTo(-size * 0.1, size * 0.02);
      ctx.lineTo(size * 0.08, size * 0.16);
      ctx.lineTo(-size * 0.04, size * 0.42);
      ctx.lineWidth = Math.max(2, size * 0.07);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = PALETTE.cream;
      ctx.stroke();
      ctx.lineWidth = Math.max(1, size * 0.03);
      ctx.strokeStyle = "#8c6f78";
      ctx.stroke();
      ctx.restore();
    }

    drawPlayer(ctx) {
      const p = this.player;
      const r = p.r;

      // trail of fading sparkly dots
      for (let i = 0; i < p.trail.length; i++) {
        const t = p.trail[i];
        const a = (i / p.trail.length) * 0.28;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = PALETTE.blush;
        ctx.beginPath();
        ctx.arc(t.x, t.y, r * 0.4 * (i / p.trail.length), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const speed = Math.hypot(p.vx, p.vy);
      const stretch = clamp(speed * 0.02, 0, 0.22);
      const ang = Math.atan2(p.vy, p.vx);
      const idle = Math.sin(this.elapsed * 2.4) * 0.04;

      ctx.save();
      ctx.translate(p.x, p.y);

      // ground shadow
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = PALETTE.rose;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.95, r * 0.85, r * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // soft glow
      ctx.save();
      ctx.globalAlpha = 0.5;
      const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 1.6);
      glow.addColorStop(0, "rgba(248,200,220,0.5)");
      glow.addColorStop(1, "rgba(248,200,220,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // squash & stretch toward the direction of travel
      ctx.rotate(ang);
      ctx.scale(1 + stretch, 1 - stretch + idle);
      ctx.rotate(-ang);

      // body
      const body = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r * 1.1);
      body.addColorStop(0, "#ffffff");
      body.addColorStop(1, PALETTE.pastel);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.08);
      ctx.strokeStyle = "#f2b9c8";
      ctx.stroke();

      // rosy cheeks
      ctx.fillStyle = "rgba(248,150,170,0.55)";
      ctx.beginPath(); ctx.arc(-r * 0.45, r * 0.18, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.45, r * 0.18, r * 0.16, 0, Math.PI * 2); ctx.fill();

      // face changes with mood
      ctx.fillStyle = "#6b4a52";
      ctx.strokeStyle = "#6b4a52";
      ctx.lineWidth = Math.max(2, r * 0.09);
      ctx.lineCap = "round";
      const ex = r * 0.32, ey = -r * 0.08;

      if (p.hurt > 0) {
        // x_x eyes
        this.drawX(ctx, -ex, ey, r * 0.13);
        this.drawX(ctx, ex, ey, r * 0.13);
        ctx.beginPath(); ctx.arc(0, r * 0.3, r * 0.1, 0, Math.PI * 2); ctx.stroke(); // little o mouth
      } else if (p.happy > 0) {
        // ^_^ happy eyes
        this.drawArc(ctx, -ex, ey, r * 0.14, true);
        this.drawArc(ctx, ex, ey, r * 0.14, true);
        this.drawArc(ctx, 0, r * 0.22, r * 0.2, false); // big smile
      } else {
        // calm round eyes + soft smile
        ctx.beginPath(); ctx.arc(-ex, ey, r * 0.1, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex, ey, r * 0.1, 0, Math.PI * 2); ctx.fill();
        this.drawArc(ctx, 0, r * 0.2, r * 0.16, false);
        // tiny eye sparkles
        ctx.fillStyle = "#ffffff";
        ctx.beginPath(); ctx.arc(-ex + r * 0.04, ey - r * 0.04, r * 0.03, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(ex + r * 0.04, ey - r * 0.04, r * 0.03, 0, Math.PI * 2); ctx.fill();
      }

      ctx.restore();
    }

    drawX(ctx, x, y, s) {
      ctx.beginPath();
      ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
      ctx.stroke();
    }
    /** up=true draws an upward arc (happy eye); up=false a downward smile. */
    drawArc(ctx, x, y, s, up) {
      ctx.beginPath();
      if (up) ctx.arc(x, y + s * 0.4, s, Math.PI * 1.15, Math.PI * 1.85);
      else ctx.arc(x, y, s, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    drawFloaters(ctx) {
      for (const f of this.floaters) {
        ctx.save();
        ctx.globalAlpha = clamp(f.life, 0, 1);
        ctx.font = "700 " + Math.round(26 * this.scale) + "px " + HAND_FONT;
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
        ctx.restore();
      }
    }

    /* ---- HUD ----------------------------------------------------------- */
    renderHud(pop) {
      const scoreEl = $("score");
      scoreEl.textContent = this.score;
      if (pop) retrigger(scoreEl, "pop");

      const livesEl = $("lives");
      livesEl.innerHTML = "";
      for (let i = 0; i < CONFIG.startLives; i++) {
        const s = document.createElement("span");
        s.className = "life" + (i >= this.lives ? " lost" : "");
        s.textContent = "♥";
        livesEl.appendChild(s);
      }
    }

    showCombo(combo) {
      const el = $("combo");
      el.textContent = "combo ×" + combo;
      retrigger(el, "show");
    }

    showToast(text) {
      const el = $("toast");
      el.textContent = text;
      retrigger(el, "show");
    }

    /* ---- audio / mute -------------------------------------------------- */
    toggleMute() {
      this.audio.setMuted(!this.audio.muted);
      Store.set(CONFIG.storage.muted, this.audio.muted ? "1" : "0");
      this.applyMuteUi();
    }
    applyMuteUi() {
      const btn = $("btn-mute");
      btn.classList.toggle("is-muted", this.audio.muted);
      btn.setAttribute("aria-pressed", String(this.audio.muted));
    }

    /* ---- keyboard + easter eggs --------------------------------------- */
    onKey(e) {
      const k = e.key;

      // konami code → a happy rain of hearts
      if (k === KONAMI[this.konamiIdx] || k.toLowerCase() === KONAMI[this.konamiIdx]) {
        this.konamiIdx++;
        if (this.konamiIdx === KONAMI.length) { this.konamiIdx = 0; this.heartRain(); }
      } else {
        this.konamiIdx = (k === KONAMI[0]) ? 1 : 0;
      }

      const key = k.toLowerCase();
      if (key === "p") { this.togglePause(); }
      else if (key === "m") { this.audio.ensure(); this.toggleMute(); }
      else if (key === "r") { if (this.state !== "menu") this.start(); }
      else if (k === " " || k === "Enter") {
        e.preventDefault();
        if (this.state === "menu" || this.state === "over") this.start();
        else if (this.state === "paused") this.resume();
      }
      // stop arrow keys from nudging the page
      if (k.startsWith("Arrow")) e.preventDefault();
    }

    heartRain() {
      this.showToast("✦ secret hearts ✦");
      this.audio.milestone();
      this.fx.hearts(this.w / 2, this.h / 2, 28);
      this.fx.confetti(this.w / 2, this.h / 2, 30);
      if (this.state === "playing") {
        for (let i = 0; i < 6; i++) setTimeout(() => this.spawnHeart("good"), i * 90);
      }
    }

    brandEgg() {
      this.audio.click();
      this.brandClicks++;
      retrigger($("brand"), "spin");
      const rect = $("brand").getBoundingClientRect();
      this.fx.hearts(rect.left + rect.width / 2, rect.top + rect.height / 2, 6);
      if (this.brandClicks % 5 === 0) {
        this.showToast("made with love ♥");
        this.fx.confetti(rect.left + rect.width / 2, rect.top + rect.height, 24);
      }
    }

    /* ---- main loop ----------------------------------------------------- */
    loop(now) {
      if (this.state !== "playing") return;
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.update(dt);
      this.render();
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /* ======================================================================
     5. bootstrap
     ====================================================================== */
  window.addEventListener("DOMContentLoaded", () => {
    // Ambient drifters + the burst layer live in particles.js.
    new HF.AmbientBackground("bg-canvas");
    const fx = new HF.BurstLayer("fx-canvas");

    const game = new Game(fx);
    game.init();

    // Handy handle for tinkering from the dev console (tweak CONFIG, peek at
    // state, etc.). Purely optional — the game never relies on it.
    window.heartful = game;

    // Reveal the page once the cozy loader has had its moment.
    const loader = $("loader");
    const showGame = () => {
      document.body.classList.add("ready");
      loader.classList.add("is-hidden");
      loader.setAttribute("aria-hidden", "true");
    };
    setTimeout(showGame, reduceMotion ? 250 : 1500);
  });
})();
