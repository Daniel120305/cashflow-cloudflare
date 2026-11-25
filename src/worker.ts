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
import { saveTransaction, monthlySummary } from "./services/finance.js";
import { drainQueues, cleanup } from "./services/queues.js";

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
  NODE_ENV?: string;
}
type Ctx = { waitUntil: (p: Promise<unknown>) => void };

// As integrações antigas leem process.env; copia as variáveis de texto para lá.
function loadEnv(env: Env) {
  const target = ((globalThis as any).process ??= { env: {} }).env as Record<string, string>;
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") target[k] = v;
  target.NODE_ENV ||= "production";
}

const telegramFor = (db: Database, env: Env) =>
  env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET
    ? new TelegramService({
        db,
        token: env.TELEGRAM_BOT_TOKEN,
        ocr: workersAiOcr(env.AI),
        record: (uid, input) => saveTransaction(db, uid, input),
        summary: (uid) => monthlySummary(db, uid),
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
    telegramSecret: env.TELEGRAM_WEBHOOK_SECRET,
    later,
    onTelegramUpdate: () => later(drainQueues(db, telegramFor(db, env), 3)),
  });
  const response = await app.handle(request);
  return { response, background };
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    // Abrir o site vai direto para a tela de login.
    if (url.pathname === "/" || url.pathname === "/index.html")
      return Response.redirect(new URL("/CashFlow_Tela_de_Login/login.html", url).toString(), 302);
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
