# Rediseño de la consola: Warden v2 — PRD

Cubre el rediseño **completo** de la consola: nuevo lenguaje visual (sidebar
oscura, sistema de tokens "Warden · Sistema", dark mode), las siete áreas de
navegación y todos sus estados. Es enteramente superficie de producto: cero
cambios de endpoints, cero cambios en el guard, cero cambios en `src/`. El
diseño está cerrado y aprobado en Figma pantalla por pantalla (ver §4);
`docs/specs/console-redesign-v2.md` fija el cómo.

Reemplaza a la serie anterior (`rules-redesign`, `models-redesign`), que
implementó el diseño previo (PR #32). Aquellas PRDs quedan como historia; sus
decisiones sobreviven solo donde este documento las repite.

## 0. Por qué existe este documento

La consola actual implementa un lenguaje visual que fue superado por un
redesign integral hecho en Figma entre el 2026-09-09 y el 2026-09-15, revisado
y elegido pantalla por pantalla por el owner. Las distancias más grandes:

- **La navegación es un topnav horizontal** (`web/js/nav.js:25-47`, decisión
  argumentada en `nav.js:12-14`); el redesign la reemplaza por una **sidebar
  oscura fija de 240px** con grupos OVERVIEW / MANAGE / LOCAL. La consecuencia
  que el topnav protegía (ancho completo para el composer) se resuelve con la
  columna de lectura de 760px que todo el redesign usa.
- **No existe dark mode** (cero `prefers-color-scheme` en `web/style.css`);
  el redesign trae 35 tokens de color con valores duales Light/Dark ya
  decididos, más reglas de elevación propias del modo oscuro.
- **Los tokens actuales (`style.css:19-82`) son de otra paleta**: el accent
  near-black `#1a1d23`, verdicts `#2f8256`/`#c5383d`/`#96650f`. El sistema
  nuevo es Graphite `#262A33` + verdicts `#087356`/`#B91C41`/`#7B6200` +
  roles de identidad + sidebar propia — 60 tokens, dos modos.
- **Las filas abren expansión inline** (`data-toggle`); el redesign decide
  **"rows open a page"**: una decisión de Activity y una regla de Rules abren
  página propia con header de detalle, no un panel debajo de la fila.
- **Faltan estados enteros**: vacío / sin resultados / cargando / fallo de
  carga están diseñados para cada lista; hoy solo existen empty states
  parciales.
- **Interacciones nuevas ya resueltas en diseño**: menús contextuales de fila
  (···), filas desplegables con datum, editores inline de una línea, trigger
  de valor para cambiar modelo, confirmaciones honestas para operaciones 202.

## 1. Usuario y trabajo a resolver

El administrador de una instalación de Warden, en las siete preguntas que la
consola responde: *¿qué decidió Warden y por qué?* (Activity), *¿qué espera
mi respuesta?* (Inbox), *¿qué reglas rigen y cómo escribo una?* (Rules),
*¿quiénes son y qué límites tienen?* (Team), *¿qué modelo hace cada trabajo?*
(Models), *¿qué corre en esta máquina?* (This device).

## 2. Qué no es (alcance)

- **No cambia ningún endpoint ni contrato HTTP.** Toda la API se consume tal
  cual está (`src/server/routes/*`).
- **No cambia el stack.** La consola sigue siendo vanilla ES modules sin build
  step — decisión deliberada del repo (`web/style.css:1-3`) que este redesign
  ratifica. **No se introduce React ni Tailwind**: el sistema de 60 tokens
  semánticos con dos modos es exactamente lo que CSS custom properties hace
  nativo, y los 35 componentes son clases CSS + funciones de template que la
  arquitectura actual ya produce. El costo real del redesign (sidebar, vistas
  de detalle, estados) es idéntico en cualquier stack; migrar de stack solo
  agregaría el riesgo de la migración.
- **No toca los motores por dentro**: la conversación de New rule
  (`web/js/draft.js`, `draft-set.js`, `answers.js`), el pipeline de documentos
  (`documents.js`), el envío del tester (`simulator.js` por dentro), el
  router, `core.js` (`state`, `api()`), la suscripción SSE (`data.js`). Se
  re-visten y se re-encuadran; no se reescriben.
- **No diseña pantallas nuevas.** Donde una vista actual no tiene frame en
  Figma (segunda tanda declarada: Add model flow, prompt editor, estados de
  tabla de Library, desconexión de tool, resultado de Clear sample data), la
  vista existente **se re-estiliza con el sistema nuevo sin inventar layout**.

## 3. Experiencia deseada

Una consola con **sidebar oscura invariante** (idéntica en light y dark), el
contenido naciendo en un solo origen (x=280: sidebar 240 + 40 de padding),
columna de lectura de 760px para conversaciones y páginas de settings, tablas
de 1120 con filas que sangran simétricamente a 1160 (patrón Linear). Un solo
idioma de disclosure en todo el producto (chevron ⌄/⌃ a la derecha del
datum), radio 6 en todo elemento con caja, pills prohibidas, color saturado
reservado a verdicts y roles.

Las siete áreas, a nivel producto:

1. **Activity** — registro de decisiones agrupado por día; cada fila abre una
   página de detalle construida como "el intercambio": el pedido como turno
   de persona, la respuesta de Warden como tarjeta de veredicto. **La tarjeta
   de Warden existe solo cuando Warden intervino** — un permitido no tiene
   tarjeta de regla.
2. **Inbox** — una sola lista con tres grupos (Waiting on you / Reported as
   wrong / Already answered), nunca tabs. Retención abierta = Approve
   primario + Refuse rojo apagado; apelación = las palabras de la persona
   primero y "Open the rule" como acción (resolver no existe en la API).
3. **Rules** — lista → detalle en página → edición in place → test del draft
   sin guardar. Crear es una conversación con el compilador (el único hero
   composer centrado del producto); probar es un hilo con composer abajo.
4. **Team** — tres tabs (People / Roles / Company). Roles con editor de
   límite inline de una línea; Company como página de settings con filas
   desplegables y el reset diciendo la verdad del backend: **la gente y los
   prompts se van, las reglas quedan** (verificado en
   `src/server/routes/company.ts:71` → `clearDemoDirectory` + `forgetAll`).
5. **Models** — tres tabs (Active / Library / Prompts). En Active, **el valor
   es el control**: el nombre del modelo es el trigger que abre el menú de
   cambio; el picker ofrece **solo modelos testeados**; cambiar muestra la
   transición honesta ("judging continues on X until it's ready" — nunca hay
   un hueco sin juez). Session ceilings viven acá, por rol.
6. **This device** — la máquina, no la persona: tools detectadas (estado como
   texto coloreado, sin botones), dirección pública (el 202 del túnel
   renderizado honestamente), datos en esta máquina.
7. **Dark mode** — sigue al sistema operativo. La elevación se invierte (lo
   flotante es más claro), el primario se invierte (botón claro sobre fondo
   oscuro), la sidebar no cambia.

## 4. Decisiones de producto (cerradas — no re-litigar)

Cada una fue tomada explícitamente por el owner durante el redesign:

- **Sidebar oscura reemplaza al topnav.** Selección = banda rellena
  `#262A33` radius 8 + texto Semi Bold; nunca subrayado (la regla de
  underline pertenecía al diseño anterior y muere con él).
- **Un solo idioma de disclosure**: chevron ⌄/⌃ a la derecha, después del
  datum. El datum se muestra **solo si reporta estado real** ("Installed · 5
  people · 3 roles"), no si meramente adelanta el contenido.
- **Un editor inline no contiene disclosures** y no lleva chevron: es estado
  temporal abierto desde un ···, se cierra con Cancel/Save. Una cosa
  colapsable por pantalla.
- **Regla de eje**: horizontal cuando se cambia UN valor (label izquierda,
  control derecha, acciones al lado del grupo); vertical solo para
  formularios que se llenan enteros. Save aparece recién cuando el valor
  cambió; sin tocar, solo existe Cancel.
- **La acción vive al lado del valor que opera**, nunca a 500px en el borde.
  De ahí el Trigger / Value de Models.
- **Rows open a page** (Activity, Rules); los menús de fila (···) repiten
  exactamente las acciones de la página de detalle.
- **Reset de company**: sin confirmación de tipear el nombre (esa ceremonia
  estaba dimensionada para una pérdida de reglas que no ocurre); diálogo
  plano Cancel / Reset company con el copy verdadero.
- **Picker de modelos: solo testeados.** Lo no testeado se resuelve en
  Library.
- **Session ceilings se editan en Models, por rol** — donde vive la noción de
  token — no en el editor de límite de Roles (que quedó en una sola línea:
  requests al día).
- **Destructivo se ve destructivo sin danger zone**: rojo de veredicto
  apagado, texto explícito, nunca color solo.
- **Radio 6 en todo; pills prohibidas.** Labels de rol = chip delineado sin
  relleno. Efecto en filas de tabla = texto coloreado plano, sin caja.
- **Dark**: paper `#16181D` (el azulado, elegido explícitamente), flotantes
  más claros que el papel (`surface/raised`), primario invertido, sidebar
  invariante, verdicts con tints oscuros propios — nunca inversiones
  automáticas.
- **Figma es la fuente de verdad de layout y copy.** Archivo "Warden"
  (fileKey `RFPKLtSSZjQMHy9XaOOSqp`), páginas `01 · Design system` a
  `07 · Models` + `08 · Dark`. Solo frames "· Elegida". Las páginas
  `90/91 · Referencia`, `98 · Biblioteca anterior`, `99 · Archivo` y las
  colecciones de variables "ZZ Legacy · …" **no se miran** — son historia.
  Todos los frames están exportados como PNG en `design/console-v2/` para
  trabajar sin acceso a Figma.

## 5. Métricas de éxito

- Las siete áreas navegan desde la sidebar; el item activo dice dónde estás.
- Cero hex y cero font-size literales fuera de `:root` (la invariante de
  `style.css:16` sobrevive con los tokens nuevos).
- Cada lista tiene sus cuatro estados (vacío / sin resultados / cargando /
  fallo) y cada fallo distingue el log de la protección ("Your rules still
  apply — requests keep being judged").
- Dark mode completo con solo cambiar el tema del OS; ningún componente con
  fondo queda blanco en oscuro.
- Cero regresiones funcionales: todo lo que la consola hace hoy (escribir,
  activar, probar, aprobar retenciones, rotar claves, cambiar modelos,
  exponer el gateway) sigue funcionando contra los mismos endpoints.
- `pnpm test`, `pnpm run typecheck`, `pnpm run build` en verde;
  `scripts/test-console.mjs` actualizado a los strings nuevos, no
  deshabilitado.

## 6. Riesgos

- **El full-render por innerHTML** redibuja el pane entero; la sidebar pasa a
  ser chrome persistente y conviene sacarla del redraw (el spec fija cómo).
- **La bifurcación solo/team de la nav es una regla de producto real**
  (`soloIsPureInstall()`, `web/js/nav.js:66-69`, citada a
  `docs/specs/solo-mode.md §7`). La sidebar debe respetarla; el spec fija qué
  ve una instalación solo pura.
- **Vistas sin frame** (redteam, engine, soloSettings, y la segunda tanda):
  el riesgo es inventar diseño. Regla: re-estilizar con el sistema, no
  rediseñar.
- **"Conflicto de versión" (frame 278:1671) no tiene API detrás** — la
  política es last-write-wins sin 409. La pantalla queda diseñada pero fuera
  del alcance de implementación hasta que exista el endpoint.
- El copy diseñado está en inglés y es parte del diseño; traducirlo o
  "mejorarlo" al implementar es una regresión.

## 7. Fuera de este documento

Rutas exactas, el bloque completo de tokens listo para pegar, el mapa de los
35 componentes, el inventario pantalla por pantalla con su PNG y su node-id,
el orden de fases y la verificación — todo eso es
`docs/specs/console-redesign-v2.md`.
