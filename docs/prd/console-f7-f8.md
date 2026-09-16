# El primer uso de This device, y el tema nuevo — PRD

Continúa `docs/prd/console-f5-f6.md`. F5 le dio a This device un bloque de
condiciones honesto y separó cableado de tráfico; F6 le dio una sola casa a la
clave. Las dos suponen algo que nunca construimos: **que alguien ya llegó hasta
acá**. No hay primer uso. La pantalla asume un modelo bajado, una herramienta
cableada y una regla escrita, y si falta cualquiera de las tres contesta con un
hueco ámbar y un botón.

Este documento define **F7** (el primer uso de This device y la llegada después
de él) y **F8** (el tema: los neutrales cambian, los veredictos no). F7 y F8 son
numeración de esta serie, no secciones de `docs/specs/wiring-and-unwiring.md`.

Referencias `archivo:línea` al repo al 2026-09-16, `main` en `1e76144` (F5 y F6
ya mergeados, PR #43). Archivo de diseño: `RFPKLtSSZjQMHy9XaOOSqp`, página
**06 · This device** (`298:1989`).

Las dos secciones nuevas de esa página traen su propia especificación escrita
dentro del archivo — `675:2054` y `675:2068` — y este documento no las
reinterpreta: las cita y las traduce a endpoints, estado y tests.

## 0. Por qué existe este documento

**Porque la sección `01A` del archivo llama "Actual" a lo que F5 construyó y
propone cambiarlo.** El frame `611:11170` es un facsímil de la llegada que
renderiza `web/js/solo.js` hoy, puesto al lado de `611:11298` para compararlos.
Eso no es un detalle de nomenclatura: significa que la pantalla que acabamos de
escribir es el punto de partida del diseño nuevo, no su resultado.

Tres cosas están mal hoy, y ninguna es un bug:

1. **No hay camino de entrada.** Alguien que instala Warden en su máquina cae en
   una pantalla de estado que le dice, en ámbar, todo lo que le falta. El orden
   —modelo, herramienta, regla, pedido— es el orden correcto, y la pantalla lo
   comunica como una lista de defectos en vez de como un recorrido. La sección
   descartada `99` del archivo dice por qué no alcanzaba con pegarle un asistente
   encima: *"un asistente pegado encima de una pantalla de estado: dos objetos
   peleando, uno que vive y otro que se muere — y lo que el setup te enseñó se
   muere con él"*.

2. **"Protegido" todavía se puede afirmar sin evidencia.** F5 arregló lo peor
   —definir protección como tráfico visto— separando cableado de tráfico. Pero
   quedó del otro lado: hoy una máquina con el hook escrito, el modelo bajado y
   una regla prendida dice *"Judging requests"* en verde **sin que ningún pedido
   real haya sido juzgado nunca**. Es más honesto que antes y sigue sin ser la
   verdad. La nota `675:2054` la define: la protección está verificada cuando
   existe **un pedido real originado en la herramienta configurada Y una decisión
   de Warden asociada a la regla activa**, y nada más cuenta.

3. **El tema cambió y el código no.** `web/style.css:63` dice
   `/* sidebar — invariant: the same values in light and dark */`. Dejó de serlo:
   el sidebar ahora es claro en light (`#F4F5F4`) y oscuro en dark (`#202020`), y
   con él se movió toda la paleta neutral de azulada a verde-gris.

## 1. Lo que ya existe y no se toca

- **El pipeline del guard.** Nada de acá agrega un camino donde la respuesta de
  un modelo despeje un pedido. El primer uso *muestra* una decisión; no la
  produce, no la simula y no la fabrica.
- **`exemptRoles` y `admin-auth.ts`.** No se agrega una segunda noción de admin.
  Todo lo nuevo de This device cae bajo la identidad que `/api/solo/*` ya
  resuelve.
- **El audit log guarda hashes, nunca texto de prompts.** El registro de
  verificación que propone §6.1 guarda el `auditId`, la herramienta, el veredicto
  y las reglas que dispararon. No guarda el prompt, ni su versión enmascarada.
- **El sidebar como estructura.** `web/js/nav.js` ya tiene los tres grupos
  (`Overview` / `Manage` / `Local`), los iconos por ítem y el único contador que
  sobrevive (Inbox). Los frames nuevos lo reproducen tal cual. Lo único que
  cambia en el sidebar es el color, y eso es F8.
- **La pestaña Identity.** Las dos notas de implementación se titulan
  *"(sin Identity)"* a propósito. Queda como la escribió F5.
- **El compilador, las reglas y el catálogo de presets.** El primer uso no
  inventa reglas: activa `solo-security-1`, que ya existe en
  `data/seed/presets.json`.

## 2. F7 — El primer uso

Sección de diseño `603:1080`. Especificación dentro del archivo: `675:2054`.

### 2.1 El shell

Los seis frames no tienen sidebar. Es una pantalla completa con la marca
`warden` arriba a la izquierda, un eyebrow `THIS DEVICE · FIRST RUN`, título,
bajada, un riel de cinco tramos, dos tarjetas, la acción primaria abajo a la
derecha y una nota al pie. Desde el paso 02 aparece `Back to previous step` al
pie, a la izquierda.

Eso es una vista nueva del router, no una pantalla dentro de `soloRules`. El
shell actual (`web/index.html` + `renderNav`) siempre dibuja el sidebar; hace
falta un layout sin cromo. Mantenerlo como vista del mismo router —no una página
aparte— para que `go()` y el hash sigan siendo la única forma de navegar.

El riel dice `1 of 5` … `5 of 5` y después `SETUP COMPLETE · VERIFIED`. **Son
cinco pasos y una confirmación, no seis pasos.** El frame `606:1125` es el
desenlace del 05, no un 06.

### 2.2 Los cinco pasos

Copy exacto de los frames. El título de cada tarjeta y su bajada van literales;
el texto suelto al pie es la nota al pie de esa pantalla.

**01 · Elegir objetivo** (`604:1080`) — `1 of 5 · CHOOSE A GOAL`
> **What do you want Warden to protect?**
> Start with one goal. You can add team management later without losing this setup.
>
> - **Protect this device** — Connect your AI tool, choose a rule, then check a real request from this computer.
> - **Protect a team** — Set up a gateway, give each employee their own connection, and check who is protected.
>
> `Continue` · *Your choice changes the setup path, not what Warden can do later.*

La rama "Protect a team" sale de este documento: lleva al alta de gente, que ya
existe. Lo único que F7 le debe es no romperla.

**02 · Preparar Warden** (`605:1081`) — `2 of 5 · PREPARE WARDEN`
> **Get the local judge ready**
> Warden needs a local model to judge requests. Download it once before you rely on protection.
>
> - **Download the local judge** — Qwen3 · about 4.3 GB. Stored on this computer; your prompts stay here.
> - **Explore in demo mode** — Look around with sample decisions. Demo mode does not protect any request.
>
> `Download models` · *You can resume the download if it is interrupted.*

La segunda tarjeta es el modo mock que ya existe (`state.mock`, `canLeaveDemo`).
La frase *"Demo mode does not protect any request"* es la misma verdad que el
bloque de condiciones dice en ámbar; acá se dice antes de que cueste algo.

**03 · Conectar herramienta** (`605:1102`) — `3 of 5 · CONNECT A TOOL`
> **Connect the tool you use first**
> Warden found these tools on this computer. Pick one to connect now; you can add more later.
>
> - **Claude Code · found** — Add Warden to Claude Code so requests are checked before they leave this computer.
> - **Codex · found** — You can connect Codex after your first protection is working.
>
> `Connect tool` · *Warden will show what it changed and whether the tool reported back.*

La lista sale de la sonda de CLI que ya alimenta `toolState()`
(`web/js/solo.js:96`, `state.compiler.cliTools`). El sufijo `· found` es el
estado de esa sonda, no del cableado.

**04 · Primera regla** (`606:1083`) — `4 of 5 · ACTIVATE A RULE`
> **Choose your first rule**
> Claude Code is connected. Choose what Warden should stop before testing it.
>
> - **Block credential requests** — Warden blocks requests for API keys, tokens and passwords. This rule applies to you.
> - **Write a different rule** — Describe what you want to protect in your own words and review it before activation.
>
> `Activate rule` · *Suggested rules are ready to use. You can edit your protection later.*

La primera tarjeta activa `solo-security-1`. El texto de la tarjeta es un
resumen de la regla, **no la regla**: el texto que lee el juez es el del
catálogo y no se acorta para que entre en una tarjeta.

**05 · Probar pedido real** (`606:1104`) — `5 of 5 · VERIFY`
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

### 2.3 El paso 05 es el único que puede fallar, y falla de cuatro maneras

Esto es el corazón del flujo y la razón de que existan tres frames más. La nota
`675:2054` lo dice sin margen: *"No equiparar falta de conexión, timeout y un
Allow: exigen mensajes y acciones diferentes."*

| desenlace | qué pasó | riel | a dónde va |
|---|---|---|---|
| **Esperando** | regla activa, herramienta configurada, ningún pedido observado desde ella | `5 of 5 · VERIFY` | se queda, escuchando |
| **Bloqueado** | llegó un pedido real de la herramienta, Warden decidió `BLOCK`, y la regla activa es la que produjo el bloqueo | `SETUP COMPLETE · VERIFIED` | confirmación |
| **Permitido** | llegó un pedido real y Warden respondió `ALLOW` | `5 of 5 · RULE NOT VERIFIED` (`621:103`) | se queda |
| **Sin conexión** | el diagnóstico dice que el hook de la herramienta falta o dejó de estar activo, y no se observó ningún pedido | `5 of 5 · CONNECTION FAILED` (`621:124`) | vuelve al 03 |
| **Sin respuesta** | la herramienta consultó y no hubo decisión de Warden dentro del plazo | `5 of 5 · NO DECISION` (`621:145`) | se queda, reintenta |

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
03), enable Warden, then send the safe request again."
`Review connection` · *After reconnecting, verify with a real request from Claude Code.*

