# El primer uso de Team — Spec técnico

Implementa [`docs/prd/teams-onboarding.md`](../prd/teams-onboarding.md). La PRD
dice qué tiene que probar el recorrido y con qué palabras; este documento dice
qué archivo se toca, en qué orden, y cuáles de sus supuestos no sobrevivieron al
código.

Referencias `archivo:línea` al repo al 2026-09-20, rama
`worktree-teams-onboarding` sobre `main` en `c436010`. Archivo de diseño
`RFPKLtSSZjQMHy9XaOOSqp`, página **05 · Team** (`298:1988`), secciones
`852:6447` y `852:6448`.

Estado: propuesta, sin implementar.

## 0. Fuentes de verdad

| qué | dónde |
| --- | --- |
| Qué hace el recorrido, su copy, sus desenlaces, cuándo aparece | PRD §4 |
| Lo que ninguna pantalla puede decir | PRD §7 |
| El patrón de recorrido (vista `bare`, riel, paso derivado) | `web/js/first-run.js` |
| Alta de gente, mensaje de setup, `wiring()` | `web/js/team.js:59` |
| El mensaje de setup y el one-liner de instalación | `src/onboarding/index.ts`, `src/server/routes/install.ts` |
| La dirección que viaja en ese mensaje | `gatewayUrl()`, `src/server/http.ts:95` |
| Host de escucha y su checkbox | `desktop/main.ts:238`, `:536`, `:588` |
| Acceso público | `desktop/tunnel.ts`, `routes/system.ts:180`, `web/js/gateway.js:189` |
| El canal consola → shell | `src/server/desktop-bridge.ts` |
| La bifurcación del splash | `desktop/main.ts:198`, `hasCompanyPeople()` `:93` |
| Qué nav ve cada instalación | `soloIsPureInstall()`, `web/js/nav.js:88` |
| Los frames | PRD §4, con sus node-ids |

Regla vigente (`console-redesign-v2-api-gaps.md`): si un frame y la API se
contradicen, gana la API, y se anota.

## 1. Lo que ya existe y no se toca

Lo de la PRD §1, más tres cosas que son de implementación:

- **`web/js/first-run.js` no cambia una cadena.** Se le extrae el shell (§5.1) y
  el test 10 de la PRD existe para probar que salió igual.
- **Las clases `.first-run*` conservan su nombre.** Renombrarlas es un diff de
  CSS que no le da nada a nadie.
- **Ningún `src/guard/`, `src/policy/store.ts`, `src/audit/`.** Si una fase de
  este documento termina tocando alguno, se detuvo en el lugar equivocado.

## 2. Las cuatro decisiones que esta spec toma sobre la PRD

### 2.1 `reachable` no es un campo

La PRD §6.1 pide que la consola sepa "cómo se llega a este gateway". La
tentación es publicar `reachable: boolean`. No: `/health` publica los tres
hechos (§4.1) y `reachable` lo deriva quien lo lee. Un campo calculado es una
segunda copia de algo que ya se sabe, y es la misma razón por la que el paso no
se guarda.

### 2.2 El 409 vive en el endpoint, no en la consola

La PRD §5 describe el aviso de la página de la persona. La consola *podría*
decidirlo sola mirando `health.reach`. No alcanza: `GET …/onboarding` también lo
consume quien llame a la API a mano, y el bug de la PRD §0.1 es del servidor. El
endpoint se niega (§4.2) y la consola traduce esa negativa.

### 2.3 Salir por la marca necesita una bandera, y no es un cursor

La PRD §4.4 dice que salir no redispara el recorrido en la misma sesión.
`state.teamSetup.left` es memoria de proceso: no toca disco, no dice en qué paso
estaban, y se olvida al reabrir. Es lo mínimo para que la única salida no rebote
contra el `onEnter` que la trajo.

**A mirar al implementar:** `first-run.js:376` sale con `go('soloRules')`, cuyo
`onEnter` vuelve a preguntar `firstRunIsDue()` (`solo.js:57`). Si hoy rebota, es
un bug de This device con el mismo arreglo; se corrige en T4 y se anota.

