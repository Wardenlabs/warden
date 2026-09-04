# Warden Solo — Plan de implementación

Sigue a `docs/prd/solo-mode.md` y `docs/specs/solo-mode.md`. Ninguna decisión
de producto o de arquitectura se vuelve a discutir acá — esto es orden de
trabajo, archivos concretos, y los gates que hay que pasar antes de avanzar
de una fase a la siguiente.

## 0. Principio de orden

**El cambio de mayor riesgo va primero, aislado, y medido — antes de que
nada más dependa de él.** Todo lo demás en este plan es superficie nueva
(archivos, rutas, vistas) que no puede romper nada existente por definición;
el cambio de la Fase 1 sí puede, porque toca la función más
security-relevant del repo según su propio `CLAUDE.md`. Nada de las Fases
2 a 8 arranca hasta que la Fase 1 esté mergeada con su verificación hecha.

Dependencias entre fases:

```
Fase 1 (rulesForActor)  ──┬──▶ Fase 4 (endpoints /api/solo/*) ──▶ Fase 5 (consola) ──▶ Fase 7 (protect) ──▶ Fase 8 (E2E)
Fase 3 (presets JSON) ────┘                                          ▲
Fase 2 (UX audiencia) ── en paralelo, sin dependencia de Fase 1 ─────┘ (usa Fase 1 solo para el aviso de "esto te va a aplicar a vos")
Fase 6 (desktop/first-run) ── en paralelo con 4/5, converge en Fase 7
```

Fase 2 y Fase 3 se pueden hacer en paralelo con la Fase 1 (son archivos
distintos, sin overlap), pero Fase 2's aviso de "esto también te va a
aplicar a vos" no tiene nada que mostrar hasta que la Fase 1 esté andando —
se puede construir la UI antes, pero no se puede verificar el caso real
hasta que exista.

## Fase 1 — `rulesForActor`: el cambio de riesgo

**Archivo:** `src/policy/store.ts:281-299`.

```ts
// antes
export function rulesForActor(spec: PolicySpec, actor: { id: string; role: string }, side: JudgedSide = 'input'): Rule[] {
  if (isExempt(spec, actor.role)) return [];
  return spec.rules.filter((r) => bindsActor(r.appliesTo, actor) && governsSide(r, side));
}

// después
export function rulesForActor(spec: PolicySpec, actor: { id: string; role: string }, side: JudgedSide = 'input'): Rule[] {
  const exempt = isExempt(spec, actor.role);
  return spec.rules.filter((r) => {
    if (exempt && r.appliesTo.includes(EVERYONE)) return false;
    return bindsActor(r.appliesTo, actor) && governsSide(r, side);
  });
}
```

Actualizar también el comentario que justifica el corte (líneas 286-297) —
sigue siendo válido pero tiene que decir explícitamente que ahora es
por-regla, no por-actor, para que la próxima persona que lea la función no
tenga que reconstruir el razonamiento leyendo este documento.

**Checklist para dar por cerrada esta fase (todos obligatorios, en este
orden):**

1. Test unitario nuevo (junto a los que ya existan para `store.ts`, o un
   archivo nuevo `src/policy/store.test.ts` si no hay suite ahí todavía) con
   4 casos mínimos:
   - exento + regla `*` → no aparece (comportamiento viejo, no debe cambiar).
   - exento + regla con su rol nombrado (`"admin"`) → aparece.
   - exento + regla con su `@id` nombrado → aparece.
   - no exento, cualquier regla que lo alcance → sin cambios respecto a hoy.
2. `pnpm run typecheck` limpio.
3. `pnpm run redteam` corrido **antes** de mergear el cambio (baseline) y
   **después** (delta) — con el `data/policies.json` real del repo, sin
   ninguna regla nueva todavía. El delta esperado es **cero**: ninguna regla
   existente hoy nombra a `admin` ni a un `@id` exento, así que el filtro
   nuevo no debería mover ni un verdict. Si algo se mueve, no se sigue sin
   entender por qué.
4. Prueba manual, igual a la que ya se hizo a mano en esta sesión de
   research: con `WARDEN_ADAPTER=real`, ratificar una regla de prueba con
   `appliesTo: ["@<tu propio id de admin>"]`, mandar un prompt que la
   viole desde esa misma identidad, confirmar `BLOCK`. Después borrar la
   regla de prueba (`DELETE /api/policy/rules/:id`) y confirmar que el hash
   de la política vuelve al valor previo — mismo procedimiento de limpieza
   que ya se siguió antes acá.
5. Documentar el cambio en `docs/MEASUREMENTS.md`, por convención del repo
   ("si arreglás una de estas, agregá la fila con la corrida detrás") —
   aunque esto no es uno de los ítems de esa lista, es el mismo tipo de
   cambio de comportamiento del guard y merece el mismo registro.

