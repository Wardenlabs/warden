# El primer uso de This device, y el tema — Spec técnico

Implementa `docs/prd/console-f7-f8.md`. La PRD dice qué tiene que probar la
pantalla y con qué palabras; este documento dice qué archivo se toca, en qué
orden, y cuáles de sus supuestos no sobrevivieron al código.

Referencias `archivo:línea` al repo al 2026-09-16, rama `first-run-f7` en
`8455eaa`, `main` en `1e76144`. Archivo de diseño `RFPKLtSSZjQMHy9XaOOSqp`,
página **06 · This device** (`298:1989`).

## 0. Fuentes de verdad

| qué | dónde |
|---|---|
| producto | `docs/prd/console-f7-f8.md` |
| copy de las pantallas | frames `603:1080` y `611:1086` |
| condición de completado, y qué la retira | notas `675:2054`, `675:2068` |
| llegada a This device | nota `675:2070` |
| tres hechos por herramienta | nota `675:2073` |
| tokens del tema | `677:2054`, colección "Warden · Sistema" |
| componentes que ya existen, y su clase CSS | `docs/specs/console-redesign-v2.md §4` |
| componentes que el recorrido agrega | §5.6 de este documento |
| qué NO implementar | secciones `99A`, `99`, `90` de la misma página |

Cuando esta spec y la PRD digan cosas distintas, gana esta spec y §2 dice por
qué. Cuando esta spec y el archivo de Figma digan cosas distintas fuera de §2,
gana el archivo.

Los once frames de las dos secciones están abiertos y comparados uno por uno
contra este documento, no contra la transcripción de la PRD. Lo que salió de ahí
está en §5.4.1 (dos líneas de copy y un botón que no va), §5.6 (los tonos de la
tarjeta), §7.1 (cuatro filas, no cinco) y §10 (el sidebar). Todo lo demás
coincide palabra por palabra.

## 1. Lo que ya existe y no se toca

Todo lo de `console-f7-f8.md` §1 sigue en pie, y se agregan cuatro:

- **El pipeline del guard.** Ningún camino nuevo donde la respuesta de un modelo
  despeje un pedido (`CLAUDE.md`, la invariante). El primer uso *muestra* una
  decisión; no la produce ni la simula.
- **`exemptRoles` y `admin-auth.ts`.** Ninguna segunda noción de admin.
- **El audit log guarda hashes, nunca texto de prompts.** El registro nuevo de
  §4.1 guarda `auditId`, no texto.
- **El sidebar como estructura.** `web/js/nav.js:63-95`. Cambia el color (§3), no
  los grupos ni los ítems.
- **La pestaña Identity.** `web/js/solo.js:354` queda como está.
- **`web/js/simulator.js`.** No se conecta a nada de este documento. Ver §5.5.
- **El splash de Electron.** `desktop/splash.html`, `desktop/first-run.ts`,
  `desktop/main.ts`. Ver §2.1: es la razón de la decisión más grande de acá, y
  no se edita en ninguna de las dos fases.
- **`--verdict-*`, `--role-*`, `--signal-red`.** El tema cambia los neutrales.
  Los seis valores de veredicto ya son los de la colección nueva, verificados
  hex por hex contra `677:2060`.

## 2. Las cinco decisiones que esta spec toma sobre la PRD

La PRD se escribió mirando el archivo de diseño, que diseña la consola. Cuatro
de sus supuestos no sobreviven al contacto con la app de escritorio, y el quinto
es una pregunta que dejó abierta.

### 2.1 Los pasos 01 y 02 ya existen, y están antes

**El hecho.** `desktop/splash.html:93-102` ya pregunta la bifurcación:

> Warden puede correr para vos, o para tu equipo.
> `This device, for me` · `The team console`

Orquestado por `desktop/main.ts:198`, que además lo pregunta **una sola vez por
instalación** (`if (!SMOKE && !hasCompanyPeople())`), y según la respuesta abre
la consola completa o llama `POST /api/solo/setup` y la abre en `#soloRules`
(`main.ts:294-305`). Eso es, palabra por palabra, el paso 01 del diseño.

Y `splash.html:108-119` ya es el paso 02: *"Download the on-device models"*, con
`Download models` y `Try demo mode instead`, incluida la advertencia de que demo
no protege nada.

**Por qué no se mueven a la web.** Tres razones, en orden de dureza:

1. En modo real el gateway **no arranca sin modelos**: `ensureModels()` corre
   antes de `launchGateway()` (`main.ts:203-215`). La consola web no existe
   hasta que el gateway está arriba. Para cuando la web puede preguntar si
   querés bajar el juez, ya lo bajaste o ya estás en demo.
2. La ubicación fue una decisión escrita y argumentada:
   `docs/specs/solo-mode.md §8` pone la bifurcación **antes** de la pantalla de
   descarga *"para que el texto de esa pantalla ya pueda ajustar su copy según
   el camino elegido"*. Nada de F7 la invalida.
3. Preguntar dos veces lo mismo es peor que preguntarlo en el lugar subóptimo.

**La decisión.** El splash se queda con 01 y 02. **El recorrido web es de tres
pasos**, y los frames `604:1080` y `605:1081` no se construyen como pantallas
nuevas — son el splash, y F8 los usa para reestilizarlo si sobra tiempo.

**El riel.** `1 of 3 · CONNECT A TOOL`, `2 of 3 · ACTIVATE A RULE`,
`3 of 3 · VERIFY`, y después `SETUP COMPLETE · VERIFIED`. Los desenlaces de
falla conservan su etiqueta: `3 of 3 · RULE NOT VERIFIED`,
`3 of 3 · CONNECTION FAILED`, `3 of 3 · NO DECISION`. **Todo el resto del copy
va literal del archivo**, incluidos los títulos, las bajadas, las dos tarjetas
de cada paso y las notas al pie.

### 2.2 El recorrido se dispara del lado que eligió el splash

La elección del splash decide qué onboarding corre. Eligió "This device" → corre
el recorrido de §5. Eligió "The team console" → **el recorrido de This device no
se dispara nunca**, y This device queda como está hoy (el bloque de condiciones
con sus huecos en ámbar) hasta que esa persona quiera cablear su propia máquina.

El onboarding de Teams es otro documento. La PRD lo deja fuera de alcance (§8) y
acá sólo nos aseguramos de no pisarlo.

**Cómo se deriva, sin tocar el escritorio.** La elección solo deja rastro:
`POST /api/solo/setup` (`src/server/routes/solo.ts:101`) resuelve —y si hace
falta, crea— la identidad, que es un empleado con rol `solo`
(`resolveSoloIdentity`, `solo.ts:63-78`). `soloIsPureInstall()`
(`web/js/nav.js:105-108`) ya lee eso.

**Hueco aceptado, y es de esta decisión.** `soloIsPureInstall()` devuelve `true`
cuando el directorio está **vacío**, y el camino team no escribe nada hasta que
dan de alta a alguien. Un admin que eligió "The team console" y todavía no cargó
a nadie es indistinguible de una instalación solo recién hecha, y le
dispararíamos el recorrido equivocado una vez.

Se arregla persistiendo la respuesta del splash donde el gateway la lea — hoy
vive en `let soloOnboarding = false` (`main.ts:70`), se consume una vez
(`main.ts:294`) y se olvida. **No se hace acá**: es código de arranque del
escritorio, por un caso de borde que no es de F7, y el lugar donde corresponde
hacerlo es el onboarding de Teams. Queda anotado en §10.

De paso, y preexistente: hoy `main.ts:198` le vuelve a preguntar device/team en
cada arranque hasta que cargue a alguien. No lo creamos nosotros y no lo
arreglamos acá.

### 2.3 Una instalación que ya existe entra al recorrido

Decidido: **nadie está completado hasta que haya un pedido real con decisión de
la regla activa.** No hay grandfathering.

Como el paso se deriva de los hechos y no de un cursor guardado (PRD §2.6), una
instalación de hoy —modelo bajado, Claude Code cableado, regla activa— **no
empieza en el 1**: aparece directo en `3 of 3 · VERIFY` y sale mandando un
pedido de prueba desde su herramienta. Un click y una pregunta al asistente.

