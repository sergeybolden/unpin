// The Unpin mascot: a soft ghost shaped like a location pin, with two eyes and two floating hands.
//
// The approach follows bloub (github.com/jeremy-prt/bloub, MIT), an SVG recreation of the x.ai bot:
// - The body is a radial profile: one radius per direction around a centre. Every shape is sampled
//   at the same angles, so any shape morphs into any other by plain interpolation: the pin into a
//   ball, three "thinking" dots, an exclamation mark, a dot that bursts into particles.
// - The eyes are painted on a sphere. The head turns (yaw, pitch, roll); each eye takes the sphere's
//   tangent frame, so the far eye narrows and slides behind the edge (the body clips it). An
//   expression is the head pose plus width, height, tilt and openness of each eye.
// - At rest the life is gaze drift and blinking; a blink hides each change of shape.
// - A state is a pose as a pure function of local time; a change blends from the frame on screen
//   to the new state with an exponential ease-out.
// On top of that this ghost is soft: it jiggles after a jolt, floats a little, and can be pulled.
//
// Units: the ball radius is 1 (the logo's half width, 302 px of the 1024 artwork). y points down.

const TAU = Math.PI * 2;
const INK = "#16162d";
const ACCENT = "#ffdd00";
const LAVENDER = "#8d89dc";
const N = 120; // samples per profile

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const r3 = (v) => Math.round(v * 1000) / 1000;
const deg = (d) => (d * Math.PI) / 180;
const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  quint: (t) => 1 - (1 - t) ** 5,
};
// Smooth periodic noise for the gaze drift (periods chosen so it never visibly repeats).
const noise = (t, period, seed = 0) => {
  const p = (t / period) * TAU;
  return 0.55 * Math.sin(p + seed) + 0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) + 0.15 * Math.sin(3 * p + seed * 2.3 + 2.4);
};
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- shapes as radial profiles ----------

// Distance from (cx, cy) to a closed polygon along each sampled direction.
function profile(poly, cx = 0, cy = 0) {
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU, dx = Math.cos(a), dy = Math.sin(a);
    let best = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const ex = x2 - x1, ey = y2 - y1, qx = x1 - cx, qy = y1 - cy;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && t > best) best = t;
    }
    out[k] = best;
  }
  return out;
}

// The logo's body outline, flattened, in ball units around (490, 470).
const PIN_POLY = (() => {
  const P = [[490, 114.9], [653.7, 114.9], [792.2, 245.1], [792.2, 402.3], [792.2, 492.5], [754.1, 579], [690, 671],
    [636, 749.1], [566.3, 844], [514.2, 898], [499.3, 912.8], [480.7, 912.8], [465.8, 898], [413.7, 844], [344, 749.1],
    [290, 671], [225.9, 579], [187.8, 492.5], [187.8, 402.3], [187.8, 245.1], [326.3, 114.9], [490, 114.9]];
  const out = [];
  for (let i = 0; i + 3 < P.length; i += 3) {
    for (let s = 0; s < 40; s++) {
      const t = s / 40, u = 1 - t;
      const x = u * u * u * P[i][0] + 3 * u * u * t * P[i + 1][0] + 3 * u * t * t * P[i + 2][0] + t * t * t * P[i + 3][0];
      const y = u * u * u * P[i][1] + 3 * u * u * t * P[i + 1][1] + 3 * u * t * t * P[i + 2][1] + t * t * t * P[i + 3][1];
      out.push([(x - 490) / 302, (y - 470) / 302]);
    }
  }
  return out;
})();
const PIN = profile(PIN_POLY);
const circleR = (r) => new Float64Array(N).fill(r);
// Convex hull of two circles (a capsule or a tapered bar), as a polygon.
function hull2(x1, y1, r1, x2, y2, r2) {
  const pts = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * TAU;
    pts.push([x1 + Math.cos(a) * r1, y1 + Math.sin(a) * r1], [x2 + Math.cos(a) * r2, y2 + Math.sin(a) * r2]);
  }
  // gift wrapping
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length > 1 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.reverse()) { while (hi.length > 1 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
const BAR_CY = -0.35;
const BAR = profile(hull2(0, -0.82, 0.17, 0, 0.0, 0.1), 0, BAR_CY);
const BALL = circleR(1.08);

const sil = (radii, o = {}) => ({ radii, cx: 0, cy: 0, sx: 1, sy: 1, ...o });

// ---------- eyes on a sphere ----------

// Rotate two vectors of an orthonormal frame within their common plane.
function spin(u, v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [[u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s], [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s]];
}
// Screen x right, y down, z towards the viewer. Returns [left eye, right eye].
function eyePoses(g, split) {
  let f = [0, 0, 1], right = [1, 0, 0], down = [0, 1, 0];
  [f, right] = spin(f, right, deg(g.yaw));
  [down, f] = spin(down, f, deg(g.pitch));
  [right, down] = spin(right, down, deg(g.roll));
  return [-1, 1].map((side) => {
    const [ef, er] = spin(f, right, deg(split * side));
    return { x: ef[0], y: ef[1], a: er[0], b: er[1], c: down[0], d: down[1], depth: ef[2] };
  });
}

// The logo's face: eyes 0.209 x 0.388, 15.4 deg apart, looking a little up.
const EYE_W = 0.209, EYE_H = 0.388, SPLIT = 15.4;
const REST = { yaw: 0, pitch: 9, roll: 0 };
const eye = (w, h, tilt = 0, open = 1) => ({ w, h, tilt, open });
const pair = (w, h, tilt = 0, open = 1) => [eye(w, h, tilt, open), eye(w, h, -tilt, open)];
const mixEyes = (a, b, k) => a.map((e, i) => ({ w: lerp(e.w, b[i].w, k), h: lerp(e.h, b[i].h, k), tilt: lerp(e.tilt, b[i].tilt, k), open: lerp(e.open, b[i].open, k) }));
const HAPPY = pair(0.28, 0.15, 14);

// Rest expressions: head pose, eye spacing, each eye. Values adapted from bloub's catalogue.
export const EXPRESSIONS = {
  neutral: { gaze: { ...REST }, split: SPLIT, eyes: pair(EYE_W, EYE_H) },
  attentive: { gaze: { yaw: 4, pitch: 5, roll: -4 }, split: 16, eyes: pair(0.21, 0.44) },
  surprised: { gaze: { yaw: 3, pitch: -3, roll: 0 }, split: 19, eyes: pair(0.42, 0.45) },
  excited: { gaze: { yaw: 6, pitch: -14, roll: 0 }, split: 19.5, eyes: pair(0.38, 0.54, -10) },
  happy: { gaze: { yaw: 5, pitch: 9, roll: 0 }, split: 17, eyes: pair(0.27, 0.16, 14) },
  laughing: { gaze: { yaw: 4, pitch: 14, roll: 0 }, split: 18, eyes: pair(0.34, 0.12, 20) },
  angry: { gaze: { yaw: 3, pitch: 7, roll: 0 }, split: 17, eyes: pair(0.34, 0.15, 30) },
  sad: { gaze: { yaw: 3, pitch: -13, roll: 0 }, split: 16, eyes: pair(0.22, 0.4, -28) },
  scared: { gaze: { yaw: 2, pitch: -20, roll: 0 }, split: 20.5, eyes: pair(0.38, 0.58) },
  suspicious: { gaze: { yaw: 12, pitch: 6, roll: -6 }, split: 16, eyes: [eye(0.21, 0.4), eye(0.22, 0.15)] },
  confused: { gaze: { yaw: -14, pitch: 3, roll: 8 }, split: 16.5, eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)] },
  curious: { gaze: { yaw: 16, pitch: -9, roll: -15 }, split: 16.5, eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)] },
  proud: { gaze: { yaw: 5, pitch: 17, roll: 0 }, split: 17, eyes: pair(0.3, 0.15, 18) },
  shy: { gaze: { yaw: -19, pitch: -14, roll: -7 }, split: 14, eyes: pair(0.17, 0.3) },
  unimpressed: { gaze: { yaw: -22, pitch: 2, roll: 0 }, split: 16, eyes: pair(0.3, 0.12) },
  sleepy: { gaze: { yaw: 6, pitch: -9, roll: -3 }, split: 16, eyes: pair(0.2, 0.42, 0, 0.42) },
};

