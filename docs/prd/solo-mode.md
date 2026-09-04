# Warden Solo — PRD

Nombre de trabajo: **Warden Solo**. Es el primer tercio de un plan en dos partes
— este documento cubre solo esto. El modo equipo (onboarding de empleados) es
un PRD aparte, después, y comparte motor pero no comparte flujo de producto.

## 0. Por qué existe este documento

Warden hoy tiene un solo modelo mental: administrador que gobierna empleados.
Todo lo que se instala, se explica y se mide asume eso — directorio de
personas, roles, `exemptRoles`, tokens de instalación por persona, alcance de
red para que un tercero llegue al gateway.

Ese modelo no tiene un caso "soy una sola persona y quiero que esto me proteja
a mí". Existe de hecho — probado en vivo el 2026-09-03 — pero solo entrando por
la puerta de atrás: el operador se da de alta como `admin` (con lo cual queda
**exento de sus propias reglas**, el resultado opuesto al que buscaba), y para
quedar efectivamente gobernado tiene que crear una segunda identidad no-exenta
y usar esa key en su propia herramienta. Ningún documento del repo explica este
paso; se reconstruyó leyendo `admin-auth.ts`, `policy/types.ts` y
`onboarding/index.ts`.

Ese hueco es el problema que resuelve Warden Solo: alguien baja Warden **para
sí mismo** — bloquear que información no salga de su compu vía Claude Code,
Codex, Cursor, etc. — sin tener que entender compañías, roles ni exenciones.

## 1. Usuario y trabajo a resolver

**Usuario:** una persona individual — dev freelance, alguien con acceso a
datos sensibles, cualquiera que use un asistente de IA y no confíe en no
pegarle algo que no debería. No es IT, no administra a nadie más.

**Job:** "Instalo algo una vez, en mi compu, y a partir de ahí lo que le mando
a Claude/Codex queda revisado antes de salir — sin que yo tenga que armar un
directorio de personas ni entender qué es un rol exento."

**No es:** una versión reducida del modo equipo. Es el mismo motor de guardia
(`src/guard/`) con una superficie de producto distinta — el modo equipo se
construye encima de este, después, no al revés.

## 2. Qué no es (alcance v1)

- No hay directorio de personas, ni pantalla de "People", ni concepto de rol
  visible.
- No hay exposición de red: nada de tunnel, nada de LAN. Todo corre y se
  consume en `127.0.0.1`.
- No reemplaza el modo equipo ni la consola de administración actual — convive
  como un segundo modo de arranque de la misma app.
- No resuelve `docs/HOOK-VERIFICATION.md` (NOT VERIFIED) — lo hereda tal cual.
  Ver riesgos (§7).

## 3. Experiencia deseada

Punto de entrada: primer arranque de la app de escritorio, antes de la
pantalla de bienvenida que hoy ya existe ahí. Dónde exactamente vive esa
bifurcación en el código queda para el spec técnico — la primera revisión de
este documento asumía `desktop/first-run.ts`, y no es ahí (ver spec §8).

1. **"¿Esto es para vos, o vas a controlar un equipo?"** — dos botones. Elegir
   "Para mí" entra al camino que describe este documento; el otro entra al
   camino existente hoy (consola completa, People, etc.), sin cambios.
2. **Reglas por defecto, no redacción en blanco.** Un puñado de categorías
   preescritas y activables con un switch — credenciales/API keys, tarjetas y
   datos de pago, información de clientes, código propietario. Cada una ya
   viene compilada y verificada por nosotros, no depende de que el modelo
   local de 1.7B entienda la redacción de un usuario en el momento — que es
   justo el bug ya encontrado (`no quiero que...` se rechaza con motivo vacío;
   `nadie puede...` compila bien). Un campo de texto libre queda disponible
   abajo para quien quiera agregar una propia, con la misma advertencia que
   hoy tiene el compilador.
3. **Un solo botón: "Proteger este equipo".** Corre el equivalente de
   `--fix`: detecta qué hay instalado (Claude Code, Codex, Cursor si están) y
   les instala el hook o la config de proxy, sin pedir tokens ni URLs — la
   identidad ya existe localmente, la genera la app misma.
4. **Confirmación con evidencia, no un mensaje de "listo".** Corre un prompt
   de prueba real contra una de las reglas activadas y muestra el bloqueo,
   igual que el bloque de la consola actual — la misma prueba que se hizo a
   mano en esta sesión, pero integrada al flujo.
5. **De ahí en adelante, una consola reducida:** "Mis reglas" (activar,
   desactivar, ver qué bloqueó y cuándo) en vez de la consola de administración
   completa. Sin People, sin roles, sin la palabra "empleado" en ningún lado.

## 4. Decisiones de producto

