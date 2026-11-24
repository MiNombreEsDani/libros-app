// Webhook del bot de Telegram: contesta las órdenes al instante, sin depender del ordenador.
// El trabajo pesado (buscar, descargar, enviar) lo hace el trabajador de GitHub Actions.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const APP_URL = "https://minombreesdani.github.io/libros-app/";
const enc = new TextEncoder();

async function getConfig(clave: string): Promise<string | null> {
  const { data } = await db.from("config").select("valor").eq("clave", clave).maybeSingle();
  return data?.valor ?? null;
}

async function sha256(text: string) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

let TOKEN = "";
async function tg(method: string, params: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return r.json().catch(() => ({}));
}

const say = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const appButton = { inline_keyboard: [[{ text: "📚 Abrir la app de libros", web_app: { url: APP_URL } }]] };

const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

async function despertarTrabajador() {
  const token = await getConfig("gh_token");
  if (!token) return false;
  try {
    const r = await fetch("https://api.github.com/repos/MiNombreEsDani/libros-app/dispatches", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "libros-app" },
      body: JSON.stringify({ event_type: "pedido" }),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

const HELP_OWNER =
  "📚 <b>Bot de libros</b>\n\n" +
  "/app — abrir la app\n" +
  "/libro Título | Autor — pedir un libro desde el chat\n" +
  "/pendientes — pedidos esperando en el grupo\n" +
  "/cancelar N — dejar de esperar el pedido nº N\n" +
  "/usuarios — quién usa la app (/aprobar ID, /rechazar ID)\n" +
  "/reenviar — reintentar envíos que fallaron\n" +
  "/probarcorreo — enviar un correo de prueba\n" +
  "/estado — cuándo trabajó el bot por última vez";
const HELP_USER = "📚 Pulsa el botón para abrir la app de libros: pide un libro y te llegará al Kindle.";

async function setEstadoUsuario(tgId: number, estado: "aprobado" | "rechazado") {
  const { data } = await db.from("usuarios").update({ estado }).eq("tg_id", tgId)
    .select("tg_id,nombre").maybeSingle();
  if (!data) return "Usuario no encontrado.";
  if (estado === "aprobado") {
    await say(tgId, "🎉 ¡Ya tienes acceso! Abre la app y pide tu primer libro.", { reply_markup: appButton });
    return `✅ ${esc(data.nombre)} ya puede pedir libros.`;
  }
  return `❌ ${esc(data.nombre)} no tendrá acceso.`;
}

async function solicitados() {
  const { data } = await db.from("pedidos").select("id,titulo,autor,created_at,usuarios(nombre)")
    .eq("estado", "solicitado").order("id");
  return data ?? [];
}

async function onMessage(m: any) {
  const chat = m.chat?.id, from = m.from?.id;
  const text: string = (m.text || "").trim();
  if (!chat || !text.startsWith("/")) return;
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  const arg = text.slice(text.split(/\s+/)[0].length).trim();

  const { data: owner } = await db.from("usuarios").select("tg_id").eq("es_dueno", true).maybeSingle();
  const isOwner = owner?.tg_id === from;

  if (cmd === "/start" || cmd === "/app" || cmd === "/ayuda" || cmd === "/help") {
    await say(chat, isOwner && cmd !== "/app" ? HELP_OWNER : HELP_USER, { reply_markup: appButton });
    return;
  }
  if (!isOwner) {
    await say(chat, HELP_USER, { reply_markup: appButton });
    return;
  }

  switch (cmd) {
    case "/libro": {
      const [titulo, autor] = arg.split("|").map((x) => x.trim());
      if (!titulo) return void await say(chat, "Formato: /libro Título | Autor");
      await db.from("pedidos").insert({
        tg_id: from, titulo: titulo.slice(0, 300), autor: autor ? autor.slice(0, 200) : null,
        paso: "Pedido desde el chat del bot",
      });
      const ya = await despertarTrabajador();
      await say(chat, ya ? "👍 Pedido recibido. Empiezo enseguida." : "👍 Pedido recibido. El bot lo recogerá en unos minutos.");
      return;
    }
    case "/pendientes": {
      const ps = await solicitados();
      if (!ps.length) return void await say(chat, "No hay pedidos esperando en el grupo.");
      const lines = ps.map((p: any, i: number) =>
        `${i + 1}. ${esc(p.titulo)}${p.autor ? " — " + esc(p.autor) : ""} (${esc(p.usuarios?.nombre)}, desde ${String(p.created_at).slice(0, 10)})`);
      return void await say(chat, "⏳ Esperando en el grupo:\n" + lines.join("\n"));
    }
    case "/cancelar": {
      const n = parseInt(arg, 10);
      const ps = await solicitados();
      if (!(n >= 1 && n <= ps.length)) return void await say(chat, "Número no válido. Mira /pendientes.");
      const p: any = ps[n - 1];
      await db.from("pedidos").update({ estado: "cancelado", paso: "Cancelado" }).eq("id", p.id);
      return void await say(chat, `🗑️ Cancelado: ${esc(p.titulo)}`);
    }
    case "/usuarios": {
      const { data } = await db.from("usuarios").select("tg_id,nombre,estado,kindle_email").order("created_at");
      const icon: Record<string, string> = { aprobado: "✅", pendiente: "⏳", rechazado: "❌" };
      const lines = (data ?? []).map((u: any) =>
        `${icon[u.estado] ?? "•"} ${esc(u.nombre)} — ${esc(u.kindle_email || "sin Kindle")} — id <code>${u.tg_id}</code>`);
      return void await say(chat, "👥 Usuarios:\n" + (lines.join("\n") || "Ninguno") + "\n\nPara cambiar: /aprobar ID o /rechazar ID");
    }
    case "/aprobar":
    case "/rechazar": {
      const id = parseInt(arg, 10);
      if (!id) return void await say(chat, `Formato: ${cmd} ID (míralo en /usuarios)`);
      return void await say(chat, await setEstadoUsuario(id, cmd === "/aprobar" ? "aprobado" : "rechazado"));
    }
    case "/reenviar": {
      const { count } = await db.from("pedidos").select("id", { count: "exact", head: true }).eq("estado", "descargado");
      if (!count) return void await say(chat, "No hay envíos pendientes de reintentar.");
      await despertarTrabajador();
      return void await say(chat, `📤 Hay ${count} envío(s) pendiente(s). El bot los reintenta en su próxima ronda (cada pocos minutos).`);
    }
    case "/probarcorreo": {
      await db.from("config").upsert({ clave: "probar_correo", valor: "1" });
      await despertarTrabajador();
      return void await say(chat, "📧 De acuerdo: en su próxima ronda el bot te enviará un correo de prueba y te avisará aquí.");
    }
    case "/estado": {
      const ronda = await getConfig("ultima_ronda");
      const err = await getConfig("ultimo_error");
      const { count: cola } = await db.from("pedidos").select("id", { count: "exact", head: true }).eq("estado", "nuevo");
      const cuando = ronda
        ? new Date(ronda).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" })
        : "todavía nunca";
      return void await say(chat,
        `🤖 Última ronda del bot: <b>${cuando}</b>\n📥 Pedidos en cola: ${cola ?? 0}` +
        (err ? `\n⚠️ Último error: ${esc(err).slice(0, 300)}` : ""));
    }
    default:
      await say(chat, HELP_OWNER, { reply_markup: appButton });
  }
}

async function onCallback(q: any) {
  const { data: owner } = await db.from("usuarios").select("tg_id").eq("es_dueno", true).maybeSingle();
  const match = /^(ok|no):(\d+)$/.exec(q.data || "");
  if (!match || owner?.tg_id !== q.from?.id) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Solo el dueño puede hacer esto." });
    return;
  }
  const texto = await setEstadoUsuario(Number(match[2]), match[1] === "ok" ? "aprobado" : "rechazado");
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  if (q.message) {
    await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: texto, parse_mode: "HTML" });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  TOKEN = (await getConfig("bot_token")) || "";
  if (!TOKEN) return new Response("sin token", { status: 503 });
  // Telegram firma cada llamada con el secreto que se le dio al configurar el webhook
  const secret = (await sha256("webhook:" + TOKEN)).slice(0, 48);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("no", { status: 401 });
  try {
    const update = await req.json();
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok"); // siempre 200 para que Telegram no reintente en bucle
});