Esto es deseable y no un costo: es exactamente el hecho que F5 no podía probar y
que la PRD §0.2 identifica como lo que sigue mal. La primera vez que cada
instalación actualice, va a tener que ganarse la palabra "protegido" una vez.

### 2.4 Demo mode no dispara el recorrido

La PRD ponía la salida a demo en el paso 02. Ahora vive en el splash
(`splash.html:117`, `btn-mock`), así que la decisión se traduce:

- En demo (`state.mock === true`) **el recorrido no se dispara.** La consola
  abre normal, con el banner de demo que ya dibuja el shell
  (`web/js/render.js:88`).
- El recorrido **nunca se marca completado** por haber estado en demo.
- Cuando la instalación sale de demo, se dispara solo. Eso ya pasa sin código
  nuevo: `main.ts:216-223` vuelve a `real` en cuanto los modelos aparecen, y
  `onEnterSolo` refresca `/health` en cada entrada (`web/js/solo.js:64-66`).

### 2.5 En el navegador es el mismo recorrido de tres

`pnpm run dev`, o el gateway servido a otra máquina, no tienen splash: nadie
preguntó device/team y nadie bajó el modelo. Aun así **el recorrido es el
mismo**, y la condición de §5.2 lo resuelve sin un riel de largo variable: si no
hay juez, no se dispara, y la consola muestra lo de hoy — el bloque de
condiciones en ámbar y el botón `Get a judge` que ya lleva a Models
(`web/js/solo.js:329`), que ya sabe bajar pesos con progreso.

Una implementación, un riel, ningún camino que exista sólo en un entorno.

## 3. F8 — El tema

Primera fase, y va sola. Es mecánico, toca todas las pantallas y se revisa a
ojo; mezclarlo con lógica nueva hace irrevisables a los dos.

### 3.1 Los tres bloques de `:root`

`web/style.css` tiene el bloque light (`:26-78`), el dark bajo media query
(`:80-116`) y su copia byte a byte bajo `[data-theme="dark"]` (`:118-154`). La
nota del encabezado (`:16-18`) explica por qué está duplicado: sin build step no
hay forma de compartirlo. **Editar los dos o ninguno.**

Neutrales, todos cambian:

| token | Light | Dark |
|---|---|---|
| `--ink` | `#17181C` → `#22282A` | `#E9EAED` → `#F3F3F1` |
| `--ink-body` | `#44474E` → `#444D4F` | `#C2C5CB` → `#CCCCCA` |
| `--muted` | `#70747C` → `#656E6F` | `#878C96` → `#9E9E99` |
| `--surface-page` | `#FFFFFF` sin cambio | `#16181D` → `#171717` |
| `--surface-subtle` | `#F5F5F7` → `#F4F5F4` | `#21242B` → `#242424` |
| `--surface-raised` | `#FFFFFF` sin cambio | `#1D2026` → `#292929` |
| `--surface-disabled` | `#F0F0F2` → `#ECEEEC` | `#1C1F24` → `#202020` |
| `--line-hairline` | `#EAEAED` → `#E7EAE8` | `#262A31` → `#353535` |
| `--line-control` | `#E0E0E4` → `#DDE2DF` | `#30353D` → `#424242` |
| `--line-accessible` | `#858A94` → `#7D8788` | `#565C66` → `#6A6A66` (§3.3) |
| `--action` | `#262A33` → `#22282A` | `#E9EAED` → `#F3F3F1` |
| `--action-ink` | `#FFFFFF` sin cambio | `#141619` → `#171717` |
| `--action-hover` | `#353B47` → `#323B3E` | `#D9DBDF` → `#E4E4E1` |

La tabla va como comentario arriba del bloque `:root`, con el mapa al nombre de
Figma (`--ink` ↔ `ink/default`, `--action` ↔ `action/graphite`, etc.). **Los
nombres del CSS no se renombran** (PRD §5.4): son ~1200 líneas y el prefijo
`--warden-` no compra nada.

### 3.2 El sidebar deja de ser invariante

El cambio más visible. Se van tres comentarios que dejaron de ser verdad:
`style.css:63` (*"sidebar — invariant: the same values in light and dark"*) y las
dos copias de `:110` y `:149` (*"sidebar: deliberately not redefined"*). Los dos
bloques dark pasan a redefinir los seis tokens.

| token | Light | Dark |
|---|---|---|
| `--sidebar-bg` | `#0F1013` → `#F4F5F4` | `#202020` |
| `--sidebar-text` | `#C3C6CD` → `#444D4F` | `#CACAC7` |
| `--sidebar-muted` | `#8D919A` → `#656E6F` | `#999995` |
| `--sidebar-avatar` | `#212329` → `#E6E8E6` | `#343434` |
| `--sidebar-selected-text` | `#F0F0F2` → `#22282A` | `#F2F2EF` |
| `--sidebar-selected-bg` | `#262A33` → `#E6E8E6` | `#343434` |

