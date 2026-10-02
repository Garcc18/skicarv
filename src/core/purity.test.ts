// El código puro (análisis, protocolo, unión por seq, simulador) debe ser determinista y
// no depender del navegador: así se ejecuta igual en la app, en los tests y sobre grabaciones.
// tsconfig.core.json ya impide usar el DOM; este test vigila lo que ES sí permite.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PURE_DIRS = ["core", "protocol", "sync", "sim"];

const FORBIDDEN: [RegExp, string][] = [
  [/\bDate\.now\s*\(/, "Date.now()"],
  [/\bnew\s+Date\s*\(/, "new Date()"],
  [/\bMath\.random\s*\(/, "Math.random() (usa el PRNG con semilla)"],
  [/\bperformance\./, "performance"],
  [/\bset(Timeout|Interval)\s*\(/, "temporizadores"],
  [/\b(window|document|navigator|localStorage|indexedDB)\b/, "APIs del navegador"],
];

function files(dir: string): string[] {
  let out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out = out.concat(files(p));
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
    }
  } catch {
    // la carpeta aún no existe en esta fase
  }
  return out;
}

// Quita comentarios para no dar falsos positivos con la documentación.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("pureza del núcleo", () => {
  const all = PURE_DIRS.flatMap((d) => files(join(ROOT, d)));

  it("hay archivos que comprobar", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it("no usa nada no determinista ni del navegador", () => {
    const hits: string[] = [];
    for (const f of all) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const [re, what] of FORBIDDEN) {
        if (re.test(code)) hits.push(`${relative(ROOT, f)}: ${what}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
