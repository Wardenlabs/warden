# Rediseño de la consola v2 — contradicciones diseño / API

Sigue a `docs/specs/console-redesign-v2.md`. La regla del owner (2026-09-15):
**si el diseño y la API se contradicen, gana la API.** El rediseño es 100%
`web/` y no toca `src/`, así que cuando un frame promete algo que el gateway
no hace, la consola implementa lo que el gateway hace y lo dice con copy
verdadero. Cada caso queda anotado acá para que la próxima tanda de diseño (o
un endpoint nuevo) lo pueda cerrar.

Formato de cada entrada: frame y node-id, qué pide el diseño, qué permite la
API, qué se implementó.

## Rules

### Probar un draft sin guardar

- **Frames**: `rules/test-*` (199:451, 199:554, 266:1075, 209:3, 209:98,
  272:606, 209:193, 278:1772, 324:2452).
- **Diseño**: "Test rule" prueba la versión *sin guardar* de una regla contra
  un pedido y un archivo, y devuelve veredicto + razón legible + reporte de
  extracción, con versionado del draft (v2 → v3).
- **API**: `POST /api/guard/check` prueba la política **activa** como un
  empleado (acepta adjuntos, devuelve razón y documentos). `POST
  /api/policy/preview` prueba una regla **candidata**, pero solo texto, sin
  adjuntos, re-adjudica todos los ejemplos de la regla en cada llamada, y la
  razón es la del modelo por fila.
- **Implementado** (decisión del owner, "híbrido"): desde la lista, *Test
  rules →* usa el motor de `simulator.js` intacto contra la política activa,
  con adjuntos y *Send as*. Desde Edit o un draft, *Test rule* usa
  `/api/policy/preview` con el texto escrito, sin adjuntos (el `+` del
  composer no aparece) y el copy dice que es una simulación de ese draft. El
  versionado v2 → v3 se lleva en el cliente.

### Deactivate…

- **Frames**: `rules/detalle` 266:603, `rules/menu-de-fila` 487:2580,
  `rules/editar-guardado` 310:3699.
- **Diseño**: "Deactivate…" como acción reversible (Kind Default).
- **API**: no hay estado activo/inactivo; solo `DELETE
  /api/policy/rules/:id`, que borra la regla del policy.
- **Implementado**: "Remove rule…" en el mismo lugar, estilo destructivo, con
  un diálogo que dice que la regla se borra y deja de atar en el momento.

### Editar el texto de una regla

- **Frames**: `rules/editar` 266:836, `editar-validacion` 276:1510,
  `editar-fallo-al-guardar` 217:96, `editar-guardado` 310:3699.
- **Diseño**: el textarea de la instrucción se edita in place y *Save changes*
  aplica.
- **API**: `POST /api/policy/ratify` reemplaza la regla por id con lo que se
  le mande. Pero los ejemplos de la regla entran al prompt del juez
  (`src/guard/passes/shots.ts`); guardar texto nuevo con ejemplos escritos
  para el texto viejo cambia cómo se juzga sin medirlo.
- **Implementado** (decisión del owner): si el texto cambió, *Save changes*
  recompila con `POST /api/policy/draft` (`lockTo` = audiencia actual), conserva
  el id y el Effect elegido, y recién entonces ratifica. Si solo cambió el
  Effect, ratifica directo. Sin compilador configurado el guardado falla con
  el error del gateway y los cambios quedan en el formulario.

### Revisar un refinamiento antes de reemplazar los drafts

- **Frames**: `crear-refinando` 277:1458, `crear-revisar-refinamiento`
  323:2288, `crear-refinamiento-fallido` 323:2403.
- **Diseño**: al refinar, los drafts actuales quedan intactos hasta que el
  admin elige *Use revised drafts* o *Keep current drafts*.
- **API**: `POST /api/policy/draft-set` es sin estado: devuelve un set nuevo y
  no guarda nada. El motor de la consola reemplazaba el set en cuanto llegaba.
- **Implementado**: el set revisado se retiene del lado del cliente como
  propuesta pendiente y reemplaza al actual solo con *Use revised drafts*. No
  hace falta API: el gateway nunca tuvo el set.

### Estados de carga y de fallo de las listas

- **Frames**: `rules/cargando` 280:1986, `rules/fallo-de-carga` 280:2084,
  `activity/cargando` 480:6981, `activity/fallo-de-carga` 480:7080,
  `inbox/cargando` 486:571, `inbox/fallo-de-carga` 486:7189.
