import {
  FrameType,
  NUM_FSR,
  Opcode,
  PROTO_VERSION,
  Size,
  auxFrameSize,
  mainFrameSize,
  type FrameTypeCode,
} from "./constants";
import type {
  BaroRaw,
  Bytes,
  ControlCommand,
  FrameHeader,
  GpsFrame,
  ImuRaw,
  InfoMsg,
  ParseErrorCode,
  ParseResult,
  SensorFrame,
  StatusMsg,
} from "./types";

const LE = true;

export function asView(b: Bytes): DataView {
  if (b instanceof DataView) return b;
  if (b instanceof Uint8Array) return new DataView(b.buffer, b.byteOffset, b.byteLength);
  return new DataView(b);
}

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(code: ParseErrorCode, message: string): ParseResult<T> => ({
  ok: false,
  error: { code, message },
});

function readHeader(dv: DataView): FrameHeader {
  return {
    type: dv.getUint8(0) as FrameTypeCode,
    flags: dv.getUint8(1),
    valid: dv.getUint16(2, LE),
    seq: dv.getUint32(4, LE),
    tUs: dv.getUint32(8, LE),
  };
}

function readImu(dv: DataView, o: number): ImuRaw {
  return {
    ax: dv.getInt16(o, LE),
    ay: dv.getInt16(o + 2, LE),
    az: dv.getInt16(o + 4, LE),
    gx: dv.getInt16(o + 6, LE),
    gy: dv.getInt16(o + 8, LE),
    gz: dv.getInt16(o + 10, LE),
  };
}

function readBaro(dv: DataView, o: number): BaroRaw {
  return { pPaX100: dv.getInt32(o, LE), tCdeg: dv.getInt16(o + 4, LE) };
}

/**
 * Trama de la característica FRAME (MAIN o AUX). El tamaño debe ser exacto: una trama
 * truncada o con bytes de más se rechaza en vez de leer basura.
 */
export function parseSensorFrame(bytes: Bytes, nFsr = NUM_FSR): ParseResult<SensorFrame> {
  const dv = asView(bytes);
  if (dv.byteLength < 1) return fail("size", "trama vacía");
  const type = dv.getUint8(0);
  let expected: number;
  if (type === FrameType.MAIN) expected = mainFrameSize(nFsr);
  else if (type === FrameType.AUX) expected = auxFrameSize(nFsr);
  else return fail("type", `tipo de trama 0x${type.toString(16)} no válido en FRAME`);
  if (dv.byteLength !== expected) {
    return fail("size", `trama tipo 0x0${type} de ${dv.byteLength} B; se esperaban ${expected} B`);
  }
  const header = readHeader(dv);
  const imu = readImu(dv, Size.HEADER);
  const fsr: number[] = [];
  const fsrOff = Size.HEADER + Size.IMU;
  for (let i = 0; i < nFsr; i++) fsr.push(dv.getUint16(fsrOff + 2 * i, LE));
  const frame: SensorFrame = { header, imu, fsr };
  if (type === FrameType.MAIN) frame.baro = readBaro(dv, fsrOff + 2 * nFsr);
  return ok(frame);
}

/** Trama de la característica GPS. */
export function parseGpsFrame(bytes: Bytes): ParseResult<GpsFrame> {
  const dv = asView(bytes);
  if (dv.byteLength < 1) return fail("size", "trama vacía");
  const type = dv.getUint8(0);
  if (type !== FrameType.GPS) return fail("type", `tipo 0x${type.toString(16)} no es GPS`);
  if (dv.byteLength !== Size.GPS) {
    return fail("size", `trama GPS de ${dv.byteLength} B; se esperaban ${Size.GPS} B`);
  }
  const o = Size.HEADER;
  return ok({
    header: readHeader(dv),
    latE7: dv.getInt32(o, LE),
    lonE7: dv.getInt32(o + 4, LE),
    altMm: dv.getInt32(o + 8, LE),
    speedCms: dv.getUint16(o + 12, LE),
    headingCdeg: dv.getUint16(o + 14, LE),
    fix: dv.getUint8(o + 16),
    sats: dv.getUint8(o + 17),
    hdopX100: dv.getUint16(o + 18, LE),
    itowMs: dv.getUint32(o + 20, LE),
  });
}

export function parseStatus(bytes: Bytes): ParseResult<StatusMsg> {
  const dv = asView(bytes);
  if (dv.byteLength !== Size.STATUS) {
    return fail("size", `STATUS de ${dv.byteLength} B; se esperaban ${Size.STATUS} B`);
  }
  return ok({
    streaming: dv.getUint8(0),
    syncState: dv.getUint8(1),
    batteryMv: dv.getUint16(2, LE),
    framesSent: dv.getUint32(4, LE),
    framesDropped: dv.getUint32(8, LE),
    clockOffsetUs: dv.getInt32(12, LE),
  });
}

/** INFO. Rechaza otras versiones del protocolo: su formato puede ser distinto. */
export function parseInfo(bytes: Bytes): ParseResult<InfoMsg> {
  const dv = asView(bytes);
  if (dv.byteLength >= 1 && dv.getUint8(0) !== PROTO_VERSION) {
    return fail(
      "version",
      `el firmware usa protocolo v${dv.getUint8(0)} y la app espera v${PROTO_VERSION}`,
    );
  }
  if (dv.byteLength !== Size.INFO) {
    return fail("size", `INFO de ${dv.byteLength} B; se esperaban ${Size.INFO} B`);
  }
  return ok({
    protoVer: dv.getUint8(0),
    role: dv.getUint8(1),
    fwVer: dv.getUint8(2),
    side: dv.getUint8(3),
    nFsr: dv.getUint8(4),
    rateHz: dv.getUint8(5),
    gpsRateHz: dv.getUint8(6),
    reserved: dv.getUint8(7),
    accLsbPerG: dv.getFloat32(8, LE),
    gyroLsbPerDps: dv.getFloat32(12, LE),
    present: dv.getUint16(16, LE),
  });
}

/**
 * Comando CONTROL, con las mismas reglas que ControlCB::onWrite del firmware
 * (lo usa el simulador para comportarse como una placa).
 */
export function parseControl(bytes: Bytes): ParseResult<ControlCommand> {
  const dv = asView(bytes);
  if (dv.byteLength < 1) return fail("size", "comando vacío");
  const op = dv.getUint8(0);
  switch (op) {
    case Opcode.START:
      return ok({ op: "start" });
    case Opcode.STOP:
      return ok({ op: "stop" });
    case Opcode.RESET_COUNTERS:
      return ok({ op: "resetCounters" });
    case Opcode.SET_TIME:
      if (dv.byteLength < 9) return fail("size", "SET_TIME necesita 8 bytes de tiempo");
      return ok({ op: "setTime", hostUs: dv.getBigInt64(1, LE) });
    case Opcode.SIM_FAIL:
      if (dv.byteLength < 3) return fail("size", "SIM_FAIL necesita 2 bytes de máscara");
      return ok({ op: "simFail", mask: dv.getUint16(1, LE) });
    default:
      return fail("opcode", `opcode 0x${op.toString(16)} desconocido`);
  }
}
