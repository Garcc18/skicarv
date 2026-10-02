import { describe, expect, it } from "vitest";
import {
  Bit,
  FrameFlag,
  FrameType,
  Opcode,
  Role,
  Side,
  auxFrameSize,
  bitFsr,
  encodeControl,
  gpsToPhysical,
  imuToPhysical,
  isValid,
  mainFrameSize,
  parseControl,
  parseGpsFrame,
  parseInfo,
  parseSensorFrame,
  parseStatus,
  sensorDefs,
  sensorState,
  serializeGpsFrame,
  serializeInfo,
  serializeSensorFrame,
  serializeStatus,
  type GpsFrame,
  type SensorFrame,
} from "./index";

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.replace(/\s+/g, "").match(/../g)!.map((b) => parseInt(b, 16)));

// Tramas escritas a mano siguiendo los structs del firmware (no salen del serializador).
const MAIN_HEX =
  "01 03 ff03 45230100 0df0ad0b" + //            header: MAIN, synced|sim, valid 0x03FF, seq 0x12345, t 0x0BADF00D
  "0040 ffff 00c0 6806 98f9 0000" + //           imu: ax 16384, ay -1, az -16384, gx 1640, gy -1640, gz 0
  "7800 ff0f 0000 0100 0001 e803 d007 b80b" + // fsr: 120 4095 0 1 256 1000 2000 3000
  "149c9a00 2e09"; //                            baro: 10132500 (101325,00 Pa), 2350 (23,50 °C)

const AUX_HEX =
  "02 00 fd01 0a000000 10270000" + //            AUX, valid 0x01FD (IMU + FSR 2..8: FSR1 sin señal), seq 10, t 10000
  "0000 0000 0040 0000 0000 0000" + //
  "0000 6400 c800 2c01 9001 f401 5802 bc02";

const INFO_HEX = "03 01 03 02 08 64 05 00 00008046 33338341 ff83"; // v3, MAIN, fw3, derecha, 8 FSR, 100 Hz, 5 Hz, 16384, 16.4, 0x83FF
const STATUS_HEX = "01 01 a00f e8030000 05000000 18fcffff"; // streaming, sync, 4000 mV, 1000 env., 5 desc., offset -1000

const GPS_HEX =
  "03 01 0100 14000000 40420f00" + // GPS, synced, fix válido, seq 20, t 1000000
  "0084d717 00000000 a0bb0d00" + // lat 40° (400000000), lon 0°, alt 900 m
  "9600 3075 03 0b 5a00 e8030000"; // 1,5 m/s, 300°, fix 3D, 11 sats, hdop 0,9, itow 1000 ms

describe("parseSensorFrame", () => {
  it("lee una trama MAIN con el layout del firmware", () => {
    const r = parseSensorFrame(hex(MAIN_HEX));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.value;
    expect(f.header).toEqual({ type: FrameType.MAIN, flags: 3, valid: 0x03ff, seq: 0x12345, tUs: 0x0badf00d });
    expect(f.imu).toEqual({ ax: 16384, ay: -1, az: -16384, gx: 1640, gy: -1640, gz: 0 });
    expect(f.fsr).toEqual([120, 4095, 0, 1, 256, 1000, 2000, 3000]);
    expect(f.baro).toEqual({ pPaX100: 10132500, tCdeg: 2350 });
  });

  it("lee una trama AUX (sin barómetro)", () => {
    const r = parseSensorFrame(hex(AUX_HEX));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.header.type).toBe(FrameType.AUX);
    expect(r.value.baro).toBeUndefined();
    expect(r.value.fsr).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
  });

  it("acepta DataView con desplazamiento (como entrega Web Bluetooth)", () => {
    const raw = hex(MAIN_HEX);
    const padded = new Uint8Array(raw.length + 7);
    padded.set(raw, 5);
    const r = parseSensorFrame(new DataView(padded.buffer, 5, raw.length));
    expect(r.ok && r.value.header.seq).toBe(0x12345);
  });

  it.each([
    ["MAIN truncada", MAIN_HEX, 45],
    ["MAIN con un byte de más", MAIN_HEX + "00", 47],
    ["AUX truncada", AUX_HEX, 39],
    ["AUX con tamaño de MAIN", AUX_HEX + "000000000000", 46],
  ])("rechaza tamaño erróneo: %s", (_name, h, len) => {
    const full = hex(h);
    const bytes = new Uint8Array(len);
    bytes.set(full.subarray(0, Math.min(len, full.length)));
    const r = parseSensorFrame(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("size");
  });

  it("rechaza trama vacía, tipo GPS y tipo desconocido en FRAME", () => {
    expect(parseSensorFrame(new Uint8Array(0))).toMatchObject({ ok: false, error: { code: "size" } });
    const gps = hex(GPS_HEX);
    expect(parseSensorFrame(gps)).toMatchObject({ ok: false, error: { code: "type" } });
    const bad = hex(MAIN_HEX);
    bad[0] = 0x7f;
    expect(parseSensorFrame(bad)).toMatchObject({ ok: false, error: { code: "type" } });
  });

  it("los tamaños coinciden con los static_assert del firmware", () => {
    expect(mainFrameSize()).toBe(46);
    expect(auxFrameSize()).toBe(40);
  });
});

