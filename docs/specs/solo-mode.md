# Warden Solo — Spec técnico

Sigue a `docs/prd/solo-mode.md`. Acá se cierra lo que ese documento dejó
explícitamente afuera (§8): cómo se modela la identidad, qué cambia en el
servidor, qué pasa con `data/company.json` sin compañía, y el detalle de la
consola "Mis reglas". Las decisiones de producto del PRD (§4, §7) son
insumo fijo acá, no se vuelven a discutir.

Todas las referencias `archivo:línea` son al estado del repo al 2026-09-03.

## 1. Lo que ya existe y no se toca

- `src/guard/`, `src/qvac/`, el invariante `ALLOW < ESCALATE < BLOCK` — cero
  cambios. Warden Solo es superficie, no pipeline.
- El modelo de identidad actual (`Employee`, `src/policy/people.ts:39-46`):
  cuatro campos obligatorios, `id`/`name`/`role`/`apiKey`, sin `companyId`
  porque la pertenencia es 1:1 con la instalación entera — un proceso, un
  `data/company.json`, singleton en memoria (`cached`, `people.ts:95`).
  Warden Solo reusa este mismo tipo, no crea uno nuevo.
- `exemptRoles` sigue siendo una propiedad del **rol**, resuelta en
  `isExempt(spec, role)` (`src/policy/store.ts:302-304`), nunca una propiedad
  de la persona. Esto es la base de la decisión de §2.
- **Excepción declarada:** `rulesForActor` (`src/policy/store.ts:281-299`) sí
  cambia — es el único punto de este spec que toca código ya existente fuera
  de la superficie nueva. Ver §2 para el motivo y el alcance exacto del
  cambio.

## 2. El problema de diseño central: reglas por rol, no un segundo guardia

**Este diseño reemplaza una versión anterior de esta sección** (un segundo
`PolicySpec` en paralelo, con sus verdicts combinados tomando siempre el más
estricto). Esa versión resolvía "protegerme a mí con reglas nuevas" pero no
resolvía lo que en realidad hace falta: que **algunas** reglas de equipo
sigan sin aplicarle al admin (más permisos) mientras **otras**, elegidas a
propósito, sí — un segundo guardia que solo suma nunca puede dar menos
restricciones, y ese era justo el pedido.

`rulesForActor` (`src/policy/store.ts:281-299`) corta temprano:

```ts
export function rulesForActor(spec, actor, side = 'input') {
  if (isExempt(spec, actor.role)) return [];
  return spec.rules.filter((r) => bindsActor(r.appliesTo, actor) && governsSide(r, side));
}
```

La pieza que ya existe y que este diseño explota: cada regla tiene un
`appliesTo` (`src/policy/audience.ts:1-51`) que ya sabe distinguir tres
audiencias — `*` (todos), un rol (`"sales"`), o una persona puntual
(`"@ana"`), en unión. **El sistema ya modela "reglas por rol"** — lo único
que lo bloquea para el admin es que `isExempt` corta *antes* de mirar
`appliesTo` en absoluto, para cualquier rol exento, sin distinguir si la
regla es genérica o si nombra a esa persona a propósito.

**Decisión:** el corte de exención pasa a aplicar solo a las reglas
genéricas (`appliesTo` incluye `*`). Una regla que nombra explícitamente al
rol o a la persona exenta (`"admin"`, `"@gaston"`) sí la evalúa, aunque esa
persona sea exenta del resto.

```ts
// src/policy/store.ts — antes
if (isExempt(spec, actor.role)) return [];
return spec.rules.filter((r) => bindsActor(r.appliesTo, actor) && governsSide(r, side));

// después
const exempt = isExempt(spec, actor.role);
return spec.rules.filter((r) => {
  if (exempt && r.appliesTo.includes(EVERYONE)) return false;
  return bindsActor(r.appliesTo, actor) && governsSide(r, side);
});
```

Consecuencias directas de este cambio, una por una:

