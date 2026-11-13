// Параметры сцены и расчёты над ними. Без зависимостей — проверяются тестами в Node.
//
// Единицы: пиксели документа, градусы, проценты. Структура:
//   shape     — форма и её размеры
//   transform — положение формы в документе: центр, масштаб, наклоны
//   placement — надпись на форме: по высоте, вокруг оси, масштаб, угол охвата
//   camera    — ортогональная или перспективная, угол обзора

import { coneProfile, cylinderProfile, radiusAt, sAtHeight, sphereProfile } from "./revolve.js";
import { defaultProfile, profileBounds, sampleProfile } from "./profile.js";

const DEG = Math.PI / 180;

export const DEFAULT_WRAP_ANGLE = 120;
const DEFAULT_CONE_RATIO = 0.7; // верхний радиус конуса относительно нижнего
const SPHERE_SEGMENTS = 96;
const TILT_DEG_PER_PX = 0.25; // чувствительность наклона при перетаскивании

/** Границы и шаг числовых полей. Ключ — путь к параметру. */
export const FIELDS = {
  "shape.radius": { min: 1, max: 100000, step: 1, unit: "px" },
  "shape.radiusTop": { min: 0, max: 100000, step: 1, unit: "px" },
  "shape.radiusBottom": { min: 0, max: 100000, step: 1, unit: "px" },
  "shape.height": { min: 1, max: 100000, step: 1, unit: "px" },
  "transform.x": { min: -1000000, max: 1000000, step: 1, unit: "px" },
  "transform.y": { min: -1000000, max: 1000000, step: 1, unit: "px" },
  "transform.scale": { min: 1, max: 10000, step: 1, unit: "%" },
  "transform.tilt": { min: -89, max: 89, step: 0.5, unit: "°" },
  "transform.roll": { min: -180, max: 180, step: 0.5, unit: "°" },
  "placement.offset": { min: -1000000, max: 1000000, step: 1, unit: "px" },
  "placement.rotation": { min: -180, max: 180, step: 0.5, unit: "°", wrap: true },
  "placement.scale": { min: 1, max: 10000, step: 1, unit: "%" },
  "placement.wrapAngle": { min: 1, max: 360, step: 0.5, unit: "°" },
  "camera.fov": { min: 5, max: 100, step: 1, unit: "°" },
  "light.strength": { min: 0, max: 100, step: 1, unit: "%" },
  "ui.backdropOpacity": { min: 0, max: 100, step: 1, unit: "%" },
  "ui.formOpacity": { min: 0, max: 100, step: 1, unit: "%" },
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Приводит значение поля к допустимому. null — если это не число. */
export function clampField(path, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const f = FIELDS[path];
  if (!f) return v;
  if (f.wrap) {
    const span = f.max - f.min;
    return ((((v - f.min) % span) + span) % span) + f.min;
  }
  return clamp(v, f.min, f.max);
}

/** Независимая копия параметров, вместе с точками контура. */
export function cloneParams(params) {
  return {
    shape: { ...params.shape, points: params.shape.points ? params.shape.points.map((p) => ({ ...p })) : null },
    transform: { ...params.transform },
    placement: { ...params.placement },
    camera: { ...params.camera },
    light: { ...params.light },
  };
}

/**
 * Начальная сцена для надписи. label — прямоугольник надписи в документе
 * { left, top, width, height }.
 * Радиус подбирается так, чтобы дуга под надписью равнялась её ширине, — тогда надпись
 * не растянута и не сжата. Центр формы — в центре надписи.
 */
export function defaultParams(label) {
  const radius = label.width / (DEFAULT_WRAP_ANGLE * DEG);
  return {
    shape: {
      type: "cylinder",
      radius,
      height: label.height * 2,
      radiusTop: radius * DEFAULT_CONE_RATIO,
      radiusBottom: radius,
      points: null, // контур тела вращения; создаётся при первом переходе к нему
    },
    transform: {
      x: label.left + label.width / 2,
      y: label.top + label.height / 2,
      scale: 100,
      tilt: 0,
      roll: 0,
    },
    placement: {
      offset: 0,
      rotation: 0,
      scale: 100,
      wrapAngle: DEFAULT_WRAP_ANGLE,
      linked: true,
      hideBack: true,
    },
    camera: {
      type: "ortho",
      fov: 30,
    },
    // По умолчанию без затенения: цвета надписи не меняются.
    light: {
      shading: false,
      strength: 50,
    },
  };
}

const SHAPE_TYPES = ["cylinder", "sphere", "cone", "lathe"];

/**
 * Проверяет параметры, прочитанные из сохранённой сцены: числа приводятся к границам полей,
 * недостающее берётся из значений по умолчанию. null — если данные не похожи на сцену.
 */
export function sanitizeParams(saved) {
  if (!saved || typeof saved !== "object") return null;
  const { shape, transform, placement, camera } = saved;
  if (![shape, transform, placement, camera].every((part) => part && typeof part === "object")) return null;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  if (![shape.radius, shape.height, transform.x, transform.y].every(finite)) return null;

  const num = (path, value, fallback) => (finite(value) ? clampField(path, value) : fallback);
  const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  const light = saved.light && typeof saved.light === "object" ? saved.light : {};
  const radius = num("shape.radius", shape.radius, 100);

  let points = null;
  if (Array.isArray(shape.points)) {
    const ok = shape.points.every((p) => p && finite(p.r) && finite(p.y) && p.r >= 0);
    if (ok && shape.points.length >= 2) points = shape.points.map((p) => ({ r: p.r, y: p.y, smooth: !!p.smooth }));
  }
  let type = SHAPE_TYPES.includes(shape.type) ? shape.type : "cylinder";
  if (type === "lathe" && !points) type = "cylinder";

  return {
    shape: {
      type,
      radius,
      height: num("shape.height", shape.height, 100),
      radiusTop: num("shape.radiusTop", shape.radiusTop, radius * DEFAULT_CONE_RATIO),
      radiusBottom: num("shape.radiusBottom", shape.radiusBottom, radius),
      points,
    },
    transform: {
      x: num("transform.x", transform.x, 0),
      y: num("transform.y", transform.y, 0),
      scale: num("transform.scale", transform.scale, 100),
      tilt: num("transform.tilt", transform.tilt, 0),
      roll: num("transform.roll", transform.roll, 0),
    },
    placement: {
      offset: num("placement.offset", placement.offset, 0),
      rotation: num("placement.rotation", placement.rotation, 0),
      scale: num("placement.scale", placement.scale, 100),
      wrapAngle: num("placement.wrapAngle", placement.wrapAngle, DEFAULT_WRAP_ANGLE),
      linked: flag(placement.linked, true),
      hideBack: flag(placement.hideBack, true),
    },
    camera: {
      type: camera.type === "persp" ? "persp" : "ortho",
      fov: num("camera.fov", camera.fov, 30),
    },
    light: {
      shading: flag(light.shading, false),
      strength: num("light.strength", light.strength, 50),
    },
  };
}

/** Образующая формы: ломаная { r, y } снизу вверх. */
export function shapeProfile(shape) {
  if (shape.type === "lathe") return sampleProfile(shape.points);
  if (shape.type === "sphere") return sphereProfile(shape.radius, SPHERE_SEGMENTS);
  if (shape.type === "cone") return coneProfile(shape.radiusBottom, shape.radiusTop, shape.height);
  return cylinderProfile(shape.radius, shape.height);
}

/**
 * Радиус формы под центром надписи. Положение по высоте — это высота в системе формы
 * (от её начала координат), а не расстояние вдоль образующей: при правке контура
 * в другом месте надпись остаётся на своей высоте.
 */
function referenceRadius(params, profile) {
  return Math.max(radiusAt(profile, sAtHeight(profile, params.placement.offset)), 0.001);
}

/** Переводит параметры размещения в аргументы buildPatch. */
export function resolvePlacement(params, label) {
  const profile = shapeProfile(params.shape);
  const pl = params.placement;
  const wrap = clamp(pl.wrapAngle, 0.01, 360);
  return {
    profile,
    thetaCenter: pl.rotation * DEG,
    thetaSpan: wrap * DEG,
    sCenter: sAtHeight(profile, pl.offset),
    sLength: (label.height * pl.scale) / 100,
    thetaSegments: clamp(Math.ceil((wrap / 360) * 256), 32, 256),
  };
}

/**
 * Поддерживает пропорции надписи, если включено «Сохранять пропорции».
 * changed — что изменил пользователь: при "wrapAngle" под угол подстраивается масштаб,
 * во всех остальных случаях под масштаб подстраивается угол охвата.
 */
export function syncLinked(params, label, changed) {
  const pl = params.placement;
  if (!pl.linked) return params;
  const radius = referenceRadius(params, shapeProfile(params.shape));
  if (changed === "wrapAngle") {
    pl.scale = clamp(((pl.wrapAngle * DEG * radius) / label.width) * 100, FIELDS["placement.scale"].min, FIELDS["placement.scale"].max);
  } else {
    const angle = ((label.width * pl.scale) / 100 / radius) / DEG;
    pl.wrapAngle = clamp(angle, FIELDS["placement.wrapAngle"].min, FIELDS["placement.wrapAngle"].max);
  }
  return params;
}

/** Меняет форму, перенося размеры из прежней. */
export function setShapeType(params, type, label) {
  const shape = params.shape;
  const from = shape.type;
  if (type === from) return params;
  if (from === "lathe") {
    // размеры простой формы берутся по нарисованному контуру
    const bounds = profileBounds(shape.points);
    shape.radius = Math.max(referenceRadius(params, shapeProfile(shape)), FIELDS["shape.radius"].min);
    shape.height = Math.max(bounds.maxY - bounds.minY, FIELDS["shape.height"].min);
    shape.radiusBottom = shape.points[0].r;
    shape.radiusTop = shape.points[shape.points.length - 1].r;
  } else if (type === "cone") {
    const ratio = shape.radiusBottom > 0 ? shape.radiusTop / shape.radiusBottom : DEFAULT_CONE_RATIO;
    shape.radiusBottom = shape.radius;
    shape.radiusTop = shape.radius * ratio;
  } else if (from === "cone") {
    shape.radius = Math.max(shape.radiusTop, shape.radiusBottom, FIELDS["shape.radius"].min);
  }
  // нарисованный контур не пересоздаётся: возврат к телу вращения его сохраняет
  if (type === "lathe" && !shape.points) shape.points = defaultProfile(shape);
  shape.type = type;
  return syncLinked(params, label, "shape");
}

/**
 * Матрица формы 4×4 (по столбцам): масштаб → наклон к себе (вокруг X) → наклон вбок
 * (в плоскости картинки, вокруг Z) → перенос в точку документа.
 * Положительный наклон к себе приближает верх формы к зрителю, положительный наклон вбок
 * валит верх вправо. Ось Y документа направлена вниз, поэтому y меняет знак.
 */
export function shapeMatrix(transform) {
  const k = transform.scale / 100;
  const a = transform.tilt * DEG;
  const b = -transform.roll * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  // R = Rz(b) · Rx(a)
  return [
    cb * k, sb * k, 0, 0,
    -sb * ca * k, cb * ca * k, sa * k, 0,
    sb * sa * k, -cb * sa * k, ca * k, 0,
    transform.x, -transform.y, 0, 1,
  ];
}

/**
 * Положение камеры. Камера смотрит на центр документа; в полном кадре плоскость документа
 * (z = 0) занимает кадр целиком, поэтому результат попадает точно на своё место.
 * fov — вертикальный угол обзора для перспективной камеры.
 */
export function cameraSetup(doc, camera) {
  if (camera.type === "persp") {
    const fov = clamp(camera.fov, FIELDS["camera.fov"].min, FIELDS["camera.fov"].max);
    const distance = doc.height / 2 / Math.tan((fov * DEG) / 2);
    return { type: "persp", fov, distance, near: distance * 0.02, far: distance * 20 };
  }
  const distance = 10 * Math.max(doc.width, doc.height, 1000);
  return { type: "ortho", fov: camera.fov, distance, near: distance * 0.5, far: distance * 1.5 };
}

/**
 * Перетаскивание во вьюпорте. start — параметры в момент нажатия, d — полный сдвиг с этого
 * момента: dxDoc, dyDoc в пикселях документа, dxCss, dyCss в пикселях окна.
 * Возвращает новые параметры, start не меняет.
 */
export function applyDrag(mode, start, d, label) {
  const next = cloneParams(start);
  if (mode === "label") {
    const k = start.transform.scale / 100;
    const radius = referenceRadius(start, shapeProfile(start.shape));
    next.placement.rotation = clampField("placement.rotation", start.placement.rotation + d.dxDoc / (radius * k) / DEG);
    next.placement.offset = clampField("placement.offset", start.placement.offset - d.dyDoc / k);
    syncLinked(next, label, "offset");
  } else if (mode === "tilt") {
    next.transform.roll = clampField("transform.roll", start.transform.roll + d.dxCss * TILT_DEG_PER_PX);
    next.transform.tilt = clampField("transform.tilt", start.transform.tilt + d.dyCss * TILT_DEG_PER_PX);
  } else {
    next.transform.x = clampField("transform.x", start.transform.x + d.dxDoc);
    next.transform.y = clampField("transform.y", start.transform.y + d.dyDoc);
  }
  return next;
}

/** Масштабирование колесом: в режиме «Надпись» — надписи, иначе — формы целиком. */
export function applyScale(mode, start, factor, label) {
  const next = cloneParams(start);
  if (mode === "label") {
    next.placement.scale = clampField("placement.scale", start.placement.scale * factor);
    syncLinked(next, label, "scale");
  } else {
    next.transform.scale = clampField("transform.scale", start.transform.scale * factor);
  }
  return next;
}