**Sin respuesta** (`621:145`) — *Warden did not respond* / "Claude Code attempted
the check, but the hook timed out without a Warden decision."
Tarjetas: **No decision from Warden** — "The hook timed out. This request has no
verified rule decision." · **Retry from Claude Code** — "Reopen Warden if needed.
Then send the safe credential request from Claude Code again."
`Try again` · *After Warden responds, repeat the safe request from Claude Code.*

Lo importante de "Permitido": **un `ALLOW` prueba el camino y no prueba la
regla.** Confirma herramienta → Warden, que es exactamente lo que "Sin conexión"
niega, y por eso el titular dice *Connection confirmed* en vez de tratarlo como
un error. Pero el flujo no se completa: el riel cambia de `VERIFY` a
`RULE NOT VERIFIED` y pide una solicitud que sí active la regla.

### 2.4 "Check request" no manda nada

*"Check request consulta el estado, no genera un pedido interno."* El botón lee
lo que el gateway ya sabe; no le pide nada a la herramienta y no corre el
simulador. La nota al pie del frame lo dice a la cara del usuario: *"A test
inside Warden checks the rule, but not the connection to Claude Code."*

Esto hay que escribirlo en el código como comentario, porque el atajo está
servido: `web/js/simulator.js` existe, corre el juez real contra un texto
cualquiera, y conectarlo a este botón daría una demo perfecta y una mentira. El
simulador prueba la regla; el paso 05 prueba el cable.

