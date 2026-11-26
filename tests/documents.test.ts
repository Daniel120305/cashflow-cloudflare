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

test("orçamento mensal em grade (planilha real): meses, total, seções e anexo", { skip: !(await import("node:fs")).existsSync(new URL("./orcamento.md", import.meta.url)) && "tests/orcamento.md é local (dados reais, fora do git)" }, async () => {
  const { readFileSync } = await import("node:fs");
  const { findMatrix, rowsFromMatrix, matrixChoice } = await import("../src/integrations/documents.js");
  const m = findMatrix(readFileSync(new URL("./orcamento.md", import.meta.url), "utf8"))!;
  assert.equal(m.months.length, 12);
  assert.notEqual(m.totalCol, null); // coluna de total sem título, achada pelos valores
  const total = rowsFromMatrix(m, "total", HOJE);
  const soma = (t: string) => Math.round(total.filter((r) => r.type === t).reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;
  // Renda bate com a "Renda Total" declarada na planilha; o anexo "Renda Bruta" fica de fora.
  assert.equal(soma("income"), 248720.01);
  assert.ok(!total.some((r) => /Daniel|Honorários|IRRF/.test(r.description)));
  // Nada de vencimento como valor, nem linhas de TOTAL/saldo.
  assert.ok(!total.some((r) => /^(total|renda total|despesas totais|resultado|saldo)/i.test(r.description)));
  const pj = total.find((r) => r.description === "Salário PJ - dia 10")!;
  assert.deepEqual([pj.type, pj.category, pj.amount], ["income", "salario", "93321.60"]);
  const aluguel = total.find((r) => r.description === "Aluguel/Financiamento")!;
  assert.deepEqual([aluguel.type, aluguel.category, aluguel.amount], ["expense", "moradia", "25000.00"]);
  assert.equal(total.find((r) => r.description === "Aluguel de Carro")!.category, "lazer"); // seção Férias/Viagens
  // Linha sem valor na coluna de total ("Claude"): soma dos meses.
  assert.equal(total.find((r) => r.description === "Claude")!.amount, "1320.00");
  // Mês: data usa o vencimento.
  const nov = rowsFromMatrix(m, 11, HOJE);
  assert.deepEqual(nov.find((r) => r.description === "Salário PJ - dia 10"), { date: "2026-11-10", description: "Salário PJ - dia 10", amount: "7790.00", type: "income", category: "salario" });
  assert.equal(matrixChoice("pega só a última coluna", m, HOJE), "total");
  assert.equal(matrixChoice("quero novembro", m, HOJE), 11);
  assert.equal(matrixChoice("abacaxi", m, HOJE), undefined);
});

test("lista comum: coluna de dia/vencimento nunca vira valor", async () => {
  const md = "| Conta | Vencimento | Valor |\n|---|---|---|\n| Luz | 10 | 210,35 |\n| Água | 5 | 80,00 |\n| Internet | 15 | 139,90 |";
  const rows = rowsFromDocument(md, HOJE);
  assert.deepEqual(rows.map((r) => [r.description, r.amount]), [["Luz", "210.35"], ["Água", "80.00"], ["Internet", "139.90"]]);
});
