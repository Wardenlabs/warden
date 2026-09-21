# Taste aplicado a Warden

Paquete instalado para Codex con `npx skills add Leonxlnx/taste-skill --agent codex --yes`. El paquete contiene 13 skills; se aplicaron `design-taste-frontend` y `redesign-existing-projects` a esta revisión. No se combinan automáticamente sus distintas direcciones estéticas.

## Lectura del brief

Landing para desarrolladores y equipos que usan herramientas de IA. Monocromo, escudo oficial frontal, pocos elementos y movimiento con una función clara. Es una evolución de la marca existente.

`DESIGN_VARIANCE: 3`, `MOTION_INTENSITY: 4`, `VISUAL_DENSITY: 2`.

## Auditoría y decisiones

- Conservar Manrope, negro #080808, carbón #121212, blanco #F4F4F2 y el sistema de radios existente. La identidad elegida por el usuario tiene prioridad sobre las recetas genéricas de la skill.
- Conservar el hero centrado: presenta una sola promesa y el símbolo oficial. La pose frontal y los fondos oscuros son pedidos explícitos.
- Mantener las rutas, descargas, eventos, controles nativos, foco visible y metadatos. La guía conserva sus datos de demostración; a pedido del usuario, no repite rótulos de ejemplo en la interfaz.
- Compactar la entrada de How it works: menor espacio inicial, título más breve y encabezado de acción. La primera interacción aparece antes.
- Retirar el barrido brillante de los botones. El metal pertenece al escudo; los controles responden a la presión con 1px de desplazamiento y escala .985. El movimiento reducido elimina esa respuesta.
- Conservar los efectos de decisión: explican visualmente el bloqueo o paso de un pedido. El usuario pidió después un balanceo continuo y contenido para el escudo; es la única excepción. No agregar cursores personalizados, tarjetas de relleno ni fotos ajenas al producto.
- Mantener la versión real junto a los instaladores: sirve para identificar la descarga y no es un adorno inventado.

## Para futuras iteraciones

Leer primero DESIGN.md, PRODUCT.md y DARK-DIRECTION.md. Aplicar la auditoría de taste sobre la implementación real, no usarla como excusa para reemplazar la marca. Revisar cada cambio en escritorio y móvil, mantener el texto concreto y verificar las interacciones. Para el video, conservar la pose frontal inicial y la luz como recurso de movimiento.

## Revisión de uso y cierre

Se aplicaron también `gpt-taste` y `frontend-design` a pedido del usuario. El brief de marca prevalece sobre las recetas de aleatorización, tipografías nuevas, bento y scroll fijado: se conserva Manrope y no se agrega fricción al recorrido.

- La guía abandona autoplay y avance por scroll. Describe, Review y Activate controlan un solo espacio de trabajo. No hay un editor falso: la instrucción de ejemplo se presenta como texto.
- Los cambios de estado actualizan título y mensaje accesible. Una acción que desaparece deja el foco en el selector estable del paso.
- La primera revisión compactó el footer; el usuario aclaró después que buscaba composición y presencia, no menor tamaño. Se reemplazó por la firma centrada descrita abajo.
- El escudo entra frontal y continúa con un balanceo lento. Se limita a 30fps y pausa por visibilidad o movimiento reducido.

## Edición de texto

Se retiran los párrafos explicativos debajo de los títulos, las bandas de “Illustrative example”, “For connected tools” y las notas de política. “Usage limit” queda como nombre funcional. La página muestra acciones y resultados; los datos de demostración siguen siendo locales y no representan actividad real del visitante. Los mensajes de estado para lectores de pantalla se conservan sin añadir ruido visual.

## Footer como firma de marca

El cierre usa el lockup oficial grande y centrado, con aire alrededor. La descarga principal es tipográfica, con un icono contenido en un círculo; las demás plataformas forman una fila subordinada. Sin un nuevo slogan. La navegación queda en la línea inferior. Se retiran también “By your rule.” y “Within your rule.” de la prueba, cuyos márgenes y espacios internos se normalizan.
