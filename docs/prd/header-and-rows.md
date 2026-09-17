# El header de página y las filas de tabla — PRD

La consola gasta 266px de alto antes del primer dato en Rules y 274 en Team, dice
tres veces dónde estás, y pierde la acción primaria apenas scrolleás. Sus filas
miden 80px porque casi toda celda tiene una segunda línea, y la mitad de esas
segundas líneas no informan nada.

Este documento dice qué tiene que quedar y con qué palabras.
[`docs/specs/header-and-rows.md`](../specs/header-and-rows.md) dice qué archivo
se toca y en qué orden.

Archivo de diseño `RFPKLtSSZjQMHy9XaOOSqp`. El sistema vive en la página
**01 · Design system** (`298:1984`); la propuesta y sus comparaciones en
**10 · Propuesta · Header v3** (`695:907`). Las 131 pantallas de las páginas
02–09 ya están migradas en Figma y son la referencia visual.

## 1. Lo que no cambia

- **El pipeline del guard.** Nada de acá toca `src/guard/`. Es una pasada de
  consola.
- **`--verdict-*`, `--role-*`, `--signal-red`.** Los colores con significado no
  se mueven. Lo que se mueve es cuánta tipografía y cuántos renglones hay
  alrededor de ellos.
- **El sidebar.** Ni sus grupos ni sus ítems ni su selección.
- **Qué acciones existen.** No se agrega ni se saca ninguna capacidad del
  producto. Se decide dónde vive cada una.
- **El texto de las reglas, los veredictos y los nombres.** El contenido de los
  datos es intocable; lo que se borra son las oraciones que los rodean.

## 2. El problema, medido

| | Rules | Team | Fila de Team |
|---|---|---|---|
| alto antes del primer dato | 266px | 274px | — |
| alto de fila | — | — | 80px |
| veces que dice dónde estás | 3 | 3 | — |
| elementos fijos al scrollear | 0 | 0 | — |

Los 266 de Rules son `context-bar` 64 + gap 24 + `page-head` 90 + gap 24 +
toolbar 40 + gap 24. Ninguno de esos seis bloques es contenido.

Tres cosas están mal, y la altura es sólo el síntoma:

**Se dice tres veces dónde estás.** El ítem del sidebar está encendido, el
breadcrumb lo repite y el `h1` lo repite otra vez. Ninguno de los tres es nuevo
para quien hizo clic para llegar.

**La descripción no trabaja.** «Set the boundaries. Keep your team moving.» y
«Manage the people whose requests run through Warden.» se leen el día uno y
después son ruido permanente en una herramienta de uso diario.

**Las filas tienen segundas líneas que definen en vez de informar.** «No device
has ever checked in» debajo de «Never reported» dice lo mismo con otras
palabras, idéntico para toda persona en ese estado. Una celda de tabla es el
peor lugar del producto para poner una explicación: se repite tantas veces como
filas haya.

## 3. Lo que queda

### 3.1 Una sola fila de header

`Header / Page v4` (`720:959`): una fila de 56 con dónde estás, qué es y qué
podés hacer, más un strip opcional de 48 para tabs o filtros, y **un solo
hairline** que cierra la región entera. 105px con strip, 57 sin.

El crumb va en la misma línea que el título y sólo aparece cuando hay a dónde
volver. En una vista raíz se omite: el ítem del sidebar ya lo dijo.

### 3.2 El header no tiene una segunda línea de prosa

Las catorce descripciones fijas se borran. Donde una vista de verdad necesita
explicarse —Settings, Runtime details, Red team, el resultado de activación— la
oración baja a la columna de lectura como bajada de su primera sección, que es
donde la prosa pertenece.

**La excepción son las vistas de detalle de un registro.** Una decisión, un
pedido retenido y una persona sí llevan una segunda línea, porque ahí no es
prosa: es la identidad del registro —cuándo pasó, cuánto tardó, quién es—, no se
repite en ninguna otra parte de esa pantalla y cambia con cada registro. Esa
línea es mono, de una sola línea, y nunca una oración.

