# Dirección para el próximo video de Warden

Estado: brief para producción futura. No es un video renderizado ni un guion aprobado. El video actual de 17 segundos continúa enlazado en la landing.

## Idea

Una marca. Una regla. Una decisión.

El próximo video comparte el lenguaje de la landing: negro, blanco, metal neutro, Manrope y el logo oficial. Cada plano contiene una idea legible. La geometría del escudo es el vínculo entre apertura y cierre.

## Guion visual propuesto · 18 segundos

| Tiempo | Imagen | Texto en pantalla | Propósito |
| --- | --- | --- | --- |
| 0–3 s | Escudo sobre negro. Frente visible desde el primer fotograma; una luz blanca recorre los biseles. | Your AI. | Reconocer la marca y establecer el ritmo. |
| 3–5 s | El escudo mantiene su frente mientras cambia el reflejo. Título con más peso. | Your rules. | Presentar la promesa. |
| 5–8 s | Continuidad sobre negro; una sola regla en una superficie carbón. Aparece su estado activo. | Keep client pricing private. | Mostrar una regla ya revisada y activada. |
| 8–11 s | El pedido entra en el mismo panel. | Share a client’s private pricing. | Hacer concreto el límite. |
| 11–14 s | La entrada se detiene. Icono y resultado, sin sacudidas de cámara. | Blocked. | Mostrar la decisión. |
| 14–18 s | Negro. Escudo y wordmark oficial. Cierre sostenido. | Warden. Free and open source. | Dar tiempo a recordar y actuar. |

El pedido y la regla son ejemplos, no una captura de una evaluación de producción. Incluir «Illustrative example» durante la prueba. Si se muestra el proceso de creación, insertar revisión y activación humana explícitas; no animar un borrador aplicándose solo.

## Reglas de imagen

- Usar los vectores de `brand/` y los contornos de `landing/assets/3d/brand-paths.js`.
- Reutilizar el renderer de `landing/assets/3d/official-shield.js` como referencia de material; verificar normales y bordes a resolución de exportación.
- Negro `#080808`, blanco `#F4F4F2`, gris secundario `#A3A3A3` sobre negro.
- No usar escenas de fondo blanco: negro `#080808`, superficies `#121212` y líneas `#303030`. Blanco reservado para texto, metal y acciones.
- Escudo en metal neutro. Los reflejos dan profundidad; no teñirlo ni añadir un halo de color.
- Una fuente: Manrope. Peso 400 para apertura secundaria, 580–650 para afirmación y decisión.
- Ninguna marca de integración se presenta como cliente o aval comercial.

## Movimiento y sonido

Un gesto principal: la luz recorre el escudo y se asienta. En la prueba, el pedido llega y se detiene. Usar aceleración suave, desaceleración clara y pausas de lectura; evitar giros completos, texto reescrito en bucle y movimientos simultáneos en todos los elementos.

El sonido puede acompañar la entrada de luz y el momento de bloqueo con dos acentos discretos. Mantener música y voz opcionales hasta definir la pieza. No usar un sonido de éxito para «Blocked»: debe sentirse una decisión clara y controlada.

## Adaptaciones

- **16:9 · 1920×1080:** composición central; el logo nunca compite con dos columnas de texto. Márgenes de seguridad mínimos del 8%.
- **9:16 · 1080×1920:** recomponer logo, frase y decisión verticalmente. Evitar controles de interfaz en el 15% superior/inferior. No recortar la versión horizontal.
- Mantener la frase más larga en dos o tres líneas con lectura cómoda a tamaño de teléfono.
- Cierre visible durante al menos 3 segundos. Confirmar URL o destino de campaña antes de incluirlo; no inventar un dominio.

## Antes de producir

Obtener devolución sobre esta landing y ajustar el sistema, elegir duración/canal, confirmar el texto del cierre y luego cargar la skill de producción de video. La calidad del video se verifica en su exportación real, no solo en capturas de la composición.

## Motivo compartido con la web

Una línea representa el recorrido del pedido. Una frontera vertical lo detiene cuando la regla bloquea; una frontera discontinua permite continuar el ejemplo público. Usar este motivo en el video como explicación de la decisión, con el resultado escrito y el ejemplo identificado. La página lo anima en 1,25 segundos; ese tiempo es una decisión de montaje, no una promesa de latencia.