- **Identidad interna:** una sola identidad local, creada por la app al elegir
  "Para mí", **nunca** con rol exento. Los detalles de cómo se modela
  (reusar `Employee` con un rol fijo vs. un tipo nuevo) quedan para el spec
  técnico — acá lo que se fija es el comportamiento: la persona que instala
  Warden Solo queda gobernada por sus propias reglas, sin excepción ni paso
  manual.
- **Reglas por defecto sobre redacción libre.** Se prioriza esto porque ya
  hay evidencia de que la redacción libre en el compilador local es frágil
  (la fórmula de la frase cambia el resultado). Presets curados y verificados
  de antemano bajan esa superficie de falla a cero para el camino principal.
- **Sigue siendo local, sigue siendo el mismo motor.** No se toca
  `src/guard/`, `src/qvac/`, ni el invariante `ALLOW < ESCALATE < BLOCK`. Este
  PRD es enteramente de superficie de producto (onboarding + UI), no de
  pipeline de decisión.
- **La app de escritorio es el vehículo, no una build separada.** Un mismo
  instalador, una bifurcación en el primer arranque. Evita mantener dos
  distribuciones.
- **No es un upgrade path, es coexistencia.** "Para mí" y modo equipo no son
  pasos secuenciales de una misma escalera — son dos capacidades que conviven
  en la misma persona. Un admin puede tener sus propias "Mis reglas" activas
  (protegiéndolo a él) **y al mismo tiempo** administrar las reglas del
  equipo, sin que activar una obligue a desinstalar la otra ni que una se
  convierta en la otra. Esto además resuelve de raíz el problema de §0: hoy
  el admin está exento de las reglas del equipo por diseño (`exemptRoles`);
  la resolución elegida hace que "Mis reglas" se le sigan aplicando a él
  aunque sea exento como admin de equipo, sin dejar de ser exento de las
  reglas genéricas del equipo — el mecanismo exacto (una sola política,
  reglas que declaran explícitamente a quién atan) queda para el spec
  técnico, pero el comportamiento que se fija acá es el mismo: nunca uno
  reemplaza al otro.

## 5. Métricas de éxito

- De "abrir el instalador" a "vi un bloqueo real de una regla mía" en menos de
  5 minutos, sin leer ningún doc.
- Cero apariciones de "empleado", "compañía" o "rol" en el flujo de setup de
  este modo.
- El bug de redacción en primera persona (§0) deja de ser alcanzable desde
  este flujo, porque no hay redacción libre en el camino principal.

## 6. Riesgos heredados (no los resuelve este PRD, pero aplican igual)

- **El hook sigue NOT VERIFIED end-to-end** (`docs/HOOK-VERIFICATION.md`).
  Warden Solo no debería anunciarse como "protección confiable" hasta que esa
  verificación se cierre — instalarlo hoy da la misma cobertura real que tiene
  el modo equipo hoy, ni más ni menos.
- **Fail-open por timeout** sigue siendo el comportamiento: una decisión que
  tarda más del deadline deja pasar el prompt sin revisar. Para un usuario
  solo esto importa tanto como para un empleado — hay que decidir si se
  comunica en el flujo de onboarding (recomendado) o se deja implícito como
  hoy.
- **Modelos on-device (~1.8GB) siguen siendo necesarios** para que esto sea
  real y no el adaptador mock — el primer arranque tiene que dejarlo claro
  antes del botón "Proteger este equipo", no después.

## 7. Decisiones resueltas (cierre de las preguntas abiertas)

1. **Consola reducida:** vista nueva y separada, no la consola de admin con
   cosas ocultas. Componente propio, sin ningún rastro de conceptos de equipo
   en el DOM ni en el código que la sirve.
2. **Presets de reglas:** se escriben directo en JSON, a mano, en el mismo
   formato que ya consume el guard (`severity`, `violating`, `compliant`,
   etc.) — salvo `appliesTo`, que se completa recién al activar el preset,
   apuntado a quien lo activa (detalle en el spec técnico). Nunca pasan por
   el compilador de IA — ni al crearlos ni en runtime. Viven como archivos
   fijos versionados en el repo. Esto es lo que en la práctica hace cero la
   superficie de falla del bug de redacción del §0/§4 para el camino
   principal: no hay redacción de por medio.
3. **Relación con modo equipo:** no es upgrade, es coexistencia — ver §4.
   "Mis reglas" y las reglas de equipo son conjuntos independientes que un
   mismo admin puede tener activos a la vez.
4. **Tray/menu bar:** no hace falta en v1. La ventana actual de Electron
   alcanza; no se toca el ciclo de vida ni el packaging por esto.

## 8. Fuera de este documento

Cómo se modela la identidad internamente, qué endpoints cambian o se agregan,
qué pasa con `data/company.json` cuando no hay compañía, y el detalle de la UI
reducida — eso es contenido de `docs/specs/solo-mode.md`, el siguiente
documento de esta serie.