El flujo escucha por SSE (`/api/events`, al que `web/js/data.js:141` ya está
suscrito) y `Check request` es el respaldo manual para cuando el evento se
perdió. Los dos leen la misma fuente.

### 2.5 Qué es "verificado", y qué lo retira

Condición de finalización, literal de `675:2054`:

> Completar solo si existe evidencia de un pedido real originado en la
> herramienta configurada **Y** una decisión de Warden asociada a la regla
> activa. Para el recorrido diseñado, la evidencia final es Block por la regla
> de credenciales.
>
> No completar por conexión reportada, prueba interna del motor, llegada de un
> pedido permitido ni por un intento sin decisión.

Y de `675:2068`, lo que la retira:

> Si el usuario cambia la regla o reconecta una herramienta, conservar la
> configuración, pero retirar la verificación afectada hasta observar otro
> pedido real y su decisión. Los estados se derivan de eventos de integración y
> decisión; no inferirlos por haber abierto una pestaña ni por una prueba
> interna.

La verificación es **por herramienta**, no por máquina: *"Una segunda herramienta
no hereda la verificación de la primera."*

### 2.6 Cuándo aparece el flujo, y cuándo no vuelve

- **Entra** una instalación que nunca lo completó. El haberlo completado es un
  hecho durable (§6.1), no una cuenta de reglas ni de herramientas.
- **El paso dentro del flujo se deriva de los hechos**, no de un cursor
  guardado: si el modelo ya está bajado, el 02 ya está hecho. Guardar en qué
  paso quedó alguien es guardar una copia de algo que el servidor ya sabe, y las
  dos se desincronizan.
- **No vuelve a entrar nunca más.** Retirar una verificación (§2.5) cambia lo
  que dice This device; no reabre el onboarding. Alguien que descablea una
  herramienta en marzo no tiene que volver a pasar por el alta.
- **`View protection`** cierra el flujo y abre This device en la pestaña Rules.

## 3. F7 — La llegada a This device

Sección `611:1086`. Frames `611:11298` (plegado) y `656:110` (abierto).
Especificación: `675:2070`.

> Abrir la pestaña Rules tras la primera decisión Block verificada. El resumen
> superior empieza contraído con "Protection is on"; Show details lo expande y
> Hide details lo contrae sin alterar la protección. El aviso de bloqueo
> reciente usa el pedido real verificado. **El titular no enumera herramientas:
> puede haber más de una.**

### 3.1 El resumen arranca plegado, y el control es texto

Hoy `conditionBlock` (`web/js/ui.js`) usa `<details class="disclosure">` con el
resumen adentro. El diseño pone un control de texto —`Show details ⌄` /
`Hide details ⌃`— en la fila del titular, a la izquierda de la acción primaria.

La regla que F5 estableció **no se toca**: un hueco fuerza el bloque abierto y
se renderiza *sin* el control, para que no haya un botón que esconda un
problema. Los frames nuevos son todos estados sanos, así que no la contradicen;
hay que mantenerla igual.

