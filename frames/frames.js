/* ══ FRAMES ═══════════════════════════════════════════
   Every frame in the app. Add yours to the list, save,
   refresh. Nothing else to edit.

     id      must match the filename prefix of your PNGs
     label   what the button says
     bg      paper colour behind the photos
     ink     footer text colour
     art     you drew a PNG that goes OVER the photos
             -> frames/<id>-three.png and <id>-six.png
     back    you drew one that goes BEHIND them
             -> frames/<id>-back-three.png and -six.png
     doodle  keep the hand-drawn wobbly border

   This is a .js file rather than .json on purpose: a browser
   will not let a page opened straight off the disk read a
   .json file, but it will always run a <script>. So the app
   shows your frames whether it is served or double-clicked.
   See README.md.                                           */

window.BOOTH_FRAMES = [
  { id: 'classic', label: 'Classic',  bg: '#FFFFFF', ink: '#4A4A4A', doodle: true },
  { id: 'charcoal',label: 'Charcoal', bg: '#2B2B2B', ink: '#EFEAE2' },
  { id: 'blush',   label: 'Blush',    bg: '#E8CFC8', ink: '#4A4A4A' },
  { id: 'sky',     label: 'Sky',      bg: '#C8D8E8', ink: '#4A4A4A' },
  { id: 'bear',    label: 'Bear',     bg: '#F5F0E8', ink: '#4A4A4A', art: true },
  { id: 'dots',    label: 'Dots',     bg: '#F5F0E8', ink: '#4A4A4A', back: true },
];