describe("máscara valid", () => {
  it("bits del firmware", () => {
    expect(Bit.IMU).toBe(0x0001);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(bitFsr)).toEqual([2, 4, 8, 16, 32, 64, 128, 256]);
    expect(Bit.BARO).toBe(0x0200);
    expect(Bit.GPS).toBe(0x8000);
  });

  it("un FSR con bit a 0 es inválido aunque su valor crudo sea un número", () => {
    const r = parseSensorFrame(hex(AUX_HEX));
    if (!r.ok) throw new Error(r.error.message);
    const { valid } = r.value.header;
    expect(isValid(valid, bitFsr(0))).toBe(false); // FSR1: crudo 0, pero NO es un 0 medido
    expect(isValid(valid, bitFsr(1))).toBe(true);
    expect(isValid(valid, Bit.IMU)).toBe(true);
  });

  it("estado de sensor: OK / sin señal / no instalado", () => {
    const infoAux = { role: Role.AUX, nFsr: 8 };
    const defs = sensorDefs(infoAux);
    expect(defs.map((d) => d.id)).toEqual(["imu", "fsr1", "fsr2", "fsr3", "fsr4", "fsr5", "fsr6", "fsr7", "fsr8"]);
    const present = Bit.IMU | (0x01fe & ~bitFsr(7)); // FSR8 no instalado
    const valid = Bit.IMU | bitFsr(1) | bitFsr(2); // FSR1 instalado pero sin señal
    const st = Object.fromEntries(defs.map((d) => [d.id, sensorState(present, valid, d)]));
    expect(st.imu).toBe("ok");
    expect(st.fsr1).toBe("fail");
    expect(st.fsr2).toBe("ok");
    expect(st.fsr8).toBe("none");
  });

  it("la bota principal añade barómetro y GPS (validez del GPS en su trama)", () => {
    const defs = sensorDefs({ role: Role.MAIN, nFsr: 8 });
    const gps = defs.find((d) => d.id === "gps")!;
    expect(gps.validIn).toBe("gps");
    expect(sensorState(Bit.GPS, 0x0001, gps)).toBe("ok");
    expect(sensorState(Bit.GPS, 0x0000, gps)).toBe("fail");
    expect(sensorState(0, 0x0001, gps)).toBe("none");
  });
});

describe("GPS, STATUS, INFO", () => {
  it("GPS: campos y unidades", () => {
    const r = parseGpsFrame(hex(GPS_HEX));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.value;
    expect(g.header).toMatchObject({ type: FrameType.GPS, valid: 1, seq: 20, tUs: 1_000_000 });
    expect(g.lonE7).toBe(0);
    expect(g.altMm).toBe(900_000);
    const p = gpsToPhysical(g);
    expect(p.lat).toBeCloseTo(40, 7);
    expect(p.altM).toBe(900);
    expect(p.speedMs).toBe(1.5);
    expect(p.headingDeg).toBe(300);
    expect(p).toMatchObject({ fix: 3, sats: 11, hdop: 0.9 });
    expect(g.itowMs).toBe(1000);
  });

  it("GPS: tamaño y tipo erróneos", () => {
    expect(parseGpsFrame(hex(GPS_HEX).subarray(0, 35))).toMatchObject({ ok: false, error: { code: "size" } });
    expect(parseGpsFrame(hex(MAIN_HEX))).toMatchObject({ ok: false, error: { code: "type" } });
  });

  it("STATUS", () => {
    const r = parseStatus(hex(STATUS_HEX));
    expect(r).toEqual({
      ok: true,
      value: { streaming: 1, syncState: 1, batteryMv: 4000, framesSent: 1000, framesDropped: 5, clockOffsetUs: -1000 },
    });
    expect(parseStatus(hex(STATUS_HEX).subarray(0, 15)).ok).toBe(false);
  });

  it("INFO", () => {
    const r = parseInfo(hex(INFO_HEX));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      protoVer: 3, role: Role.MAIN, fwVer: 3, side: Side.RIGHT, nFsr: 8, rateHz: 100, gpsRateHz: 5, present: 0x83ff,
    });
    expect(r.value.accLsbPerG).toBe(16384);
    expect(r.value.gyroLsbPerDps).toBeCloseTo(16.4, 5);
  });

  it("INFO: rechaza otra versión de protocolo y tamaño erróneo", () => {
    const v2 = hex(INFO_HEX);
    v2[0] = 2;
    expect(parseInfo(v2)).toMatchObject({ ok: false, error: { code: "version" } });
    expect(parseInfo(hex(INFO_HEX).subarray(0, 17))).toMatchObject({ ok: false, error: { code: "size" } });
  });

  it("IMU a unidades físicas con las escalas de INFO", () => {
    const r = parseSensorFrame(hex(MAIN_HEX));
    if (!r.ok) throw new Error();
    const p = imuToPhysical(r.value.imu, { accLsbPerG: 16384, gyroLsbPerDps: 16.4 });
    expect(p.acc).toEqual([1, -1 / 16384, -1]);
    expect(p.gyro[0]).toBeCloseTo(100, 10);
    expect(p.gyro[1]).toBeCloseTo(-100, 10);
  });
});

