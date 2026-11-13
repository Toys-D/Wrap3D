// Управление мышью во вьюпорте.
//
//   левая кнопка + тянуть      — действие текущего режима (форма / надпись / наклон)
//   Alt + тянуть               — временно режим «Надпись», Shift + тянуть — «Наклон»
//   колесо                     — масштаб вида, точка под курсором остаётся на месте
//   Alt + колесо               — масштаб формы или надписи
//   пробел + тянуть, средняя или правая кнопка — сдвиг вида

import { keys } from "./keys.js";

/**
 * handlers:
 *   getMode()                  текущий режим: "form" | "label" | "tilt"
 *   canEdit()                  можно ли менять сцену
 *   onDragStart(mode), onDrag(mode, dxCss, dyCss), onDragEnd(mode) — сдвиг от точки нажатия
 *   onPan(dxCss, dyCss)        сдвиг вида с прошлого события
 *   onZoom(factor, x, y)       масштаб вида в точке окна
 *   onScale(factor)            масштаб формы или надписи
 */
export function attachPointer(el, handlers) {
  let drag = null;

  const position = (e) => {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  el.addEventListener("pointerdown", (e) => {
    if (drag) return;
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && keys.space);
    if (!pan && e.button !== 0) return;
    if (!pan && !handlers.canEdit()) return;
    const p = position(e);
    const mode = pan ? "pan" : e.altKey ? "label" : e.shiftKey ? "tilt" : handlers.getMode();
    drag = { id: e.pointerId, mode, x: p.x, y: p.y, lastX: p.x, lastY: p.y };
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      /* без захвата указателя перетаскивание работает, пока курсор над вьюпортом */
    }
    if (!pan) handlers.onDragStart(mode);
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = position(e);
    if (drag.mode === "pan") {
      handlers.onPan(p.x - drag.lastX, p.y - drag.lastY);
      drag.lastX = p.x;
      drag.lastY = p.y;
    } else {
      handlers.onDrag(drag.mode, p.x - drag.x, p.y - drag.y);
    }
  });

  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const mode = drag.mode;
    drag = null;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* захвата могло не быть */
    }
    if (mode !== "pan") handlers.onDragEnd(mode);
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);

  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16; // строки
      else if (e.deltaMode === 2) delta *= 400; // страницы
      const factor = Math.min(2, Math.max(0.5, Math.exp(-delta * 0.0015)));
      if (e.altKey) {
        if (handlers.canEdit()) handlers.onScale(factor);
      } else {
        const p = position(e);
        handlers.onZoom(factor, p.x, p.y);
      }
    },
    { passive: false },
  );

  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
