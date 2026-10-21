/* ══════════════════════════════════════════════════════
   PHOTO BOOTH
   The whole app. Four sections:
     haptic()          feedback on taps
     initPhotoBooth()  the camera, the strip, frames, export
     initPWA()         service worker + iOS install hint
   ══════════════════════════════════════════════════════ */

/* ══ HAPTICS ═════════════════════════════════════════
   A short tap of feedback on the actions that matter. iOS gets
   the real Taptic Engine through Capacitor's Haptics plugin when
   it is installed; Android falls back to navigator.vibrate; a
   desktop browser has neither and silently does nothing.       */
function haptic(style) {
  try {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (H) {
      if (style === 'success') H.notification({ type: 'SUCCESS' });
      else H.impact({ style: style === 'heavy' ? 'HEAVY' : style === 'light' ? 'LIGHT' : 'MEDIUM' });
      return;
    }
    if (navigator.vibrate) {
      navigator.vibrate(style === 'success' ? [12, 40, 18] : style === 'heavy' ? 22 : 10);
    }
  } catch (err) { /* feedback is a nicety — never let it break a tap */ }
}

/* ══ PHOTO BOOTH ═════════════════════════════════════
   The app. Wrapped in one function so its variables stay
   private, and it bails out if #stage isn't on the page.  */
