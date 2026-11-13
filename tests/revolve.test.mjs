import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPatch,
  coneProfile,
  cylinderProfile,
  profileLength,
  radiusAt,
  sAtHeight,
  sphereProfile,
} from "../webview-src/scene/revolve.js";

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

function vertices(patch) {
  const out = [];
  for (let i = 0; i < patch.positions.length / 3; i++) {
    out.push({
      x: patch.positions[i * 3],
      y: patch.positions[i * 3 + 1],
      z: patch.positions[i * 3 + 2],
      nx: patch.normals[i * 3],
      ny: patch.normals[i * 3 + 1],
      nz: patch.normals[i * 3 + 2],
      u: patch.uvs[i * 2],
      v: patch.uvs[i * 2 + 1],
    });
  }
  return out;
}

const range = (arr) => [Math.min(...arr), Math.max(...arr)];

function cylinderPatch(extra = {}) {
  return buildPatch(cylinderProfile(100, 50), {
    thetaCenter: 0,
    thetaSpan: 120 * DEG,
    sCenter: 25,
    sLength: 50,
    thetaSegments: 48,
    ...extra,
  });
}

test("cylinderProfile — вертикальная образующая, центр формы в нуле", () => {
  assert.deepEqual(cylinderProfile(100, 50), [
    { r: 100, y: -25 },
    { r: 100, y: 25 },
  ]);
});

test("участок цилиндра занимает заданный угол на стороне, обращённой к камере (+Z)", () => {
  const vs = vertices(cylinderPatch());
  const [minX, maxX] = range(vs.map((p) => p.x));
  const [minY, maxY] = range(vs.map((p) => p.y));
  const [minZ, maxZ] = range(vs.map((p) => p.z));
  assert.ok(near(minX, -100 * Math.sin(60 * DEG)), `minX ${minX}`);
  assert.ok(near(maxX, 100 * Math.sin(60 * DEG)), `maxX ${maxX}`);
  assert.ok(near(minY, -25) && near(maxY, 25), `y ${minY}..${maxY}`);
  assert.ok(near(minZ, 50), `minZ ${minZ}`);
  assert.ok(near(maxZ, 100), `maxZ ${maxZ}`);
});

test("левый верхний угол надписи — uv (0,0), правый нижний — uv (1,1)", () => {
  const vs = vertices(cylinderPatch());
  const [minX, maxX] = range(vs.map((p) => p.x));
  const topLeft = vs.find((p) => near(p.x, minX) && near(p.y, 25));
  const bottomRight = vs.find((p) => near(p.x, maxX) && near(p.y, -25));
  assert.ok(near(topLeft.u, 0) && near(topLeft.v, 0), `верх-лево uv ${topLeft.u},${topLeft.v}`);
  assert.ok(near(bottomRight.u, 1) && near(bottomRight.v, 1), `низ-право uv ${bottomRight.u},${bottomRight.v}`);
});

test("нормали единичные и смотрят наружу от оси", () => {
  for (const p of vertices(cylinderPatch())) {
    assert.ok(near(Math.hypot(p.nx, p.ny, p.nz), 1), "длина нормали");
    assert.ok(near(p.nx, p.x / 100) && near(p.nz, p.z / 100) && near(p.ny, 0), "направление нормали");
  }
});

test("треугольники обходятся против часовой стрелки, если смотреть снаружи", () => {
  const patch = cylinderPatch();
  const P = (i) => [patch.positions[i * 3], patch.positions[i * 3 + 1], patch.positions[i * 3 + 2]];
  const N = (i) => [patch.normals[i * 3], patch.normals[i * 3 + 1], patch.normals[i * 3 + 2]];
  assert.ok(patch.indices.length > 0);
  for (let t = 0; t < patch.indices.length; t += 3) {
    const [a, b, c] = [patch.indices[t], patch.indices[t + 1], patch.indices[t + 2]].map(P);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const n = N(patch.indices[t]);
    assert.ok(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0, `треугольник ${t / 3}`);
  }
});