Nada de lo que sigue empieza sin este checklist cerrado.

## Fase 2 — UX de creación de reglas (`web/app.js`)

Puede arrancar en paralelo con la Fase 1 (archivo distinto), pero el punto
4 de su propio checklist depende de que la Fase 1 esté mergeada.

**Archivo:** `web/app.js`, alrededor de `renderAudienceChips`
(`app.js:2600-2627`) y el draft card (`app.js:2239-2247`).

1. Agregar `state.audienceConfirmed = false` al crear un draft nuevo (donde
   sea que `state.draft` se inicializa hoy).
2. En el handler de click de los chips (`host.onclick`, dentro de
   `renderAudienceChips`), setear `state.audienceConfirmed = true` en la
   primera línea, antes de mutar `appliesTo`.
3. Si `state.draftFor`/`lockTo` está seteado (audiencia ya bloqueada por
   contexto), `state.audienceConfirmed` arranca directamente en `true` — no
   hay elección posible, no hay nada que confirmar.
4. En el handler del botón de ratificar: si `!state.audienceConfirmed`,
   no mandar el `fetch` — en cambio, abrir el editor de chips
   (`state.audienceOpen = true`, re-render) y mostrar un `<div class="note">`
   nuevo en el draft card con el texto de advertencia. Mismo patrón visual
   que `#addNote` en People (`app.js:2741`), no un `alert()`.
5. Aviso de inclusión de exento: en `renderAudienceChips`, para cada chip
   cuyo token nombra un rol o `@id` exento (`isExempt` — necesita que el
   cliente tenga la lista de `exemptRoles` de la política actual, que ya
   viaja en `state.policy` si se sigue el patrón de otras vistas; si no
   viaja, agregarlo al payload de `GET /api/policy`), si ese chip está
   activo (`on.has(o.token)`) mostrar el texto aclaratorio al lado del chip
   o debajo de la lista.
6. Prueba manual: crear un draft, no tocar nada, intentar activar →
   aparece el cartel y no se manda el request. Tocar un chip → el cartel
   desaparece y ratificar funciona. Elegir el chip de tu propio rol admin →
   aparece la aclaración de "esto también te va a aplicar a vos".

No hay cambios de servidor en esta fase — `ratifySchema`/`ratifyRule` no
se tocan, siguen aceptando lo que ya aceptan.

## Fase 3 — Presets como datos

Puede arrancar en paralelo con la Fase 1 y la Fase 2.

**Archivos nuevos**, uno por preset, en `data/seed/solo-presets/`. Shape:
`ruleSchema` (`src/policy/types.ts:57-90`) sin `id` ni `appliesTo` (se
completan al activar, ver Fase 4) y sin `embedding` (se genera al indexar,
como cualquier regla ratificada hoy). Primer borrador de los cuatro —
contenido real, no placeholder, para que la Fase 4 tenga algo concreto
contra qué implementar:

```json
// data/seed/solo-presets/credentials.json
{
  "text": "No compartir API keys, tokens de acceso, contraseñas ni credenciales de ningún servicio.",
  "scope": "both",
  "severity": "block",
  "examples": {
    "violating": [
      "acá está mi API key de OpenAI: sk-proj-...",
      "la contraseña del servidor es Xyz123!",
      "pegale este token de AWS al script: AKIA..."
    ],
    "compliant": [
      "¿cómo genero una API key nueva en el dashboard?",
      "¿dónde se guardan las credenciales de forma segura, en un .env o en un secret manager?"
    ]
  },
  "guidance": "Guardá la credencial en un gestor de secretos y compartí una referencia (nombre de la variable, no el valor) si necesitás ayuda con el código que la usa."
}
```

Los otros tres (`payment-data.json`, `customer-info.json`,
`proprietary-code.json`) siguen la misma estructura — mismo nivel de
detalle en `examples`, cubriendo el caso que el PRD nombra en su §3.2
(tarjetas/pagos, información de clientes, código propietario). No se
completan acá con el mismo detalle para no encajar contenido de producto en
un plan de implementación, pero el shape y el estándar de calidad
("`compliant` no vacío, ejemplos concretos, no genéricos") son estos.

**Checklist:**
1. Los 4 archivos parsean contra `ruleSchema.omit({ id: true, appliesTo: true, embedding: true })`
   — agregar ese schema derivado donde se validen al cargar, para fallar en
   build/test si alguno queda con `examples.compliant` vacío o similar
   (`ruleExamplesSchema` ya exige `min(1)` en ambos arrays, así que un
   preset mal escrito ya falla la validación existente sin código nuevo).
