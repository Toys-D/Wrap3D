// Вьюпорт и финальный рендер на three.js.
//
// Сцена измеряется в пикселях документа: точка документа (x, y) — это мировая точка (x, −y, 0).
// Камера в полном кадре видит ровно документ, поэтому любой прямоугольник документа
// можно отрендерить через setViewOffset — и для просмотра, и для результата, и для плиток.

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FrontSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  REVISION,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { buildPatch, profileLength } from "./revolve.js";
import { cameraSetup, resolvePlacement, shapeMatrix, shapeProfile } from "./params.js";
import { blitFlipped, cropToAlpha, toRGBA, unpremultiply } from "./pixels.js";
import { fitView, panView, resizeView, zoomView } from "./view.js";

const MAX_TILE = 4096; // сторона плитки финального рендера
export const MAX_OUTPUT_PIXELS = 64e6; // предел площади результата
const HELPER_COLOR = 0x1473e6;

// Материал надписи: без преобразования цвета — значения пикселей слоя проходят как есть.
// Текстура заранее умножена на альфу. При shade = 0 (по умолчанию) затенения нет и цвет
// не меняется вовсе; иначе надпись мягко темнеет к краям формы, где поверхность отворачивается
// от зрителя.
const LABEL_VERTEX = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mv.xyz;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;

const LABEL_FRAGMENT = `
uniform sampler2D map;
uniform float shade;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
  vec4 c = texture2D(map, vUv);
  if (shade > 0.0) {
    vec3 n = normalize(vNormal);
    vec3 v = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
    float edge = 1.0 - abs(dot(n, v));
    c.rgb *= 1.0 - shade * edge * edge;
  }
  gl_FragColor = c;
}`;

