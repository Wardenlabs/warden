# Warden como app de escritorio

La app de escritorio empaqueta **el gateway completo** — servidor, consola de
admin, proxy OpenAI-compatible e inferencia on-device — en una aplicación
instalable para macOS y Windows (y un zip para Linux). Es exactamente el mismo
`dist/server/index.js` que corre `pnpm start`, envuelto en Electron: la ventana
es la consola de siempre servida desde `127.0.0.1`, mismo origen, sin CORS.

Lo que cambia respecto de correrlo con Node:

| | `pnpm run dev` / `pnpm start` | App de escritorio |
|---|---|---|
| Escucha en | `0.0.0.0` (toda la LAN) | `127.0.0.1` hasta que actives **Allow LAN access** |
| Datos y auditoría | junto al repo (`data/`) | carpeta de datos del usuario (ver abajo) |
| Modelos | `pnpm run setup` | pantalla de primer arranque con descarga y reanudación |
| Puerto 8080 ocupado | el proceso muere | reintenta solo con un puerto libre |
| Cierre | Ctrl-C | apagado limpio: descarga modelos y termina el worker de inferencia |

## Conseguir el instalador

Cada push relevante (y cualquier tag `v*`) corre el workflow **desktop** de
GitHub Actions, que deja como artifacts:

| Artifact | Contenido |
|---|---|
| `warden-darwin-arm64` | `.dmg` + `.zip` para Mac con Apple Silicon (recomendado: usa Metal) |
| `warden-darwin-x64` | `.dmg` + `.zip` para Mac Intel (inferencia solo CPU) |
| `warden-win32-x64` | `Warden-Setup.exe` (instalador Squirrel) + `.zip` portable |

No existe build "universal" de macOS: los binarios nativos de inferencia son
por arquitectura y el plugin de QVAC lo rechaza a propósito. Bajá el que
corresponda a tu máquina.

Para construir localmente (en la plataforma de destino):

```bash
pnpm install --frozen-lockfile
pnpm run app:make        # deja el instalador en out/make/
pnpm run app:dev         # correr la app sin empaquetar, para desarrollo
```

## Primer arranque

1. La app detecta que faltan los modelos y ofrece **descargarlos (~5.4 GB)**
   desde HuggingFace, con barra de progreso por modelo. Una descarga cortada
   se reanuda donde quedó — es la misma lógica con `Range` que usa
   `pnpm run setup`.
2. La alternativa es **modo demo (mock)**: toda la consola funciona con
   inferencia simulada, y podés descargar los modelos más tarde desde
   *Gateway → Download models & leave demo mode*.
3. Con los modelos en disco, el gateway arranca y precalienta los pesos
   (~30 s la primera vez; el splash lo muestra). Después de eso, abrir la app
   es inmediato.

## Abrir builds sin firmar

Con los secrets de firma configurados en el repo (`MACOS_CERT_P12`,
`MACOS_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`) los builds de macOS salen firmados y notarizados, y esta
sección deja de aplicar.

Los artefactos de CI todavía no van firmados ni notarizados (eso requiere un
certificado de Apple Developer y uno de code-signing de Windows — pendiente).

- **macOS**: al abrirla, Gatekeeper dice **"Warden is damaged and can't be
  opened"**. No está dañada — es el mensaje estándar para apps descargadas
  sin notarizar, y con estos builds el clic derecho → Abrir **no** alcanza
  (verificado en una instalación real). Quitá la cuarentena una vez, desde
  Terminal ejecutando: `xattr -rd com.apple.quarantine /Applications/Warden.app`
  y abrila normalmente después.
- **Windows**: en el aviso de SmartScreen, **Más información** → **Ejecutar de
  todas formas**.

## Modo LAN (el despliegue en equipo)

Por defecto la app escucha solo en `127.0.0.1`. Para el modelo de despliegue
de siempre — una máquina con los modelos y el resto del equipo apuntando a
ella (ver [`DESPLIEGUE.md`](DESPLIEGUE.md)) — activá **Gateway → Allow LAN
access**. El gateway se reinicia escuchando en `0.0.0.0`; el sistema
operativo va a pedir permiso de firewall la primera vez (y macOS puede volver
a pedirlo tras actualizar, mientras la app no esté firmada).

Con LAN activo, **Copy network URL** copia la dirección que se le pasa a los
empleados; el flujo de onboarding (`/install/<install-token>`, hooks, claves) es idéntico
al de siempre.

## Dónde viven los datos

*Gateway → Open data folder* abre la carpeta. Por sistema:

| SO | Carpeta |
|---|---|
| macOS | `~/Library/Application Support/Warden/` |
| Windows | `%APPDATA%\Warden\` |
| Linux | `~/.config/Warden/` |

Adentro: `data/` (política, directorio, auditoría — los mismos JSON/JSONL de
siempre), `models/` (los GGUF descargados), `logs/warden-gateway.log` y
`desktop-settings.json` (puerto, modo LAN, adapter). Borrar `models/` fuerza
la re-descarga en el próximo arranque; borrar la carpeta entera resetea la
instalación completa.

## Requisitos

Los mismos del gateway: Mac Apple Silicon recomendado (Metal); Mac Intel corre
solo en CPU; Windows/Linux necesitan Vulkan ≥ 1.4 para GPU (sin eso, CPU);
8 GB de RAM mínimo — los modelos ocupan ~2 GB residentes.

## Límites conocidos

- Sin firma ni notarización (ver arriba). Sin auto-update: se instala la
  versión nueva encima.
- El modelo de OCR solo se distribuye por el registro P2P de QVAC, igual que
  en el CLI: la app no lo descarga, y el escaneo de adjuntos se degrada
  exactamente como hasta ahora.
- Cerrar la ventana cierra el gateway (también en macOS). Si el equipo está
  usándote de gateway, dejá la app abierta.
