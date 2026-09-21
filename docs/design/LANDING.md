# Brief de superficie · Landing de Warden

Modo: persuadir. Estado: implementación autorizada para main el 20 de septiembre de 2026, con ajuste de nitidez del logo 3D.

## Objetivo

Que una persona entienda que Warden permite definir qué puede compartir su IA y encuentre la descarga. Audiencia: responsables de equipos y usuarios de herramientas de IA conectadas.

## Dirección fijada por el usuario

Menos texto y componentes, blanco y negro, conservar el logo. La referencia de acabado es Plaude. Se reutilizan marca, Manrope, escudo 3D, video e infraestructura de descarga existentes.

## Tres momentos

### Apertura negra

- Título: **Your AI. Your rules.**
- Apoyo: **Control what your AI can share.**
- Escudo centrado, aislado y sin rótulos o diagramas alrededor.
- Descarga principal según plataforma; enlace secundario al video existente.
- Claude Code, Codex y OpenCode en una línea discreta al pie.

En escritorio el título ocupa una línea cuando cabe. En móvil se separan sus dos frases. El objeto está entre el texto y la acción; no se traslada una columna de escritorio debajo de una pila de botones. El contenido siempre puede crecer en pantallas cortas o con texto ampliado.

### Prueba blanca

Título: **You set the rule.** Un solo panel muestra una regla activa, un pedido y su resultado. Radios nativos permiten comparar información privada y pública sin depender de JavaScript. El ejemplo es fijo y está identificado como ilustrativo.

La regla mostrada ya está activa. Su creación requiere revisión y activación humana, explicadas en la guía. No se presenta el ejemplo como una regla activada por el visitante.

### Cierre negro

Título: **Make it yours.** Versión y condición gratuita/open source. Descarga principal y enlaces de otras plataformas. Pie mínimo con marca, licencia, repositorio, guía y seguridad.

## Presupuesto editorial

Una frase de apoyo en el hero; un ejemplo en el cuerpo; un cierre. La medición inicial del DOM renderizado dio 104 palabras visibles, incluido el pie, con el ejemplo privado seleccionado. La cifra puede variar por plataforma y estado; el criterio es evitar volver a una portada con varios párrafos por sección.

## Lo que se conserva en la guía

Redacción de políticas, revisión y activación, negativas dentro de las herramientas, registro de decisiones, límites de uso y descargas. Se conserva el recorrido interactivo anterior en `landing/how-it-works.html`.

## Verificación

Revisar escritorio, 390px y 320px; teclado y selección de ejemplos; reproducción/cierre del video; enlaces de descarga; controles de la guía; ausencia de errores de carga. Respetar movimiento reducido y el fallback del escudo.

## Revisión de movimiento y guía

La portada usa ahora flechas horizontales SVG. Se eliminó el segundo enlace redundante debajo del ejemplo. La trayectoria del pedido da forma visual a la diferencia entre Blocked y Allowed: línea detenida frente a línea completa, con resultado escrito siempre disponible. No es una evaluación real ni una medida de latencia.

How it works comparte tokens, botones y pie con la portada. Su fondo claro, encabezado oscuro y paneles negros mantienen el contraste. Se conservan revisión, activación, selección de herramientas, explicación de reglas, decisiones y límites de uso. El control de replay conserva su etiqueta accesible y usa un icono SVG.

La portada y la guía mantienen desplazamiento nativo. En pantallas amplias la guía conserva su secuencia vinculada al scroll cuando cabe; el móvil usa flujo normal. No se añaden bucles ambientales ni dependencias.
