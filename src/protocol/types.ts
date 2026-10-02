// Estructuras del protocolo v3 en crudo: mismos campos y mismos enteros que el firmware,
// para que parsear y volver a serializar dé exactamente los mismos bytes.
// La conversión a unidades físicas está en physical.ts.

import type { FrameTypeCode, OpcodeCode } from "./constants";

export interface FrameHeader {
  type: FrameTypeCode;
  flags: number; // FrameFlag
  valid: number; // un bit por sensor (ver Bit / bitFsr)
  seq: number; // uint32: índice de muestra en la base de tiempo común (t / 10 ms)
  tUs: number; // uint32: 32 bits bajos del tiempo sincronizado (µs)
}

export interface ImuRaw {
  ax: number; ay: number; az: number; // int16, LSB (÷ accLsbPerG → g)
  gx: number; gy: number; gz: number; // int16, LSB (÷ gyroLsbPerDps → °/s)
}

export interface BaroRaw {
  pPaX100: number; // int32: presión en Pa × 100
  tCdeg: number; // int16: temperatura en centésimas de °C
}

/** Trama de 100 Hz. MAIN lleva `baro`; AUX no. */
export interface SensorFrame {
  header: FrameHeader;
  imu: ImuRaw;
  fsr: number[]; // uint16 ADC crudo 0..4095, FSR 1..n en orden
  baro?: BaroRaw;
}

export interface GpsFrame {
  header: FrameHeader; // valid bit 0 = fix válido
  latE7: number; // int32, grados × 1e7
  lonE7: number; // int32, grados × 1e7
  altMm: number; // int32, mm
  speedCms: number; // uint16, cm/s
  headingCdeg: number; // uint16, centésimas de grado
  fix: number; // 0 sin fix, 2 = 2D, 3 = 3D
  sats: number;
  hdopX100: number; // uint16
  itowMs: number; // uint32, tiempo GPS de la semana
}

export interface StatusMsg {
  streaming: number; // uint8 (0/1)
  syncState: number; // 0 = sin sincronizar, 1 = sincronizado
  batteryMv: number;
  framesSent: number;
  framesDropped: number; // notificaciones que no se pudieron encolar
  clockOffsetUs: number; // int32
}

export interface InfoMsg {
  protoVer: number;
  role: number; // Role
  fwVer: number;
  side: number; // Side
  nFsr: number;
  rateHz: number;
  gpsRateHz: number;
  reserved: number;
  accLsbPerG: number; // float32
  gyroLsbPerDps: number; // float32
  present: number; // sensores instalados (bits de "valid"; bit 15 = GPS)
}

export type ControlCommand =
  | { op: "start" }
  | { op: "stop" }
  | { op: "resetCounters" }
  /** Fija el reloj de la placa: tiempo sincronizado = hostUs en este instante. */
  | { op: "setTime"; hostUs: bigint }
  /** Bits a 1 simulan un sensor que no responde (solo con sensores simulados). */
  | { op: "simFail"; mask: number };

export type ParseErrorCode = "size" | "type" | "version" | "opcode";

export interface ParseError {
  code: ParseErrorCode;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };

export type Bytes = Uint8Array | DataView | ArrayBuffer;

export type { FrameTypeCode, OpcodeCode };
