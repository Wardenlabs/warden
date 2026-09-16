# La consola después de F1–F4: This device, Gateway, Team y Activity — PRD

Cierra la serie de `docs/prd/wiring-and-unwiring.md`. F1 a F4 pusieron los
hechos en el servidor: cada gateway dice cuál es, cada máquina reporta su
propio cableado, y una pausa deja un registro que dice que no se juzgó. Nada
de eso se ve todavía. Este documento define las pantallas que lo muestran,
contra los frames que se diseñaron **después** de F1–F4 — que es el orden que
pidió el spec, porque recién con los datos en la mano se sabe qué puede
prometer una pantalla.

Cubre **F5** (la consola, §10 del spec) y **F6** (la clave, §7 del spec), más
una corrección de alcance acotado que el barrido de diseño encontró de paso
(§8).

Referencias `archivo:línea` al estado del repo al 2026-09-16, `main` en
`92bfdee`. Archivo de diseño: `RFPKLtSSZjQMHy9XaOOSqp`.

## 0. Por qué existe este documento

Porque hoy la consola dice tres cosas que no son ciertas, y las tres tienen la
misma causa: **confunde tráfico con configuración.**

1. **`web/js/solo.js:172` define estar protegido como haber mandado tráfico.**
   `const isProtected = connected.length > 0`. Hacés todo bien —instalás el
   hook, bajás el modelo, escribís una regla— y la pantalla te contesta en
   ámbar *"Not protected yet · no tool on this machine has sent a request
   through Warden"*. La única forma de que te diga que estás protegido es
   mandar un prompt. Esa frase fue lo primero que rompió la confianza de
   alguien que había hecho todo bien.

2. **Team muestra tráfico en memoria y lo llama conexión.** La columna
   `CONNECTED TOOLS` sale de `activityFor()`, que vive en un `Map` y se vacía
   cuando el proceso se reinicia. Después de un restart, un equipo entero
   perfectamente cableado aparece como *"Not connected yet"*. Y peor: la misma
   frase cubre tres situaciones distintas que para un administrador son
   opuestas — alguien que nunca instaló, alguien que instaló y **sacó** el
   hook, y alguien que está cableado pero de vacaciones.

3. **Gateway no existe como pantalla.** Lo que un gateway es —cuál instalación
   es, con qué juzga, qué modo corre, qué le promete a cada hook— está
   repartido entre This device y ningún lado. El par `deadlines.decisionMs` /
   `failClosed`, que es literalmente lo que decide si un hook deja pasar
   prompts sin revisar, no se ve en ninguna pantalla de la aplicación.

F3 ya separó los dos hechos en disco y F1 ya puso la identidad del gateway en
`/health`. Falta la mitad que se mira.

## 1. Lo que ya existe y no se toca

- **El sistema visual.** `web/style.css` ya es el rediseño: sidebar oscuro de
  240 px, paleta Graphite, tokens de light y dark, origen de contenido a 40 px
  del borde del sidebar. No hay un "portar el diseño"; las pantallas nuevas se
  escriben con lo que ya está.
- **El pipeline del guard.** Ningún cambio de acá hace que un modelo pueda
  despejar un pedido. La consola muestra decisiones, no las produce.
- **`exemptRoles` y `admin-auth.ts`.** No se agrega una segunda noción de
  admin. Gateway, Team y Activity son administrativas por estar fuera de
  `EMPLOYEE_PATHS`, que es como tiene que ser.
- **El audit log guarda hashes, nunca texto de prompts.** Lo que Activity
  muestra del texto viene de `src/audit/prompts.ts`, con su fecha de
  vencimiento, y Gateway tiene que decir esa fecha en voz alta (§3.3).
- **Rules, Inbox y Models.** El barrido contra el archivo de diseño confirmó
  que lo diseñado ahí tiene código detrás, incluidos los flujos difíciles
  (refinamiento, excluir y restaurar drafts, éxito parcial al activar,
  resultado de prueba anterior). No entran en este alcance.

## 2. This device