### 3.2 Los deltas de copy contra lo que construimos

El bloque de condiciones de F5 y el del diseño tienen las mismas cinco filas con
las mismas etiquetas. Cambian el titular, la acción y tres valores:

| | F5, hoy | `611:11298` |
|---|---|---|
| titular sano | `Judging requests` | `Protection is on` |
| acción sana | `Turn Warden off` | `Pause protection` |
| control de detalle | `<details>` con resumen | `Show details` / `Hide details` |
| Warden | `Running · "X" v0.2.5 · on this device` | `Running · "Warden" v0.2.5 · this device` |
| You | `Gastón · admin · this gateway knows your key` | `You · this gateway knows your key` |
| Rules for you | `1 rule on · 1 block` | `1 rule on · blocks credential requests` |

`Pause protection` es el mismo `POST /api/solo/pause {until:null}` que F5 ya
escribió; cambia la palabra, no el mecanismo. Y sigue sin haber ningún camino
que apague el proceso: el gateway sirve esta página.

**La fila `You` dice `You`, siempre.** This device es la pantalla de quien está
sentado en esa máquina: por construcción no hay otro candidato, y el nombre
propio en la pantalla propia es redundante. Team es la otra mitad del producto y
ahí sí todo el mundo tiene nombre.

Lo que el nombre parecía aportar ya está mejor puesto en otro lado. El **rol**
importa por sus consecuencias, y ésas las dice `Rules for you` — *"tu rol está
exento de las reglas de la empresa, así que nada te juzga"* es una frase sobre
el rol sin nombrarlo. El nombre y el rol en sí viven en la pestaña Identity, a
un click. Esta fila sólo tiene que decir que el gateway te reconoce.

Queda registrado un hueco preexistente que esto no crea ni resuelve:
`resolveSoloIdentity` (`src/server/routes/solo.ts:63`) elige **la primera**
persona exenta de forma determinística cuando hay más de una, y su propio
comentario lo dice. En esa instalación, `You` puede ser la identidad de otro. El
arreglo no es poner el nombre en esta fila —es resolver de quién es la
pantalla— y sigue fuera de alcance.

### 3.3 La banda del primer bloqueo

Debajo del bloque, un aviso verde con check:

> ✓ **Your rule blocked a request from Claude Code**
> Credential request · blocked just now, before it left Claude Code.

Sale del pedido verificado real (§6.1), no de un texto fijo. Es el mismo hecho
que cerró el onboarding, mostrado una vez más en su casa definitiva. Se va sola
cuando envejece — no es un estado permanente de la pantalla.

### 3.4 Las cinco filas se quedan

En `656:110` el nodo `656:165` (`Condition / Your tools`) tiene
`hidden="true"`, así que el frame muestra cuatro. **Decidido: van las cinco**,
como en el código de F5. El layer apagado es del archivo, no de la pantalla.

Las dos razones, para que nadie lo vuelva a apagar más adelante:

- **La banda verde de §3.3 se va.** Es el aviso del primer bloqueo y envejece.
  La fila es evidencia permanente.
