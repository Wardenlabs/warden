# Warden · Dirección visual

Estado: implementación autorizada para subir a main el 20 de septiembre de 2026, con corrección de resolución y biseles del logo 3D. El estado del despliegue se verifica por separado.

Este conjunto traduce el pedido de menos texto, menos componentes y más cuidado visual en una landing y una base para el próximo video. Conserva el logo oficial y trabaja con blanco, negro y metal neutro.

## Qué leer

- [Dirección oscura vigente](DARK-DIRECTION.md): corrección de fondos, pose frontal y footer.

- [Investigación y criterio](RESEARCH.md): referencias primarias, observaciones y decisiones.
- [Brief de la landing](LANDING.md): composición, texto, recorridos y límites.
- [Sistema de diseño](../../DESIGN.md): valores y comportamiento de la implementación.
- [Dirección para el video](VIDEO-DIRECTION.md): guion visual propuesto y reglas de adaptación.

## Fuentes de implementación

- `landing/design-system.css`: tokens compartidos de la nueva portada.
- `landing/landing.css`: composición y componentes de esa portada.
- `landing/foundation-v2.css`: base, marca, controles y reproductor.
- `landing/assets/3d/official-shield.js`: geometría oficial, metal e iluminación.
- `landing/shield.js`: ciclo de vida, movimiento, preferencias y fallback.
- `landing/how-it-works.html`: explicación detallada y demostraciones anteriores.

La portada explica lo esencial. La guía conserva el detalle. PRODUCT.md gobierna las afirmaciones; DESIGN.md gobierna la presentación. Una propuesta visual no cambia las capacidades del producto.
