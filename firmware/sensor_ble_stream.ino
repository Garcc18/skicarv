/*
  XIAO ESP32-S3 Plus — Streaming BLE de sensores en tiempo real
  ---------------------------------------------------------------------------
  Librería : NimBLE-Arduino 2.x (h2zero)
  Placa    : core esp32 de Espressif 3.x, placa "XIAO_ESP32S3" / "XIAO_ESP32S3_Plus"
             Tools > USB CDC On Boot: Enabled (para ver el Serial)

  Un mismo firmware para las dos piezas: cambia DEVICE_ROLE.
    Cada bota lleva IMU + 8 FSR (100 Hz).
    ROLE_MAIN : además barómetro (100 Hz) y GPS (5 Hz)
    ROLE_AUX  : solo IMU + 8 FSR
    BOOT_SIDE : qué pie es cada bota (izquierda/derecha), lo publica INFO

  Cada grupo de sensores puede ser SIMULADO, REAL o NO INSTALADO (ver "Origen de los
  sensores"). Cada trama lleva una máscara "valid" con un bit por sensor, así la app
  distingue "dato válido", "sin señal" y "no instalado".

  GATT (servicio propio, UUIDs de 128 bits):
    8f1d0001-...  Sensor Stream Service
      8f1d0002  FRAME   Notify       Trama de 100 Hz (todo lo muestreado en ese tick)
      8f1d0003  GPS     Notify       Trama de GPS a 5 Hz
      8f1d0004  CONTROL Write        Comandos (start/stop/reset/set time/simular fallos)
      8f1d0005  STATUS  Read+Notify  Estado, contadores, sincronización (1 Hz)
      8f1d0006  INFO    Read         Rol, versión de protocolo, escalas, sensores instalados

  Protocolo v3: las dos botas comparten formato (IMU + 8 FSR); la principal añade el barómetro
  al final de la trama. Sin IMUs externas.
*/

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_timer.h>
#include <math.h>

// ======================= Configuración =======================
#define ROLE_MAIN 1
#define ROLE_AUX  2
#define DEVICE_ROLE ROLE_MAIN      // <-- cambia a ROLE_AUX para la otra bota

#define SIDE_LEFT  1
#define SIDE_RIGHT 2
#define BOOT_SIDE  SIDE_RIGHT      // <-- pie de esta bota

// ---- Origen de los sensores ----
// SRC_SIM  : valores simulados (para probar la app sin hardware)
// SRC_REAL : lee el sensor real (rellena las funciones read... más abajo)
// SRC_NONE : no instalado; la app lo muestra como "no instalado"
#define SRC_NONE 0
#define SRC_SIM  1
#define SRC_REAL 2

static const uint8_t SRC_IMU     = SRC_SIM;   // IMU de la bota
static const uint8_t SRC_FSR     = SRC_SIM;   // los 8 FSR de la plantilla
static const uint8_t SRC_BARO    = SRC_SIM;   // solo MAIN
static const uint8_t SRC_GPS     = SRC_SIM;   // solo MAIN

#define AUTO_START        1        // 1 = empieza a emitir al suscribirse (cómodo con nRF Connect)
#define SAMPLE_PERIOD_US  10000    // 100 Hz
#define GPS_DIVIDER       20       // 100 Hz / 20 = 5 Hz
#define NUM_FSR           8
#define PROTO_VERSION     3
#define FW_VERSION        3

// Factores de escala (los publica INFO para que la app convierta a unidades físicas)
static const float ACC_LSB_PER_G    = 16384.0f;  // ±2 g
static const float GYRO_LSB_PER_DPS = 16.4f;     // ±2000 dps

// UUIDs
static const char* SVC_UUID     = "8f1d0001-5c3a-4b7e-9a21-3c6d2e8b1f40";
static const char* FRAME_UUID   = "8f1d0002-5c3a-4b7e-9a21-3c6d2e8b1f40";
static const char* GPS_UUID     = "8f1d0003-5c3a-4b7e-9a21-3c6d2e8b1f40";
static const char* CONTROL_UUID = "8f1d0004-5c3a-4b7e-9a21-3c6d2e8b1f40";
static const char* STATUS_UUID  = "8f1d0005-5c3a-4b7e-9a21-3c6d2e8b1f40";
static const char* INFO_UUID    = "8f1d0006-5c3a-4b7e-9a21-3c6d2e8b1f40";

