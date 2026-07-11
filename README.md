# 🍜 ¿Qué comer?

App web mobile-first para decidir qué comer sin sobrepensar. Compañera de la app de outfits: misma lógica de galería + filtros + "sorpréndeme".

**🌐 En vivo: https://yolini27.github.io/que-comer/**

Todo vive en el navegador (IndexedDB): sin backend, sin cuentas, sin login. Las fotos se comprimen a máx. 800px antes de guardarse.

## Cómo correrla

Necesita servirse por HTTP (el service worker no funciona con `file://`):

```bash
cd que-comer
python3 -m http.server 8137
# abrir http://localhost:8137
```

Ya está publicada en GitHub Pages (repo `yolini27/que-comer`, rama `main`): cada `git push` actualiza la página en uno o dos minutos. Los datos se guardan **por navegador/dispositivo**: usa Exportar/Importar (⚙️) para pasarlos de uno a otro.

## Instalarla como app

- **iPhone (Safari):** Compartir → "Agregar a pantalla de inicio".
- **Android (Chrome):** menú ⋮ → "Agregar a pantalla principal" / "Instalar app".

Queda con su propio ícono (tazón humeante 🍲) y funciona offline.

## Estructura

| Archivo | Qué hace |
|---|---|
| `index.html` | Toda la UI (galería, formulario, detalle, decidir, ajustes) |
| `app.js` | Lógica: IndexedDB, compresión de fotos, filtros, random ponderado, respaldo JSON |
| `styles.css` | Estilos mobile-first, tema oscuro cálido |
| `sw.js` | Service worker: network-first con fallback a caché (offline) |
| `manifest.webmanifest` + `icons/` | PWA instalable |

## Detalles de diseño

- **Sorpréndeme** es un random ponderado: cada opción pesa según los días sin comerla (lo nunca registrado pesa 45 días), así prioriza lo que hace más tiempo no comes.
- **"Lo comí hoy"** guarda la fecha en `eatenDates`; el grid muestra el badge discreto ("ayer", "hace 2 sem"...). Tocarlo dos veces el mismo día no duplica.
- **Respaldo:** el JSON exportado incluye las fotos en base64; importar reemplaza todo (previa confirmación).
- Los distritos personalizados que agregues quedan guardados y aparecen en filtros y formularios.