test("надпись выше формы обрезается по краям формы, а не сжимается", () => {
  const vs = vertices(cylinderPatch({ sLength: 100 }));
  const [minY, maxY] = range(vs.map((p) => p.y));
  const [minV, maxV] = range(vs.map((p) => p.v));
  assert.ok(near(minY, -25) && near(maxY, 25));
  assert.ok(near(minV, 0.25) && near(maxV, 0.75), `v ${minV}..${maxV}`);
});

test("надпись целиком за пределами формы — участка нет", () => {
  assert.equal(cylinderPatch({ sCenter: 500, sLength: 50 }), null);
});

test("thetaCenter поворачивает участок вокруг оси", () => {
  const vs = vertices(cylinderPatch({ thetaCenter: 90 * DEG }));
  const [minX, maxX] = range(vs.map((p) => p.x));
  const [minZ, maxZ] = range(vs.map((p) => p.z));
  assert.ok(near(maxX, 100) && near(minX, 50), `x ${minX}..${maxX}`);
  assert.ok(near(minZ, -100 * Math.sin(60 * DEG)) && near(maxZ, 100 * Math.sin(60 * DEG)), `z ${minZ}..${maxZ}`);
});

test("на сужающейся кверху образующей нормаль наклонена вверх", () => {
  const patch = buildPatch(
    [
      { r: 100, y: -50 },
      { r: 50, y: 50 },
    ],
    { thetaCenter: 0, thetaSpan: 60 * DEG, sCenter: 55.9, sLength: 40, thetaSegments: 8 },
  );
  for (const p of vertices(patch)) {
    assert.ok(near(Math.hypot(p.nx, p.ny, p.nz), 1));
    assert.ok(near(p.ny, 50 / Math.hypot(100, 50)), `ny ${p.ny}`);
  }
});

test("v идёт по длине образующей, а не по высоте", () => {
  // длина образующей 30 + 50 = 80; надпись на всю длину
  const patch = buildPatch(
    [
      { r: 100, y: 0 },
      { r: 100, y: 30 },
      { r: 60, y: 60 },
    ],
    { thetaCenter: 0, thetaSpan: 60 * DEG, sCenter: 40, sLength: 80, thetaSegments: 4 },
  );
  const vs = vertices(patch);
  const atBreak = vs.filter((p) => near(p.y, 30));
  assert.ok(atBreak.length > 0);
  for (const p of atBreak) assert.ok(near(p.v, (80 - 30) / 80), `v ${p.v}`);
});

test("coneProfile — усечённый конус: внизу один радиус, вверху другой", () => {
  assert.deepEqual(coneProfile(100, 60, 200), [
    { r: 100, y: -100 },
    { r: 60, y: 100 },
  ]);
});

test("sphereProfile — полуокружность от нижнего полюса до верхнего", () => {
  const profile = sphereProfile(100, 8);
  assert.equal(profile.length, 9);
  assert.ok(near(profile[0].r, 0) && near(profile[0].y, -100), "нижний полюс");
  assert.ok(near(profile[4].r, 100) && near(profile[4].y, 0), "экватор");
  assert.ok(near(profile[8].r, 0) && near(profile[8].y, 100), "верхний полюс");
  for (const p of profile) assert.ok(near(Math.hypot(p.r, p.y), 100), "точка на окружности");
  assert.ok(profile.every((p) => p.r >= 0), "радиус не отрицательный");
});

test("profileLength — длина образующей", () => {
  assert.equal(profileLength(cylinderProfile(50, 80)), 80);
  assert.ok(near(profileLength(coneProfile(100, 60, 30)), 50), "образующая конуса 40-30-50");
  assert.ok(near(profileLength(sphereProfile(100, 256)), Math.PI * 100, 0.05), "полуокружность");
});

