"""
Receptor de prueba en PC para el firmware sensor_ble_stream.ino (protocolo v3)
pip install bleak
python ble_receiver.py            # se conecta a la primera bota que encuentre
python ble_receiver.py SKI-L      # o a una concreta por nombre

Muestra cada segundo: tramas/s recibidas, tramas perdidas (huecos en seq), sensores
sin señal y unos valores.
"""
import asyncio
import struct
import sys

from bleak import BleakClient, BleakScanner

BASE = "-5c3a-4b7e-9a21-3c6d2e8b1f40"
SVC, FRAME, GPS, CTRL, STATUS, INFO = (f"8f1d000{i}{BASE}" for i in range(1, 7))

PROTO = 3
HDR = "<BBHII"                                        # type, flags, valid, seq, t_us (12 B)
MAIN = struct.Struct(HDR + "6h" + "8H" + "ih")        # 46 B
AUX = struct.Struct(HDR + "6h" + "8H")                # 40 B
GPSF = struct.Struct(HDR + "iiiHHBBHI")              # 36 B
STAT = struct.Struct("<BBHIIi")                       # 16 B
INFOS = struct.Struct("<8BffH")                       # 18 B

OP_START, OP_STOP = 0x01, 0x02
BIT_IMU, BIT_BARO, BIT_GPS = 1 << 0, 1 << 9, 1 << 15


def sensor_names(role, n_fsr):
    names = [("IMU", BIT_IMU)] + [(f"FSR{i + 1}", 1 << (1 + i)) for i in range(n_fsr)]
    if role == 1:
        names.append(("Baro", BIT_BARO))
    return names


class Stats:
    def __init__(self):
        self.count = 0
        self.lost = 0
        self.last_seq = None
        self.last = None
        self.valid = 0

    def push(self, seq, valid, values):
        if self.last_seq is not None and seq > self.last_seq + 1:
            self.lost += seq - self.last_seq - 1
        self.last_seq = seq
        self.count += 1
        self.valid = valid
        self.last = values


frames, gps = Stats(), Stats()
acc_lsb, gyro_lsb = 16384.0, 16.4


def on_frame(_, data: bytearray):
    if data[0] == 0x01 and len(data) == MAIN.size:
        v = MAIN.unpack(data)
        frames.push(v[3], v[2], (v[5:11], v[11:19], v[19] / 100.0, v[20] / 100.0))
    elif data[0] == 0x02 and len(data) == AUX.size:
        v = AUX.unpack(data)
        frames.push(v[3], v[2], (v[5:11], v[11:19]))


def on_gps(_, data: bytearray):
    v = GPSF.unpack(data)
    gps.push(v[3], v[2], (v[5] / 1e7, v[6] / 1e7, v[12]))


def on_status(_, data: bytearray):
    s = STAT.unpack(data)
    print(f"   [STATUS] streaming={s[0]} sync={s[1]} sent={s[3]} dropped_tx={s[4]}")


async def main():
    global acc_lsb, gyro_lsb
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    print("Buscando dispositivo...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, ad: SVC in [u.lower() for u in ad.service_uuids]
        and (wanted is None or d.name == wanted),
        timeout=15,
    )
    if dev is None:
        print("No encontrado")
        return

    async with BleakClient(dev) as client:
        print(f"Conectado a {dev.name}  (MTU {client.mtu_size})")
        info = INFOS.unpack(await client.read_gatt_char(INFO))
        if info[0] != PROTO:
            print(f"El firmware usa protocolo v{info[0]} y este script espera v{PROTO}.")
            return
        role, side, n_fsr, present = info[1], info[3], info[4], info[10]
        acc_lsb, gyro_lsb = info[8], info[9]
        names = sensor_names(role, n_fsr)
        installed = [n for n, b in names if present & b]
        missing = [n for n, b in names if not present & b]
        print(f"INFO: bota {'izquierda' if side == 1 else 'derecha'}, "
              f"{'principal' if role == 1 else 'auxiliar'}, rate={info[5]}Hz gps={info[6]}Hz")
        print(f"      instalados: {', '.join(installed) or '-'}")
        print(f"      no instalados: {', '.join(missing) or '-'}")

        await client.start_notify(FRAME, on_frame)
        await client.start_notify(STATUS, on_status)
        if role == 1 and present & BIT_GPS:
            await client.start_notify(GPS, on_gps)
        await client.write_gatt_char(CTRL, bytes([0x20, 0, 0]), response=True)  # sin fallos simulados
        await client.write_gatt_char(CTRL, bytes([OP_START]), response=True)

        prev_f, prev_g = 0, 0
        try:
            while True:
                await asyncio.sleep(1)
                rf, rg = frames.count - prev_f, gps.count - prev_g
                prev_f, prev_g = frames.count, gps.count
                line = f"frames {rf:3d}/s  perdidas {frames.lost}"
                if role == 1 and present & BIT_GPS:
                    line += f" | gps {rg}/s perdidas {gps.lost}"
                no_signal = [n for n, b in names if present & b and not frames.valid & b]
                if no_signal:
                    line += f" | SIN SEÑAL: {', '.join(no_signal)}"
                if frames.last and frames.valid & BIT_IMU:
                    imu = frames.last[0]
                    line += f" | az={imu[2] / acc_lsb:+.2f} g  gx={imu[3] / gyro_lsb:+7.1f} dps"
                print(line)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            await client.write_gatt_char(CTRL, bytes([OP_STOP]), response=True)


if __name__ == "__main__":
    asyncio.run(main())
