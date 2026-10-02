// Prueba mínima de BLE + voz con la pantalla bloqueada (Bluefy en iPhone, Chrome/Edge en PC).
// Se conecta a una o dos botas, cuenta tramas y dice un número cada 10 s. Todo lo que pasa
// se guarda en localStorage para poder leer el informe al desbloquear.

import {
  Side,
  UUID,
  encodeControl,
  parseInfo,
  parseSensorFrame,
  type ControlCommand,
  type InfoMsg,
} from "../protocol";
import {
  STALL_MS,
  WINDOW_MS,
  formatReport,
  summarize,
  type DevWindow,
  type TestLog,
} from "./report";

const STORE_KEY = "skicoach-bgtest-log";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msg = (t: string) => ($("msg").textContent = t);

// ---------- Estado ----------
const listening = new WeakSet<BluetoothRemoteGATTCharacteristic>();

class Dev {
  info!: InfoMsg;
  ctrl!: BluetoothRemoteGATTCharacteristic;
  connected = false;
  lastSeq: number | null = null;
  lastArrival: number | null = null;
  // contadores de la ventana de 10 s
  wFrames = 0; wLost = 0; wMaxGap = 0; wMinLag: number | null = null;
  // contadores del último segundo (pantalla)
  sFrames = 0; fps = 0;
  totalFrames = 0; totalLost = 0;
  el!: HTMLElement;

  constructor(public device: BluetoothDevice) {}
  get name() { return this.device.name ?? "bota"; }

  async connect() {
    const server = await this.device.gatt!.connect();
    const svc = await server.getPrimaryService(UUID.service);
    const info = parseInfo(await (await svc.getCharacteristic(UUID.info)).readValue());
    if (!info.ok) {
      this.device.gatt!.disconnect();
      throw new Error(info.error.message);
    }
    this.info = info.value;
    this.ctrl = await svc.getCharacteristic(UUID.control);
    const frame = await svc.getCharacteristic(UUID.frame);
    // Al reconectar el navegador puede devolver el mismo objeto: no duplicar el listener
    if (!listening.has(frame)) {
      listening.add(frame);
      frame.addEventListener("characteristicvaluechanged", (e) =>
        this.onFrame((e.target as BluetoothRemoteGATTCharacteristic).value!),
      );
    }
    await frame.startNotifications();
    await this.cmd({ op: "simFail", mask: 0 });
    await this.cmd({ op: "start" });
    this.connected = true;
    this.lastSeq = null;
  }

  cmd(c: ControlCommand) {
    return this.ctrl.writeValueWithResponse(encodeControl(c));
  }

  onFrame(dv: DataView) {
    const now = performance.now();
    const r = parseSensorFrame(dv, this.info.nFsr);
    if (!r.ok) { logEvent(`${this.name}: trama inválida (${r.error.message})`); return; }
    const seq = r.value.header.seq;
    if (this.lastSeq !== null) {
      const d = seq - this.lastSeq;
      if (d > 1 && d < 100_000) { this.wLost += d - 1; this.totalLost += d - 1; }
      else if (d <= 0 || d >= 100_000) logEvent(`${this.name}: salto de seq ${this.lastSeq} → ${seq}`);
    }
    if (this.lastArrival !== null) this.wMaxGap = Math.max(this.wMaxGap, now - this.lastArrival);
    const lag = now - seq * 10;
    this.wMinLag = this.wMinLag === null ? lag : Math.min(this.wMinLag, lag);
    this.lastSeq = seq;
    this.lastArrival = now;
    this.wFrames++; this.sFrames++; this.totalFrames++;
  }

  takeWindow(): DevWindow {
    const w: DevWindow = {
      name: this.name, frames: this.wFrames, lost: this.wLost, maxGapMs: this.wMaxGap,
      minLagMs: this.wMinLag === null ? null : this.wMinLag - t0, connected: this.connected,
    };
    this.wFrames = 0; this.wLost = 0; this.wMaxGap = 0; this.wMinLag = null;
    return w;
  }
}