Frames elegidos: página `06 · This device`, sección `01 · This device ·
Elegida` (`551:692`) y `03 · Arranque · Elegida` (`552:692`). La reproducción
de cómo está hoy queda en `90 · Referencia` (`566:1227`) y **no es diseño**:
existe para tener contra qué comparar.

### 2.1 El bloque de condiciones reemplaza el layout actual

La pantalla deja de ser una lista de secciones y pasa a ser **un titular que
es la conclusión y cinco filas que son la evidencia**:

| Fila | Qué dice | De dónde sale |
|---|---|---|
| Warden | corriendo, qué instalación, qué versión | `/health` → `installation` |
| You | quién sos para este gateway, tu rol, si conoce tu clave | `GET /api/identity` |
| Your tools | qué herramientas, cableadas o no, última vez juzgada | `devices` de tu persona + `activityFor` |
| The judge | qué modelo juzga, y si es el mock | `/health` → `models`, `mock` |
| Rules for you | cuántas reglas te alcanzan y con qué efecto | `rulesForActor` |

**El plegado lo decide el contenido, no el usuario.** Con todo en orden, el
bloque se pliega a dos líneas y ofrece `Details ⌄` (frame `544:296`). Con
cualquier hueco, se abre solo y **no se puede plegar** (`559:1159`). Podés
guardar una buena noticia; no podés esconder que falta el juez.

Un hueco se pinta en `verdict/attention`; lo satisfecho, en `ink/default`.

### 2.2 Las dos condiciones invisibles

Dos cosas pueden estar mal sin que nada en la pantalla lo diga hoy, y las dos
hacen que Warden parezca andar:

- **Sin modelos descargados contesta el mock.** Es un doble de prueba, no un
  juez. La fila *The judge* tiene que decirlo con esas palabras y ofrecer
  `POST /api/gateway/leave-demo` cuando hay shell (`canLeaveDemo`), o el
  comando cuando no.
- **Un rol exento no está alcanzado por ninguna regla company-wide.** Cablear
  perfecto y no tener ni una regla dirigida a vos es estar sin protección. La
  fila *Rules for you* lo dice y la tarea siguiente es escribir una regla para
  uno mismo.

### 2.3 La acción vive arriba

El slot de la derecha del titular lleva **una** acción: la del titular. Si esa
acción resuelve una fila, esa fila pierde el suyo. En el arranque sin nada
conectado (`555:1112`) esa acción es `Protect this device` →
`POST /api/solo/protect`; con todo andando es `Turn Warden off` →
`POST /api/solo/pause` con `until: null`, y `DELETE` para volver.

Un pause sin fecha de vencimiento **es** el interruptor: apaga hasta que
alguien lo vuelva a prender, resuelve contra rol exento y queda en el log. No
se agrega ninguna otra forma de apagar.

### 2.4 Lo que se va de esta pantalla

La dirección pública y los datos en disco **se mudan a Gateway** (§3). Hoy
están acá y son del servidor, no de la máquina.

### 2.5 La corrección de `isProtected`

`solo.js:172` deja de existir en esa forma. Estar protegido pasa a ser una
conjunción de condiciones observables —gateway alcanzable, clave conocida,
herramienta cableada, juez real, al menos una regla que te alcance— y el
tráfico visto pasa a ser lo que es: una fila más, la que dice *última vez
juzgada*. Ninguna pantalla vuelve a decir "no estás protegido" porque todavía
no mandaste un prompt.

## 3. Gateway (pantalla nueva)

Frames: página `09 · Gateway` (`570:1227`), sección `01 · Gateway · Elegida`
(`570:1228`). Vista nueva en `web/js/gateway.js`, item nuevo en `nav.js` bajo
`LOCAL`, debajo de This device.

**La línea entre las dos pantallas no se cruza.** This device contesta *¿está
cableada mi máquina?*. Gateway contesta *¿qué es este servidor y está andando
honestamente?*. Acá no van modelos (tienen pantalla propia), ni reglas, ni
personas, ni actividad.