// ---------- poses ----------

const HAND_R = 0.22;
const REST_HANDS = [{ x: -0.89, y: 0.51, r: HAND_R }, { x: 0.89, y: 0.45, r: HAND_R }];
const FACE = { x: 0, y: -0.225, s: 1 }; // the sphere the eyes sit on: the pin's round top

function base(o = {}) {
  return {
    sil: sil(PIN), tail: 0, lean: 0, offX: 0, offY: 0,
    face: { ...FACE }, gaze: { ...REST }, split: SPLIT, eyes: pair(EYE_W, EYE_H),
    eyeA: 1, bodyA: 1, blush: 0, tone: 0, ledge: null,
    hands: REST_HANDS.map((h) => ({ ...h })),
    dots: [], rings: [], badge: null, scan: null, zs: [],
    ...o,
  };
}
const withFace = (expr, o = {}) => base({ gaze: { ...expr.gaze }, split: expr.split, eyes: expr.eyes.map((e) => ({ ...e })), ...o });
const handsAt = (lx, ly, rx, ry, r = HAND_R) => [{ x: lx, y: ly, r }, { x: rx, y: ry, r }];
// Hands pulled into the body (for shapes with no hands): shrunk to nothing at the centre.
const handsIn = (cx = 0, cy = 0.2) => [{ x: cx - 0.2, y: cy, r: 0 }, { x: cx + 0.2, y: cy, r: 0 }];

// The three thinking dots: a wave runs through them left to right.
const DOT_X = [-0.62, 0, 0.62], DOT_R = 0.2;
function pulse(t, i) {
  const p = ((((t - i * 0.5) / 1.5) % 1) + 1) % 1;
  return p < 0.5 ? 0.5 - 0.5 * Math.cos(p * 2 * TAU) : 0; // a smooth bump in the first half of each cycle
}

// Burst particles: bits of metadata flying off. Fixed seeds, so every replay is the same.
const BITS = (() => {
  const r = rng(0x0b1d);
  return Array.from({ length: 14 }, (_, i) => ({ a: (i / 14) * TAU + r() * 0.35, v: 1.1 + r() * 0.9, r: 0.05 + r() * 0.07, gold: i % 4 === 1 }));
})();

// Rings that orbit the body: tilted circles, drawn half behind and half in front.
const RINGS = [
  { R: 1.45, tx: 72, tz: 18, w: 0.045, color: LAVENDER, speed: 1.1, ph: 0 },
  { R: 1.6, tx: 64, tz: -34, w: 0.05, color: ACCENT, speed: -0.8, ph: 1.2 },
  { R: 1.35, tx: 80, tz: 62, w: 0.035, color: "#c3c4fa", speed: 1.4, ph: 2.3 },
];

