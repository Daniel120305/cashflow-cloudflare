// Ponto de entrada na Cloudflare.
// - Páginas/arquivos: servidos direto pelos "static assets" (pasta public/).
// - /api/*: este Worker, com o banco Supabase via Hyperdrive.
// - Cron a cada 5 minutos: filas do Telegram e alertas; limpeza de hora em hora.
import { buildApp } from "./app.js";
import { connectDatabase, type Database } from "./db.js";
import { resetSender, confirmSender } from "./integrations/mail.js";
import { checkEmailDomain } from "./integrations/email-check.js";
import { googleVerifier } from "./integrations/google.js";
import { TelegramService } from "./integrations/telegram.js";
import { workersAiOcr } from "./integrations/ocr.js";
import { aiTextInterpreter } from "./integrations/conversa.js";
import { ensureWebhook, ensureProfile, webhookSecret } from "./integrations/telegram-setup.js";
import { saveTransaction, monthlySummary } from "./services/finance.js";
import { drainQueues, cleanup } from "./services/queues.js";
import { redirectFor, assetFor, rewritePage } from "./pages.js";

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  HYPERDRIVE: { connectionString: string };
  AI?: { run: (model: string, input: any) => Promise<any> };
  APP_ORIGIN?: string;
  APP_EXTRA_ORIGINS?: string;
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  EMAIL_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  NODE_ENV?: string;
}
type Ctx = { waitUntil: (p: Promise<unknown>) => void };

// As integrações antigas leem process.env; copia as variáveis de texto para lá.
function loadEnv(env: Env) {
  const target = ((globalThis as any).process ??= { env: {} }).env as Record<string, string>;
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") target[k] = v;
  target.NODE_ENV ||= "production";
}

// Só o token é obrigatório: o segredo do webhook sai dele se não for definido.
const tgSecret = (env: Env) =>
  env.TELEGRAM_BOT_TOKEN ? webhookSecret(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET) : undefined;
const syncWebhook = (env: Env, force = false) =>
  env.TELEGRAM_BOT_TOKEN && env.APP_ORIGIN
    ? ensureWebhook(env.TELEGRAM_BOT_TOKEN, env.APP_ORIGIN, tgSecret(env)!, fetch, force)
    : Promise.resolve("sem token");

// Foto do bot: public/bot-avatar.jpg, lida dos próprios arquivos do site.
const syncProfile = (env: Env, force = false) =>
  env.TELEGRAM_BOT_TOKEN && env.APP_ORIGIN
    ? ensureProfile(
        env.TELEGRAM_BOT_TOKEN,
        async () => {
          const r = await env.ASSETS.fetch(new Request(new URL("/bot-avatar.jpg", env.APP_ORIGIN).toString()));
          return r.ok ? await r.blob() : undefined;
        },
        fetch,
        force,
      )
    : Promise.resolve("sem token");

const telegramFor = (db: Database, env: Env) =>
  env.TELEGRAM_BOT_TOKEN
    ? new TelegramService({
        db,
        token: env.TELEGRAM_BOT_TOKEN,
        ocr: workersAiOcr(env.AI),
        record: (uid, input) => saveTransaction(db, uid, input),
        summary: (uid, month) => monthlySummary(db, uid, month),
        siteUrl: env.APP_ORIGIN,
        interpret: aiTextInterpreter(env.AI),
      })
    : undefined;

export async function handleApi(request: Request, env: Env, ctx: Ctx, db: Database) {
  const background: Promise<unknown>[] = [];
  const later = (task: Promise<unknown>) =>
    background.push(task.catch((e) => console.error("Tarefa em segundo plano falhou:", String(e))));
  const production = (env.NODE_ENV ?? "production") === "production";
  const app = await buildApp(db, {
    production,
    appOrigin: env.APP_ORIGIN,
    extraOrigins: (env.APP_EXTRA_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean),
    googleClientId: env.GOOGLE_CLIENT_ID || undefined,
    verifyGoogle: googleVerifier(env.GOOGLE_CLIENT_ID || undefined),
    sendReset: resetSender(),
    sendConfirmation: confirmSender(),
    checkEmail: checkEmailDomain,
    telegramSecret: tgSecret(env),
    telegramBot: env.TELEGRAM_BOT_USERNAME || undefined,
    later,
    onTelegramUpdate: () => later(drainQueues(db, telegramFor(db, env), 3)),
  });
  const response = await app.handle(request);
  // Confere o webhook do bot de vez em quando (no máx. a cada 10 min por instância).
  later(syncWebhook(env));
  later(syncProfile(env));
  return { response, background };
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    // Endereço antigo (com .html) ou raiz: redireciona para o endereço curto.
    const moved = redirectFor(url);
    if (moved) return Response.redirect(moved, 301);
    // Endereço curto (/home, /perfil...): serve a página da pasta dela.
    const file = assetFor(url.pathname);
    if (file) {
      const page = await env.ASSETS.fetch(new Request(new URL(file, url).toString(), request));
      return rewritePage(page, file);
    }
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    loadEnv(env);
    let db: (Database & { end: () => Promise<void> }) | undefined;
    try {
      db = connectDatabase(env.HYPERDRIVE?.connectionString);
      const { response, background } = await handleApi(request, env, ctx, db);
      const conn = db;
      // Fecha o banco só depois das tarefas de fundo (emails, Telegram).
      ctx.waitUntil(Promise.allSettled(background).then(() => conn.end()));
      return response;
    } catch (error) {
      console.error("Falha ao atender a requisição:", error);
      if (db) ctx.waitUntil(db.end().catch(() => {}));
      return Response.json(
        { status: "error", message: "Não foi possível concluir agora. Tente novamente; se persistir, contate o suporte." },
        { status: 503 },
      );
    }
  },

  async scheduled(controller: { scheduledTime: number }, env: Env, ctx: Ctx) {
    loadEnv(env);
    const db = connectDatabase(env.HYPERDRIVE.connectionString);
    const run = async () => {
      try {
        await syncWebhook(env, true).catch((e) => console.error("Webhook do Telegram:", String(e)));
        await syncProfile(env, true).catch((e) => console.error("Perfil do bot:", String(e)));
        await drainQueues(db, telegramFor(db, env));
        // Limpeza uma vez por hora: poupa a cota diária de consultas do Hyperdrive.
        if (new Date(controller.scheduledTime).getUTCMinutes() < 5) await cleanup(db);
      } catch (error) {
        console.error("Tarefa agendada falhou:", String(error));
      } finally {
        await db.end();
      }
    };
    ctx.waitUntil(run());
  },
};
