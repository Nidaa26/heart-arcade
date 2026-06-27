# Heartful! 💗

> A cozy little arcade game about catching floating hearts and gently dodging
> the broken ones. Warm, soft, handcrafted — built with Flask + vanilla
> HTML/CSS/JavaScript, and **fully offline**.

Move your soft little mochi friend (it doubles as your cursor!) around a
paper-textured stage, scoop up the glowing hearts, chain catches into combos,
and steer clear of the cracked ones. Everything is hand-drawn on `<canvas>`,
every sound is synthesised in the browser, and there is not a single external
service, API, font download, or asset server in sight.

---

## ✨ Features✨ ✨ 

- **Catch & dodge gameplay** — collect ❤, avoid 💔, with three lives.
- **Combo system** — chain quick catches for bigger point pops.
- **Gradual difficulty** — hearts spawn faster, move quicker, and broken hearts
  grow more common as the levels climb.
- **Score & high score** — your best is saved with `localStorage`.
- **Pause / restart / mute** — friendly scrapbook control buttons.
- **Animated loading screen, game-over screen & smooth restart.**
- **Handcrafted look** — paper textures, stitched borders, washi tape, drifting
  background hearts, twinkling sparkles, parallax, confetti bursts and a custom
  mochi cursor — all pure CSS/canvas.
- **Synthesised sound** — collect / hurt / game-over / click / milestone tones
  made with the Web Audio API. No audio files, no autoplay, with a mute toggle.
- **Responsive** — plays well on desktop, laptop, tablet and phone (mouse,
  trackpad, pen or touch).
- **Considerate** — respects `prefers-reduced-motion` and auto-pauses when the
  tab loses focus.
- **A few hidden surprises** — keep an eye out. 👀

---

## 🚀 Running it

You only need Python and Flask.

```bash
pip install flask
python app.py
