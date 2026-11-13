// Собирает архив плагина для релиза: dist/Wrap3D-<версия>.zip и dist/SHA256SUMS.txt.
// В архиве одна папка Wrap3D — её manifest.json выбирают в UXP Developer Tools.
// Запуск: npm run package

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin/manifest.json"), "utf8"));
const name = `Wrap3D-${manifest.version}.zip`;
const dist = path.join(root, "dist");
const archive = path.join(dist, name);

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(archive, { force: true });

// Копия во временной папке: в архив не должны попасть служебные файлы системы.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "wrap3d-"));
try {
  fs.cpSync(path.join(root, "plugin"), path.join(stage, "Wrap3D"), {
    recursive: true,
    filter: (source) => path.basename(source) !== ".DS_Store",
  });
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "Wrap3D", "LICENSE"));
  execFileSync("zip", ["-r", "-q", "-X", archive, "Wrap3D"], { cwd: stage });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

const sha = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${sha}  ${name}\n`);
console.log(`${name}  ${(fs.statSync(archive).size / 1024).toFixed(0)} КБ  sha256 ${sha.slice(0, 16)}…`);
