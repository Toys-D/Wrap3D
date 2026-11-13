/**
 * Имитация модуля require("photoshop") — только те вызовы, что описаны в документации Adobe:
 * app.activeDocument, core.executeAsModal + hostControl, imaging.getPixels / putPixels /
 * createImageDataFromBuffer, document.createPixelLayer.
 */
export function fakePhotoshop(over = {}) {
  const calls = [];
  const layerPixels = new Uint8Array(900 * 260 * 4).fill(7);
  const layer = {
    id: 12,
    name: "Logo",
    kind: "text",
    boundsNoEffects: { left: 350, top: 470, right: 1250, bottom: 730, width: 900, height: 260 },
    ...over.layer,
  };
  // Видимость слоя — свойство с записью: каждое изменение попадает в журнал вызовов.
  let visible = over.layer && "visible" in over.layer ? over.layer.visible : true;
  Object.defineProperty(layer, "visible", {
    enumerable: true,
    get: () => visible,
    set: (value) => {
      visible = value;
      calls.push(["setVisible", value]);
    },
  });
  const doc = {
    id: 5,
    name: "bottle.psd",
    width: 1600,
    height: 1200,
    mode: "RGBColorMode",
    activeLayers: [layer],
    createPixelLayer: async (o) => {
      calls.push(["createPixelLayer", o]);
      return { id: 99, name: o.name };
    },
    ...over.doc,
  };
  const ps = {
    app: { activeDocument: "activeDocument" in over ? over.activeDocument : doc },
    core: {
      executeAsModal: async (fn, opts) => {
        calls.push(["executeAsModal", opts]);
        if (over.modalError) throw over.modalError;
        return fn({
          hostControl: {
            suspendHistory: async (o) => {
              calls.push(["suspendHistory", o]);
              return 77;
            },
            resumeHistory: async (id, commit) => {
              calls.push(["resumeHistory", id, commit]);
            },
          },
        });
      },
    },
    imaging: {
      getPixels: async (o) => {
        calls.push(["getPixels", o, { layerVisible: layer.visible }]);
        if (over.getPixelsError) throw over.getPixelsError;
        if (o.layerID === undefined) {
          // без layerID Photoshop отдаёт сведённое изображение документа;
          // при одном заданном размере второй считается пропорционально
          let width = doc.width;
          let height = doc.height;
          if (o.targetSize && o.targetSize.width) {
            width = o.targetSize.width;
            height = Math.round((doc.height * width) / doc.width);
          } else if (o.targetSize && o.targetSize.height) {
            height = o.targetSize.height;
            width = Math.round((doc.width * height) / doc.height);
          }
          return {
            imageData: {
              width,
              height,
              components: 3,
              hasAlpha: false,
              getData: async () => new Uint8Array(width * height * 3).fill(9),
              dispose: () => calls.push(["dispose", "snapshot"]),
            },
            sourceBounds: { left: 0, top: 0, right: width, bottom: height },
            level: 0,
          };
        }
        const width = o.targetSize ? o.targetSize.width : 900;
        const height = o.targetSize ? o.targetSize.height : 260;
        return {
          imageData: {
            width,
            height,
            components: 4,
            hasAlpha: true,
            getData: async () => (o.targetSize ? new Uint8Array(width * height * 4) : layerPixels),
            dispose: () => calls.push(["dispose", "read"]),
          },
          // без targetSize Photoshop возвращает область, обрезанную по пикселям
          sourceBounds: { left: 352, top: 471, right: 1252, bottom: 731 },
          level: 0,
        };
      },
      createImageDataFromBuffer: async (buffer, o) => {
        calls.push(["createImageDataFromBuffer", buffer, o]);
        return { dispose: () => calls.push(["dispose", "write"]) };
      },
      putPixels: async (o) => {
        calls.push(["putPixels", o]);
        if (over.putPixelsError) throw over.putPixelsError;
      },
    },
  };
  return { ps, calls, doc, layer, layerPixels };
}
