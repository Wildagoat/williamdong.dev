// main.js — small landing-page interactions: footer year, reveal-on-scroll,
// and the project detail modal. No framework, no build step.

// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// Reveal-on-scroll for anything tagged .reveal.
const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add('in'));
}

// ---- Project detail modal ----
// Text keeps normal casing here; the landing lowercases it via CSS (body.home).
// `img` points at a file in ./assets/ — if it's missing, the media panel is
// hidden gracefully (no broken-image icon), so cards work before the files exist.
const PROJECTS = {
  trainer: {
    status: 'Live demo', live: true, title: 'CV Punch Trainer',
    problem: 'Power, speed, and accuracy come from consistent punching form, but inspecting every rep is time-consuming.',
    solution: 'Build an app that does it automatically.',
    desc: 'A real-time, in-browser boxing-form coach. Your webcam feeds a pose model that reads 33 body landmarks per frame. My own biomechanics engine detects each punch and scores balance, guard, kinetic-chain sequencing, and retraction, with plain-language coaching notes. Everything runs locally, so the video never leaves your device. No webcam? A synthetic demo streams a boxer through the same pipeline.',
    tags: ['MediaPipe', 'Realtime CV', 'Biomechanics', 'Canvas'],
    link: './games/punch-trainer.html', linkLabel: 'Open the trainer →',
  },
  scorpion: {
    status: 'Defense · lead ME', title: 'SCORPION',
    problem: 'Drones can\'t carry heavy payloads for long periods of time.',
    solution: 'Create an attritable ground vehicle.',
    desc: 'An expendable payload vehicle built at Raptor Defense Company, where I was the lead and sole mechanical engineer. I owned the full mechanical design from concept to working prototype, modeled the complete assembly in Onshape in 6 days, then built and assembled it in 3. It came in over 50 mph (a conservative estimate), on under half the R&D budget, and passed the preliminary test matrix.',
    tags: ['Onshape', 'UGV', 'Defense hardware', 'Rapid prototyping'],
    model: './assets/models/full-v2-rear.glb',
    modelOrientation: '0deg -90deg 0deg', // Onshape Z-up → viewer Y-up (sits on its wheels)
    modelOrbit: '30deg 72deg 105%',
    img: './assets/scorpion.webp',
  },
  ftad: {
    status: 'Vehicle design', title: 'FTAD Chassis',
    problem: 'Commercial RC cars aren\'t designed for modular aero components or custom optimization.',
    solution: 'Build one myself.',
    desc: 'The reference race-car chassis for Formula Theory & Automotive Design, my F1-inspired engineering competition. A full independent-suspension platform (double-wishbone corners, coilover dampers, shaft drive) modeled in Onshape and Fusion 360, then refined with CFD and topology optimization.',
    tags: ['Onshape', 'Fusion 360', 'CFD', 'Topology opt.'],
    imgs: ['./assets/car1.webp', './assets/car2.webp'],
  },
  vex: {
    status: 'World-qualified', title: 'VEX Robotics',
    problem: 'The Push Back game rewards tall bots with confident collision capabilities.',
    solution: 'Build for a low center of gravity, durable design, and speed.',
    desc: 'Design lead and CAD specialist on a VEX Robotics Competition team that qualified for the VEX World Championship. I owned the mechanical design (drivetrain, structure, and scoring mechanisms), iterating the full robot in CAD before every build.',
    tags: ['VEX', 'CAD', 'Drivetrain', 'Mechanism design'],
    img: './assets/vex.webp',
  },
  'fight-diagram': {
    status: 'Tool', title: 'Fight Diagram',
    problem: 'Teaching spatial concepts is hard. Younger fighters can\'t process descriptions as fast as speech.',
    solution: 'Build a simple program that models positioning.',
    desc: 'A single-file SVG diagrammer for boxing positioning and footwork. I built it to explain ring positioning (angles, stances, distance, and exchanges) to the younger fighters I coach. Now I also use it to make content: I record sequences and export clean vector diagrams and videos to break down technique for a wider audience.',
    tags: ['SVG', 'Single-file', 'Vanilla JS'],
    img: './assets/fightdiagram.png',
  },
  cycloidal: {
    status: 'FeatureScript · parametric', title: 'Cycloidal Drive FS',
    problem: 'A cycloidal disk is the heart of a cycloidal reducer, but its lobed profile is a true epicycloid — painful to draw by hand, and standard sketches don\'t rebuild cleanly when the drive ratio or eccentricity changes.',
    solution: 'Author an Onshape FeatureScript that derives the whole disk straight from the drivetrain geometry.',
    desc: 'A custom Onshape feature that generates a complete cycloidal reducer disk from first principles. The user sets the real drive parameters — base circle diameter, rolling-circle diameter (which fixes the lobe count and reduction ratio), pin eccentricity, load-pin diameter and pitch, center bore, and thickness — and the script sweeps the epicycloid path, offsets it for the pin radius, then cuts the eccentric center bore and the load-pin holes in one parametric, fully-associative feature. It encodes the cycloidal-drive math directly: lobe count is the base/rolling ratio, the eccentricity sets the contact offset, and the load holes are placed on their pitch circle so the whole disk regenerates correctly at any ratio. Writing it meant treating the reducer geometry as equations rather than sketches — a distillation of both my CAD workflow and my understanding of how cycloidal drivetrains actually transmit torque.',
    tags: ['FeatureScript', 'Onshape', 'Cycloidal drive', 'Parametric CAD', 'Mechanical design'],
    img: './assets/cycloidalfs.webp',
    link: './assets/cycloidal-drive.fs', linkLabel: 'View the FeatureScript →',
  },
};

