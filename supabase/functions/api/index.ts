// API de la app de libros.
//  - La mini-app de Telegram se autentica con initData (firmado por Telegram).
//  - Desde el navegador, con el Telegram Login Widget (x-telegram-login).
//  - El bot del ordenador se autentica con un secreto compartido (x-bot-secret).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, x-telegram-init-data, x-telegram-login, x-bot-secret, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256(text: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getConfig(clave: string): Promise<string | null> {
  const { data } = await db.from("config").select("valor").eq("clave", clave).maybeSingle();
  return data?.valor ?? null;
}

async function setConfig(clave: string, valor: string) {
  const { error } = await db.from("config").upsert({ clave, valor });
  if (error) throw new HttpError(500, error.message);
}

// Despierta al trabajador de GitHub al momento (si hay token configurado; si no, espera a su ronda)
async function despertarTrabajador() {
  const token = await getConfig("gh_token");
  if (!token) return;
  try {
    await fetch("https://api.github.com/repos/MiNombreEsDani/libros-app/dispatches", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "libros-app" },
      body: JSON.stringify({ event_type: "pedido" }),
    });
  } catch (_) { /* no es grave: la ronda programada lo recogerá */ }
}

// ---------------------------------------------------------------- Telegram
async function telegramUser(initData: string) {
  const token = await getConfig("bot_token");
  if (!token) throw new HttpError(503, "El bot aún no está configurado.");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new HttpError(401, "Inicia sesión para continuar.");
  params.delete("hash");
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), token);
  const calc = hex(await hmac(secret, check));
  if (!safeEqual(calc, hash)) throw new HttpError(401, "Sesión de Telegram no válida.");
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > 7 * 24 * 3600) {
    throw new HttpError(401, "Sesión caducada. Cierra y vuelve a abrir la app.");
  }
  const user = JSON.parse(params.get("user") || "null");
  if (!user?.id) throw new HttpError(401, "No se pudo identificar al usuario.");
  return user as { id: number; first_name?: string; last_name?: string; username?: string };
}

// Inicio de sesión desde el navegador (Telegram Login Widget)
// https://core.telegram.org/widgets/login#checking-authorization
async function telegramWebLogin(raw: string) {
  const token = await getConfig("bot_token");
  if (!token) throw new HttpError(503, "El bot aún no está configurado.");
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { throw new HttpError(401, "Inicio de sesión no válido."); }
  const hash = String(data.hash || "");
  const check = Object.keys(data).filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(token));
  const calc = hex(await hmac(secret, check));
  if (!hash || !safeEqual(calc, hash)) throw new HttpError(401, "Inicio de sesión no válido. Vuelve a entrar.");
  if (Date.now() / 1000 - Number(data.auth_date || 0) > 30 * 24 * 3600) {
    throw new HttpError(401, "Sesión caducada. Vuelve a iniciar sesión.");
  }
  return {
    id: Number(data.id),
    first_name: data.first_name as string | undefined,
    last_name: data.last_name as string | undefined,
    username: data.username as string | undefined,
  };
}

const KINDLE_RE = /^[a-z0-9._%+-]+@(free\.)?kindle\.com$/i;

