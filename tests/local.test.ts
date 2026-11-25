// Teste de ponta a ponta do Worker rodando no Node contra um PostgreSQL local.
// Rodar: DB local com as migrações aplicadas e `node --import tsx --test tests/`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { handleApi, type Env } from "../src/worker.js";
import { wrapPool } from "../src/db.js";
import { miniPool } from "./pgmini.js";
import { workersAiOcr } from "../src/integrations/ocr.js";
import { checkEmailDomain } from "../src/integrations/email-check.js";

const ORIGIN = "http://localhost:8787";
const env = {
  NODE_ENV: "development",
  EMAIL_TOKEN_SECRET: "segredo-de-teste",
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: "cliente-teste.apps.googleusercontent.com",
} as unknown as Env;
process.env.NODE_ENV = "development";
process.env.APP_ORIGIN = ORIGIN;
process.env.EMAIL_TOKEN_SECRET = "segredo-de-teste";

const db = wrapPool(miniPool() as any);
const logs: string[] = [];
const realLog = console.log;
const stamp = Date.now();
const legacyEmail = `legado${stamp}@gmail.com`;
const newEmail = `novo${stamp}@gmail.com`;

// Cliente com "pote de cookies", como o navegador.
function client() {
  let cookie = "";
  return async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const request = new Request(ORIGIN + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { origin: ORIGIN } : {}),
        ...(cookie ? { cookie } : {}),
        "cf-connecting-ip": "10.0.0." + (stamp % 200),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const background: Promise<unknown>[] = [];
    const { response, background: bg } = await handleApi(request, env, { waitUntil: (p) => background.push(p) }, db);
    await Promise.allSettled(bg);
    const set = response.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(";");
      cookie = /Max-Age=0/.test(c) ? "" : pair;
    }
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, setCookie: set };
  };
}

before(async () => {
  console.log = (...a: any[]) => {
    logs.push(a.join(" "));
  };
  // Usuário "antigo": senha bcrypt com prefixo $2b$, como o bcryptjs grava no Render.
  const h = (await db.query("SELECT crypt('SenhaForte@123', gen_salt('bf', 10)) AS h")).rows[0].h as string;
  await db.query(
    "INSERT INTO usuarios(nome,email,senha,etapa,consentimento_em,consentimento_versao) VALUES('Pessoa Legada',$1,$2,3,NOW(),'2026-11-v1')",
    [legacyEmail, h.replace(/^\$2a\$/, "$2b$")],
  );
});
after(async () => {
  console.log = realLog;
  await db.query("DELETE FROM sessoes WHERE usuario_id IN (SELECT id FROM usuarios WHERE email IN ($1,$2))", [legacyEmail, newEmail]);
  for (const t of ["transacoes", "categorias", "operacoes", "notificacoes", "recuperacoes_senha"])
    await db.query(`DELETE FROM ${t} WHERE usuario_id IN (SELECT id FROM usuarios WHERE email IN ($1,$2))`, [legacyEmail, newEmail]);
  await db.query("DELETE FROM usuarios WHERE email IN ($1,$2)", [legacyEmail, newEmail]);
  await db.end();
});