- **El titular no nombra herramientas a propósito** (`675:2070`: *"El titular no
  enumera herramientas: puede haber más de una"*). Sin la fila, en cuanto la
  banda desaparece la pantalla deja de contestar cuáles de tus herramientas
  están cubiertas, y esa pregunta se va entera a la pestaña Tools.

## 4. F7 — Tools: tres hechos por herramienta

Frames `611:11426`, `656:197` y la variante `656:11493`. Especificación
`675:2073`:

> Mostrar por separado si una herramienta fue **detectada**, **configurada** y
> **verificada**. "Configured/Wired" significa que la integración reporta su
> instalación; "Verified/Judging requests" requiere al menos un pedido real que
> Warden haya decidido desde esa herramienta.

Los tres hechos ya existen separados en el código: `toolState()`
(`web/js/solo.js:96`) devuelve `found` (sonda de CLI), `wired` (lo que la
máquina reportó, en disco, F3) y `connected` (tráfico, en memoria). Lo que
falta es la pantalla, y el cuarto estado.

Lede de la pestaña:
> A tool is configured when it reports its wiring. It is verified after a real
> request reaches Warden.

**El estado del medio es la razón de ser de esta pestaña.** Hoy una herramienta
está en verde o en ámbar, y dos estados obligan a mentir en las dos direcciones:
o se llama protegida a una que nunca se probó, o se llama rota a una
perfectamente cableada que todavía no se usó. *Configured* dice que el cable
está puesto; *Verified* dice que pasó corriente por el cable. La línea de abajo
siempre nombra de dónde salió el dato, para que nadie tenga que confiar en la
palabra de la pantalla.

### 4.1 Las cinco filas

Cada fila es nombre · dos hechos apilados · una acción.

| herramienta | hecho de arriba (con punto) | hecho de abajo | acción |
|---|---|---|---|
| verificada | `Judging requests · verified just now` (verde) | `Wired · reported 4 minutes ago` | `Unwire` |
| configurada, sin juzgar | `Configured · waiting for a real request` (ámbar) | `Wired · reported just now` | `Unwire` |
| detectada, sin cablear | `Not connected · no request judged` (ámbar) | `Found · Warden is not in Codex settings` | `Connect` |
| no instalada | `Not found on this device` (sin punto) | `Install OpenCode before connecting it` | `Check again` |
| imposible | `Not judged, and never will be from this device` (sin punto) | `No prompt hook exists — it cannot be wired here` | *ninguna* |

La quinta es nueva y es la mejor frase de la pantalla. Cursor aparece en la
sonda (`HOOK_OF` en `web/js/solo.js:80` lo mapea) y **no tiene hook de prompt**:
no hay nada en `integrations/` para él y no lo va a haber por decisión del
producto ajeno. Hoy `toolLine()` le dice `Not found on this device`, que es
falso —está instalado— y además sugiere que instalarlo alcanzaría. Una
herramienta estructuralmente incableable necesita decirlo y no ofrecer botón.

La cuarta y la quinta se distinguen por una tabla en el código, no por la sonda:
la sonda sólo sabe si el binario está. Que exista integración es un hecho del
repo.

### 4.2 Las acciones por fila no existen todavía

Hoy `toolsTab()` (`web/js/solo.js:346`) es de sólo lectura y cierra con *"To
unwire one, run `warden-hook --unfix` on this device."* El diseño pone tres
botones. Los tres son código nuevo (§6.3), y hay una razón por la que en This
device se puede y en Team no:

**En This device el gateway corre en la misma máquina que la herramienta.** Es
la máquina de quien la usa, y quien la usa es admin de su propia computadora —
que es exactamente el modelo de permisos que fijó F5, visto desde el otro lado.
`POST /api/solo/protect` ya escribe archivos en este `$HOME`. Escribir uno menos
es la misma operación.

Eso **no** se extiende a Team. Que Warden pueda descablear tu máquina no
significa que pueda cablear la de un empleado, y la frase de F5 sigue en pie:
el hook no es una cerradura, es un precinto.

### 4.3 En Team no va el botón, pero sí va el hecho

Decisión tomada: **Team muestra el estado de cableado y no ofrece la acción.**

Un `Unwire` o un `Connect` en la ficha de un empleado sería un botón que no
puede funcionar. El hook vive en el `$HOME` de esa persona, en una máquina que
el gateway no toca; ofrecerlo y que falle es peor que no tenerlo, porque enseña
que los controles de esta consola son decorativos.

Lo que **sí** tiene que seguir viéndose es que una máquina quedó descableada.
Probablemente sea el dato más importante de esa pantalla —alguien que tenía
Warden y lo sacó— y F5 ya lo diseñó (`586:3040`). Lo que cambia no es el hecho
sino el repertorio de respuestas que la pantalla ofrece.

| | This device | Team |
|---|---|---|
| ver si está cableada | sí | sí |
| ver si está verificada | sí | sí |
| pausar / reanudar | sí | sí |
| reenviar el link de instalación | — | sí |
| cablear / descablear | sí | **no aparece** |

Pausar es estado del servidor, así que cruza la línea sin problema y deja
registro. Cablear es escribir un archivo ajeno, y no cruza.

## 5. F8 — El tema

Especificación `677:2054`. Colección Figma **"Warden · Sistema"**, modo Light
(paleta *Intermedio*) y modo Dark (paleta *Charcoal*).

> El rediseño cambia los neutrales, no el significado de los estados.

### 5.1 La tabla

Light / Dark. A la izquierda el token de `web/style.css`, a la derecha el nombre
de Figma cuando difiere.

**Neutrales** — todos cambian:

| token CSS | Light | Dark |
|---|---|---|
| `--ink` (ink/default) | `#17181C` → **`#22282A`** | `#E9EAED` → **`#F3F3F1`** |
| `--ink-body` | `#44474E` → **`#444D4F`** | `#C2C5CB` → **`#CCCCCA`** |
| `--muted` (ink/muted) | `#70747C` → **`#656E6F`** | `#878C96` → **`#9E9E99`** |
| `--surface-page` | `#FFFFFF` (igual) | `#16181D` → **`#171717`** |
| `--surface-subtle` | `#F5F5F7` → **`#F4F5F4`** | `#21242B` → **`#242424`** |
| `--surface-raised` | `#FFFFFF` (igual) | `#1D2026` → **`#292929`** |
| `--surface-disabled` | `#F0F0F2` → **`#ECEEEC`** | `#1C1F24` → **`#202020`** |
| `--line-hairline` | `#EAEAED` → **`#E7EAE8`** | `#262A31` → **`#353535`** |
| `--line-control` | `#E0E0E4` → **`#DDE2DF`** | `#30353D` → **`#424242`** |
| `--line-accessible` | `#858A94` → **`#7D8788`** | `#565C66` → *(§5.3)* |
| `--action` (action/graphite) | `#262A33` → **`#22282A`** | `#E9EAED` → **`#F3F3F1`** |
| `--action-ink` (action/on-graphite) | `#FFFFFF` (igual) | `#141619` → **`#171717`** |
| `--action-hover` | `#353B47` → **`#323B3E`** | `#D9DBDF` → **`#E4E4E1`** |

**Veredictos** — ninguno cambia. Los seis valores de `web/style.css:50-52` y sus
equivalentes dark ya son exactamente los de la colección nueva. Está verificado
hex por hex contra `677:2060`; no los toques por las dudas.

### 5.2 El sidebar deja de ser invariante

Es el cambio más visible y el que más líneas mueve:

| token | Light | Dark |
|---|---|---|
| `--sidebar-bg` | `#0F1013` → **`#F4F5F4`** | **`#202020`** |
| `--sidebar-text` | `#C3C6CD` → **`#444D4F`** | **`#CACAC7`** |
| `--sidebar-muted` | `#8D919A` → **`#656E6F`** | **`#999995`** |
| `--sidebar-avatar` | `#212329` → **`#E6E8E6`** | **`#343434`** |
| `--sidebar-selected-text` | `#F0F0F2` → **`#22282A`** | **`#F2F2EF`** |
| `--sidebar-selected-bg` | `#262A33` → **`#E6E8E6`** | **`#343434`** |

Se van las dos líneas que decían que no cambiaba: `web/style.css:63` y las
copias de `:110` y `:149`. El bloque dark pasa a redefinir los seis.

`--sidebar-selected-bg` y `--sidebar-avatar` quedan con el mismo valor en ambos
modos, porque la nota dice *"elemento elegido con sidebar/avatar y
sidebar/selected-text"*. **Mantener los dos nombres.** Son roles distintos que
hoy coinciden, y colapsarlos es la clase de atajo que el encabezado del archivo
prohíbe explícitamente: *"Pick a token by its role, never by its value"*.

Dos consecuencias que hay que mirar con los ojos, no con los tests:

- **En Light, `--surface-subtle` y `--sidebar-bg` son el mismo `#F4F5F4`, a
  propósito.** El sidebar y una fila en hover son el mismo gris. En Dark se
  separan (`#242424` vs `#202020`). Está dicho en la nota; no es un error de
  copiado.
- **`--surface-disabled` deja de servir para selección.** *"No usar
  surface/disabled para la selección; ese token queda para controles
  deshabilitados."* Hay que auditar los usos actuales.

Hover de fila, hover de botón *quiet* y tab/filtro seleccionado: los tres usan
`--surface-subtle`.

### 5.3 Los tokens que Figma no nombra

Seis cosas viven en `style.css` y no tienen variable en la colección. Decidirlas
acá y escribir por qué, en vez de dejarlas caer:

- **`--role-*` (cinco pares) y `--signal-red`.** Son identidad y señal, no
  neutrales. La nota acota el cambio a los neutrales. **Quedan como están.**
- **`--focus-ring` (`#365FA5` / `#6E96E8`).** Es accesibilidad y comparte el azul
  de `--role-admin`. **Queda como está**, pero hay que verificar contraste contra
  el sidebar claro nuevo: un anillo azul sobre `#0F1013` y sobre `#F4F5F4` no son
  el mismo problema.
- **`--line-accessible` en dark.** Figma sólo da el valor light (`#7D8788`).
  **Propuesta: `#6A6A66`**, que mantiene contra `#171717` la misma relación que
  `#7D8788` tiene contra `#FFFFFF`. Marcarlo en el código como derivado, no como
  decisión de Figma.
- **`--shadow-float` y `--scrim`.** Hoy son `rgba(23,24,28,…)`, o sea el `--ink`
  viejo. **Re-derivarlos del nuevo `#22282A`**, o la sombra queda azulada sobre
  un fondo verde-gris.

### 5.4 Los nombres no cambian

Figma usa `--warden-ink-default`; el CSS usa `--ink`. **No renombrar.** Son ~1200
líneas de hojas de estilo y el prefijo no compra nada. La tabla de §5.1 es el
mapa, y va como comentario arriba del bloque `:root`.

## 6. Lo que el servidor todavía no sabe

Cinco huecos, en orden de cuánto bloquean.

### 6.1 No hay evidencia durable de una verificación

**El hueco.** `activityFor()` vive en un `Map` en memoria
(`src/policy/activity.ts:27`) y guarda `{ tool, at, count }`. No guarda el
veredicto, ni la regla, ni el `auditId`, y se vacía con el proceso. La nota pide
exactamente lo que falta: *"Conservar la herramienta elegida, la regla activada,
el identificador del pedido, la decisión, la hora y el origen real del pedido
para sostener el estado y mostrar evidencia."*

Un onboarding cuya finalización se evapora al reiniciar el gateway es el mismo
bug que F5 arregló en Team, escrito de nuevo.

**Propuesta.** `src/policy/verification.ts`, al lado de `devices.ts` y con la
misma forma (archivo JSON, escritura atómica, `0600`). Un registro por
`(employeeId, tool)`:

```ts
type Verified = {
  tool: string;          // 'claude-code'
  auditId: string;       // el handle del pedido, no su texto
  verdict: Verdict;
  ruleIds: string[];     // las que dispararon
  at: string;
  policyVersion: string; // para saber contra qué política se verificó
};
```

Escrito desde `src/server/routes/guard.ts:134`, al lado de `recordActivity`, y
sólo cuando el veredicto no es `ALLOW` y `firedRules` no está vacío. Nada de
texto de prompt: `auditId` es el handle que el audit log ya emite.

Retirarla (§2.5) es borrar la entrada de esa herramienta cuando cambia la regla
activa o se reescribe su cableado.

### 6.2 La decisión que sale por SSE no dice de qué herramienta vino

**El hueco.** `emitDecision(decision)` (`src/server/routes/guard.ts:143`) emite un
`Decision` (`src/guard/types.ts:117`), que no tiene la herramienta. El paso 05
tiene que distinguir *"llegó un pedido de Claude Code"* de cualquier otro
tráfico, y con el evento actual no puede.

**Propuesta.** Agregar la herramienta al **sobre del evento**, no al `Decision`
ni al registro de auditoría: `emitDecision(decision, { source })`. El `Decision`
es lo que se le contesta al hook y no le hace falta; el evento es para la
consola.

**Lo que habilita en la pantalla.** El paso 05 escucha, y **sólo reacciona a la
herramienta que la persona eligió en el 03**. Una decisión que llega de otra
herramienta no produce nada: ni verde, ni error, sigue esperando. Sin este campo
la pantalla no puede hacer esa distinción y festeja con cualquier tráfico, que
es la peor forma posible de fallar — le dice a alguien que verificó algo que no
verificó.

### 6.3 No hay cablear ni descablear una sola herramienta

**El hueco.** `POST /api/solo/protect` corre el script de instalación completo en
proceso: cablea todo lo que encuentra. El paso 03 pide *una*, y la pestaña Tools
pide `Connect` y `Unwire` por fila.

**Propuesta.** `POST /api/solo/protect { tool }` — opcional, y sin él se comporta
como hoy — y `POST /api/solo/unprotect { tool }`, que corre el `--unfix` que el
hook ya implementa, acotado a esa herramienta. Ambos sólo para la identidad de
This device; ninguno toca la máquina de nadie más (§4.2).

`Check again` de la fila "no instalada" es re-correr la sonda de CLI, que ya
existe.

### 6.4 "Sin respuesta" parece inobservable, y no lo es

**El problema.** Si el hook se queda sin tiempo, falla abierto y nunca le cuenta
a nadie. El gateway no puede ver un timeout del lado del cliente. Pedirle al hook
que reporte no sirve: si no llegó a Warden, tampoco va a llegar el reporte.

**Pero el gateway sí puede ver su propia lentitud.** `Decision.totalMs` existe, y
`/health` ya publica `deadlines.decisionMs`
(`src/server/routes/system.ts:91`). Una decisión con
`totalMs > decisionMs` es, por construcción, una decisión que llegó después de
que el hook ya dejó pasar el prompt. Eso es exactamente *"No decision"*, y es
observable sin tocar el hook.

El otro sabor —la herramienta no pudo alcanzar al gateway— es indistinguible de
*no se mandó ningún pedido*, y la pantalla no debe fingir que los distingue. Por
eso el frame de "Sin conexión" dice **"No request received"** y no "la conexión
falló": es lo único que se sabe.

Esto no cambia el trade que `CLAUDE.md` documenta. El hook sigue fallando
abierto a los 90 s y sigue siendo deliberado. Lo nuevo es que el primer uso lo
puede *mostrar* en vez de reportar éxito sobre un prompt que pasó sin revisar.

### 6.5 Diagnóstico de conexión para el paso 05

**El hueco.** *"Sin conexión"* necesita saber que el hook **falta**, no sólo que
no llegó tráfico. Ese hecho existe: F3 lo pone en disco. `devicesFor()` devuelve
`tools: [{ id, wired }]` y `wired === false` es el reporte de que la herramienta
está y Warden no está en su configuración.

**No hace falta endpoint nuevo**: `/api/solo/rules` ya devuelve `devices` desde
que F5 agregó `withActivity`. Lo que falta es leerlo en el flujo. La única
distinción a respetar —de F5 y vale acá igual— es que `wired === null` es
*no se sabe*, no *no está*.

## 7. Lo que ninguna pantalla puede prometer

El frame final dice *"Your first protection is working"*. Es una frase fuerte y
hay que ganársela y acotarla al mismo tiempo.

**Lo que la evidencia sostiene:** una herramienta, una regla, un pedido, un
momento. Eso es lo que se verificó y es mucho más de lo que la pantalla decía
antes.

**Lo que no sostiene:**

- **No es cobertura.** La segunda herramienta no hereda nada, y la pantalla lo
  dice en Tools. La nota al pie del frame de confirmación —*"Changing the tool or
  rule requires another real request to verify protection"*— es la misma verdad
  mirando hacia adelante.
- **No es prevención.** El hook es un archivo en la configuración de la
  herramienta, en el `$HOME` de quien la usa. En This device eso es una
  comodidad: es tu máquina, podés sacarlo. Warden ve que se fue y no lo puede
  poner de vuelta solo.
- **No es una garantía con deadline.** A los 90 s el hook deja pasar el prompt
  sin revisar. §6.4 hace que eso sea visible; no lo elimina.
- **El juez tiene una corrida atrás.** `CLAUDE.md` lo dice y `docs/MEASUREMENTS.md`
  lo registra. "Tu primera protección funciona" es una afirmación sobre el cable,
  no sobre la exactitud del modelo, y ninguna pantalla de este documento debe
  dejar que se lea como lo segundo.

Ningún control de F7 puede decir "Force", "Reinstall" ni "Guarantee". El test de
consola que F5 dejó para eso se extiende a las pantallas nuevas.

## 8. Fuera de alcance

- **La rama "Protect a team"** del paso 01. Existe y lleva al alta de gente; no
  se rediseña acá.
- **La pestaña Identity.** Las dos notas dicen *"(sin Identity)"*.
- **El conflicto de versión al editar una regla.** Sigue abierto de
  `console-f5-f6.md` §8: `POST /api/policy/ratify` (`src/server/routes/policy.ts:191`)
  no tiene guarda de versión, y el patrón está en `src/server/routes/prompts.ts:38`.
- **Cuántos presets mostrar.** El frame dice `Suggested · 2`; el código renderiza
  los 17 inactivos en una lista plana. El frame tiene dos por espacio, no por
  decisión — pero 17 filas planas sí es un problema real, y `state.soloGroups` se
  carga y no se usa. Es una pantalla aparte.
- **Marcar las decisiones tardías en Activity.** §6.4 hace observable que un
  prompt pasó sin revisar, y el primer uso lo muestra en su propia pantalla.
  Activity es el otro lugar donde correspondería —es el registro— pero es otra
  pantalla y otra conversación. Anotado, no incluido.
- **El prototipo de Figma.** *"Los clicks del prototipo ilustran navegación y
  expansión; no ejecutan la comprobación real."*
- **Dark mode del sistema de diseño.** `style.css` sigue por delante del archivo
  en varias pantallas; F8 alinea los neutrales, no cierra esa brecha.

## 9. Verificación

**Tests de consola** (`scripts/test-console.mjs`), sobre el estado, no sobre el
DOM renderizado a mano:

1. Cada uno de los cinco desenlaces del paso 05 produce su riel y su titular, y
   los cinco son distintos entre sí.
2. Un `ALLOW` desde la herramienta configurada **no** completa el flujo.
3. Una verificación sin `firedRules` no completa el flujo.
4. Cambiar la regla activa retira la verificación de la herramienta y no toca la
   configuración.
5. Verificar Claude Code deja a Codex sin verificar.
6. Las cinco filas de Tools producen sus cinco pares de frases, y la fila
   imposible no produce botón.
7. `wired === null` no se renderiza como *no cableado* en ninguna de las dos
   pantallas.
8. Ningún control del primer uso dice `Force`, `Reinstall` ni `Guarantee`.
9. Un hueco en el bloque de condiciones lo renderiza abierto y sin el control
   `Show details`.
10. **Ninguna pantalla de Team ofrece un control de cableado** (§4.3), incluida
    la ficha de una persona descableada — que sí sigue diciendo que lo está.
11. El paso 05 ignora una decisión que llega de una herramienta distinta a la
    elegida, y sigue esperando.

**Tests de servidor:**

12. El registro de verificación sobrevive un reinicio del proceso, y no contiene
    texto de prompt.
13. `totalMs > decisionMs` marca la decisión como llegada tarde.
14. `protect { tool }` cablea esa herramienta y no las otras; `unprotect` a la
    inversa.

**A ojo, sin test posible:**

15. El sidebar claro en Light, con el anillo de foco y el ítem seleccionado.
16. `--surface-subtle` igual a `--sidebar-bg` en Light, distintos en Dark.
17. El riel de cinco tramos a 1440 y a 1280.
