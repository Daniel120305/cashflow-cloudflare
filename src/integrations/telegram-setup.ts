// Liga o bot ao site sozinho: confere o webhook no Telegram e, se estiver
// diferente, aponta para <APP_ORIGIN>/api/telegram/webhook com o segredo.
// Assim ninguém precisa montar a URL de setWebhook com o token na mão.
import { createHash } from "node:crypto";

// Segredo do webhook: o de TELEGRAM_WEBHOOK_SECRET ou um derivado do token
// (o Telegram aceita letras, números, _ e -; até 256 caracteres).
export const webhookSecret = (token: string, explicit?: string) =>
  explicit || createHash("sha256").update("cashflow-webhook:" + token).digest("hex");

const COMMANDS = [
  { command: "saldo", description: "Resumo do mês: saldo, receitas e despesas" },
  { command: "extrato", description: "Últimas 20 transações" },
  { command: "vincular", description: "Vincular sua conta do CashFlow (código do perfil)" },
];

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
  await api("setMyCommands", { commands: COMMANDS }).catch(() => {});
  console.log("[CashFlow] Webhook do Telegram apontado para", url);
  return "atualizado";
}