- **Diseño**: cada lista tiene placa de cargando y de fallo con *Retry loading*.
- **API**: los endpoints responden normalmente; la consola no distinguía
  cargando de vacío ni fallo de vacío (`refreshPolicy`, `refreshAudit`,
  `refreshAppeals`, `refreshEscalations` en `data.js` tragaban el error y el
  boot cargaba todo antes del primer render).
- **Implementado**: `data.js` registra por lista si está cargando y si la última
  lectura falló, sin cambiar qué pide ni cuándo. El fallo se muestra con el
  copy del frame y *Retry loading* vuelve a pedir la misma ruta. People no
  tiene frame de cargando/fallo: usa el mismo molde (§6.8). Antes un fallo de
  `/api/people` reemplazaba el directorio por el cuerpo del error; ahora
  `refreshPeople` conserva el último directorio leído y la lista lo dice.

### "31 checks" en la actividad de una regla

- **Frames**: `rules/lista` 266:244 ("Stopped 9 of 31"), `rules/detalle` 266:603
  ("Today · 31 checks · 9 blocked").
- **Diseño**: cuántas veces se consultó la regla hoy y cuántas bloqueó.
- **API**: `GET /api/audit` guarda las reglas que *dispararon* en cada
  decisión (`firedRules`), no las que se consultaron sin disparar.
- **Implementado**: la lista dice "Stopped 9 of 31" contando disparos de hoy, y
  el detalle dice "Today · 31 matches · 9 blocked": *matches*, no *checks*.

### Un draft con efecto Warn, en Test rule