### 2.4 `WARDEN_INSTALL_INTENT` es preferencia de interfaz

La respuesta del splash llega al gateway como variable de entorno (§4.4). No
autoriza nada, no entra en el hash de la política y no es una segunda noción de
admin: decide qué nav se dibuja y qué recorrido se dispara, y nada más.

## 3. El bug que T1 corrige sola

PRD §0.1, con las líneas: `desktop/settings.ts:21` (`lanEnabled: false`) →
`desktop/main.ts:238` (`host: '127.0.0.1'`) → `src/server/http.ts:123`
(`lanAddresses()[0]`, sin mirar `HOST`). `pnpm run dev` no lo sufre:
`WARDEN_HOST` por defecto es `0.0.0.0` (`src/server/config.ts:46`).

Existe con o sin recorrido, y por eso T1 va primero y se puede mergear sola.

## 4. Lo que el servidor todavía no sabe

Todo es `src/server/` y `desktop/`.

### 4.1 `/health` dice cómo se llega a este gateway

`GET /health` suma un bloque al lado de `publicUrl` (`routes/system.ts:63`):

```ts
reach: {
  /** Lo que el proceso escucha de verdad: HOST es loopback, o no. */
  listening: 'loopback' | 'network',
  /** `http://<lan>:<port>` si listening === 'network' y hay interfaz; si no, null. */
  lanUrl: string | null,
  /** Igual que hoy. */
  publicUrl: string | null,
  /** `shellAttached()`: si esta consola puede pedirle al shell que lo cambie. */
  canChange: boolean
}
```

`web/js/data.js` lo guarda en `state.reach` dentro de `refreshHealth()`, junto a
`state.publicUrl` (`:50`).

### 4.2 `gatewayUrl()` deja de inventar

Nueva firma: `gatewayUrl(req): string | null`. Devuelve `null` cuando `HOST` es
loopback y no hay `WARDEN_PUBLIC_URL`. El orden de prioridad no cambia: URL
pública, después el header `Host` si no es localhost, después la LAN.

- `GET /api/people/:id/onboarding` con `null` → **409**
  `{ error: 'Nobody else can reach this gateway yet.', reach: 'loopback' }`.
- `GET /install/:token` no cambia: quien llegó a esa ruta desde otra máquina
  demostró que el gateway es alcanzable, y el header `Host` manda.
- Los demás llamadores se revisan uno por uno. El que imprime la dirección para
  el propio admin puede seguir cayendo a `localhost`; el que la mete en algo que
  otra persona va a ejecutar, no.

### 4.3 Prender la red desde la consola

Con la forma exacta de `expose`:

- `desktop-bridge.ts`: `tellShell` acepta `'lan-on' | 'lan-off'`.
- `desktop/main.ts:257-261`: `if (msg === 'lan-on') void setLanEnabled(true)`,
  ídem off. `setLanEnabled` ya persiste y reinicia (`:536`).
- `POST /api/gateway/lan { enabled }` → `202`, o `409` sin shell con *"This
  gateway is not running inside the desktop app. Set `WARDEN_HOST` instead."*
  No entra en `EMPLOYEE_PATHS` (`admin-auth.ts:68`), así que es administrativa
  sin que nadie lo escriba. Tiene exactamente el poder del ítem de menú, que
  está en la misma máquina.

La ruta responde "pedido", nunca "hecho": el gateway se reinicia del otro lado
de esa respuesta. `watchAddress()` (`gateway.js:164`) ya es ese patrón; se
generaliza a `watchReach(predicate)` y sale de `gateway.js` a un módulo que las
dos vistas importen.

### 4.4 La respuesta del splash queda escrita

- `DesktopSettings` suma `intent?: 'solo' | 'team'` (`desktop/settings.ts:14`).
  `main.ts:198` pregunta sólo si `intent` no está **y** `!hasCompanyPeople()`, y
  escribe la respuesta.
- `server-manager.ts:83` la pasa como `WARDEN_INSTALL_INTENT`; `/health` la
  publica en `installation.intent`.
- `soloIsPureInstall()` (`nav.js:88`) devuelve `false` si `intent === 'team'`.
  Arregla el nav y, como `firstRunIsDue()` empieza por ahí, el recorrido
  equivocado.
- Sin shell no hay `intent` y todo se comporta como hoy (§8).

### 4.5 Un reporte de dispositivo llega a la consola

`/api/events` sólo transporta `type: 'decision'` (`web/js/data.js:180-181`
descarta el resto), y `POST /api/devices/report` (`routes/guard.ts:104`) escribe
en disco y no emite nada.

- `routes/guard.ts:104` emite, después de guardar,
  `{ type: 'device', employeeId }`. Ni nombre de máquina, ni herramientas, ni
  versión. `/api/events` es administrativa (`admin-auth.ts:22`), así que
  `employeeId` no le llega a ningún empleado.
- `subscribe()` en `data.js`: con `type === 'device'`, `refreshPeople()` y, si
  la vista es `teamSetup` o `people`, `render()`. En cualquier otra no se
  re-renderiza, por la razón que ese comentario ya da: un evento que llega no
  puede borrarle a alguien lo que está tipeando.

## 5. El recorrido

### 5.1 Una vista del router, sin cromo

`VIEWS.teamSetup`, `bare: true`, en `web/js/team-setup.js`. `#/teamSetup`.

