// 3D walk through Cambridge, 1575. Houses are raised from the engraving itself (MAP_GRID from map-data.js),
// landmarks are hand-built from boxes, cylinders and cones; townsfolk, punts and sheep wander about.
// Needs THREE (r128) and PLACES / openCard / closeCard from index.html.
window.City3D = (function () {
  const W = 1200, H = W * 1427 / 1920;                 // world size; 1 unit ≈ 1 metre
  const G = window.MAP_GRID, CW = W / G.w, CH = H / G.h;
  const EYE = 1.7, WALK = 7, RUN = 18;
  const PAPER = 0xe9dcbc;

  let renderer, scene, camera, sun, root, built = false, active = false, onExit = () => {};
  const occ = new Uint8Array(G.w * G.h);               // 1 = a house stands in this cell
  const colliders = [];                                 // landmark walls: [minX, maxX, minZ, maxZ]
  const animated = [];                                  // per-frame callbacks (t, dt)
  const player = { x: 0, z: 0, yaw: 0, pitch: 0, bob: 0 };
  let target = null, intro = 0, introStart = 0, nearId = null, last = 0;
  const keys = {};

  const toWorld = (x, y) => ({ x: (x / 100 - 0.5) * W, z: (y / 100 - 0.5) * H });
  const toPct = (X, Z) => ({ x: (X / W + 0.5) * 100, y: (Z / H + 0.5) * 100 });
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const cellOf = (X, Z) => [Math.floor((X + W / 2) / CW), Math.floor((Z + H / 2) / CH)];

  // ---------- The river Cam, traced from the engraving (pixels of a 1024×761 copy) ----------
  const px = pts => pts.map(([x, y]) => toWorld(x / 10.24, y / 7.61));
  const RIVERS = [
    px([[150, 452], [195, 505], [245, 545], [295, 575], [335, 590], [400, 596], [462, 598]]),
    px([[462, 598], [520, 584], [600, 582], [640, 598]]),                        // round Garret Hostel Green…
    px([[462, 598], [500, 630], [565, 641], [625, 622], [640, 598]]),            // …on both sides
    px([[640, 598], [700, 556], [745, 547], [765, 535], [850, 520], [920, 506], [1010, 485]]),
    px([[720, 556], [800, 568], [870, 577], [1010, 590]]),                       // the mill stream
  ];
  const BRIDGES = px([[335, 590], [462, 598], [722, 553], [842, 521], [842, 574]]);
  const RIVER_W = 13;
  const segs = RIVERS.flatMap(r => r.slice(1).map((p, i) => [r[i], p]));
  function segDist(X, Z, [a, b]) {
    const dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((X - a.x) * dx + (Z - a.z) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(X - a.x - dx * t, Z - a.z - dz * t);
  }
  const inWater = (X, Z, margin = 0) => segs.some(s => segDist(X, Z, s) < RIVER_W / 2 + margin);
  const onBridge = (X, Z) => BRIDGES.some(b => Math.hypot(X - b.x, Z - b.z) < 4.5);
  // the cartouche, the legend and the gentlefolk in the corner are not part of the town
  const EXCL = [[0, 0, .035, 1], [.972, 0, 1, 1], [0, 0, 1, .045], [0, .955, 1, 1], [.02, .03, .30, .60], [.70, .02, .95, .26], [.62, .73, .88, .99]];
  const inDecor = (X, Z) => { const u = X / W + .5, v = Z / H + .5; return EXCL.some(([a, b, c, d]) => u >= a && u <= c && v >= b && v <= d); };

  // ---------- Hand-drawn canvas textures ----------
  function canvasTex(size, draw, repeat, h = size) {
    const c = document.createElement("canvas"); c.width = size; c.height = h;
    draw(c.getContext("2d"), size, h);
    const t = new THREE.CanvasTexture(c);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8; t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function grain(g, w, h, n = 1800, a = .08) {          // plaster / stone mottling
    for (let i = 0; i < n; i++) {
      g.fillStyle = Math.random() < .5 ? `rgba(90,60,30,${a * Math.random()})` : `rgba(255,255,240,${a * Math.random()})`;
      const s = 1 + Math.random() * 5; g.fillRect(Math.random() * w, Math.random() * h, s, s);
    }
  }
  function leaded(g, x, y, w, h, shutters) {             // a leaded-glass casement, optional shutters
    g.fillStyle = "#3d2c1c"; g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = "#2a3440"; g.fillRect(x, y, w, h);
    g.strokeStyle = "rgba(200,190,150,.6)"; g.lineWidth = 1;
    for (let i = -h; i < w; i += 7) { g.beginPath(); g.moveTo(x + i, y); g.lineTo(x + i + h, y + h); g.moveTo(x + i + h, y); g.lineTo(x + i, y + h); g.stroke(); }
    g.fillStyle = "rgba(255,250,220,.25)"; g.fillRect(x + 2, y + 2, w / 3, h / 2);
    g.fillStyle = "#6b4a2b"; g.fillRect(x - 4, y + h + 2, w + 8, 4);
    if (shutters) { g.fillStyle = shutters; g.fillRect(x - w / 2 - 4, y - 2, w / 2, h + 4); g.fillRect(x + w + 4, y - 2, w / 2, h + 4); }
  }
  const T = {};
  function makeTextures() {
    T.ground = canvasTex(256, (g, s) => {                // shop front: stone plinth, door, casement, sign
      g.fillStyle = "#fbf3df"; g.fillRect(0, 0, s, s); grain(g, s, s);
      g.fillStyle = "#b9a98c"; g.fillRect(0, 214, s, 42); grain(g, s, 42, 200, .2);
      g.fillStyle = "#4a3120"; g.fillRect(0, 0, s, 12); g.fillRect(0, 0, 10, s); g.fillRect(s - 10, 0, 10, s);
      g.fillStyle = "#3a2616"; g.beginPath(); g.moveTo(40, 256); g.lineTo(40, 110); g.quadraticCurveTo(75, 80, 110, 110); g.lineTo(110, 256); g.fill();
      g.strokeStyle = "#5c4028"; g.lineWidth = 3; for (let x = 52; x < 110; x += 14) { g.beginPath(); g.moveTo(x, 100); g.lineTo(x, 256); g.stroke(); }
      g.fillStyle = "#c89b3c"; g.beginPath(); g.arc(98, 180, 4, 0, 7); g.fill();
      leaded(g, 140, 70, 84, 100, false);
      g.fillStyle = "#7a5230"; g.fillRect(132, 176, 100, 14);
    });
    T.timber = canvasTex(256, (g, s) => {                // Tudor framing: studs, braces, two casements
      g.fillStyle = "#fbf3df"; g.fillRect(0, 0, s, s); grain(g, s, s);
      g.fillStyle = "#4a3120";
      g.fillRect(0, 0, s, 12); g.fillRect(0, s - 12, s, 12); g.fillRect(0, 120, s, 10);
      for (let x = 0; x <= s; x += 42) g.fillRect(x - 5, 0, 10, s);
      g.strokeStyle = "#4a3120"; g.lineWidth = 9;
      g.beginPath(); g.moveTo(0, 256); g.lineTo(42, 130); g.moveTo(256, 256); g.lineTo(214, 130);
      g.moveTo(84, 120); g.lineTo(126, 12); g.moveTo(172, 120); g.lineTo(130, 12); g.stroke();
      leaded(g, 47, 150, 76, 70); leaded(g, 133, 150, 76, 70);
      leaded(g, 150, 30, 50, 60); leaded(g, 56, 30, 50, 60);
    });
    T.plaster = canvasTex(256, (g, s) => {               // lime-washed plaster with shuttered windows
      g.fillStyle = "#fff8ea"; g.fillRect(0, 0, s, s); grain(g, s, s, 2500, .12);
      g.fillStyle = "#6b4a2b"; g.fillRect(0, 0, s, 10); g.fillRect(0, 124, s, 6);
      leaded(g, 40, 30, 56, 70, "#3f6aa0"); leaded(g, 160, 30, 56, 70, "#3f6aa0");
      leaded(g, 40, 156, 56, 70, "#3f6aa0"); leaded(g, 160, 156, 56, 70, "#3f6aa0");
    });
    T.brick = canvasTex(256, (g, s) => {                 // Tudor brick with diaper pattern
      g.fillStyle = "#e8d6c8"; g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 10) for (let x = (y / 10) % 2 ? -12 : 0; x < s; x += 24) {
        const l = 200 + Math.random() * 55, dark = (Math.abs(((x + y * 2) % 96)) < 12) && Math.random() < .7;
        g.fillStyle = dark ? "#6d5b66" : `rgb(${l},${l - 25},${l - 30})`; g.fillRect(x + 1, y + 1, 22, 8);
      }
      leaded(g, 40, 40, 60, 70); leaded(g, 156, 40, 60, 70); leaded(g, 40, 160, 60, 70); leaded(g, 156, 160, 60, 70);
    });
    T.tiles = canvasTex(128, (g, s) => {                  // clay tiles, each a slightly different shade, a little moss
      g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 8) for (let x = (y / 8) % 2 ? -5 : 0; x < s; x += 10) {
        const l = 170 + Math.random() * 85; g.fillStyle = `rgb(${l},${l},${l})`; g.fillRect(x, y, 9, 7);
        g.fillStyle = "rgba(40,20,10,.35)"; g.fillRect(x, y + 6, 10, 2);
      }
      for (let i = 0; i < 14; i++) { g.fillStyle = "rgba(110,130,60,.35)"; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 2 + Math.random() * 6, 0, 7); g.fill(); }
    }, true);
    T.stone = canvasTex(256, (g, s) => stoneBlocks(g, s), true);
    T.stoneWin = canvasTex(256, (g, s) => {             // ashlar with a tall traceried gothic window
      stoneBlocks(g, s);
      g.fillStyle = "#6f6450"; g.beginPath(); g.moveTo(72, 244); g.lineTo(72, 90); g.quadraticCurveTo(72, 26, 128, 12); g.quadraticCurveTo(184, 26, 184, 90); g.lineTo(184, 244); g.fill();
      g.fillStyle = "#26303d"; g.beginPath(); g.moveTo(80, 238); g.lineTo(80, 92); g.quadraticCurveTo(80, 34, 128, 22); g.quadraticCurveTo(176, 34, 176, 92); g.lineTo(176, 238); g.fill();
      g.fillStyle = "rgba(150,70,60,.5)"; g.fillRect(84, 120, 88, 30); g.fillStyle = "rgba(60,90,150,.5)"; g.fillRect(84, 170, 88, 30);
      g.strokeStyle = "#d6c7a1"; g.lineWidth = 4;
      g.beginPath(); for (const x of [104, 128, 152]) { g.moveTo(x, 60); g.lineTo(x, 238); } g.moveTo(80, 160); g.lineTo(176, 160); g.stroke();
      g.lineWidth = 3; g.beginPath(); g.arc(104, 70, 22, Math.PI, 0); g.arc(152, 70, 22, Math.PI, 0); g.stroke();
    }, true);
    T.water = canvasTex(128, (g, s) => {
      g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
      g.strokeStyle = "rgba(60,80,90,.35)"; g.lineWidth = 2;
      for (let i = 0; i < 40; i++) { const x = Math.random() * s, y = Math.random() * s; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6, y - 3, x + 14, y); g.stroke(); }
      g.strokeStyle = "rgba(255,255,255,.7)";
      for (let i = 0; i < 20; i++) { const x = Math.random() * s, y = Math.random() * s; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 8, y); g.stroke(); }
    }, true);
    T.detail = canvasTex(256, (g, s) => {                // speckle laid over the ground so it isn't a blur underfoot
      g.clearRect(0, 0, s, s);
      for (let i = 0; i < 5000; i++) { g.fillStyle = Math.random() < .6 ? "rgba(60,40,20,.25)" : "rgba(255,250,230,.25)"; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1 + Math.random() * 2); }
      for (let i = 0; i < 60; i++) { g.strokeStyle = "rgba(60,40,20,.25)"; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 3 + Math.random() * 5, 0, 7); g.stroke(); }
    }, true);
    T.flag = canvasTex(64, (g) => { g.fillStyle = "#f7f1e3"; g.fillRect(0, 0, 64, 40); g.fillStyle = "#b3261e"; g.fillRect(26, 0, 12, 40); g.fillRect(0, 14, 64, 12); }, false, 40);
  }
  function stoneBlocks(g, s) {
    g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 22) for (let x = (y / 22) % 2 ? -24 : 0; x < s; x += 48) {
      const l = 215 + Math.random() * 40; g.fillStyle = `rgb(${l},${l - 6},${l - 18})`; g.fillRect(x + 1, y + 1, 46, 20);
    }
    grain(g, s, s, 1500, .1);
  }

  // ---------- Geometry helpers ----------
  function prismGeo() {                                   // gable roof: ridge along X, 1×1×1, base at y=0
    const a = [-.5, 0, -.5], b = [.5, 0, -.5], c = [.5, 1, 0], d = [-.5, 1, 0], e = [-.5, 0, .5], f = [.5, 0, .5];
    const tris = [a, c, b, a, d, c, e, f, c, e, c, d, a, e, d, b, c, f];
    const uvs = [0, 0, 2, 1, 2, 0, 0, 0, 0, 1, 2, 1, 0, 0, 2, 0, 2, 1, 0, 0, 2, 1, 0, 1, 0, 0, 1, 0, .5, 1, 0, 0, .5, 1, 1, 0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(tris.flat(), 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  }
  function tiledBox(w, h, d, tile) {                      // box whose texture repeats every `tile` units
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv;
    for (let f = 0; f < 6; f++) {
      const [su, sv] = f < 2 ? [d, h] : f < 4 ? [w, d] : [w, h];
      for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * su / tile, uv.getY(i) * sv / tile); }
    }
    return geo;
  }
  function houseBox(topCap) {                             // unit box: texture on the four walls only
    const geo = new THREE.BoxGeometry(1, 1, 1), uv = geo.attributes.uv;
    for (let i = 8; i < 16; i++) uv.setXY(i, .02, .02);   // top & bottom faces sample a plain corner
    return geo;
  }

  let M, PRISM;
  function box(w, h, d, x, y, z, mat, tile = 8, solid = true) {
    const m = new THREE.Mesh(tiledBox(w, h, d, tile), mat);
    m.position.set(x, y + h / 2, z); root.add(m);
    if (solid && y < 2) colliders.push([x - w / 2, x + w / 2, z - d / 2, z + d / 2]);
    return m;
  }
  function gable(w, h, d, x, y, z, mat, alongZ) {
    const m = new THREE.Mesh(PRISM, mat);
    m.position.set(x, y, z); m.scale.set(w, h, d);            // ridge runs along local X (length w)
    if (alongZ) m.rotation.y = Math.PI / 2;
    root.add(m); return m;
  }
  function tower(r, h, x, z, mat, { y = 0, sides = 8, spire = 0, spireMat = M.lead, crenel = false } = {}) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, h, sides), mat);
    m.position.set(x, y + h / 2, z); root.add(m);
    if (y < 2) colliders.push([x - r, x + r, z - r, z + r]);
    if (spire) { const s = new THREE.Mesh(new THREE.ConeGeometry(r * 1.1, spire, sides), spireMat); s.position.set(x, y + h + spire / 2, z); root.add(s);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(r * .18 + .1, 8, 6), M.gold); ball.position.set(x, y + h + spire, z); root.add(ball); }
    if (crenel) for (let i = 0; i < sides * 2; i += 2) {
      const a = i / (sides * 2) * Math.PI * 2;
      box(1.2, 1.4, 1.2, x + Math.cos(a) * r * .9, y + h, z + Math.sin(a) * r * .9, mat, 8, false);
    }
    return m;
  }
  function crenels(w, d, x, y, z, mat) {                 // battlements around a rectangle's top edge
    for (let i = -w / 2; i <= w / 2; i += 2.6) { box(1.3, 1.5, 1, x + i, y, z - d / 2, mat, 8, false); box(1.3, 1.5, 1, x + i, y, z + d / 2, mat, 8, false); }
    for (let i = -d / 2 + 2.6; i < d / 2; i += 2.6) { box(1, 1.5, 1.3, x - w / 2, y, z + i, mat, 8, false); box(1, 1.5, 1.3, x + w / 2, y, z + i, mat, 8, false); }
  }
  function flag(x, y, z) {                                // St George's cross fluttering on a pole
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 5, 5), M.wood); pole.position.set(x, y + 2.5, z); root.add(pole);
    const f = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2, 8, 1), M.flag);
    f.geometry.translate(1.6, 0, 0); f.position.set(x, y + 4, z); root.add(f);
    const pos = f.geometry.attributes.position, base = pos.array.slice();
    animated.push(t => { for (let i = 0; i < pos.count; i++) { const u = base[i * 3]; pos.setZ(i, Math.sin(u * 2 - t * 5) * .25 * u / 3.2); } pos.needsUpdate = true; f.rotation.y = Math.sin(t * .4) * .3; });
  }
  function gatehouse(x, z, mat, h = 20) {                // square gate tower with four corner turrets
    box(13, h, 11, x, 0, z, mat, 8, false);
    box(5, 7, 11.2, x, 0, z, M.dark, 8, false);             // the archway — walk through it
    box(3, 3, 11.3, x, 9, z, M.stoneWin, 3, false);         // oriel window above the arch
    colliders.push([x - 6.5, x - 2.5, z - 5.5, z + 5.5], [x + 2.5, x + 6.5, z - 5.5, z + 5.5]);
    crenels(13, 11, x, h, z, mat);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(1.8, h + 4, x + i * 6.5, z + j * 5.5, mat, { crenel: true, sides: 8 }));
  }
  function quad(cx, cz, w, d, wall, roofMat, h = 11) {  // a college court: four ranges around a lawn
    const t = 9;
    box(w, h, t, cx, 0, cz - d / 2, wall); gable(w, 5, t + 1, cx, h, cz - d / 2, roofMat);
    box(w, h, t, cx, 0, cz + d / 2, wall); gable(w, 5, t + 1, cx, h, cz + d / 2, roofMat);
    box(t, h, d - t, cx - w / 2, 0, cz, wall); gable(d - t, 5, t + 1, cx - w / 2, h, cz, roofMat, true);
    box(t, h, d - t, cx + w / 2, 0, cz, wall); gable(d - t, 5, t + 1, cx + w / 2, h, cz, roofMat, true);
    for (let i = -w / 2 + 6; i < w / 2 - 3; i += 9) {    // chimneys & dormers along the ranges
      box(1.2, 4, 1.2, cx + i, h + 2, cz - d / 2 - 1, M.brick, 4, false); box(1.2, 4, 1.2, cx + i + 4, h + 2, cz + d / 2 + 1, M.brick, 4, false);
    }
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(w - t, d - t), M.lawn);
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(cx, .06, cz); root.add(lawn);
    // paths crossing the lawn
    const path = new THREE.Mesh(new THREE.PlaneGeometry(2.5, d - t), M.path); path.rotation.x = -Math.PI / 2; path.position.set(cx, .08, cz); root.add(path);
    const path2 = new THREE.Mesh(new THREE.PlaneGeometry(w - t, 2.5), M.path); path2.rotation.x = -Math.PI / 2; path2.position.set(cx, .08, cz); root.add(path2);
    // leave the court enterable: replace the front range's collider with two halves around the gate
    const front = colliders.findIndex(c => c[2] === cz + d / 2 - t / 2 && c[0] === cx - w / 2);
    if (front >= 0) colliders.splice(front, 1, [cx - w / 2, cx - 4, cz + d / 2 - t / 2, cz + d / 2 + t / 2], [cx + 4, cx + w / 2, cz + d / 2 - t / 2, cz + d / 2 + t / 2]);
    gatehouse(cx, cz + d / 2, wall);
    flag(cx, 24, cz + d / 2);
  }
  function church(cx, cz, len, wid, h, mat, roofMat, towerH) {
    box(len, h, wid, cx, 0, cz, mat, 10); gable(len, h * .45, wid + 1, cx, h, cz, roofMat);
    for (let i = -len / 2 + 3; i <= len / 2 - 3; i += 7) { box(1.4, h * .8, 2, cx + i, 0, cz - wid / 2 - .6, M.stone, 6, false); box(1.4, h * .8, 2, cx + i, 0, cz + wid / 2 + .6, M.stone, 6, false); }
    if (towerH) {
      const tx = cx - len / 2 - 5;
      box(10, towerH, 10, tx, 0, cz, M.stoneWin, 10); crenels(10, 10, tx, towerH, cz, mat);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(.9, 6, tx + i * 4.5, cz + j * 4.5, mat, { y: towerH, sides: 6, spire: 3 }));
      const clock = new THREE.Mesh(new THREE.CircleGeometry(1.8, 20), M.clock); clock.position.set(tx, towerH - 6, cz + 5.05); root.add(clock);
    }
  }
  function label(text, x, y, z) {
    const c = document.createElement("canvas"); c.width = 512; c.height = 96;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(244,232,204,.95)"; g.fillRect(4, 4, 504, 88);
    g.strokeStyle = "#b3261e"; g.lineWidth = 6; g.strokeRect(4, 4, 504, 88);
    g.fillStyle = "#3b2412"; g.font = "44px 'IM Fell English SC', Georgia, serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 256, 50, 480);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c) }));
    s.scale.set(32, 6, 1); s.position.set(x, y, z); root.add(s);
  }

  // ---------- Landmarks ----------
  const LANDMARKS = {
    kings(x, z) {                                        // King's College Chapel: long, tall, four pinnacles
      box(72, 27, 19, x, 0, z, M.stoneWin, 9);
      gable(72, 5, 20, x, 27, z, M.lead);
      for (let i = -32; i <= 32; i += 8) { box(2.2, 23, 3, x + i, 0, z - 11, M.stone); box(2.2, 23, 3, x + i, 0, z + 11, M.stone);
        tower(.6, 4, x + i, z - 11, M.stone, { y: 23, sides: 6, spire: 2.5, spireMat: M.stone }); tower(.6, 4, x + i, z + 11, M.stone, { y: 23, sides: 6, spire: 2.5, spireMat: M.stone }); }
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(2.6, 36, x + i * 36, z + j * 9.5, M.stone, { sides: 8, spire: 8, spireMat: M.stone }));
      const east = new THREE.Mesh(new THREE.PlaneGeometry(12, 20), M.stoneWin); east.position.set(x + 36.05, 14, z); east.rotation.y = Math.PI / 2; root.add(east);
      box(5, 6, 1, x - 20, 0, z + 9.8, M.dark, 4, false);
      quad(x - 10, z + 48, 60, 50, M.stone, M.lead, 10);
      flag(x + 36, 44, z - 9.5);
    },
    trinity(x, z) { quad(x, z, 80, 76, M.stoneWin, M.slate, 12);
      tower(3, 4, x, z, M.stone, { sides: 8 }); tower(3.4, 2.5, x, z, M.stone, { y: 4, sides: 8, spire: 5, spireMat: M.lead }); // the fountain
      church(x - 10, z - 55, 44, 13, 14, M.stoneWin, M.lead); },
    johns(x, z) { quad(x, z, 58, 50, M.brickL, M.tile, 12); church(x + 5, z - 40, 34, 12, 14, M.stoneWin, M.lead, 26); },
    queens(x, z) { quad(x, z, 48, 44, M.brickL, M.tile); },
    corpus(x, z) { quad(x, z, 42, 40, M.stone, M.tile, 10); church(x - 34, z, 22, 10, 10, M.stone, M.tile, 22); },
    peter(x, z) { quad(x, z, 44, 38, M.stone, M.tile); church(x, z - 34, 20, 10, 12, M.stoneWin, M.lead); },
    christs(x, z) { quad(x, z, 48, 46, M.stone, M.slate); },
    jesus(x, z) { quad(x, z, 46, 46, M.brickL, M.tile); church(x + 8, z - 40, 36, 12, 14, M.stoneWin, M.lead, 30); },
    magdalene(x, z) { quad(x, z, 38, 34, M.brickL, M.tile, 10); },
    round(x, z) {                                        // the Round Church: drum, clerestory, conical roof
      tower(9, 9, x, z, M.stone, { sides: 16 });
      tower(5.5, 5, x, z, M.stone, { y: 9, sides: 16, spire: 5, spireMat: M.lead });
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, w = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 3), M.dark); w.position.set(x + Math.cos(a) * 9.05, 5, z + Math.sin(a) * 9.05); w.rotation.y = -a + Math.PI / 2; root.add(w); }
      box(12, 8, 9, x + 13, 0, z, M.stone); gable(12, 4, 10, x + 13, 8, z, M.tile);
    },
    senate(x, z) { church(x + 4, z, 42, 16, 15, M.stoneWin, M.lead, 36);
      box(34, 14, 14, x, 0, z + 28, M.white, 6);           // Senate House (well, it's 1730 — the map is dreaming)
      for (let i = -15; i <= 15; i += 5) tower(.8, 12, x + i, z + 36, M.white, { sides: 10 });
      gable(34, 4, 15, x, 14, z + 28, M.white); flag(x - 22, 39.5, z); },
    market(x, z) {                                       // stalls with striped awnings, wares and a market cross
      tower(1.2, 7, x, z, M.stone, { sides: 8, spire: 3, spireMat: M.stone }); tower(3, 1.5, x, z, M.stone, { sides: 8 });
      const wares = [M.red, M.gold, M.lawn, M.awningB, M.blue];
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2, r = 16 + (i % 2) * 8, sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
        const st = box(4, 1.1, 2.6, sx, 0, sz, M.wood, 4); st.rotation.y = -a;
        for (let k = 0; k < 5; k++) { const w = new THREE.Mesh(new THREE.SphereGeometry(.25, 6, 4), pick(wares)); w.position.set(sx + rnd(-1.5, 1.5), 1.35, sz + rnd(-.8, .8)); root.add(w); }
        const aw = new THREE.Mesh(PRISM, i % 3 ? M.awningR : M.awningB);
        aw.position.set(sx, 2.8, sz); aw.scale.set(5, 1.2, 3.6); aw.rotation.y = -a; root.add(aw);
      }
      for (let i = 0; i < 10; i++) { const b = new THREE.Mesh(new THREE.CylinderGeometry(.45, .4, 1, 10), M.wood); b.position.set(x + rnd(-26, 26), .5, z + rnd(-26, 26)); root.add(b); }
    },
    castle(x, z) {                                       // Norman castle: keep on a motte, curtain wall, round towers
      const motte = new THREE.Mesh(new THREE.CylinderGeometry(16, 34, 12, 20), M.grass);
      motte.position.set(x, 6, z); root.add(motte); colliders.push([x - 26, x + 26, z - 26, z + 26]);
      box(18, 18, 18, x, 12, z, M.stoneDark, 6); crenels(18, 18, x, 30, z, M.stoneDark);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(2.2, 22, x + i * 9, z + j * 9, M.stoneDark, { y: 12, crenel: true }));
      flag(x, 31.5, z);
      const R = 55, n = 7;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
        const ax = x + Math.cos(a) * R, az = z + Math.sin(a) * R, bx = x + Math.cos(b) * R, bz = z + Math.sin(b) * R;
        tower(5, 17, ax, az, M.stoneDark, { crenel: true });
        if (i === 2) continue;                           // a gap for the gate
        const len = Math.hypot(bx - ax, bz - az), wall = new THREE.Mesh(tiledBox(len, 11, 3, 6), M.stoneDark);
        wall.position.set((ax + bx) / 2, 5.5, (az + bz) / 2); wall.rotation.y = -Math.atan2(bz - az, bx - ax); root.add(wall);
        for (let k = 0; k < len; k += 2.6) { const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.5, 3.2), M.stoneDark);
          m.position.set(ax + (bx - ax) * k / len, 11.75, az + (bz - az) * k / len); m.rotation.y = wall.rotation.y; root.add(m); }
        for (let k = 0; k < 8; k++) colliders.push([ax + (bx - ax) * k / 8 - 2, ax + (bx - ax) * k / 8 + 2, az + (bz - az) * k / 8 - 2, az + (bz - az) * k / 8 + 2]);
      }
    },
    cjbs(x, z) {                                         // Outram's polychrome Judge building
      box(40, 16, 26, x, 0, z, M.judge, 16);
      gable(40, 5, 27, x, 16, z, M.tile);
      for (let i = -18; i <= 18; i += 6) { tower(1.3, 13, x + i, z + 15, M.red, { sides: 10 }); tower(1.8, 1.4, x + i, z + 15, M.blue, { y: 13, sides: 10 }); }
      tower(5, 8, x, z, M.blue, { y: 21, sides: 12, spire: 4, spireMat: M.red });
    },
  };
  const CLEAR = { kings: 70, trinity: 60, johns: 50, castle: 70, market: 38, senate: 48, cjbs: 36, round: 26 };

  // ---------- River, bridges, punts ----------
  function buildRiver() {
    RIVERS.forEach(r => {
      const pos = [], uv = [], idx = []; let along = 0;
      r.forEach((p, i) => {
        const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz), nx = -dz / l * RIVER_W / 2, nz = dx / l * RIVER_W / 2;
        if (i) along += Math.hypot(p.x - r[i - 1].x, p.z - r[i - 1].z);
        pos.push(p.x + nx, .12, p.z + nz, p.x - nx, .12, p.z - nz); uv.push(0, along / 12, 1, along / 12);
        if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, M.water); m.receiveShadow = true; root.add(m);
      // reeds along the banks
      r.slice(1).forEach((p, i) => { for (let k = 0; k < 6; k++) {
        const t = Math.random(), a = r[i], side = Math.random() < .5 ? 1 : -1, dx = p.x - a.x, dz = p.z - a.z, l = Math.hypot(dx, dz);
        const rx = a.x + dx * t - dz / l * side * (RIVER_W / 2 + .3), rz = a.z + dz * t + dx / l * side * (RIVER_W / 2 + .3);
        const reed = new THREE.Mesh(new THREE.ConeGeometry(.35, rnd(1, 1.8), 4), M.reed); reed.position.set(rx, .6, rz); root.add(reed);
      } });
    });
    animated.push((t, dt) => { M.water.map.offset.y -= dt * .05; M.water.map.offset.x = Math.sin(t * .3) * .05; });
    BRIDGES.forEach(b => {                               // a stone bridge across the nearest stretch of river
      let best = segs[0], bd = 1e9; segs.forEach(s => { const d = segDist(b.x, b.z, s); if (d < bd) { bd = d; best = s; } });
      const ang = Math.atan2(best[1].z - best[0].z, best[1].x - best[0].x);
      const g = new THREE.Group(); g.position.set(b.x, 0, b.z); g.rotation.y = -ang + Math.PI / 2; root.add(g);
      const deck = new THREE.Mesh(tiledBox(5, .5, RIVER_W + 6, 3), M.stone); deck.position.y = .25; g.add(deck);
      [-2.6, 2.6].forEach(sx => { const p = new THREE.Mesh(tiledBox(.5, 1, RIVER_W + 6, 3), M.stone); p.position.set(sx, .9, 0); g.add(p); });
      const arch = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 5.2, 16, 1, true, 0, Math.PI), M.stoneDark); arch.rotation.z = Math.PI / 2; arch.position.y = -2.5; g.add(arch);
    });
    // punts: a flat hull, a punter with a long pole, gliding up and down the river
    RIVERS.forEach((r, ri) => {
      if (ri === 2) return;
      const lens = r.slice(1).map((p, i) => Math.hypot(p.x - r[i].x, p.z - r[i].z)), total = lens.reduce((a, b) => a + b, 0);
      for (let n = 0; n < 2; n++) {
        const g = new THREE.Group(); root.add(g);
        const hull = new THREE.Mesh(new THREE.BoxGeometry(1.6, .4, 6.5), M.wood); hull.position.y = .3; g.add(hull);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(.22, .32, 1.1, 8), pick([M.red, M.blue, M.dark])); body.position.set(0, 1.05, -2.3); g.add(body);
        const head = new THREE.Mesh(new THREE.SphereGeometry(.15, 8, 6), M.skin); head.position.set(0, 1.75, -2.3); g.add(head);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, 6, 4), M.wood); pole.position.set(.4, 1.6, -2.1); pole.rotation.x = .35; g.add(pole);
        const pass = new THREE.Mesh(new THREE.CylinderGeometry(.22, .3, .8, 8), pick([M.awningB, M.gold])); pass.position.set(0, .8, 1.2); g.add(pass);
        const ph = new THREE.Mesh(new THREE.SphereGeometry(.14, 8, 6), M.skin); ph.position.set(0, 1.35, 1.2); g.add(ph);
        let s = Math.random() * total, dir = n ? 1 : -1; const v = rnd(1.2, 2);
        animated.push((t, dt) => {
          s += dir * v * dt; if (s > total - 3 || s < 3) dir *= -1;
          let k = 0, acc = s; while (k < lens.length - 1 && acc > lens[k]) { acc -= lens[k]; k++; }
          const a = r[k], b = r[k + 1], f = acc / lens[k];
          g.position.set(a.x + (b.x - a.x) * f, Math.sin(t * 2 + n) * .04, a.z + (b.z - a.z) * f);
          g.rotation.y = Math.atan2(b.x - a.x, b.z - a.z) + (dir < 0 ? Math.PI : 0);
          pole.rotation.x = .35 + Math.sin(t * 1.5 + n) * .25;
        });
      }
    });
  }

  // ---------- Townsfolk ----------
  const LINES = [
    "Good morrow to thee, stranger!", "God save Queen Elizabeth!", "Hast thou seen the new court at Trinity?",
    "The Proctors are abroad — keep thy gown on!", "Fresh eels from the Cam, a penny the brace!", "Stourbridge Fair is nigh, sir — best in all England.",
    "Pray, which way to the Market Hill?", "I read Greek by candle till the bell of Great St Mary's.", "A business school? What manner of trade is that?",
    "Mind the kine on Garret Hostel Green.", "They say King's Chapel took seventy years. My back feels every one.", "Hast thou a farthing for a poor scholar?",
    "The plague is in London, they say. Stay thee in Cambridge.", "Buy my apples! Sweet pippins!", "The river floods again come Michaelmas, mark me.",
    "Whither goest thou in such strange garb?", "My master lectures on Aristotle at nine. I shall be late.", "A pint of ale at the Eagle? It's not built yet, alas.",
  ];
  const PEOPLE = [], BUBBLE = { el: null, who: null, until: 0 };
  function buildPeople(streets) {
    const N = Math.min(220, streets.length);
    const lam = o => new THREE.MeshLambertMaterial(o);
    const legGeo = new THREE.CylinderGeometry(.08, .065, .8, 6); legGeo.translate(0, -.4, 0);
    const bodyGeo = new THREE.CylinderGeometry(.2, .36, 1, 10); bodyGeo.translate(0, .5, 0);
    const armGeo = new THREE.CylinderGeometry(.06, .05, .62, 5); armGeo.translate(0, -.31, 0);
    const parts = {
      legs: new THREE.InstancedMesh(legGeo, lam({ color: 0xffffff }), N * 2),
      body: new THREE.InstancedMesh(bodyGeo, lam({ color: 0xffffff }), N),
      arms: new THREE.InstancedMesh(armGeo, lam({ color: 0xffffff }), N * 2),
      head: new THREE.InstancedMesh(new THREE.SphereGeometry(.13, 10, 8), lam({ color: 0xffffff }), N),
      hat: new THREE.InstancedMesh(new THREE.CylinderGeometry(.19, .21, .12, 4), lam({ color: 0xffffff }), N),
    };
    Object.values(parts).forEach(p => { p.castShadow = true; p.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(p); });
    const col = new THREE.Color();
    const KINDS = [
      { w: 3, name: "scholar", gown: 1.45, body: [0x1f1b1e, 0x2a2330], hat: [0x151515], cap: true },
      { w: 3, name: "burgher", gown: .72, body: [0xb3261e, 0x3f6aa0, 0x6b8e3a, 0x8a5a2b, 0xc89b3c], legs: [0xb3261e, 0xe9dcbc, 0x3b2412, 0x3f6aa0], hat: [0x222222, 0x6b3a1e, 0xb3261e] },
      { w: 2, name: "goodwife", gown: 1.45, body: [0x8b2c2c, 0x5d7899, 0x7a6a3a, 0xa0522d, 0x6e4b6e], hat: [0xf7f1e3] },
    ];
    const bag = KINDS.flatMap(k => Array(k.w).fill(k));
    for (let i = 0; i < N; i++) {
      const k = pick(bag), c = streets[Math.floor(Math.random() * streets.length)];
      const p = { x: c[0] + rnd(-1, 1), z: c[1] + rnd(-1, 1), yaw: rnd(0, 6.3), tx: 0, tz: 0, speed: rnd(.9, 1.5), phase: rnd(0, 6), kind: k, pause: 0, line: pick(LINES), h: rnd(.92, 1.06) };
      parts.body.setColorAt(i, col.setHex(pick(k.body))); parts.hat.setColorAt(i, col.setHex(pick(k.hat)));
      parts.arms.setColorAt(i * 2, col.setHex(pick(k.body))); parts.arms.setColorAt(i * 2 + 1, col);
      const lc = pick(k.legs || [0x222222]); parts.legs.setColorAt(i * 2, col.setHex(lc)); parts.legs.setColorAt(i * 2 + 1, col);
      parts.head.setColorAt(i, col.setHex(pick([0xd9a07a, 0xc98b62, 0xb87850, 0xe0b08e])));
      newTarget(p, streets); PEOPLE.push(p);
    }
    const m = new THREE.Matrix4(), e = new THREE.Euler(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), s = new THREE.Vector3();
    const place = (inst, i, x, y, z, yaw, pitch, sx, sy, sz) => { inst.setMatrixAt(i, m.compose(v.set(x, y, z), q.setFromEuler(e.set(pitch, yaw, 0, "YXZ")), s.set(sx, sy, sz))); };
    animated.push((t, dt) => {
      PEOPLE.forEach((p, i) => {
        const dp = Math.hypot(p.x - player.x, p.z - player.z);
        if (dp < 3.2) {                                    // stop, turn to the visitor and speak
          p.pause = 1.5; const want = Math.atan2(player.x - p.x, player.z - p.z); p.yaw += Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw)) * Math.min(1, dt * 5);
          if (BUBBLE.who !== p && dp < 3) { BUBBLE.who = p; BUBBLE.until = t + 4; BUBBLE.el.textContent = p.line; }
        } else if (p.pause > 0) p.pause -= dt;
        else {
          const dx = p.tx - p.x, dz = p.tz - p.z, d = Math.hypot(dx, dz);
          if (d < .5) { p.pause = Math.random() < .3 ? rnd(1, 4) : 0; newTarget(p, streets); }
          else {
            const nx = p.x + dx / d * p.speed * dt, nz = p.z + dz / d * p.speed * dt;
            if (blocked(nx, nz, true)) newTarget(p, streets); else { p.x = nx; p.z = nz; p.phase += dt * p.speed * 5.5; }
            const want = Math.atan2(dx, dz); p.yaw += Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw)) * Math.min(1, dt * 6);
          }
        }
        const walking = p.pause <= 0 && dp >= 3.2, sw = walking ? Math.sin(p.phase) * .5 : 0, h = p.h, k = p.kind;
        const bob = walking ? Math.abs(Math.cos(p.phase)) * .04 : 0, cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
        const hip = .8 * h + bob;
        const legScale = k.gown > 1 ? .001 : 1;
        place(parts.legs, i * 2, p.x + cy * .1, hip, p.z - sy * .1, p.yaw, sw, legScale, h, legScale);
        place(parts.legs, i * 2 + 1, p.x - cy * .1, hip, p.z + sy * .1, p.yaw, -sw, legScale, h, legScale);
        const gy = k.gown > 1 ? bob : hip - .05;
        place(parts.body, i, p.x, gy, p.z, p.yaw, 0, 1, (k.gown > 1 ? 1.45 : .72) * h, 1);
        place(parts.arms, i * 2, p.x + cy * .27, 1.38 * h + bob, p.z - sy * .27, p.yaw, -sw * .8, 1, h, 1);
        place(parts.arms, i * 2 + 1, p.x - cy * .27, 1.38 * h + bob, p.z + sy * .27, p.yaw, sw * .8, 1, h, 1);
        place(parts.head, i, p.x, 1.58 * h + bob, p.z, p.yaw, 0, 1, 1.1, 1);
        if (k.cap) place(parts.hat, i, p.x, 1.73 * h + bob, p.z, p.yaw + Math.PI / 4, 0, 1.5, .5, 1.5);     // square scholar's cap
        else if (k.name === "goodwife") place(parts.hat, i, p.x, 1.64 * h + bob, p.z, p.yaw, 0, .9, 1.8, .9); // white coif
        else place(parts.hat, i, p.x, 1.74 * h + bob, p.z, p.yaw, 0, 1.1, 1.3, 1.1);
      });
      Object.values(parts).forEach(p => { p.instanceMatrix.needsUpdate = true; });
      // speech bubble follows the speaker's head
      if (BUBBLE.who && t < BUBBLE.until) {
        v.set(BUBBLE.who.x, 2.2, BUBBLE.who.z).project(camera);
        const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        BUBBLE.el.style.display = vis ? "block" : "none";
        BUBBLE.el.style.left = (v.x * .5 + .5) * innerWidth + "px"; BUBBLE.el.style.top = (-v.y * .5 + .5) * innerHeight + "px";
      } else { BUBBLE.el.style.display = "none"; if (BUBBLE.who && Math.hypot(BUBBLE.who.x - player.x, BUBBLE.who.z - player.z) > 4) BUBBLE.who = null; }
    });
  }
  function newTarget(p, streets) {
    for (let k = 0; k < 12; k++) {
      const c = streets[Math.floor(Math.random() * streets.length)];
      if (Math.hypot(c[0] - p.x, c[1] - p.z) < 45) { p.tx = c[0]; p.tz = c[1]; return; }
    }
    p.tx = p.x + rnd(-8, 8); p.tz = p.z + rnd(-8, 8);
  }

  // ---------- Sheep & cattle in the meadows (the engraving has plenty) ----------
  function buildBeasts(meadows) {
    const lam = o => new THREE.MeshLambertMaterial(o);
    const N = Math.min(140, meadows.length);
    const body = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), lam({ color: 0xffffff, flatShading: true }), N);
    const head = new THREE.InstancedMesh(new THREE.BoxGeometry(.35, .35, .5), lam({ color: 0x2a2320 }), N);
    const legs = new THREE.InstancedMesh(new THREE.CylinderGeometry(.06, .06, .5, 4), lam({ color: 0x2a2320 }), N * 4);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    const beasts = [];
    for (let i = 0; i < N; i++) {
      const c = meadows[Math.floor(Math.random() * meadows.length)], cow = Math.random() < .15;
      beasts.push({ x: c[0] + rnd(-2, 2), z: c[1] + rnd(-2, 2), yaw: rnd(0, 6.3), cow, sc: cow ? 1.7 : 1, t: rnd(0, 9) });
      body.setColorAt(i, col.setHex(cow ? pick([0x8a5a2b, 0x5a3a22, 0xc9a06a]) : pick([0xf4efe2, 0xe8e0cc, 0xfaf7ee])));
    }
    [body, head, legs].forEach(x => { x.castShadow = true; scene.add(x); });
    animated.push((t, dt) => {
      beasts.forEach((b, i) => {
        b.t -= dt; if (b.t < 0) { b.t = rnd(3, 10); b.yaw += rnd(-1, 1); }       // graze, then shuffle
        if (b.t > 7) { const nx = b.x + Math.sin(b.yaw) * dt * .4, nz = b.z + Math.cos(b.yaw) * dt * .4; if (!blocked(nx, nz, true)) { b.x = nx; b.z = nz; } }
        const sc = b.sc, cy = Math.sin(b.yaw), cz = Math.cos(b.yaw), nod = Math.sin(t * 2 + i) * .08;
        q.setFromAxisAngle(up, b.yaw);
        body.setMatrixAt(i, m.compose(v.set(b.x, .75 * sc, b.z), q, s.set(.5 * sc, .42 * sc, .72 * sc)));
        head.setMatrixAt(i, m.compose(v.set(b.x + cy * .78 * sc, (.72 + nod - (b.t % 3 < 1.5 ? .25 : 0)) * sc, b.z + cz * .78 * sc), q, s.set(sc, sc, sc)));
        [[.25, .45], [-.25, .45], [.25, -.45], [-.25, -.45]].forEach(([lx, lz], k) =>
          legs.setMatrixAt(i * 4 + k, m.compose(v.set(b.x + (cz * lx + cy * lz) * sc, .25 * sc, b.z + (-cy * lx + cz * lz) * sc), q, s.set(sc, sc, sc))));
      });
      body.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = legs.instanceMatrix.needsUpdate = true;
    });
  }

  // ---------- Build the scene once ----------
  function build() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById("view3d").prepend(renderer.domElement);
    BUBBLE.el = document.getElementById("say");
    scene = new THREE.Scene(); root = scene;
    scene.fog = new THREE.Fog(PAPER, 60, 480);
    scene.background = canvasTex(256, (g, s) => { const gr = g.createLinearGradient(0, 0, 0, s);
      gr.addColorStop(0, "#b9cbd0"); gr.addColorStop(.5, "#e9dcbc"); gr.addColorStop(1, "#e9dcbc"); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
    camera = new THREE.PerspectiveCamera(70, 1, .1, 1500); camera.rotation.order = "YXZ";
    scene.add(new THREE.HemisphereLight(0xfff4dc, 0x6b7a3a, .62));
    sun = new THREE.DirectionalLight(0xfff0d0, .9); sun.position.set(80, 140, 50);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 10, far: 400 });
    sun.shadow.bias = -.0006; sun.shadow.normalBias = .4;
    scene.add(sun, sun.target);

    makeTextures();
    const lam = (o) => new THREE.MeshLambertMaterial(o);
    M = {
      stone: lam({ map: T.stone, color: 0xe6d6ae }), stoneWin: lam({ map: T.stoneWin, color: 0xe6d6ae }), stoneDark: lam({ map: T.stone, color: 0xb8a98a }),
      brick: lam({ color: 0x9c4a32 }), brickL: lam({ map: T.brick, color: 0xc77a5c }), white: lam({ map: T.stone, color: 0xfaf4e6 }), dark: lam({ color: 0x2b2118 }),
      lead: lam({ map: T.tiles, color: 0x8a959c, side: THREE.DoubleSide }), slate: lam({ map: T.tiles, color: 0x6a84a3, side: THREE.DoubleSide }),
      tile: lam({ map: T.tiles, color: 0xc0482e, side: THREE.DoubleSide }), wood: lam({ color: 0x6b4a2b }), gold: lam({ color: 0xd4a93c }),
      awningR: lam({ color: 0xb3261e, side: THREE.DoubleSide }), awningB: lam({ color: 0xefe3c4, side: THREE.DoubleSide }),
      lawn: lam({ color: 0x7fa04c }), grass: lam({ color: 0x7f9b4c }), path: lam({ color: 0xd9c8a0 }), red: lam({ color: 0xb3261e }), blue: lam({ color: 0x3f6aa0 }),
      skin: lam({ color: 0xd9a07a }), reed: lam({ color: 0x6d7d3a }),
      water: lam({ map: T.water, color: 0x7a98a2, transparent: true, opacity: .92, side: THREE.DoubleSide }),
      flag: lam({ map: T.flag, side: THREE.DoubleSide }),
      clock: lam({ map: canvasTex(64, g => { g.fillStyle = "#1c2a4a"; g.beginPath(); g.arc(32, 32, 31, 0, 7); g.fill(); g.strokeStyle = "#d4a93c"; g.lineWidth = 3;
        g.beginPath(); g.arc(32, 32, 26, 0, 7); g.moveTo(32, 32); g.lineTo(32, 12); g.moveTo(32, 32); g.lineTo(46, 36); g.stroke(); }) }),
      judge: lam({ map: canvasTex(64, (g) => { ["#e6c88e", "#b3261e", "#e6c88e", "#3f6aa0", "#e6c88e", "#c89b3c"].forEach((c, i) => { g.fillStyle = c; g.fillRect(0, i * 11, 64, 11); }); }, true) }),
    };
    PRISM = prismGeo();

    // Ground: the engraving itself, laid flat, with a speckle overlay, inside an endless meadow
    const img = new Image(); img.src = window.MAP_DATA_URL;
    const mapTex = new THREE.Texture(img); img.onload = () => { mapTex.needsUpdate = true; };
    mapTex.encoding = THREE.sRGBEncoding; mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), lam({ map: mapTex }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    T.detail.repeat.set(W / 3, H / 3);
    const detail = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: T.detail, transparent: true, opacity: .45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    detail.rotation.x = -Math.PI / 2; detail.position.y = .02; scene.add(detail);
    const meadow = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), lam({ color: 0x8aa458 }));
    meadow.rotation.x = -Math.PI / 2; meadow.position.y = -1.5; scene.add(meadow);

    // Landmarks, and room around them
    const clearR = {};
    PLACES.forEach(p => { const w = toWorld(p.x, p.y); clearR[p.id] = [w.x, w.z, CLEAR[p.id] || 42]; });
    const cleared = (X, Z) => Object.values(clearR).some(([x, z, r]) => (X - x) ** 2 + (Z - z) ** 2 < r * r);
    PLACES.forEach(p => { const w = toWorld(p.x, p.y); LANDMARKS[p.id] && LANDMARKS[p.id](w.x, w.z); label(p.short || p.name, w.x, 48, w.z); });
    buildRiver();

    // Houses and trees, one per grid cell the engraving paints red/blue/green
    const cells = [], trees = [];
    for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
      const k = G.rows[j][i]; if (k === "0") continue;
      const X = (i + .5) * CW - W / 2, Z = (j + .5) * CH - H / 2;
      if (cleared(X, Z) || inWater(X, Z, 1)) continue;
      if (k === "3") { if (Math.random() < .45) trees.push([X + rnd(-1, 1), Z + rnd(-1, 1)]); continue; }
      occ[j * G.w + i] = 1; cells.push([X, Z, k]);
    }
    buildHouses(cells);
    buildTrees(trees);

    // Streets (free cells next to houses) for townsfolk; open meadows for sheep
    const streets = [], meadows = [];
    for (let j = 2; j < G.h - 2; j++) for (let i = 2; i < G.w - 2; i++) {
      if (occ[j * G.w + i]) continue;
      const X = (i + .5) * CW - W / 2, Z = (j + .5) * CH - H / 2;
      if (blocked(X, Z, true) || inDecor(X, Z)) continue;
      let near = 0; for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) near += occ[(j + b) * G.w + i + a];
      if (near >= 2 && near < 25) streets.push([X, Z]);
      else if (!near && G.rows[j][i] === "0") meadows.push([X, Z]);
    }
    buildPeople(streets);
    buildBeasts(meadows);
    buildClouds();

    scene.traverse(o => { if (o.isMesh && o !== ground && o.material !== M.water) { o.castShadow = true; o.receiveShadow = true; } });
    detail.castShadow = detail.receiveShadow = false; meadow.castShadow = false;

    bindControls();
    addEventListener("resize", resize); resize();
    built = true;
  }

  function buildHouses(cells) {
    const lam = o => new THREE.MeshLambertMaterial(o);
    const n = cells.length, geo = houseBox();
    const groundM = new THREE.InstancedMesh(geo, lam({ map: T.ground }), n);
    const uppers = [lam({ map: T.timber }), lam({ map: T.plaster }), lam({ map: T.brick })].map(mat => ({ mat, list: [] }));
    const roofs = new THREE.InstancedMesh(PRISM, lam({ map: T.tiles, side: THREE.DoubleSide }), n);
    const chim = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lam({ color: 0x8e4a34 }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), v = new THREE.Vector3(), s = new THREE.Vector3();
    const WALLC = [0xfff3da, 0xf3e2bd, 0xe8d3a8, 0xfaf0dc], PLASTER = [0xf7e7c4, 0xf2d7a0, 0xeec3a8, 0xf5efe0, 0xdfe3d0], BRICK = [0xd98a6a, 0xc77a5c, 0xe09a78];
    const ROOFC = [0xb3261e, 0xa8401f, 0x9a2f1c, 0xc0502c, 0x8e3a22];
    let nc = 0;
    cells.forEach(([X, Z, k], i) => {
      const g = 3.1, h = k === "2" ? rnd(8, 12) : rnd(5.5, 9), sx = CW * .97, sz = CH * .97, turn = Math.random() < .5;
      groundM.setMatrixAt(i, m4.compose(v.set(X, g / 2, Z), q.identity(), s.set(sx, g, sz)));
      groundM.setColorAt(i, col.setHex(pick(WALLC)));
      const kind = k === "2" ? 2 : Math.random() < .6 ? 0 : Math.random() < .7 ? 1 : 2;
      const jx = rnd(1.03, 1.1), jz = rnd(1.03, 1.1);        // jettied upper storey overhangs the street
      uppers[kind].list.push([X, g + (h - g) / 2, Z, sx * jx, h - g, sz * jz, pick(kind === 0 ? WALLC : kind === 1 ? PLASTER : BRICK)]);
      q.setFromAxisAngle(up, turn ? Math.PI / 2 : 0);
      const rh = rnd(2.8, 4.5);
      roofs.setMatrixAt(i, m4.compose(v.set(X, h, Z), q, s.set((turn ? sz : sx) * 1.18, rh, (turn ? sx : sz) * 1.18)));
      roofs.setColorAt(i, col.setHex(k === "2" ? 0x6a84a3 : pick(ROOFC)));
      if (Math.random() < .55) { chim.setMatrixAt(nc++, m4.compose(v.set(X + (turn ? 0 : sx * .28), h + rh * .6, Z + (turn ? sz * .28 : 0)), q.identity(), s.set(.8, rh * .9, .8))); }
    });
    chim.count = nc;
    scene.add(groundM, roofs, chim);
    uppers.forEach(({ mat, list }) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, y, z, w, h, d, c], i) => { im.setMatrixAt(i, m4.compose(v.set(x, y, z), q.identity(), s.set(w, h, d))); im.setColorAt(i, col.setHex(c)); });
      scene.add(im);
    });
  }

  function buildTrees(trees) {
    const lam = o => new THREE.MeshLambertMaterial(o);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), lam({ color: 0xffffff, flatShading: true }), trees.length * 2);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.22, .38, 1, 6), M.wood, trees.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), v = new THREE.Vector3(), s = new THREE.Vector3();
    trees.forEach(([X, Z], n) => {
      const sc = rnd(2, 3.4), th = rnd(2.2, 3.4);
      crowns.setMatrixAt(n * 2, m4.compose(v.set(X, th + sc * .8, Z), q.setFromAxisAngle(up, rnd(0, 6)), s.set(sc, sc * 1.1, sc)));
      crowns.setMatrixAt(n * 2 + 1, m4.compose(v.set(X + rnd(-.8, .8), th + sc * 1.6, Z + rnd(-.8, .8)), q.setFromAxisAngle(up, rnd(0, 6)), s.set(sc * .7, sc * .7, sc * .7)));
      const c = pick([0x55702f, 0x4a6429, 0x667d36, 0x5e7a2c]);
      crowns.setColorAt(n * 2, col.setHex(c)); crowns.setColorAt(n * 2 + 1, col.setHex(c).offsetHSL(0, 0, .05));
      trunks.setMatrixAt(n, m4.compose(v.set(X, th / 2, Z), q.identity(), s.set(1, th, 1)));
    });
    scene.add(crowns, trunks);
  }

  function buildClouds() {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9a9a90, flatShading: true, fog: false, transparent: true, opacity: .92 });
    const geo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 26; i++) {
      const c = new THREE.Group(); c.position.set(rnd(-900, 900), rnd(140, 220), rnd(-900, 900));
      for (let k = 0; k < 6; k++) { const p = new THREE.Mesh(geo, mat); p.position.set(rnd(-25, 25), rnd(-4, 5), rnd(-10, 10)); p.scale.set(rnd(12, 22), rnd(7, 11), rnd(10, 16)); c.add(p); }
      scene.add(c);
      animated.push((t, dt) => { c.position.x += dt * 3; if (c.position.x > 1000) c.position.x = -1000; });
    }
    // a few rooks circling the towers
    const birdGeo = new THREE.BufferGeometry(); birdGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, .4, 1, 0, 0], 3));
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2a2320, side: THREE.DoubleSide });
    const kc = toWorld(byIdPlace("kings").x, byIdPlace("kings").y);
    for (let i = 0; i < 12; i++) {
      const b = new THREE.Mesh(birdGeo, birdMat), r = rnd(20, 60), h = rnd(40, 70), sp = rnd(.2, .4), ph = rnd(0, 6);
      scene.add(b);
      animated.push(t => { const a = t * sp + ph; b.position.set(kc.x + Math.cos(a) * r, h + Math.sin(t * 2 + ph) * 2, kc.z + Math.sin(a) * r);
        b.rotation.y = -a; b.scale.set(1, 1 + Math.sin(t * 12 + ph) * .8, 1); });
    }
  }
  const byIdPlace = id => PLACES.find(p => p.id === id);

  // ---------- Movement & collisions ----------
  function blocked(X, Z, npc) {
    if (Math.abs(X) > W * .465 || Math.abs(Z) > H * .455) return true;
    const [i, j] = cellOf(X, Z);
    if (occ[j * G.w + i]) return true;
    if (inWater(X, Z) && !onBridge(X, Z)) return true;
    return colliders.some(c => X > c[0] - .5 && X < c[1] + .5 && Z > c[2] - .5 && Z < c[3] + .5);
  }
  const R = .8;                                           // the visitor's shoulders — keeps the camera off the walls
  const blockedR = (X, Z) => blocked(X, Z) || blocked(X + R, Z) || blocked(X - R, Z) || blocked(X, Z + R) || blocked(X, Z - R);
  function freeSpot(X, Z) {                               // nearest walkable point (spiral search)
    for (let r = 0; r < 120; r += 2) for (let a = 0; a < 16; a++) {
      const x = X + Math.cos(a / 16 * Math.PI * 2) * r, z = Z + Math.sin(a / 16 * Math.PI * 2) * r;
      if (!blockedR(x, z)) return { x, z };
    }
    return { x: X, z: Z };
  }
  function move(dx, dz) {                                 // slide along walls: try each axis separately
    let moved = false;
    if (!blockedR(player.x + dx, player.z)) { player.x += dx; moved = true; }
    if (!blockedR(player.x, player.z + dz)) { player.z += dz; moved = true; }
    return moved;
  }

  function bindControls() {
    const el = renderer.domElement;
    let drag = null;
    el.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy);
      player.yaw -= dx * .005; player.pitch = Math.max(-1.2, Math.min(1.2, player.pitch - dy * .004));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    el.addEventListener("pointerup", e => {                // a click (not a drag) walks to the spot on the ground
      if (drag && drag.moved < 6) {
        const r = el.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, camera);
        const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
        if (hit && hit.distanceTo(camera.position) < 400) target = { x: hit.x, z: hit.z };
      }
      drag = null;
    });
    addEventListener("keydown", e => { if (!active) return; keys[e.code] = true; if (e.code === "Escape") exit(); if (e.code.startsWith("Arrow")) e.preventDefault(); });
    addEventListener("keyup", e => { keys[e.code] = false; });
    document.querySelectorAll("#pad button").forEach(b => {
      const k = b.dataset.k;
      b.addEventListener("pointerdown", e => { e.preventDefault(); keys[k] = true; });
      ["pointerup", "pointerleave", "pointercancel"].forEach(ev => b.addEventListener(ev, () => { keys[k] = false; }));
    });
    document.getElementById("exit3d").onclick = exit;
  }

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function tick(now) {
    if (!active) return;
    requestAnimationFrame(tick);
    const dt = Math.min(.05, (now - last) / 1000 || 0); last = now;
    const t = now / 1000;
    const speed = (keys.ShiftLeft || keys.ShiftRight ? RUN : WALK) * dt;
    if (keys.ArrowLeft || keys.KeyQ) player.yaw += 1.8 * dt;
    if (keys.ArrowRight || keys.KeyE) player.yaw -= 1.8 * dt;
    const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    let walking = false;
    if (f || s) { target = null; walking = move((-sin * f + cos * s) * speed, (-cos * f - sin * s) * speed); }
    else if (target) {
      const dx = target.x - player.x, dz = target.z - player.z, d = Math.hypot(dx, dz);
      if (d < .6) target = null;
      else {
        const want = Math.atan2(-dx, -dz); let diff = want - player.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); player.yaw += diff * Math.min(1, dt * 6);
        walking = move(dx / d * Math.min(d, speed), dz / d * Math.min(d, speed));
        if (!walking) target = null;
      }
    }
    if (walking) player.bob += dt * 10;
    animated.forEach(fn => fn(t, dt));

    // camera: swoop down from the sky on entry, then walk at eye height
    intro = Math.min(1, (now - introStart) / 1800);
    const e = 1 - Math.pow(1 - intro, 3);
    camera.position.set(player.x, EYE + Math.sin(player.bob) * .06 + (1 - e) * 160, player.z + (1 - e) * 90);
    camera.rotation.set(player.pitch * e - (1 - e) * 1.05, player.yaw, 0);
    sun.position.set(player.x + 80, 140, player.z + 50); sun.target.position.set(player.x, 0, player.z);   // shadows follow you
    renderer.render(scene, camera);

    // minimap + nearby place card
    const p = toPct(player.x, player.z);
    const dot = document.getElementById("miniDot");
    dot.style.left = p.x + "%"; dot.style.top = p.y + "%"; dot.style.transform = `translate(-50%,-50%) rotate(${-player.yaw}rad)`;
    let best = null, bd = Infinity;                       // "near" = within a landmark's clearing + 25 m
    PLACES.forEach(pl => { const w = toWorld(pl.x, pl.y), d = Math.hypot(w.x - player.x, w.z - player.z) - (CLEAR[pl.id] || 42) - 25; if (d < 0 && d < bd) { bd = d; best = pl; } });
    if ((best && best.id) !== nearId) { nearId = best && best.id; best ? openCard(best) : closeCard(); }
  }

  function enter(xPct, yPct, place) {
    if (!built) build();
    const w = toWorld(xPct, yPct);
    if (place) {                                          // stand back from the landmark and look at it
      const away = Math.atan2(w.z + 1, w.x + 1);
      const r = (CLEAR[place.id] || 42) + 12;
      const spot = freeSpot(w.x + Math.cos(away) * r, w.z + Math.sin(away) * r);
      player.x = spot.x; player.z = spot.z;
      player.yaw = Math.atan2(-(w.x - spot.x), -(w.z - spot.z)); player.pitch = .12;
    } else {
      const spot = freeSpot(w.x, w.z); player.x = spot.x; player.z = spot.z;
      const c = toWorld(60, 50); player.yaw = Math.atan2(-(c.x - spot.x), -(c.z - spot.z)); player.pitch = 0;
    }
    target = null; nearId = null;
    if (!active) {
      intro = 0; introStart = performance.now(); active = true;
      document.body.classList.add("in3d");
      last = performance.now(); requestAnimationFrame(tick);
    }
  }
  function exit() {
    if (!active) return;
    active = false; document.body.classList.remove("in3d");
    Object.keys(keys).forEach(k => keys[k] = false);
    closeCard();
    const p = toPct(player.x, player.z); onExit(p.x, p.y);
  }

  return { enter, exit, set onExit(fn) { onExit = fn; }, get active() { return active; }, get debug() { return { player, intro, people: PEOPLE }; } };
})();