// ======================= Formato de tramas =======================
// Todo little-endian y empaquetado (sin padding). Enteros escalados, nunca floats.
enum FrameType : uint8_t { FT_MAIN = 0x01, FT_AUX = 0x02, FT_GPS = 0x03 };
enum FrameFlags : uint8_t { FLAG_TIME_SYNCED = 0x01, FLAG_SIMULATED = 0x02, FLAG_SENSOR_ERR = 0x04 };
enum Opcode : uint8_t {
  OP_START = 0x01, OP_STOP = 0x02, OP_RESET_COUNTERS = 0x03,
  OP_SET_TIME = 0x10,      // [0x10][int64 tiempo_host_us]
  OP_SIM_FAIL = 0x20,      // [0x20][uint16 máscara]: los bits a 1 simulan un sensor que no responde
};

// Bits de la máscara "valid" (y de "present" en INFO), iguales en las dos botas:
//  bit 0 IMU, bits 1..8 FSR 1..8, bit 9 barómetro, bit 15 GPS (solo en INFO / OP_SIM_FAIL)
//  En la trama GPS: bit 0 = fix válido
#define BIT_IMU        0x0001
#define BIT_FSR(i)     (uint16_t)(0x0002u << (i))
#define BIT_BARO       0x0200
#define BIT_GPS        0x8000

#pragma pack(push, 1)
struct FrameHeader {        // 12 bytes
  uint8_t  type;            // FrameType
  uint8_t  flags;           // FrameFlags
  uint16_t valid;           // un bit por sensor: 1 = dato válido en esta muestra
  uint32_t seq;             // índice de muestra en la base de tiempo común (t / 10 ms)
  uint32_t t_us;            // 32 bits bajos del tiempo sincronizado (µs)
};
struct Imu6 {               // 12 bytes
  int16_t ax, ay, az;       // LSB -> g      (ACC_LSB_PER_G)
  int16_t gx, gy, gz;       // LSB -> °/s    (GYRO_LSB_PER_DPS)
};
struct Baro {               // 6 bytes
  int32_t p_pa_x100;        // presión en Pa * 100
  int16_t t_cdeg;           // temperatura en centésimas de °C
};
struct AuxFrame {           // 40 bytes: lo que llevan las dos botas
  FrameHeader h;
  Imu6 imu;
  uint16_t fsr[NUM_FSR];    // ADC crudo 0..4095 (orden: ver tabla de zonas del pie)
};
struct MainFrame {          // 46 bytes: lo mismo + barómetro al final
  FrameHeader h;
  Imu6 imu;
  uint16_t fsr[NUM_FSR];
  Baro baro;
};
struct GpsFrame {           // 36 bytes
  FrameHeader h;
  int32_t  lat_e7;          // grados * 1e7
  int32_t  lon_e7;          // grados * 1e7
  int32_t  alt_mm;          // altura en mm
  uint16_t speed_cms;       // cm/s
  uint16_t heading_cdeg;    // centésimas de grado
  uint8_t  fix;             // 0 = sin fix, 2 = 2D, 3 = 3D
  uint8_t  sats;
  uint16_t hdop_x100;
  uint32_t itow_ms;         // tiempo GPS de la semana
};
struct StatusMsg {          // 16 bytes
  uint8_t  streaming;
  uint8_t  sync_state;      // 0 = sin sincronizar, 1 = sincronizado
  uint16_t battery_mv;
  uint32_t frames_sent;
  uint32_t frames_dropped;  // notificaciones que no se pudieron encolar
  int32_t  clock_offset_us;
};
struct InfoMsg {            // 18 bytes
  uint8_t  proto_ver, role, fw_ver, side, n_fsr, rate_hz, gps_rate_hz, reserved;
  float    acc_lsb_per_g;
  float    gyro_lsb_per_dps;
  uint16_t present;         // sensores instalados (mismos bits que "valid"; bit 15 = GPS)
};
#pragma pack(pop)

static_assert(sizeof(MainFrame) == 46,  "MainFrame size");
static_assert(sizeof(AuxFrame)  == 40,  "AuxFrame size");
static_assert(sizeof(GpsFrame)  == 36,  "GpsFrame size");
static_assert(sizeof(InfoMsg)   == 18,  "InfoMsg size");

// ======================= Estado global =======================
static NimBLECharacteristic* g_frameChr  = nullptr;
static NimBLECharacteristic* g_gpsChr    = nullptr;
static NimBLECharacteristic* g_statusChr = nullptr;
static TaskHandle_t g_sampleTask = nullptr;