- **Cero cambio de comportamiento para políticas existentes.** Toda regla
  hoy vigente usa `*` (genérica, para el equipo) o nombra roles/personas no
  exentas. Ninguna nombra hoy a `admin` ni a un `@id` exento, así que el
  filtro nuevo se comporta exactamente igual que el viejo hasta que alguien
  escriba la primera regla que sí lo haga.
- **"Más permisos" sale gratis.** El admin sigue sin estar alcanzado por
  ninguna regla `*` — eso no cambió. "Tener más permisos" es simplemente no
  escribirle ninguna regla explícita a su propio rol/id.
- **"Solo algunas reglas del team, y algunas propias" se resuelve con la
  misma herramienta.** Una regla de equipo con `appliesTo: ["sales", "admin"]`
  ata a ventas y al admin a la vez; una con `appliesTo: ["sales"]` deja al
  admin afuera, como hoy. "Mis reglas" (los presets de Warden Solo, §5) son
  simplemente reglas con `appliesTo: ["@<id del admin>"]` — ninguna
  necesidad de un segundo `PolicySpec`, un segundo archivo, ni de correr el
  guard dos veces. Una sola política, una sola corrida de guard, el mismo
  `aggregate.ts` de siempre.
- **Por qué es seguro tocar esto:** el comentario original en
  `store.ts:286-297` explica que el corte va antes de `appliesTo`
  específicamente para que una regla `*` no "recapture" en silencio a quien
  ratificó la política. Ese riesgo sigue cubierto — el filtro nuevo solo dice
  que una regla `*` nunca ata a un exento, exactamente como hoy. Lo que se
  agrega es una vía **explícita**, no accidental: solo el admin — la única
  identidad que puede ratificar reglas — puede escribir un `appliesTo` que se
  incluya a sí mismo. Nadie gana la capacidad de ampliar o angostar a quién
  ata una regla salvo quien ya tenía permiso para escribir reglas.
- **Costo real:** ninguna segunda pasada de inferencia, ningún archivo
  nuevo de política. El único costo es de revisión — este cambio toca la
  función que el propio `CLAUDE.md` señala como "la frase más
  security-relevant del spec", así que va acompañado, al implementarlo, de
  una corrida de `pnpm run redteam` antes/después para confirmar que ninguna
  regla existente cambia de verdict (documentado en `docs/MEASUREMENTS.md`
  por convención del repo).

## 2.1 UX de creación de reglas: el selector ya existe, esto es lo que cambia

No hace falta diseñar una pantalla nueva. La consola de equipo ya tiene,
antes de ratificar cualquier regla, un editor de audiencia tipo chips
(`renderAudienceChips`, `web/app.js:2600-2627`): un chip "Everyone" + un
chip por rol + un chip por persona del directorio, togglables, visible en el
draft card (`web/app.js:2239-2247`). El modelo propone una audiencia al
compilar; el admin la puede cambiar tocando chips antes de activar. Eso ya
es "elegí para quién es esta regla, incluido vos mismo".

**El bug que esto destapa:** hoy ese selector te deja tocar el chip "admin"
o el chip con tu propio nombre, la regla se guarda con vos en `appliesTo`,
y aun así **nunca te va a aplicar** — porque `rulesForActor` corta antes de
mirar `appliesTo` para cualquier rol exento, sin excepción. Es un control
que ya existe en la UI y que hoy es un no-op silencioso para el caso que
más importa acá. El fix de §2 es lo que lo hace funcionar de verdad — cero
cambios de UI hacen falta para ese punto puntual, el selector ya sabe
pedirte lo que hace falta, solo que el backend lo ignoraba para exentos.

**Dos cambios de UX nuevos, pedidos en esta sesión:**

1. **Aviso cuando la audiencia incluye a un exento.** Si `appliesTo` (en
   memoria, antes de ratificar) incluye el rol o el `@id` de alguien exento
   (`isExempt(policy, ...)`), el draft card muestra una nota explícita al
   lado del chip tocado — algo como *"esta regla también te va a aplicar a
   vos, aunque seas admin"*. No es un bloqueo, es una aclaración: romper la
   expectativa implícita de "admin = exento de todo" sin decirlo en el
   momento sería confuso, aunque el comportamiento sea correcto.

