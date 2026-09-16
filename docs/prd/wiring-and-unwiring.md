# Conectar y desconectar Warden: dos caminos y un interruptor — PRD

Cubre cómo Warden entra a una máquina, cómo se sabe que entró, y cómo se sale.
Separa en dos flujos lo que hoy es uno solo — protegerme a mí mismo y gobernar
a un equipo — y le da a cada uno su propio estado visible y su propia forma de
apagarse.

A diferencia de la serie del rediseño, **este documento sí toca `src/`**: un
interruptor que solo existe del lado del gateway no se puede implementar en
`web/`. El spec técnico fijará el alcance exacto.

## 0. Por qué existe este documento

El 2026-09-15, durante la sesión que cerró el rediseño, **el propio Warden
bloqueó todos los prompts del dueño de Warden**. La secuencia completa:

- **Hay dos Warden en esa máquina.** La app empaquetada
  (`/Applications/Warden.app`), corriendo desde hacía días con sus datos en
  `~/Library/Application Support/Warden/data/`, y el repo de desarrollo con los
  suyos en `operations-aleph/data/`. Son dos directorios de personas distintos
  y **los dos quieren el puerto 8080**.
- La `WARDEN_API_KEY` del dueño, `wk-you-…`, es perfectamente válida — en la
  app. El directorio del repo nunca la tuvo.
- Se levantó un gateway de desarrollo para mirar la consola nueva. El hook,
  que apunta a `localhost:8080` y no tiene forma de saber a cuál de los dos le
  está hablando, le habló al equivocado.
- Clave desconocida → `UNKNOWN_KEY` (`src/server/identity.ts:27`) → el hook
  frenó cada prompt en su terminal.
- El mensaje dijo *"Ask your administrator for a current one"*. El dueño **es**
  el administrador, y su clave no tenía nada de malo.
- La única salida que encontró, y no por primera vez, fue matar el gateway —
  que no arregla nada: explota el fail-open del hook.

**Nada estaba roto: estaba hablando con el Warden equivocado, y ninguna de las
dos pantallas se lo podía decir.** Media hora después, con la app respondiendo
otra vez, el mismo hook bloqueó un prompt por una regla de credenciales —
funcionando exactamente como debe. Entre un bloqueo legítimo y hablarle a otra
instalación, lo único que cambia es un texto en la terminal.

Ninguna de las piezas está rota por separado. El problema es lo que falta
entre ellas:

- **No existe la desconexión.** El hook tiene `--detect` y `--fix`
  (`integrations/warden-hook.mjs:1150`); el mapa de reparadores
  (`:932`) no tiene contraparte. No hay `--unfix`, ni ruta de API, ni botón.
  **Warden sabe cablearse solo y no sabe descablearse.** La salida es editar a
  mano entre dos y cuatro archivos del home, sabiendo primero que existen.
- **La consola no dice si el hook está puesto.** This device reporta tres
  estados por herramienta (`web/js/solo.js:79`) y el del medio — *"Installed ·
  not judged by Warden yet"* — mezcla dos situaciones opuestas: *cableada y
  todavía sin tráfico* y *no cableada en absoluto*. Lo que se muestra es
  **tráfico observado, no cableado**, y son cosas distintas. `--detect` ya sabe
  la respuesta; nadie se la pregunta.
- **Los dos caminos son el mismo script.** `buildInstallScript(identity, url)`
  sirve igual a `/api/solo/protect` (`src/server/routes/solo.ts:223`) y al
  onboarding de un empleado (`src/server/routes/install.ts`). Por eso un solo
  texto de error tiene que servir a los dos, y termina siendo correcto para el
  empleado y absurdo para el dueño.
- **La clave vive en hasta cuatro lugares** — perfil de shell más el bloque
  `env` de cada herramienta (`install.ts:107-121`, `warden-hook.mjs:722`) —
  y nada verifica que coincidan. La deriva es cuestión de tiempo.
