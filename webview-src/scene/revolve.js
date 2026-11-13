// Геометрия тел вращения. Без зависимостей — проверяется тестами в Node.
//
// Образующая (профиль) — ломаная из точек { r, y } снизу вверх: r — расстояние от оси,
// y — высота. Ось вращения — Y. Угол theta отсчитывается от +Z (сторона, обращённая
// к камере) в сторону +X, поэтому надпись читается слева направо.

const SMOOTH_COS = Math.cos((30 * Math.PI) / 180); // порог излома образующей

/** Цилиндр: вертикальная образующая, центр формы в нуле. */
export function cylinderProfile(radius, height) {
  return [
    { r: radius, y: -height / 2 },
    { r: radius, y: height / 2 },
  ];
}

/** Усечённый конус: внизу radiusBottom, вверху radiusTop, центр формы в нуле. */
export function coneProfile(radiusBottom, radiusTop, height) {
  return [
    { r: radiusBottom, y: -height / 2 },
    { r: radiusTop, y: height / 2 },
  ];
}

/** Сфера: полуокружность от нижнего полюса до верхнего. */
export function sphereProfile(radius, segments = 64) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / segments;
    // на полюсах радиус ровно ноль, без погрешности косинуса
    const r = i === 0 || i === segments ? 0 : radius * Math.cos(phi);
    points.push({ r, y: radius * Math.sin(phi) });
  }
  return points;
}

/** Длина образующей. */
export function profileLength(profile) {
  let total = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    total += Math.hypot(profile[i + 1].r - profile[i].r, profile[i + 1].y - profile[i].y);
  }
  return total;
}

/** Радиус формы на расстоянии s вдоль образующей (от нижней точки); за концами — радиус края. */
export function radiusAt(profile, s) {
  if (s <= 0) return profile[0].r;
  let start = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const len = Math.hypot(profile[i + 1].r - profile[i].r, profile[i + 1].y - profile[i].y);
    if (len > 0 && s <= start + len) {
      return profile[i].r + ((profile[i + 1].r - profile[i].r) * (s - start)) / len;
    }
    start += len;
  }
  return profile[profile.length - 1].r;
}

/**
 * Длина вдоль образующей до точки на высоте y. Если на этой высоте образующая проходит
 * несколько раз, берётся внешняя поверхность (наибольший радиус). За пределами формы —
 * ближайший по высоте край.
 */
export function sAtHeight(profile, y) {
  let best = null;
  let nearest = { s: 0, distance: Infinity };
  let start = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const p0 = profile[i];
    const p1 = profile[i + 1];
    const len = Math.hypot(p1.r - p0.r, p1.y - p0.y);
    if (y >= Math.min(p0.y, p1.y) && y <= Math.max(p0.y, p1.y)) {
      // горизонтальный отрезок: берём его внешний конец
      const t = p1.y === p0.y ? (p0.r >= p1.r ? 0 : 1) : (y - p0.y) / (p1.y - p0.y);
      const r = p0.r + (p1.r - p0.r) * t;
      if (!best || r > best.r) best = { s: start + len * t, r };
    }
    if (Math.abs(p0.y - y) < nearest.distance) nearest = { s: start, distance: Math.abs(p0.y - y) };
    if (Math.abs(p1.y - y) < nearest.distance) nearest = { s: start + len, distance: Math.abs(p1.y - y) };
    start += len;
  }
  return best ? best.s : nearest.s;
}

/**
 * Строит участок поверхности под надписью.
 *   thetaCenter, thetaSpan — центр и ширина участка по углу, радианы
 *   sCenter, sLength       — центр и длина участка вдоль образующей (от её нижней точки)
 *   thetaSegments          — число делений по углу
 * Текстурные координаты: u — слева направо, v — сверху вниз (v = 0 — верх надписи).
 * Часть надписи, выходящая за концы образующей, отрезается.
 * Возвращает { positions, normals, uvs, indices } или null, если участок пуст.
 */
export function buildPatch(profile, o) {
  const segs = Math.max(1, Math.round(o.thetaSegments || 64));
  if (!(o.sLength > 0) || !(o.thetaSpan > 0) || profile.length < 2) return null;

  const sTop = o.sCenter + o.sLength / 2;
  const sBottom = o.sCenter - o.sLength / 2;

  // Отрезки образующей и их нормали в плоскости профиля (наружу от оси).
  const segments = [];
  let sStart = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const p0 = profile[i];
    const p1 = profile[i + 1];
    const dr = p1.r - p0.r;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dr, dy);
    if (len > 0) segments.push({ p0, dr, dy, len, sStart, nr: dy / len, ny: -dr / len });
    sStart += len;
  }
  // В узлах плавной образующей нормали соседних отрезков усредняются — иначе при затенении
  // видны полосы. На изломе (угол больше 30°) каждая сторона сохраняет свою нормаль.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    seg.n0 = [seg.nr, seg.ny];
    seg.n1 = [seg.nr, seg.ny];
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    if (a.nr * b.nr + a.ny * b.ny > SMOOTH_COS) {
      const nr = a.nr + b.nr;
      const ny = a.ny + b.ny;
      const d = Math.hypot(nr, ny);
      a.n1 = [nr / d, ny / d];
      b.n0 = a.n1;
    }
  }

  // Кольца: по два на каждый отрезок образующей, попавший под надпись.
  const rings = [];
  for (const seg of segments) {
    const lo = Math.max(sBottom, seg.sStart);
    const hi = Math.min(sTop, seg.sStart + seg.len);
    if (!(hi - lo > 1e-9)) continue;
    for (const s of [lo, hi]) {
      const t = (s - seg.sStart) / seg.len;
      let nr = seg.n0[0] + (seg.n1[0] - seg.n0[0]) * t;
      let ny = seg.n0[1] + (seg.n1[1] - seg.n0[1]) * t;
      const d = Math.hypot(nr, ny) || 1;
      nr /= d;
      ny /= d;
      rings.push({ r: seg.p0.r + seg.dr * t, y: seg.p0.y + seg.dy * t, nr, ny, v: (sTop - s) / o.sLength });
    }
  }
  if (rings.length === 0) return null;

  const perRing = segs + 1;
  const vertexCount = rings.length * perRing;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array((rings.length / 2) * segs * 6);

  const theta0 = o.thetaCenter - o.thetaSpan / 2;
  let p = 0;
  let q = 0;
  for (const ring of rings) {
    for (let j = 0; j <= segs; j++) {
      const u = j / segs;
      const theta = theta0 + o.thetaSpan * u;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      positions[p] = ring.r * sin;
      positions[p + 1] = ring.y;
      positions[p + 2] = ring.r * cos;
      normals[p] = ring.nr * sin;
      normals[p + 1] = ring.ny;
      normals[p + 2] = ring.nr * cos;
      p += 3;
      uvs[q] = u;
      uvs[q + 1] = ring.v;
      q += 2;
    }
  }

  let k = 0;
  for (let ringPair = 0; ringPair < rings.length; ringPair += 2) {
    const lower = ringPair * perRing;
    const upper = (ringPair + 1) * perRing;
    for (let j = 0; j < segs; j++) {
      const a = lower + j;
      const b = lower + j + 1;
      const c = upper + j;
      const d = upper + j + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = c;
    }
  }

  return { positions, normals, uvs, indices };
}
