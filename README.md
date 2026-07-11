# 🍜 ¿Qué comer?

App web mobile-first para decidir qué comer sin sobrepensar. Compañera de la app de outfits: misma lógica de galería + filtros + "sorpréndeme".

**🌐 En vivo: https://yolini27.github.io/que-comer/**

Ahora con **cuenta y nube** (Supabase, mismo proyecto que Outfit Hoy): entras con tu usuario corto (ej. `yoli` → `yoli@outfithoy.app`) y tus comidas se sincronizan entre dispositivos. **Tu misma cuenta de Outfit Hoy funciona aquí.** IndexedDB sigue siendo la copia local rápida y offline; la nube es la fuente de verdad (gana el cambio más nuevo). Las fotos se encuadran cuadradas 800×800 antes de guardarse.

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
| `index.html` | Toda la UI (galería, formulario, detalle, decidir, login, recorte, hoja de usuario) |
| `app.js` | Lógica: IndexedDB + cola de cambios, sync con Supabase, recorte cuadrado, filtros, random ponderado, respaldo JSON |
| `styles.css` | Estilos mobile-first, tema blanco limpio |
| `config.js` | URL + llave anon de Supabase (pública; el SW la sirve red-primero) |
| `setup.sql` | Tablas `comidas` y `perfiles_comida` + RLS + bucket privado `fotos-comida` (ya ejecutado) |
| `lib/supabase.min.js` | supabase-js vendorizado (sin CDN en runtime) |
| `sw.js` | Service worker: network-first con fallback a caché (offline) |
| `manifest.webmanifest` + `icons/` | PWA instalable |

## Detalles de diseño

- **Sorpréndeme** es un random ponderado: cada opción pesa según los días sin comerla (lo nunca registrado pesa 45 días), así prioriza lo que hace más tiempo no comes.
- **"Lo comí hoy"** guarda la fecha en `eatenDates`; el grid muestra el badge discreto ("ayer", "hace 2 sem"...). Tocarlo dos veces el mismo día no duplica.
- **Respaldo:** el JSON exportado incluye las fotos (y food checks) en base64; importar reemplaza lo local y se sube a la nube.
- Los distritos personalizados se sincronizan en la tabla `perfiles_comida` y se administran desde la hoja de usuario.
- **Nube:** cambios locales van a una cola `pending` y se empujan al reconectar; la primera vez que inicias sesión en un dispositivo con datos locales, todo se migra solo a tu cuenta. Cerrar sesión borra la copia local.
- **Food check:** mini-fotos del mismo plato en otros días, en la carpeta `{user_id}/{comida}-{extra}.jpg` del bucket.
- La foto de perfil se guarda como `{user_id}/avatar.jpg` en `fotos-comida`; si no existe, se reutiliza la de Outfit Hoy (bucket `fotos`).
- Capas de overlays: decidir 50 < resultado 52 < detalle 56 < editor 58 < hoja 70 < login 76 < recorte 80.
