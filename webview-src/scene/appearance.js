// Личные настройки вида вьюпорта. На результат не влияют: в документ попадает только надпись.
// Без зависимостей — проверяется тестами в Node.
//
//   formStyle "rim"   — форма как была изначально: слабая заливка и яркие края (френель)
//   formStyle "solid" — сплошная заливка, непрозрачность задаётся ползунком formOpacity, 0…100 %
//   showSource        — показывать ли исходный слой надписи на фоне-документе; по умолчанию нет,
//                       потому что плоская надпись мешает совмещать форму с фото

export const DEFAULT_VIEW_PREFS = { formStyle: "rim", formOpacity: 40, showSource: false };

/** Настройки вида из сохранённых настроек; испорченные значения заменяются исходными. */
export function sanitizeViewPrefs(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const formStyle = s.formStyle === "solid" || s.formStyle === "rim" ? s.formStyle : DEFAULT_VIEW_PREFS.formStyle;
  const valid = typeof s.formOpacity === "number" && Number.isFinite(s.formOpacity);
  const formOpacity = valid ? Math.min(100, Math.max(0, s.formOpacity)) : DEFAULT_VIEW_PREFS.formOpacity;
  const showSource = typeof s.showSource === "boolean" ? s.showSource : DEFAULT_VIEW_PREFS.showSource;
  return { formStyle, formOpacity, showSource };
}

/**
 * Во что превращаются настройки при отрисовке:
 *   solid       — сплошная заливка вместо подсветки краёв
 *   alpha       — непрозрачность сплошной заливки, 0…1
 *   doubleSided — рисовать ли заднюю стенку формы
 *   ringOpacity — непрозрачность линий на краях формы
 */
export function formAppearance(prefs) {
  if (prefs.formStyle !== "solid") {
    return { solid: false, alpha: 1, doubleSided: true, ringOpacity: 0.95 };
  }
  const alpha = Math.min(100, Math.max(0, prefs.formOpacity)) / 100;
  // Сплошная форма рисуется одним слоем (только передняя стенка): с двумя слоями итоговая
  // непрозрачность была бы выше заданной. Линии краёв гаснут вместе с заливкой.
  return { solid: true, alpha, doubleSided: false, ringOpacity: Math.min(0.95, alpha * 2) };
}
