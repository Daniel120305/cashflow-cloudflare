// Leitura de planilhas e extratos (regras, sem IA).
import { test } from "node:test";
import assert from "node:assert/strict";
import { signedMoney, sheetDate, rowsFromDocument, docKind } from "../src/integrations/documents.js";

const HOJE = "2026-11-26";
test("valores com sinal em vários formatos", () => {
  assert.equal(signedMoney("R$ -1.234,56"), -1234.56);
  assert.equal(signedMoney("1.234,56 D"), -1234.56);
  assert.equal(signedMoney("(123,45)"), -123.45);
  assert.equal(signedMoney("-45.90"), -45.9);
  assert.equal(signedMoney("1,234.56"), 1234.56);
  assert.equal(signedMoney("3000"), 3000);
  assert.equal(signedMoney("Mercado"), undefined);
  assert.equal(signedMoney("25/11/2026"), undefined);
});
test("datas de planilha, inclusive número de série do Excel", () => {
  assert.equal(sheetDate("25/11/2026"), "2026-11-25");
  assert.equal(sheetDate("25/11/26"), "2026-11-25");
  assert.equal(sheetDate("2026-11-25"), "2026-11-25");
  assert.equal(sheetDate("46351"), "2026-11-25");
  assert.equal(sheetDate("31/02/2026"), undefined);
});
test("extrato CSV do banco (valores negativos = despesas)", () => {
  const csv = "Data,Valor,Identificador,Descrição\n01/11/2026,-45.90,abc1,Supermercado Bom Preço\n03/11/2026,3000.00,abc2,Salário Empresa X\n05/11/2026,-32.50,abc3,Uber *Trip\n";
  const rows = rowsFromDocument(csv, HOJE);
  assert.deepEqual(rows, [
    { date: "2026-11-01", description: "Supermercado Bom Preço", amount: "45.90", type: "expense", category: "alimentacao" },
    { date: "2026-11-03", description: "Salário Empresa X", amount: "3000.00", type: "income", category: "salario" },
    { date: "2026-11-05", description: "Uber *Trip", amount: "32.50", type: "expense", category: "transporte" },
  ]);
});
test("planilha do Excel em Markdown, com débito/crédito e linhas de saldo", () => {
  const md = [
    "## Extrato novembro",
    "",
    "| Data | Histórico | Débito | Crédito | Saldo |",
    "|---|---|---|---|---|",
    "| 31/10/2026 | SALDO ANTERIOR | | | 1.000,00 |",
    "| 02/11/2026 | PIX Farmácia São João | 89,90 | | 910,10 |",
    "| 04/11/2026 | TED recebida | | 500,00 | 1.410,10 |",
    "| 10/11/2026 | Conta de luz | 210,35 | | 1.199,75 |",
  ].join("\n");
  const rows = rowsFromDocument(md, HOJE);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.description, r.amount, r.type, r.category]), [
    ["PIX Farmácia São João", "89.90", "expense", "saude"],
    ["TED recebida", "500.00", "income", "outros-receitas"],
    ["Conta de luz", "210.35", "expense", "moradia"],
  ]);
});
test("planilha simples de gastos (só valores positivos) e datas em série do Excel", () => {
  const md = "| Data | Descrição | Valor |\n|---|---|---|\n| 46350 | Cinema | 60 |\n| 46351 | Padaria | 12,50 |";
  const rows = rowsFromDocument(md, HOJE);
  assert.deepEqual(rows.map((r) => [r.date, r.description, r.type, r.category]), [
    ["2026-11-24", "Cinema", "expense", "lazer"],
    ["2026-11-25", "Padaria", "expense", "alimentacao"],
  ]);
});
test("tipos de arquivo", () => {
  assert.equal(docKind("nota.pdf", "application/pdf"), "document");
  assert.equal(docKind("extrato.xlsx"), "document");
  assert.equal(docKind("gastos.csv", "text/csv"), "document");
  assert.equal(docKind("cupom.JPG"), "image");
  assert.equal(docKind("musica.mp3", "audio/mpeg"), "unsupported");
  assert.equal(docKind("x.zip", "application/zip"), "unsupported");
});