const modal = document.getElementById('projModal');
if (modal) {
  const pmStatus = document.getElementById('pmStatus');
  const pmTitle = document.getElementById('pmTitle');
  const pmPs = document.getElementById('pmPs');
  const pmDesc = document.getElementById('pmDesc');
  const pmTags = document.getElementById('pmTags');
  const pmActions = document.getElementById('pmActions');
  const pmImg = document.getElementById('pmImg');
  const pmModel = document.getElementById('pmModel');
  const pmThumbs = document.getElementById('pmThumbs');
  const closeBtn = modal.querySelector('.modal-x');
  let lastFocus = null;

  // Load the (heavy) model-viewer library + Meshopt decoder ON DEMAND — only when a
  // project with a 3D model is opened. Keeps the homepage free of WebGL entirely.
  let mvReady = null;
  const ensureModelViewer = () => {
    if (mvReady) return mvReady;
    mvReady = import('./assets/vendor/model-viewer.min.js').then(() => {
      const MV = customElements.get('model-viewer');
      if (MV) MV.meshoptDecoderLocation = new URL('./assets/vendor/meshopt_decoder.js', document.baseURI).href;
    });
    return mvReady;
  };

  const openModal = (id, trigger) => {
    const p = PROJECTS[id];
    if (!p) return;
    lastFocus = trigger || document.activeElement;

    pmStatus.textContent = p.status || '';
    pmStatus.classList.toggle('live', !!p.live);
    pmTitle.textContent = p.title || '';

    // Problem / solution lead-in (rendered above the detailed write-up).
    pmPs.innerHTML = '';
    const psRow = (k, v) => {
      const row = document.createElement('p');
      row.className = 'ps-line' + (k === 'Solution' ? ' sol' : '');
      const s = document.createElement('span');
      s.className = 'ps-k';
      s.textContent = k;
      row.appendChild(s);
      row.appendChild(document.createTextNode(v));
      return row;
    };
    if (p.problem) pmPs.appendChild(psRow('Problem', p.problem));
    if (p.solution) pmPs.appendChild(psRow('Solution', p.solution));

    pmDesc.textContent = p.desc || '';

    pmTags.innerHTML = '';
    (p.tags || []).forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      pmTags.appendChild(s);
    });

    pmActions.innerHTML = '';
    if (p.link) {
      const a = document.createElement('a');
      a.className = 'btn btn-primary';
      a.href = p.link;
      a.textContent = p.linkLabel || 'Open';
      pmActions.appendChild(a);
    }

    // Media: a switchable panel that can hold an interactive 3D model and/or render(s).
    // `model` (glb path) becomes the first, default media item; `imgs`/`img` add still renders.
    // The panel hides entirely if there's nothing to show (no broken-image icon).
    const imgs = p.imgs || (p.img ? [p.img] : []);
    const items = [];
    // `modelOrientation` (roll pitch yaw) reorients CAD exported in a Z-up tool to the
    // viewer's Y-up; `modelOrbit` sets the pleasing default framing (theta phi radius).
    if (p.model) items.push({ type: 'model', src: p.model, label: '3D',
      orientation: p.modelOrientation, orbit: p.modelOrbit });
    imgs.forEach((src) => items.push({ type: 'image', src }));

    pmThumbs.innerHTML = '';
    if (!items.length) {
      modal.classList.add('no-media');
      pmModel.hidden = true;
      pmModel.removeAttribute('src');
      pmImg.hidden = true;
      pmImg.classList.remove('is-loaded');
      pmImg.removeAttribute('src');
      delete pmImg.dataset.src;
    } else {
      modal.classList.remove('no-media');
      // If a render fails to load AND it's our only media, hide the panel gracefully.
      pmImg.onerror = () => { if (items.length === 1) modal.classList.add('no-media'); };
      // Reveal a render only once IT has decoded, so switching projects never
      // flashes the previously-loaded image (see the guarded swap in showItem).
      pmImg.onload = () => pmImg.classList.add('is-loaded');

      const showItem = (item) => {
        const isModel = item.type === 'model';
        pmModel.hidden = !isModel;
        pmImg.hidden = isModel;
        if (isModel) {
          // Import model-viewer on first use, and set the decoder location BEFORE src
          // so the compressed .glb decodes correctly.
          ensureModelViewer().then(() => {
            if (item.orientation) pmModel.setAttribute('orientation', item.orientation);
            else pmModel.removeAttribute('orientation');
            if (item.orbit) pmModel.setAttribute('camera-orbit', item.orbit);
            else pmModel.removeAttribute('camera-orbit');
            if (pmModel.getAttribute('src') !== item.src) pmModel.setAttribute('src', item.src);
          });
        } else {
          pmImg.alt = p.title + ' render';
          // Swap the render only when it actually changes, and drop the old
          // image first so the panel can't paint the previous project's photo
          // while the new file downloads. `is-loaded` fades it back in onload.
          if (pmImg.dataset.src !== item.src) {
            pmImg.dataset.src = item.src;
            pmImg.classList.remove('is-loaded');
            pmImg.removeAttribute('src');
            pmImg.src = item.src;
          }
        }
        [...pmThumbs.children].forEach((b) => b.classList.toggle('active', b.dataset.src === item.src));
      };

      // Thumbnails only when there's a choice to make.
      if (items.length > 1) {
        items.forEach((item) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.src = item.src;
          if (item.type === 'model') {
            b.className = 'thumb-3d';
            b.setAttribute('aria-label', 'View interactive 3D model');
            b.textContent = item.label;
          } else {
            b.setAttribute('aria-label', 'View render');
            const im = document.createElement('img');
            im.src = item.src;
            im.alt = '';
            b.appendChild(im);
          }
          b.addEventListener('click', () => showItem(item));
          pmThumbs.appendChild(b);
        });
      }
      showItem(items[0]);
    }

    modal.hidden = false;
    document.body.classList.add('modal-open');
    closeBtn.focus();
  };

  const closeModal = () => {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  };

  document.querySelectorAll('.proj[data-project]').forEach((card) => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(card.getAttribute('data-project'), card);
    });
  });

  modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
}