const devs: Dev[] = [];
let log: TestLog | null = loadLog();
let running = false;
let t0 = 0; // performance.now() al empezar la prueba
let winStart = 0;
let lastTick = 0;
let wakeLock: WakeLockSentinel | null = null;
let silentAudio: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;

const rel = () => performance.now() - t0;

function logEvent(text: string) {
  if (!log || !running) return;
  log.events.push({ tMs: rel(), text });
  saveLog();
}

function loadLog(): TestLog | null {
  try { const s = localStorage.getItem(STORE_KEY); return s ? (JSON.parse(s) as TestLog) : null; }
  catch { return null; }
}
function saveLog() {
  try { if (log) localStorage.setItem(STORE_KEY, JSON.stringify(log)); } catch { /* lleno o bloqueado */ }
}

// ---------- Audio ----------
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.2;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
  } catch { /* sin WebAudio */ }
}

function say(text: string) {
  if (log) log.speech.requested++;
  const synth = window.speechSynthesis;
  if ($<HTMLInputElement>("optBeep").checked || !synth) {
    beep();
    if (log) log.speech.started++; // el pitido cuenta como mensaje entregado
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-ES";
  u.rate = 1.1;
  u.onstart = () => { if (log) { log.speech.started++; saveLog(); } };
  u.onerror = (e) => { if (log) { log.speech.errors++; } logEvent(`voz: error ${e.error}`); };
  synth.speak(u);
}

// WAV de 1 s casi silencioso (ruido de 1 LSB) en bucle: mantiene viva la sesión de audio.
function silentWavUrl(): string {
  const rate = 8000, n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

async function requestWakeLock() {
  if (!$<HTMLInputElement>("optWake").checked || !running) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    logEvent("wake lock concedido");
    wakeLock.addEventListener("release", () => logEvent("wake lock liberado"));
  } catch (e) {
    logEvent(`wake lock no disponible: ${(e as Error).message}`);
  }
}

// ---------- Prueba ----------
async function startTest() {
  t0 = performance.now();
  winStart = t0;
  lastTick = t0;
  running = true;
  log = {
    startedIso: new Date().toISOString(),
    userAgent: navigator.userAgent,
    options: {
      wakeLock: $<HTMLInputElement>("optWake").checked,
      silentAudio: $<HTMLInputElement>("optAudio").checked,
      beepOnly: $<HTMLInputElement>("optBeep").checked,
    },
    windows: [], events: [], stalls: [],
    speech: { requested: 0, started: 0, errors: 0 },
  };
  for (const d of devs) d.takeWindow();
  // La primera locución y el audio deben salir de un gesto del usuario (requisito de iOS).
  say("Prueba iniciada");
  if (log.options.silentAudio) {
    silentAudio = new Audio(silentWavUrl());
    silentAudio.loop = true;
    try { await silentAudio.play(); logEvent("audio silencioso en marcha"); }
    catch (e) { logEvent(`audio silencioso falló: ${(e as Error).message}`); }
  }
  await requestWakeLock();
  logEvent(`prueba iniciada con ${devs.map((d) => d.name).join(", ")}`);
  $<HTMLButtonElement>("start").disabled = true;
  $<HTMLButtonElement>("stop").disabled = false;
  saveLog();
}

function stopTest() {
  if (!running) return;
  closeWindow(performance.now());
  logEvent("prueba parada");
  running = false;
  silentAudio?.pause();
  silentAudio = null;
  void wakeLock?.release();
  wakeLock = null;
  $<HTMLButtonElement>("start").disabled = devs.length === 0;
  $<HTMLButtonElement>("stop").disabled = true;
  saveLog();
  renderReport();
}

function closeWindow(now: number) {
  if (!log) return;
  const durMs = now - winStart;
  if (durMs < 1000) return;
  log.windows.push({ tMs: now - t0, durMs, visible: document.visibilityState === "visible", devs: devs.map((d) => d.takeWindow()) });
  winStart = now;
  saveLog();
}

function tick() {
  const now = performance.now();
  for (const d of devs) { d.fps = d.sFrames; d.sFrames = 0; }
  if (running && log) {
    if (now - lastTick > STALL_MS) log.stalls.push({ tMs: now - t0, durMs: now - lastTick });
    lastTick = now;
    if (now - winStart >= WINDOW_MS) {
      const durS = (now - winStart) / 1000;
      closeWindow(now);
      const last = log.windows[log.windows.length - 1]!;
      // Dice las tramas por segundo de cada bota en esta ventana
      say(last.devs.map((d) => String(Math.round(d.frames / durS))).join(", ") || "sin botas");
    }
  }
  render();
}

// ---------- UI ----------
function render() {
  for (const d of devs) {
    d.el.innerHTML = `
      <div><b>${d.name}</b> · ${d.info.side === Side.LEFT ? "izquierda" : "derecha"} ·
        <span class="${d.connected ? "on" : "off"}">${d.connected ? "conectada" : "desconectada"}</span></div>
      <b class="big">${d.fps}</b> tramas/s
      <div class="kv">
        <span>total <b>${d.totalFrames}</b></span>
        <span>perdidas <b>${d.totalLost}</b></span>
        <span>seq <b>${d.lastSeq ?? "–"}</b></span>
      </div>`;
  }
  if (running) msg(`Prueba en marcha: ${Math.floor(rel() / 1000)} s. Bloquea la pantalla cuando quieras.`);
}

function renderReport() {
  $("report").textContent = log ? formatReport(log, summarize(log)) : "Sin datos todavía.";
}

async function connectNew() {
  try {
    msg("Buscando…");
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.service] }] });
    if (devs.some((d) => d.device.id === device.id)) { msg("Esa bota ya está conectada"); return; }
    const d = new Dev(device);
    d.el = document.createElement("div");
    d.el.className = "dev";
    $("devices").appendChild(d.el);
    await d.connect();
    devs.push(d);
    device.addEventListener("gattserverdisconnected", () => void onDisconnect(d));
    msg(`${d.name} conectada`);
    $<HTMLButtonElement>("start").disabled = running;
    render();
  } catch (e) {
    msg("Error: " + (e as Error).message);
  }
}

