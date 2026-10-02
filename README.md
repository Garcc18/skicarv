# SkiCoach

Análisis de esquí en tiempo real con dos botas instrumentadas (IMU + 8 FSR por bota; la
principal añade barómetro y GPS) que envían datos por Bluetooth LE a 100 Hz.

- Especificación del análisis: [docs/spec.md](docs/spec.md)
- Firmware y protocolo v3: [firmware/sensor_ble_stream.ino](firmware/sensor_ble_stream.ino)

> Estado: v1 en construcción, fase 1 (protocolo) + prueba de BLE en segundo plano.

## Requisitos

- Node.js 24 o superior
- Chrome o Edge de escritorio (Web Bluetooth), o Bluefy en iPhone

## Arrancar

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # tests (Vitest)
npm run build        # chequeo de tipos + build en dist/
```

`localhost` cuenta como origen seguro, así que Web Bluetooth funciona en Chrome/Edge del PC
sin https.

Para abrir la app desde otro dispositivo de la red local (solo desarrollo):

```sh
npm run dev:https    # https://<ip-del-pc>:5173 con certificado autofirmado
```

El navegador avisará del certificado. En el iPhone no se recomienda: usa el despliegue.

## Publicar (para el iPhone)

Web Bluetooth exige https. La app es estática (`dist/`), así que se puede alojar en
cualquier hosting estático.

### GitHub Pages (configurado)

1. Crea un repositorio en GitHub (puede ser privado si tu plan incluye Pages privadas;
   si no, público).
2. Súbelo:
   ```sh
   git remote add origin https://github.com/<usuario>/<repo>.git
   git push -u origin main
   ```
3. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Cada push a `main` ejecuta [.github/workflows/deploy.yml](.github/workflows/deploy.yml):
   tests → build → publica. La URL aparece en la pestaña **Actions** y en Settings → Pages:
   `https://<usuario>.github.io/<repo>/`.

La build usa rutas relativas, así que funciona dentro de `/<repo>/` sin configurar nada.

### Cloudflare Pages (alternativa)

En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**, elige el
repositorio y pon:

- Build command: `npm run build`
- Build output directory: `dist`
- Variable de entorno `NODE_VERSION` = `24`

## Prueba en segundo plano (Bluefy, pantalla bloqueada)

Antes de seguir con la app hay que confirmar que en el iPhone el Bluetooth, el JavaScript y
la voz siguen funcionando con la pantalla bloqueada. Página: `bgtest.html` (enlazada desde
la página principal).

1. Abre `https://<usuario>.github.io/<repo>/bgtest.html` en **Bluefy**.
2. **Conectar bota** → elige SKI-R (o SKI-L). Puedes conectar las dos.
3. Deja las tres opciones desmarcadas para la primera prueba.
4. **Empezar prueba**: oirás «prueba iniciada» y luego, cada 10 s, las tramas por segundo
   de cada bota («100»).
5. Bloquea la pantalla, móvil al bolsillo, **10 minutos**. Si deja de hablar, apúntate cuándo.
6. Desbloquea, vuelve a Bluefy y pulsa **Parar**. El informe dice `RESULTADO: OK` o `FALLA`
   con los motivos. Está también en `localStorage`, así que sobrevive a una recarga.
7. Pulsa **Compartir / descargar** y envíame el texto.

Si falla, repite con **Audio silencioso continuo** marcado: mantener una sesión de audio
abierta es lo que suele evitar que iOS suspenda la página. Después prueba con **Solo pitido**
para saber si el problema es la voz o el JavaScript.

El informe también da la **deriva del reloj** de cada placa respecto al móvil (ppm), que se
usa para decidir cada cuánto resincronizar las botas.
