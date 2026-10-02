// Registro e informe de la prueba en segundo plano. Puro: sin DOM, para poder probarlo.

export interface DevWindow {
  name: string;
  frames: number; // tramas recibidas en la ventana
  lost: number; // tramas perdidas (huecos de seq) en la ventana
  maxGapMs: number; // mayor hueco entre llegadas en la ventana
  /** min(llegada − seq·10 ms) en la ventana; su pendiente en el tiempo da la deriva del reloj. */
  minLagMs: number | null;
  connected: boolean;
}

export interface WindowRec {
  tMs: number; // fin de la ventana, ms desde el inicio de la prueba
  durMs: number; // duración real de la ventana (si JS se suspendió, mucho más de 10 s)
  visible: boolean;
  devs: DevWindow[];
}

export interface LogEvent {
  tMs: number;
  text: string;
}

export interface TestLog {
  startedIso: string;
  userAgent: string;
  options: { wakeLock: boolean; silentAudio: boolean; beepOnly: boolean };
  windows: WindowRec[];
  events: LogEvent[];
  /** Pausas del temporizador de 1 s mayores que el umbral (JS suspendido). */
  stalls: { tMs: number; durMs: number }[];
  speech: { requested: number; started: number; errors: number };
}

export const WINDOW_MS = 10_000;
/** Un tick de 1 s que llega más de 2,5 s tarde = página suspendida. */
export const STALL_MS = 2_500;
/** Ventana aceptable: al menos el 90 % de las tramas esperadas. */
export const MIN_RATE_FRACTION = 0.9;

export interface DevSummary {
  name: string;
  frames: number;
  meanFps: number;
  badWindows: number;
  lost: number;
  maxGapMs: number;
  disconnects: number;
  driftPpm: number | null;
}

export interface Summary {
  durationS: number;
  windows: number;
  hiddenWindows: number;
  devs: DevSummary[];
  stalls: number;
  longestStallS: number;
  speech: TestLog["speech"];
  ok: boolean;
  problems: string[];
}

/** Pendiente por mínimos cuadrados de y frente a x. */
export function slope(points: [number, number][]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  return sxx > 0 ? sxy / sxx : null;
}

export function summarize(log: TestLog, rateHz = 100): Summary {
  const w = log.windows;
  const durationS = w.length ? w.reduce((s, x) => s + x.durMs, 0) / 1000 : 0;
  const names = [...new Set(w.flatMap((x) => x.devs.map((d) => d.name)))];
  const problems: string[] = [];

  const devs: DevSummary[] = names.map((name) => {
    const rows = w.map((x) => ({ win: x, d: x.devs.find((d) => d.name === name) })).filter((r) => r.d);
    const frames = rows.reduce((s, r) => s + r.d!.frames, 0);
    const span = rows.reduce((s, r) => s + r.win.durMs, 0) / 1000;
    const badWindows = rows.filter((r) => r.d!.frames < MIN_RATE_FRACTION * rateHz * (r.win.durMs / 1000)).length;
    const pts = rows
      .filter((r) => r.d!.minLagMs !== null)
      .map((r) => [r.win.tMs, r.d!.minLagMs!] as [number, number]);
    const s = slope(pts);
    return {
      name,
      frames,
      meanFps: span > 0 ? frames / span : 0,
      badWindows,
      lost: rows.reduce((t, r) => t + r.d!.lost, 0),
      maxGapMs: Math.max(0, ...rows.map((r) => r.d!.maxGapMs)),
      disconnects: log.events.filter((e) => e.text.startsWith(`${name}: desconectado`)).length,
      // llegada − seq·10ms crece si el reloj de la placa va lento respecto al del móvil
      driftPpm: s === null ? null : s * 1e6,
    };
  });

  const longestStallS = Math.max(0, ...log.stalls.map((s) => s.durMs)) / 1000;
  if (!w.length) problems.push("no hay ventanas registradas");
  for (const d of devs) {
    if (d.badWindows) problems.push(`${d.name}: ${d.badWindows} ventanas con menos del 90 % de tramas`);
    if (d.disconnects) problems.push(`${d.name}: ${d.disconnects} desconexiones`);
    if (d.maxGapMs > 1000) problems.push(`${d.name}: hueco de ${(d.maxGapMs / 1000).toFixed(1)} s sin tramas`);
  }
  if (log.stalls.length) problems.push(`JavaScript suspendido ${log.stalls.length} veces (máx. ${longestStallS.toFixed(1)} s)`);
  const { requested, started } = log.speech;
  if (requested > 0 && started < 0.95 * requested && !log.options.beepOnly) {
    problems.push(`voz: solo empezaron ${started} de ${requested} mensajes`);
  }

  return {
    durationS,
    windows: w.length,
    hiddenWindows: w.filter((x) => !x.visible).length,
    devs,
    stalls: log.stalls.length,
    longestStallS,
    speech: log.speech,
    ok: problems.length === 0,
    problems,
  };
}

const f1 = (x: number) => x.toFixed(1);

export function formatReport(log: TestLog, s: Summary): string {
  const lines: string[] = [];
  lines.push(`RESULTADO: ${s.ok ? "OK — datos y voz continuos" : "FALLA"}`);
  for (const p of s.problems) lines.push(`  · ${p}`);
  lines.push("");
  lines.push(`Inicio: ${log.startedIso}`);
  lines.push(`Navegador: ${log.userAgent}`);
  lines.push(
    `Opciones: wakeLock=${log.options.wakeLock} audioSilencioso=${log.options.silentAudio} soloPitido=${log.options.beepOnly}`,
  );
  lines.push(`Duración: ${f1(s.durationS / 60)} min, ${s.windows} ventanas (${s.hiddenWindows} con la página oculta)`);
  lines.push(`Suspensiones de JS: ${s.stalls} (la más larga ${f1(s.longestStallS)} s)`);
  lines.push(`Voz: ${s.speech.started}/${s.speech.requested} empezaron, ${s.speech.errors} errores`);
  for (const d of s.devs) {
    lines.push(
      `${d.name}: ${d.frames} tramas, ${f1(d.meanFps)} tramas/s, ${d.lost} perdidas, ` +
        `hueco máx. ${Math.round(d.maxGapMs)} ms, ${d.badWindows} ventanas malas, ${d.disconnects} desconexiones, ` +
        `deriva ${d.driftPpm === null ? "–" : f1(d.driftPpm) + " ppm"}`,
    );
  }
  lines.push("");
  lines.push("Eventos:");
  for (const e of log.events) lines.push(`  ${f1(e.tMs / 1000)} s  ${e.text}`);
  lines.push("");
  lines.push("Ventanas (t_s, dur_s, visible, [bota: tramas/perdidas/huecoMáx_ms/conectada])");
  for (const x of log.windows) {
    const ds = x.devs.map((d) => `${d.name}: ${d.frames}/${d.lost}/${Math.round(d.maxGapMs)}/${d.connected ? "sí" : "no"}`);
    lines.push(`  ${f1(x.tMs / 1000)}, ${f1(x.durMs / 1000)}, ${x.visible ? "sí" : "no"}, ${ds.join("; ")}`);
  }
  return lines.join("\n");
}