2. Cada preset usa un `id` estable y fijo al activarlo (no generado por
   `randomUUID`, a diferencia de `ratifyRule` en el camino normal): por
   ejemplo `solo-credentials`, `solo-payment-data`, etc. — así togglear un
   preset off/on repetidamente no acumula basura de ids viejos, y el toggle
   "on" en `POST /api/solo/presets/:id/toggle` (Fase 4) puede simplemente
   sobreescribir/recrear esa misma entrada.

## Fase 4 — Identidad y endpoints `/api/solo/*`

Depende de Fase 1 (usa el `rulesForActor` nuevo) y Fase 3 (lee los archivos
de preset). No depende de Fase 2.

**Archivo nuevo:** `src/server/solo.ts` (router separado, montado en
`src/server/index.ts` bajo `/api/solo`, siguiendo el patrón de cómo ya se
organizan las rutas existentes) o, si el repo prefiere todo en un archivo,
una sección nueva claramente delimitada dentro de `index.ts` — a decidir
contra el estilo real del archivo al implementar, no algo que este plan deba
fijar de antemano.

Implementar en este orden (cada uno depende del anterior):

1. **`POST /api/solo/setup`** — resuelve el actor actual (loopback o bearer,
   mismo mecanismo que `resolveActor`, `index.ts:2139-2142`). Si ya existe
   un `Employee` para esa identidad (caso A, coexistencia — ya es admin o
   ya tiene una entrada), devuelve esa identidad sin crear nada. Si no
   existe ningún `Employee` en absoluto en el directorio (caso B), hace
   `addRole('solo')` si el rol no existe + `upsertEmployee({ name: 'You', role: 'solo' })`,
   usando `data/company.json` bootstrap mínimo de spec §4 si el archivo ni
   siquiera existe todavía.
2. **`GET /api/solo/presets`** — lee los 4 archivos de Fase 3, resuelve el
   actor, y para cada preset chequea si existe una regla en
   `loadPolicy().rules` con ese `id` fijo y `appliesTo` incluyendo
   `@<id del actor>`.
3. **`POST /api/solo/presets/:id/toggle`** — activar: toma el preset,
   completa `id` (el fijo de Fase 3) y `appliesTo: ["@<id del actor>"]`,
   llama `ratifyRule` (`src/policy/compile.ts:489-528`). Desactivar: llama
   el `DELETE /api/policy/rules/:id` existente con ese mismo id fijo — se
   puede llamar directamente a la función que ya usa esa ruta, no hace
   falta un HTTP round-trip interno.
4. **`GET /api/solo/rules`** — `rulesForActor(loadPolicy(), actor, 'any')`
   filtrado a las que no son presets de sistema (o todas, a decidir en el
   detalle de implementación) + últimos bloqueos desde el store de audit
   (mismo mecanismo que ya usa la consola de equipo para mostrar
   "qué bloqueó y cuándo", `src/audit/`).
5. **`POST /api/solo/rules`** — `compileRule` con `lockTo: ["@<id del actor>"]`
   (el mecanismo `lockTo` que ya existe para reglas iniciadas desde la
   página de una persona, `compile.ts:221-223`, reusado tal cual) seguido
   de `ratifyRule`. Devuelve el mismo tipo de advertencia que ya muestra el
   compilador de equipo para reglas en texto libre.
6. **`POST /api/solo/test`** — corre un prompt fijo de prueba (o uno que
   la UI arme a partir de los `examples.violating` del primer preset
   activo) contra el guard real para esa identidad, devuelve el verdict —
   es la evidencia del paso 4 del PRD §3.

`POST /api/solo/protect` se implementa en la Fase 7, después de que exista
`desktop/` wiring — no tiene sentido antes.

**Checklist:** tests de integración por endpoint (request → response,
contra el server real con `WARDEN_ADAPTER=mock` para setup/presets/toggle,
que no dependen de inferencia real; con `WARDEN_ADAPTER=real` solo para el
smoke test manual de `/api/solo/test`, igual que la Fase 1).

## Fase 5 — Consola "Mis reglas"

Depende de Fase 4 (necesita los endpoints respondiendo).

**Archivo:** `web/app.js` (o un módulo nuevo importado desde ahí, si el
tamaño amerita separarlo — 3400+ líneas en un solo archivo ya es grande,
buen momento para no seguir creciendo ese archivo en particular).

1. `VIEWS.soloRules` — body con los 4 switches de preset, el campo de
   texto libre, la lista de bloqueos recientes, el botón "Proteger este
   equipo" (llama a `POST /api/solo/protect`, todavía no implementado en
   esta fase — dejar el botón deshabilitado con un tooltip hasta la Fase 7,
   o implementar Fase 5 y Fase 7 en el mismo PR si se prefiere no mergear
   un botón roto).
