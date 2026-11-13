// Пресеты контура тела вращения. Без зависимостей — проверяется тестами в Node.
//
// Пресет хранит пропорции контура, а не пиксели: высота приведена к 0…1, радиус — в долях
// высоты. При применении контур подгоняется под высоту и положение текущего, поэтому форма,
// уже совмещённая с фото, не теряет размер.
//
// Пресет: { id, name, points: [{ r, y, smooth }] }.

import { profileBounds } from "./profile.js";

/** Контур в пропорциях: y — от 0 (низ) до 1 (верх), r — в долях высоты. */
export function normalizeProfile(points) {
  const bounds = profileBounds(points);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-9);
  return points.map((p) => ({ r: p.r / height, y: (p.y - bounds.minY) / height, smooth: !!p.smooth }));
}

/** Разворачивает пропорции в контур с границами bounds: { minY, maxY }. */
export function fitProfile(normalized, bounds) {
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  return normalized.map((p) => ({ r: p.r * height, y: bounds.minY + p.y * height, smooth: !!p.smooth }));
}

function nextId(list) {
  let max = 0;
  for (const preset of list) {
    const n = Number(String(preset.id).replace(/^p/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return "p" + (max + 1);
}

function autoName(list, base) {
  for (let n = list.length + 1; ; n++) {
    const name = base + " " + n;
    if (!list.some((preset) => preset.name === name)) return name;
  }
}

/**
 * Сохраняет контур как пресет и возвращает новый список. Пустое название заменяется
 * на «<autoBase> N»; пресет с тем же названием перезаписывается.
 */
export function addPreset(list, name, points, autoBase) {
  const next = list.map((preset) => ({ ...preset }));
  const normalized = normalizeProfile(points);
  const clean = String(name || "").trim();
  if (clean) {
    const existing = next.findIndex((preset) => preset.name === clean);
    if (existing >= 0) {
      next[existing] = { ...next[existing], points: normalized };
      return next;
    }
  }
  next.push({ id: nextId(next), name: clean || autoName(next, autoBase), points: normalized });
  return next;
}

export function removePreset(list, id) {
  return list.filter((preset) => preset.id !== id).map((preset) => ({ ...preset }));
}

/** Проверяет список, прочитанный из файла: испорченные записи отбрасываются. */
export function sanitizePresets(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string") continue;
    if (!Array.isArray(item.points) || item.points.length < 2) continue;
    const valid = item.points.every(
      (p) => p && typeof p.r === "number" && typeof p.y === "number" && Number.isFinite(p.r) && Number.isFinite(p.y) && p.r >= 0,
    );
    if (!valid) continue;
    out.push({ id: item.id, name: item.name, points: item.points.map((p) => ({ r: p.r, y: p.y, smooth: !!p.smooth })) });
  }
  return out;
}