El titular **no dice "corriendo"**: si podés leer la pantalla, está corriendo.
Dice si está juzgando (`Judging every request` / `Not judging anything`). La
primera condición es identidad, no signo de vida — que es para lo que existe
F1: dos instalaciones peleándose el puerto y ninguna decía cuál contestó.

Tres tabs, con el componente `Tabs / Gateway` (`542:103`).

### 3.1 Overview (`570:1229` plegado, `573:143` abierto)

Banda **What this gateway promises every hook**, que es lo que hoy no se ve en
ninguna parte:

- `deadlines.decisionMs` — cuánto espera un hook antes de rendirse, con la
  frase de por qué lo dice el gateway y no cada laptop.
- `failClosed` — qué pasa cuando no puede contestar. Abierto por default: *el
  prompt pasa sin revisar*. Va en tinta y no en ámbar, porque es un trade
  documentado y no un error, con `WARDEN_FAIL_CLOSED=1` al lado.
- Un agregado de una línea de los devices que reportan, con el hueco cuando
  alguno trae un hook más viejo que el gateway. **El detalle por persona vive
  en Team**, no acá: quién está cableado es una pregunta sobre personas.

### 3.2 Access (`575:203` cerrado, `576:267` abriendo, `576:369` expuesto)

Direcciones: local, LAN, y el túnel público. **Es la única escritura de toda
la pantalla.** `POST /api/gateway/expose` con `enabled`, que contesta **202 y
nunca 200**: pedir no es lograr, el túnel tarda y el gateway se reinicia del
otro lado. Por eso existe el estado *abriendo* como frame propio, y por eso el
resultado se aprende de `/health` → `publicUrl` cuando vuelve.

La consecuencia va **escrita al lado del botón**, no dentro de un disclosure:
la dirección cambia cada vez que el túnel reinicia, cualquiera que la tenga
llega al gateway, sigue necesitando una clave, y **lo único que se hace
público es la dirección** — los prompts, las reglas y el log se quedan.

Cuando no hay shell de escritorio el endpoint devuelve 409 con su explicación,
y la pantalla la muestra en vez de un botón que no haría nada.

### 3.3 Retention (`577:396`)

Retención de prompts (`/health` → `prompts`: `days`, `held`, `max`), con la
ruta en disco, el `0600`, y que `WARDEN_PROMPT_RETENTION_DAYS=0` lo apaga y
borra el archivo. La cadena de auditoría con `GET /api/audit/verify`
(`ok`, `entries`, y `brokenAt` / `missing` / `unwitnessed` cuando los hay), y
qué guarda: quién, cuándo, qué reglas dispararon y un hash del prompt, **nunca
el texto**. Y lo que ocupa en disco.

### 3.4 El estado que tiene que gritar (`578:459`)

`mock` y `mode: 'baseline'` son dos cosas distintas —una es que nadie lee, la
otra es que nadie aplica— y hoy las dos se ven idénticas a un gateway sano.
Frame propio: titular en ámbar, condiciones abiertas sin poder plegarse,
banner de atención con la frase que importa — *un gateway en cualquiera de los
dos estados le contesta a cada hook exactamente igual que uno que funciona* —
y **una sola acción**, bajar un juez. Baseline no lleva botón porque es
`WARDEN_MODE` en la máquina que arrancó el gateway; se dice, no se ofrece.

## 4. Team

Frames: página `05 · Team`, sección `07 · Cableado y pausa · Elegida`
(`583:2968`). Las secciones 01 a 06 ya están implementadas en `team.js` y no
se tocan.

### 4.1 La columna se parte en dos hechos

`CONNECTED TOOLS` deja de ser una columna de tráfico y pasa a ser **qué
reportó la máquina**, con **cuándo se la escuchó** al lado. `/api/people` ya
manda `devices` por persona desde F3 y `team.js` los ignora hoy.

Los cinco estados quedan distinguibles (`583:2969`):