- **La pantalla puede estar hablando de otra identidad que la del teclado.**
  `resolveSoloIdentity()` (`src/server/routes/solo.ts:62`) devuelve **el primer
  empleado exento por orden alfabético de id**, no a quien pertenece la clave
  con la que esa persona trabaja. En el directorio donde apareció este problema
  eso significa que This device mostraba las reglas de *"Gastón (operador del
  gateway)"* mientras la terminal mandaba `wk-you-…`: dos identidades, una
  pantalla, y nada que lo dijera.
- **Entrar a This device no propone un camino.** No hay un orden de pasos ni
  una tarea siguiente: hay un botón que corre un script y una tabla que
  después no confirma si sirvió. Quien llega sin saber qué es un hook no tiene
  de dónde agarrarse.

## 1. Usuario y trabajo a resolver

**Autoaplicarse Warden y gobernar a un equipo son dos usos distintos, no dos
etapas del mismo** (decisión del dueño, 2026-09-15). Hoy el código los trata
como etapas: `soloIsPureInstall()` (`web/js/nav.js:66`) define "solo" como *un
directorio al que todavía nadie agregó gente*, y de ahí sale que sumar a la
primera persona cambie lo que el dueño ve y deje su propia identidad sin lugar.
Conviven: alguien puede querer que Warden mire lo que él mismo escribe **y**
gobernar a diez personas, y ninguna de las dos cosas es un paso hacia la otra.

Dos trabajos distintos, entonces, que hoy comparten una sola mecánica:

- **Quien se protege a sí mismo** (solo, o el admin en su propia máquina):
  *"quiero que Warden mire lo que escribo — y quiero poder apagarlo un rato
  sin desinstalar nada"*. Es juez y juzgado a la vez; no le debe permiso a
  nadie.
- **Quien gobierna un equipo**: *"quiero saber en qué máquinas está puesto
  Warden, si sigue vivo, y poder eximir a alguien puntualmente sin pedirle que
  edite archivos"*. Decide sobre otros, y por eso lo que haga tiene que quedar
  registrado.

## 2. Qué no es (alcance)

- **No es un mecanismo anti-evasión.** El hook vive en el home del empleado,
  en archivos que el empleado edita. Fingir que no puede sacarlo sería teatro,
  y este repo no hace teatro (el hook falla abierto y `SECURITY.md` lo dice en
  voz alta). Lo que sí se puede es **hacerlo visible**, y eso es lo que se
  diseña acá.
- **No toca cómo se juzga.** Ni el pipeline del guard, ni `aggregate`, ni los
  modelos, ni el orden de los pases. El invariante de veredictos no se mueve.
- **No reemplaza `exemptRoles`.** Ese campo es la autenticación de admin
  (`src/server/admin-auth.ts`) y CLAUDE.md prohíbe poner una segunda noción de
  admin al lado. Pausar a alguien **no** es hacerlo exento: son ejes
  distintos y el spec los mantiene separados.
- **No agrega dependencias** ni cambia el stack de la consola.

## 3. Experiencia deseada

**Dos caminos con nombre propio, desde el primer clic.** La consola deja de
ofrecer "instalar Warden" a secas y ofrece dos cosas que se leen distinto:
*proteger esta máquina* (This device) y *conectar a alguien del equipo*
(Team). Cada uno con su copy, su confirmación y su estado.

**Un estado que se puede creer.** Cada herramienta muestra dos hechos
separados, porque son dos hechos: **si está cableada** y **si llegó tráfico**
(lo que ya se muestra hoy). Las combinaciones dicen cosas distintas y
accionables: cableada sin tráfico es normal recién instalada y sospechosa a la
semana; sin cablear es una tarea pendiente, no un estado de espera.

**Las máquinas tienen nombre.** Cada pedido dice de qué equipo vino, así que
la consola lista los dispositivos de cada persona en vez de hablar de "Ana" en
abstracto. Es lo que vuelve honesto todo lo demás: sin esto, "cableada" y
"desconectar" son afirmaciones sobre algo que el gateway no puede distinguir.

