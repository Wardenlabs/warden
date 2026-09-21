# Taste aplicado a Warden

Paquete instalado para Codex con `npx skills add Leonxlnx/taste-skill --agent codex --yes`. El paquete contiene 13 skills; se aplicaron `design-taste-frontend` y `redesign-existing-projects` a esta revisión. No se combinan automáticamente sus distintas direcciones estéticas.

## Lectura del brief

Landing para desarrolladores y equipos que usan herramientas de IA. Monocromo, escudo oficial frontal, pocos elementos y movimiento con una función clara. Es una evolución de la marca existente.

`DESIGN_VARIANCE: 3`, `MOTION_INTENSITY: 4`, `VISUAL_DENSITY: 2`.

## Auditoría y decisiones

- Conservar Manrope, negro #080808, carbón #121212, blanco #F4F4F2 y el sistema de radios existente. La identidad elegida por el usuario tiene prioridad sobre las recetas genéricas de la skill.
- Conservar el hero centrado: presenta una sola promesa y el símbolo oficial. La pose frontal y los fondos oscuros son pedidos explícitos.
- Mantener las rutas, descargas, eventos, controles nativos, foco visible y metadatos. La guía sigue siendo una demostración identificada como ejemplo.
- Compactar la entrada de How it works: menor espacio inicial, título más breve y encabezado de acción. La primera interacción aparece antes.
- Retirar el barrido brillante de los botones. El metal pertenece al escudo; los controles responden a la presión con 1px de desplazamiento y escala .985. El movimiento reducido elimina esa respuesta.
- Conservar los efectos de decisión: explican visualmente el bloqueo o paso de un pedido. No agregar loops, cursores personalizados, tarjetas de relleno ni fotos ajenas al producto.
- Mantener la versión real junto a los instaladores: sirve para identificar la descarga y no es un adorno inventado.

## Para futuras iteraciones

Leer primero DESIGN.md, PRODUCT.md y DARK-DIRECTION.md. Aplicar la auditoría de taste sobre la implementación real, no usarla como excusa para reemplazar la marca. Revisar cada cambio en escritorio y móvil, mantener el texto concreto y verificar las interacciones. Para el video, conservar la pose frontal inicial y la luz como recurso de movimiento.
