import { FrameType, Opcode, Size, auxFrameSize, mainFrameSize } from "./constants";
import type {
  ControlCommand,
  FrameHeader,
  GpsFrame,
  ImuRaw,
  InfoMsg,
  SensorFrame,
  StatusMsg,
} from "./types";

const LE = true;

// Escritura comprobada: un valor fuera de rango es un error del llamador (p. ej. el
// simulador debe saturar como lo haría el sensor), nunca se trunca en silencio.
function check(v: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name}=${v} fuera de rango [${min}, ${max}] o no entero`);
  }
  return v;
}
const u8 = (dv: DataView, o: number, v: number, n: string) => dv.setUint8(o, check(v, 0, 0xff, n));
const u16 = (dv: DataView, o: number, v: number, n: string) =>
  dv.setUint16(o, check(v, 0, 0xffff, n), LE);
const i16 = (dv: DataView, o: number, v: number, n: string) =>
  dv.setInt16(o, check(v, -0x8000, 0x7fff, n), LE);
const u32 = (dv: DataView, o: number, v: number, n: string) =>
  dv.setUint32(o, check(v, 0, 0xffffffff, n), LE);
const i32 = (dv: DataView, o: number, v: number, n: string) =>
  dv.setInt32(o, check(v, -0x80000000, 0x7fffffff, n), LE);

function writeHeader(dv: DataView, h: FrameHeader): void {
  u8(dv, 0, h.type, "type");
  u8(dv, 1, h.flags, "flags");
  u16(dv, 2, h.valid, "valid");
  u32(dv, 4, h.seq, "seq");
  u32(dv, 8, h.tUs, "tUs");
}

function writeImu(dv: DataView, o: number, m: ImuRaw): void {
  i16(dv, o, m.ax, "ax");
  i16(dv, o + 2, m.ay, "ay");
  i16(dv, o + 4, m.az, "az");
  i16(dv, o + 6, m.gx, "gx");
  i16(dv, o + 8, m.gy, "gy");
  i16(dv, o + 10, m.gz, "gz");
}

/** Trama MAIN (si `header.type` es MAIN; requiere `baro`) o AUX. */
export function serializeSensorFrame(f: SensorFrame): Uint8Array<ArrayBuffer> {
  const n = f.fsr.length;
  const isMain = f.header.type === FrameType.MAIN;
  if (!isMain && f.header.type !== FrameType.AUX) {
    throw new RangeError(`tipo ${f.header.type} no es MAIN ni AUX`);
  }
  if (isMain && !f.baro) throw new RangeError("una trama MAIN necesita baro");
  const out = new Uint8Array(isMain ? mainFrameSize(n) : auxFrameSize(n));
  const dv = new DataView(out.buffer);
  writeHeader(dv, f.header);
  writeImu(dv, Size.HEADER, f.imu);
  const fsrOff = Size.HEADER + Size.IMU;
  f.fsr.forEach((v, i) => u16(dv, fsrOff + 2 * i, v, `fsr${i + 1}`));
  if (isMain && f.baro) {
    const o = fsrOff + 2 * n;
    i32(dv, o, f.baro.pPaX100, "pPaX100");
    i16(dv, o + 4, f.baro.tCdeg, "tCdeg");
  }
  return out;
}

export function serializeGpsFrame(g: GpsFrame): Uint8Array<ArrayBuffer> {
  if (g.header.type !== FrameType.GPS) throw new RangeError("la cabecera GPS debe ser tipo GPS");
  const out = new Uint8Array(Size.GPS);
  const dv = new DataView(out.buffer);
  writeHeader(dv, g.header);
  const o = Size.HEADER;
  i32(dv, o, g.latE7, "latE7");
  i32(dv, o + 4, g.lonE7, "lonE7");
  i32(dv, o + 8, g.altMm, "altMm");
  u16(dv, o + 12, g.speedCms, "speedCms");
  u16(dv, o + 14, g.headingCdeg, "headingCdeg");
  u8(dv, o + 16, g.fix, "fix");
  u8(dv, o + 17, g.sats, "sats");
  u16(dv, o + 18, g.hdopX100, "hdopX100");
  u32(dv, o + 20, g.itowMs, "itowMs");
  return out;
}

export function serializeStatus(s: StatusMsg): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Size.STATUS);
  const dv = new DataView(out.buffer);
  u8(dv, 0, s.streaming, "streaming");
  u8(dv, 1, s.syncState, "syncState");
  u16(dv, 2, s.batteryMv, "batteryMv");
  u32(dv, 4, s.framesSent, "framesSent");
  u32(dv, 8, s.framesDropped, "framesDropped");
  i32(dv, 12, s.clockOffsetUs, "clockOffsetUs");
  return out;
}

export function serializeInfo(m: InfoMsg): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Size.INFO);
  const dv = new DataView(out.buffer);
  u8(dv, 0, m.protoVer, "protoVer");
  u8(dv, 1, m.role, "role");
  u8(dv, 2, m.fwVer, "fwVer");
  u8(dv, 3, m.side, "side");
  u8(dv, 4, m.nFsr, "nFsr");
  u8(dv, 5, m.rateHz, "rateHz");
  u8(dv, 6, m.gpsRateHz, "gpsRateHz");
  u8(dv, 7, m.reserved, "reserved");
  dv.setFloat32(8, m.accLsbPerG, LE);
  dv.setFloat32(12, m.gyroLsbPerDps, LE);
  u16(dv, 16, m.present, "present");
  return out;
}

/** Bytes de un comando para escribir en CONTROL. */
export function encodeControl(c: ControlCommand): Uint8Array<ArrayBuffer> {
  switch (c.op) {
    case "start":
      return Uint8Array.of(Opcode.START);
    case "stop":
      return Uint8Array.of(Opcode.STOP);
    case "resetCounters":
      return Uint8Array.of(Opcode.RESET_COUNTERS);
    case "setTime": {
      const out = new Uint8Array(9);
      const dv = new DataView(out.buffer);
      dv.setUint8(0, Opcode.SET_TIME);
      dv.setBigInt64(1, BigInt.asIntN(64, c.hostUs), LE);
      return out;
    }
    case "simFail": {
      const out = new Uint8Array(3);
      const dv = new DataView(out.buffer);
      dv.setUint8(0, Opcode.SIM_FAIL);
      u16(dv, 1, c.mask, "mask");
      return out;
    }
  }
}
