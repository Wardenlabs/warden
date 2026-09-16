# Conectar y desconectar Warden — Spec técnico

Sigue a `docs/prd/wiring-and-unwiring.md`. Acá se cierra el cómo: qué dice cada
gateway sobre sí mismo, cómo viaja la identidad de una máquina, dónde vive una
pausa, qué flags gana el hook, y en qué orden se construye. Las decisiones de
producto del PRD (§4) son insumo fijo y no se re-litigan.

Referencias `archivo:línea` al estado del repo al 2026-09-15, `main` en
`50288d2`. **Este spec cambia `src/`**, a diferencia de la serie del rediseño.

## 1. Lo que ya existe y no se toca

- **El pipeline del guard.** `aggregate` y los pases no cambian: ninguna cosa
  de acá hace que un modelo pueda despejar un pedido. La pausa (§5) corta
  **antes** de que corra un solo pase y deja un registro que dice que no se
  juzgó; no es un veredicto del pipeline y no debe poder parecerlo.
- **`exemptRoles` y `admin-auth.ts`.** La pausa es un eje nuevo y separado; no
  se toca la autenticación de administrador ni se agrega una segunda noción de
  admin.
- **El formato del audit log.** Sigue guardando hashes y nunca texto de
  prompts. Lo que agrega este spec (§3) es metadato operativo y entra por otra
  puerta.
- **`buildInstallScript`** sigue siendo el que instala; lo que se bifurca es el
  copy y el punto de entrada, no el mecanismo (§8).
- El fail-open del hook ante gateway caído (`warden-hook.mjs:1270`) queda
  exactamente como está, con su comentario.

## 2. Cada gateway dice cuál es, y no hay dos

**`GET /health` gana `installation`:**

```
installation: {
  label: string,     // corto, no sensible: basename del directorio de datos
  version: string,   // package.json
  dataDir?: string   // SOLO en pedidos de loopback
}
```

`dataDir` es una ruta dentro del home de una persona, y `/health` es
alcanzable desde afuera cuando alguien abre el túnel
(`POST /api/gateway/expose`). Así que la ruta completa sale **solo cuando el
pedido viene de loopback**; el `label` viaja siempre porque no dice nada que no
se pueda contar.

**Colisión de puerto.** En el arranque, antes de escuchar: si el puerto está
tomado, se le pide `GET /health` al que lo tiene. Si contesta como Warden, el
proceso **sale con código distinto de cero** diciendo qué instalación lo tiene
(su `label` y versión) y cómo levantar este en otro puerto (`WARDEN_PORT`). Si
no contesta como Warden, el mensaje dice que el puerto está ocupado por otra
cosa. Hoy el segundo proceso simplemente falla al bindear, con el error de
Node y sin contexto.

## 3. La máquina: cómo viaja y dónde queda

**El hook agrega `machine` al cuerpo de `/api/guard/check`** (hoy manda
`{ prompt, source, usage, attachments? }`, `warden-hook.mjs:1250`):

```
machine: { id: string, name: string }
```

- `id`: `sha256(hostname + salt)` truncado a 16 hex, con el salt generado una
  vez y guardado en `~/.warden-hook.state.json` (`warden-hook.mjs:1109`). Es
  estable por máquina y no reversible a un nombre.
- `name`: `os.hostname()`. **Es dato personal** — suele llevar el nombre de la
  persona adentro — así que: se muestra en la consola, se guarda en el
  directorio de dispositivos, y **no entra al audit log**, que guarda hashes.
  Si hiciera falta anotar la máquina en el log, va el `id`, nunca el nombre.

**Dispositivos persistidos**, en `data/devices.json` (`0600`, gitignored),
mapa `employeeId → machineId → { name, firstSeen, lastSeen, tools, pendingSince }`.

Se persiste — y no se deja en memoria como la liveness actual
(`src/policy/activity.ts`) — porque las dos preguntas que el PRD promete
responder no sobreviven a un reinicio de otro modo: *¿la máquina de Ana llegó a
conectarse alguna vez?* y *¿cuánto hace que no da señales?*. No guarda nada de
lo que nadie escribió; es inventario operativo. `activityFor` sigue existiendo
para el "ahora mismo" y este archivo es la memoria larga.

## 4. Cableado y tráfico: quién sabe qué

Son dos hechos con dos orígenes distintos y el spec no los mezcla en ningún
lado:

- **Tráfico** lo sabe el gateway solo: un `check` que llegó es la prueba. Ya
  funciona (`recordActivity`, `guard.ts:44`); ahora se guarda además por
  máquina (§3).
- **Cableado** lo sabe la máquina. El gateway **no puede leer el home de un
  empleado**, así que no lo infiere: se lo reportan.

**`POST /api/devices/report`** (llamable con clave de empleado — entra a
`EMPLOYEE_PATHS`, `admin-auth.ts:67`):

```
{ machine: {id, name}, tools: [{ id, wired: boolean, how?: string }], hookVersion }
```

