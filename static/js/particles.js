
(function () {
  "use strict";

  /* ---- shared palette (kept in sync with the CSS variables) ------------- */
  const PALETTE = {
    pastel: "#FADADD",
    blush:  "#F8C8DC",
    rose:   "#C85A6A",
    white:  "#FFFFFF",
    cream:  "#FFF9F8",
    deep:   "#d56a7a",
  };
  const CONFETTI_COLORS = [PALETTE.blush, PALETTE.rose, PALETTE.pastel, PALETTE.deep, "#ffd9e3"];

  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- small math helpers ---------------------------------------------- */
  const rand = (min, max) => min + Math.random() * (max - min);
  const TAU = Math.PI * 2;

  /**
   * Trace a heart path centred on (x, y) with the given pixel `size`
   * (roughly its height). The caller decides whether to fill or stroke,
   * so this single routine powers ambient hearts, burst hearts and the
   * gameplay collectibles alike.
   */
  function traceHeart(ctx, x, y, size) {
    const s = size;
    const top = y - s * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, top + s * 0.28);
    ctx.bezierCurveTo(x, top, x - s * 0.5, top, x - s * 0.5, top + s * 0.28);
    ctx.bezierCurveTo(x - s * 0.5, top + s * 0.58, x - s * 0.2, top + s * 0.72, x, top + s);
    ctx.bezierCurveTo(x + s * 0.2, top + s * 0.72, x + s * 0.5, top + s * 0.58, x + s * 0.5, top + s * 0.28);
    ctx.bezierCurveTo(x + s * 0.5, top, x, top, x, top + s * 0.28);
    ctx.closePath();
  }

  /** Draw a soft four-point sparkle/star centred on (x, y). */
  function drawSparkle(ctx, x, y, size, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    // four tapered points using quadratic curves toward the centre
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      const ox = Math.cos(a) * size;
      const oy = Math.sin(a) * size;
      const cx = Math.cos(a + Math.PI / 4) * size * 0.18;
      const cy = Math.sin(a + Math.PI / 4) * size * 0.18;
      if (i === 0) ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo(cx, cy, ox, oy);
      const na = ((i + 1) / 4) * TAU;
      ctx.quadraticCurveTo(cx, cy, Math.cos(na) * size, Math.sin(na) * size);
    }
    ctx.fill();
    ctx.restore();
  }

  /**
   * Size a canvas for crisp rendering on high-DPI screens and return its 2D
   * context. The context is scaled so all drawing can use CSS pixels.
   */
  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /* ======================================================================
     AmbientBackground — drifting hearts + sparkles with pointer parallax
     ====================================================================== */
  class AmbientBackground {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.hearts = [];
      this.sparkles = [];
      this.parallax = { x: 0, y: 0 };      // smoothed pointer influence
      this.target = { x: 0, y: 0 };
      this.last = performance.now();

      this.resize();
      this.populate();

      window.addEventListener("resize", () => this.resize());
      if (!reduceMotion) {
        window.addEventListener("pointermove", (e) => {
          // -1 .. 1 across the viewport
          this.target.x = (e.clientX / this.w - 0.5) * 2;
          this.target.y = (e.clientY / this.h - 0.5) * 2;
        }, { passive: true });
      }

      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    resize() {
      const fit = fitCanvas(this.canvas);
      this.ctx = fit.ctx;
      this.w = fit.w;
      this.h = fit.h;
    }

    populate() {
      const area = this.w * this.h;
      // Scale counts with screen size, but keep things calm on small/reduced setups.
      const heartCount = reduceMotion ? 6 : Math.round(Math.min(30, area / 26000));
      const sparkCount = reduceMotion ? 4 : Math.round(Math.min(46, area / 16000));

      this.hearts = [];
      for (let i = 0; i < heartCount; i++) this.hearts.push(this.makeHeart(true));
      this.sparkles = [];
      for (let i = 0; i < sparkCount; i++) this.sparkles.push(this.makeSparkle());
    }

    makeHeart(scatter) {
      const depth = rand(0.3, 1);                 // farther = smaller, fainter, slower
      return {
        x: rand(0, this.w),
        y: scatter ? rand(0, this.h) : this.h + 30,
        size: rand(8, 22) * depth,
        depth,
        speed: rand(8, 22) * depth,               // upward drift (px/s)
        sway: rand(10, 26),
        swaySpeed: rand(0.4, 1.1),
        phase: rand(0, TAU),
        rot: rand(-0.3, 0.3),
        alpha: rand(0.12, 0.4) * depth + 0.08,
      };
    }

    makeSparkle() {
      return {
        x: rand(0, this.w),
        y: rand(0, this.h),
        depth: rand(0.4, 1),
        size: rand(1.5, 4),
        phase: rand(0, TAU),
        twinkle: rand(1.2, 3),
        baseAlpha: rand(0.3, 0.8),
      };
    }

    loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const t = now / 1000;

      // ease parallax toward the pointer target
      this.parallax.x += (this.target.x - this.parallax.x) * 0.05;
      this.parallax.y += (this.target.y - this.parallax.y) * 0.05;

      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      // ---- hearts ----
      for (const hheart of this.hearts) {
        hheart.y -= hheart.speed * dt;
        hheart.phase += hheart.swaySpeed * dt;
        if (hheart.y < -40) Object.assign(hheart, this.makeHeart(false), { y: this.h + 30 });

        const px = this.parallax.x * 26 * hheart.depth;
        const py = this.parallax.y * 18 * hheart.depth;
        const x = hheart.x + Math.sin(hheart.phase) * hheart.sway + px;
        const y = hheart.y + py;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(hheart.rot + Math.sin(hheart.phase) * 0.08);
        ctx.globalAlpha = hheart.alpha;
        traceHeart(ctx, 0, 0, hheart.size);
        ctx.fillStyle = PALETTE.blush;
        ctx.fill();
        ctx.restore();
      }

      // ---- sparkles ----
      for (const s of this.sparkles) {
        const a = s.baseAlpha * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * s.twinkle + s.phase)));
        const px = this.parallax.x * 34 * s.depth;
        const py = this.parallax.y * 24 * s.depth;
        drawSparkle(ctx, s.x + px, s.y + py, s.size * (0.7 + 0.3 * Math.sin(t * s.twinkle)), PALETTE.white, a);
      }

      requestAnimationFrame(this.loop);
    }
  }

  /* ======================================================================
     BurstLayer — short-lived particles fired by gameplay events
     ====================================================================== */
  class BurstLayer {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.particles = [];
      this.last = performance.now();
      this.resize();
      window.addEventListener("resize", () => this.resize());
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    resize() {
      const fit = fitCanvas(this.canvas);
      this.ctx = fit.ctx;
      this.w = fit.w;
      this.h = fit.h;
    }

    /* ---- public effects ------------------------------------------------ */

    /** A gentle puff of sparkles — used when catching a heart. */
    sparkle(x, y, color = PALETTE.white, count = 12) {
      const n = reduceMotion ? Math.ceil(count / 2) : count;
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        const sp = rand(40, 200);
        this.particles.push({
          kind: "sparkle",
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 30,
          size: rand(2, 5),
          life: 1, decay: rand(1.4, 2.4),
          color,
          spin: rand(-6, 6), rot: rand(0, TAU),
        });
      }
    }

    /** An expanding ring — a soft "ping" at the catch point. */
    ring(x, y, color = PALETTE.blush) {
      this.particles.push({
        kind: "ring", x, y, r: 6, vr: rand(180, 240),
        life: 1, decay: 2.2, color, width: 4,
      });
    }

    /** Confetti rain from a point — milestones & new high scores. */
    confetti(x, y, count = 36) {
      const n = reduceMotion ? Math.ceil(count / 3) : count;
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI * 0.85, -Math.PI * 0.15);
        const sp = rand(160, 420);
        this.particles.push({
          kind: "confetti",
          x: x + rand(-20, 20), y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          w: rand(6, 11), h: rand(8, 14),
          life: 1, decay: rand(0.5, 0.9),
          color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
          rot: rand(0, TAU), spin: rand(-10, 10),
          gravity: rand(420, 620),
        });
      }
    }

    /** A pop of little hearts — used for celebrations / easter eggs. */
    hearts(x, y, count = 14, color = PALETTE.rose) {
      const n = reduceMotion ? Math.ceil(count / 2) : count;
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        const sp = rand(60, 260);
        this.particles.push({
          kind: "heart",
          x, y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - rand(40, 120),
          size: rand(10, 20),
          life: 1, decay: rand(0.6, 1.1),
          color, rot: rand(-0.4, 0.4), spin: rand(-3, 3),
          gravity: rand(160, 320),
        });
      }
    }

    /* ---- loop ---------------------------------------------------------- */
    loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= p.decay * dt;
        if (p.life <= 0) { this.particles.splice(i, 1); continue; }

        if (p.kind === "ring") {
          p.r += p.vr * dt;
          ctx.save();
          ctx.globalAlpha = Math.max(0, p.life) * 0.6;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.width * p.life;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, TAU);
          ctx.stroke();
          ctx.restore();
          continue;
        }

        // physics for the rest
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.gravity) p.vy += p.gravity * dt;
        if (p.spin) p.rot += p.spin * dt;

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));

        if (p.kind === "sparkle") {
          drawSparkle(ctx, p.x, p.y, p.size, p.color, ctx.globalAlpha);
        } else if (p.kind === "confetti") {
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        } else if (p.kind === "heart") {
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          traceHeart(ctx, 0, 0, p.size);
          ctx.fillStyle = p.color;
          ctx.fill();
        }
        ctx.restore();
      }

      requestAnimationFrame(this.loop);
    }
  }

  /* ---- expose the toolkit ---------------------------------------------- */
  window.HF = {
    PALETTE,
    reduceMotion,
    rand,
    traceHeart,
    drawSparkle,
    fitCanvas,
    AmbientBackground,
    BurstLayer,
  };
})();
