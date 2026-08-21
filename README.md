# William Dong — personal site

A static personal site (no build step) with a flagship, in-browser **CV Punch Trainer**
that grades boxing form in real time. Vanilla HTML/CSS/ES-modules; deploys to Vercel by
serving the folder as-is.

## Structure

```
portfolio/
  index.html            Landing page (hero, projects, about, contact)
  styles.css            Design tokens + landing styles (shared)
  main.js               Landing interactions (nav, reveal-on-scroll)
  games/
    punch-trainer.html  The CV Punch Trainer page
    punch-trainer.js    Real-time control + HUD
    trainer.css         Trainer HUD styles
    engine/             Vendored analyzer (from the Kodawari project)
      pose.js           MediaPipe BlazePose wrapper (CDN, GPU)
      biomech.js        de Leva CoM, base of support, per-frame features
      detect.js         Punch detection + jab/cross/hook/uppercut classifier
      scoring.js        Five-dimension technique scoring + coaching notes
      live.js           Streaming layer: batch analyzer → real-time trainer
      config.js vec.js filters.js dtw.js overlay.js synth.js
  vercel.json           cleanUrls + camera permissions-policy
```

The trainer's analysis engine is vendored from **Kodawari**
(`../kodawari/src`) — the same `pose → features → detection → scoring` pipeline —
with a thin `engine/live.js` streaming wrapper added on top. To pull upstream fixes,
re-copy the engine files from `kodawari/src` (all except `app.js`, `charts.js`, `backend.js`,
`pipeline.js`).

## Run locally

Any static server works (ES modules need http, not `file://`):

```bash
python -m http.server 4176
# then open http://localhost:4176/
```

The Claude Code launch config **`portfolio`** (port 4176) does the same. `localhost` is a
secure context, so the webcam works from the dev server. The pose model loads from a CDN on
first use; the **demo** button runs the whole pipeline offline with a synthetic boxer.

## Deploy to Vercel

No framework — it's static. Easiest paths:

- **Git:** push this folder to a repo and import it in Vercel (Framework preset: *Other*,
  no build command, output = the folder root).
- **CLI:** from this folder, `vercel` (first run) then `vercel --prod`.

`vercel.json` sets `cleanUrls` (so `/games/punch-trainer` works) and a
`Permissions-Policy: camera=(self)` header for the webcam.

## TODO (needs your input)

- Real bio + focus text in **About** (currently placeholder).
- Real experience & education entries in the timeline (from your LinkedIn/résumé).
- Your **GitHub** URL in the contact section.
- Real project links (repos or live demos) on the project cards.
