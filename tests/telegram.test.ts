// Fluxo do bot: webhook automático, vincular, registrar despesa, /saldo e /extrato.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handleApi, type Env } from "../src/worker.js";
import { wrapPool } from "../src/db.js";
import { miniPool } from "./pgmini.js";
import { ensureWebhook, ensureProfile, webhookSecret, COMMANDS } from "../src/integrations/telegram-setup.js";

const ORIGIN = "http://localhost:8787";
const TOKEN = "123:TESTE";
const aiCalls: any[] = [];
const fakeAi = {
  run: async (model: string, input: any) => {
    aiCalls.push(input);
    // IA de texto (reserva da conversa)
    if (model.includes("llama-3.1")) return { response: '{"acao":"lancamento","tipo":"despesa","valor":"45","descricao":"farmácia","categoria":"saude","data":"' + new Date().toISOString().slice(0, 10) + '"}' };
    return { response: '{"estabelecimento":"Shopping Som","data":"24/07/2026","total":"R$ 1.100,00"}' };
  },
};
const env = { NODE_ENV: "development", EMAIL_TOKEN_SECRET: "x", APP_ORIGIN: ORIGIN, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: "cashflow_pi_bot", AI: fakeAi } as unknown as Env;
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
  if (u.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "content-length": "6" } });
  if (u.startsWith("https://api.telegram.org/")) {
    const method = u.split("/").pop();
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body) : init?.body ? JSON.parse(init.body) : {};
    sent.push({ method, body });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "getMyDescription") return Response.json({ ok: true, result: { description: "" } });
    if (method === "getMyCommands") return Response.json({ ok: true, result: [] });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
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
  assert.match(await reply("bom dia"), /comandos/);
  assert.match(await cbk("cmd:saldo"), /Saldo total/);
  const pergunta = await reply("/desfazer");
  assert.match(pergunta, /salário/);
  const undoId = sent.find((s) => s.method === "sendMessage").body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(await cbk(undoId), /Apagado/);
  assert.equal((await call("GET", "/api/transacoes")).data.transactions.length, 1);
  // Foto do cupom: lê pela IA, pergunta e deixa corrigir antes de registrar.
  sent.length = 0;
  await hook({ update_id: ++upd, message: { message_id: upd, chat: { id: 777, type: "private" }, from: { id: 777, username: "Amanda_Teste" }, photo: [{ file_id: "p1", file_size: 6 }] } });
  const lido = sent.filter((x) => x.method === "sendMessage").map((x) => x.body.text).join("\n");
  assert.match(lido, /Lendo o comprovante/);
  assert.match(lido, /Shopping Som/);
  assert.match(lido, /R\$\s?1\.100,00/);
  const card = sent.find((x) => x.body?.reply_markup?.inline_keyboard?.[1]);
  const editButtons = card.body.reply_markup.inline_keyboard[1].map((b: any) => b.text).join(" ");
  assert.match(editButtons, /Valor.*Data.*Categoria.*Nome/);
  // Correção escrita, como a Amanda fez.
  assert.match(await reply("Só troca para 2.100"), /atualizei[\s\S]*R\$\s?2\.100,00/);
  // Correção por botões: categoria e data.
  const pid = card.body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  assert.match(await cbk(`editar:cat:${pid}`), /Escolha a categoria/);
  assert.match(await cbk(`cat:${pid}:lazer`), /Lazer/);
  assert.match(await cbk(`quando:${pid}:hoje`), /atualizei/);
  assert.match(await reply("nome Shopping Som Brasília"), /Shopping Som Brasília/);
  assert.match(await reply("pode registrar"), /Despesa registrada: <b>Shopping Som Brasília<\/b> · R\$\s?2\.100,00/);
  let txs = (await call("GET", "/api/transacoes")).data.transactions;
  const shop = txs.find((t: any) => t.description === "Shopping Som Brasília");
  assert.equal(shop.amount, 2100);
  assert.equal(shop.category, "lazer");
  // Linguagem natural e perguntas.
  assert.match(await reply("gastei 50 no mercado ontem"), /Despesa registrada[\s\S]*Mercado[\s\S]*R\$\s?50,00/);
  assert.match(await reply("quanto gastei esse mês?"), /Saldo do mês/);
  assert.match(await reply("oi"), /comandos/);
  // Reserva: IA de texto entende e pede confirmação.
  const entendi = await reply("farmácia 45 hoje cedo");
  assert.match(entendi, /Entendi assim[\s\S]*Farmácia[\s\S]*R\$\s?45,00/);
  assert.match(await reply("sim"), /Despesa registrada: <b>Farmácia<\/b>/);
  txs = (await call("GET", "/api/transacoes")).data.transactions;
  assert.ok(txs.some((t: any) => t.description === "Farmácia" && t.amount === 45 && t.category === "saude"));
  assert.match(await cbk("desvincular:sim"), /desvinculado/);
  // Desconectar pelo site também funciona (com RLS do usuário).
  await call("POST", "/api/telegram", { acao: "gerar", nome_telegram: "Amanda_Teste" });
  const off = await call("POST", "/api/telegram", { acao: "desvincular" });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await call("POST", "/api/telegram", { acao: "verificar" })).data.tem_codigo, false);
  assert.match(await reply("/saldo"), /vincule sua conta/);
});