- **Frame**: `rules/test-advertencia-y-version` 272:606 ("! Would allow with a
  warning").
- **Diseño**: el tester distingue "permitido" de "permitido con advertencia".
- **API**: `/api/policy/preview` devuelve `ALLOW` tanto si una regla `warn`
  disparó como si no (a propósito: es el veredicto que el guard daría) y no
  dice si la advertencia se adjuntaría.
- **Implementado**: "Would allow" con la nota "A warn rule never blocks or holds
  a request. This simulation cannot tell whether the warning would be shown."
  La razón del modelo se muestra igual.

### Archivos en Test rule de un draft

- **Frames**: `rules/test-en-curso` 199:554, `test-bloqueo` 266:1075,
  `test-fallida` 209:193 (un `.xlsx` adjunto y "View extraction report →").
- **Diseño**: un draft se prueba con documentos.
- **API**: `/api/policy/preview` no acepta adjuntos; solo
  `/api/guard/check` (política activa) lee documentos.
- **Implementado**: en modo draft el composer no ofrece `+`, la línea vacía
  dice que un draft se prueba con texto y que los archivos se prueban contra
  reglas guardadas desde *Test rules*. En *Test rules* los adjuntos, el reporte
  de extracción y el fallo con archivo están implementados como en el frame.

## Team

### Límite diario y session ceilings en el mismo `PUT`

- **Frames**: `team/roles-limite-abierto` 419:2206, `models/session-ceilings`
  512:423.
- **Diseño**: el límite diario se edita en Roles (una línea) y los ceilings
  por rol en Models, como dos ediciones independientes.
- **API**: `PUT /api/quotas/:role` es un upsert de la fila entera: un campo que
  no se manda se borra, y sin `maxRequestsPerDay` la fila completa desaparece
  (ceilings incluidos).
- **Implementado**: cada editor reenvía los campos que no está editando con su
  valor actual. En Models, un rol sin límite diario muestra sus ceilings como
  "—" y no ofrece editarlos, con la razón en la nota: sin límite diario la API
  no guarda ceilings.

### Reset company: quién se va

- **Frames**: `team/company-reset` 430:2619, `dark/company-reset` 519:219.
- **Diseño**: "Every person goes and every stored prompt is cleared. You get a
  fresh admin key — the old ones stop working. Your rules stay."
- **API**: `POST /api/company/reset` (`clearDemoDirectory` + `forgetAll`)
  conserva al **primer empleado con rol `admin`** con una clave nueva, borra a
  todos los demás y los prompts guardados; reglas y roles quedan. La respuesta
  no devuelve la clave nueva.
- **Implementado**: "Every person but the first administrator goes, and every
  stored prompt is cleared. That administrator gets a fresh key — the old ones
  stop working. Your rules stay." El toast posterior dice que la clave nueva
  está en la página de esa persona.

### Rol exento: acceso de administrador

- **Frames**: `team/confirmar-rol-exento` 363:1066, `error-cambiar-rol`
  363:5601, `rol-actualizado` 364:1703.
- **Diseño**: dos frames dicen "exempt from every rule".
- **API**: `rulesForActor` (`src/policy/store.ts`) exime a un rol exento solo
  de las reglas `*`; una regla que nombra el rol o a la persona sigue atando.
  El spec §6.4 ya lo pide ("NUNCA exempt from all rules").
- **Implementado**: "exempt from company-wide rules" en todos los casos, y el
  diálogo de confirmación mantiene "Rules written for admin, or for Ana by
  name, still apply".

### "Added today" en el detalle de una persona

- **Frame**: `team/detalle-sin-conectar` 354:683.
- **Diseño**: línea de contexto "Added today · Not connected yet".
- **API**: `GET /api/people` no trae fecha de alta.
- **Implementado**: la línea dice solo el estado de conexión ("Not connected
  yet").

## This device

### Las reglas de este dispositivo

- **Frames**: `this-device/local` 493:82, `direccion-publica` 495:129.
- **Diseño**: la página es la máquina y nada más — Tools on this machine,
  Public address y Data on this machine. No hay lugar para las reglas propias.
- **API**: una instalación solo sigue teniendo `/api/solo/rules` (listar,
  agregar, borrar), `/api/solo/presets` con su toggle y `/api/solo/protect`.
  En una instalación pura (sin equipo) "Rules" no está en la navegación, así
  que sin esta sección esas rutas quedan sin pantalla.
- **Implementado** (decisión del owner): los bloques del frame arriba, tal
  cual, y debajo la sección "Rules on this device" re-estilizada con el
  sistema nuevo (§6.8): tabla con el efecto, el texto, el toggle y ··· Remove;
  banda "Suggested" con los presets apagados; campo para escribir una regla.
  Las reglas de la empresa que no aplican a esta identidad (rol exento) se
  listan en gris con "everyone · not judged for you".

### Put it on the internet fuera de la app de escritorio

- **Frames**: `direccion-publica` 495:129, `exponiendo` 495:213.
- **Diseño**: el disclosure siempre ofrece "Put it on the internet".
- **API**: `POST /api/gateway/expose` responde 202 solo si hay un shell de
  escritorio escuchando; si no, 409 ("not running inside the desktop app").
- **Implementado**: el botón aparece solo cuando la consola sabe que hay un
  shell (`canLeaveDemo`); en demo queda deshabilitado con la razón, y sin
  shell el disclosure dice "Open a tunnel from the Warden app, or put your own
  proxy in front of it." El 202 se muestra como "Asked the tunnel to open —
  usually under a minute" y el resultado se lee de `/health`.

## Models

### Cambiar el juez: qué pasa con los requests mientras carga

- **Frame**: `models/cambiando-modelo` 506:406.
- **Diseño**: "● Loading X… judging continues on Y until it's ready".
- **API**: `RoleCoordinator` (`src/qvac/coordination.ts`): el cambio de pesos
  es un escritor encolado que **frena a los lectores nuevos**; solo las
  decisiones ya empezadas terminan con Y. Un request que llega durante la
  carga espera a X, no lo juzga Y.
- **Implementado**: "Loading X… requests already being judged finish on Y; new
  ones wait until it is ready." en ámbar al lado del trigger, que ya muestra X.

### El menú del juez: "solo modelos testeados"

- **Frame**: `models/menu-de-modelo` 506:304.
- **Diseño**: el menú lista solo modelos testeados, con el activo tildado, y
  "Add a model…" al final.
- **API**: el modelo *seleccionado* puede no estar descargado
  (`/api/settings/adjudicator` → `choices[].onDisk: false`); no deja de ser la
  selección vigente.
- **Implementado**: los built-in descargados y los custom testeados para el
  rol; si el seleccionado no está en disco aparece tildado pero deshabilitado,
  y debajo del bloque la línea ámbar "X is selected but not downloaded yet".

### Session ceilings de un rol sin límite diario

- **Frame**: `models/session-ceilings` 512:423.
- **Diseño**: toda fila de rol es editable.
- **API**: los ceilings viven en la misma fila de cuota que el límite diario;
  `PUT /api/quotas/:role` sin `maxRequestsPerDay` borra la fila entera (ver
  "Límite diario y session ceilings en el mismo `PUT`").
- **Implementado**: solo son editables los roles con límite diario; los demás
  muestran "needs a daily limit" y la nota al pie apunta a Team → Roles.
