// Навигация по вьюпорту. Вид — прямоугольник документа, показанный в окне:
//   { x, y, w, h, scale } — x, y, w, h в пикселях документа, scale — пикселей окна на пиксель документа.
// На результат вид не влияет: это только то, как документ показан в панели.

const MIN_SCALE = 0.005;
const MAX_SCALE = 64;

/** Документ целиком, по центру окна, с небольшими полями. */
export function fitView(doc, cssW, cssH, margin = 1.08) {
  const scale = Math.min(cssW / (doc.width * margin), cssH / (doc.height * margin));
  const w = cssW / scale;
  const h = cssH / scale;
  return { x: doc.width / 2 - w / 2, y: doc.height / 2 - h / 2, w, h, scale };
}

/** Точка окна → точка документа. */
export function viewToDoc(view, cssX, cssY) {
  return { x: view.x + cssX / view.scale, y: view.y + cssY / view.scale };
}

/** Масштабирование вида; точка документа под курсором остаётся на месте. */
export function zoomView(view, factor, cssX, cssY) {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const anchor = viewToDoc(view, cssX, cssY);
  const cssW = view.w * view.scale;
  const cssH = view.h * view.scale;
  return { x: anchor.x - cssX / scale, y: anchor.y - cssY / scale, w: cssW / scale, h: cssH / scale, scale };
}

/** Сдвиг вида: документ едет за курсором на (dxCss, dyCss) пикселей окна. */
export function panView(view, dxCss, dyCss) {
  return { ...view, x: view.x - dxCss / view.scale, y: view.y - dyCss / view.scale };
}

/** Окно изменило размер: масштаб и центр вида сохраняются. */
export function resizeView(view, cssW, cssH) {
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const w = cssW / view.scale;
  const h = cssH / view.scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h, scale: view.scale };
}