2. **Elegir audiencia pasa a ser obligatorio, no un default silencioso.**
   Hoy, si nadie toca el selector, `sanitiseAudience`
   (`src/policy/audience.ts:84-95`) cae a `['*']` sin que el admin haya
   decidido nada — deliberado a nivel de schema/compile ("too broad se
   nota y se corrige"), pero eso no debería alcanzar para activar una regla
   sin que un humano la haya mirado. Cambio, solo del lado del cliente
   (`web/app.js`), sin tocar `sanitiseAudience` ni el schema — ese fallback
   se mantiene como defensa de última línea, pero deja de ser alcanzable
   por el camino normal:
   - Se agrega un flag en memoria, `state.audienceConfirmed`, en `false`
     por cada draft nuevo.
   - Tocar cualquier chip (incluido volver a confirmar lo que el modelo ya
     propuso) lo pone en `true`.
   - El botón de ratificar, si `state.audienceConfirmed` es `false`, no
     manda el request: abre el editor de chips si estaba cerrado y muestra
     un cartel de advertencia inline (mismo estilo que `#addNote` en
     People, `web/app.js:2741`) — *"Elegí a quién le aplica esta regla
     antes de activarla"*. No es un `alert()` del navegador, es un mensaje
     en la misma tarjeta, consistente con el resto de la consola.
   - Cuando el draft viene con `lockTo` (bloqueado, iniciado desde la
     página de una persona — `web/app.js:2181`), la audiencia ya está
     decidida por contexto y el flag arranca en `true`: no hay nada que
     confirmar, ya es explícito por construcción.

En Warden Solo esto no aplica al camino de presets (§5) — ahí `appliesTo`
ya viene fijo a `["@<id>"]` del lado del servidor, no hay elección posible
ni falta hacerla. Si aplica al campo de texto libre del PRD (§3.2): mismo
mecanismo, mismo cartel, aunque en ese caso la única audiencia posible sea
"vos mismo", así que en la práctica el cartel casi no debería aparecer.

## 3. Identidad

Con el diseño de §2, la identidad ya no necesita resolver el problema de la
exención — eso lo resuelve `appliesTo` regla por regla. Quedan dos casos
distintos:

**Caso A — coexistencia (ya sos admin de un equipo en esta máquina).** No
hace falta ninguna identidad nueva. "Mis reglas" son reglas normales,
ratificadas contra la misma `Employee` que ya tenés como admin, con
`appliesTo: ["@<tu id>"]`. Activar un preset (§5) es literalmente ratificar
una regla más en la misma política de siempre — el admin ya tiene permiso
para eso, es lo que hace hoy para el equipo.

**Caso B — instalación solo, sin equipo.** No existe ningún `Employee`
todavía. Se crea uno vía la infraestructura existente —
`addRole('solo')` + `upsertEmployee({ name: 'You', role: 'solo' })`
(`src/policy/people.ts`), la misma ruta que ya usa la consola de admin para
dar de alta gente. El rol `'solo'` es un nombre arbitrario, no un caso
especial en el schema (`role` sigue siendo string libre en `Employee`) — lo
único que importa es que nunca se agrega a `exemptRoles`, así que las reglas
`*` (incluidos los presets si se activan sin scope explícito) ya lo
alcanzan sin necesitar `appliesTo: ["@id"]`. Igual se usa `@id` explícito
para los presets (§5) por consistencia con el caso A y para que, si esa
instalación crece a equipo más adelante, agregar gente no le sume de
golpe las reglas personales de quien la instaló.

**Cómo se decide cuál caso es, en la práctica (encontrado durante
implementación, no estaba resuelto acá):** la consola no tiene sesión ni
login — confía en loopback y nunca supo, para ninguna otra acción de admin,
qué humano puntual está del otro lado. `resolveSoloIdentity()`
(`src/server/routes/solo.ts`) no intenta resolverlo tampoco: busca en el
directorio a quién sea exento (`isExempt`); si hay exactamente uno, es el
caso A y esa es la identidad. Si no hay ninguno, es el caso B — usa o crea
la identidad de rol `solo`. Si hay más de un exento (multi-admin), toma el
primero por id, determinístico — una limitación real que este documento no
resuelve, no un intento de adivinar cuál de varios admins está mirando la
pantalla.

La `apiKey` generada (en cualquiera de los dos casos, si hace falta
generarla) se guarda solo en:
- `data/company.json` (como cualquier `Employee`), y
- el shell profile del usuario, vía el mismo mecanismo de
  `/install/:credential` (`buildInstallScript` en `src/server/routes/install.ts`) — pero invocado
  internamente por la app, no por un link que el usuario pega a mano
  (ver §6).

## 4. Bootstrap sin compañía (`data/company.json`)

`data/company.json` no tiene modo "vacío" hoy — `directorySchema` exige
`roles: string[]` con mínimo 1 elemento (`people.ts:48-86`), y no hay
verificación existente de "instalación sin compañía" en ningún flujo actual.

**Decisión:** al elegir "Para mí" en un primer arranque sin `company.json`
previo, la app escribe un `Directory` mínimo:

```json
{
  "name": "",
  "description": "",
  "roles": ["solo"],
  "employees": [{ "id": "...", "name": "You", "role": "solo", "apiKey": "..." }]
}
```

No hay bandera "sin compañía" en el schema ni falta agregarla — un
`Directory` con un solo rol y un solo empleado ya es, estructuralmente, una
instalación sin equipo. La consola "Mis reglas" (§7) nunca lee `name`ni
`description` de este archivo, así que quedar en `""` no tiene efecto de UI.
Si más adelante esa misma persona configura equipo (coexistencia, PRD §4),
el mismo archivo se extiende con más roles/empleados sin migración — es el
shape que ya existe hoy.

**Simplificación encontrada durante implementación:** no hace falta escribir
este `Directory` mínimo a mano. `loadDirectory()` (`src/policy/people.ts`)
ya devuelve un `EMPTY` (`roles: ['admin', 'employee']`, sin empleados)
cuando el archivo no existe, en vez de tirar una excepción — así que
`addRole('solo')` + `upsertEmployee(...)` funcionan tal cual sobre una
instalación sin `company.json` todavía, sin ningún caso especial en
`/api/solo/setup`. El archivo termina con `roles: ['admin', 'employee', 'solo']`
en vez del `['solo']` de arriba — una diferencia cosmética, no funcional:
nadie tiene esos otros dos roles, así que no cambian nada de lo que el
guard evalúa.

## 5. Presets de reglas

Decisión ya cerrada (PRD §7.2): JSON escrito a mano, nunca compilado en
runtime ni en build. Viven como archivos fijos versionados:

```
data/seed/solo-presets/
  credentials.json
  payment-data.json
  customer-info.json
  proprietary-code.json
```

Cada archivo es un `Rule` completo en el shape que ya consume el guard
(mismo tipo que `src/policy/types.ts`, mismo shape que produce
`ratifyRule` hoy), salvo que su `appliesTo` viene vacío en el archivo fuente
y se completa recién al activarlo. Al activar el switch de un preset en la
UI, el servidor lee el archivo correspondiente, le fija
`appliesTo: ["@<id del actor>"]` (el id de quien está activando el preset —
el admin en el caso A de §3, la identidad `solo` en el caso B) y lo escribe
en **la misma política de equipo** (`data/policies.json`, la de siempre) vía
`ratifyRule` (`src/policy/compile.ts:489-528`), sin pasar por `compileRule`
en ningún punto de este camino. No hay archivo ni store separado — es el
resultado directo de la decisión de §2: una sola política, reglas que se
diferencian por a quién apuntan. Desactivar el switch borra esa entrada con
el mismo endpoint que ya existe hoy, `DELETE /api/policy/rules/:id`
(`src/server/routes/policy.ts`).

El campo de texto libre que el PRD deja disponible (§3.2, "para quien quiera
agregar una propia") sí pasa por `compileRule` — hereda el riesgo ya
documentado (bug de redacción en primera persona) y se le muestra al usuario
la misma advertencia que hoy tiene el compilador de equipo. No es parte del
camino principal, así que no bloquea la métrica de éxito del PRD.

## 6. Endpoints

Todos nuevos, bajo un prefijo separado. Operan sobre la misma política que
`/api/policy/*` — no hay un store distinto que administrar — pero se
mantienen como rutas propias porque el filtro por "reglas que son mías" y el
`appliesTo` fijo al propio id son un detalle que la UI de Warden Solo no
debería tener que reconstruir contra la API genérica de equipo.

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/solo/setup` | Idempotente, se llama siempre — la UI no necesita saber de antemano si es caso A o B. Si ya existe una identidad para el actor actual (caso A, coexistencia), la devuelve sin tocar nada; si no existe ninguna (caso B), crea rol `solo` + `Employee`. |
| `GET` | `/api/solo/presets` | Lista el catálogo compartido `data/seed/presets.json` agrupado por categoría (desde 2026-09-04; antes eran 4 archivos propios en `solo-presets/`) con su estado (activo/inactivo) para el actor actual — activo si ya existe en `data/policies.json` una regla derivada de ese preset con `appliesTo` incluyendo `@<id del actor>`. |
| `POST` | `/api/solo/presets/:id/toggle` | Activa/desactiva un preset contra la política de equipo — mecanismo en §5. |
| `POST` | `/api/solo/rules` | Variante de `/api/policy/draft` + `/api/policy/ratify` con `appliesTo` fijo a `["@<id del actor>"]` — para el campo de texto libre. |
| `GET` | `/api/solo/rules` | Reglas con `appliesTo` incluyendo al actor actual + qué bloquearon y cuándo (para la vista "Mis reglas", §7). |
| `POST` | `/api/solo/protect` | Orquesta la instalación: internamente arma la URL de `/install/:credential` con la key del actor y la ejecuta en el proceso de la app (no en el navegador) — esto es lo que la UI llama "Proteger este equipo". |
| `POST` | `/api/solo/test` | Corre un prompt de prueba real contra los presets activos y devuelve el bloqueo — respalda el paso de "confirmación con evidencia" del PRD (§3.4). |

`/api/solo/protect` reusa `/install/:credential` tal cual existe
(`buildInstallScript`, `src/server/routes/install.ts`) en vez de reimplementar el auto-wiring:
la única diferencia con el flujo de equipo es que nadie copia/pega un
link — la app conoce la credencial porque la generó ella misma un paso
antes, en `/api/solo/setup`.

**Encontrado y corregido durante implementación:** `gatewayUrl(req)` (la
función que arma la URL para el link de equipo) prefiere a propósito una
dirección LAN sobre `localhost`, porque ese link lo lee un teammate en otra
máquina. Usarla tal cual acá hubiera generado un script que le habla a la
IP de red en vez de a `127.0.0.1` — exactamente la exposición que el PRD
(§2) dice que este modo no tiene. `/api/solo/protect` arma la URL a mano,
siempre `http://localhost:${PORT}`, sin pasar por `gatewayUrl`.

## 7. Consola "Mis reglas"

Confirmado viable sin fricción: `web/app.js` es un router por hash sin
build step (`app.js:317-343`), con vistas registradas como propiedades de
un objeto `VIEWS` (`app.js:897` en adelante) — cualquier key nueva ahí ya es
una ruta válida, no hace falta tocar el router.

- Vista nueva: `VIEWS.soloRules` — archivo separado o sección propia dentro
  de `app.js`, pero **sin compartir DOM ni copy** con `VIEWS.people`,
  `VIEWS.policy` ni `VIEWS.engine`. Nada de la palabra "empleado", "rol" o
  "compañía" en su `body()`.
- Contenido: los 4 switches de preset (§5), el campo de texto libre con su
  advertencia, la lista de bloqueos recientes (`GET /api/solo/rules`), y el
  botón único "Proteger este equipo" (`POST /api/solo/protect` → luego
  `POST /api/solo/test` para la confirmación con evidencia).
- `render()` (`app.js:507`) antepone hoy el banner de primer-arranque de
  equipo y el banner de modo mock a toda vista. Para `soloRules` se excluye
  el primero explícitamente (chequeo de `state.view === 'soloRules'` antes
  de insertarlo) — el segundo (modo mock) se mantiene, porque sigue siendo
  relevante: un usuario en modo mock necesita saber que no hay protección
  real, sea cual sea el modo de producto.
- Navegación: si la instalación es "solo" pura (sin equipo — `roles` del
  `Directory` es exactamente `['solo']`), el rail lateral (`NAV`,
  `app.js:582-604`) muestra únicamente esta vista y ninguna otra pestaña de
  equipo. Si hay coexistencia (PRD §4 — un admin con equipo Y reglas
  personales), "Mis reglas" aparece como una pestaña más junto a las
  existentes.

## 8. Primer arranque: dónde va la bifurcación

Contra lo que asume el PRD (§3, que la ubica en `desktop/first-run.ts`): ese
archivo hoy es exclusivamente la máquina de estados de descarga de modelos
(`SetupState`: `welcome` → `downloading` → `starting` → `error`,
`first-run.ts:30-34`), agnóstica a identidad. No es el lugar correcto.

**Decisión:** la bifurcación "¿Para vos, o vas a controlar un equipo?" es
una fase nueva, orquestada desde `desktop/main.ts` (que ya llama a
`ensureModels()`, `main.ts:20,161,215`), mostrada **antes** de la pantalla
`welcome` de descarga de modelos — para que el texto de esa pantalla
("esto va a bajar X GB") ya pueda ajustar su copy según el camino elegido,
en vez de mostrar lenguaje genérico y bifurcar después. Requiere:
- Una vista nueva en `desktop/splash.html` (que ya sirve `#welcome`,
  `splash.html:93,131,149-160`).
- Un mensaje IPC nuevo (paralelo a `nextChoice()`,
  `first-run.ts:41-47`) que la elección del usuario dispare, y que
  `main.ts` use para decidir si al terminar `ensureModels()` abre la
  consola completa o llama `POST /api/solo/setup` y abre directo en
  `#soloRules`.

## 9. Qué no cambia

- **La única excepción de todo este documento:** `rulesForActor`
  (`src/policy/store.ts:281-299`) sí cambia — ver §2. Es deliberado y está
  acotado a esa función; en implementación va acompañado de una corrida de
  `pnpm run redteam` para confirmar que ninguna regla existente cambia de
  verdict antes de mergear.
- `aggregate.ts`, todo `src/guard/`, todo `src/qvac/`, el invariante
  `ALLOW < ESCALATE < BLOCK`: cero cambios.
- `bin/warden-hook.mjs` y el mecanismo `--fix`: cero cambios. Ya asumen
  `WARDEN_API_KEY`/`WARDEN_URL` en el entorno y auto-detectan herramientas
  instaladas (`warden-hook.mjs:33-34`, `:840+`) — exactamente lo que
  `/api/solo/protect` necesita, reusado tal cual.
- Adaptadores `src/qvac/*`: sin cambios. Warden Solo corre sobre `real` como
  cualquier instalación; el riesgo heredado de modelos on-device (PRD §6) se
  comunica en la UI, no se resuelve acá.
- `docs/HOOK-VERIFICATION.md`: sigue NOT VERIFIED, se hereda tal cual dice
  el PRD §6 — este spec no agrega ni quita verificación end-to-end.

## 10. Fuera de este documento

Orden exacto de pantallas y wireframes de `desktop/splash.html` y de la
vista `soloRules`, el detalle del payload de cada endpoint nuevo (bodies,
códigos de error), y el orden de trabajo (qué se construye primero, qué se
puede paralelizar) — eso es `docs/implements/solo-mode.md`, el siguiente
documento de esta serie.