### 3.3 Acciones: uno, uno, y el resto al menú

Exactamente un primary. Como máximo un quiet al lado. Todo lo demás al `···`, y
lo destructivo siempre ahí, último. Si una vista no tiene una acción primaria
honesta, no pone ninguna.

**Cancel deja de existir en los headers de edición.** Llama a
`go('policy', rule.id)`, exactamente lo mismo que el crumb de atrás, y los dos
pasan por el mismo guard de «Leave without saving?». Es el crumb, repetido dos
nodos a su derecha.

### 3.4 El conmutador es uno solo, y es una card

Tabs y filtros pasan a ser el mismo control: una card de 32 de alto, sin borde
nunca. Default sin relleno, hover un gris, seleccionado un gris más. Con esto
desaparecen los cuatro sets de tabs subrayadas, su riel y su acento de 2px.

Nunca conviven —tabs en cuatro vistas, toolbar en dos, cero solapamiento— así
que unificarlos no los confunde: saca un componente.

El tab que tiene trabajo sin terminar lo marca con un punto ámbar. Hoy el hueco
sólo existe en el bloque de estado de arriba y el conmutador no dice dónde está.

### 3.5 Las filas son de una línea

Una segunda línea sobrevive sólo si cambia por fila. Si define lo que la línea
de arriba ya dijo, o si es una instrucción al lado de un botón que hace
exactamente eso, se borra. Si es medio dato y media explicación, sobrevive el
dato.

La exención de reglas de empresa deja de ser una oración debajo de la pill y
pasa a ser un chip al lado. **El hecho no se toca**: un rol exento no se mide
contra ninguna regla de empresa, y esconderlo sería la clase de default que
reparte un bypass. Lo que se va es la frase.

## 4. Qué pasa con cada descripción

| Vista | Hoy | Queda |
|---|---|---|
| Rules | Set the boundaries. Keep your team moving. | nada — los filtros dicen los conteos |
| Team | Manage the people whose requests run through Warden. | nada — las tabs y la tabla lo dicen |
| Activity · lista | `todayLine()` | nada — los filtros y la columna Time |
| Inbox · lista | los tres estados de carga | nada |
| Models | `SUBS[tab]` | nada — la tab activa dice cuál es |
| Gateway | The server that holds the rules… | nada — `conditions()` lo dice |
| This device | One device: yours… | nada — `conditions()` lo dice |
| Settings | Warden is protecting one device: yours. | bajada de *This installation* |
| Runtime details | What the gateway is running… | bajada de la primera sección |
| Red team | The canned attack corpus… | bajada de la primera sección |
| Activation result | Review the activated rules… | primera línea de la conversación |
| **Decision** | `whenLine · judged in Xs` | **queda** — identidad del registro |
| **Held request** | `whenLine · waiting X` | **queda** |
| **Person** | `personLine(p)` | **queda** |

## 5. Probado y descartado

**Sacar el strip del header** para que las tabs vivan siempre sobre el contenido
y el header tuviera una sola forma. Se construyó, se comparó y es peor: sin el
strip adentro, el hairline cae entre el título y las tabs, y ahí las tabs bajan
al mismo nivel jerárquico que el encabezado de la tabla. Se leen como contenido
en vez de navegación. La uniformidad no paga eso.

**Cambiar la descripción por una línea de contadores.** Parecía mejor que una
oración y es peor: en Rules son los mismos números que los filtros muestran 40px
más abajo. Repite el problema de decir tres veces lo mismo, con números en vez
de nombres.

## 6. Aceptación

- Ninguna vista raíz muestra un breadcrumb.
- Ningún header muestra una oración que no cambie nunca.
- Ningún header muestra más de un primary y un quiet.
- Rules llega al primer dato en 129px y Team en 129. Una vista de detalle, en 81.
- El header no se va con el scroll.
- Una fila de Team mide 56px.
- `admin` sigue diciendo, en la lista, que está exento de las reglas de empresa.
- Nada de lo que se podía hacer antes dejó de poder hacerse.