**This device habla de esta computadora y de nada más.** Las herramientas, su
cableado y el interruptor. La dirección pública y los datos en disco son
propiedades del gateway — del servicio — y se mudan a donde se hable de él.

**Y propone un camino, no un tablero.** La pantalla tiene una tarea siguiente
visible en cada estado: sin cablear, es cablear; recién cableado, es escribir
la primera regla dirigida a uno mismo; funcionando, es el estado y el
interruptor. Quien entra sin saber qué es un hook debe poder salir protegido
siguiendo lo que la pantalla le propone, sin buscar documentación.

**Y dice de quién está hablando.** La identidad que la pantalla muestra se
nombra, porque puede no ser la de la clave con la que esa persona trabaja.

**Dos interruptores, porque son dos cosas:**

- **Pausar** — decisión del gateway: Warden deja de juzgar a esa identidad y
  deja pasar sus pedidos, registrándolo. Es instantáneo, reversible, no
  requiere tocar la máquina del otro, y sirve tanto para uno mismo ("apagalo
  media hora") como para un empleado ("está debuggeando, eximilo hoy").
- **Desconectar** — decisión local: sacar el hook de las herramientas de
  *esta* máquina. Es la salida completa, solo la puede ejecutar quien está
  sentado ahí, y es lo que hoy no existe.

**Una salida del pozo.** Cuando el gateway no reconoce una clave, el hook no
deja a la persona adivinando: dice qué gateway la rechazó, y **si ese gateway
está en la propia máquina, dice que abra la consola y reclame una clave** en
lugar de mandarla a buscar un administrador que es ella misma.

**Y cada Warden dice cuál es.** Una instalación tiene nombre y el hook lo
repite cuando rechaza algo, porque "no reconozco tu clave" y "le estás
hablando a otra instalación" son el mismo mensaje hoy y son problemas
distintos. Dos gateways peleando por un puerto es una situación normal en la
máquina de quien desarrolla Warden, y va a serlo para cualquiera que pruebe
una versión nueva al lado de la que usa.

## 4. Decisiones de producto

- **Dos pantallas, una identidad.** La separación entre autoaplicarse y
  gobernar vive en la interfaz: This device es la máquina del que administra,
  Team es la de los demás. Abajo hay una sola persona en el directorio, con su
  máquina cableada como la de cualquiera, que además tiene permisos de admin.
  Se descartó darle a la máquina una identidad propia paralela al directorio:
  son dos credenciales para la misma persona, y una de ellas quedando huérfana
  es exactamente el bug del §0.
- **Un admin se autoaplica con reglas dirigidas a él.** Hoy ser admin es estar
  exento, y estar exento significa que las reglas de toda la empresa (`*`) no
  te atan; las que nombran a una persona o a un rol sí, exento o no. Así que
  autoaplicarse funciona, pero solo con reglas escritas hacia uno mismo. No se
  toca el motor: separar "admin" de "exento" crearía la segunda noción de admin
  que CLAUDE.md prohíbe, y hacer que las reglas `*` aten a los exentos cambia
  cómo se elige la política de cada persona, que es el guard y no la consola.
- **Y por lo tanto: cablear la máquina de un exento sin decírselo es prometer
  una protección que no se está dando.** Alguien se autoaplica Warden, cablea
  su máquina, y no se dispara nada nunca, porque todas sus reglas son de
  empresa y él está exento. Es el mismo género de silencio que este documento
  existe para eliminar. This device tiene que decirlo **en el momento de
  cablear**, y decir qué hacer: escribir una regla dirigida a uno mismo.
- **Un empleado que se desconecta se ve; no se impide.** Es la decisión más
  importante del documento. Impedirlo es imposible y prometerlo sería mentir;
  lo que Warden debe garantizar es que irse **no sea silencioso**. Como dice
  `src/policy/activity.ts`: *un directorio lleno de gente cuyas herramientas
  nunca se cablearon es un gateway que no gobierna a nadie mientras aparenta
  estar desplegado*. Esa frase ya está en el código y es exactamente el estado
  que hay que volver imposible de no ver.
- **Pausar deja pasar, y queda en el registro.** Un pedido no juzgado por
  pausa entra al audit log diciendo eso — no desaparece ni se disfraza de
  permitido. Es la superficie más delicada del documento: es el único camino
  nuevo donde una request pasa sin ser juzgada, y por eso es administrativo,
  explícito, con fecha, y visible en la consola mientras dure.
- **Pausa y exención son ejes distintos.** Exento = a qué reglas estás sujeto
  (y hoy, además, si sos admin). Pausado = si Warden está mirando. Mezclarlos
  crearía la segunda noción de admin que CLAUDE.md prohíbe.
- **Cableado y tráfico son dos hechos, nunca uno.** La consola no vuelve a
  mostrar un estado que signifique las dos cosas a la vez.
- **La identidad sigue siendo la persona; el equipo se declara aparte.** Cada
  pedido dice de qué máquina viene, y la consola muestra los dispositivos de
  cada persona. Se descartó una clave por máquina (multiplica las credenciales
  a administrar y muda el onboarding de la persona al equipo) y se descartó
  dejarlo por persona (obliga a la consola a no hablar nunca de máquinas, y
  deja el interruptor de desconectar sin blanco). **El nombre del equipo es un
  dato personal nuevo que empieza a viajar**, en un producto cuya promesa es
  que nada sale de la máquina: sale hacia el gateway del propio equipo, como el
  prompt, y el spec debe decidir si el nombre lo pone la persona o el sistema.
- **Pausar tiene duración elegida.** Un rato, el día, o hasta sacarla a mano;
  lo elegido queda en el registro. Una pausa sin vencimiento es un guard
  apagado que nadie recuerda haber apagado, y una que vence siempre castiga a
  quien tiene una razón larga y legítima.
- **Rotar una clave deja a esa persona "pendiente de reconectar"** hasta que
  llegue tráfico con la clave nueva, y avisa antes de romper. La clave vieja
  muere en el acto — un período de gracia debilitaría la única herramienta de
  revocación que existe — pero deja de morir en silencio.
- **Desconectar es local y completo.** Revierte exactamente lo que
  `--fix` escribió — la entrada del hook, las variables del `env`, el bloque
  de Codex, el plugin de OpenCode — y dice qué sacó. No borra reglas, ni
  personas, ni el log.
- **Una sola fuente de verdad para la clave**, con los demás lugares derivados
  de ella y verificables. La forma exacta la decide el spec; la decisión de
  producto es que **dejar de tener cuatro copias que pueden discrepar**.
- **El mensaje de clave desconocida se bifurca** según el camino: local dice
  cómo arreglarlo uno mismo; de equipo mantiene "pedile una clave a tu admin",
  que ahí sí es la verdad.
- **Una instalación no se nombra: se identifica por dónde viven sus datos.**
  Pedirle a alguien que bautice su gateway es ceremonia que nadie quiere y que
  la mayoría dejaría en el default, justo cuando más falta hace distinguirlos.
  El gateway ya sabe quién es — conoce su directorio de datos y su versión — y
  lo único que falta es que lo diga: en `/health`, en la consola, y sobre todo
  **en el rechazo del hook**, que hoy dice "no reconozco tu clave" sin decir
  quién es el que no la reconoce.
- **Dos gateways a la vez son un accidente, no una función.** Un usuario
  normal tiene uno; dos es la situación de quien desarrolla Warden o prueba una
  versión nueva al lado de la que usa. Así que el segundo **se niega a arrancar
  cuando el puerto ya lo tiene otro Warden, y dice cuál** — en vez de fallar de
  forma oscura o, peor, quedarse con la puerta. Querer dos sigue siendo posible
  eligiendo otro puerto a propósito, y ahí lo de arriba es lo que evita volver
  a confundirlos.

## 5. Métricas de éxito

- Alguien con una clave vieja y un gateway local **sale solo**, sin matar
  procesos ni editar archivos, siguiendo lo que dice la pantalla.
- This device responde sin ambigüedad, para cada herramienta: *¿está el hook
  puesto?* y *¿pasó algo por él?*
- Un admin ve, por persona, si el cableado se hizo y cuándo fue la última
  señal — y cuánto hace que no hay ninguna.
- Pausar y despausar (a uno mismo o a otro) es un clic, tiene efecto
  inmediato, y aparece en el registro administrativo.
- Desconectar y volver a conectar la propia máquina es reversible y no pierde
  nada más que el cableado.
- Quien cablea su propia máquina siendo exento **se entera en ese momento** de
  que las reglas de empresa no lo atan, y sale de la pantalla sabiendo qué
  escribir para que Warden lo mire de verdad.
- Cero regresiones: nada de esto cambia un veredicto.

## 6. Riesgos

- **La pausa es una puerta nueva por donde pasa algo sin juzgar.** Mal
  diseñada es peor que el problema que resuelve. Mitigación: administrativa,
  auditada, con duración, y con estado visible mientras dure.
- **El cableado solo es verificable de primera mano en la máquina del
  gateway.** Ahí la consola puede leer la config y responder con certeza. En la
  máquina de un empleado no: el gateway no ve su home, así que solo puede
  *inferir* cableado a partir del tráfico que llega. **La ausencia de tráfico
  no prueba ausencia de cableado**, y el spec tiene que elegir entre vivir con
  esa asimetría — dos redacciones distintas para el mismo dato — o hacer que el
  hook se reporte por su cuenta, que es comportamiento nuevo y otro dato que
  viaja.
- **La liveness es en memoria** (`src/policy/activity.ts`, se pierde al
  reiniciar). Un gateway recién arrancado no puede distinguir *"nunca se
  cableó"* de *"todavía no escribió nada desde el reinicio"*, y decir lo
  primero cuando es lo segundo es una acusación falsa sobre una persona.
- **Leer la config de otras herramientas es frágil**: formatos que cambian,
  permisos, instalaciones no estándar. El estado de cableado tiene que poder
  decir *no pude verificarlo* en vez de inventar un "no".
- **Desconectar edita archivos que Warden no es dueño** (`~/.claude/settings.json`
  tiene hooks de otras cosas). Sacar de más es peor que no sacar.
- **This device solo es verdad en la máquina del gateway.** Si un equipo corre
  el gateway en un servidor, el admin que abre la consola desde su laptop está
  mirando una página sobre otra computadora. Separar máquina de gateway (§3)
  lo mejora, pero el spec debe decidir si la página aparece siempre o solo
  cuando la consola se abre desde el propio equipo.

## 7. Lo que quedó cerrado sobre pausa y nombres

- **Un pedido de alguien pausado entra al log diciendo *no juzgado ·
  pausado*.** Si no entrara, el registro mentiría por omisión: parecería que
  esa persona no trabajó en toda la tarde. **No cuenta contra la cuota diaria
  de su rol**, porque la cuota cuenta pedidos juzgados y ese no se juzgó.
- **El admin pausa a cualquiera; quien se autoaplica Warden se pausa a sí
  mismo; un empleado no pausa a nadie, ni a sí mismo.** Si pudiera, el botón de
  apagar Warden vendría incluido en el producto.
- **El equipo se nombra desde el sistema** (nombre del host). Es automático y
  no le pide nada a nadie; el costo es que suele llevar el nombre de la persona
  adentro, y el spec debe decir que ese nombre se trata como dato personal:
  viaja al gateway de la propia empresa, se muestra en la consola, y no entra
  al audit log, que guarda hashes y no texto.

## 8. Fuera de este documento

Los flags exactos del hook, el modelo de datos de la pausa, los endpoints, el
formato del estado de cableado, qué escribe cada camino de instalación y cómo
se verifica la clave — todo eso es el spec técnico, que se escribe después de
acordar esto.