- cableado y activo;
- cableado y callado — puede ser vacaciones, no es un problema;
- **descableado** — reportó que el hook no está, en ámbar;
- **nunca reportó** — no hay registro de ninguna máquina, en gris;
- exento, que ya existía.

"Ausente" y "no cableado" son frases distintas y no se colapsan: una máquina
que nunca reportó no es una máquina sin cablear, es una máquina de la que no
se sabe.

El botón que hoy dice `2 without setup →` pasa a contar los dos por separado,
porque tienen respuestas distintas: a uno le mandás el setup, con el otro
hablás.

### 4.2 El detalle de persona dice en qué máquina

Hoy todo se resume en un subtítulo de una línea. Pasa a haber una fila por
device (`584:2942`): qué reportó sobre su propio cableado, con qué versión de
hook, desde cuándo y cuándo se lo escuchó.

### 4.3 Descableada (`586:3040`)

El estado que hoy no existe. Y **la copy no puede prometer lo que el producto
no hace**: el hook es un archivo de configuración en la máquina de la persona
y se puede borrar. No hay MDM, ni binario firmado, ni permiso del sistema
operativo. Warden **ve** que el precinto se rompió; no lo puede volver a
poner. La acción es reenviar el setup o hablar con la persona, y la pantalla
no puede sugerir otra cosa.

### 4.4 Pendiente de reconectar (`586:3152`)

Después de rotar una clave, `markPendingReconnect` marca **todas** las
máquinas de esa persona, así que la pantalla las marca todas. Se limpia sola
con el primer check que llega desde cada máquina con la clave nueva. Hoy una
rotación es invisible del lado del administrador: la clave vieja muere al
instante, sin período de gracia y por decisión, y el único que se entera es la
persona cuando la rechazan.

### 4.5 Pausar (`587:3236`) y la banda (`587:3402`)

El diálogo pide las tres cosas que `setPause` acepta: duración, motivo y
autor. Son las que hacen que un pause se pueda explicar seis meses después —
*"del 3 al 11 no se juzgó nada"* sin quién ni por qué es un agujero en el
registro. El diálogo dice qué hace de verdad: los pedidos pasan sin chequear y
quedan marcados, con tu nombre.

Mientras haya alguien pausado hay una banda visible, porque **un gateway que
no juzga a nadie no puede parecer uno que sí**. En la fila de esa persona,
donde iría *última vez*, dice que está pausada: mientras lo esté, ese dato no
significa lo que parece.

## 5. Activity

Frames: página `03 · Activity`, sección `02 · No juzgado · pausado · Elegida`
(`590:880`).

**La lógica ya está** desde F4: `activity.js` tiene el filtro propio, los
contadores excluyen los pausados del bucket de ALLOW, la línea de resumen los
cuenta aparte y el detalle trae la nota. Lo que falta es el tratamiento
visual, y la decisión es el punto en el que un pausado no se puede parecer a
un permitido:

- **El punto de color se vuelve un anillo vacío.** Rojo, ámbar y verde
  representan un veredicto. Acá no hay veredicto que representar: ningún pase
  corrió.
- **La columna RULE dice `Nothing ran`, no `—`.** En una fila permitida, `—`
  significa *corrieron las reglas y ninguna matcheó*. En una pausada
  significaría *no corrió ninguna*. La misma raya para dos cosas opuestas era
  el error.
- **El detalle muestra que el registro sigue completo**: no se juzgó, y aun
  así la cadena de hashes lo incluye. Un pausado es un agujero en lo que se
  juzgó, no en lo que se registró.

## 6. F6 — La clave: una fuente y un reconciliador

Sin pantallas. `~/.warden/credentials.json` (`0600`) pasa a ser la fuente:
`{ url, apiKey, updatedAt }`. El instalador lo escribe primero y deriva todo
lo demás. El hook lee `WARDEN_API_KEY` del entorno —para que un override siga
funcionando— y después el archivo.

