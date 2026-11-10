# Ron Kosher Sistema

Sistema propio de Ron Kosher: pedidos, armado con escaneo QR, reparto por tandas, entrega con foto, stock por depósito y lote, y caja.

## Cómo está armado

- `public/index.html`: toda la aplicación (se usa desde el celular).
- `functions/api/[[path]].js`: la API. Corre en Cloudflare Pages Functions y guarda todo en una base D1.
- `test/server.mjs`: servidor local de prueba con base en memoria (`node test/server.mjs`, Node 22 o superior).

No hay paso de compilación ni dependencias que instalar.

## Datos

- Tabla `docs`: cada pedido, artículo de stock, movimiento de caja y catálogo es un documento JSON.
- Tabla `log`: copia de cada escritura con fecha y autor. No se modifica nunca; es la auditoría.
- Las tablas se crean solas en el primer uso.
- Los datos de clientes y precios NO van en este repositorio. Se cargan una vez desde la pantalla Hoy, botón "Importar datos iniciales", con un usuario administrador.

## Publicación en Cloudflare

1. Workers & Pages → crear proyecto de Pages conectado a este repositorio. Sin comando de build; directorio de salida: `public`.
2. D1 → crear una base (por ejemplo `ronkosher`). En el proyecto de Pages → Settings → Bindings → agregar D1 con nombre de variable `DB`.
3. Zero Trust → Access → crear una aplicación self-hosted para el dominio del sistema y una política que permita solo los mails del equipo.
4. En el proyecto de Pages → Settings → Variables: `ACCESS_TEAM` (nombre del equipo de Zero Trust), `ACCESS_AUD` (Application Audience de la aplicación de Access) y `ADMIN_EMAILS` (mails con acceso total, separados por coma).
5. Custom domains → agregar `sistema.ronkosher.com`.

Sin `ACCESS_TEAM` y `ACCESS_AUD` la API no devuelve datos: es a propósito, para que nunca quede abierta.

La dirección `*.pages.dev` del proyecto también debe quedar detrás de Access (o desactivada), porque la API valida el token pero la página en sí es pública.

## Usuarios y permisos

- Cada persona entra con su mail (Cloudflare Access le manda un código).
- El nombre y el rol de cada mail se definen en el documento `catalogo/config`, campo `usuarios`: `{"mail@ejemplo.com": {"nombre": "Ron", "rol": "operador"}}`. Rol `admin` da acceso total.
- Los mails en `ADMIN_EMAILS` son siempre administradores.

## Pendiente

- Fotos de entrega en tamaño completo (hoy se guarda una versión reducida).
- Pantalla para administrar usuarios, productos y la relación producto → artículo de stock.
- Facturación y reportes contables.
- App de pedidos para clientes.
