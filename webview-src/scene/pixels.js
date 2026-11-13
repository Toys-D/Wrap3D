// Операции над пикселями RGBA 8 бит. Без зависимостей — проверяются тестами в Node.

/**
 * Готовит текстуру из пикселей слоя: цвет умножается на альфу (иначе при сглаживании
 * по краям букв появляется кайма) и добавляется прозрачная рамка шириной pad.
 * components: 4 (RGBA) или 3 (RGB, слой без прозрачности).
 */
export function prepareTexture(data, width, height, components, pad = 1) {
  const W = width + pad * 2;
  const H = height + pad * 2;
  const out = new Uint8Array(W * H * 4);
  const hasAlpha = components >= 4;
  let straightEvidence = 0;
  for (let y = 0; y < height; y++) {
    let s = y * width * components;
    let d = ((y + pad) * W + pad) * 4;
    for (let x = 0; x < width; x++, s += components, d += 4) {
      const a = hasAlpha ? data[s + 3] : 255;
      if (a === 0) continue;
      const r = data[s];
      const g = data[s + 1];
      const b = data[s + 2];
      if (a === 255) {
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = b;
      } else {
        if (r > a || g > a || b > a) straightEvidence++;
        out[d] = ((r * a + 127) / 255) | 0;
        out[d + 1] = ((g * a + 127) / 255) | 0;
        out[d + 2] = ((b * a + 127) / 255) | 0;
      }
      out[d + 3] = a;
    }
  }
  return { pixels: out, width: W, height: H, pad, straightEvidence };
}

/** Обратное действие для результата рендера: делит цвет на альфу (на месте). */
export function unpremultiply(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      continue;
    }
    const k = 255 / a;
    buf[i] = Math.min(255, Math.round(buf[i] * k));
    buf[i + 1] = Math.min(255, Math.round(buf[i + 1] * k));
    buf[i + 2] = Math.min(255, Math.round(buf[i + 2] * k));
  }
  return buf;
}

/** Обрезает изображение до прямоугольника, где есть непрозрачные пиксели. null — если их нет. */
export function cropToAlpha(buf, width, height) {
  const rowHasAlpha = (y) => {
    const end = (y + 1) * width * 4;
    for (let i = y * width * 4 + 3; i < end; i += 4) if (buf[i] !== 0) return true;
    return false;
  };
  let top = 0;
  while (top < height && !rowHasAlpha(top)) top++;
  if (top === height) return null;
  let bottom = height - 1;
  while (bottom > top && !rowHasAlpha(bottom)) bottom--;

  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * width * 4;
    for (let x = 0; x < left; x++) {
      if (buf[row + x * 4 + 3] !== 0) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x > right; x--) {
      if (buf[row + x * 4 + 3] !== 0) {
        right = x;
        break;
      }
    }
  }

  const w = right - left + 1;
  const h = bottom - top + 1;
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * width + left) * 4;
    pixels.set(buf.subarray(from, from + w * 4), y * w * 4);
  }
  return { left, top, width: w, height: h, pixels };
}

/**
 * Копирует плитку, прочитанную из WebGL (строки идут снизу вверх), в общий буфер
 * со строками сверху вниз, в позицию (dstX, dstY).
 */
export function blitFlipped(src, srcW, srcH, dst, dstW, dstX, dstY) {
  const rowBytes = srcW * 4;
  for (let r = 0; r < srcH; r++) {
    const from = (srcH - 1 - r) * rowBytes;
    dst.set(src.subarray(from, from + rowBytes), ((dstY + r) * dstW + dstX) * 4);
  }
}

/** Приводит пиксели к RGBA: RGB дополняется непрозрачной альфой, RGBA возвращается как есть. */
export function toRGBA(data, width, height, components) {
  if (components === 4) return data;
  const out = new Uint8Array(width * height * 4);
  for (let s = 0, d = 0; d < out.length; s += 3, d += 4) {
    out[d] = data[s];
    out[d + 1] = data[s + 1];
    out[d + 2] = data[s + 2];
    out[d + 3] = 255;
  }
  return out;
}
