# Libros — mini-app de Telegram

App para pedir libros desde Telegram. Tiene dos pantallas:
- **Pedir:** título y autor; el libro llega al Kindle de quien lo pide.
- **Biblioteca:** libros pedidos y guardados, con su estado.

- `index.html`: la app, publicada con GitHub Pages.
- `supabase/functions/api`: la API (Supabase Edge Function). Valida que las peticiones vienen de Telegram y guarda los pedidos.
- El bot que atiende los pedidos se ejecuta en el ordenador de Dani; no está en este repositorio.