// Each state: how long it holds when played in sequence, how long the entry morph takes, whether a
// blink hides the entry, whether it shows the chosen rest expression, whether the eyes may follow the
// pointer (only where they have nothing of their own to do), and its pose at local time t.
export const STATES = {
  idle: { dur: 2.4, morph: 0.45, face: true, follow: true, pose: (t, x) => withFace(x) },

  look: {
    dur: 3.4, morph: 0.45,
    pose: (t0) => {
      // Looks left, holds, looks right, holds, back to the middle; then again.
      const t = t0 % 3.4;
      const seg = (a, b) => ease.inOut(clamp((t - a) / (b - a)));
      const k = seg(0.35, 0.85) - 2 * seg(1.45, 2.25) + seg(2.85, 3.3); // 0 -> 1 (left) -> -1 (right) -> 0
      // The hand on the side he looks to rises above that eye, like a visor.
      const vl = Math.max(0, k), vr = Math.max(0, -k);
      return base({ gaze: { yaw: -34 * k, pitch: 8, roll: k * 5 }, split: 16, eyes: pair(0.22, 0.43), lean: -k * 0.07, tail: k * 0.08,
        hands: [
          // the path bows outwards, so the hand never crosses the eye on its way
          { x: lerp(-0.89, -0.7, vl) - Math.sin(vl * Math.PI) * 0.32, y: lerp(0.51, -0.98, vl), r: lerp(HAND_R, HAND_R * 0.72, vl) },
          { x: lerp(0.89, 0.7, vr) + Math.sin(vr * Math.PI) * 0.32, y: lerp(0.45, -0.98, vr), r: lerp(HAND_R, HAND_R * 0.72, vr) },
        ] });
    },
  },

  wink: { dur: 1.6, morph: 0.3, blink: true, pose: () => base({ gaze: { yaw: -5, pitch: 6, roll: 7 }, split: 16.2, eyes: [eye(0.23, 0.44), eye(0.42, 0.085)], blush: 0.4 }) },

  wide: {
    dur: 1.8, morph: 0.5, blink: true, follow: true,
    pose: () => base({ sil: sil(PIN, { sx: 0.96, sy: 1.05 }), gaze: { yaw: 4, pitch: -6, roll: 6 }, split: 18.4, eyes: pair(0.32, 0.72), hands: handsAt(-1.02, -0.05, 1.0, -0.12, HAND_R * 0.9) }),
  },

  catch: {
    dur: 1.8, morph: 0.3, kick: 1.4,
    pose: (t) => {
      const s = Math.exp(-3.5 * t) * Math.cos(10 * t);
      return base({ sil: sil(PIN, { sx: 1 + 0.16 * s, sy: 1 - 0.16 * s }), gaze: { yaw: 0, pitch: 12, roll: 0 }, split: 17, eyes: pair(0.28, 0.15, 14), blush: 0.7, hands: handsAt(-0.27, 0.78, 0.27, 0.76, HAND_R * 0.95) });
    },
  },

  thinking: {
    dur: 2.6, morph: 0.4, blink: true,
    pose: (t) => {
      const emerge = 0.3 + 0.7 * ease.out(clamp(t / 0.3));
      const mid = pulse(t, 1);
      return base({
        sil: sil(circleR(DOT_R * (1 + 0.32 * mid))), face: { x: 0, y: 0, s: 0.3 }, eyeA: 0, hands: handsIn(0, 0), tone: 0.6,
        dots: [0, 2].map((i) => { const k = pulse(t, i); return { x: DOT_X[i] * emerge, y: 0, r: DOT_R * (1 + 0.32 * k), o: 0.5 + 0.5 * k }; }),
      });
    },
  },

  scan: {
    dur: 2.4, morph: 0.4, blink: true,
    pose: (t) => {
      const yaw = 30 * Math.sin((t / 1.6) * TAU);
      return base({ gaze: { yaw, pitch: -4, roll: 0 }, split: 16, eyes: pair(0.36, 0.1), lean: yaw / 30 * 0.04,
        hands: handsAt(-0.3, 0.85 + Math.max(0, Math.sin(t * 9)) * -0.05, 0.3, 0.85 + Math.max(0, -Math.sin(t * 9)) * -0.05, HAND_R * 0.8),
        scan: { y: -1.2 + (((t / 1.6) % 1) * 2.8), a: clamp(t / 0.3) } });
    },
  },

  orbit: {
    dur: 3.2, morph: 0.5,
    pose: (t) => {
      const fade = clamp(t / 0.6);
      return base({ gaze: { yaw: 42 * Math.sin(t * 4.2), pitch: 4 + 8 * Math.cos(t * 4.2), roll: 0 }, split: 16, eyes: pair(0.21, 0.42),
        rings: RINGS.map((s, i) => ({ ...s, rot: t * s.speed * TAU * 0.5 + s.ph, o: fade * clamp((t - i * 0.15) / 0.3) })) });
    },
  },

  found: {
    dur: 2.2, morph: 0.45, blink: true,
    pose: (t) => {
      // The yellow badge pops (+18 %) and settles; the eyes turn to it.
      const p = clamp(t / 0.45), pop = 1 + 0.18 * Math.sin(p * Math.PI) * (1 - p * 0.35);
      const a = deg(-48);
      return base({ gaze: { yaw: 24, pitch: 18, roll: -8 }, split: 18.5, eyes: pair(0.36, 0.4), lean: 0.04,
        badge: { x: Math.cos(a) * 1.02, y: -0.225 + Math.sin(a) * 1.02, r: 0.2 * (p < 1 ? pop : 1) * clamp(t / 0.12) },
        hands: handsAt(-0.89, 0.51, 0.98, 0.05, HAND_R * 0.9) });
    },
  },

  burst: {
    dur: 2.6, morph: 0.35,
    pose: (t) => {
      // Collapses to a dot while the bits fly off, then grows back with a happy face.
      const collapse = 1 - 0.86 * ease.quint(clamp(t / 0.6));
      const back = ease.quint(clamp((t - 1.6) / 0.6));
      const k = collapse + (1 - collapse) * back;
      const radii = PIN.map((r, i) => lerp(0.16, r, (k - 0.14) / 0.86));
      const fly = clamp((t - 0.15) / 1.3);
      return base({
        sil: sil(radii, { cy: (1 - k) * 0.2 }), face: { x: 0, y: lerp(0, -0.225, k), s: k },
        eyeA: clamp((t - 1.8) / 0.3), gaze: { yaw: 0, pitch: 12, roll: 0 }, split: 17, eyes: pair(0.28, 0.15, 14), blush: back * 0.6,
        hands: REST_HANDS.map((h) => ({ x: h.x * k, y: h.y * k, r: h.r * clamp((k - 0.4) / 0.6) })),
        // the bits leave from the shrinking edge, not from inside the body
        dots: BITS.map((b) => {
          const d = 0.85 * collapse + ease.out(fly) * b.v * 1.2;
          return { x: Math.cos(b.a) * d, y: Math.sin(b.a) * d + fly * fly * 0.5, r: b.r * (1 - fly * 0.6), o: clamp((t - 0.12) / 0.1) * (1 - fly), gold: b.gold };
        }),
      });
    },
  },

  unpin: {
    dur: 3.4, morph: 0.3, kick: 0.8,
    pose: (t) => {
      // The point retracts: the pin becomes a ball (no point, no location) and a drop falls off.
      // Surprised round eyes, then a happy squint; at the end the point grows back.
      const k = ease.inOut(clamp((t - 0.15) / 0.55)) * (1 - ease.inOut(clamp((t - 2.6) / 0.6)));
      const glad = ease.inOut(clamp((t - 1.1) / 0.35)) * (1 - ease.inOut(clamp((t - 2.6) / 0.5)));
      const wide = pair(lerp(EYE_W, 0.3, k), lerp(EYE_H, 0.5, k));
      const fall = clamp((t - 0.35) / 0.9);
      return base({
        sil: sil(PIN.map((r, i) => lerp(r, BALL[i], k)), { cy: k * -0.08 }), face: { x: 0, y: lerp(-0.225, -0.15, k), s: 1 },
        gaze: { yaw: 0, pitch: lerp(lerp(9, -8, k), 12, glad), roll: 0 }, split: lerp(SPLIT, 17, Math.max(k, glad)),
        eyes: mixEyes(wide, HAPPY, glad), blush: 0.6 * glad,
        // the drop swells out of the retracting tip, then falls and fades
        dots: [{ x: 0, y: 1.28 + fall * fall * 1.1, r: 0.09 * clamp((t - 0.2) / 0.15) * (1 - fall * 0.3), o: 1 - fall }],
      });
    },
  },

  vanish: {
    dur: 3, morph: 0.4,
    pose: (t) => {
      // Fades out of sight; the eyes stay and smile, then the body comes back.
      const out = ease.inOut(clamp(t / 0.9)) * (1 - ease.inOut(clamp((t - 2.3) / 0.6)));
      const glad = ease.inOut(clamp((t - 1.0) / 0.3)) * (1 - ease.inOut(clamp((t - 2.2) / 0.3)));
      return base({ bodyA: 1 - out * 0.88, offY: -out * 0.08, sil: sil(PIN, { sy: 1 + out * 0.05 }),
        gaze: { yaw: 0, pitch: lerp(9, 12, glad), roll: 0 }, split: lerp(SPLIT, 17, glad), eyes: mixEyes(pair(EYE_W, EYE_H), HAPPY, glad) });
    },
  },

  // Not there at all: the start of "appear".
  gone: { dur: 1, morph: 0.3, pose: () => base({ bodyA: 0, eyeA: 0, eyes: pair(EYE_W, EYE_H, 0, 0), hands: handsIn(0, 0.3) }) },

  appear: {
    dur: 1.5, morph: 0.2,
    pose: (t) => {
      // Out of thin air: first the eyes open in the empty spot, then the body fills in around them.
      const eyes = ease.out(clamp((t - 0.1) / 0.3));
      const body = ease.inOut(clamp((t - 0.45) / 0.75));
      return base({ bodyA: body, eyeA: clamp(eyes * 1.5), eyes: pair(EYE_W, EYE_H, 0, eyes), offY: (1 - body) * -0.06,
        sil: sil(PIN, { sx: 1 - (1 - body) * 0.06, sy: 1 + (1 - body) * 0.08 }),
        hands: REST_HANDS.map((h) => ({ ...h, r: h.r * body })) });
    },
  },

  shrug: {
    dur: 2.2, morph: 0.45,
    pose: (t) => {
      const up = Math.sin(clamp(t / 0.9) * Math.PI) * 0.12;
      return base({ ...EXPRESSIONS.confused, gaze: { ...EXPRESSIONS.confused.gaze }, sil: sil(PIN, { sx: 1.04, sy: 0.97 }),
        hands: handsAt(-1.28, 0.2 - up, 1.28, 0.2 - up, HAND_R * 0.9), lean: -0.04 });
    },
  },

  ponder: {
    dur: 2.4, morph: 0.45,
    pose: (t) => base({ gaze: { yaw: 14 + 4 * Math.sin(t * 1.3), pitch: 16, roll: -12 }, split: 16.5, eyes: [eye(0.24, 0.42, -8), eye(0.22, 0.2, 10)],
      lean: -0.05, hands: handsAt(-0.89, 0.55, 0.36, 0.42 + Math.sin(t * 5) * 0.015, HAND_R * 0.78) }),
  },

  alert: {
    dur: 2, morph: 0.45,
    pose: (t) => {
      const buzz = Math.sin(t * 2.5 * TAU) * 0.01;
      return base({ sil: sil(BAR, { cy: BAR_CY + buzz }), face: { x: 0, y: -0.5, s: 0.3 }, eyeA: 0, hands: handsIn(0, 0.2), tone: 0.85,
        dots: [{ x: 0, y: 0.42 - buzz * 2, r: 0.12, o: 1 }] });
    },
  },

  sad: {
    dur: 2.4, morph: 0.5, blink: true,
    pose: (t) => base({ sil: sil(PIN, { sx: 1.08, sy: 0.9 }), offY: 0.08, ...EXPRESSIONS.sad, gaze: { ...EXPRESSIONS.sad.gaze, yaw: 3 * Math.sin(t) },
      hands: handsAt(-0.72, 1.02, 0.72, 1.0, HAND_R * 0.85) }),
  },

  sleep: {
    dur: 3, morph: 0.5,
    pose: (t) => {
      const br = Math.sin((t / 2.4) * TAU);
      // Z z z: each letter rises from the head, grows, sways and fades; a new one every 0.8 s.
      const zs = [0, 1, 2].map((i) => {
        const q = ((((t - 0.4 - i * 0.8) / 2.4) % 1) + 1) % 1;
        const on = t > 0.4 + i * 0.8 ? 1 : 0;
        return { x: 0.38 + q * 0.78 + Math.sin(q * 6) * 0.05, y: -0.78 - q * 0.72, s: 0.05 + q * 0.09, o: on * clamp(q / 0.12) * clamp((1 - q) / 0.3) };
      });
      return base({ sil: sil(PIN, { sx: 1.03 - br * 0.02, sy: 0.95 + br * 0.03 }), offY: 0.06, gaze: { yaw: 6, pitch: -10, roll: -4 }, split: 16, eyes: pair(0.3, 0.06),
        hands: handsAt(-0.82, 0.72, 0.82, 0.68, HAND_R * 0.9), zs });
    },
  },

  peek: {
    dur: 3, morph: 0.5, follow: true,
    // Hides behind an edge (on the site: a letter of the big wordmark), hands on the edge.
    // At rest the eyes follow the pointer.
    pose: (t) => base({ offY: 0.3, ledge: { y: 0.36, a: 1 }, gaze: { yaw: 0, pitch: 14, roll: 0 }, split: 16, eyes: pair(0.22, 0.44),
      hands: handsAt(-0.52, 0.3, 0.52, 0.3 + Math.max(0, Math.sin(t * 0.9 + 1)) * -0.04, HAND_R * 0.9) }),
  },

  wave: {
    dur: 2.2, morph: 0.4,
    pose: (t) => {
      const w = Math.sin(t * 11) * clamp(t / 0.3);
      return base({ gaze: { yaw: 4, pitch: 12, roll: 4 }, split: 17, eyes: pair(0.28, 0.15, 14), blush: 0.5, lean: 0.03,
        hands: handsAt(-0.89, 0.55, 1.05 + w * 0.12, -0.5 - Math.abs(w) * 0.05, HAND_R * 0.95) });
    },
  },
};

