// Conversión de los enteros del protocolo a unidades físicas.
// Las escalas de la IMU vienen de INFO (no se suponen), así un cambio de rango de la IMU
// en el firmware no obliga a tocar la app.

import type { BaroRaw, GpsFrame, ImuRaw, InfoMsg } from "./types";

export interface ImuPhysical {
  acc: [number, number, number]; // g, ejes de la IMU
  gyro: [number, number, number]; // °/s, ejes de la IMU
}

export function imuToPhysical(m: ImuRaw, info: Pick<InfoMsg, "accLsbPerG" | "gyroLsbPerDps">): ImuPhysical {
  const a = info.accLsbPerG;
  const g = info.gyroLsbPerDps;
  return {
    acc: [m.ax / a, m.ay / a, m.az / a],
    gyro: [m.gx / g, m.gy / g, m.gz / g],
  };
}

export const baroPressurePa = (b: BaroRaw): number => b.pPaX100 / 100;
export const baroTemperatureC = (b: BaroRaw): number => b.tCdeg / 100;

export interface GpsPhysical {
  lat: number; // grados
  lon: number; // grados
  altM: number;
  speedMs: number;
  headingDeg: number;
  fix: number;
  sats: number;
  hdop: number;
}

export function gpsToPhysical(g: GpsFrame): GpsPhysical {
  return {
    lat: g.latE7 / 1e7,
    lon: g.lonE7 / 1e7,
    altM: g.altMm / 1000,
    speedMs: g.speedCms / 100,
    headingDeg: g.headingCdeg / 100,
    fix: g.fix,
    sats: g.sats,
    hdop: g.hdopX100 / 100,
  };
}
