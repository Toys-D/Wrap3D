// Общее состояние клавиатуры для вьюпорта и редактора контура.

export const keys = { space: false };

/** Курсор в поле ввода — клавиши принадлежат полю, а не вьюпорту. */
export function isEditable(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || isEditable(e.target)) return;
    keys.space = true;
    e.preventDefault(); // пробел не должен прокручивать панель или нажимать кнопку в фокусе
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") keys.space = false;
  });
  window.addEventListener("blur", () => {
    keys.space = false;
  });
}
