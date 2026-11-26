// Liga o bot ao site sozinho: confere o webhook no Telegram e, se estiver
// diferente, aponta para <APP_ORIGIN>/api/telegram/webhook com o segredo.
// Assim ninguém precisa montar a URL de setWebhook com o token na mão.
import { createHash } from "node:crypto";

// Segredo do webhook: o de TELEGRAM_WEBHOOK_SECRET ou um derivado do token
// (o Telegram aceita letras, números, _ e -; até 256 caracteres).
export const webhookSecret = (token: string, explicit?: string) =>
  explicit || createHash("sha256").update("cashflow-webhook:" + token).digest("hex");

export const COMMANDS = [
  { command: "saldo", description: "💰 Saldo total e do mês" },
  { command: "mes", description: "📅 Resumo do mês e comparação com o anterior" },
  { command: "hoje", description: "📆 Lançamentos de hoje" },
  { command: "extrato", description: "🧾 Últimos 10 lançamentos" },
  { command: "categorias", description: "📊 Onde você mais gastou no mês" },
  { command: "limite", description: "🎯 Gasto máximo: usado e restante" },
  { command: "despesa", description: "🔴 Registrar despesa (ex.: /despesa mercado 35,90)" },
  { command: "receita", description: "🟢 Registrar receita (ex.: /receita salário 3000)" },
  { command: "desfazer", description: "↩️ Apagar o último lançamento" },
  { command: "dica", description: "💡 Dica rápida de finanças" },
  { command: "site", description: "🌐 Abrir o CashFlow" },
  { command: "ajuda", description: "❓ Todos os comandos e exemplos" },
  { command: "vincular", description: "🔗 Vincular sua conta (código do Perfil)" },
  { command: "desvincular", description: "⛔ Desligar este Telegram da conta" },
];
export const BOT_NAME = "CashFlow - Assistente Financeiro";
// "O que este bot faz?" (aparece antes de iniciar a conversa).
export const BOT_DESCRIPTION =
  "Seu assistente financeiro do CashFlow 💰\n\n" +
  "• Registre gastos e receitas: /despesa mercado 35,90 ou escreva do seu jeito, como \"gastei 50 no mercado\"\n" +
  "• Mande a foto do cupom fiscal: eu leio e você corrige o que precisar\n" +
  "• Fale por áudio: \"gastei cinquenta no mercado\" ou \"apaga a despesa do uber\"\n" +
  "• Consulte /saldo, /extrato, /categorias e /limite\n" +
  "• Receba alertas quando chegar a 80% do limite\n\n" +
  "Para começar, vincule sua conta no Perfil do site.";
// Bio do perfil do bot (até 120 caracteres).
export const BOT_SHORT = "Assistente do CashFlow: registre gastos, veja seu saldo e receba alertas pelo Telegram.";

async function call(token: string, method: string, body: object | FormData, fetcher: typeof fetch) {
  const isForm = body instanceof FormData;
  const r = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await r.json()) as any;
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? r.status}`);
  return data.result;
}

// Nome, descrição, bio, comandos e foto do bot. Só mexe quando a descrição
// no Telegram é diferente da atual (assim a foto não é reenviada toda hora).
let profileAt = 0;
export async function ensureProfile(
  token: string,
  avatar: () => Promise<Blob | undefined>,
  fetcher: typeof fetch = fetch,
  force = false,
) {
  if (!force && Date.now() - profileAt < 30 * 60000) return "recente";
  profileAt = Date.now();
  const current = await call(token, "getMyDescription", {}, fetcher);
  const cmds = await call(token, "getMyCommands", {}, fetcher);
  const sameCommands = JSON.stringify((cmds ?? []).map((c: any) => c.command)) === JSON.stringify(COMMANDS.map((c) => c.command));
  const name = await call(token, "getMyName", {}, fetcher).catch(() => ({ name: BOT_NAME }));
  // Só o nome mudou: troca o nome e não reenvia a foto.
  if (current?.description === BOT_DESCRIPTION && sameCommands) {
    if (name?.name === BOT_NAME) return "ok";
    await call(token, "setMyName", { name: BOT_NAME }, fetcher);
    console.log("[CashFlow] Nome do bot atualizado:", BOT_NAME);
    return "nome";
  }
  await call(token, "setMyCommands", { commands: COMMANDS }, fetcher);
  await call(token, "setMyName", { name: BOT_NAME }, fetcher).catch((e) => console.warn(String(e)));
  await call(token, "setMyShortDescription", { short_description: BOT_SHORT }, fetcher);
  const image = await avatar().catch(() => undefined);
  if (image) {
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
    form.append("avatar", image, "cashflow.jpg");
    await call(token, "setMyProfilePhoto", form, fetcher).catch((e) => console.warn("Foto do bot:", String(e)));
  }
  // Por último: é o que marca o perfil como atualizado.
  await call(token, "setMyDescription", { description: BOT_DESCRIPTION }, fetcher);
  console.log("[CashFlow] Perfil do bot atualizado (nome, descrição, comandos e foto).");
  return "atualizado";
}

let checkedAt = 0;
export async function ensureWebhook(
  token: string,
  origin: string,
  secret: string,
  fetcher: typeof fetch = fetch,
  force = false,
) {
  // No máximo uma conferência a cada 10 min por instância.
  if (!force && Date.now() - checkedAt < 10 * 60000) return "recente";
  checkedAt = Date.now();
  const api = async (method: string, body?: object) => {
    const r = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await r.json()) as any;
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? r.status}`);
    return data.result;
  };
  const url = new URL("/api/telegram/webhook", origin).toString();
  const info = await api("getWebhookInfo");
  if (info.url === url) return "ok";
  await api("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 10,
  });
  console.log("[CashFlow] Webhook do Telegram apontado para", url);
  return "atualizado";
}