async function appAction(action: string, body: any, initData: string, webLogin: string) {
  const tg = webLogin ? await telegramWebLogin(webLogin) : await telegramUser(initData);
  const nombre = [tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || String(tg.id);

  // Registrar / actualizar al usuario en cada llamada
  let { data: me } = await db.from("usuarios").select("*").eq("tg_id", tg.id).maybeSingle();
  if (!me) {
    // ignoreDuplicates: si dos peticiones llegan a la vez, no falla
    await db.from("usuarios").upsert(
      { tg_id: tg.id, nombre, username: tg.username ?? null },
      { onConflict: "tg_id", ignoreDuplicates: true },
    );
    const r = await db.from("usuarios").select("*").eq("tg_id", tg.id).single();
    if (r.error) throw new HttpError(500, r.error.message);
    me = r.data;
  } else if (me.nombre !== nombre || me.username !== (tg.username ?? null)) {
    await db.from("usuarios").update({ nombre, username: tg.username ?? null }).eq("tg_id", tg.id);
  }

  const perfil = {
    nombre,
    estado: me.estado,
    kindle_email: me.kindle_email,
    es_dueno: me.es_dueno,
  };

  switch (action) {
    case "me":
      return perfil;

    case "set_kindle": {
      const email = String(body.email || "").trim().toLowerCase();
      if (!KINDLE_RE.test(email)) throw new HttpError(400, "Debe ser una dirección @kindle.com.");
      await db.from("usuarios").update({ kindle_email: email }).eq("tg_id", tg.id);
      return { ...perfil, kindle_email: email };
    }

    case "pedir": {
      if (me.estado !== "aprobado") {
        throw new HttpError(403, me.estado === "rechazado"
          ? "Tu acceso ha sido denegado."
          : "Tu acceso está pendiente de aprobación.");
      }
      if (!me.kindle_email) throw new HttpError(400, "Primero indica tu correo de Kindle.");
      const titulo = String(body.titulo || "").trim().slice(0, 300);
      const autor = String(body.autor || "").trim().slice(0, 200);
      if (!titulo) throw new HttpError(400, "Escribe el título del libro.");
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await db.from("pedidos").select("id", { count: "exact", head: true })
        .eq("tg_id", tg.id).gte("created_at", since);
      if ((count ?? 0) >= 15) throw new HttpError(429, "Has llegado al máximo de 15 pedidos al día.");
      const { data, error } = await db.from("pedidos")
        .insert({ tg_id: tg.id, titulo, autor: autor || null, paso: "En cola: el bot lo recogerá en unos minutos" })
        .select().single();
      if (error) throw new HttpError(500, error.message);
      await despertarTrabajador();
      return data;
    }

    case "biblioteca": {
      const { data, error } = await db.from("pedidos")
        .select("id,titulo,autor,estado,paso,archivo,destino,created_at,updated_at")
        .eq("tg_id", tg.id).order("created_at", { ascending: false }).limit(200);
      if (error) throw new HttpError(500, error.message);
      return { perfil, pedidos: data };
    }

    default:
      throw new HttpError(400, "Acción desconocida.");
  }
}

// ---------------------------------------------------------------- Bot
// Claves de config que el trabajador puede leer/escribir
const CONFIG_BOT = ["ultimo_msg_id", "probar_correo", "ultima_ronda", "ultimo_error"];

const ESTADOS = ["nuevo", "buscando", "solicitado", "descargado", "enviado", "error", "cancelado"];

async function botAction(action: string, body: any) {
  switch (action) {
    case "register": {
      // El bot se presenta al arrancar: guarda su token (para validar la app) y el dueño.
      const token = String(body.bot_token || "");
      if (!/^\d+:[\w-]{30,}$/.test(token)) throw new HttpError(400, "bot_token no válido");
      await setConfig("bot_token", token);
      if (body.bot_username) await setConfig("bot_username", String(body.bot_username).replace(/^@/, ""));
      const ownerId = Number(body.owner_id);
      if (ownerId) {
        const { data: u } = await db.from("usuarios").select("kindle_email").eq("tg_id", ownerId).maybeSingle();
        await db.from("usuarios").upsert({
          tg_id: ownerId,
          nombre: body.owner_name ?? "Dueño",
          estado: "aprobado",
          es_dueno: true,
          avisado: true,
          kindle_email: u?.kindle_email || body.owner_kindle || null,
        });
      }
      return { ok: true };
    }

    case "claim": {
      const { data: pedidos, error } = await db.rpc("reclamar_pedidos_v2");
      if (error) throw new HttpError(500, error.message);
      const { data: nuevos } = await db.from("usuarios")
        .update({ avisado: true }).eq("avisado", false).eq("estado", "pendiente")
        .select("tg_id,nombre,username");
      return { pedidos: pedidos ?? [], usuarios_nuevos: nuevos ?? [] };
    }

    case "update": {
      const id = Number(body.id);
      const patch: Record<string, unknown> = {};
      if (body.estado) {
        if (!ESTADOS.includes(body.estado)) throw new HttpError(400, "estado no válido");
        patch.estado = body.estado;
      }
      for (const k of ["paso", "archivo", "destino", "request_msg_id", "archivo_msg_id"]) if (k in body) patch[k] = body[k];
      const { error } = await db.from("pedidos").update(patch).eq("id", id);
      if (error) throw new HttpError(500, error.message);
      return { ok: true };
    }

    case "crear": {
      const tgId = Number(body.tg_id);
      const { data, error } = await db.from("pedidos").insert({
        tg_id: tgId,
        titulo: String(body.titulo).slice(0, 300),
        autor: body.autor ? String(body.autor).slice(0, 200) : null,
        paso: "Pedido desde el chat del bot",
      }).select().single();
      if (error) throw new HttpError(500, error.message);
      return data;
    }

    case "solicitados":
    case "reintentos": {
      // solicitados: pedidos publicados en el grupo, esperando a que alguien suba el libro
      // reintentos: libros ya localizados cuyo envío por correo falló
      const estado = action === "solicitados" ? "solicitado" : "descargado";
      const { data, error } = await db.from("pedidos")
        .select("id,tg_id,titulo,autor,request_msg_id,archivo_msg_id,created_at,usuarios(kindle_email,es_dueno,nombre)")
        .eq("estado", estado).order("id");
      if (error) throw new HttpError(500, error.message);
      return {
        pedidos: (data ?? []).map((p: any) => ({
          ...p, kindle_email: p.usuarios?.kindle_email, es_dueno: p.usuarios?.es_dueno, nombre: p.usuarios?.nombre,
          usuarios: undefined,
        })),
      };
    }

    case "get_config": {
      const out: Record<string, string | null> = {};
      for (const k of (body.claves ?? []) as string[]) {
        if (CONFIG_BOT.includes(k)) out[k] = await getConfig(k);
      }
      return out;
    }

    case "set_config": {
      const k = String(body.clave);
      if (!CONFIG_BOT.includes(k)) throw new HttpError(400, "clave no permitida");
      if (body.valor === null || body.valor === undefined) await db.from("config").delete().eq("clave", k);
      else await setConfig(k, String(body.valor));
      return { ok: true };
    }

    case "usuarios": {
      const { data } = await db.from("usuarios")
        .select("tg_id,nombre,username,estado,kindle_email,es_dueno").order("created_at");
      return { usuarios: data ?? [] };
    }

    case "set_estado_usuario": {
      const estado = String(body.estado);
      if (!["aprobado", "rechazado", "pendiente"].includes(estado)) throw new HttpError(400, "estado no válido");
      const { data, error } = await db.from("usuarios").update({ estado })
        .eq("tg_id", Number(body.tg_id)).select("tg_id,nombre,estado").maybeSingle();
      if (error) throw new HttpError(500, error.message);
      if (!data) throw new HttpError(404, "Usuario no encontrado");
      return data;
    }

    default:
      throw new HttpError(400, "Acción desconocida.");
  }
}

// ---------------------------------------------------------------- Servidor
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const botSecret = req.headers.get("x-bot-secret");
    if (botSecret) {
      const expected = await getConfig("bot_secret_sha256");
      if (!expected || !safeEqual(await sha256(botSecret), expected)) {
        throw new HttpError(401, "Secreto del bot no válido");
      }
      return json(await botAction(action, body));
    }
    if (action === "info") {
      // Público: lo que necesita la página de acceso (nombre del bot para el botón de Telegram)
      return json({ bot_username: await getConfig("bot_username") });
    }
    const initData = req.headers.get("x-telegram-init-data") || "";
    const webLogin = req.headers.get("x-telegram-login") || "";
    return json(await appAction(action, body, initData, webLogin));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message || "Error" }, status);
  }
});