// ---- Timeline: click a node to pin its blurb open (single-select; ringed while pinned) ----
(() => {
  const items = [...document.querySelectorAll('.tl-item')];
  if (!items.length) return;
  const track = document.querySelector('.tl-track');
  items.forEach((item) => {
    item.tabIndex = 0;
    const toggle = () => {
      const wasPinned = item.classList.contains('tl-pinned');
      items.forEach((i) => i.classList.remove('tl-pinned'));
      if (!wasPinned) item.classList.add('tl-pinned');
      // while one caption is pinned, hover-peek is disabled so only one ever shows
      if (track) track.classList.toggle('has-pinned', !wasPinned);
    };
    item.addEventListener('click', (e) => {
      // On desktop, clicking inside an already-open blurb (to read/select text) shouldn't close it.
      // On touch there's no hover-peek and the note fills the tap area, so let a tap close it.
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!coarse && item.classList.contains('tl-pinned') && e.target.closest('.tl-note')) return;
      toggle();
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
})();

// ---- Ambient CAD backdrop: the spinning SCORPION is a pre-rendered video (no WebGL) ----
// Only thing left to do in JS: hold it still for visitors who prefer reduced motion.
(() => {
  const vid = document.querySelector('.cad-video');
  if (!vid) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    vid.removeAttribute('autoplay');
    vid.addEventListener('loadeddata', () => { try { vid.pause(); vid.currentTime = 0; } catch (e) {} }, { once: true });
    try { vid.pause(); } catch (e) {}
  }
})();
