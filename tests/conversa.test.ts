// Conversa em texto livre: correções, lançamentos naturais e perguntas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCorrection, parseNatural, intentOf, parseAmount, parseDate, aiTextInterpreter } from "../src/integrations/conversa.js";

const HOJE = "2026-11-26";
test("valores escritos de vários jeitos", () => {
  assert.equal(parseAmount("Só troca para 2.100"), "2100.00");
  assert.equal(parseAmount("2.100,00"), "2100.00");
  assert.equal(parseAmount("R$ 35,9"), "35.90");
  assert.equal(parseAmount("8.50"), "8.50");
  assert.equal(parseAmount("foi 1.234.567,89"), "1234567.89");
  assert.equal(parseAmount("data 25/11"), undefined);
});
test("datas relativas e escritas, nunca no futuro", () => {
  assert.equal(parseDate("data hoje", HOJE), "2026-11-26");
  assert.equal(parseDate("foi ontem", HOJE), "2026-11-25");
  assert.equal(parseDate("25/11", HOJE), "2026-11-25");
  assert.equal(parseDate("dia 20", HOJE), "2026-11-20");
  assert.equal(parseDate("dia 28", HOJE), "2026-10-28");
  assert.equal(parseDate("30/12", HOJE), "2025-12-30");
  assert.equal(parseDate("troca para 2.100", HOJE), undefined);
});
test("correções do comprovante", () => {
  assert.deepEqual(parseCorrection("Só troca para 2.100", HOJE), { valor: "2100.00" });
  assert.deepEqual(parseCorrection("valor 2100 e data hoje", HOJE), { valor: "2100.00", data: HOJE });
  assert.deepEqual(parseCorrection("2.100,00", HOJE), { valor: "2100.00" });
  assert.deepEqual(parseCorrection("categoria lazer", HOJE), { categoria: "lazer" });
  assert.deepEqual(parseCorrection("é lazer", HOJE), { categoria: "lazer" });
  assert.deepEqual(parseCorrection("nome Shopping Som", HOJE), { descricao: "Shopping Som" });
  assert.deepEqual(parseCorrection("foi dia 20", HOJE), { data: "2026-11-20" });
  assert.deepEqual(parseCorrection("sim", HOJE), { confirmar: true });
  assert.deepEqual(parseCorrection("pode registrar", HOJE), { confirmar: true });
  assert.deepEqual(parseCorrection("não, cancela", HOJE), { cancelar: true });
  assert.equal(parseCorrection("quanto gastei esse mês?", HOJE), null);
});
test("lançamentos em linguagem natural", () => {
  assert.deepEqual(parseNatural("gastei 50 no mercado", HOJE), { type: "expense", amount: "50.00", description: "Mercado", category: "alimentacao", date: HOJE });
  assert.deepEqual(parseNatural("paguei 120 de luz ontem", HOJE), { type: "expense", amount: "120.00", description: "Luz", category: "moradia", date: "2026-11-25" });
  assert.deepEqual(parseNatural("comprei pão 8,50", HOJE), { type: "expense", amount: "8.50", description: "Pão", category: "outros-despesas", date: HOJE });
  assert.deepEqual(parseNatural("recebi 3.000 de salário", HOJE), { type: "income", amount: "3000.00", description: "Salário", category: "salario", date: HOJE });
  assert.equal(parseNatural("gastei muito", HOJE), null);
  assert.equal(parseNatural("bom dia", HOJE), null);
});
test("perguntas viram comandos", () => {
  assert.equal(intentOf("quanto gastei esse mês?"), "mes");
  assert.equal(intentOf("Quanto ainda posso gastar?"), "limite");
  assert.equal(intentOf("onde mais gastei"), "categorias");
  assert.equal(intentOf("quanto gastei hoje"), "hoje");
  assert.equal(intentOf("qual meu saldo"), "saldo");
  assert.equal(intentOf("oi"), "ajuda");
  assert.equal(intentOf("me dá uma dica"), "dica");
  assert.equal(intentOf("abacate"), undefined);
});
test("IA de texto: só usa o que passa na validação", async () => {
  const ai = (resp: string) => ({ run: async () => ({ response: resp }) });
  const ler = (r: string, pend: any = null) => aiTextInterpreter(ai(r))!("x", pend, HOJE);
  assert.deepEqual(await ler('{"acao":"lancamento","tipo":"despesa","valor":"45.9","descricao":"farmácia","categoria":"saude","data":"2026-11-26"}'),
    { acao: "lancamento", lancamento: { type: "expense", amount: "45.90", description: "Farmácia", category: "saude", date: HOJE } });
  // Categoria inventada e data no futuro são trocadas por valores seguros.
  const l = await ler('{"acao":"lancamento","tipo":"despesa","valor":"10","descricao":"uber","categoria":"inventada","data":"2030-01-01"}');
  assert.equal((l as any).lancamento.category, "transporte");
  assert.equal((l as any).lancamento.date, HOJE);
  assert.equal(await ler('{"acao":"lancamento","valor":"abc"}'), null);
  assert.deepEqual(await ler('{"acao":"comando","comando":"saldo"}'), { acao: "comando", comando: "saldo" });
  assert.equal(await ler('{"acao":"comando","comando":"apagar_tudo"}'), null);
  assert.deepEqual(await ler('{"acao":"correcao","valor":"2100"}', { descricao: "x", valor: "1", data: HOJE, categoria: "lazer" }), { acao: "correcao", correcao: { valor: "2100.00" } });
  assert.equal(await ler("não sei"), null);
});

test("números falados (áudio) viram algarismos", async () => {
  const { wordsToNumbers } = await import("../src/integrations/conversa.js");
  assert.equal(wordsToNumbers("gastei cinquenta reais no mercado"), "gastei 50 reais no mercado");
  assert.equal(wordsToNumbers("paguei mil e duzentos de aluguel"), "paguei 1200 de aluguel");
  assert.equal(wordsToNumbers("gastei trinta e cinco e noventa na farmácia"), "gastei 35,90 na farmácia");
  assert.equal(wordsToNumbers("recebi dois mil e cem reais e cinquenta centavos"), "recebi 2100,50");
  assert.equal(wordsToNumbers("comprei um café de oito reais"), "comprei um café de 8 reais");
  assert.equal(wordsToNumbers("troca para dois mil e cem"), "troca para 2100");
});

test("apagar por descrição", async () => {
  const { parseDelete } = await import("../src/integrations/conversa.js");
  assert.equal(parseDelete("apaga a despesa do mercado"), "mercado");
  assert.equal(parseDelete("Remover o uber de ontem."), "uber");
  assert.equal(parseDelete("exclui a receita de salário"), "salario");
  assert.equal(parseDelete("apaga o último"), undefined);
  assert.equal(parseDelete("gastei 50 no mercado"), undefined);
});