async function onDisconnect(d: Dev) {
  d.connected = false;
  logEvent(`${d.name}: desconectado`);
  // Reintenta sin selector (el permiso ya está concedido)
  for (let i = 1; i <= 5 && !d.connected; i++) {
    await new Promise((r) => setTimeout(r, 1000 * i));
    try { await d.connect(); logEvent(`${d.name}: reconectado (intento ${i})`); }
    catch (e) { logEvent(`${d.name}: reconexión ${i} falló: ${(e as Error).message}`); }
  }
}

// ---------- Arranque ----------
if (!navigator.bluetooth) {
  msg("Este navegador no tiene Web Bluetooth. En iPhone usa Bluefy; en PC, Chrome o Edge.");
  $<HTMLButtonElement>("connect").disabled = true;
}
$("connect").onclick = () => void connectNew();
$("start").onclick = () => void startTest();
$("stop").onclick = stopTest;
$("clear").onclick = () => { log = null; try { localStorage.removeItem(STORE_KEY); } catch { /* */ } renderReport(); };
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("report").textContent ?? ""); msg("Informe copiado"); }
  catch { msg("No se pudo copiar; selecciona el texto a mano"); }
};
$("share").onclick = async () => {
  const text = $("report").textContent ?? "";
  const file = new File([text], "prueba-segundo-plano.txt", { type: "text/plain" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch { /* cancelado o no soportado: se descarga */ }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
};
document.addEventListener("visibilitychange", () => {
  logEvent(`página ${document.visibilityState === "visible" ? "visible" : "oculta"}`);
  if (document.visibilityState === "visible") void requestWakeLock();
});
window.addEventListener("pagehide", () => logEvent("pagehide"));
window.addEventListener("pageshow", () => logEvent("pageshow"));
document.addEventListener("freeze", () => logEvent("freeze"));
document.addEventListener("resume", () => logEvent("resume"));

setInterval(tick, 1000);
renderReport();