`rail()`, `card()` y `screen()` son privadas de `first-run.js`, con el `3` y el
eyebrow adentro. Se mueven a `web/js/run-shell.js`, parametrizadas:

```js
screen({ kicker, steps, step, label, title, content, action, secondary, note, back, error })
```

`content` es HTML ya armado —dos tarjetas o un formulario—, que es lo único que
el shell de hoy no admite. `secondary` es el enlace al lado de la acción
(`Check again`). `first-run.js` importa el shell con `kicker: 'THIS DEVICE ·
FIRST RUN'` y `steps: 3`.

### 5.2 El paso se deriva

```js
const team = () => state.company.employees.filter((e) => e.role !== 'solo');
const reachable = () => Boolean(state.reach?.publicUrl || state.reach?.lanUrl);

export function stepOf() {
  if (!state.company.name || state.company.demo) return 1;
  if (!reachable()) return 2;
  if (!team().length) return 3;
  return 4;
}
```

`← Back` pone `state.teamSetup.step`, como `first-run.js:379`; cualquier acción
que cambie un hecho lo borra.

El desenlace del paso 4 es `wiring(team()[0]).kind`, sin traducción. `wiring()`
se exporta de `team.js`; no se copia.

### 5.3 Cuándo se dispara

`VIEWS.people` no tiene `onEnter`. Se le agrega, y sólo actúa con
`tabOf() === ''`:

```js
function teamSetupIsDue() {
  if (state.mock) return false;
  if (state.teamSetup.left) return false;
  if (team().length > 1) return false;
  return !team().some((e) => wiring(e).kind === 'wired');
}
```

La empresa de muestra tiene siete personas y cae en la tercera línea; no
necesita un caso propio.

### 5.4 Las acciones

| paso | acción | llamada |
| --- | --- | --- |
| 1 | `Continue` | `PUT /api/company` (`routes/company.ts:23`) |
| 2 | `Turn on` | `POST /api/gateway/lan` o `/api/gateway/expose`, después `watchReach` |
| 3 | `Add person` | `POST /api/people` |
| 4 | `Copy setup message` | `GET /api/people/:id/onboarding` → `copyText(j.message)` |
| 4 | `Check again` | `refreshPeople()`. No manda nada |
| 4 · `wired` | `View team` / `Write a rule` | `go('people')` / `go('policy', 'new')`, según `state.policy.rules.length` |

Las fallas del paso 2, cada una con su señal:

