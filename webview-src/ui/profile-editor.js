// Редактор контура тела вращения: плоское поле поверх снимка документа.
//
//   клик по пустому месту        — новая точка (её сразу можно тянуть)
//   тянуть точку                 — двигать
//   двойной клик по точке        — острая / сглаженная
//   Delete или Backspace         — удалить выбранную точку
//   квадрат на оси               — сдвиг оси, кружок на конце оси — её наклон
//   колесо, пробел или правая кнопка + тянуть — масштаб и сдвиг вида
//
// Пользователь рисует правую половину профиля; левая показывается зеркально.

import { clampField, cloneParams } from "../scene/params.js";
import {
  docToLocal,
  insertPoint,
  localToDoc,
  movePoint,
  profileBounds,
  removePoint,
  sampleProfile,
  toggleSmooth,
} from "../scene/profile.js";
import { viewToDoc } from "../scene/view.js";
import { isEditable, keys } from "./keys.js";

const POINT_HIT = 9; // допуск попадания в точку, пиксели окна
const HANDLE_HIT = 11;
const ROTATE_GAP = 34; // от верха контура до ручки наклона, пиксели окна
const COLOR = "#ffd24a";
const COLOR_DIM = "rgba(255, 210, 74, 0.55)";
const HALO = "rgba(0, 0, 0, 0.6)";

/**
 * options:
 *   canvas, container
 *   getView()      вид вьюпорта { x, y, w, h, scale }
 *   getParams()    параметры сцены
 *   canEdit()      можно ли менять сцену
 *   onChange(next) новые параметры сцены
 *   onSelect()     сменилась выбранная точка
 *   onPan(dx, dy), onZoom(factor, x, y), onScale(factor)
 */