static volatile bool g_connected = false;
static volatile bool g_streaming = false;
static volatile uint32_t g_framesSent = 0, g_framesDropped = 0;
static volatile uint16_t g_simFail = 0;   // sensores simulados que "fallan" (OP_SIM_FAIL)

static volatile int64_t g_clockOffsetUs = 0;
static volatile bool    g_timeSynced = (DEVICE_ROLE == ROLE_MAIN);

static inline int64_t syncedTimeUs() { return esp_timer_get_time() + g_clockOffsetUs; }

// Máscara de sensores instalados según la configuración
static uint16_t presentMask() {
  uint16_t m = 0;
  if (SRC_IMU != SRC_NONE) m |= BIT_IMU;
  if (SRC_FSR != SRC_NONE) for (int i = 0; i < NUM_FSR; i++) m |= BIT_FSR(i);
#if DEVICE_ROLE == ROLE_MAIN
  if (SRC_BARO != SRC_NONE) m |= BIT_BARO;
  if (SRC_GPS != SRC_NONE) m |= BIT_GPS;
#endif
  return m;
}

// ======================= Lectura de sensores REALES =======================
// Rellena el dato y devuelve true si es válido. Nunca deben bloquear: si el sensor no
// responde, devuelve false enseguida (timeout corto en I2C/SPI) y la trama se envía igual.
static bool readImu(Imu6& o)            { return false; }  // TODO: IMU de la bota
static bool readFsr(int i, uint16_t& v) { return false; }  // TODO: analogRead del FSR i (0..7)
static bool readBaro(Baro& o)           { return false; }  // TODO: barómetro (solo MAIN)
static bool readGps(GpsFrame& g)        { return false; }  // TODO: GPS por UART, sin bloquear (solo MAIN)

// ======================= Simulación =======================
static void simImu(Imu6& o, float t, float phase) {
  const float w = 2.0f * PI;
  o.ax = (int16_t)(ACC_LSB_PER_G * 0.5f * sinf(w * 1.0f * t + phase));
  o.ay = (int16_t)(ACC_LSB_PER_G * 0.3f * cosf(w * 0.7f * t + phase));
  o.az = (int16_t)(ACC_LSB_PER_G * (1.0f + 0.1f * sinf(w * 2.0f * t + phase)));
  o.gx = (int16_t)(GYRO_LSB_PER_DPS * 120.0f * sinf(w * 0.5f * t + phase));
  o.gy = (int16_t)(GYRO_LSB_PER_DPS * 60.0f  * cosf(w * 0.5f * t + phase));
  o.gz = (int16_t)(GYRO_LSB_PER_DPS * 30.0f  * sinf(w * 0.2f * t + phase));
}

static void simGps(GpsFrame& g, float t) {
  const float r = 0.0002f;  // círculo de ~20 m
  g.lat_e7       = (int32_t)((40.0f + r * sinf(0.05f * t)) * 1e7f);
  g.lon_e7       = (int32_t)((-4.0f + r * cosf(0.05f * t)) * 1e7f);
  g.alt_mm       = 650000;
  g.speed_cms    = 150;
  g.heading_cdeg = (uint16_t)(fmodf(t * 2.86f, 360.0f) * 100.0f);
  g.fix = 3; g.sats = 11; g.hdop_x100 = 90;
  g.itow_ms = (uint32_t)(t * 1000.0f);
}

// Esquí simulado: giros de 1,2 s alternando izquierda/derecha. En cada giro esta bota es
// exterior (mucha carga) o interior (poca), y la carga pasa de la punta al talón (FSR 4-8 ->
// FSR 1-2), como describen los estudios con plantillas de presión.
static uint16_t simFsr(int i, float t) {
  const float T = 1.2f;                                         // duración de un giro
  const int   turn = (int)(t / T);
  const float u = fmodf(t, T) / T;                              // 0..1 dentro del giro
  const bool  outside = ((turn & 1) == 0) == (BOOT_SIDE == SIDE_RIGHT);
  const float load = (outside ? 0.85f : 0.25f) * sinf(PI * u);  // carga total del pie
  static const float fore[NUM_FSR] = { 0.0f, 0.0f, 0.4f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f };
  const float w = fore[i] * (1.0f - u) + (1.0f - fore[i]) * u;  // delante al inicio, talón al final
  return (uint16_t)(120 + 3700.0f * load * w);                  // 120 = lectura base sin presión
}

// ---- Adquisición: decide entre simulado / real / no instalado ----
static inline bool simOk(uint16_t bit) { return !(g_simFail & bit); }

