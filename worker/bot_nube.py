"""
Trabajador del bot de libros (se ejecuta en GitHub Actions cada pocos minutos).

En cada ronda:
  1. Reintenta los envíos por correo que fallaron.
  2. Recoge los pedidos nuevos de la app:
       - si el libro está en el grupo -> lo descarga y lo envía al Kindle;
       - si no -> publica la solicitud en el grupo.
  3. Revisa los mensajes nuevos del grupo por si alguien ha subido un libro pedido.
  4. Avisa a cada persona por Telegram de cada paso.

Toda la configuración llega en el secreto CONFIG_BOT (JSON en base64) que genera
preparar_nube.py en el ordenador de Dani. El estado vive en Supabase.
"""

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import smtplib
import ssl
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl import types
from telethon.tl.types import InputMessagesFilterDocument

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("telethon").setLevel(logging.WARNING)
log = logging.getLogger("libros")

# --------------------------------------------------------------------------
# Configuración
# --------------------------------------------------------------------------
RAW = os.environ.get("CONFIG_BOT", "").strip()
if not RAW:
    sys.exit("Falta el secreto CONFIG_BOT en GitHub (Settings → Secrets and variables → Actions).")
try:
    CFG = json.loads(base64.b64decode(RAW).decode("utf-8"))
except Exception:
    sys.exit("El secreto CONFIG_BOT no es válido. Vuelve a generarlo con preparar_nube.py.")

API_ID = int(CFG["API_ID"])
API_HASH = CFG["API_HASH"]
BOT_TOKEN = CFG["BOT_TOKEN"]
OWNER_ID = int(CFG["OWNER_ID"])
TG_SESSION = CFG["TG_SESSION"]
GROUP_ID = int(CFG["GROUP_ID"])                 # -100xxxxxxxxxx
GROUP_HASH = int(CFG["GROUP_ACCESS_HASH"])
APP_API_URL = CFG["APP_API_URL"]
APP_API_SECRET = CFG["APP_API_SECRET"]
APP_URL = CFG.get("APP_URL", "https://minombreesdani.github.io/libros-app/")
SMTP_HOST = CFG.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(CFG.get("SMTP_PORT", 465))
SMTP_USER = CFG.get("SMTP_USER", "")
SMTP_PASSWORD = (CFG.get("SMTP_PASSWORD") or "").replace(" ", "")
EMAIL_READY = bool(SMTP_USER and SMTP_PASSWORD)
KINDLE_EMAIL = CFG.get("KINDLE_EMAIL", "")
PUBLISHED_EMAIL = CFG.get("PUBLISHED_EMAIL", "")
REQUEST_TEMPLATE = CFG.get("REQUEST_TEMPLATE") or (
    "Buenas, quisiera pedir el siguiente libro:\n\nTítulo: {titulo}\nAutor: {autor}\n"
    "Tipo: Libro\nIdioma: Español\n\nGracias\n#Pedido")
REQUEST_FORMAT = CFG.get("REQUEST_FORMAT", "EPUB")
PREFERRED_FORMATS = [f.strip().lower() for f in CFG.get("PREFERRED_FORMATS", "epub,pdf,docx,txt,azw3,mobi").split(",")]
BOOK_EXTENSIONS = set(PREFERRED_FORMATS) | {"epub", "pdf", "mobi", "azw3", "azw", "docx", "doc", "rtf", "txt", "fb2"}
SCAN_LIMIT = int(CFG.get("SCAN_LIMIT", 3000))
WEBHOOK_URL = APP_API_URL.rsplit("/", 1)[0] + "/telegram"

KINDLE_OK = {"epub", "pdf", "doc", "docx", "txt", "rtf", "htm", "html"}
MAX_MB = 25
DOWNLOAD_DIR = Path(tempfile.mkdtemp(prefix="libros_"))


# --------------------------------------------------------------------------
# Utilidades de coincidencia (mismas reglas que el bot del ordenador)
# --------------------------------------------------------------------------
def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


STOPWORDS = {"el", "la", "los", "las", "de", "del", "y", "un", "una", "the", "of", "a", "and", "en"}


def title_tokens(titulo: str) -> list[str]:
    toks = normalize(titulo).split()
    significant = [t for t in toks if t not in STOPWORDS]
    return significant or toks


def file_name(msg) -> str:
    return (msg.file.name if msg.file and msg.file.name else "") or ""


def file_ext(msg) -> str:
    name = file_name(msg)
    if "." in name:
        return name.rsplit(".", 1)[-1].lower()
    return (msg.file.ext or "").lstrip(".").lower() if msg.file else ""


def is_book(msg) -> bool:
    return bool(getattr(msg, "document", None)) and file_ext(msg) in BOOK_EXTENSIONS


