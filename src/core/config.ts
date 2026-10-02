// TODOS los umbrales y rangos del análisis.
//
// Cada valor lleva un comentario con su origen:
//   [spec: <apartado> / <estudio>]  sale de docs/spec.md o del estudio que cita
//   [provisional]                   valor razonable sin respaldo; ajustar con datos reales
//   [protocolo]                     lo fija el firmware / protocolo v3
//
// Este archivo se irá completando fase a fase. Nada de umbrales sueltos en el código.

export const CONFIG = {
  sampling: {
    /** [protocolo] SAMPLE_PERIOD_US = 10 000 µs. */
    rateHz: 100,
    /** [protocolo] GPS_DIVIDER = 20 → 5 Hz. */
    gpsRateHz: 5,
  },

  sync: {
    /**
     * [provisional] Cada cuánto se reenvía OP_SET_TIME a las botas mientras no haya ESP-NOW.
     * Los cristales derivan hasta ~40 ppm entre placas (≈ 1,2 ms en 30 s, < 1 muestra);
     * reenviar cada 30 s mantiene la deriva acumulada muy por debajo de una muestra.
     */
    timeResyncIntervalS: 30,
  },
} as const;

export type Config = typeof CONFIG;