// Rellena la parte común de las dos botas (IMU + 8 FSR) y devuelve su máscara de validez
static uint16_t acqCommon(Imu6& imu, uint16_t* fsr, float t) {
  uint16_t valid = 0;
  const float phase = (BOOT_SIDE == SIDE_LEFT) ? PI : 0.0f;    // botas en contrafase
  if (SRC_IMU == SRC_SIM && simOk(BIT_IMU)) { simImu(imu, t, phase); valid |= BIT_IMU; }
  else if (SRC_IMU == SRC_REAL && readImu(imu)) valid |= BIT_IMU;
  for (int i = 0; i < NUM_FSR; i++) {
    bool ok = false;
    if (SRC_FSR == SRC_SIM && simOk(BIT_FSR(i))) { fsr[i] = simFsr(i, t); ok = true; }
    else if (SRC_FSR == SRC_REAL)                { ok = readFsr(i, fsr[i]); }
    if (ok) valid |= BIT_FSR(i);
  }
  return valid;
}

// ======================= Callbacks BLE =======================
class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    g_connected = true;
    // Intervalo fijo de 15 ms, latencia 0, timeout 4 s (compatible con iPhone y Android)
    s->updateConnParams(info.getConnHandle(), 12, 12, 0, 400);
    Serial.printf("Conectado: %s\n", info.getAddress().toString().c_str());
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    g_connected = false;
    g_streaming = false;
    Serial.printf("Desconectado (motivo %d)\n", reason);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo& info) override {
    Serial.printf("MTU negociado: %u\n", mtu);
  }
};

class FrameCB : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic* c, NimBLEConnInfo& info, uint16_t subValue) override {
#if AUTO_START
    g_streaming = (subValue & 0x0001);
#endif
    Serial.printf("Suscripción FRAME: %u\n", subValue);
  }
};

class ControlCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    NimBLEAttValue v = c->getValue();
    const uint8_t* d = v.data();
    size_t n = v.length();
    if (n < 1) return;
    switch (d[0]) {
      case OP_START:          g_streaming = true;  break;
      case OP_STOP:           g_streaming = false; break;
      case OP_RESET_COUNTERS: g_framesSent = 0; g_framesDropped = 0; break;
      case OP_SET_TIME:
        if (n >= 9) {
          int64_t hostUs;
          memcpy(&hostUs, d + 1, 8);
          g_clockOffsetUs = hostUs - esp_timer_get_time();
          g_timeSynced = true;
        }
        break;
      case OP_SIM_FAIL:
        if (n >= 3) g_simFail = (uint16_t)(d[1] | (d[2] << 8));
        break;
    }
    Serial.printf("CONTROL op=0x%02X streaming=%d simFail=0x%04X\n", d[0], (int)g_streaming, g_simFail);
  }
};

// ======================= Bucle de muestreo =======================
static void onSampleTimer(void*) {
  xTaskNotifyGive(g_sampleTask);
}

static void sendNotify(NimBLECharacteristic* c, const void* data, size_t len) {
  if (c->notify((const uint8_t*)data, len)) g_framesSent++;
  else g_framesDropped++;
}