Lo llama el hook en tres momentos, nunca como latido periódico: después de
`--fix`, después de `--unfix`, y **piggyback en un check normal a lo sumo una
vez por hora** (marca en el state file). No se agrega un proceso de fondo ni
tráfico que no acompañe algo que la persona ya estaba haciendo.

Cuando el gateway corre en la misma máquina que se está mirando (This device),
además puede correr la detección local y no depende del reporte.

**La consola nunca muestra un estado que signifique las dos cosas.** Las
combinaciones y su redacción:

| cableado | tráfico | qué dice |
| --- | --- | --- |
| sí | reciente | Judging requests · verificado hace X |
| sí | nunca | Wired · nothing judged yet |
| sí | hace mucho | Wired · no requests since <fecha> |
| no | — | Not wired |
| desconocido | reciente | Judging requests · wiring not reported |
| desconocido | nunca | Unknown — this machine has not reported |

"Desconocido" es un estado de primera clase: un formato que cambió o un permiso
denegado tiene que poder decir *no pude verificarlo* en vez de inventar un "no"
(PRD §6).

## 5. Los dos interruptores

### 5.1 Pausa (la decide el gateway)

Estado en el directorio, **no** en la política: la política se hashea y una
pausa no es una regla. En cada empleado:

```
paused?: { until: string | null, reason?: string, by: string, at: string }
```

`until` nulo significa hasta que alguien la saque. Endpoints:

- `POST /api/people/:id/pause` `{ until?, reason? }` — admin.
- `DELETE /api/people/:id/pause` — admin.
- `POST /api/solo/pause` / `DELETE /api/solo/pause` — el que se autoaplica,
  sobre sí mismo.

**Un empleado no tiene camino a pausarse**: las rutas de pausa son
administrativas y `/api/solo/pause` resuelve por `resolveSoloIdentity()`, que
exige rol exento.

**Efecto en el guard.** En `identity.ts`, después de resolver al actor y
**antes** de cualquier pase: si hay pausa vigente, se devuelve

```
{ verdict: 'ALLOW', notJudged: 'paused', pausedUntil, firedRules: [], passes: [] }
```

y se registra con `notJudged: 'paused'`. Reglas duras:

- **No cuenta cuota** (`quota.ts` no se toca porque no se llega).
- **No corre ningún modelo.**
- El campo `notJudged` es obligatorio en ese registro: la consola lo muestra
  como *no juzgado · pausado* y **nunca** como "Allowed". Un `ALLOW` sin
  `notJudged` sigue significando lo que siempre significó.
- Una pausa vencida es una pausa que no existe: se evalúa contra la hora del
  pedido, no hay tarea de limpieza que pueda atrasarse.

### 5.2 Desconexión (la decide la máquina)

`warden-hook.mjs --unfix`, contraparte exacta de `--fix` (`:932`):

- **Claude Code** (`~/.claude/settings.json`): saca la entrada de
  `UserPromptSubmit` cuyo comando menciona `warden-hook`, y las claves
  `WARDEN_URL` / `WARDEN_API_KEY` del bloque `env`. **No toca** otros hooks,
  otras variables, ni reescribe el archivo entero: lee, quita lo propio,
  escribe. Si el archivo tiene algo que no parsea, no lo toca y lo dice.
- **Codex** (`~/.codex/config.toml`): saca el bloque `[[hooks.UserPromptSubmit]]`
  que menciona warden-hook.
- **OpenCode**: borra `~/.config/opencode/plugin/warden.js` solo si es el que
  Warden escribió.
- Reporta al gateway (§4) y **imprime qué sacó y qué dejó**.
- **No borra** `~/.warden-hook.mjs`, ni el perfil de shell, ni reglas, ni
  personas, ni el log. Desconectar no es desinstalar; `--unfix --purge` puede
  existir después y no entra en este spec.

## 6. `--status`: las tres preguntas

`warden-hook --status` responde, en ese orden, lo que hoy no se puede saber:

1. **¿Hay un gateway?** `GET /health` a `WARDEN_URL`. Imprime `label`, versión
   y `dataDir` (viene porque es loopback). Si no contesta: lo dice, y aclara
   que **los prompts pasan sin revisar** mientras tanto — el fail-open, dicho
   en voz alta.
2. **¿Me conoce?** `GET /api/identity` (nueva, employee-callable) devuelve
   `{ id, name, role, paused }` para la clave presentada, o 401. Es el oráculo
   mínimo: no juzga, no escribe, y no dice más de lo que el dueño de la clave
   ya sabe de sí mismo.
3. **¿Qué está cableado, y coinciden las claves?** Corre la detección de
   `AGENTS` (`:722`) y compara la clave de cada lugar (§7).

Sale con código 0 si las tres dan bien, distinto de cero si alguna no — para
que se pueda meter en un script.

## 7. La clave: una fuente y un reconciliador

`~/.warden/credentials.json` (`0600`) pasa a ser la fuente:
`{ url, apiKey, updatedAt }`.