// The time at which each state reads best: what a still thumbnail shows.
export const STILL = { idle: 1, look: 1.3, wink: 0.8, wide: 0.8, catch: 1.2, thinking: 1.1, scan: 0.5, orbit: 1.3, found: 0.9, burst: 0.55,
  unpin: 1, vanish: 1.5, shrug: 0.6, ponder: 1, alert: 0.6, sad: 1, sleep: 1.5, peek: 1.2, wave: 0.6 };

// ---------- blending ----------

const lerpObj = (a, b, t, keys) => { const o = {}; for (const k of keys) o[k] = lerp(a[k], b[k], t); return o; };
function blendPose(a, b, t) {
  if (t >= 1) return b;
  const radii = new Float64Array(N);
  for (let i = 0; i < N; i++) radii[i] = lerp(a.sil.radii[i], b.sil.radii[i], t);
  const n = Math.max(a.dots.length, b.dots.length);
  const dots = [];
  for (let i = 0; i < n; i++) {
    const p = a.dots[i], q = b.dots[i];
    const pp = p || { ...q, r: 0, o: 0 }, qq = q || { ...p, r: 0, o: 0 };
    dots.push({ x: lerp(pp.x, qq.x, t), y: lerp(pp.y, qq.y, t), r: lerp(pp.r, qq.r, t), o: lerp(pp.o, qq.o, t), gold: (q || p).gold });
  }
  const rings = [];
  for (let i = 0; i < Math.max(a.rings.length, b.rings.length); i++) {
    const p = a.rings[i], q = b.rings[i];
    rings.push({ ...(q || p), o: lerp(p ? p.o : 0, q ? q.o : 0, t) });
  }
  const badge = a.badge || b.badge ? (() => {
    const p = a.badge || { ...b.badge, r: 0 }, q = b.badge || { ...a.badge, r: 0 };
    return lerpObj(p, q, t, ["x", "y", "r"]);
  })() : null;
  const zs = [...a.zs.map((z) => ({ ...z, o: z.o * (1 - t) })), ...b.zs.map((z) => ({ ...z, o: z.o * t }))];
  const scan = a.scan || b.scan ? { y: (b.scan || a.scan).y, a: lerp(a.scan ? a.scan.a : 0, b.scan ? b.scan.a : 0, t) } : null;
  return {
    sil: { radii, ...lerpObj(a.sil, b.sil, t, ["cx", "cy", "sx", "sy"]) },
    tail: lerp(a.tail, b.tail, t), lean: lerp(a.lean, b.lean, t), offX: lerp(a.offX, b.offX, t), offY: lerp(a.offY, b.offY, t),
    face: lerpObj(a.face, b.face, t, ["x", "y", "s"]), gaze: lerpObj(a.gaze, b.gaze, t, ["yaw", "pitch", "roll"]), split: lerp(a.split, b.split, t),
    eyes: [0, 1].map((i) => lerpObj(a.eyes[i], b.eyes[i], t, ["w", "h", "tilt", "open"])),
    eyeA: lerp(a.eyeA, b.eyeA, t), bodyA: lerp(a.bodyA, b.bodyA, t), blush: lerp(a.blush, b.blush, t), tone: lerp(a.tone, b.tone, t),
    ledge: a.ledge || b.ledge ? { y: (b.ledge || a.ledge).y, a: lerp(a.ledge ? a.ledge.a : 0, b.ledge ? b.ledge.a : 0, t) } : null,
    hands: [0, 1].map((i) => lerpObj(a.hands[i], b.hands[i], t, ["x", "y", "r"])),
    dots, rings, badge, scan, zs,
  };
}

