// Estado de cada sensor: "ok" (dato válido), "fail" (instalado pero sin señal en esta
// muestra) o "none" (no instalado según INFO.present).

import { Bit, Role, bitFsr } from "./constants";
import type { InfoMsg } from "./types";

export type SensorState = "ok" | "fail" | "none";

export type SensorId =
  | "imu"
  | "fsr1" | "fsr2" | "fsr3" | "fsr4" | "fsr5" | "fsr6" | "fsr7" | "fsr8"
  | "baro"
  | "gps";

export interface SensorDef {
  id: SensorId;
  label: string;
  /** Bit en INFO.present. */
  presentBit: number;
  /** Bit de validez y en qué trama está: FRAME (`valid`) o GPS (bit 0 = fix). */
  validBit: number;
  validIn: "frame" | "gps";
}

export const SENSOR_STATE_LABEL: Record<SensorState, string> = {
  ok: "OK",
  fail: "sin señal",
  none: "no instalado",
};

/** Zonas del pie de cada FSR (docs/spec.md, tabla «Dónde van los 8 FSR»). */
export const FSR_ZONES = [
  "Talón interior",
  "Talón exterior",
  "Mediopié exterior",
  "Met. 5",
  "Met. 2–3",
  "Met. 1",
  "Dedo gordo",
  "Dedos 2–5",
] as const;

/** Sensores que puede tener una bota con este INFO (instalados o no). */
export function sensorDefs(info: Pick<InfoMsg, "role" | "nFsr">): SensorDef[] {
  const defs: SensorDef[] = [
    { id: "imu", label: "IMU", presentBit: Bit.IMU, validBit: Bit.IMU, validIn: "frame" },
  ];
  for (let i = 0; i < info.nFsr; i++) {
    const bit = bitFsr(i);
    defs.push({
      id: `fsr${i + 1}` as SensorId,
      label: `FSR ${i + 1}`,
      presentBit: bit,
      validBit: bit,
      validIn: "frame",
    });
  }
  if (info.role === Role.MAIN) {
    defs.push({ id: "baro", label: "Barómetro", presentBit: Bit.BARO, validBit: Bit.BARO, validIn: "frame" });
    defs.push({ id: "gps", label: "GPS", presentBit: Bit.GPS, validBit: Bit.GPS_FIX, validIn: "gps" });
  }
  return defs;
}

/** Estado de un sensor a partir de la máscara `present` (INFO) y la de validez de su trama. */
export function sensorState(present: number, validMask: number, def: Pick<SensorDef, "presentBit" | "validBit">): SensorState {
  if (!(present & def.presentBit)) return "none";
  return validMask & def.validBit ? "ok" : "fail";
}

/** ¿Es válido el dato de este bit en esta máscara? Un dato inválido nunca debe leerse como 0. */
export const isValid = (validMask: number, bit: number): boolean => (validMask & bit) !== 0;
