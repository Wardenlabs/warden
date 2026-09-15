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
  copy del frame y *Retry loading* vuelve a pedir la misma ruta.

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

### "Added today" en el detalle de una persona

- **Frame**: `team/detalle-sin-conectar` 354:683.
- **Diseño**: línea de contexto "Added today · Not connected yet".
- **API**: `GET /api/people` no trae fecha de alta.
- **Implementado**: la línea dice solo el estado de conexión ("Not connected
  yet").