function initPhotoBooth() {
  if (!document.getElementById('stage')) return;   // not the booth page
  /* ── elements ───────────────────────────────────────── */
  const video     = document.getElementById('video');
  const stage     = document.getElementById('stage');
  const stageMsgText = document.getElementById('stageMsgText');
  const countdown = document.getElementById('countdown');
  const flash     = document.getElementById('flash');
  const shotPip   = document.getElementById('shotPip');
  const startBtn  = document.getElementById('startBtn');
  const uploadBtn = document.getElementById('uploadBtn');
  const fileInput = document.getElementById('fileInput');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn  = document.getElementById('clearBtn');
  const toastEl   = document.getElementById('toast');
  let   slots     = [];            // filled by buildStrip(), see LAYOUTS

  /* ── SCREENS ─────────────────────────────────────────
     Two screens, one visible at a time. Shoot is where the
     camera lives; Edit is the strip, filters and stickers.
     goTo() only moves classes around — the CSS does the slide. */
  const screenShoot = document.getElementById('screenShoot');
  const screenEdit  = document.getElementById('screenEdit');
  const backBtn     = document.getElementById('backBtn');
  const toEditBtn   = document.getElementById('toEditBtn');
  let   screen      = 'shoot';

  function goTo(name) {
    if (name === screen) return;
    screen = name;
    const fwd  = name === 'edit';
    const from = fwd ? screenShoot : screenEdit;
    const to   = fwd ? screenEdit  : screenShoot;

    from.className = 'screen ' + (fwd ? 'is-behind' : 'screen-next');
    from.setAttribute('aria-hidden', 'true');
    to.className = 'screen is-current';
    to.removeAttribute('aria-hidden');
    haptic('light');
    setButtons();
    if (fwd) { requestAnimationFrame(fitStrip); scheduleRender(); }
  }

  /* One light tap for any button on this screen, wired once here
     rather than repeated in every handler below. */
  document.querySelectorAll('.bth, .chip, .sticker-tray button').forEach(function (el) {
    el.addEventListener('pointerdown', function () { haptic('light'); });
  });
  const stripEl   = document.getElementById('strip');

  /* ── STATE ───────────────────────────────────────────
     Everything the page needs to know, in four variables. Any time one
     of these changes we call render() to redraw the strip from it. This
     is the "single source of truth" idea — the screen is always a
     picture of these variables, so the two can never drift apart.

     shots  : the 4 slots. null = empty. Photos are stored UNFILTERED as
              base64 data URLs, and the filter is applied when drawing.
              That's why switching filters instantly restyles photos you
              already took — the originals were never modified.
     stream : the live MediaStream from the webcam, or null if the camera
              hasn't been opened. Also used as the "is the camera on?"
              flag that decides what the main button does.
     busy   : true while a countdown sequence is running. Every button
              checks this so you can't start a second capture mid-shot.
     filter : which filter is currently selected.
     OUT    : every captured photo is normalised to 720x720, so webcam
              shots and uploaded photos are always the same size.        */
  const OUT = 720;                 // captured square size in px

  /* ── LAYOUTS ─────────────────────────────────────────
     Two strip shapes. 'n' is how many photos, 'cols' is how they're
     arranged — one column gives the classic tall booth strip, two
     columns give the 3x2 sheet. Everything downstream reads these
     two numbers rather than assuming four photos in a line, so
     adding a third layout means adding one line here plus one
     button in index.html.                                        */
  const LAYOUTS = {
    three: { n: 3, cols: 1, label: '3 photos' },
    six:   { n: 6, cols: 2, label: '6 photos' }
  };
  let layout = 'three';
  const N = function () { return LAYOUTS[layout].n; };

  /* ── FRAMES ──────────────────────────────────────────
     A frame is the paper the photos are printed on: the
     background colour, the colour of the footer text, and
     optionally a piece of artwork laid over the top.

       bg      flat strip background colour
       ink     footer text colour
       doodle  keep the hand-drawn wobbly border
       back    artwork UNDER the photos — paper texture, a
               patterned background, anything that should sit
               behind. frames/<id>-back-three.png / -six.png
       art     artwork OVER the photos — corner characters,
               borders, a title. frames/<id>-three.png / -six.png

     Which layer you want matters: 'art' is painted on top, so a
     solid fill there hides every photo. Anything meant to be a
     background is either 'bg' (one flat colour) or 'back'.

     TO ADD YOUR OWN: design against frames/_template-three.svg
     and _template-six.svg (they carry the exact pixel geometry
     and show where the photos sit), export both as transparent
     PNGs named <id>-three.png / <id>-six.png, then add one line
     here and one button in index.html. Nothing else changes —
     the preview and the saved PNG both read this object.      */
  /* These are the built-in defaults. frames/frames.json overrides
     them at startup, so adding a frame means editing that one file
     and dropping PNGs in frames/ — no code change. If the JSON is
     missing or malformed the app falls back to this list rather
     than starting with no frames at all.                         */
  const FRAMES = {
    classic:  { label: 'Classic',   bg: '#FFFFFF', ink: '#4A4A4A', doodle: true },
    charcoal: { label: 'Charcoal',  bg: '#2B2B2B', ink: '#EFEAE2' },
    blush:    { label: 'Blush',     bg: '#E8CFC8', ink: '#4A4A4A' },
    sky:      { label: 'Sky',       bg: '#C8D8E8', ink: '#4A4A4A' },
    bear:     { label: 'Bear',      bg: '#F5F0E8', ink: '#4A4A4A', art: true },
    dots:     { label: 'Dots',      bg: '#F5F0E8', ink: '#4A4A4A', back: true },
    frog:     { label: 'Frogs',     bg: '#DEE697', ink: '#4A3B32', art: true }
  };
  let frameId = 'classic';
  try { frameId = localStorage.getItem('booth.frame') || 'classic'; } catch (err) {}
  if (!FRAMES[frameId]) frameId = 'classic';

  let shots  = new Array(LAYOUTS[layout].n).fill(null);   // raw (unfiltered) data URLs
  let stream = null;
  let busy   = false;
  let filter = 'none';

  /* Filters are plain CSS filter strings. Storing them in one object
     means the same value can be reused in three places: the live video
     preview, the <img> tags in the strip, and the download canvas
     (canvas has a ctx.filter property that accepts identical syntax).
     Add a new look by adding one line here plus one chip button.        */
  const FILTERS = {
    none:  'none',
    bw:    'grayscale(1) contrast(1.08)',
    warm:  'saturate(1.25) sepia(.28) contrast(1.03)',
    cool:  'saturate(1.1) hue-rotate(180deg) brightness(1.04)',
    pop:   'saturate(1.7) contrast(1.22)',
    dream: 'saturate(1.15) brightness(1.12) contrast(.92) blur(.4px)'
  };

  /* toast(): the little black pill that slides up at the bottom.
     clearTimeout on each call cancels the previous hide-timer, so rapid
     messages don't fight each other — the newest one always gets its
     full display time.                                                  */
  const toast = (msg, ms = 2600) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
  };

  /* sleep(): wraps setTimeout in a Promise so we can write
     'await sleep(1000)' inside an async function. This is what lets the
     countdown read like a straight list of steps instead of a nest of
     callbacks — see countTo() below.                                    */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ── OPENING THE CAMERA ──────────────────────────────
     getUserMedia() asks the browser for camera access and returns a
     Promise. It's async because the user has to click Allow first — the
     await pauses here until they respond.

     Two things commonly make this fail, so both are handled explicitly:
       NotAllowedError — the user (or a previous 'Block') denied it
       NotFoundError   — no camera hardware
     There's also the file:// case: browsers only expose cameras on
     "secure contexts" (https or localhost), so double-clicking the HTML
     file will always fail. The check on location.protocol catches that
     and explains it rather than showing a confusing generic error.

     Whatever happens we return true/false so the caller knows whether
     it's safe to continue into a capture sequence.                      */
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      stageMsgText.innerHTML = 'This browser can\'t reach the camera.<br>Try uploading photos instead.';
      toast('Camera unavailable — use Upload photos.', 5000);
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      stage.classList.remove('idle');
      stage.classList.add('live');
      setButtons();
      toast('Camera ready — press Take ' + N() + ' photos.');
      return true;
    } catch (err) {
      /* iOS has a long history of blocking the camera in home-screen
         apps, and it forgets the permission between launches. If we're
         running standalone on an iPhone, that's by far the most likely
         cause — so say so, and give the workaround that actually
         works: open the same page in Safari instead.                 */
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                         navigator.standalone === true;

      let msg = 'Could not open the camera.';
      if (isIOS && standalone) {
        msg = 'iPhones sometimes block the camera in home screen apps. Open this page in Safari instead.';
      }
      else if (err.name === 'NotAllowedError')      msg = 'Camera permission was blocked. Allow it in your browser settings.';
      else if (err.name === 'NotFoundError')        msg = 'No camera found on this device.';
      else if (location.protocol === 'file:')       msg = 'Cameras need a local server, not a file:// page.';

      stageMsgText.innerHTML = msg + '<br>You can still upload photos.';
      toast(msg, 6000);
      return false;
    }
  }

  /* ── CAPTURING ONE SQUARE FRAME ──────────────────────
     This is the heart of the booth. A <video> element can be handed
     straight to canvas drawImage(), which grabs whatever frame is on
     screen at that instant.

     The 9-argument form of drawImage is what does the cropping:
       drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
                         └── region to take FROM ──┘ └── where to put IT ┘

     A webcam gives 1280x720 (landscape), so we take the biggest centred
     square — 720x720 starting 280px from the left — and paint it into a
     720x720 canvas. Nothing is squashed, the sides are simply trimmed.

     The translate + scale(-1, 1) pair mirrors the drawing horizontally.
     It's needed because the CSS mirrors the preview; without it your
     photo would come out the opposite way round from what you posed
     for, and any text in shot would read backwards.

     toDataURL() then serialises the canvas into a base64 PNG string we
     can drop straight into an <img src>.                                */
  function grabSquare() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const size = Math.min(vw, vh);              // biggest centred square
    const sx = (vw - size) / 2, sy = (vh - size) / 2;

    const c = document.createElement('canvas');
    c.width = c.height = OUT;
    const ctx = c.getContext('2d');
    ctx.translate(OUT, 0);
    ctx.scale(-1, 1);                            // match the mirrored preview
    ctx.drawImage(video, sx, sy, size, size, 0, 0, OUT, OUT);
    return c.toDataURL('image/png');
  }

  /* countTo(): shows 3, 2, 1 with a one-second gap.
     Rewriting innerHTML each tick replaces the <span>, and because a
     brand-new element is created the CSS 'pop' animation restarts from
     the beginning every number. Reusing the same span would only animate
     once.                                                               */
  async function countTo(n) {
    countdown.classList.add('show');
    for (let i = n; i > 0; i--) {
      countdown.innerHTML = '<span>' + i + '</span>';
      await sleep(1000);
    }
    countdown.classList.remove('show');
    countdown.innerHTML = '';
  }

  /* captureInto(): the full ritual for ONE photo —
     label it, count down, flash, grab the frame, breathe.
     Written as a separate function because two different flows need it:
     the automatic 4-shot run, and a single retake. Note the capture
     happens on the same line the flash starts, so the photo is taken at
     the peak of the white flash, exactly like a real camera.            */
  /* 'step' and 'ofN' are only for the on-screen counter. They're
     separate from 'index' because the shots being taken may not be
     slots 1-4 any more — if two slots are already filled by uploads,
     this is "Shot 1 of 2" while writing into slot 3.               */
  async function captureInto(index, step, ofN) {
    shotPip.textContent = 'Shot ' + (step || index + 1) + ' of ' + (ofN || N());
    shotPip.classList.add('show');
    await countTo(3);

    /* Light FIRST, then shoot. The screen going white acts as a fill
       light on your face, but the browser needs a moment to actually
       paint it and the webcam needs a moment to adjust its exposure to
       the extra brightness. Capturing on the same line as the flash
       would grab the frame before any of that happened — you'd get the
       animation but none of the lighting benefit.

       260ms lands inside the 315ms the flash holds at full white.     */
    flash.classList.add('fire');
    await sleep(260);
    const data = grabSquare();

    setTimeout(function () { flash.classList.remove('fire'); }, 800);
    if (data) { shots[index] = data; render(); }
    await sleep(700);
  }

  /* runSequence(): the automatic 4-shot run.
     Because captureInto() is awaited, this loop pauses ~3.7 seconds each
     time round — a plain for-loop without await would fire all four
     captures in the same millisecond and give four identical photos.
     'busy' is raised before the loop and lowered after, which is what
     locks the buttons for the whole ~15-second run.                     */
  /* Fill only the EMPTY slots. The old version always ran 0,1,2,3, so
     if you'd uploaded a photo first it got overwritten by shot one.
     Now uploads and camera shots share the strip properly, and if
     every slot is full it starts fresh rather than doing nothing.   */
  async function runSequence() {
    let targets = [];
    for (let i = 0; i < N(); i++) if (!shots[i]) targets.push(i);
    if (!targets.length) {                      // strip full — start over
      shots = new Array(N()).fill(null);
      render();
      targets = shots.map(function (_, i) { return i; });
    }

    busy = true; setButtons();
    for (let n = 0; n < targets.length; n++) {
      await captureInto(targets[n], n + 1, targets.length);
    }
    shotPip.classList.remove('show');
    busy = false; setButtons();
    haptic('success');
    goTo('edit');
    toast('Strip complete — add stickers, then save.');
  }

  /* Retake is pressed on the Edit screen but needs the viewfinder,
     so it borrows the Shoot screen and hands it back afterwards. */
  async function retake(i) {
    if (busy) return;
    const came = screen;
    goTo('shoot');
    if (!stream) {
      const ok = await startCamera();
      if (!ok) { goTo(came); return; }
    }
    busy = true; setButtons();
    await captureInto(i, 1, 1);
    shotPip.classList.remove('show');
    busy = false; setButtons();
    goTo(came);
  }

  /* The main button does two different jobs depending on state, which is
     why it's one button and not two. First press = open the camera (and
     stop there, so you can check your framing). Second press = run the
     sequence. setButtons() relabels it to match.                        */
  startBtn.addEventListener('click', async function () {
    if (busy) return;
    if (!stream) { await startCamera(); return; }   // first press opens the camera
    runSequence();                                   // second press starts the 4 shots
  });

  /* ── UPLOADS ─────────────────────────────────────────
     The real <input type="file"> is hidden because browsers barely let
     you style it. Clicking our pretty button programmatically clicks the
     hidden input instead — a standard trick.                            */
  /* null = "fill the empty slots in order". A number means a specific
     slot asked for a photo, set by the Upload button inside that slot. */
  let uploadTarget = null;

  uploadBtn.addEventListener('click', function () {
    uploadTarget = null;
    fileInput.click();
  });

  fileInput.addEventListener('change', async function (e) {
    const files = [].slice.call(e.target.files).filter(f => f.type.indexOf('image/') === 0);
    if (!files.length) { uploadTarget = null; return; }

    let placed = 0;
    for (const f of files) {
      /* a slot asked by name? use it, then fall back to filling gaps
         for any further files in the same selection */
      let idx;
      if (uploadTarget !== null) { idx = uploadTarget; uploadTarget = null; }
      else                       { idx = shots.indexOf(null); }

      if (idx === -1) { toast('Strip is full — clear it or retake a shot.'); break; }
      try { shots[idx] = await fileToSquare(f); placed++; render(); }
      catch (err) { toast('One image could not be read.'); }
    }
    uploadTarget = null;
    if (placed) toast('Added ' + placed + ' photo' + (placed > 1 ? 's' : '') + '.');
    /* Resetting .value matters: without it, picking the SAME file twice
       in a row fires no 'change' event, because the value didn't change. */
    fileInput.value = '';
  });

  /* fileToSquare(): put an uploaded photo through the identical
     centre-crop as a webcam shot, so mixed sources look consistent in
     the strip. Image loading is asynchronous, hence the Promise wrapper
     — the pixels don't exist until img.onload fires.
     createObjectURL makes a temporary local reference to the file;
     revokeObjectURL releases it afterwards so memory isn't leaked. The
     file never leaves the computer.                                     */
  function fileToSquare(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const size = Math.min(img.width, img.height);      // centre-crop to square
        const sx = (img.width - size) / 2, sy = (img.height - size) / 2;
        const c = document.createElement('canvas');
        c.width = c.height = OUT;
        c.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, OUT, OUT);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /* ── filters ────────────────────────────────────────── */
  /* [data-filter] matters: the layout picker uses .chip too, and an
     unscoped selector would set filter to undefined when you tapped
     "6 photos".                                                     */
  document.querySelectorAll('.chip[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      filter = chip.dataset.filter;
      document.querySelectorAll('.chip[data-filter]').forEach(function (c) {
        c.setAttribute('aria-pressed', c === chip);
      });
      video.style.filter = FILTERS[filter];
      render();
    });
  });

  /* ── RENDERING THE STRIP ─────────────────────────────
     One function redraws all four slots from the 'shots' array. Nothing
     else in the code touches the strip's HTML directly — take a photo,
     upload one, change filter, clear, retake, they all just update the
     data and call render(). That keeps the display honest and means new
     features only need to change the array.

     The filter is injected as an inline style here rather than baked
     into the stored image, which is why filters are non-destructive.    */
  function render() {
    slots.forEach(function (slot, i) {
      const data = shots[i];
      if (!data) {
        /* empty slots get their own upload button, so a photo can go
           into slot 3 without filling 1 and 2 first */
        slot.innerHTML = '<span class="slot-num">' + (i + 1) + '</span>' +
                         '<button class="slot-upload" data-up="' + i + '">Upload</button>';
        return;
      }
      slot.innerHTML =
        '<img src="' + data + '" alt="Photo ' + (i + 1) + '" style="filter:' + FILTERS[filter] + '">' +
        '<button class="retake" data-i="' + i + '">Retake</button>';
    });
    setButtons();
    scheduleRender();          // keep the saved PNG in step with the screen
  }

  /* ══ STICKERS ════════════════════════════════════════
     Add your own art by dropping transparent PNGs into the stickers/
     folder and listing the filenames here. JavaScript can't read a
     folder's contents, so this list is how it knows what exists — if a
     file is missing its swatch quietly removes itself from the tray.

     Positions are stored as FRACTIONS of the strip (0 to 1), never
     pixels. That's the whole trick: the strip is ~300px wide on screen
     but 668px on the download canvas, and fractions map onto both
     without any conversion maths.                                     */
  const STICKER_DIR   = '';
  const STICKER_FILES = ['Bearlogo3.png','stickers/TEST2_S1.png', 'stickers/TEST2.png', 'stickers/TEST2_S2.png', 'stickers/TEST2_S3.png', 'stickers/TEST3_F.png',];/*---------Sticker eddition edit line Uploads here-----------------*/
  /* Sticker width as a fraction of the strip's width.
     One photo is 600px of the strip's 668px, so 0.90 makes a sticker
     exactly one photo wide. Reference points:
       0.22  a quarter of a photo      0.67  three-quarters
       0.45  half a photo              0.90  exactly one photo
     Export art at roughly 2x the drawn size to stay crisp —
     at 0.90 that's a 1200 x 1200px PNG.                              */
  const STICKER_W     = 0.90;
  let placed = [];                     // [{ src, x, y }] — x/y are 0-1

  /* Push STICKER_W into CSS so the on-screen size is driven by the same
     number as the download. Change STICKER_W alone and both follow.   */
  /* STICKER_W is expressed against ONE photo, so on the two-column
     sheet the same sticker has to be half as wide a share of the
     strip. buildStrip() calls this again on every layout change.   */
  function applyStickerWidth() {
    const cols = LAYOUTS[layout].cols;
    stripEl.style.setProperty('--sticker-w', (STICKER_W * 100 / cols) + '%');
  }
  applyStickerWidth();

  const tray              = document.getElementById('stickerTray');
  const clearStickersBtn  = document.getElementById('clearStickersBtn');
  const stickerUploadBtn  = document.getElementById('stickerUploadBtn');
  const stickerUpload     = document.getElementById('stickerUpload');

  /* addSwatch(): builds one tappable thumbnail in the tray.
     Used for both sources — the presets above and anything you upload —
     so uploaded art behaves identically to art in the folder.

     'missingRemoves' is only true for presets: if the file isn't in the
     stickers/ folder the swatch deletes itself rather than showing a
     broken image. Uploads can't fail that way.                        */
  function addSwatch(src, label, missingRemoves) {
    const b  = document.createElement('button');
    const im = document.createElement('img');
    b.type  = 'button';
    b.title = 'Add ' + label;
    im.src  = src;
    im.alt  = label;
    if (missingRemoves) im.onerror = function () { b.remove(); };
    b.appendChild(im);
    b.addEventListener('click', function () { addSticker(src); });
    tray.appendChild(b);
    return b;
  }

  /* preset stickers from the stickers/ folder.
     Empty STICKER_FILES above if you only want your own uploads.      */
  STICKER_FILES.forEach(function (file) {
    addSwatch(STICKER_DIR + file, file.replace('.png', ''), true);
  });

  /* ── UPLOADING YOUR OWN STICKERS ─────────────────────
     Each file is read into an <img>, redrawn onto a canvas at no more
     than 512px on its longest side, and stored as a PNG data URL.

     Three reasons for the canvas round-trip rather than using the file
     directly: it caps the memory a huge photo would eat, PNG output
     preserves transparency (a JPEG would fill it with black), and a
     data URL is same-origin so it can never taint the download canvas
     the way a linked file can.                                        */
  stickerUploadBtn.addEventListener('click', function () { stickerUpload.click(); });

  stickerUpload.addEventListener('change', async function (e) {
    const files = [].slice.call(e.target.files).filter(function (f) {
      return f.type.indexOf('image/') === 0;
    });
    if (!files.length) return;

    let added = 0;
    for (const f of files) {
      try {
        const src = await fileToSticker(f);
        addSwatch(src, f.name.replace(/\.[^.]+$/, ''), false);
        added++;
      } catch (err) {
        toast('Could not read ' + f.name + '.');
      }
    }
    if (added) {
      toast('Added ' + added + ' sticker' + (added > 1 ? 's' : '') + ' to the tray — tap to place.');
    }
    stickerUpload.value = '';        // lets you re-pick the same file later
  });

  function fileToSticker(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        /* Uploads keep their full resolution — no downscaling.
           To cap them again, set MAX to a pixel size and multiply
           w/h by Math.min(1, MAX / Math.max(img.width, img.height)). */
        const w = img.width;
        const h = img.height;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));   // PNG keeps transparency
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /* Drop a new sticker near the middle, jittered slightly so tapping
     the same one twice doesn't hide one perfectly behind the other.   */
  function addSticker(src) {
    placed.push({
      src: src,
      x: 0.5 + (Math.random() - 0.5) * 0.25,
      y: 0.5 + (Math.random() - 0.5) * 0.5
    });
    renderStickers();
    toast('Sticker added — drag it where you want.');
  }

  /* Stickers are direct children of .strip, while photos live inside
     .slot elements. render() only rewrites the slots, so stickers are
     never disturbed by taking or filtering photos.                    */
  function renderStickers() {
    [].slice.call(stripEl.querySelectorAll('.placed')).forEach(function (n) { n.remove(); });
    placed.forEach(function (s, i) {
      const img = document.createElement('img');
      img.className = 'placed';
      img.src = s.src;
      img.alt = '';
      img.dataset.i = i;
      img.style.left = (s.x * 100) + '%';
      img.style.top  = (s.y * 100) + '%';
      stripEl.appendChild(img);
    });
    /* the Remove button only exists while there's something to remove */
    clearStickersBtn.hidden = placed.length === 0;
    scheduleRender();
  }

  clearStickersBtn.addEventListener('click', function () {
    if (!placed.length) return;
    const n = placed.length;
    placed = [];
    renderStickers();
    toast('Removed ' + n + ' sticker' + (n > 1 ? 's' : '') + '.');
  });

  /* DRAGGING — pointer events cover mouse, touch and stylus in one API.
     setPointerCapture routes every move to this element even if the
     cursor outruns it, which is what stops the sticker being dropped
     the moment you move quickly.

     getBoundingClientRect() gives the strip's live position and size on
     screen; subtracting it converts a page coordinate into a fraction
     of the strip. Clamping to 0-1 keeps stickers from being lost off
     the edge.                                                          */
  let drag = null;

  stripEl.addEventListener('pointerdown', function (e) {
    const el = e.target.closest('.placed');
    if (!el) return;
    e.preventDefault();
    drag = { el: el, i: +el.dataset.i };
    el.setPointerCapture(e.pointerId);
    el.classList.add('grabbing');
  });

  stripEl.addEventListener('pointermove', function (e) {
    if (!drag) return;
    const r = stripEl.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top)  / r.height));
    placed[drag.i].x = x;
    placed[drag.i].y = y;
    drag.el.style.left = (x * 100) + '%';
    drag.el.style.top  = (y * 100) + '%';
  });

  function endDrag() {
    if (!drag) return;
    drag.el.classList.remove('grabbing');
    drag = null;
  }
  stripEl.addEventListener('pointerup', endDrag);
  stripEl.addEventListener('pointercancel', endDrag);

  /* EVENT DELEGATION
     The Retake buttons are destroyed and recreated on every render, so
     listeners attached directly to them would die instantly. Instead one
     listener sits on the parent strip, which never changes, and
     .closest() works out whether the click landed on a Retake button.
     One listener, works forever, no rebinding.                          */
  stripEl.addEventListener('click', function (e) {
    const btn = e.target.closest('.retake');
    if (btn) { retake(+btn.dataset.i); return; }

    /* per-slot upload: remember which slot asked, then open the picker */
    const up = e.target.closest('.slot-upload');
    if (up && !busy) {
      uploadTarget = +up.dataset.up;
      fileInput.click();
    }
  });

  /* setButtons(): the only place button enabled/disabled state and the
     main button's label are decided. Called after anything that changes
     state, so the controls can never contradict what's actually going
     on — e.g. you can't hit Download mid-countdown.                     */
  function setButtons() {
    const any = shots.some(Boolean);
    if (toEditBtn) toEditBtn.hidden = !any || screen === 'edit';
    downloadBtn.disabled = !any || busy;
    clearBtn.disabled    = !any || busy;
    startBtn.disabled    = busy;
    uploadBtn.disabled   = busy;
    startBtn.textContent = busy ? 'Smile…' : (stream ? 'Take ' + N() + ' photos' : 'Start camera');
  }

  clearBtn.addEventListener('click', function () {
    if (busy) return;
    shots = new Array(N()).fill(null);
    placed = [];              // stickers go too
    render();
    renderStickers();
    toast('Strip cleared.');
  });

  /* ── DOWNLOAD: FLATTEN THE STRIP INTO ONE PNG ────────
     The on-screen strip is HTML, which can't be saved as an image
     directly. So we rebuild it on a canvas and export that.

     The four constants drive all the geometry, so changing PHOTO or GAP
     rescales the whole layout without any other edits:
       PHOTO 600 — each square photo
       PAD    34 — white border around the strip
       GAP    20 — space between photos
       FOOT   96 — footer band for the logo and date
     That gives 668 x 2590px:
       width  = 600 + 34x2
       height = 34 + (600 x 4) + (20 x 3) + 96

     ctx.filter takes the same string as CSS filter, so the downloaded
     image gets the identical look you see on screen. save()/restore()
     wraps it so the filter doesn't bleed onto the footer text.

     Empty slots are drawn as grey blocks rather than skipped, keeping
     the strip a consistent size even if you only took two photos.

     Export works by pointing a temporary <a download> at the canvas's
     data URL and clicking it in code — no server involved, the file is
     generated entirely in the browser.                                  */
  /* ══ SAVING ══════════════════════════════════════════
     Rebuilt around one hard constraint: **iOS only lets a page open
     the share sheet while it still has "transient activation" from
     your tap**, and that expires after a few hundred milliseconds.
     The old code rendered a 1080x3233 canvas, loaded the frame art
     and encoded a PNG *before* calling navigator.share — by then the
     activation was long gone, iOS threw NotAllowedError, and the
     fallback (<a download>) is something iOS Safari mostly ignores
     for blob URLs. So the button appeared to do nothing.

     The fix is to do the slow work ahead of time. The strip is
     re-rendered in the background whenever it changes, so by the time
     you press Save the PNG already exists and the share sheet opens
     immediately, inside your tap.                                   */

  let pngBlob   = null;    // the finished PNG, ready to hand over
  let pngStamp  = '';      // what the strip looked like when we made it
  let rendering = false;

  /* A cheap description of everything that affects the image. If this
     hasn't changed, the cached PNG is still correct.                */
  function stripStamp() {
    return [layout, frameId, filter,
            shots.map(function (x) { return x ? x.length : 0; }).join(','),
            placed.map(function (p) {
              return p.src.length + ':' + p.x.toFixed(3) + ':' + p.y.toFixed(3);
            }).join('|')].join('~');
  }

  /* ── DRAWING THE STRIP ONTO A CANVAS ─────────────────
     Returns a PNG blob. Everything is measured off the live page, so
     the export is a scaled-up copy of exactly what's on screen.    */
  async function renderStripBlob() {
    /* ── GEOMETRY MEASURED FROM THE LIVE PAGE ────────────
       The download used to be laid out with its own constants — PAD 34,
       GAP 20 and so on. Those were hand-picked to look like the CSS
       (padding 18, gap 12) but weren't proportionally identical, so the
       photos came out 89.8% of the strip's width instead of 88.0%. Tiny,
       but enough to make stickers look smaller than in the preview.

       Now nothing is hard-coded. We measure the real strip and every
       slot with getBoundingClientRect(), then multiply by one SCALE
       factor. The download is a scaled-up copy of exactly what you're
       looking at — and it stays that way even if you edit the CSS.    */
    const rect = stripEl.getBoundingClientRect();
    if (!rect.width) throw new Error('the strip is not visible');

    const TARGET_W = 1080;                     // output width in pixels
    const SCALE = TARGET_W / rect.width;
    const W = Math.round(rect.width  * SCALE);
    const H = Math.round(rect.height * SCALE);

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    /* positions are measured relative to the strip's top-left corner */
    const rel = function (el) {
      const r = el.getBoundingClientRect();
      return {
        x: (r.left - rect.left) * SCALE,
        y: (r.top  - rect.top)  * SCALE,
        w: r.width  * SCALE,
        h: r.height * SCALE
      };
    };
    /* The hand-drawn look uses an eight-value border-radius, where each
       corner is a different lopsided ellipse. Canvas can't draw that,
       and getComputedStyle returns something like "255px 15px" — which
       parseFloat reads as 255, ballooning the exported corners into
       pill shapes. So the value is capped at a small fraction of the
       box, giving gently rounded corners in the saved image.        */
    const radiusOf = function (el, w, h) {
      const raw = parseFloat(getComputedStyle(el).borderTopLeftRadius) * SCALE || 0;
      return Math.min(raw, Math.min(w, h) * 0.06);
    };

    /* strip background, with the same rounded corners as on screen */
    const stripCss = getComputedStyle(stripEl);
    ctx.fillStyle = stripCss.backgroundColor || '#FFFFFF';
    roundRect(ctx, 0, 0, W, H, radiusOf(stripEl, W, H));
    ctx.fill();

    /* background artwork, under everything but the flat colour */
    if (FRAMES[frameId] && FRAMES[frameId].back) {
      try {
        const bk = await loadImage(layerSrc(frameId, 'back'));
        ctx.drawImage(bk, 0, 0, W, H);
      } catch (err) { /* missing file must not cost you the strip */ }
    }

    /* photos, drawn wherever their slots actually sit */
    for (let i = 0; i < slots.length; i++) {
      const p = rel(slots[i]);
      ctx.save();
      roundRect(ctx, p.x, p.y, p.w, p.h, radiusOf(slots[i], p.w, p.h));
      ctx.clip();
      if (shots[i]) {
        const img = await loadImage(shots[i]);
        ctx.filter = FILTERS[filter];
        ctx.drawImage(img, p.x, p.y, p.w, p.h);
      } else {
        ctx.fillStyle = '#F0EDE7';
        ctx.fillRect(p.x, p.y, p.w, p.h);
      }
      ctx.restore();
    }

    /* frame artwork, over the photos and under the footer — the same
       order the browser paints it in, so the export matches. The PNGs
       are authored at exactly the strip's export size, so this is a
       straight 1:1 draw.                                            */
    if (FRAMES[frameId] && FRAMES[frameId].art) {
      try {
        const art = await loadImage(layerSrc(frameId, 'art'));
        ctx.drawImage(art, 0, 0, W, H);
      } catch (err) {
        /* a missing frame file must not cost you the whole strip */
      }
    }

    /* footer — same text, font, colour and position as the preview */
    const footEl = document.getElementById('stripFoot');
    if (footEl && footEl.textContent.trim()) {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const f  = rel(footEl);
      const fc = getComputedStyle(footEl);
      ctx.fillStyle    = fc.color;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = fc.fontStyle + ' ' + fc.fontWeight + ' ' +
                 (parseFloat(fc.fontSize) * SCALE) + 'px ' + fc.fontFamily;
      ctx.fillText(footEl.textContent.trim(), W / 2, f.y + f.h / 2);
    }

    /* stickers last, so they sit on top exactly as they do on screen.
       Measuring the placed elements rather than recomputing from the
       fractions means position, size and aspect ratio all match by
       construction — there's no second calculation to get wrong.      */
    const stickerEls = stripEl.querySelectorAll('.placed');
    for (const el of stickerEls) {
      const p   = rel(el);
      const img = await loadImage(el.src);
      ctx.save();
      ctx.filter = 'drop-shadow(0 ' + (2 * SCALE).toFixed(1) + 'px ' +
                   (5 * SCALE).toFixed(1) + 'px rgba(0,0,0,.25))';
      ctx.drawImage(img, p.x, p.y, p.w, p.h);
      ctx.restore();
    }

    const blob = await new Promise(function (res) { c.toBlob(res, 'image/png'); });
    if (!blob) throw new Error('the image could not be created');
    return blob;
  }

  /* Re-render in the background. Debounced, because changing a filter
     or dragging a sticker fires this repeatedly.                    */
  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      if (busy || !shots.some(Boolean) || screen !== 'edit') return;
      const stamp = stripStamp();
      if (rendering || (pngBlob && pngStamp === stamp)) return;
      rendering = true;
      renderStripBlob().then(function (blob) {
        pngBlob = blob; pngStamp = stamp;
      }).catch(function () {
        pngBlob = null;            // fall back to rendering on demand
      }).then(function () {
        rendering = false;
        setButtons();
      });
    }, 260);
  }

  /* ── HANDING THE FILE OVER ───────────────────────────
     Four routes, best first. Each one is tried only where it actually
     works, and every failure explains itself instead of going quiet. */

  /* 1. NATIVE — straight into the photo album, no share sheet.
        Needs two Capacitor plugins; if they aren't installed we fall
        through to the share sheet, which still works inside the app.
          Pin the versions — this project is on Capacitor 7 and the
          latest plugin releases need 8:
            npm install @capacitor/filesystem@7 @capacitor-community/media@8
            npx cap sync                                              */
  async function saveNative(blob, name) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (!P || !P.Filesystem || !P.Media) return false;

    const base64 = await new Promise(function (res, rej) {
      const r = new FileReader();
      r.onload  = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });

    /* Cache, not Documents: this copy only has to survive long enough
       for the Media plugin to copy it into the album.              */
    const w = await P.Filesystem.writeFile({
      path: name, data: base64, directory: 'CACHE'
    });
    await P.Media.savePhoto({ path: w.uri });
    try { await P.Filesystem.deleteFile({ path: name, directory: 'CACHE' }); } catch (e) {}
    return true;
  }

  /* 2. SHARE SHEET — iOS Safari, iOS home-screen apps, Android.
        "Save Image" in that sheet is what puts it in Photos. Must be
        called with the blob already in hand (see the note above).   */
  function canShareFile(file) {
    return !!(navigator.canShare && navigator.canShare({ files: [file] }));
  }

  /* 3. DOWNLOAD — desktop browsers and Android Chrome. */
  function saveDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);        // Firefox needs it in the document
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  downloadBtn.addEventListener('click', async function () {
    if (busy) return;
    const name = 'photobooth-' + Date.now() + '.png';

    try {
      /* If the background render hasn't finished, do it now. This is
         the slow path and it costs us the iOS gesture, so afterwards
         we tell the user to press Save again rather than failing
         silently — one extra tap, and the second one is instant.   */
      const stamp = stripStamp();
      if (!pngBlob || pngStamp !== stamp) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Preparing…';
        try {
          pngBlob = await renderStripBlob();
          pngStamp = stamp;
        } finally {
          downloadBtn.textContent = 'Save to photos';
          setButtons();
        }
        const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const native = window.Capacitor && window.Capacitor.isNativePlatform &&
                       window.Capacitor.isNativePlatform();
        if (iOS && !native) {
          toast('Ready — press Save to photos again.', 4000);
          return;
        }
      }

      const blob = pngBlob;
      const file = new File([blob], name, { type: 'image/png' });

      /* 1. native album */
      try {
        if (await saveNative(blob, name)) {
          haptic('success');
          toast('Saved to your photos.');
          return;
        }
      } catch (err) {
        /* plugin present but refused — most often permission denied */
        toast('Photos permission was declined. Allow it in Settings.', 5000);
        return;
      }

      /* 2. share sheet — phones and tablets only; on a desktop a
            download is what people expect from a Save button.      */
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (isTouch && canShareFile(file)) {
        try {
          await navigator.share({ files: [file], title: 'My photo strip' });
          haptic('success');
          toast('Saved.');
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;         // user cancelled
          if (err.name === 'NotAllowedError') {
            toast('Press Save to photos again — iOS needs a fresh tap.', 5000);
            return;
          }
          /* anything else falls through to the download route */
        }
      }

      /* 3. download */
      const a = document.createElement('a');
      if (typeof a.download !== 'undefined') {
        saveDownload(blob, name);
        haptic('success');
        toast(isTouch ? 'Saved to your files.' : 'Strip downloaded.');
        return;
      }

      /* 4. last resort — show it and let them press and hold */
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      toast('Press and hold the image to save it.', 5000);

    } catch (err) {
      /* "Tainted canvas" has exactly one cause here: the page is on
         file://, where every image counts as a foreign origin. Say
         that, rather than repeating the browser's jargon.          */
      if (err.name === 'SecurityError' || /[Tt]ainted/.test(err.message || '')) {
        toast('Saving needs the app to be served, not opened as a file. ' +
              'Run: npm run serve', 7000);
      } else {
        toast('Could not save — ' + (err.message || err.name) + '.', 5000);
      }
    }
  });

  /* roundRect(): traces a rounded rectangle path. Canvas has a built-in
     ctx.roundRect() now, but it's recent enough that older phones miss
     it — this works everywhere.                                       */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      const i = new Image();
      /* Only for network URLs, and never for data: — asking for CORS on
         a data URL makes some browsers refuse to load it at all. This
         keeps the canvas exportable if the app is ever served from a
         CDN or a different host than its images.                     */
      if (/^https?:/i.test(src)) i.crossOrigin = 'anonymous';
      i.onload  = function () { res(i); };
      i.onerror = function () { rej(new Error('could not load ' + src)); };
      i.src = src;
    });
  }

  /* ── TIDY UP ─────────────────────────────────────────
     Stopping every track releases the webcam and turns off the little
     green camera light. Without this the camera can stay claimed after
     you navigate away, which looks alarming and blocks other apps.
     'pagehide' is used rather than 'unload' because it also fires when
     a mobile browser backgrounds the tab.                               */
  window.addEventListener('pagehide', function () {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  });

  /* ── APPLYING A FRAME ────────────────────────────────
     Paints the strip and swaps the overlay image. The <img>
     is created once and reused, so switching frames doesn't
     churn the DOM mid-animation.                           */
  const frameArt = document.createElement('img');
  frameArt.className = 'frame-art';
  frameArt.alt = '';
  frameArt.hidden = true;

  const frameBack = document.createElement('img');
  frameBack.className = 'frame-back';
  frameBack.alt = '';
  frameBack.hidden = true;

  /* both layers use the same naming rule, so one helper does both */
  function layerSrc(id, kind) {
    return 'frames/' + id + (kind === 'back' ? '-back-' : '-') + layout + '.png';
  }
  function setLayer(el, on, id, kind) {
    if (on) {
      if (!el.parentElement) stripEl.appendChild(el);
      const src = layerSrc(id, kind);
      if (el.getAttribute('src') !== src) el.src = src;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function applyFrame(id, announce) {
    frameId = FRAMES[id] ? id : 'classic';
    const f = FRAMES[frameId];

    stripEl.style.background = f.bg;
    stripEl.classList.toggle('no-doodle', !f.doodle);
    const foot = document.getElementById('stripFoot');
    if (foot) foot.style.color = f.ink;

    setLayer(frameBack, !!f.back, frameId, 'back');
    setLayer(frameArt,  !!f.art,  frameId, 'art');

    document.querySelectorAll('.frame-opt').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.frame === frameId));
    });
    try { localStorage.setItem('booth.frame', frameId); } catch (err) {}
    scheduleRender();
    if (announce) toast(f.label + ' frame.');
  }

  /* ── THE PICKER ──────────────────────────────────────
     Built from FRAMES rather than written out in the HTML, so a
     new frame appears the moment it's added to frames.json.    */
  const frameRow = document.querySelector('.frame-row');

  function buildFrameRow() {
    if (!frameRow) return;
    frameRow.innerHTML = '';
    Object.keys(FRAMES).forEach(function (id) {
      const f = FRAMES[id];
      const btn = document.createElement('button');
      btn.className = 'frame-opt';
      btn.dataset.frame = id;
      btn.setAttribute('aria-pressed', String(id === frameId));
      btn.style.setProperty('--swatch', f.bg || '#fff');
      const sw = document.createElement('span');
      btn.appendChild(sw);
      btn.appendChild(document.createTextNode(f.label || id));
      btn.addEventListener('click', function () {
        if (busy || id === frameId) return;
        haptic('light');
        applyFrame(id, true);
      });
      frameRow.appendChild(btn);
    });
  }

  /* ── LOADING THE FRAME LIST ──────────────────────────
     frames/frames.js sets window.BOOTH_FRAMES and is loaded by a
     plain <script> tag before this file. That matters: fetch() is
     blocked outright on file://, so the old frames.json could only
     be read when the app was served, and double-clicking index.html
     silently showed the built-in frames instead of yours. A script
     tag has no such restriction, so your list now loads however the
     app is opened — served, double-clicked, or inside the native
     shell. The defaults above are only used if the file is missing
     or has a syntax error.                                        */
  function loadFrameConfig() {
    const list = window.BOOTH_FRAMES;
    if (!Array.isArray(list) || !list.length) {
      /* frames.js didn't run. Almost always a stale index.html being
         served from an old service worker cache — the file on disk
         has the <script> tag but the page in the browser doesn't. */
      console.warn('frames.js did not load, so only the built-in frames ' +
                   'are showing. The page is probably cached: hard-refresh ' +
                   '(Cmd+Shift+R), or unregister the service worker in ' +
                   'DevTools > Application > Service Workers.');
      return;
    }

    const next = {};
    list.forEach(function (f) {
      if (!f || typeof f.id !== 'string' || !f.id) return;
      next[f.id] = {
        label:  f.label || f.id,
        bg:     f.bg  || '#FFFFFF',
        ink:    f.ink || '#4A4A4A',
        doodle: !!f.doodle,
        art:    !!f.art,
        back:   !!f.back
      };
    });
    if (!Object.keys(next).length) return;

    Object.keys(FRAMES).forEach(function (k) { delete FRAMES[k]; });
    Object.keys(next).forEach(function (k) { FRAMES[k] = next[k]; });
    if (!FRAMES[frameId]) frameId = Object.keys(FRAMES)[0];
  }

  /* ── FITTING THE STRIP ───────────────────────────────
     The strip is laid out at its natural size, then scaled down
     so the tallest layout still fits without scrolling. offsetW/H
     are the UNtransformed size, so re-running this never compounds
     the previous scale.                                          */
  function fitStrip() {
    const box = stripEl.parentElement;
    if (!box) return;
    const bw = box.clientWidth, bh = box.clientHeight;
    const nw = stripEl.offsetWidth, nh = stripEl.offsetHeight;
    if (!bw || !bh || !nw || !nh) return;
    const k = Math.min(bw / nw, bh / nh, 1.35);
    stripEl.style.transform = 'translate(-50%, -50%) scale(' + k.toFixed(4) + ')';
  }
  window.addEventListener('resize', fitStrip);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStrip);

  /* ── BUILDING THE STRIP ──────────────────────────────
     The slots used to be hard-coded in index.html, which locked the
     app to one shape. They're generated here instead, so switching
     layout is just: rebuild the slots, resize the shots array,
     redraw. --cols drives the CSS grid.

     Photos already taken are kept where they'll still fit. Going
     6 -> 3 drops shots 4-6, so say so rather than losing them
     silently.                                                     */
  function buildStrip(next, announce) {
    const spec = LAYOUTS[next] || LAYOUTS.three;
    const lost = shots.slice(spec.n).filter(Boolean).length;

    layout = next in LAYOUTS ? next : 'three';
    shots  = shots.slice(0, spec.n);
    while (shots.length < spec.n) shots.push(null);

    stripEl.style.setProperty('--cols', spec.cols);
    stripEl.dataset.layout = layout;
    if (typeof applyStickerWidth === 'function') applyStickerWidth();

    /* rebuild the slots, leaving the footer and any placed stickers
       exactly where they are */
    [].slice.call(stripEl.querySelectorAll('.slot')).forEach(function (el) { el.remove(); });
    const foot = document.getElementById('stripFoot');
    for (let i = 0; i < spec.n; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.dataset.i = i;
      stripEl.insertBefore(d, foot);
    }
    slots = [].slice.call(stripEl.querySelectorAll('.slot'));

    const sub = document.querySelector('.booth-sub');
    if (sub) {
      const words = { 3: 'Three', 6: 'Six' };
      sub.textContent = (words[spec.n] || spec.n) + ' shots, three seconds each.';
    }

    document.querySelectorAll('.layout-opt').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
    });

    render();
    applyFrame(frameId, false);
    requestAnimationFrame(fitStrip);
    setTimeout(fitStrip, 220);
    if (announce) {
      toast(lost ? 'Switched to ' + spec.label + ' — ' + lost + ' photo' +
                   (lost > 1 ? 's' : '') + ' did not fit.'
                 : 'Switched to ' + spec.label + '.');
    }
  }

  if (backBtn)   backBtn.addEventListener('click', function () { if (!busy) goTo('shoot'); });
  if (toEditBtn) toEditBtn.addEventListener('click', function () { goTo('edit'); });

  document.querySelectorAll('.layout-opt').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (busy || btn.dataset.layout === layout) return;
      haptic('light');
      buildStrip(btn.dataset.layout, true);
    });
  });

  /* First paint: builds the empty slots and sets the initial
     disabled state of the buttons.                                      */
  loadFrameConfig();
  buildStrip(layout, false);
  buildFrameRow();
  applyFrame(frameId, false);
}

