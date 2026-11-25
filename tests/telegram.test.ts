// Fluxo do bot: webhook automático, vincular, registrar despesa, /saldo e /extrato.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handleApi, type Env } from "../src/worker.js";
import { wrapPool } from "../src/db.js";
import { miniPool } from "./pgmini.js";
import { ensureWebhook, webhookSecret } from "../src/integrations/telegram-setup.js";

const ORIGIN = "http://localhost:8787";
const TOKEN = "123:TESTE";
const env = { NODE_ENV: "development", EMAIL_TOKEN_SECRET: "x", APP_ORIGIN: ORIGIN, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: "cashflow_pi_bot" } as unknown as Env;
process.env.NODE_ENV = "development"; process.env.APP_ORIGIN = ORIGIN; process.env.EMAIL_TOKEN_SECRET = "x";
const db = wrapPool(miniPool() as any);
const stamp = Date.now();
const email = `tg${stamp}@gmail.com`;
const sent: any[] = [];
const realFetch = globalThis.fetch;
// Igual ao Worker: fetch chamado como método de outro objeto falha.
globalThis.fetch = (async function (this: any, url: any, init?: any) {
  if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/")) {
    const method = u.split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    sent.push({ method, body });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    return Response.json({ ok: true, result: true });
  }
  return realFetch(url, init);
}) as any;
after(async () => {
  globalThis.fetch = realFetch;
  const id = (await db.query("SELECT id FROM usuarios WHERE email=$1", [email])).rows[0]?.id;
  if (id) {
    for (const t of ["sessoes", "transacoes", "operacoes", "notificacoes", "telegram_vinculos"]) await db.query(`DELETE FROM ${t} WHERE usuario_id=$1`, [id]);
    await db.query("DELETE FROM usuarios WHERE id=$1", [id]);
  }
  await db.query("DELETE FROM telegram_updates WHERE update_id >= $1", [stamp]);
  await db.end();
});
let cookie = "";
async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const request = new Request(ORIGIN + path, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "10.7.7." + (stamp % 200), ...(cookie ? { cookie } : {}), ...headers },
  });
  const { response, background } = await handleApi(request, env, { waitUntil() {} }, db);
  await Promise.allSettled(background);
  for (const c of response.headers.getSetCookie()) cookie = c.split(";")[0];
  return { status: response.status, data: await response.json().catch(() => null) };
}
let upd = stamp;
const msg = (text: string) => ({ update_id: ++upd, message: { message_id: upd, text, chat: { id: 777, type: "private" }, from: { id: 777, username: "Amanda_Teste" } } });
const secret = webhookSecret(TOKEN);

test("webhook automático aponta para o site e cadastra comandos", async () => {
  const r = await ensureWebhook(TOKEN, ORIGIN, secret, fetch, true);
  assert.equal(r, "atualizado");
  const set = sent.find((s) => s.method === "setWebhook");
  assert.equal(set.body.url, ORIGIN + "/api/telegram/webhook");
  assert.equal(set.body.secret_token, secret);
  assert.ok(sent.some((s) => s.method === "setMyCommands"));
});

test("vincular pelo código, registrar despesa, /saldo e /extrato", async () => {
  assert.equal((await call("POST", "/api/cadastro/etapa1", { nome: "Pessoa Telegram", email, senha: "SenhaTg@2026", consentimento: true })).status, 200);
  assert.equal((await call("GET", "/api/config/publica")).data.telegramBot, "cashflow_pi_bot");
  const gen = await call("POST", "/api/telegram", { acao: "gerar", nome_telegram: "@Amanda_Teste" });
  assert.equal(gen.status, 200, JSON.stringify(gen.data));
  // Webhook sem o segredo é recusado.
  assert.equal((await call("POST", "/api/telegram/webhook", msg("oi"))).status, 403);
  const hook = (u: any) => call("POST", "/api/telegram/webhook", u, { "x-telegram-bot-api-secret-token": secret });
  sent.length = 0;
  assert.equal((await hook(msg(`/start ${gen.data.codigo}`))).status, 200);
  assert.match(sent.find((s) => s.method === "sendMessage")?.body.text ?? "", /vinculado com sucesso/);
  sent.length = 0;
  await hook(msg("despesa mercado 30,50"));
  assert.match(sent.find((s) => s.method === "sendMessage")?.body.text ?? "", /registrada/);
  sent.length = 0;
  await hook(msg("/saldo"));
  assert.match(sent.find((s) => s.method === "sendMessage")?.body.text ?? "", /Despesas: R\$\s?30,50/);
  sent.length = 0;
  await hook(msg("/extrato"));
  assert.match(sent.find((s) => s.method === "sendMessage")?.body.text ?? "", /mercado/);
  const tx = await call("GET", "/api/transacoes");
  assert.equal(tx.data.transactions.length, 1);
  assert.equal(tx.data.transactions[0].amount, 30.5);
});
