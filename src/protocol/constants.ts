// Protocolo v3 — idéntico a firmware/sensor_ble_stream.ino.
// Todo little-endian y empaquetado (sin padding). Si cambias algo aquí, cambia el firmware
// a la vez y sube PROTO_VERSION.

export const PROTO_VERSION = 3;

const UUID_BASE = "-5c3a-4b7e-9a21-3c6d2e8b1f40";
export const UUID = {
  service: "8f1d0001" + UUID_BASE,
  frame: "8f1d0002" + UUID_BASE, // Notify: trama de 100 Hz
  gps: "8f1d0003" + UUID_BASE, // Notify: trama GPS a 5 Hz
  control: "8f1d0004" + UUID_BASE, // Write: comandos
  status: "8f1d0005" + UUID_BASE, // Read + Notify: estado a 1 Hz
  info: "8f1d0006" + UUID_BASE, // Read: rol, versión, escalas, sensores instalados
} as const;

export const FrameType = { MAIN: 0x01, AUX: 0x02, GPS: 0x03 } as const;
export type FrameTypeCode = (typeof FrameType)[keyof typeof FrameType];

export const FrameFlag = { TIME_SYNCED: 0x01, SIMULATED: 0x02, SENSOR_ERR: 0x04 } as const;

export const Opcode = {
  START: 0x01,
  STOP: 0x02,
  RESET_COUNTERS: 0x03,
  SET_TIME: 0x10, // [0x10][int64 tiempo_host_us]
  SIM_FAIL: 0x20, // [0x20][uint16 máscara]
} as const;
export type OpcodeCode = (typeof Opcode)[keyof typeof Opcode];

export const Role = { MAIN: 1, AUX: 2 } as const;
export type RoleCode = (typeof Role)[keyof typeof Role];

export const Side = { LEFT: 1, RIGHT: 2 } as const;
export type SideCode = (typeof Side)[keyof typeof Side];

// Bits de la máscara "valid" (trama) y "present" (INFO), iguales en las dos botas:
//  bit 0 IMU, bits 1..8 FSR 1..8, bit 9 barómetro, bit 15 GPS (solo en INFO / OP_SIM_FAIL).
//  En la trama GPS, bit 0 = fix válido.
export const Bit = {
  IMU: 0x0001,
  BARO: 0x0200,
  GPS: 0x8000,
  GPS_FIX: 0x0001,
} as const;
/** Bit del FSR `i` (0..7). */
export const bitFsr = (i: number): number => (0x0002 << i) & 0xffff;

export const NUM_FSR = 8;

// Tamaños en bytes (static_assert del firmware)
export const Size = {
  HEADER: 12,
  IMU: 12,
  BARO: 6,
  GPS: 36,
  STATUS: 16,
  INFO: 18,
} as const;

/** Tamaño de una trama AUX (IMU + FSR) para `nFsr` FSR. Con 8 FSR: 40 B. */
export const auxFrameSize = (nFsr = NUM_FSR): number => Size.HEADER + Size.IMU + 2 * nFsr;
/** Tamaño de una trama MAIN (AUX + barómetro). Con 8 FSR: 46 B. */
export const mainFrameSize = (nFsr = NUM_FSR): number => auxFrameSize(nFsr) + Size.BARO;
