# Sorteo de material

Página web para que un grupo de compañeros se apunte a un sorteo de material
informático que ya no se usa (televisores, tablets, dispositivos de streaming
y equipamiento de laboratorio).

Es un sitio estático. Cada participante entra con un código anónimo y una clave
que recibe por privado, y marca los artículos que le interesan. Las elecciones se
guardan en un servicio externo mediante una clave pública, y el acceso a los datos
está restringido por reglas en el propio servidor: cada persona solo puede ver y
modificar lo suyo, y solo hasta la fecha de cierre.

No se almacena ningún dato personal: ni nombres, ni correos. El único identificador
es un código del tipo `P-07`.

## Ficheros

| Fichero | Contenido |
|---|---|
| `index.html`, `app.js`, `styles.css` | La página |
| `data/items.csv` | Catálogo de artículos del sorteo |
| `data/config.json` | Dirección y clave pública del servicio de datos |

La clave que aparece en `data/config.json` es una clave pública, pensada para ir en
el navegador. Lo que protege la información son los permisos y las políticas de
acceso por fila configuradas en el servidor, no ocultar esa clave.
