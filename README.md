# Libros — mini-app de Telegram

App para pedir libros desde Telegram. Tiene dos pantallas:
- **Pedir:** título y autor; el libro llega al Kindle de quien lo pide.
- **Biblioteca:** libros pedidos y guardados, con su estado.

- `index.html`: la app, publicada con GitHub Pages.
- `supabase/functions/api`: la API (Supabase Edge Function). Valida que las peticiones vienen de Telegram y guarda los pedidos.
- `supabase/functions/telegram`: contesta al momento las órdenes del bot de Telegram (webhook).
- `worker/bot_nube.py` + `.github/workflows/bot.yml`: el trabajador que, cada 5 minutos en GitHub Actions, recoge los pedidos, busca en el grupo, descarga, pide los libros que faltan y los envía al Kindle.

La configuración del trabajador está en el secreto `CONFIG_BOT` del repositorio. Lo genera `preparar_nube.py`, en el ordenador de Dani.