def score(msg, titulo: str, autor: str) -> int | None:
    words = set(normalize(file_name(msg) + " " + (msg.message or "")).split())
    if not all(t in words for t in title_tokens(titulo)):
        return None
    pts = 10
    if autor:
        surname = normalize(autor).split()
        if surname and surname[-1] in words:
            pts += 5
    ext = file_ext(msg)
    if ext in PREFERRED_FORMATS:
        pts += len(PREFERRED_FORMATS) - PREFERRED_FORMATS.index(ext)
    return pts


# --------------------------------------------------------------------------
# HTTP: API de la app y Bot API de Telegram
# --------------------------------------------------------------------------
class ApiError(Exception):
    pass


def _post(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read())
            msg = body.get("error") or body.get("description") or str(e)
        except Exception:  # noqa: BLE001
            msg = str(e)
        raise ApiError(f"{e.code}: {msg}") from None
    except urllib.error.URLError as e:
        raise ApiError(f"sin conexión ({e.reason})") from None


async def api(action: str, **kw) -> dict:
    return await asyncio.to_thread(_post, APP_API_URL, {"action": action, **kw}, {"x-bot-secret": APP_API_SECRET})


async def api_quiet(action: str, **kw):
    try:
        return await api(action, **kw)
    except ApiError as e:
        log.warning("API %s falló: %s", action, e)
        return None


async def botapi(method: str, **params) -> dict:
    return await asyncio.to_thread(_post, f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", params, {})


async def tell(tg_id: int, text: str, reply_markup: dict | None = None) -> None:
    log.info("[%s] %s", tg_id, text.replace("\n", " | "))
    try:
        p = {"chat_id": tg_id, "text": text, "disable_web_page_preview": True}
        if reply_markup:
            p["reply_markup"] = reply_markup
        await botapi("sendMessage", **p)
    except ApiError as e:
        log.error("No pude escribir a %s: %s", tg_id, e)


APP_BUTTON = {"inline_keyboard": [[{"text": "📚 Abrir la app de libros", "web_app": {"url": APP_URL}}]]}


async def step(req: dict, text: str, estado: str | None = None, **extra) -> None:
    """Avisa a quien pidió el libro y actualiza el estado que ve en la app."""
    await tell(req["tg_id"], text)
    if req.get("pedido_id"):
        clean = re.sub(r"^[^\wÀ-ÿ¡¿«]+", "", text.split("\n")[0]).strip()
        payload = {"id": req["pedido_id"], "paso": clean[:300], **extra}
        if estado:
            payload["estado"] = estado
        await api_quiet("update", **payload)


# --------------------------------------------------------------------------
# Correo
# --------------------------------------------------------------------------
def _smtp_send(msg: EmailMessage) -> None:
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=60) as s:
        s.login(SMTP_USER, SMTP_PASSWORD)
        s.send_message(msg)


def _send_book(path: Path, to: str, subject: str) -> None:
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP_USER, to, subject
    msg.set_content(f"Adjunto: {path.name}")
    ctype, _ = mimetypes.guess_type(path.name)
    if path.suffix.lower() == ".epub":
        ctype = "application/epub+zip"
    maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
    msg.add_attachment(path.read_bytes(), maintype=maintype, subtype=subtype, filename=path.name)
    _smtp_send(msg)


async def send_email(path: Path, to: str, req: dict) -> bool:
    size_mb = path.stat().st_size / 1024 / 1024
    if size_mb > MAX_MB:
        await step(req, f"⚠️ El archivo pesa {size_mb:.1f} MB y el correo admite {MAX_MB} MB; no se puede enviar.",
                   estado="error")
        return False
    if not EMAIL_READY:
        await step(req, "📦 Libro localizado. Se enviará en cuanto el correo del bot esté activo.", estado="descargado")
        return False
    if to.lower().endswith("kindle.com") and path.suffix.lstrip(".").lower() not in KINDLE_OK:
        await tell(req["tg_id"], f"⚠️ Kindle no acepta {path.suffix} por correo. Lo intento igualmente.")
    await step(req, f"📧 Enviando «{path.name}» a {to}…")
    try:
        await asyncio.to_thread(_send_book, path, to, f"Libro: {req['titulo']}")
    except smtplib.SMTPAuthenticationError:
        await step(req, "📦 Libro localizado, pero el correo del bot falla. Se reintentará.", estado="descargado")
        await tell(OWNER_ID, "❌ Gmail rechaza el usuario o la contraseña del bot. Vuelve a ejecutar preparar_nube.py.")
        return False
    except Exception as e:  # noqa: BLE001
        await step(req, "📦 Libro localizado, pero el envío falló. Se reintentará en la próxima ronda.",
                   estado="descargado")
        log.warning("Error SMTP: %s", e)
        return False
    await step(req, f"✅ Enviado a {to}. En unos minutos lo tendrás en el Kindle.",
               estado="enviado", destino=to, archivo=path.name)
    return True


