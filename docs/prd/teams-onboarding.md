# El primer uso de Team — PRD

Continúa `docs/prd/console-f7-f8.md`. F7 le dio a This device un camino de
entrada y dejó escrito, en su §8, lo que quedaba del otro lado de la
bifurcación: *"La rama 'Protect a team' del paso 01. Existe y lleva al alta de
gente; no se rediseña acá."* Este documento es esa rama.

Define **F9**: el primer uso de Team — el recorrido que lleva a un
administrador desde una instalación vacía hasta la primera máquina ajena que
reporta estar cableada. F9 es numeración de esta serie.

Referencias `archivo:línea` al repo al 2026-09-20, `main` en `c436010` (el
primer uso de This device ya mergeado, PR #50). Archivo de diseño:
`RFPKLtSSZjQMHy9XaOOSqp`, página **05 · Team** (`298:1988`), secciones
**08 · Primer uso · los cuatro pasos** (`852:6447`) y **09 · Primer uso ·
caminos que fallan** (`852:6448`). Los once frames están `· Por revisar`.

El cómo —archivos, tipos, orden de fases— está en
[`docs/specs/teams-onboarding.md`](../specs/teams-onboarding.md).

## 0. Por qué existe este documento

**Porque hoy el primer compañero de cualquier instalación de escritorio no se
puede conectar, y nada en la consola lo dice.**

Tres cosas están mal, y sólo la primera es un bug:

1. **El mensaje de setup puede llevar una dirección en la que nadie escucha.**
   La app de escritorio arranca con la red apagada: `lanEnabled: false`
   (`desktop/settings.ts:21`) hace que el gateway escuche en `127.0.0.1`
   (`desktop/main.ts:238`). Pero la función que arma la dirección para el
   compañero, cuando la consola está abierta en `localhost`, responde con la IP
   de la LAN sin preguntarse si el proceso escucha ahí
   (`src/server/http.ts:123`). El admin da de alta a Ana, copia el mensaje, lo
   manda por chat, y en la laptop de Ana el `curl` no conecta. El comentario de
   esa misma función describe la falla con exactitud: *"silently, on someone
   else's laptop"*. Leído en el código; todavía no reproducido en una segunda
   máquina (§9.17).

2. **No hay camino de entrada.** Team es una tabla vacía con un botón `Add
   people`. El orden real de las cosas —que Warden sea alcanzable, después dar
   de alta, después mandar el mensaje, después esperar— no está en ninguna
   pantalla. Prender la red vive en un menú de Electron
   (`desktop/main.ts:588`) al que nada en la consola apunta. El alta termina en
   un diálogo que dice *"Share their connection key to finish setup"* y ahí se
   acaba la ayuda.

3. **Quien eligió "The team console" es tratado como si hubiera elegido lo
   otro.** La respuesta del splash no se escribe en ningún lado, y con el
   directorio vacío la consola decide que la instalación es solo: dibuja el nav
   sin el ítem `Team` (`web/js/nav.js:103`), dispara el primer uso de This
   device (`web/js/solo.js:57`), y el splash vuelve a preguntar en cada arranque
   (`desktop/main.ts:198`). `first-run-and-theme.md` §2.2 lo dejó anotado como
   hueco y señaló dónde correspondía cerrarlo: acá.

## 1. Lo que ya existe y no se toca

- **El pipeline del guard.** Nada de F9 se acerca a una decisión. El recorrido
  no juzga, no simula y no muestra veredictos.
- **`exemptRoles` y `admin-auth.ts`.** No se agrega una segunda noción de admin.
  Las dos rutas nuevas son administrativas por defecto, que es la dirección en
  la que ese archivo ya falla.
- **La identidad es la API key y sólo la API key.** El recorrido no le pide al
  compañero que configure nombre ni rol, y el mensaje de setup sigue siendo el
  que genera `src/onboarding/index.ts`.
- **El alta, el mensaje y los estados de cableado.** `POST /api/people`,
  `GET /api/people/:id/onboarding` y la clasificación `wiring()`
  (`web/js/team.js:59`: `never` / `silent` / `wired` / `unwired` / `pending`)
  son la materia prima del recorrido, no algo que reescriba.
- **El túnel.** `desktop/tunnel.ts` y `POST /api/gateway/expose` quedan como
  están, incluida su advertencia.
- **Team → People, Roles y Company.** El recorrido es la puerta de entrada; la
  tabla, el alta múltiple por comas y la página de cada persona siguen siendo
  donde se vive después.
- **El primer uso de This device.** F9 le toma prestado el shell y no le cambia
  una cadena.

## 2. El modelo que el recorrido tiene que enseñar

Antes que un flujo, F9 tiene que corregir una idea equivocada que es razonable
tener: que cada compañero corre un Warden en su máquina y le reporta al admin.
**Es al revés**, y todo el recorrido sale de ahí.

Hay un solo Warden: una máquina con los modelos, las reglas y el audit. El
compañero instala un archivo —el hook— con un comando que escribe dos datos en
su máquina: la dirección del gateway y su key. Desde ese momento, **cada prompt
que escribe viaja al gateway del admin**, se juzga allá, y vuelve permitido o
bloqueado.

Tres consecuencias, y cada una es una pantalla o una frase de F9:

1. **La cadena de conexión es dirección + key.** La key la emite el alta y
   nunca estuvo mal. La dirección es el dato que puede estar mal (§0.1), y por
   eso tiene su propio paso.
2. **Alcanzable no es un paso de instalación: es una condición permanente.** La
   laptop del compañero tiene que llegar al gateway en cada prompt. Si el túnel
   se cae mientras el admin espera en el último paso, el recorrido tiene que
   volver atrás solo, porque el mensaje que mandó dejó de servir.
3. **Un gateway que no contesta no bloquea a nadie: deja de mirar.** El hook
   falla abierto pasado su plazo (`CLAUDE.md`, "Security posture"). El gateway
   es la laptop de alguien; cuando duerme, el equipo trabaja sin que nada lo
   revise. Ninguna pantalla de la consola lo dice hoy.

## 3. Decisiones de producto

Tomadas con el owner el 2026-09-20. Son insumo fijo de la spec.

1. **Team es "los otros".** El recorrido da de alta empleados. El admin no se
   da de alta a sí mismo acá; cablear su propia máquina es This device.
2. **Lo termina un hecho: la máquina de esa persona reportó estar cableada.**
   No *"mensaje copiado"*, que no prueba nada. Y tampoco un pedido real juzgado,
   que es la vara de This device: allá quien verifica está sentado enfrente, acá
   depende de otra persona y de otro día.
3. **Una sola persona.** Un alta, un mensaje, una verificación. El resto del
   equipo se carga desde People.
4. **No hay paso de regla.** La instalación ya aterriza en el compositor de
   reglas (`web/js/router.js:19`), y es ahí donde el producto produce su efecto:
   una frase se vuelve una regla. El recorrido de Team se dispara **al entrar a
   Team**, no al arrancar, y llega después.
5. **El túnel rápido entra, con su advertencia.** Es MVP. La dirección pública
   cambia en cada reinicio, y la tarjeta que la ofrece lo dice con esas
   palabras.

## 4. F9 — El recorrido

### 4.1 El shell

El de This device, sin cambios: pantalla completa sin sidebar, la marca arriba a
la izquierda, eyebrow, título, riel, contenido, la acción primaria abajo a la
derecha, `← Back` abajo a la izquierda desde el paso 2, y una nota al pie.

Tres diferencias, y son todas:

- El eyebrow dice `TEAM · FIRST RUN`.
- El riel tiene **cuatro tramos**. `1 of 4` … `4 of 4`, y después
  `SETUP COMPLETE · CONNECTED`. Son cuatro pasos y una confirmación.
- Dos pasos tienen **un campo** en lugar de dos tarjetas. Es el primer recorrido
  donde el contenido es un formulario; usa el `Field` que ya existe.

La marca es la salida, como en This device. Salir no completa nada.

### 4.2 Los cuatro pasos

Copy exacto de los frames.

**Paso 1 — `1 of 4 · NAME YOUR COMPANY`** (`852:6449`)

> **Name your company**
> Campo `Company name`.
> Acción: `Continue`, deshabilitada con el campo vacío. Sin `← Back`.
> Nota: *You can change it later in Team → Company.*

Es el paso más liviano y hace dos trabajos: es lo primero que el admin escribe
que es *suyo*, y nombrar la empresa de muestra la convierte en propia — eso ya
pasa hoy (`src/policy/people.ts:480`).

**Paso 2 — `2 of 4 · MAKE WARDEN REACHABLE`** (`852:6490`, `854:6493`)

> **Choose how your team reaches Warden**
>
> `Same network · 192.168.1.42` — *Teammates on this network connect to this
> computer. Nothing leaves the office.*
>
> `Anywhere · public address` — *Opens a public HTTPS address through
> Cloudflare. It changes every time Warden restarts, and everyone needs a new
> setup message when it does.*
>
> Acción: `Turn on`.
> Nota: *Warden runs on this computer. While it is off or asleep, your team's
> requests are not checked.*

Dos tarjetas que son una elección, con la elegida en `surface/subtle`, igual que
el paso 1 de This device. La dirección real va en el título de la tarjeta de
red en cuanto se conoce.

**La nota al pie es la frase más importante del recorrido** (§2.3) y la única
que ningún otro lugar de la consola dice. No se acorta.

Mientras se prende (`855:6520`), el botón pasa a `Turning on…` y la nota cambia:
*Warden restarts to listen on the network. This page reconnects by itself, and
macOS may ask to allow incoming connections.* Las dos cosas pasan de verdad —el
gateway se reinicia y el sistema operativo puede preguntar— y un admin que no
está avisado lee cualquiera de las dos como una falla.

**Paso 3 — `3 of 4 · ADD A PERSON`** (`853:6469`)

> **Add the first person**
> Campo `Name`, y `Role` con los roles de la instalación como opciones.
> Acción: `Add person`.
> Nota: *They get their own connection key. You can add everyone else from
> Team.*

Los roles van en el orden del diálogo Add people: **los exentos al final**. Una
instalación nueva tiene `admin` y `employee`, `admin` es exento y
alfabéticamente primero, y el primer alta de una instalación no puede repartir
un bypass por orden alfabético. Si eligen un rol exento, la misma advertencia en
ámbar que el diálogo ya tiene.

**Paso 4 — `4 of 4 · CONNECT THEM`** (`853:6519`)

> **Send Ana their setup**
>
> `Send the setup message` — *Copy it and send it to Ana privately — a direct
> message or an email. It is one command, pasted into the Terminal on their own
> computer. It carries Ana's key and this address: http://192.168.1.42:8080.
> Treat it like a password.*
>
> `Waiting for Ana's device` — *Nothing has reported yet. You can leave — this
> updates when it does.*
>
> Acción: `Copy setup message`. Enlace secundario: `Check again`.
> Nota: *This step finishes when Ana's device reports back. It can take a day —
> nothing here needs you to wait.*

Primera tarjeta la instrucción, segunda el estado: la misma gramática que el
paso 3 de This device. La dirección se muestra **en esta pantalla**, no sólo
adentro del mensaje, porque es el dato que el admin tiene que poder mirar y
reconocer como equivocado.

### 4.3 El paso 4 puede tardar un día, y tiene cuatro desenlaces

Es la diferencia de fondo con This device. Allá el último paso espera a la
persona que está mirando la pantalla; acá espera a otra persona, en otra
máquina, que quizás lea el mensaje mañana. Tres cosas salen de eso:

- **Se puede abandonar.** La segunda tarjeta lo dice. Al volver, el recorrido
  cae de nuevo en este paso (§4.4).
- **Avanza solo.** Cuando la máquina de Ana reporta, la pantalla cambia sin que
  nadie toque nada. `Check again` queda como respaldo manual y, como
  `Check request` en This device, **no manda nada a ningún lado**: vuelve a leer
  lo que el gateway ya sabe.
- **Si Warden deja de ser alcanzable, vuelve al paso 2.** No es un error del
  paso 4; es que el paso 2 dejó de ser verdad.

Los desenlaces salen de lo que la máquina de Ana dijo de sí misma, y no son
intercambiables:

| lo que se sabe | riel | título | frame |
| --- | --- | --- | --- |
| nada reportó | `4 of 4 · CONNECT THEM` | `Send Ana their setup` | `853:6519` |
| llegó un pedido con su key, ninguna herramienta reportó el hook | `4 of 4 · SEEN, NOT WIRED` | `Ana's device reached Warden` | `855:6598` |
| una herramienta reportó que el hook **no** está | `4 of 4 · NOT WIRED` | `The hook is not in Ana's tool` | `855:6636` |
| la key se rotó y ninguna máquina volvió con la nueva | `4 of 4 · NEW KEY` | `Ana needs the new setup` | sin frame; layout de `853:6519` |
| una herramienta reportó el hook | `SETUP COMPLETE · CONNECTED` | `Ana is connected` | `854:6528` |

Copy de cada uno:

- **Seen, not wired.** `Connected, not wired` — *A request arrived with Ana's
  key, but no tool has reported the hook.* / `What to ask Ana` — *Run
  warden-hook --fix, then open their tool again.* Nota: *This step finishes when
  one of Ana's tools reports the hook.*
- **Not wired**, en tono de bloqueo. `Claude Code is not wired` — *Ana's device
  reported that Warden is no longer in Claude Code's settings. Ana's requests
  are not being checked.* / `What Warden can do` — *It can see this; it cannot
  put the hook back — it is a file on Ana's machine. Send the setup again, or
  talk to Ana.* Es la misma frase que la ficha de una persona descableada ya
  dice (`web/js/team.js:687`), escrita contra lo que el producto puede hacer.
- **Connected**, en tono `allow`. `Wired · Claude Code` — *Ana's device
  reported the hook. Ana's requests are checked against your rules from now
  on.* / `Add the rest of your team` — *Everyone gets their own key and their
  own setup message.* Acción: `View team`. Sin `← Back`. Nota: *If Ana's device
  stops reporting, Team says so on Ana's row.*

**Con cero reglas activas** (`854:6564`) la confirmación no puede decir *"are
checked against your rules"*: sería verdad técnica y mentira práctica. La
primera tarjeta baja a *Warden sees Ana's requests from now on*, la segunda pasa
a `Nothing is being stopped yet` — *You have no active rules, so every request
is allowed. Write one and it applies to Ana at once.* — y la acción es
`Write a rule`.

### 4.4 Cuándo aparece, y cuándo no vuelve

**Aparece** al entrar a la pestaña People de Team, cuando el equipo —la gente
del directorio que no es la identidad solo— tiene **cero o una persona, y nadie
cableado**:

- Directorio vacío → el paso que toque.
- Una persona, nunca cableada → directo al paso 4. Es volver al día siguiente.

**No aparece:**

- Con dos o más personas. Esa instalación ya pasó del primer uso, y People tiene
  para eso el contador *"never set up"*.
- Con la empresa de muestra cargada (tiene siete personas).
- En demo. Mismo criterio que F7: sin juez no hay nada que un recorrido pueda
  prometer, y el acceso público está deshabilitado ahí de todos modos.
- En Roles, Company o la página de una persona. Son enlaces que alguien siguió
  a propósito.

**El paso no se guarda: se deriva**, igual que en This device. Nombre de la
empresa, alcanzable, alguien en el equipo: los tres son hechos que el gateway ya
conoce. Quien le puso nombre a la empresa en Company no ve el paso 1; un gateway
que ya escucha en la red no ve el 2.

**Completado tampoco se guarda.** Es *"alguien del equipo está cableado"*. Si
esa única persona después se descablea, el recorrido vuelve, y está bien que
vuelva: con un equipo de uno, es la verdad.

Salir por la marca no lo hace reaparecer en la misma sesión. Al reabrir la app,
si sigue correspondiendo, vuelve.

## 5. F9 — Lo que cambia fuera del recorrido

**La página de una persona.** Cuando nadie más puede alcanzar el gateway,
`Copy setup message` deja de copiar un mensaje roto. En su lugar, un aviso:
*Nobody else can reach this gateway yet*, con `Make Warden reachable` →
Gateway → Access. El recorrido deja de aparecer con dos personas (§4.4), y la
red se puede apagar después de ese día; este aviso es lo que queda mirando.

**Gateway → Access.** Suma el control de red al lado del de acceso público, con
las mismas palabras que el paso 2. Hoy esa pestaña sólo sabe del túnel, y el
paso 2 no puede ser el único lugar de la consola donde la red se prende: es una
pantalla que se ve una vez.

**El nav.** Quien eligió *The team console* ve el nav de equipo —con `Team`—
desde el primer arranque, con el directorio vacío.

**El splash.** Pregunta una vez. La respuesta queda escrita.

## 6. Lo que el servidor todavía no sabe

Cuatro cosas. El detalle está en la spec §4; acá va qué le falta al producto.

1. **Cómo se llega a este gateway.** Nada le dice a la consola si el proceso
   escucha sólo en loopback o en la red, ni cuál es su dirección de LAN. Sin ese
   dato el paso 2 no puede derivarse y la consola no puede saber que un mensaje
   de setup saldría roto.
2. **Decir "no hay dirección".** La función que arma la dirección del compañero
   siempre devuelve algo. Tiene que poder devolver nada, y el endpoint del
   mensaje de setup tiene que negarse en vez de entregar una dirección muerta.
3. **Prender la red desde la consola.** Existe sólo como checkbox del menú de
   Electron. El túnel ya resolvió el mismo problema —la consola le pide al
   gateway, el gateway se lo pide al shell— y la red tiene que ir por el mismo
   camino.
4. **Avisar que una máquina reportó.** El stream de la consola sólo transporta
   decisiones. Un reporte de cableado se escribe en disco y no le avisa a nadie,
   así que el paso 4 se quedaría quieto para siempre con Ana ya conectada. El
   aviso no lleva datos de la máquina: es un timbre, y lo demás se lee de
   `GET /api/people`. El stream ya es administrativo
   (`src/server/admin-auth.ts:22`), así que nombrar a la persona no le filtra
   nada a un empleado.

Y una quinta, que es del escritorio: **la respuesta del splash** (§0.3).

## 7. Lo que ninguna pantalla puede prometer

El frame final dice *"Ana is connected"*. Es menos que *"Your first protection
is working"*, a propósito, y aun así hay que acotarlo.

**Lo que la evidencia sostiene:** una máquina de una persona dijo que el hook
está en una herramienta, y lo dijo con la key de esa persona, a este gateway.

**Lo que no sostiene:**

- **No es protección verificada.** Nadie vio a una regla decidir un pedido de
  Ana. Es la vara que se eligió (§3.2) y el copy no promete más: dice
  *connected* y *wired*, nunca *protected* ni *verified*.
- **No es permanente.** El hook es un archivo en el `$HOME` de Ana. Puede
  sacarlo, y Warden lo ve y no lo puede reponer. La nota de la confirmación
  apunta a dónde se va a ver.
- **No es disponibilidad.** El gateway es una laptop. Dormida, el equipo trabaja
  sin revisión, y el hook falla abierto. El paso 2 lo dice; nada lo resuelve.
- **La dirección pública no es estable.** Un reinicio deja a todo el equipo
  apuntando a una dirección muerta —y, por lo anterior, sin revisión— hasta que
  cada uno reciba un mensaje nuevo. La tarjeta lo dice antes de que la elijan.
- **El mensaje es un secreto viajando por un chat.** Lleva la key. El paso 4
  dice *"Treat it like a password"* y no puede hacer más que decirlo.

Ningún control de F9 dice `Force`, `Reinstall`, `Guarantee`, `Protected` ni
`Verified`.

## 8. Fuera de alcance

- **Una dirección pública estable.** Un túnel con nombre, o un gateway
  desplegado con `WARDEN_PUBLIC_URL` (`docs/DESPLIEGUE.md`). Es la salida real
  del cuarto punto de §7 y es una decisión de producto con su propio documento.
- **Avisarle al equipo que la dirección cambió.** Hoy se enteran porque Warden
  deja de opinar. Lo mínimo útil sería que `warden-hook --status` lo diga.
- **Un token de instalación de un solo uso**, para que el mensaje deje de llevar
  la key.
- **Cablear la máquina del admin.** Es This device, y un admin de equipo llega
  ahí por el nav cuando quiera.
- **El alta múltiple dentro del recorrido.** Sigue en People.
- **Reglas.** No hay paso de regla (§3.4); la confirmación sin reglas sólo
  señala el camino.
- **Modo oscuro de los frames.** Están atados a variables de punta a punta; la
  prueba se genera cuando haga falta, como en `08 · Dark`.
- **El rediseño del splash**, que el owner ya difirió. F9 sólo le hace recordar
  una respuesta.
- **Tres estados sin frame:** el paso 1 vacío (el mismo frame con el botón
  deshabilitado), el paso 3 con rol exento (la advertencia ya está diseñada en
  el diálogo Add people) y `NEW KEY` (layout del paso 4 en espera).

## 9. Verificación

**Tests de consola** (`scripts/test-console.mjs`), sobre el estado:

1. Los cuatro pasos se derivan de los cuatro hechos, y cambiar un hecho cambia
   el paso sin tocar nada más.
2. Un gateway que deja de ser alcanzable devuelve el paso 4 al 2.
3. Los cinco desenlaces del paso 4 producen su riel y su título, y los cinco son
   distintos entre sí.
4. `wired` con cero reglas activas produce `Write a rule`, y con una o más,
   `View team`.
5. El recorrido no se dispara con dos o más personas, con la empresa de muestra,
   en demo, ni en Roles, Company o la página de una persona.
6. Una persona nunca cableada entra directo al paso 4.
7. Los roles del paso 3 listan los exentos al final, y elegir uno muestra la
   advertencia.
8. Salir por la marca no redispara el recorrido en la misma sesión.
9. Ningún control de F9 dice `Force`, `Reinstall`, `Guarantee`, `Protected` ni
   `Verified`.
10. El primer uso de This device produce exactamente las mismas cadenas que
    antes de extraer el shell.

**Tests de servidor:**

11. Loopback sin dirección pública: no hay dirección para el compañero, y el
    endpoint del mensaje de setup se niega.
12. Con `WARDEN_PUBLIC_URL`, esa dirección gana sobre la de red.
13. Prender la red exige administrador, y sin shell responde que no puede.
14. Un reporte de cableado emite el aviso, y el aviso no lleva nombre de
    máquina, herramientas ni versión.
15. Con la elección *team* escrita, un directorio vacío no es una instalación
    solo: nav de equipo, y el primer uso de This device no se dispara.
16. El splash no vuelve a preguntar después de la primera respuesta.

**Con dos máquinas, sin test posible:**

17. Instalación limpia de escritorio en A → *The team console* → escribir una
    regla → entrar a Team → recorrer 1 a 4 con `Same network` → pegar el mensaje
    en B, misma red → el paso 4 de A pasa a `SETUP COMPLETE · CONNECTED` **sin
    que nadie toque A**.
18. Lo mismo con `Anywhere`, con B en otra red.
19. Reiniciar Warden en A con el túnel prendido, y confirmar que la consola dice
    la verdad sobre la dirección nueva.

Hasta que 17 pase, F9 es **NOT VERIFIED** y se anota así en
`docs/HOOK-VERIFICATION.md`, que es la convención de este repo.

**A ojo:**

20. El riel de cuatro tramos a 1440 y a 1280.
21. Los pasos 1 y 3, que son los únicos con un campo, contra los frames.