2. Entry en `NAV` (`app.js:582-604`), condicional a si hay coexistencia o
   instalación solo pura — ver spec §7 para el criterio exacto
   (`roles` del `Directory` es `['solo']` a secas → solo esa pestaña).
3. Exclusión del banner de primer-arranque de equipo en `render()`
   (`app.js:507`) para `state.view === 'soloRules'`.
4. Nada de "empleado", "rol", "compañía" en el copy — pasar el archivo por
   una revisión de texto antes de dar la fase por cerrada, no solo por
   funcionalidad (es una métrica de éxito explícita del PRD §5).

## Fase 6 — Primer arranque (`desktop/`)

Puede empezar en paralelo con la Fase 4/5 — es un área de código distinta
(`desktop/` vs `src/server/` + `web/`) — pero converge con ambas en la
Fase 7.

1. Vista nueva en `desktop/splash.html`, antes de `#welcome`
   (`splash.html:93`), con la pregunta "¿Para vos, o vas a controlar un
   equipo?" y sus dos botones.
2. Mensaje IPC nuevo, paralelo a `nextChoice()` (`first-run.ts:41-47`), que
   la elección dispara.
3. `desktop/main.ts` (`main.ts:20,161,215`): antes de llamar
   `ensureModels()`, esperar esta elección. Guardar el resultado (en memoria
   alcanza para v1, no hace falta persistirlo — se vuelve a preguntar solo
   si no hay `company.json`, ver punto 4).
4. Si la máquina ya tiene `company.json` con gente cargada, esta pantalla
   no se muestra — el primer arranque solo bifurca cuando la instalación es
   genuinamente nueva. (Repetir la pregunta a alguien que ya configuró su
   equipo no tiene sentido y contradice la decisión de coexistencia del
   PRD §4.)

## Fase 7 — `POST /api/solo/protect` y confirmación con evidencia

Depende de Fase 4 (identidad + endpoints) y Fase 6 (para el caso B, que la
identidad exista antes de llamar protect).

1. Implementar `POST /api/solo/protect`: arma internamente lo mismo que
   `GET /install/:credential` (`index.ts:1576-1652`) produce como script,
   pero lo ejecuta desde el proceso de la app de escritorio (Node, no
   shell del usuario) — llamar directamente a la lógica que ese handler ya
   tiene factorizada, no invocar el endpoint HTTP contra sí mismo.
2. Conectar el botón "Proteger este equipo" de la Fase 5 a este endpoint,
   seguido automáticamente de `POST /api/solo/test` y el render del
   resultado (paso 4 del PRD §3 — "confirmación con evidencia, no un
   mensaje de listo").
3. Prueba manual, en una máquina/perfil de shell limpio si es posible:
   confirmar que después de "Proteger este equipo", una tool real (Claude
   Code o Codex, lo que esté instalado) efectivamente tiene el hook
   cableado, sin haber tocado una terminal.

## Fase 8 — Verificación end-to-end y cierre

1. Instalación **solo pura**, sin `company.json` previo: desde cero hasta
   ver un bloqueo real, cronometrado — contra la métrica del PRD §5
   ("menos de 5 minutos, sin leer ningún doc"). Si no se cumple, es una
   señal de que alguna fase quedó más pesada de lo que el spec previó, no
   algo que se ignora.
2. Instalación **coexistencia**: una máquina con equipo ya configurado
   (admin + empleados), activar Warden Solo para el admin, confirmar que
   (a) las reglas de equipo siguen sin aplicarle, (b) los presets activados
   sí le aplican, (c) nada de esto afecta lo que ven los empleados.
3. Correr `pnpm run redteam` una vez más sobre el estado final — no debería
   haber sorpresas respecto al delta ya verificado en la Fase 1, pero es la
   corrida que certifica el conjunto, no solo el cambio aislado.
4. Confirmar explícitamente, por escrito en el PR o en `docs/MEASUREMENTS.md`,
   que `docs/HOOK-VERIFICATION.md` sigue en NOT VERIFIED y que Warden Solo
   no se anuncia como "protección confiable" hasta que esa verificación
   exista — heredado de spec §9, no se resuelve en este plan, y es fácil
   olvidarlo en el entusiasmo de cerrar la feature.

## Fuera de este plan (v1 no lo incluye)

Lo que el PRD (§7) y el spec ya dejaron fuera de alcance a propósito, para
que quede escrito en un solo lugar y no se cuele por accidente durante la
implementación: tray/menu bar, migración automática solo→equipo, más de una
identidad personal por instalación, y cualquier exposición de red para el
modo solo (nada de tunnel, nada de LAN — todo `127.0.0.1`, sin excepción).