// Pre-drawn blink schedule (1.9 to 4.6 s apart, sometimes double): deterministic, no state.
const BLINKS = (() => {
  const r = rng(0x5eed), out = [];
  for (let t = 1.4; t < 900;) { out.push(t); t += 1.9 + r() * 2.7; if (r() < 0.18) { out.push(t); t += 0.24; } }
  return out;
})();
function blinkAt(t) {
  for (const s of BLINKS) {
    if (t < s) break;
    const k = (t - s) / 0.18;
    if (k <= 1) return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
  }
  return 1;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the frame loop: only mascots on screen run ----------
const live = new Set();
let raf = 0;
function frame() {
  raf = 0;
  for (const m of live) m.draw(m.now());
  if (live.size) raf = requestAnimationFrame(frame);
}
function wake() { if (!raf && live.size) raf = requestAnimationFrame(frame); }

let ids = 0;
const NS = "http://www.w3.org/2000/svg";

export class Mascot {
  // frozen: render one exact frame at that local time, with no loop (thumbnails, still pages).
  // ledge: false when the page itself provides the edge he hides behind (the footer letter).
  // handsHost: draw the hands in a second SVG there, so the page can put something between the
  // body and the hands (the footer: body behind the letter, hands on top of it).
  constructor(host, { state = "idle", expression = "neutral", frozen = null, shadow = true, paper = "#ffffff", ledge = true, handsHost = null } = {}) {
    const p = `um${++ids}`;
    this.reduced = reducedMotion();
    this.frozen = frozen ?? (this.reduced ? STILL[state] ?? 1 : null);
    this.paper = paper;
    this.ledgeOn = ledge;
    this.expr = EXPRESSIONS[expression] || EXPRESSIONS.neutral;
    this.exprPrev = null;
    this.exprAt = -10;
    this.cur = state;
    this.prev = null; // frozen pose of what was on screen when the state changed
    this.changeAt = -10;
    this.kicks = [];
    this.look = null;
    this.pullV = { dx: 0, dy: 0 };
    this.release = null;
    this.clock0 = performance.now() / 1000 - Math.random() * 20;
    this.startAt = this.now();

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-1.65 -1.6 3.3 3.45");
    svg.setAttribute("class", "mascot-svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = `<defs>
<linearGradient id="${p}-b" x1="0.29" y1="0.07" x2="0.79" y2="0.98"><stop offset="0" stop-color="#ffffff"/><stop offset="0.38" stop-color="#f6f5ff"/><stop offset="0.72" stop-color="#e2e0ff"/><stop offset="1" stop-color="#c3c4fa"/></linearGradient>
<linearGradient id="${p}-d" x1="0.29" y1="0.07" x2="0.79" y2="0.98"><stop offset="0" stop-color="#e4e2ff"/><stop offset="0.55" stop-color="#bcb9f4"/><stop offset="1" stop-color="#9894e6"/></linearGradient>
<linearGradient id="${p}-h" x1="0.2" y1="0.12" x2="0.83" y2="0.96"><stop offset="0" stop-color="#ffffff"/><stop offset="0.65" stop-color="#f7f6ff"/><stop offset="1" stop-color="#d9d8ff"/></linearGradient>
<filter id="${p}-s" filterUnits="userSpaceOnUse" x="-3" y="-3" width="6" height="6"><feDropShadow dx="0" dy="0.04" stdDeviation="0.05" flood-color="#2b2463" flood-opacity="0.18"/></filter>
<clipPath id="${p}-c"><path class="m-clip"/></clipPath>
</defs>
<ellipse class="m-shadow" fill="#2b2463"/>
<g class="m-all">
<g class="m-back"></g>
<g class="m-dots-back" fill="url(#${p}-b)" stroke="#d9d7ef" stroke-width="0.016" filter="url(#${p}-s)"></g>
<path class="m-body" fill="url(#${p}-b)" stroke="#d9d7ef" stroke-width="0.016" filter="url(#${p}-s)"/>
<path class="m-tone" fill="url(#${p}-d)"/>
<g clip-path="url(#${p}-c)">
<rect class="m-scan" x="-2" width="4" height="0.07" fill="${ACCENT}"/>
<ellipse class="m-blush" rx="0.12" ry="0.065" fill="#ff9fb8"/><ellipse class="m-blush" rx="0.12" ry="0.065" fill="#ff9fb8"/>
<g class="m-eyes" fill="${INK}"><rect class="m-eye"/><rect class="m-eye"/></g>
</g>
<g class="m-dots" filter="url(#${p}-s)"></g>
<rect class="m-ledge" x="-1.8" width="3.6" height="2.4" rx="0.05" fill="#efeee8"/>
<g class="m-hands" fill="url(#${p}-h)" stroke="#d9d7ef" stroke-width="0.013" filter="url(#${p}-s)"><ellipse class="m-hand"/><ellipse class="m-hand"/></g>
<circle class="m-badge" fill="${ACCENT}" stroke="${paper}" stroke-width="0.07"/>
<g class="m-front"></g>
<g class="m-zs" fill="none" stroke="${LAVENDER}" stroke-linecap="round" stroke-linejoin="round"></g>
</g>`;
    if (!shadow) svg.querySelector(".m-shadow").remove();
    host.append(svg);
    this.svg = svg;
    if (handsHost) {
      // Same viewBox and the same moves, only the hands: the page stacks it over whatever it likes.
      const front = document.createElementNS(NS, "svg");
      front.setAttribute("viewBox", svg.getAttribute("viewBox"));
      front.setAttribute("class", "mascot-svg mascot-front");
      front.setAttribute("aria-hidden", "true");
      front.setAttribute("focusable", "false");
      const hands = svg.querySelector(".m-hands");
      front.innerHTML = `<defs>${svg.querySelector(`#${p}-h`).outerHTML}${svg.querySelector(`#${p}-s`).outerHTML}</defs><g class="m-all m-all-front"></g>`;
      front.querySelector(".m-all").append(hands);
      handsHost.append(front);
      this.front = front;
    }
    this.grad = `url(#${p}-b)`;
    this.deep = `url(#${p}-d)`;
    const root = this.front ? [svg, this.front] : [svg];
    const q = (s) => svg.querySelector(s) || this.front?.querySelector(s), qa = (s) => root.flatMap((r) => [...r.querySelectorAll(s)]);
    this.el = { shadow: q(".m-shadow"), all: q(".m-all"), body: q(".m-body"), tone: q(".m-tone"), ledge: q(".m-ledge"), clip: q(".m-clip"), eyes: qa(".m-eye"), eyesG: q(".m-eyes"),
      blush: qa(".m-blush"), hands: qa(".m-hand"), handsG: q(".m-hands"), badge: q(".m-badge"), scan: q(".m-scan"),
      dots: q(".m-dots"), zs: q(".m-zs"), dotsBack: q(".m-dots-back"), back: q(".m-back"), front: q(".m-front") };

    if (this.frozen != null) { this.draw(this.frozen, true); return; }
    this.draw(this.now());
    this.active = true;
    this.io = new IntersectionObserver(([e]) => { this.onScreen = e.isIntersecting; this.setActive(this.active); });
    this.io.observe(host);
  }

  now() { return performance.now() / 1000 - this.clock0; }

  // A mascot that is on screen but can't be seen (a faded-out frame) can be paused.
  setActive(on) {
    this.active = on;
    if (on && this.onScreen && this.frozen == null) { live.add(this); wake(); } else live.delete(this);
  }

  // Switch to another state; the change blends from the frame on screen.
  setState(id, { restart = false } = {}) {
    if (!STATES[id] || (id === this.cur && !restart)) return;
    const t = this.now();
    this.prev = this.sample(t);
    this.prevFollow = this.followAt(t);
    this.changeAt = t;
    this.startAt = t;
    this.cur = id;
    this.kick(STATES[id].kick ?? 0.35);
    if (this.frozen != null) this.draw(STILL[id] ?? 1, true);
  }

  setExpression(id) {
    if (!EXPRESSIONS[id]) return;
    const t = this.now();
    this.exprPrev = this.currentExpr(t);
    this.exprAt = t;
    this.expr = EXPRESSIONS[id];
    if (this.frozen != null) this.draw(this.frozen, true);
  }

  currentExpr(t) {
    const k = ease.quint(clamp((t - this.exprAt) / 0.4));
    if (!this.exprPrev || k >= 1) return this.expr;
    const a = this.exprPrev, b = this.expr;
    return { gaze: lerpObj(a.gaze, b.gaze, k, ["yaw", "pitch", "roll"]), split: lerp(a.split, b.split, k),
      eyes: [0, 1].map((i) => lerpObj(a.eyes[i], b.eyes[i], k, ["w", "h", "tilt", "open"])) };
  }

  // A jolt: the soft body jiggles for a moment.
  kick(amount = 1, side = 0) { this.kicks = this.kicks.filter((k) => this.now() - k.t < 3); this.kicks.push({ t: this.now(), a: amount, side }); wake(); }

  // Point the head at a page position (pointer, a dragged file), or null to let go.
  lookAt(px, py) {
    const t = this.now();
    const from = this.look ? this.lookValue(t) : { yaw: 0, pitch: 0, mix: 0 };
    if (px == null) { this.look = { from, to: { ...from, mix: 0 }, at: t }; return; }
    const b = this.svg.getBoundingClientRect();
    if (!b.width) return;
    const dx = (px - (b.left + b.width / 2)) / b.width, dy = (py - (b.top + b.height * 0.38)) / b.height;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.look = { from, to: { yaw: clamp(dx * 70, -38, 38), pitch: clamp(-dy * 60, -30, 30), mix: 1 }, at: t };
  }
  lookValue(t) {
    const L = this.look, k = ease.out(clamp((t - L.at) / 0.35));
    return lerpObj(L.from, L.to, k, ["yaw", "pitch", "mix"]);
  }

  // How much the pointer steers the eyes now: fades in and out with the state's entry morph.
  followAt(t) {
    const S = STATES[this.cur], to = S.follow ? 1 : 0;
    if (this.prevFollow == null) return to;
    return lerp(this.prevFollow, to, ease.quint(clamp((t - this.changeAt) / S.morph)));
  }

  sample(t) {
    const S = STATES[this.cur];
    const local = this.frozen != null ? t : t - this.startAt;
    const target = S.pose(local, this.currentExpr(t));
    const k = this.prev ? ease.quint(clamp((t - this.changeAt) / S.morph)) : 1;
    return this.prev ? blendPose(this.prev, target, k) : target;
  }

  draw(t, still = false) {
    const P = this.sample(t), e = this.el;
    const life = !still && !this.reduced;
    // Jiggle: the sum of the jolts, each a damped wobble.
    let J = 0, JX = 0;
    if (life) for (const k of this.kicks) { const d = t - k.t; if (d >= 0 && d < 3) { const w = Math.exp(-3 * d); J += k.a * w * Math.sin(d * 16); JX += k.side * w * Math.sin(d * 11); } }
    // Pull (dragging the ghost) and its spring back.
    let { dx, dy } = this.pullV;
    if (this.release) { const k = ease.quint(clamp((t - this.release.at) / 0.5)); dx = this.release.dx * (1 - k); dy = this.release.dy * (1 - k); if (k >= 1) this.release = null; }
    const pullK = 1 / (1 + Math.hypot(dx, dy) / 2);
    const stretch = clamp(1 - dy * 0.55 * pullK, 0.6, 1.6);

    const fy = life ? noise(t, 5.3, 0.3) * 0.025 : 0;
    const sx = P.sil.sx * (1 + J * 0.1) / Math.sqrt(stretch), sy = P.sil.sy * (1 - J * 0.1) * stretch;
    const lean = P.lean + JX * 0.12 + dx * 0.5 * pullK + (life ? noise(t, 7.1, 1.4) * 0.02 : 0);
    const tail = P.tail + JX * -0.15 + (life ? noise(t, 6.2, 2.2) * 0.04 : 0) - dx * 0.2 * pullK;
    const wob = life ? 0.004 + Math.abs(J) * 0.02 + Math.abs(JX) * 0.015 : 0;
    const ox = P.offX + dx * 0.25 * pullK, oy = P.offY + fy + dy * 0.12 * pullK;
    const pivot = 1.2; // squash about the bottom of the body

    // Body outline: the profile, squashed, leaned at the top, its tip swinging, a little jelly.
    const { radii, cx, cy } = P.sil, pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const r = radii[i] * (1 + wob * (Math.sin(a * 3 - t * 2.3) + 0.6 * Math.sin(a * 5 + t * 1.7)));
      let x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const v = clamp((y + 1.2) / 2.6);
      x += lean * (1 - v) * 1.4 + tail * Math.max(0, (y - 0.3) / 1.1) ** 2;
      pts.push([x * sx, pivot + (y - pivot) * sy]);
    }
    let d = "";
    for (let i = 0; i < N; i++) {
      const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
      if (!i) d = `M${r3(p1[0])} ${r3(p1[1])}`;
      d += `C${r3(p1[0] + (p2[0] - p0[0]) / 6)} ${r3(p1[1] + (p2[1] - p0[1]) / 6)} ${r3(p2[0] - (p3[0] - p1[0]) / 6)} ${r3(p2[1] - (p3[1] - p1[1]) / 6)} ${r3(p2[0])} ${r3(p2[1])}`;
    }
    d += "Z";
    e.body.setAttribute("d", d);
    e.clip.setAttribute("d", d);
    e.body.setAttribute("opacity", r3(P.bodyA));
    // Small shapes (the "!", the thinking dots) take a deeper lavender, or they vanish on white.
    if (P.tone > 0.01) { e.tone.setAttribute("d", d); e.tone.setAttribute("opacity", r3(P.tone * P.bodyA)); e.tone.removeAttribute("display"); }
    else e.tone.setAttribute("display", "none");
    if (this.ledgeOn && P.ledge && P.ledge.a > 0.01) { e.ledge.setAttribute("y", r3(P.ledge.y)); e.ledge.setAttribute("opacity", r3(P.ledge.a)); e.ledge.removeAttribute("display"); }
    else e.ledge.setAttribute("display", "none");
    e.all.setAttribute("transform", `translate(${r3(ox)} ${r3(oy)})`);
    this.front?.firstElementChild.nextElementSibling.setAttribute("transform", `translate(${r3(ox)} ${r3(oy)})`);
    // A point that rides the body: same lean and squash as the outline.
    const ride = (x, y) => { const v = clamp((y + 1.2) / 2.6); return [(x + lean * (1 - v) * 1.4) * sx, pivot + (y - pivot) * sy]; };

    // Eyes on the sphere: the head pose, a drifting gaze, the pointer, blinks.
    const lk = this.look ? this.lookValue(t) : { yaw: 0, pitch: 0, mix: 0 };
    lk.mix *= this.followAt(t);
    const drift = life ? 1 - lk.mix * 0.7 : 0;
    const g = {
      yaw: lerp(P.gaze.yaw, lk.yaw, lk.mix) + (noise(t, 11.3, 0.4) * 5.5 + noise(t, 3.7, 2.1) * 1.6) * drift,
      pitch: lerp(P.gaze.pitch, lk.pitch, lk.mix) + (noise(t, 9.1, 1.3) * 4.2 + noise(t, 4.3, 0.7) * 1.3) * drift,
      roll: P.gaze.roll + noise(t, 13.7, 3.2) * 2.2 * drift,
    };
    let lid = life ? blinkAt(t) : 1;
    // A blink hides the entry of states that change the face.
    if (life && STATES[this.cur].blink) { const k = (t - this.changeAt) / 0.2; if (k >= 0 && k <= 1) lid = Math.min(lid, k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55); }
    const poses = eyePoses(g, P.split);
    const fs = P.face.s;
    for (let i = 0; i < 2; i++) {
      const E = P.eyes[i], ep = poses[i], el = e.eyes[i];
      const [ex, ey] = ride(P.face.x + ep.x * fs, P.face.y + ep.y * fs);
      const open = 0.06 + 0.94 * clamp(E.open * lid);
      const ct = Math.cos(deg(E.tilt)), st = Math.sin(deg(E.tilt));
      // tangent frame (right = a,b; down = c,d) times the eye's own tilt, then the blink squashes screen y
      const a = (ep.a * ct + ep.c * st) * sx, b = (ep.b * ct + ep.d * st) * sy * open;
      const c = (-ep.a * st + ep.c * ct) * sx, dd = (-ep.b * st + ep.d * ct) * sy * open;
      const w = E.w * fs, h = E.h * fs;
      el.setAttribute("x", r3(-w / 2)); el.setAttribute("y", r3(-h / 2));
      el.setAttribute("width", r3(w)); el.setAttribute("height", r3(h)); el.setAttribute("rx", r3(Math.min(w, h) / 2));
      el.setAttribute("transform", `matrix(${r3(a)} ${r3(b)} ${r3(c)} ${r3(dd)} ${r3(ex)} ${r3(ey)})`);
      el.setAttribute("opacity", ep.depth > 0 ? 1 : 0);
      const bl = e.blush[i];
      const [bx, by] = ride(P.face.x + (ep.x * 1.55) * fs, P.face.y + (ep.y + 0.33) * fs);
      bl.setAttribute("cx", r3(bx)); bl.setAttribute("cy", r3(by));
      bl.setAttribute("opacity", r3(P.blush * 0.6 * P.eyeA * (ep.depth > 0.2 ? 1 : 0)));
    }
    e.eyesG.setAttribute("opacity", r3(P.eyeA));

    // Hands float free, with the body's lean and squash and a lazy bob.
    for (let i = 0; i < 2; i++) {
      const H = P.hands[i], el = e.hands[i];
      const bob = life ? Math.sin(t * 1.85 + i * 1.3) * 0.025 : 0;
      const [hx, hy] = ride(H.x, H.y + bob);
      const hj = J * (i ? -0.12 : 0.12);
      el.setAttribute("cx", r3(hx)); el.setAttribute("cy", r3(hy));
      el.setAttribute("rx", r3(H.r * (1 + hj))); el.setAttribute("ry", r3(H.r * (1 - hj)));
    }
    e.handsG.setAttribute("opacity", r3(P.bodyA));

    // Extra dots (thinking, exclamation point, burst bits, a falling drop).
    const front = [], back = [];
    for (const D of P.dots) {
      if (D.r < 0.002 || D.o < 0.01) continue;
      const [x, y] = ride(D.x, D.y);
      const fill = D.gold ? ACCENT : P.tone > 0.5 ? this.deep : this.grad;
      front.push(`<circle cx="${r3(x)}" cy="${r3(y)}" r="${r3(D.r)}" opacity="${r3(D.o)}" fill="${fill}" stroke="${D.gold ? "#e8c400" : "#d9d7ef"}" stroke-width="0.016"/>`);
    }
    e.dots.innerHTML = front.join("");

    // Rings: tilted circles, the back half drawn before the body so it passes behind.
    const rb = [], rf = [];
    for (const R of P.rings) {
      if (R.o < 0.01) continue;
      const tx = deg(R.tx), tz = deg(R.tz);
      let pb = "", pf = "", side = 0;
      for (let k = 0; k <= 72; k++) {
        const ph = (k / 72) * TAU + R.rot;
        let x = Math.cos(ph) * R.R, y = 0, z = Math.sin(ph) * R.R;
        [y, z] = [y * Math.cos(tx) - z * Math.sin(tx), y * Math.sin(tx) + z * Math.cos(tx)]; // tilt about x
        [x, y] = [x * Math.cos(tz) - y * Math.sin(tz), x * Math.sin(tz) + y * Math.cos(tz)]; // then about z
        const s = z < 0 ? -1 : 1, seg = `${r3(x)} ${r3(y - 0.1)}`;
        if (s < 0) pb += (side === s ? "L" : "M") + seg; else pf += (side === s ? "L" : "M") + seg;
        side = s;
      }
      const stroke = `fill="none" stroke="${R.color}" stroke-width="${R.w}" stroke-linecap="round" opacity="${r3(R.o)}"`;
      rb.push(`<path d="${pb.replaceAll("|", "")}" ${stroke}/>`);
      rf.push(`<path d="${pf.replaceAll("|", "")}" ${stroke}/>`);
    }
    e.back.innerHTML = rb.join("");
    e.front.innerHTML = rf.join("");

    // Sleep letters: a "Z" drawn as three strokes.
    e.zs.innerHTML = P.zs.filter((z) => z.o > 0.01).map((z) => {
      const h = z.s;
      return `<path d="M${r3(z.x - h)} ${r3(z.y - h)}H${r3(z.x + h)}L${r3(z.x - h)} ${r3(z.y + h)}H${r3(z.x + h)}" stroke-width="${r3(h * 0.32)}" opacity="${r3(z.o)}"/>`;
    }).join("");

    // The "found" badge and the scan line.
    if (P.badge && P.badge.r > 0.005) {
      const [bx, by] = ride(P.badge.x, P.badge.y);
      e.badge.setAttribute("cx", r3(bx)); e.badge.setAttribute("cy", r3(by)); e.badge.setAttribute("r", r3(P.badge.r));
      e.badge.removeAttribute("display");
    } else e.badge.setAttribute("display", "none");
    if (P.scan && P.scan.a > 0.01) {
      e.scan.setAttribute("y", r3(P.scan.y)); e.scan.setAttribute("opacity", r3(P.scan.a * 0.85)); e.scan.removeAttribute("display");
    } else e.scan.setAttribute("display", "none");

    // Ground shadow: follows the body's width; lighter when the body fades or floats up.
    if (e.shadow) {
      let lo = 9, hi = -9;
      for (const [x] of pts) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const k = clamp(1 - oy * 1.2, 0.4, 1.2);
      e.shadow.setAttribute("cx", r3(ox + tail * 0.3)); e.shadow.setAttribute("cy", 1.68);
      e.shadow.setAttribute("rx", r3(0.42 * k * Math.max(0.12, hi - lo))); e.shadow.setAttribute("ry", r3(0.065 * k));
      e.shadow.setAttribute("opacity", r3(0.14 * k * P.bodyA));
    }
  }

  // Let people poke and pull the ghost like dough. With a mouse the grab is immediate; a finger
  // must rest on the ghost a moment first, so a swipe over it still scrolls, and a tap is a poke.
  grabbable() {
    const svg = this.svg;
    svg.classList.add("mascot-grab");
    let grip = null, hold = 0, down = null;
    const toUnits = (ev) => { const m = svg.getScreenCTM(); if (!m) return [0, 0]; const q = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()); return [q.x, q.y]; };
    const start = (ev) => { grip = { at: toUnits(ev) }; this.release = null; try { svg.setPointerCapture(ev.pointerId); } catch { /* pointer gone */ } this.kick(0.5); };
    svg.addEventListener("pointerdown", (ev) => {
      if (this.reduced) return;
      if (ev.pointerType === "mouse") { start(ev); return; }
      down = ev;
      hold = setTimeout(() => { hold = 0; if (down) start(down); }, 280);
    });
    svg.addEventListener("pointermove", (ev) => {
      if (!grip) { if (!ev.buttons && ev.pointerType === "mouse") this.lookAt(ev.clientX, ev.clientY); return; }
      const [x, y] = toUnits(ev);
      this.pullV = { dx: x - grip.at[0], dy: y - grip.at[1] };
      this.lookAt(ev.clientX, ev.clientY);
    });
    svg.addEventListener("pointerleave", () => { if (!grip) this.lookAt(null); });
    svg.addEventListener("touchmove", (ev) => { if (grip) ev.preventDefault(); }, { passive: false });
    const end = (ev) => {
      if (hold) { clearTimeout(hold); hold = 0; if (ev.type === "pointerup") this.poke(); }
      down = null;
      if (!grip) return;
      grip = null;
      const { dx, dy } = this.pullV;
      this.pullV = { dx: 0, dy: 0 };
      this.release = { dx, dy, at: this.now() };
      this.kick(Math.min(2.2, 0.5 + Math.hypot(dx, dy) * 2), clamp(-dx * 3, -1.6, 1.6));
      this.lookAt(null);
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
  }

  // A quick tap: a startled jiggle and a short happy squint.
  poke() {
    this.kick(1.3, (Math.random() - 0.5) * 1.6);
    const back = this.expr;
    this.setExpression("happy");
    clearTimeout(this.pokeT);
    this.pokeT = setTimeout(() => { this.exprPrev = this.currentExpr(this.now()); this.exprAt = this.now(); this.expr = back; }, 900);
  }

  destroy() { live.delete(this); this.io?.disconnect(); this.svg.remove(); this.front?.remove(); }
}

export function createMascot(host, opts) { return new Mascot(host, opts); }