# --------------------------------------------------------------------------
# Telegram (tu cuenta)
# --------------------------------------------------------------------------
async def search_group(user, group, titulo: str, autor: str, req: dict):
    best, best_pts = None, -1
    async for m in user.iter_messages(group, search=titulo, filter=InputMessagesFilterDocument, limit=200):
        if is_book(m):
            pts = score(m, titulo, autor)
            if pts is not None and pts > best_pts:
                best, best_pts = m, pts
    if best:
        return best
    await step(req, "🔁 Revisando a fondo los últimos archivos del grupo…")
    async for m in user.iter_messages(group, filter=InputMessagesFilterDocument, limit=SCAN_LIMIT):
        if is_book(m):
            pts = score(m, titulo, autor)
            if pts is not None and pts > best_pts:
                best, best_pts = m, pts
    return best


async def download_and_send(user, msg, req: dict, to: str) -> None:
    name = file_name(msg) or f"{normalize(req['titulo']).replace(' ', '_')}.{file_ext(msg) or 'epub'}"
    size = (msg.file.size or 0) / 1024 / 1024
    await step(req, f"⬇️ Descargando «{name}» ({size:.1f} MB)…", archivo_msg_id=msg.id)
    path = await user.download_media(msg, file=str(DOWNLOAD_DIR / name))
    if not path:
        await step(req, "❌ No se pudo descargar el archivo.", estado="error")
        return
    await send_email(Path(path), to, req)
    try:
        Path(path).unlink()
    except OSError:
        pass


def destino_posterior(p: dict) -> str:
    if p.get("es_dueno") and PUBLISHED_EMAIL:
        return PUBLISHED_EMAIL
    return p.get("kindle_email") or KINDLE_EMAIL


async def handle_request(user, group, p: dict) -> None:
    req = {"pedido_id": p["id"], "tg_id": p["tg_id"], "titulo": p["titulo"]}
    titulo, autor = p["titulo"], p.get("autor") or ""
    if not p.get("kindle_email"):
        await step(req, "❌ Falta tu correo de Kindle. Ponlo en la app y vuelve a pedirlo.", estado="error")
        return
    await step(req, f"🔎 Buscando «{titulo}»{' de ' + autor if autor else ''} en los archivos del grupo…",
               estado="buscando")
    found = await search_group(user, group, titulo, autor, req)
    if found:
        await step(req, f"📗 ¡Encontrado! «{file_name(found)}»")
        await download_and_send(user, found, req, p["kindle_email"])
        return
    text = REQUEST_TEMPLATE.format(titulo=titulo, autor=autor or "—", formato=REQUEST_FORMAT)
    sent = await user.send_message(group, text)
    await step(req, "📨 No estaba en el grupo, así que lo hemos pedido. Te avisamos en cuanto alguien lo publique.",
               estado="solicitado", request_msg_id=sent.id)
    if p["tg_id"] != OWNER_ID:
        await tell(OWNER_ID, f"📨 Pedido publicado en el grupo para {p.get('nombre') or p['tg_id']}: «{titulo}»")


async def retry_unsent(user, group) -> None:
    r = await api("reintentos")
    for p in r.get("pedidos", []):
        if not EMAIL_READY or not p.get("archivo_msg_id"):
            continue
        msg = await user.get_messages(group, ids=p["archivo_msg_id"])
        req = {"pedido_id": p["id"], "tg_id": p["tg_id"], "titulo": p["titulo"]}
        if not msg or not is_book(msg):
            await step(req, "⚠️ El archivo ya no está en el grupo; vuelve a pedirlo.", estado="error")
            continue
        to = p["kindle_email"] if p.get("request_msg_id") is None else destino_posterior(p)
        await download_and_send(user, msg, req, to)


async def watch_group(user, group) -> None:
    """Busca, entre los mensajes nuevos del grupo, libros que alguien haya pedido."""
    cfg = await api("get_config", claves=["ultimo_msg_id"])
    latest = await user.get_messages(group, limit=1)
    latest_id = latest[0].id if latest else 0
    last = int(cfg.get("ultimo_msg_id") or 0)
    if not last:
        await api("set_config", clave="ultimo_msg_id", valor=latest_id)
        return
    pendientes = (await api("solicitados")).get("pedidos", [])
    if pendientes:
        async for m in user.iter_messages(group, min_id=last, reverse=True,
                                          filter=InputMessagesFilterDocument, limit=2000):
            if not is_book(m):
                continue
            for p in list(pendientes):
                if m.reply_to_msg_id == p.get("request_msg_id") or score(m, p["titulo"], p.get("autor") or "") is not None:
                    req = {"pedido_id": p["id"], "tg_id": p["tg_id"], "titulo": p["titulo"]}
                    await step(req, f"🎉 ¡Han publicado «{p['titulo']}» en el grupo!")
                    await download_and_send(user, m, req, destino_posterior(p))
                    pendientes.remove(p)
                    break
    await api("set_config", clave="ultimo_msg_id", valor=max(last, latest_id))