Las copias en el perfil de shell y en el `env` de cada herramienta **siguen
existiendo**: Claude Code abierto desde el Dock no leyó ningún perfil, y su
`env` es estático, así que no puede apuntar a un archivo. Lo que cambia es que
dejan de ser originales. `--status` avisa cuando alguna difiere y `--fix` las
reescribe desde el archivo.

Es el más invasivo del home y por eso va último.

## 7. Lo que ninguna pantalla puede prometer

Vale escribirlo una vez, porque toca la copy de tres pantallas:

**Warden detecta, no impide.** Un empleado no puede hacer nada por API —las
únicas rutas que puede llamar son `guard/check`, `guard/rewrite`,
`guard/appeal`, `identity` y `devices/report`, y ninguna cambia nada— pero
puede borrar el hook de su propia máquina. Lo que el producto da es que eso se
vea: el reporte horario deja de llegar o llega diciendo que no está cableado.

Impedirlo de verdad necesitaría MDM o un proxy de red por el que pase todo, y
eso es otro producto. Ninguna pantalla puede escribirse como si Warden fuera
un candado.

## 8. Conflicto de versión al editar una regla

Alcance acotado, encontrado en el barrido del archivo de diseño contra el
código. El frame `Editar una regla / Conflicto de versión` diseña una
capacidad que el backend no tiene: `POST /api/policy/ratify`
(`src/server/routes/policy.ts:191`) recibe la regla y la escribe sin ninguna
guarda. Dos administradores editando la misma regla al mismo tiempo, el último
pisa al primero en silencio.

No hay que inventar el patrón: el editor de prompts ya lo hace. `changePrompt`
recibe la revisión que el cliente creía tener y la rechaza si no coincide
(`src/server/routes/prompts.ts:38`), con el comentario explícito de no invitar
a sobrescribir desde una revisión vieja. Se copia eso.

Va aparte de F5 y F6 porque no depende de nada de la serie de cableado, y
podría salir antes o después sin bloquear nada.

## 9. Fuera de alcance

**Pendiente de diseño, no de código** — tres flujos existen en la consola y no
tienen frames, y hasta que los tengan no hay nada que implementar:

- Add model (`web/js/model-library.js`)
- Editor de prompt (`web/js/prompt-editor.js`)
- Estados de tabla de Models (`web/js/models.js`)

**Dos decisiones abiertas:**

- **Modo oscuro.** `web/style.css` ya define la paleta completa bajo
  `prefers-color-scheme: dark` y bajo `[data-theme]`, con el sidebar
  deliberadamente sin redefinir. El sistema de Figma es Light-only y hay una
  página `08 · Dark` suelta. Acá el código va adelante del diseño y hay que
  decidir si el oscuro es contrato o accidente.
- **Inbox / Fallo al guardar** está diseñado pero marcado *En revisión*.

**Deuda operativa anotada:** el paso de notarización de macOS en CI no tiene
reintento. Ya falló una vez por red y se destrabó re-corriendo el job; en un
release real se rompe igual.

## 10. Verificación

Cada pantalla tiene un estado que sólo se puede ver rompiendo algo a
propósito, y son esos los que hay que probar:

- **This device** con el gateway en mock: la fila del juez dice que contesta
  un doble de prueba. Con rol exento y sin reglas dirigidas: la fila de reglas
  es un hueco y el bloque no se pliega.
- **Gateway** con `WARDEN_MODE=baseline`: titular en ámbar, banner, sin botón
  para baseline. Sin shell de escritorio: el 409 de expose se muestra como
  explicación y no como botón muerto.
- **Team** después de reiniciar el gateway: nadie pasa a decir *"not connected
  yet"*, porque los devices vienen de disco. Con una clave recién rotada:
  todas las máquinas de esa persona quedan pendientes.
- **Activity** con alguien pausado: los pedidos aparecen con anillo vacío,
  `Nothing ran`, fuera del conteo de permitidos, y el detalle muestra la
  cadena intacta.

Los smoke tests corren en un puerto de scratch con su propio `cwd` y su propio
home. **Nada de esto se prueba contra el 8080 del dueño.**