static void sampleTask(void*) {
  const uint16_t present = presentMask();
  uint32_t tick = 0;
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    const int64_t tUs = syncedTimeUs();
    const uint32_t seq = (uint32_t)((tUs + SAMPLE_PERIOD_US / 2) / SAMPLE_PERIOD_US);
    const float t = tUs * 1e-6f;
    uint8_t flags = g_timeSynced ? FLAG_TIME_SYNCED : 0;

    if (!(g_connected && g_streaming)) { tick++; continue; }

    if (SRC_IMU == SRC_SIM || SRC_FSR == SRC_SIM) flags |= FLAG_SIMULATED;

#if DEVICE_ROLE == ROLE_MAIN
    MainFrame f;
    memset(&f, 0, sizeof(f));
    uint16_t valid = acqCommon(f.imu, f.fsr, t);

    if (SRC_BARO == SRC_SIM && simOk(BIT_BARO)) {
      f.baro.p_pa_x100 = (int32_t)((101325.0f + 50.0f * sinf(2.0f * PI * 0.2f * t)) * 100.0f);
      f.baro.t_cdeg = 2350;
      valid |= BIT_BARO;
      flags |= FLAG_SIMULATED;
    } else if (SRC_BARO == SRC_REAL && readBaro(f.baro)) {
      valid |= BIT_BARO;
    }

    if (valid != (present & ~BIT_GPS)) flags |= FLAG_SENSOR_ERR;   // falta algún sensor instalado
    f.h = { FT_MAIN, flags, valid, seq, (uint32_t)tUs };
    sendNotify(g_frameChr, &f, sizeof(f));

    if (SRC_GPS != SRC_NONE && tick % GPS_DIVIDER == 0) {
      GpsFrame g;
      memset(&g, 0, sizeof(g));
      bool ok = false;
      if (SRC_GPS == SRC_SIM && simOk(BIT_GPS)) { simGps(g, t); ok = true; }
      else if (SRC_GPS == SRC_REAL)             { ok = readGps(g); }
      uint8_t gf = g_timeSynced ? FLAG_TIME_SYNCED : 0;
      if (SRC_GPS == SRC_SIM) gf |= FLAG_SIMULATED;
      if (!ok) gf |= FLAG_SENSOR_ERR;
      g.h = { FT_GPS, gf, (uint16_t)(ok ? 1 : 0), seq, (uint32_t)tUs };
      sendNotify(g_gpsChr, &g, sizeof(g));
    }
#else
    AuxFrame f;
    memset(&f, 0, sizeof(f));
    uint16_t valid = acqCommon(f.imu, f.fsr, t);
    if (valid != present) flags |= FLAG_SENSOR_ERR;
    f.h = { FT_AUX, flags, valid, seq, (uint32_t)tUs };
    sendNotify(g_frameChr, &f, sizeof(f));
#endif
    tick++;
  }
}

// ======================= Setup =======================
static void setupBle() {
  const char* name = (BOOT_SIDE == SIDE_LEFT) ? "SKI-L" : "SKI-R";
  NimBLEDevice::init(name);
  NimBLEDevice::setPower(9);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setDefaultPhy(BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCB());

  NimBLEService* svc = server->createService(SVC_UUID);

  g_frameChr = svc->createCharacteristic(FRAME_UUID, NIMBLE_PROPERTY::NOTIFY);
  g_frameChr->setCallbacks(new FrameCB());

  g_gpsChr = svc->createCharacteristic(GPS_UUID, NIMBLE_PROPERTY::NOTIFY);

  NimBLECharacteristic* ctrl = svc->createCharacteristic(
      CONTROL_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  ctrl->setCallbacks(new ControlCB());

  g_statusChr = svc->createCharacteristic(STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  NimBLECharacteristic* info = svc->createCharacteristic(INFO_UUID, NIMBLE_PROPERTY::READ);
  InfoMsg im = { PROTO_VERSION, (uint8_t)DEVICE_ROLE, FW_VERSION, (uint8_t)BOOT_SIDE,
                 (uint8_t)NUM_FSR,
                 100, (uint8_t)(DEVICE_ROLE == ROLE_MAIN ? 5 : 0), 0,
                 ACC_LSB_PER_G, GYRO_LSB_PER_DPS, presentMask() };
  info->setValue((uint8_t*)&im, sizeof(im));

  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  NimBLEAdvertisementData advData, scanData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  advData.addServiceUUID(NimBLEUUID(SVC_UUID));
  scanData.setName(name);
  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanData);
  adv->start();
  Serial.printf("Anunciando como %s (sensores instalados 0x%04X)\n", name, presentMask());
}

void setup() {
  Serial.begin(115200);
  delay(500);
  setupBle();

  xTaskCreatePinnedToCore(sampleTask, "sample", 4096, nullptr, 5, &g_sampleTask, 1);

  const esp_timer_create_args_t args = { .callback = &onSampleTimer, .arg = nullptr,
                                         .dispatch_method = ESP_TIMER_TASK, .name = "sample" };
  esp_timer_handle_t timer;
  esp_timer_create(&args, &timer);
  esp_timer_start_periodic(timer, SAMPLE_PERIOD_US);
}

void loop() {
  static uint32_t last = 0;
  if (millis() - last >= 1000) {
    last = millis();
    StatusMsg st = { (uint8_t)g_streaming, (uint8_t)g_timeSynced, 4000,
                     g_framesSent, g_framesDropped, (int32_t)g_clockOffsetUs };
    g_statusChr->setValue((uint8_t*)&st, sizeof(st));
    if (g_connected) g_statusChr->notify();
    Serial.printf("sent=%lu dropped=%lu streaming=%d\n",
                  (unsigned long)g_framesSent, (unsigned long)g_framesDropped, (int)g_streaming);
  }
  delay(10);
}