test("login com senha antiga ($2b$ do bcryptjs) e senha errada", async () => {
  const api = client();
  assert.equal((await api("POST", "/api/login", { email: legacyEmail, senha: "errada" })).status, 401);
  assert.equal((await api("POST", "/api/login", { email: "naoexiste" + stamp + "@gmail.com", senha: "x" })).status, 401);
  const ok = await api("POST", "/api/login", { email: legacyEmail, senha: "SenhaForte@123", lembrar: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.match(ok.setCookie[0], /HttpOnly/);
  assert.match(ok.setCookie[0], /Max-Age=2592000/);
  const perfil = await api("GET", "/api/perfil");
  assert.equal(perfil.data.dados.email, legacyEmail);
});

test("transações, resumo, categorias e perfil", async () => {
  const api = client();
  await api("POST", "/api/login", { email: legacyEmail, senha: "SenhaForte@123" });
  const hoje = new Date().toISOString().slice(0, 10);
  const nova = await api("POST", "/api/transacoes", { description: "Salário", amount: "5000,00", category: "salario", type: "income", date: hoje, idempotency_key: "t1-" + stamp });
  assert.equal(nova.status, 200, JSON.stringify(nova.data));
  const gasto = await api("POST", "/api/transacoes", { description: "Mercado", amount: "350,90", category: "alimentacao", type: "expense", date: hoje, idempotency_key: "t2-" + stamp });
  assert.equal(gasto.status, 200, JSON.stringify(gasto.data));
  const lista = await api("GET", "/api/transacoes");
  assert.equal(lista.data.transactions.length, 2);
  assert.equal(typeof lista.data.transactions[0].amount, "number");
  const resumo = await api("GET", "/api/resumo");
  assert.equal(resumo.status, 200, JSON.stringify(resumo.data));
  const cat = await api("POST", "/api/categorias", { nome: "Bônus", tipo: "income" });
  assert.equal(cat.status, 200, JSON.stringify(cat.data));
  assert.equal((await api("POST", "/api/categorias", { nome: "Bônus", tipo: "income" })).status, 409);
  const cats = await api("GET", "/api/categorias");
  assert.equal(cats.data.categories.length, 1);
  const del = await api("POST", "/api/categorias/excluir", { id: cat.data.id });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  const perfil = await api("POST", "/api/perfil", { cidade: "Brasília", estado: "DF" });
  assert.equal(perfil.status, 200, JSON.stringify(perfil.data));
  assert.equal((await api("POST", "/api/session/atividade")).status, 200);
  assert.equal((await api("POST", "/api/transacoes/excluir", { id: lista.data.transactions[0].id })).status, 200);
  assert.equal((await api("POST", "/api/logout")).status, 200);
  assert.equal((await api("GET", "/api/transacoes")).status, 401);
});

test("cadastro novo grava bcrypt pelo banco, confirma email e entra", async () => {
  const api = client();
  const r = await api("POST", "/api/cadastro/etapa1", { nome: "Pessoa Nova", email: newEmail, senha: "OutraSenha@456", consentimento: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = (await db.query("SELECT senha FROM usuarios WHERE email=$1", [newEmail])).rows[0];
  assert.match(row.senha, /^\$2a\$12\$/);
  const link = logs.find((l) => l.includes("/confirmar-email?") && l.includes(newEmail));
  assert.ok(link, "link de confirmação no terminal");
  const token = new URL(link!.split("\n").find((x) => x.includes("http"))!.trim()).searchParams.get("token");
  const conf = await api("POST", "/api/email/confirmar", { token });
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  const outro = client();
  assert.equal((await outro("POST", "/api/login", { email: newEmail, senha: "OutraSenha@456" })).status, 200);
});

test("recuperação de senha de ponta a ponta", async () => {
  const api = client();
  const r = await api("POST", "/api/senha/recuperar", { email: legacyEmail });
  assert.equal(r.status, 200);
  const link = logs.find((l) => l.includes("/redefinir-senha?") && l.includes(legacyEmail));
  assert.ok(link);
  const token = new URL(link!.split("\n").find((x) => x.includes("http"))!.trim()).searchParams.get("token");
  const reset = await api("POST", "/api/senha/redefinir", { token, senha: "NovaSenha@789", confirmar_senha: "NovaSenha@789" });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await api("POST", "/api/senha/redefinir", { token, senha: "NovaSenha@789", confirmar_senha: "NovaSenha@789" })).status, 400);
  assert.equal((await api("POST", "/api/login", { email: legacyEmail, senha: "SenhaForte@123" })).status, 401);
  assert.equal((await api("POST", "/api/login", { email: legacyEmail, senha: "NovaSenha@789" })).status, 200);
});

test("segurança: origem de outro site, sem sessão e limite de tentativas", async () => {
  const api = client();
  const evil = await api("POST", "/api/login", { email: legacyEmail, senha: "x" }, { origin: "https://site-malicioso.com" });
  assert.equal(evil.status, 403);
  assert.equal((await api("GET", "/api/perfil")).status, 401);
  assert.equal((await api("GET", "/api/rota-que-nao-existe")).status, 404);
  const ip = { "cf-connecting-ip": "10.9.9.9" };
  let last = 0;
  for (let i = 0; i < 21; i++)
    last = (await api("POST", "/api/login", { email: legacyEmail, senha: "errada" }, ip)).status;
  assert.equal(last, 429);
});

test("OCR pelo Workers AI aceita a licença na primeira vez", async () => {
  const calls: any[] = [];
  let agreed = false;
  const ai = {
    run: async (_m: string, input: any) => {
      calls.push(input);
      if (input.prompt === "agree") return (agreed = true), { response: "ok" };
      if (!agreed) throw new Error("5016: Prior to using this model, you must submit the prompt 'agree'");
      return { response: "SUPERMERCADO BOM PRECO\n10/11/2026\nTOTAL R$ 45,90" };
    },
  };
  const text = await workersAiOcr(ai)!(new Uint8Array([1, 2, 3]));
  assert.match(text, /TOTAL/);
  assert.equal(calls.length, 3);
  const { extractReceipt } = await import("../src/integrations/receipt.js");
  assert.deepEqual(extractReceipt(text), { description: "SUPERMERCADO BOM PRECO", amount: "45.90", date: "2026-11-10", category: "alimentacao" });
});

test("verificação de email por DNS-over-HTTPS e login Google por WebCrypto", async () => {
  const realFetch = globalThis.fetch;
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as any;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.includes("dns-query")) {
      const name = new URL(u).searchParams.get("name");
      if (name === "dominio-que-nao-existe-xyz.com.br") return Response.json({ Status: 3 });
      return Response.json({ Status: 0, Answer: [{ type: 15, data: "10 mx.exemplo.com." }] });
    }
    if (u.includes("oauth2/v3/certs"))
      return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }, { headers: { "cache-control": "max-age=60" } });
    return realFetch(url);
  }) as any;
  try {
    assert.equal((await checkEmailDomain("a@empresa-real.com.br")).ok, true);
    assert.equal((await checkEmailDomain("a@dominio-que-nao-existe-xyz.com.br")).ok, false);
    assert.equal((await checkEmailDomain("a@mailinator.com")).ok, false);
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
    const googleEmail = `google${stamp}@gmail.com`;
    const body = b64({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "sub-" + stamp, email: googleEmail, email_verified: true, name: "Pessoa Google", exp: Math.floor(Date.now() / 1000) + 600 });
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
    const api = client();
    const primeiro = await api("POST", "/api/login/google", { credential: `${head}.${body}.${sig}` });
    assert.equal(primeiro.status, 409); // conta nova pede aceite dos termos
    const criado = await api("POST", "/api/login/google", { credential: `${head}.${body}.${sig}`, consentimento: true });
    assert.equal(criado.status, 200, JSON.stringify(criado.data));
    const adulterado = await api("POST", "/api/login/google", { credential: `${head}.${body}.${sig.slice(0, -4)}AAAA` });
    assert.equal(adulterado.status, 401);
    await db.query("DELETE FROM sessoes WHERE usuario_id IN (SELECT id FROM usuarios WHERE email=$1)", [googleEmail]);
    await db.query("DELETE FROM usuarios WHERE email=$1", [googleEmail]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("id do usuário em texto (bigint do Supabase) funciona nas consultas por usuário", async () => {
  const { userDatabase } = await import("../src/db.js");
  const id = (await db.query("SELECT id FROM usuarios WHERE email=$1", [newEmail])).rows[0].id;
  const r = await userDatabase(db, String(id)).query("SELECT current_setting('app.user_id') AS u");
  assert.equal(r.rows[0].u, String(id));
  assert.throws(() => userDatabase(db, "2; drop table x" as any));
});
