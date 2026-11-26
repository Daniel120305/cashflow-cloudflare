// Endereços curtos e leitura de comprovante (funções puras).
import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectFor, assetFor, absolutize } from "../src/pages.js";
import { readReceipt } from "../src/integrations/ocr.js";

test("endereços antigos redirecionam para os curtos, mantendo ?query", () => {
  const u = (p: string) => new URL("https://app.cashflow-pi.workers.dev" + p);
  assert.equal(redirectFor(u("/CashFlow_Tela_HomePage/home.html?bemvindo=1")), "https://app.cashflow-pi.workers.dev/home?bemvindo=1");
  assert.equal(redirectFor(u("/redefinir-senha.html?token=abc")), "https://app.cashflow-pi.workers.dev/redefinir-senha?token=abc");
  assert.equal(redirectFor(u("/")), "https://app.cashflow-pi.workers.dev/login");
  assert.equal(redirectFor(u("/home")), undefined);
  assert.equal(assetFor("/perfil"), "/CashFlow_Tela_Perfil/perfil.html");
  assert.equal(assetFor("/perfil/"), "/CashFlow_Tela_Perfil/perfil.html");
  assert.equal(assetFor("/homeStyle.css"), undefined);
});

test("links relativos da página viram caminhos absolutos da pasta dela", () => {
  const f = "/CashFlow_Tela_HomePage/home.html";
  assert.equal(absolutize("homeStyle.css", f), "/CashFlow_Tela_HomePage/homeStyle.css");
  assert.equal(absolutize("../image.png", f), "/image.png");
  assert.equal(absolutize("../CashFlow_Tela_Perfil/perfil.html#gasto-maximo", f), "/perfil#gasto-maximo");
  assert.equal(absolutize("/money-mask.js", f), "/money-mask.js");
  assert.equal(absolutize("#telegram", f), "#telegram");
  assert.equal(absolutize("https://fonts.googleapis.com/x", f), "https://fonts.googleapis.com/x");
  assert.equal(absolutize("mailto:a@b.com", f), "mailto:a@b.com");
});

test("leitura do comprovante: JSON do modelo, data inválida/futura e texto puro", () => {
  assert.deepEqual(readReceipt('Aqui: {"estabelecimento":"Drogaria Rosário","data":"03/11/2026","total":"42,10"}', "2026-11-25"),
    { description: "Drogaria Rosário", amount: "42.10", date: "2026-11-03", category: "saude" });
  assert.equal(readReceipt('{"estabelecimento":"Posto Shell","data":"30/12/2026","total":"200,00"}', "2026-11-25")?.date, "2026-11-25");
  assert.equal(readReceipt('{"estabelecimento":"Loja","data":null,"total":"1.234,56"}', "2026-11-25")?.amount, "1234.56");
  assert.equal(readReceipt('{"erro":"nao_e_comprovante"}'), null);
  assert.equal(readReceipt("SUPERMERCADO BOM PRECO\n10/11/2026\nTOTAL R$ 45,90")?.amount, "45.90");
});

test("áudio: se o Whisper turbo falha, usa o outro modelo", async () => {
  const { workersAiTranscriber } = await import("../src/integrations/audio.js");
  const calls: string[] = [];
  const ai = { run: async (model: string) => { calls.push(model); if (model.includes("turbo")) throw new Error("3010: formato"); return { text: " gastei 10 no uber " }; } };
  assert.equal(await workersAiTranscriber(ai)!(new Uint8Array([1, 2, 3])), "gastei 10 no uber");
  assert.deepEqual(calls, ["@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"]);
  await assert.rejects(workersAiTranscriber({ run: async () => { throw new Error("x"); } })!(new Uint8Array([1])), /whisper-turbo: x \| whisper: x/);
});