export function createProfileEditor(options) {
  const { canvas, container } = options;
  const ctx = canvas.getContext("2d");
  let active = false;
  let selected = -1;
  let drag = null;
  let cssW = 0;
  let cssH = 0;

  const scene = () => {
    const params = options.getParams();
    const view = options.getView();
    if (!active || !params || !view || params.shape.type !== "lathe" || !params.shape.points) return null;
    return { params, view };
  };

  const toCss = (view, doc) => ({ x: (doc.x - view.x) * view.scale, y: (doc.y - view.y) * view.scale });
  const localCss = (s, r, y) => toCss(s.view, localToDoc(s.params.transform, r, y));

  /** Ручки оси: начало координат формы и конец оси над контуром. */
  function axisHandles(s) {
    const t = s.params.transform;
    const origin = toCss(s.view, { x: t.x, y: t.y });
    const roll = (t.roll * Math.PI) / 180;
    const up = { x: Math.sin(roll), y: -Math.cos(roll) };
    const top = Math.max(profileBounds(s.params.shape.points).maxY, 0) * (t.scale / 100) * s.view.scale;
    const reach = Math.max(60, top + ROTATE_GAP);
    return { origin, up, rotate: { x: origin.x + up.x * reach, y: origin.y + up.y * reach } };
  }

  function position(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitControlPoint(s, p) {
    const points = s.params.shape.points;
    let best = -1;
    let bestDistance = POINT_HIT;
    for (let i = 0; i < points.length; i++) {
      const c = localCss(s, points[i].r, points[i].y);
      const distance = Math.hypot(c.x - p.x, c.y - p.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  function commitPoints(s, points) {
    const next = cloneParams(s.params);
    next.shape.points = points;
    options.onChange(next);
  }

  function select(index) {
    if (index === selected) return;
    selected = index;
    options.onSelect();
    draw();
  }

  // ---------- отрисовка ----------

  function resize() {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssW = Math.max(1, Math.floor(rect.width));
    cssH = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    draw();
  }

  function path(points) {
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  }

  function stroke(points, color, width) {
    path(points);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = HALO;
    ctx.lineWidth = width + 2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const s = scene();
    if (!s) return;

    const points = s.params.shape.points;
    if (selected >= points.length) selected = -1;
    const dense = sampleProfile(points);
    const right = dense.map((p) => localCss(s, p.r, p.y));
    const left = dense.map((p) => localCss(s, -p.r, p.y));
    const axis = axisHandles(s);

    // силуэт тела вращения
    path(right.concat(left.slice().reverse()));
    ctx.closePath();
    ctx.fillStyle = "rgba(20, 115, 230, 0.2)";
    ctx.fill();

    // ось вращения
    const far = cssW + cssH;
    ctx.save();
    ctx.setLineDash([6, 4]);
    stroke(
      [
        { x: axis.origin.x - axis.up.x * far, y: axis.origin.y - axis.up.y * far },
        { x: axis.origin.x + axis.up.x * far, y: axis.origin.y + axis.up.y * far },
      ],
      "#ffffff",
      1,
    );
    ctx.restore();

    stroke(left, COLOR_DIM, 1);
    stroke(right, COLOR, 2);

    // опорные точки: сглаженная — кружок, острая — квадрат
    points.forEach((p, i) => {
      const c = localCss(s, p.r, p.y);
      ctx.beginPath();
      if (p.smooth) ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
      else ctx.rect(c.x - 4.5, c.y - 4.5, 9, 9);
      ctx.fillStyle = i === selected ? "#2d7ff0" : "#ffffff";
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    });

    // ручки оси
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(axis.origin.x - 6, axis.origin.y - 6, 12, 12);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(axis.origin.x - 3, axis.origin.y);
    ctx.lineTo(axis.origin.x + 3, axis.origin.y);
    ctx.moveTo(axis.origin.x, axis.origin.y - 3);
    ctx.lineTo(axis.origin.x, axis.origin.y + 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(axis.rotate.x, axis.rotate.y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // ---------- мышь ----------

  canvas.addEventListener("pointerdown", (e) => {
    if (drag) return;
    const p = position(e);
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && keys.space);
    if (pan) {
      drag = { id: e.pointerId, kind: "pan", lastX: p.x, lastY: p.y };
    } else {
      if (e.button !== 0 || !options.canEdit()) return;
      const s = scene();
      if (!s) return;
      const axis = axisHandles(s);
      const doc = viewToDoc(s.view, p.x, p.y);
      const start = { params: s.params, doc };
      if (Math.hypot(axis.rotate.x - p.x, axis.rotate.y - p.y) <= HANDLE_HIT) {
        drag = { id: e.pointerId, kind: "rotate", ...start };
      } else {
        const index = hitControlPoint(s, p);
        if (index >= 0) {
          select(index);
          const local = docToLocal(s.params.transform, doc.x, doc.y);
          drag = { id: e.pointerId, kind: "point", index, side: local.r < 0 ? -1 : 1, ...start };
        } else if (Math.hypot(axis.origin.x - p.x, axis.origin.y - p.y) <= HANDLE_HIT) {
          drag = { id: e.pointerId, kind: "origin", ...start };
        } else {
          // новая точка: ставится на правую половину и сразу тянется
          const local = docToLocal(s.params.transform, doc.x, doc.y);
          const added = insertPoint(s.params.shape.points, local.r, local.y);
          selected = added.index;
          options.onSelect();
          commitPoints(s, added.points);
          drag = { id: e.pointerId, kind: "point", index: added.index, side: local.r < 0 ? -1 : 1, ...start };
        }
      }
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* без захвата указателя перетаскивание работает, пока курсор над полем */
    }
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = position(e);
    if (drag.kind === "pan") {
      options.onPan(p.x - drag.lastX, p.y - drag.lastY);
      drag.lastX = p.x;
      drag.lastY = p.y;
      return;
    }
    const s = scene();
    if (!s) return;
    const doc = viewToDoc(s.view, p.x, p.y);
    if (drag.kind === "point") {
      const local = docToLocal(s.params.transform, doc.x, doc.y);
      commitPoints(s, movePoint(s.params.shape.points, drag.index, local.r * drag.side, local.y));
    } else if (drag.kind === "origin") {
      const next = cloneParams(s.params);
      next.transform.x = clampField("transform.x", drag.params.transform.x + doc.x - drag.doc.x);
      next.transform.y = clampField("transform.y", drag.params.transform.y + doc.y - drag.doc.y);
      options.onChange(next);
    } else if (drag.kind === "rotate") {
      const t = s.params.transform;
      const dx = doc.x - t.x;
      const dy = doc.y - t.y;
      if (Math.hypot(dx, dy) < 1e-6) return;
      const next = cloneParams(s.params);
      // наклон по часовой стрелке — положительный: верх оси уходит вправо
      next.transform.roll = clampField("transform.roll", (Math.atan2(dx, -dy) * 180) / Math.PI);
      options.onChange(next);
    }
  });

  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* захвата могло не быть */
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  canvas.addEventListener("dblclick", (e) => {
    const s = scene();
    if (!s || !options.canEdit()) return;
    const index = hitControlPoint(s, position(e));
    if (index < 0) return;
    select(index);
    commitPoints(s, toggleSmooth(s.params.shape.points, index));
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= 400;
      const factor = Math.min(2, Math.max(0.5, Math.exp(-delta * 0.0015)));
      if (e.altKey) {
        if (options.canEdit()) options.onScale(factor);
      } else {
        const p = position(e);
        options.onZoom(factor, p.x, p.y);
      }
    },
    { passive: false },
  );

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (!active || selected < 0 || isEditable(e.target)) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    api.deleteSelected();
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(container);
  else window.addEventListener("resize", resize);

  const api = {
    setActive(value) {
      const next = !!value;
      if (next === active) {
        draw();
        return;
      }
      active = next;
      if (!active) drag = null;
      resize();
    },
    draw,
    /** Выбранная точка или null. */
    selectedPoint() {
      const params = options.getParams();
      const points = params && params.shape.points;
      return active && points && selected >= 0 && selected < points.length ? points[selected] : null;
    },
    canDelete() {
      const params = options.getParams();
      return !!api.selectedPoint() && params.shape.points.length > 2;
    },
    setSelectedSmooth(smooth) {
      const s = scene();
      const point = api.selectedPoint();
      if (!s || !point || point.smooth === smooth || !options.canEdit()) return;
      commitPoints(s, toggleSmooth(s.params.shape.points, selected));
    },
    deleteSelected() {
      const s = scene();
      if (!s || !api.canDelete() || !options.canEdit()) return;
      const points = removePoint(s.params.shape.points, selected);
      selected = -1;
      options.onSelect();
      commitPoints(s, points);
    },
    clearSelection() {
      select(-1);
    },
  };
  return api;
}
