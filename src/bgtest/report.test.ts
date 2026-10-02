import { describe, expect, it } from "vitest";
import { formatReport, slope, summarize, type TestLog, type WindowRec } from "./report";

function log(windows: WindowRec[], extra: Partial<TestLog> = {}): TestLog {
  return {
    startedIso: "2026-10-02T10:00:00Z",
    userAgent: "test",
    options: { wakeLock: false, silentAudio: false, beepOnly: false },
    windows,
    events: [],
    stalls: [],
    speech: { requested: windows.length, started: windows.length, errors: 0 },
    ...extra,
  };
}

const win = (i: number, frames = 1000, lag = 50, durMs = 10_000): WindowRec => ({
  tMs: (i + 1) * 10_000,
  durMs,
  visible: i === 0,
  devs: [{ name: "SKI-R", frames, lost: 0, maxGapMs: 40, minLagMs: lag, connected: true }],
});

describe("informe de la prueba en segundo plano", () => {
  it("60 ventanas completas: OK", () => {
    const l = log(Array.from({ length: 60 }, (_, i) => win(i)));
    const s = summarize(l);
    expect(s.ok).toBe(true);
    expect(s.durationS).toBe(600);
    expect(s.devs[0]!.meanFps).toBeCloseTo(100);
    expect(s.hiddenWindows).toBe(59);
    expect(formatReport(l, s)).toContain("RESULTADO: OK");
  });

  it("ventanas con pocas tramas, suspensión de JS y voz que no suena: FALLA con motivos", () => {
    const ws = Array.from({ length: 10 }, (_, i) => win(i, i < 5 ? 1000 : 200));
    ws.push(win(10, 1000, 50, 120_000)); // 2 min sin ticks
    const l = log(ws, {
      stalls: [{ tMs: 110_000, durMs: 110_000 }],
      speech: { requested: 11, started: 5, errors: 0 },
      events: [{ tMs: 60_000, text: "SKI-R: desconectado" }],
    });
    const s = summarize(l);
    expect(s.ok).toBe(false);
    expect(s.devs[0]!.badWindows).toBe(6); // 5 con 200 tramas + la de 120 s con 1000
    expect(s.devs[0]!.disconnects).toBe(1);
    expect(s.problems.join("\n")).toMatch(/suspendido 1 veces/);
    expect(s.problems.join("\n")).toMatch(/voz: solo empezaron 5 de 11/);
  });

  it("deriva del reloj: pendiente de min(llegada − seq·10ms)", () => {
    // +40 ppm: 0,4 ms más de retraso cada 10 s
    const l = log(Array.from({ length: 60 }, (_, i) => win(i, 1000, 50 + 0.4 * i)));
    expect(summarize(l).devs[0]!.driftPpm).toBeCloseTo(40, 6);
    expect(slope([[0, 0], [1, 1]])).toBeNull();
  });
});