// Полупрозрачная «тень» формы для совмещения с фото: слабая заливка и яркий край по силуэту.
// Край считается по углу между нормалью и направлением взгляда, поэтому силуэт верен
// при любом наклоне и для обеих камер.
const GHOST_VERTEX = `
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mv.xyz;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;

const GHOST_FRAGMENT = `
uniform vec3 color;
uniform float fill;
uniform float rim;
uniform float solid;
uniform float alpha;
varying vec3 vNormal;
varying vec3 vViewPosition;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float facing = abs(dot(n, v));
  if (solid > 0.5) {
    // Сплошная заливка: непрозрачность одинакова по всей форме и равна значению ползунка.
    // Цвет немного темнее к краям, чтобы у формы читался объём.
    vec3 c = color * (0.72 + 0.28 * facing);
    gl_FragColor = vec4(c * alpha, alpha);
  } else {
    float a = fill + rim * pow(1.0 - facing, 3.0);
    gl_FragColor = vec4(color * a, a);
  }
}`;

export class Viewport {
  constructor({ canvas, container, docFrame, backdrop, log }) {
    this.canvas = canvas;
    this.container = container;
    this.docFrame = docFrame;
    this.backdrop = backdrop;
    this.log = log || (() => {});
    this.onViewChange = null;

    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new Scene();
    this.shape = new Group(); // всё, что движется вместе с формой
    this.shape.matrixAutoUpdate = false;
    this.scene.add(this.shape);

    // Вспомогательная графика: видна только во вьюпорте, в результат не попадает.
    this.helpers = new Group();
    this.shape.add(this.helpers);

    this.ghost = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        uniforms: {
          color: { value: new Vector3(0x14 / 255, 0x73 / 255, 0xe6 / 255) },
          fill: { value: 0.08 },
          rim: { value: 0.75 },
          solid: { value: 0 },
          alpha: { value: 1 },
        },
        vertexShader: GHOST_VERTEX,
        fragmentShader: GHOST_FRAGMENT,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = 0;
    this.helpers.add(this.ghost);

    this.rings = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: HELPER_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 10;
    this.helpers.add(this.rings);

    this.material = new ShaderMaterial({
      uniforms: { map: { value: null }, shade: { value: 0 } },
      vertexShader: LABEL_VERTEX,
      fragmentShader: LABEL_FRAGMENT,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    this.shape.add(this.mesh);

    this.camera = null;
    this.cameraKey = "";
    this.patchKey = "";
    this.ghostKey = "";
    this.doc = null;
    this.label = null;
    this.params = null;
    this.texture = null;
    this.view = null;
    this.autoFit = true;
    this.showForm = true;
    this.cssW = 0;
    this.cssH = 0;
    this.frame = 0;

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.log("error", "WebGL: контекст потерян");
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.log("warn", "WebGL: контекст восстановлен");
      this.requestRender();
    });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => this.resize()).observe(container);
    } else {
      window.addEventListener("resize", () => this.resize());
    }
    this.resize();
  }

  /** Возможности WebGL — для диагностики и для выбора размеров. */
  caps() {
    const gl = this.renderer.getContext();
    const c = this.renderer.capabilities;
    let gpu = "";
    try {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch (e) {
      gpu = "";
    }
    return {
      webgl: String(gl.getParameter(gl.VERSION)),
      gpu,
      maxTextureSize: c.maxTextureSize,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxSamples: c.maxSamples,
      maxAnisotropy: c.getMaxAnisotropy(),
      three: REVISION,
    };
  }

  // ---------- документ, надпись, параметры ----------

  /** doc: { id, width, height }. При смене документа вид сбрасывается, фон убирается. */
  setDocument(doc) {
    const same = this.doc && this.doc.id === doc.id && this.doc.width === doc.width && this.doc.height === doc.height;
    this.doc = doc;
    if (!same) {
      this.autoFit = true;
      this.clearBackdrop();
      this.cameraKey = "";
    }
    this.updateView();
    this.requestRender();
  }

  /**
   * label — прямоугольник надписи в документе { left, top, width, height };
   * tex — { pixels, width, height }, RGBA, цвет умножен на альфу, строки сверху вниз.
   */
  setLabel(label, tex) {
    if (this.texture) this.texture.dispose();
    const texture = new DataTexture(tex.pixels, tex.width, tex.height, RGBAFormat, UnsignedByteType);
    texture.colorSpace = NoColorSpace;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    this.texture = texture;
    this.material.uniforms.map.value = texture;
    this.label = label;
    this.patchKey = "";
  }

  setParams(params) {
    this.params = params;
    if (!this.doc || !this.label) return;
    this.updateCamera();

    this.shape.matrix.fromArray(shapeMatrix(params.transform));
    this.shape.matrixWorldNeedsUpdate = true;

    // Участок под надписью
    const patchKey = JSON.stringify([params.shape, params.placement, this.label.width, this.label.height]);
    if (patchKey !== this.patchKey) {
      this.patchKey = patchKey;
      const placement = resolvePlacement(params, this.label);
      const patch = buildPatch(placement.profile, placement);
      this.mesh.geometry.dispose();
      this.mesh.geometry = toGeometry(patch);
      this.mesh.visible = !!patch;
      const side = params.placement.hideBack ? FrontSide : DoubleSide;
      if (this.material.side !== side) {
        this.material.side = side;
        this.material.needsUpdate = true;
      }
    }

    // Вспомогательная форма
    const ghostKey = JSON.stringify(params.shape);
    if (ghostKey !== this.ghostKey) {
      this.ghostKey = ghostKey;
      const profile = shapeProfile(params.shape);
      const total = profileLength(profile);
      const surface = buildPatch(profile, {
        thetaCenter: 0,
        thetaSpan: Math.PI * 2,
        sCenter: total / 2,
        sLength: total,
        thetaSegments: 128,
      });
      this.ghost.geometry.dispose();
      this.ghost.geometry = toGeometry(surface);
      this.rings.geometry.dispose();
      this.rings.geometry = ringsGeometry(profile, params.shape);
    }
    this.material.uniforms.shade.value = params.light.shading ? params.light.strength / 100 : 0;
    this.helpers.visible = this.showForm;
    this.requestRender();
  }

  updateCamera() {
    const W = this.doc.width;
    const H = this.doc.height;
    const setup = cameraSetup(this.doc, this.params.camera);
    const key = [setup.type, setup.fov, W, H].join("|");
    if (key === this.cameraKey) return;
    this.cameraKey = key;
    if (setup.type === "persp") {
      this.camera = new PerspectiveCamera(setup.fov, W / H, setup.near, setup.far);
    } else {
      this.camera = new OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, setup.near, setup.far);
    }
    this.camera.position.set(W / 2, -H / 2, setup.distance);
    this.camera.updateMatrixWorld();
  }

  setShowForm(show) {
    this.showForm = !!show;
    this.helpers.visible = this.showForm;
    this.requestRender();
  }

  /** a — результат formAppearance(): подсветка краёв или сплошная заливка с непрозрачностью. */
  setFormAppearance(a) {
    const material = this.ghost.material;
    material.uniforms.solid.value = a.solid ? 1 : 0;
    material.uniforms.alpha.value = a.alpha;
    const side = a.doubleSided ? DoubleSide : FrontSide;
    if (material.side !== side) {
      material.side = side;
      material.needsUpdate = true;
    }
    this.rings.material.opacity = a.ringOpacity;
    this.rings.visible = a.ringOpacity > 0;
    this.requestRender();
  }

  // ---------- фон-документ ----------

  /** info: { width, height, components }, pixels — строки сверху вниз. */
  setBackdrop(info, pixels) {
    const canvas = this.backdrop;
    canvas.width = info.width;
    canvas.height = info.height;
    const rgba = toRGBA(pixels, info.width, info.height, info.components);
    const image = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), info.width, info.height);
    canvas.getContext("2d").putImageData(image, 0, 0);
    canvas.style.display = "block";
  }

  clearBackdrop() {
    this.backdrop.style.display = "none";
  }

  /** opacity: 0…100 */
  setBackdropOpacity(opacity) {
    this.backdrop.style.opacity = String(Math.min(100, Math.max(0, opacity)) / 100);
  }

  // ---------- навигация по виду ----------

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === this.cssW && h === this.cssH) return;
    this.cssW = w;
    this.cssH = h;
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);
    this.updateView();
    this.requestRender();
  }

  updateView() {
    if (!this.doc || !this.cssW || !this.cssH) return;
    this.view = this.autoFit || !this.view ? fitView(this.doc, this.cssW, this.cssH) : resizeView(this.view, this.cssW, this.cssH);
    this.emitView();
  }

  emitView() {
    if (this.onViewChange && this.view) this.onViewChange(this.view);
  }

  fit() {
    this.autoFit = true;
    this.updateView();
    this.requestRender();
  }

  zoomAt(factor, cssX, cssY) {
    if (!this.view) return;
    this.autoFit = false;
    this.view = zoomView(this.view, factor, cssX, cssY);
    this.emitView();
    this.requestRender();
  }

  panBy(dxCss, dyCss) {
    if (!this.view) return;
    this.autoFit = false;
    this.view = panView(this.view, dxCss, dyCss);
    this.emitView();
    this.requestRender();
  }

  // ---------- отрисовка ----------

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(null);
    if (!this.doc || !this.view) {
      r.clear();
      this.docFrame.style.display = "none";
      return;
    }
    const v = this.view;
    const s = this.docFrame.style;
    s.display = "block";
    s.left = -v.x * v.scale + "px";
    s.top = -v.y * v.scale + "px";
    s.width = this.doc.width * v.scale + "px";
    s.height = this.doc.height * v.scale + "px";

    if (!this.camera) {
      r.clear();
      return;
    }
    this.camera.setViewOffset(this.doc.width, this.doc.height, v.x, v.y, v.w, v.h);
    r.render(this.scene, this.camera);
  }

  /**
   * Прямоугольник документа, в который попадает надпись (целые пиксели, в границах документа).
   * Если часть надписи оказалась за камерой, берётся документ целиком.
   */
  outputRegion() {
    const W = this.doc.width;
    const H = this.doc.height;
    const camera = this.camera;
    camera.clearViewOffset();
    camera.updateMatrixWorld();
    this.shape.updateMatrixWorld(true);

    const position = this.mesh.geometry.getAttribute("position");
    if (!position) return null;
    const p = new Vector3();
    const inView = new Vector3();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let behindCamera = false;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(this.mesh.matrixWorld);
      if (camera.isPerspectiveCamera) {
        inView.copy(p).applyMatrix4(camera.matrixWorldInverse);
        if (-inView.z <= camera.near) {
          behindCamera = true;
          break;
        }
      }
      p.project(camera);
      const x = (p.x * 0.5 + 0.5) * W;
      const y = (0.5 - p.y * 0.5) * H;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (behindCamera) return { x: 0, y: 0, w: W, h: H };
    const x0 = Math.max(0, Math.floor(minX) - 2);
    const y0 = Math.max(0, Math.floor(minY) - 2);
    const x1 = Math.min(W, Math.ceil(maxX) + 2);
    const y1 = Math.min(H, Math.ceil(maxY) + 2);
    if (!(x1 > x0) || !(y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Финальный рендер в разрешении документа. Рендерится только область надписи; если она
   * больше предела WebGL — плитками. Возвращает
   *   { pixels, left, top, width, height, tiles, timings }
   * где pixels — RGBA без умножения на альфу, строки сверху вниз, а left/top — место в документе.
   * { empty: true } — если надпись не попала в документ.
   */
  renderOutput(options = {}) {
    if (!this.doc || !this.camera || !this.mesh.visible) return { empty: true };
    const timings = {};
    const tStart = performance.now();

    const region = this.outputRegion();
    if (!region) {
      this.requestRender();
      return { empty: true };
    }
    if (region.w * region.h > MAX_OUTPUT_PIXELS) {
      this.requestRender();
      const err = new Error("область результата слишком велика");
      err.code = "tooLarge";
      err.detail = { mp: Math.round((region.w * region.h) / 1e6), max: MAX_OUTPUT_PIXELS / 1e6 };
      throw err;
    }

    const caps = this.caps();
    const tile = Math.max(16, Math.min(options.tileMax || MAX_TILE, caps.maxTextureSize, caps.maxRenderbufferSize));
    const samples = Math.min(4, caps.maxSamples || 0);
    const out = new Uint8Array(region.w * region.h * 4);
    const r = this.renderer;
    const helpersWereVisible = this.helpers.visible;
    this.helpers.visible = false; // форма невидима: в результат попадает только надпись

    let target = null;
    let tiles = 0;
    try {
      for (let ty = 0; ty < region.h; ty += tile) {
        for (let tx = 0; tx < region.w; tx += tile) {
          const tw = Math.min(tile, region.w - tx);
          const th = Math.min(tile, region.h - ty);
          if (!target || target.width !== tw || target.height !== th) {
            if (target) target.dispose();
            target = new WebGLRenderTarget(tw, th, {
              samples,
              depthBuffer: true,
              format: RGBAFormat,
              type: UnsignedByteType,
              colorSpace: NoColorSpace,
              generateMipmaps: false,
              minFilter: LinearFilter,
              magFilter: LinearFilter,
            });
          }
          this.camera.setViewOffset(this.doc.width, this.doc.height, region.x + tx, region.y + ty, tw, th);
          r.setRenderTarget(target);
          r.clear();
          r.render(this.scene, this.camera);
          const buffer = new Uint8Array(tw * th * 4);
          r.readRenderTargetPixels(target, 0, 0, tw, th, buffer);
          blitFlipped(buffer, tw, th, out, region.w, tx, ty);
          tiles++;
        }
      }
    } finally {
      r.setRenderTarget(null);
      if (target) target.dispose();
      this.helpers.visible = helpersWereVisible;
      this.requestRender();
    }
    timings.render = Math.round(performance.now() - tStart);

    const tPost = performance.now();
    unpremultiply(out);
    const crop = cropToAlpha(out, region.w, region.h);
    timings.post = Math.round(performance.now() - tPost);
    if (!crop) return { empty: true };

    return {
      pixels: crop.pixels,
      left: region.x + crop.left,
      top: region.y + crop.top,
      width: crop.width,
      height: crop.height,
      tiles,
      samples,
      region,
      timings,
    };
  }
}

function toGeometry(patch) {
  const geometry = new BufferGeometry();
  if (patch) {
    geometry.setAttribute("position", new BufferAttribute(patch.positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(patch.normals, 3));
    geometry.setAttribute("uv", new BufferAttribute(patch.uvs, 2));
    geometry.setIndex(new BufferAttribute(patch.indices, 1));
  }
  return geometry;
}

/**
 * Окружности, по которым удобно совмещать форму с фото: края формы; у сферы — экватор;
 * у тела вращения ещё и изломы контура (острые точки).
 */
function ringsGeometry(profile, shape) {
  const SEGMENTS = 128;
  const points = [];
  const ring = (radius, y) => {
    if (!(radius > 0.5)) return;
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
      points.push(radius * Math.sin(a0), y, radius * Math.cos(a0), radius * Math.sin(a1), y, radius * Math.cos(a1));
    }
  };
  if (shape.type === "sphere") {
    const middle = profile[Math.floor(profile.length / 2)];
    ring(middle.r, middle.y);
  } else {
    ring(profile[0].r, profile[0].y);
    ring(profile[profile.length - 1].r, profile[profile.length - 1].y);
    if (shape.type === "lathe") {
      for (const p of shape.points.slice(1, -1)) {
        if (!p.smooth) ring(p.r, p.y);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points), 3));
  return geometry;
}