test("radiusAt — радиус формы на заданной длине вдоль образующей", () => {
  const cone = coneProfile(100, 60, 30); // длина образующей 50
  assert.ok(near(radiusAt(cone, 0), 100));
  assert.ok(near(radiusAt(cone, 25), 80));
  assert.ok(near(radiusAt(cone, 50), 60));
  assert.ok(near(radiusAt(cone, -10), 100), "ниже формы — радиус нижнего края");
  assert.ok(near(radiusAt(cone, 999), 60), "выше формы — радиус верхнего края");
  const sphere = sphereProfile(100, 128);
  assert.ok(near(radiusAt(sphere, profileLength(sphere) / 2), 100, 0.01), "экватор сферы");
});

test("на сфере нормали смотрят от центра", () => {
  const sphere = sphereProfile(100, 64);
  const total = profileLength(sphere);
  const patch = buildPatch(sphere, { thetaCenter: 0, thetaSpan: 90 * DEG, sCenter: total / 2, sLength: total * 0.6, thetaSegments: 16 });
  for (const p of vertices(patch)) {
    const dot = (p.nx * p.x + p.ny * p.y + p.nz * p.z) / 100;
    assert.ok(dot > 0.999, `нормаль отклонена: ${dot}`);
  }
});

test("sAtHeight — длина вдоль образующей до заданной высоты", () => {
  const cylinder = cylinderProfile(50, 80);
  assert.ok(near(sAtHeight(cylinder, 0), 40));
  assert.ok(near(sAtHeight(cylinder, -40), 0));
  assert.ok(near(sAtHeight(cylinder, 40), 80));
  const cone = coneProfile(100, 60, 30); // образующая 50
  assert.ok(near(sAtHeight(cone, 0), 25));
});

test("sAtHeight за пределами формы прижимается к ближайшему краю", () => {
  const cylinder = cylinderProfile(50, 80);
  assert.ok(near(sAtHeight(cylinder, 999), 80));
  assert.ok(near(sAtHeight(cylinder, -999), 0));
});

test("sAtHeight при нескольких пересечениях берёт внешнюю поверхность", () => {
  // контур идёт вверх по радиусу 100, затем возвращается внутрь и вниз
  const profile = [
    { r: 100, y: 0 },
    { r: 100, y: 100 },
    { r: 50, y: 50 },
  ];
  assert.ok(near(sAtHeight(profile, 75), 75), "точка на внешней стенке, а не на внутренней");
});

test("sAtHeight на сфере: экватор — середина образующей", () => {
  const sphere = sphereProfile(100, 128);
  assert.ok(near(sAtHeight(sphere, 0), profileLength(sphere) / 2, 0.01));
});

test("на плавной образующей нормали в узлах сглажены: на сфере они строго радиальные", () => {
  const sphere = sphereProfile(100, 32);
  const total = profileLength(sphere);
  const patch = buildPatch(sphere, { thetaCenter: 0, thetaSpan: 60 * DEG, sCenter: total / 2, sLength: total * 0.5, thetaSegments: 4 });
  for (const p of vertices(patch)) {
    const onNode = sphere.some((node) => near(node.y, p.y, 1e-3));
    if (!onNode) continue;
    const dot = (p.nx * p.x + p.ny * p.y + p.nz * p.z) / 100;
    assert.ok(dot > 0.99999, `нормаль в узле отклонена: ${dot}`);
  }
});

test("на изломе образующей нормали не сглаживаются", () => {
  // вертикальная стенка, затем горизонтальная полка внутрь
  const profile = [
    { r: 100, y: 0 },
    { r: 100, y: 100 },
    { r: 50, y: 100 },
  ];
  const patch = buildPatch(profile, { thetaCenter: 0, thetaSpan: 10 * DEG, sCenter: 75, sLength: 150, thetaSegments: 1 });
  const atCorner = vertices(patch).filter((p) => near(p.y, 100) && near(Math.hypot(p.x, p.z), 100));
  const vertical = atCorner.filter((p) => near(p.ny, 0));
  const horizontal = atCorner.filter((p) => near(p.ny, 1));
  assert.ok(vertical.length > 0, "у стенки нормаль горизонтальная");
  assert.ok(horizontal.length > 0, "у полки нормаль смотрит вверх");
});
