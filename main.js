/* Le Dernier Jardin — moteur de scène
 * Un seul shader plein écran rend tout : image de fond, ouverture organique,
 * bulles réfractantes (ambiantes + curseur), bulle-portail entre les deux mondes,
 * transition par vague, étalonnage de profondeur.
 * GSAP/ScrollTrigger pilotent l'objet d'état S ; la boucle de rendu le lit.
 */
(() => {
  gsap.registerPlugin(ScrollTrigger);

  const isTouch = matchMedia("(hover: none)").matches;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Position des poissons dans chaque image (uv texture, y vers le haut)
  const FISH_1 = [0.45, 0.48];
  const FISH_2 = [0.405, 0.46];

  // ---------- état piloté par le scroll ----------
  const S = {
    reveal: 0.012,
    zoom: 2.5,
    panX: FISH_1[0] - 0.5,
    panY: FISH_1[1] - 0.5,
    mix: 0,
    depth: 0,
    light: 0,
    shade: 0,
    bubbles: 0,
    portalX: 0.5,
    portalY: -0.35,
    portalR: 0,
    portalK: 1.9,
    portalZoom: 1.8,
    meters: 0,
    liquid: 0,
  };

  // =====================================================================
  //  WebGL
  // =====================================================================
  const canvas = document.getElementById("gl");
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false });

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main(){ vUv = aPos*.5+.5; gl_Position = vec4(aPos,0.,1.); }
  `;

  const N_BUB = 10;
  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex0, uTex1;
    uniform vec2 uRes;
    uniform float uTime, uReveal, uMix, uZoom, uDepth, uLight, uShade, uWobble;
    uniform vec2 uPan;
    uniform vec2 uImgA;        // ratio largeur/hauteur de chaque image
    uniform vec4 uPortal;     // xy centre (espace st), z rayon, w force
    uniform float uPortalZoom;
    uniform vec4 uMouse;       // xy, rayon, force
    uniform vec4 uBub[${N_BUB}];

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
    }

    // cadrage « cover » : l'image (ratio ia) remplit l'écran sans déformation
    vec2 cover(vec2 uv, float zoom, float ia){
      float a = uRes.x/uRes.y;
      vec2 s = a>ia ? vec2(1., ia/a) : vec2(a/ia, 1.);
      return (uv-.5)*s/zoom + .5 + uPan;
    }

    // ondulation de l'eau, amplifiée par la vitesse de scroll
    vec2 water(vec2 uv){
      float w = .0022*(1.+uWobble*2.5);
      return uv + vec2(sin(uv.y*22.+uTime*.9), cos(uv.x*17.+uTime*.7))*w;
    }

    vec3 tex0(vec2 uv, float b){ return texture2D(uTex0, uv, b).rgb; }
    vec3 tex1(vec2 uv, float b){ return texture2D(uTex1, uv, b).rgb; }

    // scène de base : deux mondes séparés par une vague
    vec3 scene(vec2 uv, float b){
      vec2 iu0 = water(cover(uv, uZoom, uImgA.x));
      vec2 iu1 = water(cover(uv, uZoom, uImgA.y));
      if(uMix < .001) return tex0(iu0, b);
      if(uMix > .999) return tex1(iu1, b);
      float wave = sin(uv.x*9.+uTime*1.3)*.035 + (noise(uv*vec2(5.,3.)+uTime*.25)-.5)*.22;
      float f = uv.y*.85 + .08 + wave;
      float k = smoothstep(f-.12, f+.12, uMix*1.7-.35);
      float band = 1.-abs(k*2.-1.);
      vec2 d = vec2(sin(uv.y*40.+uTime*3.)*.01, .07)*band;
      return mix(tex0(iu0+d, b+band*2.), tex1(iu1-d, b+band*2.), k);
    }

    void lens(vec2 st, vec3 bb, float k, inout vec2 off, inout float rim, inout float spec, inout float ca, inout float ang){
      vec2 d = (st-bb.xy)/bb.z; float l = length(d);
      float aa = 1.5/(bb.z*uRes.y);
      float m = smoothstep(1., 1.-aa, l);
      if(m <= 0.) return;
      float z = sqrt(max(1.-l*l, 0.));
      off += -d*(1.-z)*k*bb.z*vec2(uRes.y/uRes.x, 1.)*m;
      rim = max(rim, pow(1.-z, 1.7)*m);
      spec = max(spec, (smoothstep(.32,.0,length(d-vec2(-.38,.42))) + .4*smoothstep(.13,.0,length(d-vec2(.46,-.34))))*m);
      ca += (1.-z)*m;
      ang = atan(d.y, d.x);
    }

    void main(){
      vec2 uv = vUv;
      float a = uRes.x/uRes.y;
      vec2 st = vec2(uv.x*a, uv.y);
      float bias = uDepth*2.2;

      // --- ouverture organique (prologue) : forme calculée en premier, elle sert aussi de lentille ---
      vec2 rd = st - vec2(.5*a, .5);
      float ra = atan(rd.y, rd.x);
      // bruit échantillonné sur un cercle : continu sur 360° (pas de couture à ±π)
      vec2 ring = vec2(cos(ra), sin(ra))*1.6;
      float wob = (noise(ring + vec2(uTime*.35, uTime*.25))-.5)*.35 + sin(ra*3.+uTime*.8)*.06;
      float pulse = 1. + .18*sin(uTime*2.2)*(1.-smoothstep(.0,.1,uReveal));
      float R = uReveal*length(vec2(a,1.))*.62*(1.+wob*(1.-uReveal))*pulse;
      float rl = length(rd);
      float rm = smoothstep(R+.003, R-.003, rl);

      // --- bulles ambiantes + bulle-curseur ---
      vec2 off = vec2(0.); float rim=0., spec=0., ca=0., ang=0.;
      for(int i=0;i<${N_BUB};i++){
        if(uBub[i].z > .0005) lens(st, uBub[i].xyz, uBub[i].w, off, rim, spec, ca, ang);
      }
      if(uMouse.z > .001) lens(st, uMouse.xyz, uMouse.w, off, rim, spec, ca, ang);

      // --- goutte-lentille : l'ouverture bombe l'image (fisheye + franges colorées),
      //     masque l'agrandissement du zoom initial et s'efface avant le titre ---
      float dropK = 1. - smoothstep(.2, .85, uReveal);
      float cs = .12;
      if(dropK > 0. && rm > 0.){
        vec2 dd = rd/max(R, 1e-4); float dl = min(length(dd), 1.);
        float dz = sqrt(max(1.-dl*dl, 0.));
        off += -dd*(1.-dz)*.9*dropK*R*vec2(1./a, 1.);
        cs += .35*dropK*dl;
        rim = max(rim, pow(1.-dz, 3.5)*dropK*.7);
        spec = max(spec, (smoothstep(.38,.0,length(dd-vec2(-.42,.46))) + .4*smoothstep(.14,.0,length(dd-vec2(.5,-.4))))*dropK*.55);
        ang = atan(dd.y, dd.x);
      }

      // aberration chromatique : chaque canal se réfracte un peu différemment
      vec3 col;
      col.r = scene(uv+off*(1.+cs), bias).r;
      col.g = scene(uv+off, bias).g;
      col.b = scene(uv+off*(1.-cs), bias).b;

      // --- bulle-portail : un autre monde vu au travers ---
      if(uPortal.z > .001){
        vec2 pd = (st-uPortal.xy)/uPortal.z; float pl = length(pd);
        float pm = smoothstep(1., 1.-1.5/(uPortal.z*uRes.y), pl);
        if(pm > 0.){
          float pz = sqrt(max(1.-pl*pl, 0.));
          vec2 poff = -pd*(1.-pz)*uPortal.w*uPortal.z*vec2(1./a, 1.);
          // légère inversion façon goutte d'eau, qui s'efface quand on entre
          vec2 pc = vec2(uPortal.x/a, uPortal.y);
          vec2 puv = uv + off + poff;
          vec3 pcol;
          vec2 base = water(cover(puv, uPortalZoom, uImgA.y));
          vec2 dd = poff*vec2(1., 1.)*.6;
          pcol.r = tex1(base+dd*.25, 0.).r;
          pcol.g = tex1(base, 0.).g;
          pcol.b = tex1(base-dd*.25, 0.).b;
          float big = mix(.3, 1., 1.-smoothstep(.3, 1.1, uPortal.z));
          float pr = pow(1.-pz, 1.6)*pm*clamp(uPortal.w, 0., 1.)*big;
          float pang = atan(pd.y, pd.x);
          vec3 irid = .5+.5*cos(6.2831*(vec3(0.,.33,.67) + pr*1.3 + pang*.16 + uTime*.05));
          pcol = mix(pcol, pcol*.55 + irid*.75, pr*.5) + pr*.2;
          float ps = (smoothstep(.3,.0,length(pd-vec2(-.4,.45))) + .35*smoothstep(.12,.0,length(pd-vec2(.5,-.38))))*clamp(uPortal.w,0.,1.);
          pcol += ps*.7*big;
          // ombre portée douce autour de la bulle
          col *= 1. - smoothstep(1.25, 1., pl)*(1.-pm)*.25*clamp(uPortal.w,0.,1.);
          col = mix(col, pcol, pm);
        } else {
          col *= 1. - smoothstep(1.25, 1., pl)*.25*clamp(uPortal.w,0.,1.);
        }
      }

      // irisation + reflets des petites bulles
      vec3 irid = .5+.5*cos(6.2831*(vec3(0.,.33,.67) + rim*1.2 + ang*.16 + uTime*.04));
      col = mix(col, col*.6 + irid*.7, rim*.45);
      col += rim*.16 + spec*.8;

      // rayons de lumière depuis la surface
      float rays = pow(max(0., sin(uv.x*11. + uv.y*2.5 + sin(uTime*.25)*1.5)*.5+.5), 6.)
                 + pow(max(0., sin(uv.x*23. - uv.y*4. + uTime*.18)*.5+.5), 10.)*.6;
      col += rays*smoothstep(.2, 1.1, uv.y)*.07*(1.-uDepth);

      // --- profondeur : tout s'éteint sauf l'orange ---
      float lum = dot(col, vec3(.299,.587,.114));
      float orange = smoothstep(.22,.5, col.r-col.b) * smoothstep(.12,.32, col.r-col.g);
      vec3 deep = vec3(.01,.05,.11) + lum*vec3(.04,.2,.36);
      vec3 ember = col*vec3(1.25,.72,.42)*1.25;
      col = mix(col, mix(deep, ember, orange), uDepth);

      // neige marine
      vec2 sp = st*36. + vec2(sin(uTime*.2)*2., uTime*.9);
      vec2 id = floor(sp), fp = fract(sp)-.5;
      vec2 o = vec2(hash(id+3.1), hash(id+7.7))-.5;
      float snow = step(.88, hash(id))*smoothstep(.07,.0,length(fp-o*.7));
      col += snow*(.12 + uDepth*.4)*vec3(.75,.88,1.);

      col *= 1. - uShade*.38;
      float v = smoothstep(1.35, .25, length((uv-.5)*vec2(a,1.)));
      col *= mix(1., v, .3 + uDepth*.55);
      col = mix(col, vec3(.95,.97,1.), uLight);

      vec3 abyss = vec3(.012,.027,.05);
      abyss += vec3(1.,.42,.12)*exp(-max(rl-R,0.)*28.)*.55*(1.-smoothstep(.1,.6,uReveal));
      col = mix(abyss, col, rm);

      col += (hash(uv*uRes + fract(uTime)*91.)-.5)*.035; // grain
      gl_FragColor = vec4(col, 1.);
    }
  `;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ["uTex0", "uTex1", "uRes", "uTime", "uReveal", "uMix", "uZoom", "uDepth", "uLight", "uShade", "uWobble",
   "uPan", "uImgA", "uPortal", "uPortalZoom", "uMouse", "uBub"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));

  const imgAspect = [1, 1];
  function loadTexture(url, unit) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        // WebGL1 : mipmaps (flou de profondeur) et MIRRORED_REPEAT exigent des
        // dimensions en puissance de 2 → on rééchantillonne, le ratio d'origine est
        // conservé à part et corrigé dans le shader.
        const pot = (n) => Math.min(2048, 2 ** Math.round(Math.log2(n)));
        let src = img;
        if (pot(img.width) !== img.width || pot(img.height) !== img.height) {
          src = document.createElement("canvas");
          src.width = pot(img.width);
          src.height = pot(img.height);
          const ctx = src.getContext("2d");
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, src.width, src.height);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        imgAspect[unit] = img.width / img.height;
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  let W = 0, H = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  // =====================================================================
  //  Bulles ambiantes (simulées en JS, réfractées dans le shader)
  // =====================================================================
  const bubbles = Array.from({ length: N_BUB }, (_, i) => spawnBubble({}, true, i));
  function spawnBubble(b, initial, i = 0) {
    b.x = Math.random();
    b.y = initial ? Math.random() * 1.2 - 0.1 : -0.12 - Math.random() * 0.3;
    b.r = 0.012 + Math.pow(Math.random(), 2.2) * 0.055;
    b.k = 0.8 + Math.random() * 0.9;
    b.speed = 0.035 + Math.random() * 0.05 + (0.06 - b.r) * 0.6;
    b.phase = Math.random() * 6.28;
    b.scale = 1;
    b.popping = false;
    return b;
  }
  const bubData = new Float32Array(N_BUB * 4);

  // =====================================================================
  //  Curseur-lentille
  // =====================================================================
  const cursorEl = document.querySelector(".cursor");
  const mouse = { x: W / 2, y: H / 2, sx: W / 2, sy: H / 2, r: 0, tr: isTouch ? 0 : 0.075 };
  window.addEventListener("pointermove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  });
  if (!isTouch) document.querySelectorAll("[data-hover], a, button").forEach((el) => {
    el.addEventListener("pointerenter", () => { mouse.tr = 0.13; cursorEl.classList.add("is-hover"); });
    el.addEventListener("pointerleave", () => { mouse.tr = 0.075; cursorEl.classList.remove("is-hover"); });
  });

  // Clic : éclate une bulle si on est dessus, sinon en souffle une nouvelle
  window.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button")) return;
    const a = W / H;
    const st = [(e.clientX / W) * a, 1 - e.clientY / H];
    const hit = bubbles.find((b) => !b.popping && Math.hypot(b.x * a - st[0], b.y - st[1]) < b.r * b.scale * S.bubbles);
    if (hit) {
      hit.popping = true;
      popRing(e.clientX, e.clientY, hit.r * H * 2);
      gsap.to(hit, { scale: 0, duration: 0.18, ease: "power2.in", onComplete: () => spawnBubble(hit, false) });
    } else {
      const b = bubbles.reduce((m, c) => (c.y > m.y ? c : m)); // recycle la plus haute
      spawnBubble(b, false);
      b.x = e.clientX / W;
      b.y = 1 - e.clientY / H;
      b.r = 0.03 + Math.random() * 0.03;
      b.scale = 0;
      gsap.to(b, { scale: 1, duration: 0.7, ease: "elastic.out(1, 0.5)" });
    }
  });
  function popRing(x, y, d) {
    const el = document.createElement("div");
    el.className = "pop";
    Object.assign(el.style, { left: `${x - d / 2}px`, top: `${y - d / 2}px`, width: `${d}px`, height: `${d}px` });
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  // =====================================================================
  //  Scroll fluide
  // =====================================================================
  const lenis = new Lenis({ lerp: reduceMotion ? 1 : 0.075, smoothWheel: !reduceMotion });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  lenis.stop();
  window.lenis = lenis;
  let velocity = 0;

  // =====================================================================
  //  Rendu
  // =====================================================================
  const liquidMap = document.getElementById("liquid-map");
  const liquidNoise = document.getElementById("liquid-noise");
  let lastLiquid = -1;
  const gaugeVal = document.querySelector(".gauge-val");
  const gaugeFill = document.querySelector(".gauge-fill");
  const gaugeFish = document.querySelector(".gauge-fish");
  let lastMeters = -1;
  const t0 = performance.now();
  let prev = t0;

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;
    const time = (now - t0) / 1000;
    const a = W / H;

    velocity += ((lenis.velocity || 0) - velocity) * 0.1;
    const wob = Math.min(Math.abs(velocity) / 40, 1.5);

    // bulles : la vitesse de scroll les pousse
    for (let i = 0; i < N_BUB; i++) {
      const b = bubbles[i];
      b.y += (b.speed + Math.max(velocity, 0) * 0.0025) * dt;
      b.x += Math.sin(time * 1.4 + b.phase) * 0.00045;
      if (b.y - b.r > 1.15 && !b.popping) spawnBubble(b, false);
      bubData[i * 4] = b.x * a;
      bubData[i * 4 + 1] = b.y;
      bubData[i * 4 + 2] = b.r * b.scale * S.bubbles;
      bubData[i * 4 + 3] = b.k;
    }

    mouse.sx += (mouse.x - mouse.sx) * 0.14;
    mouse.sy += (mouse.y - mouse.sy) * 0.14;
    mouse.r += (mouse.tr * Math.min(S.reveal * 1.4, 1) - mouse.r) * 0.08;

    gl.uniform1i(U.uTex0, 0);
    gl.uniform1i(U.uTex1, 1);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, time);
    gl.uniform1f(U.uReveal, S.reveal);
    gl.uniform1f(U.uMix, S.mix);
    gl.uniform1f(U.uZoom, S.zoom);
    gl.uniform1f(U.uDepth, S.depth);
    gl.uniform1f(U.uLight, S.light);
    gl.uniform1f(U.uShade, S.shade);
    gl.uniform1f(U.uWobble, wob);
    gl.uniform2f(U.uPan, S.panX, S.panY);
    gl.uniform2f(U.uImgA, imgAspect[0], imgAspect[1]);
    gl.uniform4f(U.uPortal, S.portalX * a, S.portalY, S.portalR, S.portalK);
    gl.uniform1f(U.uPortalZoom, S.portalZoom);
    gl.uniform4f(U.uMouse, (mouse.sx / W) * a, 1 - mouse.sy / H, mouse.r, 1.6);
    gl.uniform4fv(U.uBub, bubData);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // titres liquides
    const liq = Math.round((S.liquid + wob * 22) * 10) / 10;
    if (liq !== lastLiquid) {
      liquidMap.setAttribute("scale", liq);
      lastLiquid = liq;
    }
    if (liq > 0.5) liquidNoise.setAttribute("baseFrequency", `${0.008 + Math.sin(time) * 0.002} ${0.03 + Math.cos(time * 0.8) * 0.006}`);

    // jauge de profondeur
    const m = Math.round(S.meters);
    if (m !== lastMeters) {
      gaugeVal.textContent = `−${String(m).padStart(3, "0")} m`;
      gaugeFill.style.transform = `scaleY(${m / 400})`;
      gsap.set(gaugeFish, { y: (m / 400) * 0.32 * innerHeight });
      lastMeters = m;
    }

    requestAnimationFrame(frame);
  }

  // =====================================================================
  //  Chorégraphie
  // =====================================================================
  // timeline de section : durée fixée à 1 pour que les positions (0..1) = progression du scroll
  const scrub = (trigger, opts = {}) =>
    gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: { trigger, start: "top top", end: "bottom bottom", scrub: reduceMotion ? true : 0.6, ...opts },
    }).set({}, {}, 1);

  function choreograph() {
    // --- jauge de profondeur : apparaît au chapitre I, le trait s'étire depuis le haut ---
    gsap.set(".gauge", { autoAlpha: 1 });
    const gaugeIn = gsap.timeline({ paused: true })
      .fromTo(".gauge-label", { autoAlpha: 0, y: -12 }, { autoAlpha: 1, y: 0, duration: 0.6, ease: "power2.out" })
      .fromTo(".gauge-track", { scaleY: 0 }, { scaleY: 1, duration: 1.4, ease: "expo.inOut" }, 0.15)
      .fromTo(".gauge-fish", { scale: 0, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.6, ease: "back.out(3)" }, 1.15)
      .fromTo(".gauge-val", { autoAlpha: 0, y: 10, filter: "blur(4px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.7, ease: "power2.out" }, 1.1);
    ScrollTrigger.create({
      trigger: ".s-legend",
      start: "top 60%",
      onEnter: () => gaugeIn.timeScale(1).play(),
      onLeaveBack: () => gaugeIn.timeScale(2.2).reverse(),
    });

    // --- Timeline maîtresse : tout l'état du shader, sur toute la page ---
    // Une seule timeline écrit dans S → aucun conflit, même en scroll rapide.
    const main = document.querySelector("main");
    const M = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: { trigger: main, start: "top top", end: "bottom bottom", scrub: reduceMotion ? true : 0.6 },
    });
    // progression locale d'une section (0..1 sur sa durée épinglée) → temps maître (en hauteurs d'écran)
    const span = (sel) => (document.querySelector(sel).offsetHeight - innerHeight) / innerHeight;
    const at = (sel, p) => document.querySelector(sel).offsetTop / innerHeight + p * span(sel);
    const sTo = (sel, p, vars) => M.to(S, { ...vars, duration: (vars.duration ?? 1) * span(sel) }, at(sel, p));
    const sSet = (sel, p, vars) => M.set(S, vars, at(sel, p));

    // --- 00 · Prologue : le point orange devient un jardin ---
    sTo(".s-intro", 0.08, { reveal: 1, duration: 0.55, ease: "power2.in" });
    sTo(".s-intro", 0.08, { zoom: 1.12, panX: 0, panY: 0, duration: 0.7, ease: "power2.inOut" });
    sTo(".s-intro", 0.55, { bubbles: 1, duration: 0.2 });
    sSet(".s-intro", 0.579, { liquid: 140 });
    sTo(".s-intro", 0.58, { liquid: 0, duration: 0.3, ease: "power2.out" });
    sTo(".s-intro", 0.8, { meters: 8, duration: 0.2 });
    scrub(".s-intro")
      .to(".scroll-hint", { opacity: 0, duration: 0.06 }, 0)
      .to(".intro-line", { opacity: 0, y: -40, filter: "blur(8px)", duration: 0.14 }, 0.04)
      .fromTo(".title", { opacity: 0, scale: 1.12, letterSpacing: "0.08em" }, { opacity: 1, scale: 1, letterSpacing: "-0.02em", duration: 0.3, ease: "power2.out" }, 0.58)
      .to(".title-sub", { opacity: 1, duration: 0.1 }, 0.78)
      .to([".title", ".title-sub"], { opacity: 0, y: -60, duration: 0.1, ease: "power1.in" }, 0.9);

    // --- I · La Légende : les mots émergent un à un ---
    const words = document.querySelector(".words");
    words.innerHTML = words.textContent.trim().split(/\s+/).map((w) => `<span class="w">${w}</span>`).join(" ");
    sTo(".s-legend", 0, { shade: 0.55, duration: 0.15 });
    sTo(".s-legend", 0, { zoom: 1.3, meters: 30, duration: 1 });
    sTo(".s-legend", 0.9, { shade: 0.1, duration: 0.1 });
    scrub(".s-legend")
      .fromTo(".s-legend .kicker", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.1 }, 0.02)
      .fromTo(".words .w", { opacity: 0.1, y: 18, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", stagger: 0.016, duration: 0.08 }, 0.08)
      .to([".words", ".s-legend .kicker"], { opacity: 0, y: -40, duration: 0.08 }, 0.9);

    // --- II · La Bulle : on traverse la bulle vers l'autre monde ---
    sSet(".s-portal", 0, { portalR: 0.2, portalY: -0.35, portalX: 0.62, portalK: 1.9, portalZoom: 1.8 });
    sTo(".s-portal", 0, { portalY: 0.47, portalX: 0.5, duration: 0.32, ease: "power2.out" });
    sTo(".s-portal", 0, { meters: 70, duration: 1 });
    sTo(".s-portal", 0.5, { portalR: 1.6, duration: 0.42, ease: "power3.in" });
    sTo(".s-portal", 0.5, { portalK: 0, portalZoom: 1.25, duration: 0.42, ease: "power2.in" });
    sTo(".s-portal", 0.5, { zoom: 1.25, shade: 0, duration: 0.42 });
    sSet(".s-portal", 0.93, { mix: 1, portalR: 0 });
    scrub(".s-portal")
      .fromTo(".s-portal .kicker", { opacity: 0 }, { opacity: 1, duration: 0.05 }, 0.02)
      .fromTo(".portal-title", { opacity: 0, y: 40, filter: "blur(10px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.12 }, 0.1)
      .fromTo(".portal-sub", { opacity: 0 }, { opacity: 1, duration: 0.08 }, 0.26)
      .to([".portal-title", ".portal-sub", ".s-portal .kicker"], { opacity: 0, filter: "blur(10px)", duration: 0.08 }, 0.46);

    // --- III · Le Gardien : couloir horizontal de fiches en verre ---
    const track = document.querySelector(".track");
    buildStems();
    sTo(".s-guardian", 0, { zoom: 1.5, panX: FISH_2[0] - 0.5 + 0.06, shade: 0.25, meters: 140, duration: 1 });
    scrub(".s-guardian")
      .to(track, { x: () => -(track.scrollWidth - window.innerWidth), duration: 0.86 }, 0.08)
      .fromTo(".stems path", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.7, stagger: 0.02 }, 0.05)
      .fromTo(".stems circle", { scale: 0 }, { scale: 1, duration: 0.1, stagger: 0.03, ease: "back.out(3)" }, 0.6)
      .to(".stems", { opacity: 0, duration: 0.08 }, 0.92);

    // reflet des cartes qui suit la souris
    document.querySelectorAll(".card").forEach((c) => {
      c.addEventListener("pointermove", (e) => {
        const r = c.getBoundingClientRect();
        c.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
        c.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
      });
    });

    // --- IV · La Profondeur : les couleurs meurent, l'orange brûle ---
    sTo(".s-depth", 0, { depth: 1, meters: 400, shade: 0, duration: 0.85, ease: "power1.inOut" });
    sTo(".s-depth", 0, { zoom: 2.3, panX: FISH_2[0] - 0.5, panY: FISH_2[1] - 0.5, duration: 0.9, ease: "power2.inOut" });
    sTo(".s-depth", 0.2, { bubbles: 0.55, duration: 0.6 });
    const lines = gsap.utils.toArray(".depth-lines p");
    const depthTl = scrub(".s-depth").fromTo(".s-depth .kicker", { opacity: 0 }, { opacity: 1, duration: 0.05 }, 0);
    lines.forEach((p, i) => {
      depthTl.fromTo(p, { opacity: 0, y: 30, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.1 }, 0.15 + i * 0.25);
      if (i < lines.length - 1) depthTl.to(p, { opacity: 0.18, duration: 0.1 }, 0.38 + i * 0.25);
    });
    depthTl.to([".depth-lines", ".s-depth .kicker"], { opacity: 0, duration: 0.05 }, 0.95);

    // --- V · La Remontée : la vague nous ramène au premier jardin ---
    sTo(".s-final", 0, { depth: 0, meters: 0, bubbles: 1, duration: 0.55, ease: "power2.inOut" });
    sTo(".s-final", 0.08, { mix: 0, duration: 0.5, ease: "power1.inOut" });
    sTo(".s-final", 0, { zoom: 1.08, panX: 0, panY: 0, duration: 0.6, ease: "power2.inOut" });
    sSet(".s-final", 0.499, { liquid: 120 });
    sTo(".s-final", 0.5, { liquid: 0, duration: 0.25, ease: "power2.out" });
    sTo(".s-final", 0.5, { shade: 0.2, duration: 0.2 });
    M.set({}, {}, (main.offsetHeight - innerHeight) / innerHeight); // cale la durée sur la page
    scrub(".s-final")
      .fromTo(".s-final .kicker", { opacity: 0 }, { opacity: 1, duration: 0.05 }, 0.05)
      .fromTo(".final-title", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" }, 0.5)
      .to(".foot", { opacity: 1, duration: 0.1 }, 0.82);

    document.querySelector(".to-top").addEventListener("click", () => lenis.scrollTo(0, { duration: 4.5 }));
    document.querySelector(".brand").addEventListener("click", (e) => { e.preventDefault(); lenis.scrollTo(0, { duration: 3 }); });
  }

  // tiges végétales qui se dessinent sur les bords
  function buildStems() {
    document.querySelectorAll(".stems").forEach((svg, side) => {
      let html = "";
      for (let s = 0; s < 4; s++) {
        const x0 = 20 + s * 38 + side * 9;
        const amp = 18 + s * 7;
        const top = 120 + ((s * 173 + side * 91) % 380);
        let d = `M ${x0} 1000`;
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const y = 1000 - ((1000 - top) * i) / steps;
          const x = x0 + Math.sin(i * 0.9 + s) * amp;
          d += ` S ${x + amp * 0.6} ${y + 40} ${x} ${y}`;
          if (i % 3 === 0 && i < steps) {
            const dir = i % 2 ? 1 : -1;
            html += `<path pathLength="1" stroke-dasharray="1" d="M ${x} ${y} q ${dir * 30} -14 ${dir * 46} -42 q ${-dir * 26} 4 ${-dir * 46} 42" />`;
          }
        }
        const endX = x0 + Math.sin(steps * 0.9 + s) * amp;
        html = `<path pathLength="1" stroke-dasharray="1" d="${d}" />` + html;
        html += `<circle cx="${endX}" cy="${top}" r="5" />`;
      }
      svg.innerHTML = html;
    });
  }

  // =====================================================================
  //  Démarrage
  // =====================================================================
  document.body.classList.add("is-loading");
  const numEl = document.querySelector(".loader-num");
  const load = { v: 0 };
  const counter = gsap.to(load, {
    v: 92, duration: 2.2, ease: "power2.out",
    onUpdate: () => (numEl.textContent = String(Math.round(load.v)).padStart(3, "0")),
  });

  Promise.all([loadTexture("assets/jardin-1-16x9-hd.webp", 0), loadTexture("assets/jardin-2.png", 1), document.fonts.ready])
    .then(() => {
      counter.kill();
      requestAnimationFrame(frame);
      choreograph();
      ScrollTrigger.refresh();
      gsap.timeline()
        .to(load, { v: 100, duration: 0.4, onUpdate: () => (numEl.textContent = String(Math.round(load.v)).padStart(3, "0")) })
        .to(".loader", { opacity: 0, duration: 1.2, ease: "power2.inOut" })
        .add(() => {
          document.querySelector(".loader").remove();
          document.body.classList.remove("is-loading");
          lenis.start();
        })
        .from(".intro-line", { opacity: 0, y: 20, filter: "blur(8px)", duration: 1.6, ease: "power3.out" }, "-=0.6")
        .from(".scroll-hint", { opacity: 0, duration: 1 }, "-=0.8")
        .from(".hud", { opacity: 0, duration: 1.2 }, "<");
    })
    .catch((err) => {
      console.error(err);
      numEl.textContent = "Erreur de chargement des images";
    });
})();