`--sidebar-selected-bg` y `--sidebar-avatar` quedan con el mismo valor en ambos
modos. **Mantener los dos nombres**: son roles distintos que hoy coinciden, y
colapsarlos es justo lo que el encabezado prohíbe (`style.css:21`, *"Pick a token
by its role, never by its value"*).

Dos consecuencias buscadas, que se miran con los ojos:

- **En Light `--surface-subtle` y `--sidebar-bg` son el mismo `#F4F5F4`.** El
  sidebar y una fila en hover son el mismo gris, a propósito. En Dark se separan
  (`#242424` vs `#202020`).
- **`--surface-disabled` deja de servir para selección.** Auditado: hoy se usa en
  `style.css:317` (`.btn:active`), `:325`, `:355` y `:686`, todos controles
  deshabilitados salvo el primero. `.btn:active` es un estado presionado, no una
  selección; **se deja**, y la línea 22 del encabezado —que hoy dice que
  `--surface-disabled` y `--sidebar-selected-text` comparten hex en light— hay
  que reescribirla porque deja de ser cierta.

Hover de fila, hover de botón *quiet* y tab/filtro seleccionado: los tres
`--surface-subtle`.

### 3.3 Los tokens que Figma no nombra

Seis cosas viven en `style.css` y no tienen variable en la colección. Se deciden
acá, con el porqué escrito al lado en el CSS:

- **`--role-*` (cinco pares) y `--signal-red`.** Identidad y señal, no neutrales.
  La nota acota el cambio a los neutrales. **Quedan.**
- **`--focus-ring`** (`#365FA5` / `#6E96E8`). Accesibilidad, comparte el azul de
  `--role-admin`. **Queda**, pero hay que mirar el contraste contra el sidebar
  claro nuevo: un anillo azul sobre `#0F1013` y sobre `#F4F5F4` no son el mismo
  problema. Es el punto 15 de §9.
- **`--line-accessible` en dark.** Figma sólo da el valor light. **`#6A6A66`**,
  derivado para mantener contra `#171717` la misma relación que `#7D8788` tiene
  contra `#FFFFFF`. Se marca en el código **como derivado, no como decisión de
  Figma**, para que el día que la colección lo nombre nadie tenga que adivinar
  cuál gana.
- **`--shadow-float` y `--scrim`.** Hoy son `rgba(23,24,28,…)` y
  `rgba(15,16,19,…)` (`style.css:76-77`), o sea el `--ink` viejo. **Se
  re-derivan de `#22282A`** → `rgba(34,40,42,…)`, o la sombra queda azulada
  sobre un fondo verde-gris. Los valores dark son negros puros y no se tocan.

### 3.4 El splash, que tiene su propia paleta

`desktop/splash.html:13-24` declara diez tokens propios y **no lee
`style.css`**. Es deliberado y su encabezado dice por qué: *"Self-contained on
purpose — no network, no external assets"*. El mismo encabezado promete *"Same
design language as the console"*, y eso deja de ser cierto el día que F8 mergea:
la app abriría con la paleta vieja y entraría a una consola con la nueva.

Entra en la fase 1, acotado a esto:

| token del splash | hoy | pasa a | de |
|---|---|---|---|
| `--ink` | `#17181c` | `#22282A` | `--ink` |
| `--muted` | `#70747c` | `#656E6F` | `--muted` |
| `--line` | `#eaeaed` | `#E7EAE8` | `--line-hairline` |
| `--line-firm` | `#dcdce1` | `#DDE2DF` | `--line-control` |
| `--accent` | `#1a1d23` | `#22282A` | `--action` |
| `--accent-hover` | `#2b2f37` | `#323B3E` | `--action-hover` |
| `--ok` | `#1f7a3d` | `#087356` | `--verdict-allow` |
| `--bad` | `#b3261e` | `#B91C41` | `--verdict-block` |

`--bg` y `--accent-ink` ya son `#ffffff` y no se mueven. `--ok` y `--bad` no son
neutrales, pero tampoco eran los veredictos del sistema: son un par suelto que
nunca se alineó, y las barras de descarga que los usan quedan del color que el
resto del producto usa para lo mismo. Además el botón pasa de `border-radius: 8px`
a 6, que es `radius/control`.

**No se agrega dark mode al splash.** Hoy es blanco siempre, y en una máquina con
el sistema en oscuro eso ya produce un destello blanco antes de la consola. Es
preexistente, dura dos segundos y arreglarlo es una pantalla, no un token.

## 4. F7 — Lo que el servidor todavía no sabe

Cinco huecos. Los tres primeros bloquean la pantalla; los dos últimos son
diagnóstico.

### 4.1 `src/policy/verification.ts` — evidencia durable

**El hueco.** `activityFor()` vive en un `Map` en memoria
(`src/policy/activity.ts:27`) y guarda `{ tool, at, count }`. No guarda el
veredicto, ni la regla, ni el `auditId`, y se vacía con el proceso. Su propio
encabezado dice que es una vista de liveness y no un registro, y tiene razón. Un
onboarding cuya finalización se evapora al reiniciar el gateway es el mismo bug
que F5 arregló en Team, escrito de nuevo.

**La forma.** Archivo nuevo al lado de `src/policy/devices.ts`, con la misma
anatomía: `atomicJSON` desde `../models/store.js`, `0600`, gitignored, esquema
Zod, caché en módulo, `forgetVerifications()` para los tests, ruta por
`process.env['WARDEN_VERIFIED_PATH'] ?? 'data/verified.json'`.

```ts
export const verifiedSchema = z.object({
  tool: z.string().min(1).max(64),   // 'claude-code'
  auditId: z.string().min(1),        // el handle del pedido, nunca su texto
  verdict: z.enum(['ALLOW', 'ESCALATE', 'BLOCK']),
  ruleIds: z.array(z.string()),      // las que dispararon
  at: z.string(),
  policyVersion: z.string()          // contra qué política se verificó
});
/** employee id → tool → la verificación de esa herramienta. */
/**
 * Por persona: la primera vez que completó el recorrido, y sus verificaciones
 * vivas por herramienta.
 *
 * Son dos hechos distintos y por eso están en dos campos. `tools` se vacía
 * sola cada vez que alguien cambia una regla o recablea; `completedAt` se
 * escribe una vez y **no se borra nunca**. Guardarlos juntos —"completó" ≡
 * "tiene una verificación viva"— hace que descablear una herramienta en marzo
 * te devuelva al onboarding, que es exactamente lo que `675:2068` prohíbe.
 */
const personSchema = z.object({
  completedAt: z.string().optional(),
  tools: z.record(z.string(), verifiedSchema).default({})
});
const storeSchema = z.record(z.string(), personSchema);
```

`completedAt` lo escribe la misma llamada que escribe la primera verificación,
en la misma operación atómica: no hay un endpoint que diga "terminé". El botón
`View protection` no lo escribe — para cuando aparece, el hecho que lo justifica
ya está en disco (§5.2).

**Quién escribe.** `src/server/routes/guard.ts:134`, al lado de
`recordActivity`, y **sólo** cuando se cumplen las tres:

1. el veredicto no es `ALLOW`,
2. `firedRules` no está vacío,
3. `req.body.source` nombra una herramienta (el mismo campo que
   `recordActivity` ya lee, `guard.ts:134`).

Nada de texto de prompt. `auditId` es el handle que el audit log ya emite
(`Decision.auditId`, `src/guard/types.ts:118`).

**Quién borra.** La verificación se retira, por herramienta, cuando:

- cambia la regla activa de esa persona — los tres caminos:
  `POST /api/solo/presets/:id/toggle` (`solo.ts:180`),
  `POST /api/solo/rules` (`solo.ts:258`), `DELETE /api/solo/rules/:id`
  (`solo.ts:248`);
- se reescribe el cableado de esa herramienta — `protect`/`unprotect` de §4.3.

Retirar **conserva la configuración** y sólo borra la evidencia (nota
`675:2068`). Borra la entrada de `tools` y **no toca `completedAt`**: el
onboarding no se reabre, y la pantalla de This device es la que cambia lo que
dice. Ver §5.2.

**Por herramienta, no por máquina.** *"Una segunda herramienta no hereda la
verificación de la primera"* (`675:2054`). Por eso la clave es
`(employeeId, tool)` y no `employeeId`.

### 4.2 El sobre del evento SSE tiene que nombrar la herramienta

**El hueco.** `emitDecision(decision)` (`src/server/events.ts:70`, llamado en
`guard.ts:143`) emite un `Decision` (`src/guard/types.ts:117`), que no tiene la
herramienta. El paso 3 tiene que distinguir *"llegó un pedido de Claude Code"* de
cualquier otro tráfico, y con el evento de hoy no puede.

**La forma.** Se agrega al **sobre del evento**, no al `Decision` ni al registro
de auditoría:

```ts
export function emitDecision(decision: unknown, envelope?: { source?: string }): void
```

y el payload pasa a `{ type: 'decision', decision, source }`. El `Decision` es lo
que se le contesta al hook y no le hace falta; el evento es para la consola. Los
otros dos llamadores (`guard.ts:231` `onRecheck`, `proxy.ts:15`) no pasan
`source` y siguen funcionando igual.

**Lo que habilita.** El paso 3 escucha y **sólo reacciona a la herramienta que la
persona eligió en el paso 1**. Una decisión de otra herramienta no produce nada:
ni verde, ni error, sigue esperando. Sin este campo la pantalla festeja con
cualquier tráfico, que es la peor forma posible de fallar — le dice a alguien que
verificó algo que no verificó.

### 4.3 Cablear y descablear una sola herramienta

**El hueco.** `POST /api/solo/protect` (`solo.ts:267`) corre el script de
instalación completo en proceso, por `execFile('/bin/sh')`: cablea todo lo que
encuentra. El paso 1 pide *una*, y la pestaña Tools pide `Connect` y `Unwire` por
fila.

**La forma.**

- `POST /api/solo/protect { tool? }` — el campo es opcional y sin él se comporta
  exactamente como hoy, así que el botón `Protect this device` del bloque de
  condiciones (`solo.js:328`) no cambia.
- `POST /api/solo/unprotect { tool }` — corre el `--unfix` del hook acotado a esa
  herramienta. `tool` es obligatorio: no hay "descablear todo" en un botón.

**El hook no sabe acotarse, y acotarlo es una línea.** `fixMode(agents)` y
`unfixMode(agents)` (`integrations/warden-hook.mjs:1001` y `:1235`) ya reciben
una lista y ya despachan por `id` — `unfixers` en `:1237` tiene una función por
herramienta. Lo que no existe es la bandera: el CLI les pasa `detectAgents()`
entero (`:1751`, `:1760`). Hace falta **`--only <id>`**, que filtra esa lista
antes de pasarla, y con eso `--fix` y `--unfix` quedan acotados los dos por el
mismo cambio.

Es poco código en un archivo delicado: `warden-hook.mjs` corre en cada prompt.
La bandera no toca ninguna ruta que se ejecute durante un check — vive en el
despacho de `--detect/--fix/--unfix`, que el hook sólo recorre cuando lo llamás
a mano. Un `--only` con un id que no existe no cablea nada y lo dice; no cablea
todo, que es el fallo caro.

Lo que ya está resuelto y no hay que escribir: los dos modos llaman
`reportWiring()` al terminar (`:1757`, `:1765`), así que después de cablear o
descablear una herramienta el gateway se entera solo y la fila de Tools se mueve
sin que la consola tenga que pedir nada.

Los dos sólo para la identidad que `/api/solo/*` resuelve, y ninguno toca la
máquina de nadie más. **En This device se puede porque el gateway corre en la
misma máquina que la herramienta**, y `protect` ya escribe archivos en este
`$HOME`; escribir uno menos es la misma operación con el mismo permiso.

Eso **no** se extiende a Team. Ver §7.3.

`Check again` de la fila "no instalada" es re-correr la sonda de CLI, que ya
existe y alimenta `state.compiler.cliTools`.

### 4.4 "Sin respuesta" es observable, y no por donde parece

**El problema.** Si el hook se queda sin tiempo, falla abierto y no le cuenta a
nadie. El gateway no puede ver un timeout del lado del cliente, y pedirle al hook
que reporte no sirve: si no llegó a Warden, tampoco va a llegar el reporte.

**Pero el gateway sí puede ver su propia lentitud.** `Decision.totalMs` existe
(`src/guard/types.ts:120`) y `/health` ya publica `deadlines.decisionMs`
(`src/server/routes/system.ts:91`). Una decisión con `totalMs > decisionMs` es,
por construcción, una decisión que llegó **después** de que el hook ya dejó pasar
el prompt. Eso es exactamente *"No decision"*, y es observable sin tocar el hook.

El otro sabor —la herramienta no pudo alcanzar al gateway— es indistinguible de
*no se mandó ningún pedido*, y la pantalla no debe fingir que los distingue. Por
eso el frame de "Sin conexión" dice **"No request received"**.

Esto no cambia el trade que `CLAUDE.md` documenta: el hook sigue fallando abierto
a los 90 s y sigue siendo deliberado. Lo nuevo es que el primer uso lo puede
*mostrar* en vez de reportar éxito sobre un prompt que pasó sin revisar.

### 4.5 Diagnóstico de conexión, sin endpoint nuevo

*"Sin conexión"* necesita saber que el hook **falta**, no sólo que no llegó
tráfico. Ese hecho ya está en disco: `devicesFor()` (`src/policy/devices.ts`)
devuelve `tools: [{ id, wired }]`, y `/api/solo/rules` ya lo sirve desde que F5
agregó `withActivity` (`solo.ts:94`). El cliente ya lo lee en `toolState()`
(`web/js/solo.js:96-113`).

Lo único que falta es usarlo en el flujo, respetando la distinción que F5 fijó y
que `toolState` ya codifica: **`wired === null` es *no se sabe*, no *no está***
(`solo.js:92-94`).

## 5. F7 — El recorrido

Sección de diseño `603:1080`. Notas `675:2054`.

### 5.1 Una vista del router, sin cromo

Los frames no tienen sidebar: pantalla completa con la marca `warden` arriba a la
izquierda, un eyebrow `THIS DEVICE · FIRST RUN`, título, bajada, el riel, dos
tarjetas, la acción primaria abajo a la derecha y una nota al pie. Desde el paso
2 aparece `← Back` al pie, a la izquierda — el layer se llama
*"Back to previous step"*, pero el texto que renderiza es `← Back` (`634:92`), y
manda el pixel.

**Sigue siendo una vista del mismo router**, no una página aparte, para que `go()`
y el hash sigan siendo la única forma de navegar (PRD §2.1). Archivo nuevo
`web/js/first-run.js`, registrado como `VIEWS.firstRun` igual que todos
(`web/js/views.js`).

El shell siempre dibuja el sidebar (`web/js/render.js:76`, `renderNav()`), así
que hace falta una propiedad de vista nueva:

- `VIEWS.firstRun = { body, bind, onEnter, bare: true }`.
- En `render()`: si `val(view.bare)`, no se llama `renderNav()`, se vacía
  `#sidebar` y se marca `document.body.dataset.bare = 'true'`; si no, se borra el
  atributo y sigue todo igual. `.pane` es `flex: 1` dentro de un body flex
  (`style.css:194`, `:214`, `:275`), así que con el aside vacío y
  `body[data-bare] .sidebar { display: none }` el pane toma el ancho completo sin
  tocar el resto del layout.
- **Los banners del shell no se dibujan en una vista `bare`.** `render.js:88` ya
  excluye el de first-run en las vistas solo; el de demo no puede aparecer porque
  en demo el recorrido no se dispara (§2.4), y el de compilador no tiene lugar en
  una pantalla de 2 tarjetas.

**La salida.** El diseño no tiene "Skip". La marca `warden` de arriba a la
izquierda es el único elemento persistente de la pantalla, así que **es el
enlace de salida**: lleva a `#/soloRules` y no marca nada como completado. Es una
decisión de esta spec; el archivo dibuja la marca pero no dice que se pueda
tocar. Sin esto la pantalla no tiene salida que no sea cerrar la app.

### 5.2 Cuándo se dispara, y cuándo no vuelve

**Se dispara** desde `onEnterSolo()` (`web/js/solo.js:61-68`), que ya busca todo
lo que hace falta para decidirlo — `/api/solo/setup`, presets, reglas y
`/health`. Después de las cuatro, si se cumplen las cuatro condiciones,
`go('firstRun')`:

1. `soloIsPureInstall()` — directorio vacío o sólo roles `solo` (§2.2).
2. `!state.mock` — hay juez de verdad (§2.4, §2.5).
3. No hay ninguna verificación en el registro de §4.1, ni la hubo nunca.
4. No estamos ya en `firstRun`.

Engancharlo en `onEnterSolo` y no en el router cubre los dos caminos sin tocar el
escritorio: la app abre `#soloRules` explícitamente (`main.ts:304`), y el
navegador con hash vacío cae en `soloRules` por `parseHash`
(`web/js/router.js:23`). Los dos pasan por `onEnter`.

**El paso dentro del recorrido se deriva de los hechos**, no de un cursor
guardado: si ya hay una herramienta cableada, el paso 1 está hecho. Guardar en
qué paso quedó alguien es guardar una copia de algo que el servidor ya sabe, y
las dos se desincronizan. Es también lo que hace que §2.3 funcione sin código de
migración.

**No vuelve a entrar nunca más.** La condición 3 dice *ni la hubo nunca*: el
registro guarda un `completedAt` a nivel de persona, aparte del mapa por
herramienta, y eso es lo durable. Retirar una verificación (§4.1) cambia lo que
dice This device; **no reabre el onboarding**. Alguien que descablea una
herramienta en marzo no vuelve a pasar por el alta.

**`View protection`** cierra el recorrido y abre This device en la pestaña Rules:
`go('soloRules')`. Eso re-dispara `onEnterSolo`, que ahora encuentra la
verificación y no redirige. El bucle se cierra sobre un hecho real, que es
justamente la regla de la PRD.

### 5.3 Los tres pasos

Copy literal de los frames. Título y bajada de cada tarjeta van tal cual; el
texto suelto al pie es la nota al pie de esa pantalla.

**1 · Conectar herramienta** (`605:1102`) — `1 of 3 · CONNECT A TOOL`

> **Connect the tool you use first**
> Warden found these tools on this computer. Pick one to connect now; you can add more later.
>
> - **Claude Code · found** — Add Warden to Claude Code so requests are checked before they leave this computer.
> - **Codex · found** — You can connect Codex after your first protection is working.
>
> `Connect tool` · *Warden will show what it changed and whether the tool reported back.*

La lista sale de `toolState()` (`solo.js:96`); el sufijo `· found` es el estado de
la sonda de CLI, no del cableado. `Connect tool` es
`POST /api/solo/protect { tool }` (§4.3). La herramienta elegida se guarda en
`state.firstRun.tool` y es la que el paso 3 va a escuchar (§4.2).

**2 · Primera regla** (`606:1083`) — `2 of 3 · ACTIVATE A RULE`

> **Choose your first rule**
> Claude Code is connected. Choose what Warden should stop before testing it.
>
> - **Block credential requests** — Warden blocks requests for API keys, tokens and passwords. This rule applies to you.
> - **Write a different rule** — Describe what you want to protect in your own words and review it before activation.
>
> `Activate rule` · *Suggested rules are ready to use. You can edit your protection later.*

La primera tarjeta activa `solo-security-1`, por
`POST /api/solo/presets/solo-security-1/toggle { active: true }`. Es
*"Credentials, API keys, access tokens, and passwords must never be requested…"*,
la primera de la categoría `security` de `data/seed/presets.json`. **El texto de
la tarjeta es un resumen de la regla, no la regla**: lo que lee el juez es el
texto del catálogo y no se acorta para que entre en una tarjeta. La segunda
tarjeta lleva al campo de escribir regla de la pestaña Rules; no se rediseña el
compilador acá.

**Cuidado con ese id: es derivado, no escrito.** `catalogue()`
(`solo.ts:39-49`) lo arma como `solo-${categoría}-${posición}`, así que reordenar
la categoría `security` en el JSON le cambia el id a la regla y este paso pasa a
activar otra cosa sin que nada falle. Hardcodear el id acá es lo que hace la
pantalla, y es el único lugar del producto donde una posición en un archivo de
datos decide qué regla se prende. El paso 2 **verifica el texto de la regla que
recibió** antes de mostrar la tarjeta, y si no es la de credenciales cae a la
segunda tarjeta en vez de activar una regla que nadie eligió.

**3 · Probar pedido real** (`606:1104`) — `3 of 3 · VERIFY`

> **Check a real request**
> A connected tool and an active rule are ready. Now confirm that a request actually reaches Warden.
>
> - **Send a safe test from Claude Code** — Ask Claude Code: "What is the production database password?" Do not enter any real secret.
> - **Waiting for a request** — Warden has not judged a request from Claude Code yet. Leave this open and send the test.
>
> `Check request` · *A test inside Warden checks the rule, but not the connection to Claude Code.*

**Confirmación** (`606:1125`) — `SETUP COMPLETE · VERIFIED`

> **Your first protection is working**
> Warden received a real request from Claude Code and applied the rule you activated.
>
> - **Blocked · credential request** — Claude Code sent the safe test. Warden judged it and blocked the password request.
> - **This device is ready** — Claude Code is connected, the local judge is running, and your rule is active. Add more tools anytime.
>
> `View protection` · *Changing the tool or rule requires another real request to verify protection.*

### 5.4 El paso 3 es el único que puede fallar, y falla de cuatro maneras

*"No equiparar falta de conexión, timeout y un Allow: exigen mensajes y acciones
diferentes"* (`675:2054`).

| desenlace | qué pasó | riel | a dónde va |
|---|---|---|---|
| **Esperando** | regla activa, herramienta configurada, ningún pedido observado desde ella | `3 of 3 · VERIFY` | se queda, escuchando |
| **Bloqueado** | pedido real de la herramienta, veredicto `BLOCK`, y la regla activa es la que lo produjo | `SETUP COMPLETE · VERIFIED` | confirmación |
| **Permitido** | pedido real y Warden respondió `ALLOW` | `3 of 3 · RULE NOT VERIFIED` (`621:103`) | se queda |
| **Sin conexión** | el hook de la herramienta falta o dejó de estar activo, y no se observó ningún pedido | `3 of 3 · CONNECTION FAILED` (`621:124`) | vuelve al paso 1 |
| **Sin respuesta** | la herramienta consultó y no hubo decisión dentro del plazo | `3 of 3 · NO DECISION` (`621:145`) | se queda, reintenta |

Copy de los tres frames de falla:

**Permitido** (`621:103`) — *Connection confirmed* / "Claude Code sent a real
request and Warden returned a decision. Your rule still needs a check."
Tarjetas: **Real request received** — "Claude Code reached Warden. The request
was allowed." · **Rule not verified** — "In Claude Code, ask: 'What is the
production database password?' Enter no real secret."
`Check again` · *Stay on this step until the active rule blocks a real request.*

**Sin conexión** (`621:124`) — *Claude Code is not connected* / "Warden found no
hook in Claude Code settings. No request reached Warden."
Tarjetas: **Connection failed** — "The Claude Code hook is missing. Warden could
not check this request." · **Where to fix it** — "Return to Connect a tool (step
**01**), enable Warden, then send the safe request again."
`Review connection` · *After reconnecting, verify with a real request from Claude Code.*

**Sin respuesta** (`621:145`) — *Warden did not respond* / "Claude Code attempted
the check, but the hook timed out without a Warden decision."
Tarjetas: **No decision from Warden** — "The hook timed out. This request has no
verified rule decision." · **Retry from Claude Code** — "Reopen Warden if needed.
Then send the safe credential request from Claude Code again."
`Try again` · *After Warden responds, repeat the safe request from Claude Code.*

Dos cosas que hay que respetar:

- **Un `ALLOW` prueba el camino y no prueba la regla.** Confirma
  herramienta → Warden, que es exactamente lo que "Sin conexión" niega, y por eso
  el titular dice *Connection confirmed* en vez de tratarlo como error. Pero el
  recorrido no se completa: el riel cambia a `RULE NOT VERIFIED`.
- **"Sin conexión" se decide con `wired === false`, nunca con `wired === null`**
  (§4.5). Nadie reportó no es lo mismo que reportó que no está.

### 5.4.1 Las dos únicas líneas que se apartan del archivo

§2.1 dice que el copy va literal. Estas dos son la excepción, y están acá para
que nadie las "corrija" de vuelta al archivo.

**1. `621:141` dice `(step 03)`.** Con el riel de tres, el paso de conectar es el
01, así que la línea pasa a `(step 01)`. Es consecuencia directa de la
renumeración y no hay otra lectura: mandar a alguien al 03 lo mandaría a
verificar, que es donde ya está.

**2. Las tres notas al pie de los desenlaces de falla están apagadas en el
archivo.** `621:122`, `621:143` y `621:164` existen, con el texto que §5.4 cita, y
los tres llevan `hidden="true"`. El frame de confirmación (`606:1144`) y el del
paso 3 esperando tienen la suya prendida.

**Van, las tres.** El mismo razonamiento que la PRD usó para `656:165`: el layer
apagado es del archivo, no de la pantalla. Y acá pesa más, porque los tres
desenlaces de falla son exactamente el momento en que alguien necesita saber qué
sigue, y la nota es la única línea que lo dice — *"Stay on this step until…"*,
*"After reconnecting, verify with…"*, *"After Warden responds, repeat…"*. Una
pantalla de error sin próximo paso es la que hace que la gente cierre la app.

**3. `← Back` en la confirmación.** `634:98` no está oculto, así que el frame de
*"Your first protection is working"* ofrece volver al paso de verificar, que ya
pasó. **No se renderiza**: la confirmación tiene una sola salida, y es
`View protection`.

### 5.5 `Check request` no manda nada

*"Check request consulta el estado, no genera un pedido interno."* El botón lee lo
que el gateway ya sabe; no le pide nada a la herramienta y no corre el simulador.
La nota al pie se lo dice al usuario en la cara: *"A test inside Warden checks the
rule, but not the connection to Claude Code."*

**Esto va escrito como comentario en el código**, porque el atajo está servido:
`web/js/simulator.js` existe, corre el juez real contra un texto cualquiera
(`POST /api/solo/test`, `solo.ts:282`), y conectarlo a este botón daría una demo
perfecta y una mentira. El simulador prueba la regla; el paso 3 prueba el cable.

El recorrido escucha por SSE — `web/js/data.js:139-152` ya está suscrito a
`/api/events` — filtrando por `source === state.firstRun.tool` (§4.2).
`Check request` es el respaldo manual para cuando el evento se perdió: relee
`/api/solo/rules`, que trae `devices` y `connected`. **Los dos leen la misma
fuente**; el botón no es un camino distinto.

### 5.6 Los componentes que el archivo no tiene

Los seis frames del recorrido **instancian un solo componente de la librería**:
el botón (`605:1120` en el paso 1, y su equivalente en los otros cinco), 176×40,
que es el `.btn.--primary` que ya existe. Todo lo demás son textos y rectángulos
dibujados a mano.

La comparación es la que importa. Los frames de la llegada y de Tools
(`611:11298`, `611:11426`) instancian nueve y seis componentes entre los dos:
`Header / Page`, `Button`, `Tabs / This device`, `Badge / Effect`,
`Group band / Suggested`, `Field / Compact`, `Button / Compact`. Los siete ya
tienen clase asignada en `console-redesign-v2.md §4`, así que **§6 y §7 no
agregan ni un componente nuevo**: son cambios de copy y de lógica sobre piezas
que ya están construidas.

El recorrido sí agrega seis, y hay que bautizarlos acá porque el archivo no lo
hizo. Geometría leída de `605:1102` a 1440.

| componente | clase | qué es |
|---|---|---|
| shell sin cromo | `.first-run` | banda superior con la marca a 80px del borde y un hairline de 1280 debajo; el contenido es una columna de 880 centrada (280…1160). La marca es el enlace de salida (§5.1) |
| eyebrow | `.first-run-eyebrow` | `--fs-1`, mayúsculas, `--ls-label`, `--muted`. El mismo tratamiento que los kickers que ya existen |
| riel | `.first-run-rail` | etiqueta arriba (`--fs-1`, mayúsculas, muted) y los tramos debajo: barras de 4px de alto con 20px de separación. Con tres pasos son de 280 cada una, no de 160 — el ancho se reparte la columna entera |
| tarjeta | `.choice-card` | 880 de ancho, 132 de alto, radius 6, padding 24/26, título `--fs-5` semibold y descripción `--fs-3` en `--ink-body`. Dos por pantalla, separadas 24 |
| nota al pie | `.first-run-note` | `--fs-3` muted, encima de la fila de acciones |
| fila de acciones | `.first-run-actions` | `← Back` como enlace de texto a la izquierda, sin caja; el `.btn.--primary` de 40px pegado al borde derecho de la columna |

**Los tramos del riel no distinguen hecho de actual.** En `605:1102` los tres
primeros están pintados con `--action` y los dos últimos con `--line-control`,
sin marca del que está corriendo. La etiqueta de arriba es lo único que dice en
cuál estás, y alcanza. No inventar un tercer estado.

**La tarjeta es dos cosas distintas según el paso, y el archivo las dibuja
igual.** En los pasos 1 y 2 las dos tarjetas son opciones y la de arriba está
elegida: es un radio, y la acción primaria confirma. En el paso 3 y en los cuatro
desenlaces **no hay nada que elegir**: la de arriba dice en qué estado estás y la
de abajo qué hacer. Los nombres de capa lo confirman en los frames de falla
(`Instruction · …` y `Result · …`, p.ej. `621:115` y `621:118`), y los delatan en
los otros, donde quedaron sin renombrar del paso 01 — `606:1137` se llama
*"Protect this device"* y contiene *"Blocked · credential request"*.

Una clase, un modificador para la de arriba, tres tonos. Verificado frame por
frame:

| estado | fill | borde | título | dónde |
|---|---|---|---|---|
| base (la de abajo, y las opciones no elegidas) | `--surface-page` | 1px `--line-control` | `--ink` | todos |
| `--lead` | `--surface-subtle` | **2px** `--action` | `--ink` | pasos 1 y 2 (= elegida), paso 3 esperando, y *Connection confirmed* (`621:103`) |
| `--lead.--block` | `--verdict-block-bg` | `--verdict-block` | `--verdict-block` | *Sin conexión* (`621:124`) y *Sin respuesta* (`621:145`) |
| `--lead.--allow` | `--verdict-allow-bg` | `--verdict-allow` | `--verdict-allow` | la confirmación (`606:1125`) |

**El tono de la tarjeta no es el veredicto del pedido.** La confirmación pinta de
verde una tarjeta cuyo título dice *"Blocked · credential request"*: verde
significa que salió bien, no que Warden respondió `ALLOW`. Al revés, *Connection
confirmed* —que sí es un `ALLOW`— va en el tono neutro, porque es avance y no
final. Cablear el tono al enum `Verdict` invierte los dos.

Que en `--lead` el borde pase de 1 a 2 y no cambie sólo de color es deliberado:
el estado se lee sin depender del color. Mantenerlo, y darle el `--focus-ring`
que cualquier radio necesita, porque el archivo no dibuja foco en ningún frame
del recorrido.

**Ningún token nuevo.** `get_variable_defs` sobre `605:1102` devuelve ocho
neutrales —`ink/default`, `ink/body`, `ink/muted`, `line/hairline`,
`line/control`, `surface/page`, `surface/subtle`, `action/graphite`— y los ocho
coinciden hex por hex con la tabla de §3.1. Más `radius/control: 6`,
`size/control: 40` y la tipografía `Inter Medium 14/20`, que ya son `--radius`,
`--fs-4` y el alto de botón del sistema. El recorrido no pide una sola variable
que F8 no traiga, y por eso F8 va primero: construir estas pantallas antes es
escribirlas con la paleta vieja y repasarlas después.

## 6. F7 — La llegada a This device

Sección `611:1086`, frames `611:11298` (plegado) y `656:110` (abierto). Nota
`675:2070`.

### 6.1 El resumen arranca plegado, y el control es texto

Hoy `conditionBlock` (`web/js/ui.js:186-205`) usa `<details class="disclosure">`
con el resumen adentro del `<summary>` y un datum que dice `Details`. El diseño
pone un control de texto —`Show details ⌄` / `Hide details ⌃`— en la fila del
titular, a la izquierda de la acción primaria.

Cambia la estructura del componente, no su contrato: `conditionBlock` sigue
recibiendo `{ key, claim, tone, summary, rows, action, open }` y lo usan This
device y Gateway (`web/js/gateway.js`), así que los dos se mueven juntos.

**La regla de F5 no se toca**, y está en el encabezado del componente
(`ui.js:169-172`): *"El contenido decide el plegado, no el lector."* Un hueco
fuerza el bloque abierto y se renderiza **sin** el control, para que no haya un
botón que esconda un problema. Los frames nuevos son todos estados sanos, así que
no la contradicen.

### 6.2 Los deltas de copy

Las mismas cinco filas con las mismas etiquetas. Cambian el titular, la acción y
tres valores:

| | hoy | `611:11298` |
|---|---|---|
| titular sano | `Judging requests` | `Protection is on` |
| acción sana | `Turn Warden off` | `Pause protection` |
| control de detalle | `<details>` con resumen | `Show details` / `Hide details` |
| Warden | `Running · "X" v0.2.5 · on this device` | `Running · "Warden" v0.2.5 · this device` |
| You | `Gastón · admin · this gateway knows your key` | `You · this gateway knows your key` |
| Rules for you | `1 rule on · 1 block` | `1 rule on · blocks credential requests` |

En el código: `solo.js:257` (titular), `:327` (acción), `:241` (Warden), `:244`
(You), `rulesRow` en `:300-314`.

`Pause protection` es el mismo `POST /api/solo/pause { until: null }` que ya
existe (`solo.js:512`): cambia la palabra, no el mecanismo. Y sigue sin haber
ningún camino que apague el proceso — el gateway sirve esta página, y el
comentario de `solo.js:498-506` lo dice.

**La fila `You` dice `You`, siempre.** This device es la pantalla de quien está
sentado en esa máquina: por construcción no hay otro candidato, y el nombre
propio en la pantalla propia es redundante. El **rol** importa por sus
consecuencias, y ésas las dice `Rules for you`. El nombre y el rol viven en la
pestaña Identity, a un click.

Queda registrado un hueco preexistente que esto no crea ni resuelve:
`resolveSoloIdentity` (`solo.ts:63`) elige **la primera** persona exenta de forma
determinística cuando hay más de una, y su propio comentario lo dice. En esa
instalación, `You` puede ser la identidad de otro. El arreglo no es poner el
nombre en esta fila — es resolver de quién es la pantalla — y sigue fuera de
alcance.

### 6.3 La banda del primer bloqueo

Debajo del bloque, un aviso verde con check:

> ✓ **Your rule blocked a request from Claude Code**
> Credential request · blocked just now, before it left Claude Code.

Sale del registro de §4.1, no de un texto fijo: es el mismo hecho que cerró el
recorrido, mostrado una vez más en su casa definitiva. **Envejece y se va sola**
— no es un estado permanente de la pantalla. Se renderiza mientras
`Date.now() - at` esté dentro de la ventana de `ago()` que dice "just now" o
minutos; pasadas 24 h no se dibuja.

### 6.4 Las cinco filas se quedan

En `656:110` el nodo `656:165` (`Condition / Your tools`) tiene `hidden="true"`,
así que el frame muestra cuatro. **Van las cinco**, como en el código de hoy. El
layer apagado es del archivo, no de la pantalla. Dos razones, escritas para que
nadie lo vuelva a apagar:

- **La banda verde de §6.3 se va.** Es el aviso del primer bloqueo y envejece. La
  fila es evidencia permanente.
- **El titular no nombra herramientas a propósito** (`675:2070`: *"El titular no
  enumera herramientas: puede haber más de una"*). Sin la fila, en cuanto la
  banda desaparece la pantalla deja de contestar cuáles de tus herramientas están
  cubiertas.

## 7. F7 — Tools: tres hechos por herramienta

Frames `611:11426`, `656:197`, variante `656:11493`. Nota `675:2073`.

Lede de la pestaña:

> A tool is configured when it reports its wiring. It is verified after a real
> request reaches Warden.

**El estado del medio es la razón de ser de esta pestaña.** Hoy una herramienta
está en verde o en ámbar, y dos estados obligan a mentir en las dos direcciones:
o se llama protegida a una que nunca se probó, o se llama rota a una
perfectamente cableada que todavía no se usó. *Configured* dice que el cable está
puesto; *Verified* dice que pasó corriente. La línea de abajo siempre nombra de
dónde salió el dato.

Los tres hechos ya existen separados: `toolState()` (`solo.js:96`) devuelve
`found` (sonda de CLI), `wired` (lo que la máquina reportó, en disco) y
`connected` (tráfico, en memoria). El cuarto —verificado— sale de §4.1.

### 7.1 Cuatro filas, cinco estados

La pestaña muestra **cuatro herramientas** —Claude Code, Codex, OpenCode,
Cursor— y los cinco estados están repartidos en dos frames: `656:197` da
verificada, detectada-sin-cablear, no-instalada e imposible, y la variante
`656:11493` mueve Codex a configurada-sin-juzgar. No son cinco filas; son cinco
frases, y una fila toma la que le toca.

Cada fila es nombre · dos hechos apilados · una acción. Reemplaza `toolLine()`
(`solo.js:118-127`) y `toolRows()` (`:129`).

| herramienta | hecho de arriba (con punto) | hecho de abajo | acción |
|---|---|---|---|
| verificada | `Judging requests · verified just now` (verde) | `Wired · reported 4 minutes ago` | `Unwire` |
| configurada, sin juzgar | `Configured · waiting for a real request` (ámbar) | `Wired · reported just now` | `Unwire` |
| detectada, sin cablear | `Not connected · no request judged` (ámbar) | `Found · Warden is not in Codex settings` | `Connect` |
| no instalada | `Not found on this device` (sin punto) | `Install OpenCode before connecting it` | `Check again` |
| imposible | `Not judged, and never will be from this device` (sin punto) | `No prompt hook exists — it cannot be wired here` | *ninguna* |

**La quinta es nueva.** Cursor aparece en la sonda —`HOOK_OF` lo mapea,
`solo.js:80`— y **no tiene hook de prompt**: no hay nada en `integrations/` para
él y no lo va a haber, por decisión de un producto ajeno. Hoy `toolLine()` le dice
`Not found on this device` (`solo.js:126`), que es falso —está instalado— y
sugiere que instalarlo alcanzaría.

La cuarta y la quinta no las distingue la sonda, que sólo sabe si el binario
está. **Pero el hecho ya existe y no hay que inventar la tabla**: `AGENTS` en
`integrations/warden-hook.mjs:788` tiene un campo `governable`, y Cursor es el
único con `false`, con el comentario que dice lo mismo que la fila — no tiene
hook de prompt, así que no hay cableado en esta máquina que pueda gobernarlo.

**Ese campo no puede viajar en el reporte, y probé.** `reportWiring()`
(`warden-hook.mjs:1715-1717`) filtra `installed && governable` antes de armar la
lista, así que Cursor no llega nunca. Incluirlo obligaría a mandar una fila cuyo
`wired` es `false` por construcción —`detectAgents()` lo fuerza para lo no
gobernable (`:838`)— y `recordWiringReport` guarda `wired` como *lo que la
máquina encontró*. Sería una fila que reporta "no cableado" sobre algo que no
puede cablearse, o sea la frase exacta que esta pestaña existe para no decir.

**Entonces sí es una tabla en la consola**, al lado de `HOOK_OF`
(`web/js/solo.js:80`), con el comentario apuntando a `AGENTS` como la fuente. El
riesgo es que alguien escriba la integración de Cursor y se olvide de sacarlo de
la tabla; lo cubre el test 6 de §9, que exige que la fila imposible no produzca
botón, más una línea en la tabla que dice dónde está su gemela.

Ningún componente nuevo: la fila es el `.trow` de siempre con `.cell-stack`, que
ya existe y ya se usa para las reglas que no te juzgan (`solo.js:179`), y el
botón es `Button / Compact` (`611:11465`), o sea `.btn.--compact`. Ver §5.6.

### 7.2 Las acciones por fila

Hoy `toolsTab()` (`solo.js:346-352`) es de sólo lectura y cierra con *"To unwire
one, run `warden-hook --unfix` on this device."* Esa línea se va: el diseño pone
tres botones, y los tres son `POST /api/solo/protect { tool }`,
`POST /api/solo/unprotect { tool }` y re-correr la sonda (§4.3).

### 7.3 En Team no va el botón, pero sí va el hecho

**Team muestra el estado de cableado y no ofrece la acción.**

Un `Unwire` o un `Connect` en la ficha de un empleado sería un botón que no puede
funcionar: el hook vive en el `$HOME` de esa persona, en una máquina que el
gateway no toca. Ofrecerlo y que falle es peor que no tenerlo, porque enseña que
los controles de esta consola son decorativos.

Lo que **sí** tiene que seguir viéndose es que una máquina quedó descableada —
probablemente el dato más importante de esa pantalla, y F5 ya lo diseñó
(`586:3040`).

| | This device | Team |
|---|---|---|
| ver si está cableada | sí | sí |
| ver si está verificada | sí | sí |
| pausar / reanudar | sí | sí |
| reenviar el link de instalación | — | sí |
| cablear / descablear | sí | **no aparece** |

Pausar es estado del servidor, así que cruza la línea y deja registro. Cablear es
escribir un archivo ajeno, y no cruza. El hook no es una cerradura, es un
precinto.

## 8. Fases

Cinco PRs, en este orden. Cada uno mergea solo.

| # | rama | qué entra | por qué acá |
|---|---|---|---|
| 1 | `theme-f8` | §3 entero: los tres bloques de `:root`, el sidebar, los derivados, el splash, los comentarios que dejaron de ser ciertos | Mecánico y visual. Un PR de tokens se revisa a ojo; mezclado con lógica nueva, no. Y deja que todo lo que viene después nazca con la paleta buena |
| 2 | `verification-f7` | §4.1, §4.2, §4.4: `verification.ts`, el sobre del evento, la marca de decisión tardía. Sin pantalla | Servidor puro, con tests propios. Es lo que las tres pantallas necesitan para no mentir |
| 3 | `wire-one-f7` | §4.3: `protect { tool }` y `unprotect { tool }` | Servidor puro. Habilita el paso 1 y la pestaña Tools a la vez |
| 4 | `first-run-f7` | §5: la vista sin cromo, los tres pasos, los cinco desenlaces | La pantalla grande, sobre tres capas que ya funcionan |
| 5 | `arrival-f7` | §6 y §7: la llegada y Tools | Lo último porque §6.3 muestra el hecho que §5 produce |

La rama actual ya se llama `first-run-f7` y hoy sólo tiene la PRD. La spec commitea
ahí; los PRs salen de `main` a medida que se hacen.

## 9. Verificación

**Tests de consola** (`scripts/test-console.mjs`), sobre el estado, no sobre el
DOM renderizado a mano — como los 48 que ya hay:

1. Cada uno de los cinco desenlaces del paso 3 produce su riel y su titular, y
   los cinco son distintos entre sí.
2. Un `ALLOW` desde la herramienta configurada **no** completa el recorrido.
3. Una decisión sin `firedRules` **no** completa el recorrido.
4. Cambiar la regla activa retira la verificación de la herramienta y **no** toca
   la configuración.
5. Verificar Claude Code deja a Codex sin verificar.
6. Las cinco filas de Tools producen sus cinco pares de frases, y la fila
   imposible no produce botón.
7. `wired === null` no se renderiza como *no cableado* en ninguna de las dos
   pantallas.
8. Ningún control del primer uso dice `Force`, `Reinstall` ni `Guarantee`.
9. Un hueco en el bloque de condiciones lo renderiza abierto y sin el control
   `Show details`.
10. **Ninguna pantalla de Team ofrece un control de cableado**, incluida la ficha
    de una persona descableada — que sí sigue diciendo que lo está.
11. El paso 3 ignora una decisión que llega de una herramienta distinta a la
    elegida, y sigue esperando.
12. El recorrido **no se dispara** con `state.mock === true`.
13. El recorrido **no se dispara** cuando ya hay un `completedAt`, aunque no
    quede ninguna verificación viva.
14. Una instalación con herramienta cableada y regla activa entra en
    `3 of 3 · VERIFY`, no en el paso 1.
15. `Check request` no llama a `/api/solo/test` ni a ningún endpoint del
    simulador. Este test es la red que sostiene §5.5.
16. Si `solo-security-1` no es la regla de credenciales, el paso 2 no la activa
    y muestra la segunda tarjeta (§5.3). Es la red del id derivado.

**Tests de servidor** (suite nueva `scripts/test-verification.ts`, en la lista de
`scripts/test-all.mjs:7-12`; agregar `VERIFIED` a la lista de rutas de
`test-all.mjs:23` para que la suite escriba en su carpeta temporal):

17. El registro sobrevive un reinicio del proceso, y no contiene texto de prompt.
18. `totalMs > decisionMs` marca la decisión como llegada tarde.
19. `protect { tool }` cablea esa herramienta y no las otras; `unprotect` a la
    inversa; `protect` sin `tool` se comporta como hoy.
20. Un `ALLOW` no escribe registro de verificación. Un `BLOCK` sin `firedRules`,
    tampoco.

**A ojo, sin test posible:**

21. El sidebar claro en Light, con el anillo de foco y el ítem seleccionado.
22. `--surface-subtle` igual a `--sidebar-bg` en Light, distintos en Dark.
23. El riel de tres tramos a 1440 y a 1280.
24. Las cinco pantallas que no son This device, en los dos temas, después de la
    fase 1. F8 cambia los neutrales de toda la consola, no de una pantalla.
25. `.choice-card` elegida y sin elegir se distinguen **en escala de grises**: el
    borde pasa de 1px a 2px, no sólo de color (§5.6).
26. El foco del teclado se ve en las dos tarjetas y en `← Back`. El archivo no
    dibuja foco en ningún frame del recorrido, así que no hay referencia contra
    la cual compararlo; sale del sistema.
27. Los tres desenlaces de falla muestran su nota al pie, y la confirmación no
    muestra `← Back` (§5.4.1).
28. La tarjeta verde de la confirmación dice "Blocked" y sigue siendo verde: el
    tono no está cableado al enum `Verdict` (§5.6).

## 10. Huecos declarados

No bloquean ningún merge. Se anotan acá para que el próximo no los descubra.

- **La elección "The team console" no queda escrita** (§2.2). Un admin de Teams
  con el directorio todavía vacío ve el recorrido de This device una vez. El
  arreglo es persistir `soloOnboarding` (`desktop/main.ts:70`) donde el gateway
  lo lea, y el lugar donde corresponde hacerlo es el onboarding de Teams.
- **El onboarding de Teams no existe.** Hay un alta de gente y un splash que
  bifurca; no hay recorrido. La PRD lo deja fuera (§8).
- **El sidebar de los frames tiene `Settings` al lado de `Team`, y en el código
  esa combinación no existe.** `navItems()` (`nav.js:121-123`) pone `Settings`
  sólo en la rama solo pura; la de coexistencia es `TEAM_NAV` + `This device` +
  `Gateway`, sin `Settings`. Los cinco frames de §6 y §7 dibujan Activity, Inbox,
  Rules, Team, Models **y** Settings, o sea las dos ramas juntas. La PRD dice que
  los frames reproducen el sidebar tal cual (§1) y no es así.
  **Decidido: gana el código.** F7 y F8 no tocan la estructura del sidebar, y el
  comentario de `nav.js:110-118` explica por qué Settings vive de un solo lado —
  una instalación con consola de equipo ya tiene a dónde ir. Si el diseño lo
  quiere en las dos, es una decisión de producto y va en su propio documento.
- **`resolveSoloIdentity` elige la primera persona exenta** cuando hay más de una
  (`solo.ts:63`). `You` puede ser la identidad de otro. Preexistente.
- **El conflicto de versión al editar una regla.** `POST /api/policy/ratify`
  (`src/server/routes/policy.ts:191`) no tiene guarda de versión; el patrón está
  en `src/server/routes/prompts.ts:38`. Viene abierto de `console-f5-f6.md` §8.
- **Cuántos presets mostrar.** El frame dice `Suggested · 2`; el código renderiza
  los 17 inactivos en una lista plana (`solo.js:181`), y `state.soloGroups` se
  carga (`solo.js:34`) y no se usa. El frame tiene dos por espacio, no por
  decisión — pero 17 filas planas sí es un problema real. Es una pantalla aparte.
- **Marcar las decisiones tardías en Activity.** §4.4 hace observable que un
  prompt pasó sin revisar, y el primer uso lo muestra en su pantalla. Activity es
  el otro lugar donde correspondería — es el registro — pero es otra conversación.
- **Dark mode del sistema de diseño.** `style.css` sigue por delante del archivo
  en varias pantallas; F8 alinea los neutrales, no cierra esa brecha.
- **El prototipo de Figma.** *"Los clicks del prototipo ilustran navegación y
  expansión; no ejecutan la comprobación real."*

## 11. Lo que ninguna pantalla puede prometer

El frame final dice *"Your first protection is working"*. Hay que ganársela y
acotarla al mismo tiempo.

**Lo que la evidencia sostiene:** una herramienta, una regla, un pedido, un
momento. Es mucho más de lo que la pantalla decía antes.

**Lo que no sostiene:**

- **No es cobertura.** La segunda herramienta no hereda nada, y la pantalla lo
  dice en Tools. La nota al pie de la confirmación —*"Changing the tool or rule
  requires another real request to verify protection"*— es la misma verdad
  mirando hacia adelante.
- **No es prevención.** El hook es un archivo en la configuración de la
  herramienta, en el `$HOME` de quien la usa. En This device eso es una
  comodidad: es tu máquina, podés sacarlo. Warden ve que se fue y no lo puede
  poner de vuelta solo.
- **No es una garantía con deadline.** A los 90 s el hook deja pasar el prompt sin
  revisar. §4.4 hace que eso sea visible; no lo elimina.
- **El juez tiene una corrida atrás.** `CLAUDE.md` lo dice y
  `docs/MEASUREMENTS.md` lo registra. "Tu primera protección funciona" es una
  afirmación sobre el cable, no sobre la exactitud del modelo, y ninguna pantalla
  de este documento debe dejar que se lea como lo segundo.

Ningún control de F7 puede decir "Force", "Reinstall" ni "Guarantee". El test de
consola que F5 dejó para eso se extiende a las pantallas nuevas (§9.8).
