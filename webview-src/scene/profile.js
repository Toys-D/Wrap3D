// Контур тела вращения: опорные точки половины профиля и операции над ними.
// Без зависимостей — проверяется тестами в Node.
//
// Точка: { r, y, smooth } — r — расстояние от оси (не меньше нуля), y — высота в системе формы
// (вверх), smooth — сглаженная или острая. Точки идут вдоль контура по порядку.

const DEG = Math.PI / 180;
const SAMPLE_STEP = 6; // шаг разбиения кривой, пиксели

const point = (r, y, smooth) => ({ r, y, smooth });

/**
 * Начальный контур при переходе к телу вращения. Из конуса — сам конус; из цилиндра и сферы —
 * бутылка: прямое тело, плечи и горлышко. На высоте центра формы радиус прежний,
 * поэтому надпись остаётся на месте.
 */
export function defaultProfile(shape) {
  if (shape.type === "cone") {
    return [point(shape.radiusBottom, -shape.height / 2, false), point(shape.radiusTop, shape.height / 2, false)];
  }
  const R = shape.radius;
  const H = shape.type === "sphere" ? shape.radius * 2 : shape.height;
  return [
    point(R, -0.5 * H, false),
    point(R, 0.1 * H, false),
    point(0.97 * R, 0.17 * H, true),
    point(0.5 * R, 0.3 * H, true),
    point(0.36 * R, 0.38 * H, true),
    point(0.36 * R, 0.5 * H, false),
  ];
}

/** Касательная в опорной точке для отрезка длиной len с хордой chord. */
function tangentAt(points, i, len, chord) {
  const p = points[i];
  const prev = points[i - 1];
  const next = points[i + 1];
  // Острая точка и концы контура: касательная вдоль своего отрезка — получается излом.
  if (!p.smooth || !prev || !next) return chord;
  const dr = next.r - prev.r;
  const dy = next.y - prev.y;
  const d = Math.hypot(dr, dy);
  if (d === 0) return chord;
  // Сглаженная точка: направление — от предыдущей точки к следующей, длина — по своему отрезку,
  // чтобы при неравных расстояниях между точками кривая не делала петель.
  return [(dr / d) * len, (dy / d) * len];
}

/**
 * Превращает опорные точки в плотную ломаную { r, y } для построения поверхности.
 * Между острыми точками — прямая, через сглаженные проходит плавная кривая.
 */
export function sampleProfile(points) {
  const out = [{ r: Math.max(0, points[0].r), y: points[0].y }];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const chord = [p1.r - p0.r, p1.y - p0.y];
    const len = Math.hypot(chord[0], chord[1]);
    if (len > 0) {
      const t0 = tangentAt(points, i, len, chord);
      const t1 = tangentAt(points, i + 1, len, chord);
      if (t0 !== chord || t1 !== chord) {
        const steps = Math.min(48, Math.max(4, Math.ceil(len / SAMPLE_STEP)));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          out.push({
            r: Math.max(0, h00 * p0.r + h10 * t0[0] + h01 * p1.r + h11 * t1[0]),
            y: h00 * p0.y + h10 * t0[1] + h01 * p1.y + h11 * t1[1],
          });
        }
      }
    }
    out.push({ r: Math.max(0, p1.r), y: p1.y });
  }
  return out;
}

/** Границы контура по опорным точкам. */
export function profileBounds(points) {
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.r > maxR) maxR = p.r;
  }
  return { minY, maxY, maxR };
}

// ---------- координаты ----------
// Редактор плоский: точка формы (r, y) лежит в плоскости картинки. Наклон к себе и перспектива
// здесь не участвуют — контур обводится по фото «в лоб».

/** Точка формы → точка документа. Радиус откладывается вправо от оси, высота — вверх по оси. */
export function localToDoc(transform, r, y) {
  const k = transform.scale / 100;
  const cos = Math.cos(transform.roll * DEG);
  const sin = Math.sin(transform.roll * DEG);
  return {
    x: transform.x + k * (r * cos + y * sin),
    y: transform.y + k * (r * sin - y * cos),
  };
}

/** Точка документа → точка формы. Слева от оси радиус отрицательный. */
export function docToLocal(transform, x, y) {
  const k = transform.scale / 100;
  const cos = Math.cos(transform.roll * DEG);
  const sin = Math.sin(transform.roll * DEG);
  const dx = (x - transform.x) / k;
  const dy = (y - transform.y) / k;
  return { r: dx * cos + dy * sin, y: dx * sin - dy * cos };
}

// ---------- правка точек ----------
// Все функции возвращают новый массив и не меняют исходный.

const copy = (points) => points.map((p) => ({ ...p }));

/**
 * Добавляет сглаженную точку: в ближайший отрезок контура, а если точка лежит за его концом —
 * в начало или в конец. Возвращает { points, index }.
 */
export function insertPoint(points, r, y) {
  const next = copy(points);
  const added = point(Math.abs(r), y, true);
  let bestSegment = 0;
  let bestT = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dr = b.r - a.r;
    const dy = b.y - a.y;
    const len2 = dr * dr + dy * dy;
    const t = len2 > 0 ? ((added.r - a.r) * dr + (added.y - a.y) * dy) / len2 : 0;
    const c = Math.min(1, Math.max(0, t));
    const distance = Math.hypot(added.r - (a.r + dr * c), added.y - (a.y + dy * c));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = i;
      bestT = t;
    }
  }
  let index = bestSegment + 1;
  if (bestSegment === 0 && bestT < 0) index = 0;
  else if (bestSegment === points.length - 2 && bestT > 1) index = points.length;
  next.splice(index, 0, added);
  return { points: next, index };
}

/** Двигает точку; за ось вращения она не уходит. */
export function movePoint(points, index, r, y) {
  const next = copy(points);
  next[index].r = Math.max(0, r);
  next[index].y = y;
  return next;
}

/** Удаляет точку; двух точек контур не лишается. */
export function removePoint(points, index) {
  const next = copy(points);
  if (next.length > 2) next.splice(index, 1);
  return next;
}

/** Переключает точку между острой и сглаженной. */
export function toggleSmooth(points, index) {
  const next = copy(points);
  next[index].smooth = !next[index].smooth;
  return next;
}

/** Индекс ближайшей опорной точки в пределах tolerance, иначе −1. */
export function hitPoint(points, r, y, tolerance) {
  let best = -1;
  let bestDistance = tolerance;
  for (let i = 0; i < points.length; i++) {
    const distance = Math.hypot(points[i].r - r, points[i].y - y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