initPhotoBooth();




/* ══ INSTALLABLE APP ═════════════════════════════════
   Only relevant when the app is opened in a browser rather than
   the native shell. Two jobs: register the service worker that
   makes it work offline and installable, and show iOS users how
   to add it to their home screen — Android and desktop Chrome
   offer that themselves, but iOS has never had an install
   prompt, so the only way is Share ▸ Add to Home Screen and most
   people don't know that.                                      */
function initPWA() {
  /* Service workers only run over HTTPS (or localhost), so this simply
     does nothing when the page is opened straight off the disk.      */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        /* nothing to do — the app works fine without offline support */
      });
    });
  }

  /* Inside the Capacitor shell the app is already installed, so the
     "Add to Home Screen" hint would be nonsense. */
  if (window.Capacitor && window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform()) return;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* 'standalone' means the app was opened from the home screen rather
     than inside the browser. iOS uses its own navigator.standalone;
     everyone else uses the display-mode media query.                 */
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     navigator.standalone === true;

  let dismissed = false;
  try { dismissed = localStorage.getItem('helpful.installHint') === 'no'; } catch (err) {}

  if (!isIOS || standalone || dismissed) return;

  const hint = document.createElement('div');
  hint.className = 'install-hint';
  hint.innerHTML =
    '<img src="icons/apple-touch-icon.png" alt="">' +
    '<p>Add Doodlebooth to your home screen — tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>' +
    '<button aria-label="Dismiss">✕</button>';

  hint.querySelector('button').addEventListener('click', function () {
    hint.remove();
    try { localStorage.setItem('helpful.installHint', 'no'); } catch (err) {}
  });

  /* wait a moment so it doesn't appear before the page has drawn */
  setTimeout(function () { document.body.appendChild(hint); }, 1800);
}

initPWA();