describe("serialización (ida y vuelta)", () => {
  it("MAIN, AUX, GPS, STATUS e INFO dan exactamente los mismos bytes", () => {
    for (const h of [MAIN_HEX, AUX_HEX]) {
      const r = parseSensorFrame(hex(h));
      if (!r.ok) throw new Error(r.error.message);
      expect(serializeSensorFrame(r.value)).toEqual(hex(h));
    }
    const g = parseGpsFrame(hex(GPS_HEX));
    if (!g.ok) throw new Error();
    expect(serializeGpsFrame(g.value)).toEqual(hex(GPS_HEX));
    const s = parseStatus(hex(STATUS_HEX));
    if (!s.ok) throw new Error();
    expect(serializeStatus(s.value)).toEqual(hex(STATUS_HEX));
    const i = parseInfo(hex(INFO_HEX));
    if (!i.ok) throw new Error();
    expect(serializeInfo(i.value)).toEqual(hex(INFO_HEX));
  });

  it("valores fuera de rango lanzan error en vez de truncarse", () => {
    const f: SensorFrame = {
      header: { type: FrameType.AUX, flags: 0, valid: 1, seq: 0, tUs: 0 },
      imu: { ax: 40000, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 },
      fsr: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(() => serializeSensorFrame(f)).toThrow(RangeError);
    f.imu.ax = 1.5;
    expect(() => serializeSensorFrame(f)).toThrow(RangeError);
    f.imu.ax = 0;
    f.header.seq = -1;
    expect(() => serializeSensorFrame(f)).toThrow(RangeError);
    f.header.seq = 0;
    f.header.type = FrameType.MAIN; // MAIN sin barómetro
    expect(() => serializeSensorFrame(f)).toThrow(RangeError);
  });

  it("seq y t_us usan los 32 bits completos", () => {
    const g: GpsFrame = {
      header: { type: FrameType.GPS, flags: FrameFlag.TIME_SYNCED, valid: 0, seq: 0xffffffff, tUs: 0xfffffffe },
      latE7: -900_000_000, lonE7: 1_800_000_000, altMm: -100, speedCms: 65535, headingCdeg: 35999,
      fix: 0, sats: 0, hdopX100: 9999, itowMs: 604_800_000,
    };
    const r = parseGpsFrame(serializeGpsFrame(g));
    expect(r).toEqual({ ok: true, value: g });
  });
});

describe("CONTROL", () => {
  it("codifica los comandos como el firmware los espera", () => {
    expect(encodeControl({ op: "start" })).toEqual(Uint8Array.of(Opcode.START));
    expect(encodeControl({ op: "stop" })).toEqual(Uint8Array.of(0x02));
    expect(encodeControl({ op: "resetCounters" })).toEqual(Uint8Array.of(0x03));
    expect(encodeControl({ op: "simFail", mask: 0x8003 })).toEqual(hex("20 0380"));
    expect(encodeControl({ op: "setTime", hostUs: 1_000_000n })).toEqual(hex("10 40420f0000000000"));
    expect(encodeControl({ op: "setTime", hostUs: -1n })).toEqual(hex("10 ffffffffffffffff"));
  });

  it("decodifica con las reglas de ControlCB (longitudes mínimas)", () => {
    for (const c of [
      { op: "start" }, { op: "stop" }, { op: "resetCounters" },
      { op: "setTime", hostUs: 123_456_789_012n }, { op: "simFail", mask: 0x0201 },
    ] as const) {
      expect(parseControl(encodeControl(c))).toEqual({ ok: true, value: c });
    }
    expect(parseControl(hex("10 0000"))).toMatchObject({ ok: false, error: { code: "size" } });
    expect(parseControl(hex("20 01"))).toMatchObject({ ok: false, error: { code: "size" } });
    expect(parseControl(hex("99"))).toMatchObject({ ok: false, error: { code: "opcode" } });
    expect(parseControl(new Uint8Array(0))).toMatchObject({ ok: false, error: { code: "size" } });
  });
});