| situación | señal | qué dice |
| --- | --- | --- |
| sin interfaz de red | `listening === 'network'`, `lanUrl === null` | `No network found. Connect this computer to a network, or use a public address.` |
| el túnel no abrió | 2 min sin `publicUrl` (`gateway.js:170`) | `The public address did not open. Warden needs cloudflared installed on this computer.` |
| sin shell | `canChange === false` | tarjetas informativas, sin acción: `This gateway is managed outside the desktop app. Set WARDEN_HOST or WARDEN_PUBLIC_URL and restart it.` |

Sólo la segunda tiene frame (`855:6557`); las otras dos usan el mismo `feedback`
con su texto.

Si las dos vías están prendidas el mensaje lleva la pública —`gatewayUrl()` ya
prioriza `WARDEN_PUBLIC_URL`— y la tarjeta elegida lo refleja.

### 5.5 Fuera del recorrido

- **Página de la persona** (`team.js:866`): el 409 de §4.2 deja de ser un toast.
  Es un `feedback` en la tarjeta de setup con `Make Warden reachable` →
  `go('gateway', 'access')`.
- **Gateway → Access** (`gateway.js:189`): una sección `Network access` arriba
  de `Public access`, con el mismo copy de la tarjeta `Same network` y el mismo
  `watchReach`.

## 6. Componentes

Ninguno nuevo en Figma: el riel de cuatro tramos es el de tres con un rectángulo
más, el campo es `Field` (`340:4138`) y los roles son el grupo
`Role choices / Single selection` del diálogo Add people.

En CSS el riel ya admite cuatro tramos sin tocarlo: los `<i>` son `flex: 1`
(`web/styles/responsive.css:90`) y sólo el comentario de `:88` dice "three".
Lo que sí hace falta es que `.first-run-content` contenga un `.field` con el
ancho del frame (700) en vez de las tarjetas. Se verifica a ojo (PRD §9.20-21).

## 7. Fases

| fase | qué | toca | se verifica con |
| --- | --- | --- | --- |
| **T1** | `health.reach`, `gatewayUrl()` nullable, 409 del onboarding, el `feedback` de la página de la persona | `src/server/http.ts`, `routes/system.ts`, `routes/people.ts`, `web/js/data.js`, `web/js/team.js` | `scripts/test-reach.ts` nuevo (PRD §9.11-12), `test:console` |
| **T2** | `intent` persistido, puente `lan-on/off`, `POST /api/gateway/lan`, evento `device` | `desktop/settings.ts`, `desktop/main.ts`, `server-manager.ts`, `desktop-bridge.ts`, `routes/system.ts`, `routes/guard.ts`, `web/js/nav.js` | `test:desktop`, `test:auth`, `test:devices` (PRD §9.13-16) |
| **T3** | Frames a `· Elegida` | Figma | revisión del owner |
| **T4** | `run-shell.js`, `team-setup.js`, `onEnter` de People, `Network access` en Gateway | `web/js/`, `web/styles/` | `test:console` (PRD §9.1-10), renders claro/oscuro |
| **T5** | Dos máquinas | — | PRD §9.17-19 |

T1 se puede mergear sola. T2 no tiene efecto visible sin T4 salvo el nav y el
splash, que sí se pueden probar solos. T4 depende de T1 y T2.

## 8. Huecos declarados

- **Sin shell, `intent` no existe.** `pnpm run dev` con el directorio vacío
  sigue mostrando el nav solo. Alcanza con navegar a `#/people`, y quien corre
  el repo desde un checkout sabe hacerlo.
- **`Anywhere` sin shell no se puede prender.** El túnel es del escritorio. Un
  gateway desplegado llega alcanzable por `WARDEN_PUBLIC_URL` y nunca ve el
  paso 2.
- **El sujeto del paso 4 es `team()[0]`.** Con una sola persona no hay
  ambigüedad, y con dos el recorrido ya no corre.
- **`state.teamSetup.left` no sobrevive un reload del navegador**, no sólo un
  reinicio de la app. Aceptado: es la dirección en la que conviene equivocarse.
- Lo que la PRD §8 deja afuera —dirección estable, aviso al equipo, token de un
  solo uso— sigue afuera acá.
