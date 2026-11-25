// Fluxo do bot: webhook automático, vincular, registrar despesa, /saldo e /extrato.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handleApi, type Env } from "../src/worker.js";
import { wrapPool } from "../src/db.js";
import { miniPool } from "./pgmini.js";
import { ensureWebhook, ensureProfile, webhookSecret, COMMANDS } from "../src/integrations/telegram-setup.js";

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
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body) : init?.body ? JSON.parse(init.body) : {};
    sent.push({ method, body });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "getMyDescription") return Response.json({ ok: true, result: { description: "" } });
    if (method === "getMyCommands") return Response.json({ ok: true, result: [] });
    if (method === "getMyName") return Response.json({ ok: true, result: { name: "CashFlow" } });
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
});

test("perfil do bot: nome, descrição, comandos e foto", async () => {
  sent.length = 0;
  const r = await ensureProfile(TOKEN, async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), fetch, true);
  assert.equal(r, "atualizado");
  const methods = sent.map((x) => x.method);
  for (const m of ["setMyCommands", "setMyName", "setMyShortDescription", "setMyProfilePhoto", "setMyDescription"]) assert.ok(methods.includes(m), m);
  assert.equal(sent.find((x) => x.method === "setMyCommands").body.commands.length, COMMANDS.length);
  assert.match(String(sent.find((x) => x.method === "setMyProfilePhoto").body.photo), /attach:\/\/avatar/);
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

  const reply = async (text: string) => {
    sent.length = 0;
    await hook(msg(text));
    return sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text).join("\n---\n");
  };
  const cbk = async (data: string) => {
    sent.length = 0;
    await hook({ update_id: ++upd, callback_query: { id: "cb" + upd, data, from: { id: 777, username: "Amanda_Teste" }, message: { message_id: upd, chat: { id: 777, type: "private" } } } });
    return sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text).join("\n---\n");
  };
  assert.match(await reply("/ajuda"), /\/categorias/);
  assert.match(await reply("/receita salário 1000"), /Receita registrada/);
  assert.match(await reply("/despesa"), /Use assim/);
  assert.match(await reply("/mes"), /Saldo do mês/);
  assert.match(await reply("/hoje"), /mercado/);
  assert.match(await reply("/categorias"), /Alimentação: <b>R\$\s?30,50<\/b>/);
  assert.match(await reply("/limite"), /ainda não definiu/);
  assert.match(await reply("/dica"), /Dica/);
  assert.match(await reply("bom dia"), /Não entendi/);
  assert.match(await cbk("cmd:saldo"), /Saldo total/);
  const pergunta = await reply("/desfazer");
  assert.match(pergunta, /salário/);
  const undoId = sent.find((s) => s.method === "sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(await cbk(undoId), /Apagado/);
  assert.equal((await call("GET", "/api/transacoes")).data.transactions.length, 1);
  assert.match(await cbk("desvincular:sim"), /desvinculado/);
  assert.match(await reply("/saldo"), /vincule sua conta/);
});
