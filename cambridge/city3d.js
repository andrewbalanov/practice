// 3D walk through Cambridge, 1575. Houses are raised from the engraving itself (MAP_GRID from map-data.js),
// landmarks are hand-built from boxes, cylinders and cones. Needs THREE (r128) and PLACES from index.html.
window.City3D = (function () {
  const W = 1200, H = W * 1427 / 1920;                 // world size; 1 unit ≈ 1 metre
  const G = window.MAP_GRID, CW = W / G.w, CH = H / G.h;
  const EYE = 1.7, WALK = 9, RUN = 22;
  const PAPER = 0xe9dcbc;

  let renderer, scene, camera, root, built = false, active = false, onExit = () => {};
  const occ = new Uint8Array(G.w * G.h);               // 1 = a house stands in this cell
  const colliders = [];                                 // landmark walls: [minX, maxX, minZ, maxZ]
  const player = { x: 0, z: 0, yaw: 0, pitch: 0, bob: 0 };
  let target = null, intro = 0, introStart = 0, nearId = null, last = 0;
  const keys = {};

  const toWorld = (x, y) => ({ x: (x / 100 - 0.5) * W, z: (y / 100 - 0.5) * H });
  const toPct = (X, Z) => ({ x: (X / W + 0.5) * 100, y: (Z / H + 0.5) * 100 });
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------- Hand-drawn canvas textures ----------
  function canvasTex(size, draw, repeat) {
    const c = document.createElement("canvas"); c.width = c.height = size;
    draw(c.getContext("2d"), size);
    const t = new THREE.CanvasTexture(c);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  const timberTex = () => canvasTex(128, (g, s) => {       // Tudor timber framing with two windows
    g.fillStyle = "#fff6e2"; g.fillRect(0, 0, s, s);
    g.strokeStyle = "#5a3a22"; g.lineWidth = 7;
    g.strokeRect(3, 3, s - 6, s - 6);
    g.beginPath(); g.moveTo(0, 64); g.lineTo(s, 64); g.moveTo(64, 0); g.lineTo(64, s);
    g.moveTo(0, 128); g.lineTo(40, 64); g.moveTo(128, 128); g.lineTo(88, 64); g.stroke();
    g.fillStyle = "#2c2118";
    [[18, 16], [82, 16], [18, 80], [82, 80]].forEach(([x, y], i) => { if (i < 2 || Math.random() < .5) g.fillRect(x, y, 28, 30); });
    g.strokeStyle = "#c9a96a"; g.lineWidth = 2;
    [[18, 16], [82, 16]].forEach(([x, y]) => { g.beginPath(); g.moveTo(x + 14, y); g.lineTo(x + 14, y + 30); g.moveTo(x, y + 15); g.lineTo(x + 28, y + 15); g.stroke(); });
  });
  const tileTex = () => canvasTex(64, (g, s) => {           // roof tiles
    g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
    g.strokeStyle = "rgba(60,20,10,.45)"; g.lineWidth = 2;
    for (let y = 0; y < s; y += 8) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
      for (let x = (y / 8) % 2 ? 0 : 5; x < s; x += 10) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 8); g.stroke(); }
    }
  }, true);
  const stoneTex = (windows) => canvasTex(128, (g, s) => {  // ashlar blocks, optionally a gothic window
    g.fillStyle = "#fff"; g.fillRect(0, 0, s, s);
    g.strokeStyle = "rgba(80,60,40,.35)"; g.lineWidth = 2;
    for (let y = 0; y < s; y += 16) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
      for (let x = (y / 16) % 2 ? 0 : 16; x < s; x += 32) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 16); g.stroke(); }
    }
    if (windows) {
      g.fillStyle = "#2b2a33";
      g.beginPath(); g.moveTo(40, 118); g.lineTo(40, 44); g.quadraticCurveTo(40, 14, 64, 8); g.quadraticCurveTo(88, 14, 88, 44); g.lineTo(88, 118); g.fill();
      g.strokeStyle = "#d9c9a3"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(64, 14); g.lineTo(64, 118); g.moveTo(40, 60); g.lineTo(88, 60); g.moveTo(40, 90); g.lineTo(88, 90); g.stroke();
    }
  }, true);

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
    if (spire) { const s = new THREE.Mesh(new THREE.ConeGeometry(r * 1.1, spire, sides), spireMat); s.position.set(x, y + h + spire / 2, z); root.add(s); }
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
  function gatehouse(x, z, mat, h = 20) {                // square gate tower with four corner turrets
    box(13, h, 11, x, 0, z, mat, 8, false);
    box(5, 7, 11.2, x, 0, z, M.dark, 8, false);             // the archway — walk through it
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
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(w - t, d - t), M.lawn);
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(cx, .06, cz); root.add(lawn);
    // leave the court enterable: remove the collider of the front range, add two halves around the gate
    const front = colliders.findIndex(c => c[2] === cz + d / 2 - t / 2 && c[0] === cx - w / 2);
    if (front >= 0) colliders.splice(front, 1, [cx - w / 2, cx - 4, cz + d / 2 - t / 2, cz + d / 2 + t / 2], [cx + 4, cx + w / 2, cz + d / 2 - t / 2, cz + d / 2 + t / 2]);
    gatehouse(cx, cz + d / 2, wall);
  }
  function church(cx, cz, len, wid, h, mat, roofMat, towerH) {
    box(len, h, wid, cx, 0, cz, mat, 10); gable(len, h * .45, wid + 1, cx, h, cz, roofMat);
    if (towerH) {
      const tx = cx - len / 2 - 5;
      box(10, towerH, 10, tx, 0, cz, mat, 10); crenels(10, 10, tx, towerH, cz, mat);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(.9, 6, tx + i * 4.5, cz + j * 4.5, mat, { y: towerH, sides: 6, spire: 3 }));
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
      quad(x - 10, z + 48, 60, 50, M.stone, M.lead, 10);
    },
    trinity(x, z) { quad(x, z, 80, 76, M.stoneWin, M.slate, 12);
      tower(3, 4, x, z, M.stone, { sides: 8 }); tower(3.4, 2.5, x, z, M.stone, { y: 4, sides: 8, spire: 5, spireMat: M.lead }); // the fountain
      church(x - 10, z - 55, 44, 13, 14, M.stoneWin, M.lead); },
    johns(x, z) { quad(x, z, 58, 50, M.brick, M.tile, 12); church(x + 5, z - 40, 34, 12, 14, M.stoneWin, M.lead, 26); },
    queens(x, z) { quad(x, z, 48, 44, M.brick, M.tile); },
    corpus(x, z) { quad(x, z, 42, 40, M.stone, M.tile, 10); church(x - 34, z, 22, 10, 10, M.stone, M.tile, 22); },
    peter(x, z) { quad(x, z, 44, 38, M.stone, M.tile); church(x, z - 34, 20, 10, 12, M.stoneWin, M.lead); },
    christs(x, z) { quad(x, z, 48, 46, M.stone, M.slate); },
    jesus(x, z) { quad(x, z, 46, 46, M.brick, M.tile); church(x + 8, z - 40, 36, 12, 14, M.stoneWin, M.lead, 30); },
    magdalene(x, z) { quad(x, z, 38, 34, M.brick, M.tile, 10); },
    round(x, z) {                                        // the Round Church: drum, clerestory, conical roof
      tower(9, 9, x, z, M.stone, { sides: 16 });
      tower(5.5, 5, x, z, M.stone, { y: 9, sides: 16, spire: 5, spireMat: M.lead });
      box(12, 8, 9, x + 13, 0, z, M.stone); gable(12, 4, 10, x + 13, 8, z, M.tile);
    },
    senate(x, z) { church(x + 4, z, 42, 16, 15, M.stoneWin, M.lead, 36);
      box(34, 14, 14, x, 0, z + 28, M.white, 6);           // Senate House (well, it's 1730 — the map is dreaming)
      for (let i = -15; i <= 15; i += 5) tower(.8, 12, x + i, z + 36, M.white, { sides: 10 });
      gable(34, 4, 15, x, 14, z + 28, M.white); },
    market(x, z) {                                       // stalls with striped awnings round a market cross
      tower(1.2, 7, x, z, M.stone, { sides: 8, spire: 3, spireMat: M.stone }); tower(3, 1.5, x, z, M.stone, { sides: 8 });
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2, r = 18 + (i % 2) * 6, sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
        box(4, 1.2, 3, sx, 0, sz, M.wood, 4);
        const aw = new THREE.Mesh(PRISM, i % 3 ? M.awningR : M.awningB);
        aw.position.set(sx, 3, sz); aw.scale.set(5, 1.4, 4); aw.rotation.y = -a; root.add(aw);
        [[-2, -1.4], [2, 1.4]].forEach(([dx, dz]) => tower(.12, 3, sx + dx * Math.cos(a), sz + dz, M.wood, { sides: 4 }));
      }
    },
    castle(x, z) {                                       // Norman castle: keep on a motte, curtain wall, round towers
      const motte = new THREE.Mesh(new THREE.CylinderGeometry(16, 34, 12, 20), M.grass);
      motte.position.set(x, 6, z); root.add(motte); colliders.push([x - 26, x + 26, z - 26, z + 26]);
      box(18, 18, 18, x, 12, z, M.stoneDark, 6); crenels(18, 18, x, 30, z, M.stoneDark);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([i, j]) => tower(2.2, 22, x + i * 9, z + j * 9, M.stoneDark, { y: 12, crenel: true }));
      const R = 55, n = 7;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
        const ax = x + Math.cos(a) * R, az = z + Math.sin(a) * R, bx = x + Math.cos(b) * R, bz = z + Math.sin(b) * R;
        tower(5, 17, ax, az, M.stoneDark, { crenel: true });
        if (i === 2) continue;                           // a gap for the gate
        const len = Math.hypot(bx - ax, bz - az), wall = new THREE.Mesh(tiledBox(len, 11, 3, 6), M.stoneDark);
        wall.position.set((ax + bx) / 2, 5.5, (az + bz) / 2); wall.rotation.y = -Math.atan2(bz - az, bx - ax); root.add(wall);
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

  // ---------- Build the scene once ----------
  function build() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    document.getElementById("view3d").prepend(renderer.domElement);
    scene = new THREE.Scene(); root = scene;
    scene.fog = new THREE.Fog(PAPER, 50, 460);
    scene.background = canvasTex(256, (g, s) => { const gr = g.createLinearGradient(0, 0, 0, s);
      gr.addColorStop(0, "#c9d3cf"); gr.addColorStop(.5, "#e9dcbc"); gr.addColorStop(1, "#e9dcbc"); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
    camera = new THREE.PerspectiveCamera(70, 1, .1, 1500); camera.rotation.order = "YXZ";
    scene.add(new THREE.HemisphereLight(0xfff4dc, 0x6b7a3a, .75));
    const sun = new THREE.DirectionalLight(0xfff0d0, .75); sun.position.set(.8, 1.4, .5); scene.add(sun);

    const lam = (o) => new THREE.MeshLambertMaterial(o);
    const tiles = tileTex(), stone = stoneTex(false), stoneW = stoneTex(true);
    M = {
      stone: lam({ map: stone, color: 0xe6d6ae }), stoneWin: lam({ map: stoneW, color: 0xe6d6ae }), stoneDark: lam({ map: stone, color: 0xb8a98a }),
      brick: lam({ map: stoneW, color: 0xc4745a }), white: lam({ color: 0xf6efe0 }), dark: lam({ color: 0x2b2118 }),
      lead: lam({ map: tiles, color: 0x7f8c95, side: THREE.DoubleSide }), slate: lam({ map: tiles, color: 0x5d7899, side: THREE.DoubleSide }),
      tile: lam({ map: tiles, color: 0xb3402a, side: THREE.DoubleSide }), wood: lam({ color: 0x6b4a2b }),
      awningR: lam({ color: 0xb3261e, side: THREE.DoubleSide }), awningB: lam({ color: 0xe9dcbc, side: THREE.DoubleSide }),
      lawn: lam({ color: 0x86a653 }), grass: lam({ color: 0x7f9b4c }), red: lam({ color: 0xb3261e }), blue: lam({ color: 0x3f6aa0 }),
      judge: lam({ map: canvasTex(64, (g) => { ["#e6c88e", "#b3261e", "#e6c88e", "#3f6aa0", "#e6c88e", "#c89b3c"].forEach((c, i) => { g.fillStyle = c; g.fillRect(0, i * 11, 64, 11); }); }, true) }),
    };
    PRISM = prismGeo();

    // Ground: the engraving itself, laid flat, inside an endless meadow
    const img = new Image(); img.src = window.MAP_DATA_URL;
    const mapTex = new THREE.Texture(img); img.onload = () => { mapTex.needsUpdate = true; };
    mapTex.encoding = THREE.sRGBEncoding; mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H), lam({ map: mapTex }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground); ground.name = "ground";
    const meadow = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), lam({ color: 0x8aa458 }));
    meadow.rotation.x = -Math.PI / 2; meadow.position.y = -1.5; scene.add(meadow);

    // Landmarks, and room around them
    const clearR = {};
    PLACES.forEach(p => { const w = toWorld(p.x, p.y); clearR[p.id] = [w.x, w.z, CLEAR[p.id] || 42]; });
    const cleared = (X, Z) => Object.values(clearR).some(([x, z, r]) => (X - x) ** 2 + (Z - z) ** 2 < r * r);
    PLACES.forEach(p => { const w = toWorld(p.x, p.y); LANDMARKS[p.id] && LANDMARKS[p.id](w.x, w.z); label(p.short || p.name, w.x, 48, w.z); });

    // Houses and trees, one per grid cell the engraving paints red/blue/green
    const cells = [], trees = [];
    for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
      const k = G.rows[j][i]; if (k === "0") continue;
      const X = (i + .5) * CW - W / 2, Z = (j + .5) * CH - H / 2;
      if (cleared(X, Z)) continue;
      if (k === "3") { if (Math.random() < .4) trees.push([X + rnd(-1, 1), Z + rnd(-1, 1)]); continue; }
      occ[j * G.w + i] = 1; cells.push([X, Z, k]);
    }
    const wallMat = lam({ map: timberTex() }), roofMat = lam({ map: tiles, side: THREE.DoubleSide });
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wallMat, cells.length);
    const roofs = new THREE.InstancedMesh(PRISM, roofMat, cells.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    const WALLC = [0xfff3da, 0xf3e2bd, 0xe8d3a8, 0xfaf0dc], ROOFC = [0xb3261e, 0xa8401f, 0x9a2f1c, 0xc0502c];
    cells.forEach(([X, Z, k], n) => {
      const h = k === "2" ? rnd(8, 12) : rnd(4.5, 8.5), sx = CW * .98, sz = CH * .98, turn = Math.random() < .5;
      walls.setMatrixAt(n, m4.compose(new THREE.Vector3(X, h / 2, Z), q.identity(), new THREE.Vector3(sx, h, sz)));
      walls.setColorAt(n, col.setHex(WALLC[n % 4]));
      q.setFromAxisAngle(up, turn ? Math.PI / 2 : 0);
      roofs.setMatrixAt(n, m4.compose(new THREE.Vector3(X, h, Z), q, new THREE.Vector3((turn ? sz : sx) * 1.12, rnd(2.5, 4), (turn ? sx : sz) * 1.12)));
      roofs.setColorAt(n, col.setHex(k === "2" ? 0x5d7899 : ROOFC[(n * 7) % 4]));
    });
    scene.add(walls, roofs);

    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), lam({ color: 0x55702f, flatShading: true }), trees.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.25, .35, 1, 5), M.wood, trees.length);
    trees.forEach(([X, Z], n) => {
      const s = rnd(2.2, 3.6);
      crowns.setMatrixAt(n, m4.compose(new THREE.Vector3(X, s + 2.4, Z), q.setFromAxisAngle(up, rnd(0, 6)), new THREE.Vector3(s, s * 1.15, s)));
      crowns.setColorAt(n, col.setHex([0x55702f, 0x4a6429, 0x667d36][n % 3]));
      trunks.setMatrixAt(n, m4.compose(new THREE.Vector3(X, 1.5, Z), q.identity(), new THREE.Vector3(1, 3, 1)));
    });
    scene.add(crowns, trunks);

    bindControls();
    addEventListener("resize", resize); resize();
    built = true;
  }

  // ---------- Movement & collisions ----------
  function blocked(X, Z) {
    if (Math.abs(X) > W * .465 || Math.abs(Z) > H * .455) return true;
    const i = Math.floor((X + W / 2) / CW), j = Math.floor((Z + H / 2) / CH);
    if (occ[j * G.w + i]) return true;
    return colliders.some(c => X > c[0] - .5 && X < c[1] + .5 && Z > c[2] - .5 && Z < c[3] + .5);
  }
  function freeSpot(X, Z) {                               // nearest walkable point (spiral search)
    for (let r = 0; r < 120; r += 2) for (let a = 0; a < 16; a++) {
      const x = X + Math.cos(a / 16 * Math.PI * 2) * r, z = Z + Math.sin(a / 16 * Math.PI * 2) * r;
      if (!blocked(x, z)) return { x, z };
    }
    return { x: X, z: Z };
  }
  function move(dx, dz) {                                 // slide along walls: try each axis separately
    let moved = false;
    if (!blocked(player.x + dx, player.z)) { player.x += dx; moved = true; }
    if (!blocked(player.x, player.z + dz)) { player.z += dz; moved = true; }
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
        const hit = ray.ray.intersectPlane(new THREE.Plane(up0, 0), new THREE.Vector3());
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
  const up0 = new THREE.Vector3(0, 1, 0);

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function tick(now) {
    if (!active) return;
    requestAnimationFrame(tick);
    const dt = Math.min(.05, (now - last) / 1000 || 0); last = now;
    const speed = (keys.ShiftLeft || keys.ShiftRight ? RUN : WALK) * dt;
    if (keys.ArrowLeft || keys.KeyQ) player.yaw += 1.8 * dt;
    if (keys.ArrowRight || keys.KeyE) player.yaw -= 1.8 * dt;
    let f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
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

    // camera: swoop down from the sky on entry, then walk at eye height
    intro = Math.min(1, (now - introStart) / 1800);
    const e = 1 - Math.pow(1 - intro, 3);
    camera.position.set(player.x, EYE + Math.sin(player.bob) * .06 + (1 - e) * 160, player.z + (1 - e) * 90);
    camera.rotation.set(player.pitch * e - (1 - e) * 1.05, player.yaw, 0);
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
    const first = !built;
    if (first) build();
    let w = toWorld(xPct, yPct);
    if (place) {                                          // stand back from the landmark and look at it
      const c = { x: 0, z: 0 }, away = Math.atan2(w.z - c.z + 1, w.x - c.x + 1);
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

  return { enter, exit, set onExit(fn) { onExit = fn; }, get active() { return active; }, get debug() { return { player, intro }; } };
})();