- El instalador lo escribe primero y después deriva todo lo demás.
- El hook lee, en orden: `WARDEN_API_KEY` del entorno (para que un override
  siga funcionando), después el archivo.
- Las copias en el perfil de shell y en el `env` de cada herramienta **siguen
  existiendo** — Claude Code abierto desde el Dock no leyó ningún perfil, y su
  `env` es estático, así que no puede apuntar a un archivo. Lo que cambia es
  que dejan de ser originales: `--status` avisa cuando alguna difiere, y
  `--fix` las reescribe desde el archivo.

## 8. Los dos caminos, y lo que dice cada uno al fallar

`buildInstallScript(identity, url)` gana un parámetro `audience`
(`'self' | 'employee'`), que no cambia lo que hace sino lo que dice y a dónde
manda cuando algo sale mal.

`UNKNOWN_KEY` (`identity.ts:27`) deja de ser una constante y pasa a construirse
con lo que el gateway sabe de sí mismo:

- Siempre: *"El gateway `<label>` (v`<version>`) no reconoce esta clave."* —
  que es lo que hoy falta y lo que hubiera ahorrado la confusión del PRD §0.
- Si el pedido viene de **loopback** (es tu propia máquina): *"Abrí
  `<url>` y reclamá una clave en Team → People"*, más `warden-hook --status`.
- Si viene de **afuera**: se mantiene *"Pedile una clave a tu administrador"*,
  que ahí sí es verdad.

## 9. Rotación

`rotateApiKey` (`people.ts:349`) marca `pendingSince = now` en **todos** los
dispositivos de esa persona. La consola muestra *pendiente de reconectar* y
desde cuándo; se limpia solo en el primer check que llega desde esa máquina con
la clave nueva. La clave vieja deja de servir en el acto: **no hay período de
gracia** (PRD §4).

## 10. La consola

- **This device** queda con: identidad que está mostrando (§8 del PRD — puede
  no ser la de la clave del teclado), herramientas con los dos hechos del §4,
  el interruptor de desconexión, y **una tarea siguiente en cada estado**: sin
  cablear → cablear; recién cableado y exento → escribir una regla dirigida a
  uno mismo; andando → estado e interruptor.
- **Gateway** (nuevo, o dentro de Settings): `installation` del §2, dirección
  pública y datos en disco — lo que hoy está mezclado en This device.
- **Team**: por persona, sus dispositivos con estado y último visto; la acción
  de pausar con duración; el cartel de *pendiente de reconectar*; y una franja
  visible mientras haya alguien pausado, porque un gateway que no juzga a nadie
  no puede parecer uno que sí.
- **Activity**: los pedidos con `notJudged: 'paused'` se muestran como *no
  juzgado · pausado*, con su propio tratamiento, nunca como permitidos.

## 11. Fases

1. **F1 — Quién sos y no hay dos.** §2 completo y §8 (mensajes). Es la fase que
   sola hubiera evitado el incidente del PRD §0, y no depende de nada más.
2. **F2 — `--status` y `--unfix`.** §5.2 y §6, más `GET /api/identity`. Rompe
   la trampa: a partir de acá se puede salir sin matar procesos.
3. **F3 — Máquinas.** §3, §4 y §9: identidad de máquina, reporte de cableado,
   `data/devices.json`, pendiente de reconectar.
4. **F4 — Pausa.** §5.1, servidor y consola, con su registro en Activity.
5. **F5 — Consola.** §10 completo, contra los frames de Figma que se diseñen
   después de F1–F4, porque recién ahí se sabe qué puede prometer la pantalla.
6. **F6 — La clave.** §7, que es el más invasivo del home y el que menos duele
   postergar.

## 12. Verificación

- `pnpm run typecheck`, `pnpm test`, `pnpm run build` en verde por fase.
- **Pruebas nuevas, en `scripts/`**: que una pausa vencida no pausa; que un
  pedido pausado no cuenta cuota y sale del guard sin haber corrido un pase;
  que `notJudged` está presente en ese registro; que `--unfix` sobre un
  `settings.json` con hooks de terceros deja intacto todo lo ajeno; que el
  arranque con el puerto tomado sale distinto de cero y nombra al otro; que
  `dataDir` no aparece en `/health` fuera de loopback.
- **A mano, con dos gateways a propósito** (uno en 8080 y otro en `WARDEN_PORT`
  distinto): que el hook diga con cuál habló, que `--status` lo confirme, y que
  el segundo se niegue a arrancar cuando se le pide el puerto tomado.
- **A mano, el camino completo del PRD**: cablear, ver los dos hechos, escribir
  la regla dirigida a uno mismo, pausar con duración, ver la franja, despausar,
  desconectar, y volver a conectar.
- Barrido: el nombre de máquina no aparece en `data/audit.jsonl`.

## 13. Fuera de este documento

El diseño visual de §10, que se hace en Figma después de F1–F4 con el sistema
que ya existe. `--unfix --purge`. Y cualquier idea de impedir que un empleado
se descablee, que el PRD §2 descarta por escrito.