async def ensure_webhook() -> None:
    """Conecta el bot con la función de Supabase que contesta las órdenes al instante."""
    secret = hashlib.sha256(("webhook:" + BOT_TOKEN).encode()).hexdigest()[:48]
    info = (await botapi("getWebhookInfo")).get("result", {})
    if info.get("url") != WEBHOOK_URL:
        await botapi("setWebhook", url=WEBHOOK_URL, secret_token=secret,
                     allowed_updates=["message", "callback_query"], drop_pending_updates=False)
        await botapi("setChatMenuButton", menu_button={"type": "web_app", "text": "Libros", "web_app": {"url": APP_URL}})
        log.info("Webhook configurado: %s", WEBHOOK_URL)


async def notify_new_users(nuevos: list[dict]) -> None:
    for u in nuevos:
        alias = f" (@{u['username']})" if u.get("username") else ""
        await tell(OWNER_ID, f"👤 {u.get('nombre')}{alias} quiere usar la app de libros.",
                   reply_markup={"inline_keyboard": [[
                       {"text": "✅ Aprobar", "callback_data": f"ok:{u['tg_id']}"},
                       {"text": "❌ Rechazar", "callback_data": f"no:{u['tg_id']}"}]]})


async def correo_de_prueba() -> None:
    cfg = await api("get_config", claves=["probar_correo"])
    if cfg.get("probar_correo") != "1":
        return
    await api("set_config", clave="probar_correo", valor=None)
    if not EMAIL_READY:
        await tell(OWNER_ID, "📭 El correo no está configurado. Vuelve a ejecutar preparar_nube.py con la contraseña.")
        return
    dest = PUBLISHED_EMAIL or SMTP_USER
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = SMTP_USER, dest, "Prueba del bot de libros"
    m.set_content("Si lees esto, el envío de correos del bot funciona. 📚")
    try:
        await asyncio.to_thread(_smtp_send, m)
        await tell(OWNER_ID, f"✅ Correo de prueba enviado a {dest}.")
    except smtplib.SMTPAuthenticationError:
        await tell(OWNER_ID, "❌ Gmail rechaza la contraseña del bot. Vuelve a ejecutar preparar_nube.py.")
    except Exception as e:  # noqa: BLE001
        await tell(OWNER_ID, f"❌ Error enviando el correo de prueba: {e}")


# --------------------------------------------------------------------------
async def ronda() -> None:
    await ensure_webhook()
    await correo_de_prueba()
    claim = await api("claim")
    await notify_new_users(claim.get("usuarios_nuevos", []))

    user = TelegramClient(StringSession(TG_SESSION), API_ID, API_HASH)
    await user.connect()
    try:
        if not await user.is_user_authorized():
            raise RuntimeError("La sesión de Telegram de la nube ha caducado. Vuelve a ejecutar preparar_nube.py.")
        channel_id = int(str(abs(GROUP_ID))[3:]) if str(abs(GROUP_ID)).startswith("100") else abs(GROUP_ID)
        group = types.InputPeerChannel(channel_id, GROUP_HASH)

        await retry_unsent(user, group)
        for p in claim.get("pedidos", []):
            try:
                await handle_request(user, group, p)
            except Exception as e:  # noqa: BLE001
                log.exception("Error en el pedido %s", p.get("id"))
                await step({"pedido_id": p["id"], "tg_id": p["tg_id"], "titulo": p["titulo"]},
                           "❌ Ha ocurrido un error procesando el pedido. Dani ya está avisado.", estado="error")
                await tell(OWNER_ID, f"❌ Error con «{p['titulo']}»: {e}")
        await watch_group(user, group)
    finally:
        await user.disconnect()


async def main() -> None:
    previo = (await api_quiet("get_config", claves=["ultimo_error"]) or {}).get("ultimo_error")
    try:
        await ronda()
        await api_quiet("set_config", clave="ultimo_error", valor=None)
    except Exception as e:  # noqa: BLE001
        log.exception("La ronda falló")
        msg = str(e)[:500] or e.__class__.__name__
        await api_quiet("set_config", clave="ultimo_error", valor=msg)
        if msg != previo:  # avisa una vez por Telegram, no cada 5 minutos
            await tell(OWNER_ID, f"⚠️ El bot de libros tiene un problema: {msg}")
        # No se relanza el error: así GitHub no envía un correo de fallo en cada ronda.
    finally:
        await api_quiet("set_config", clave="ultima_ronda", valor=datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    asyncio.run(main())
