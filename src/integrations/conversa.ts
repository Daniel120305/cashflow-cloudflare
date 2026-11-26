// Conversa em texto livre com o bot: correções do comprovante ("troca para
// 2.100", "data hoje"), lançamentos em linguagem natural ("gastei 50 no
// mercado") e perguntas ("quanto gastei esse mês?").
// Primeiro regras (rápidas e previsíveis); o que elas não entendem pode ir
// para uma IA de texto do Workers AI, cujo resultado é sempre validado aqui.
import { brazilToday, classifyExpense } from "./receipt.js";

export const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export const EXPENSE_CATEGORIES = ["alimentacao", "transporte", "moradia", "saude", "educacao", "lazer", "outros-despesas"];
const CATEGORY_WORDS: [RegExp, string][] = [
  [/aliment|mercado|supermerc|comida|restaurante|lanche|padaria|ifood|almoco|jantar|\bcafe\b|acougue|feira/, "alimentacao"],
  [/transporte|uber|\b99\b|taxi|gasolina|combustivel|\bposto\b|onibus|metro|estacionamento|pedagio/, "transporte"],
  [/moradia|aluguel|condominio|\bluz\b|energia|\bagua\b|internet|\bgas\b|iptu/, "moradia"],
  [/saude|farmacia|drogaria|remedio|medic|consulta|hospital|dentista|plano de saude|exame/, "saude"],
  [/educa|curso|faculdade|escola|livro|mensalidade|material escolar/, "educacao"],
  [/lazer|cinema|show|viagem|\bbar\b|festa|\bjogo|streaming|netflix|spotify|passeio/, "lazer"],
  [/^outros?$|^outras?$|outros gastos|outras despesas/, "outros-despesas"],
];
const INCOME_WORDS: [RegExp, string][] = [
  [/salario|pagamento do trabalho|holerite/, "salario"],
  [/freela|freelance|bico|servico/, "freelance"],
  [/investimento|rendimento|dividendo|juros/, "investimentos"],
];

export function categoryFrom(text: string): string | undefined {
  const t = norm(text);
  for (const [re, slug] of CATEGORY_WORDS) if (re.test(t)) return slug;
  return undefined;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (today: string, days: number) => {
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};
// Datas só com "/" ou "-" (ponto é de valor: 2.100) e com dia/mês válidos.
const DATE_RE = /\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])(?:[/-](\d{4}|\d{2}))?(?![\d/-])/;

// "hoje", "ontem", "anteontem", "25/11", "25/11/2026", "dia 25". Nunca no futuro.
export function parseDate(text: string, today = brazilToday()): string | undefined {
  const t = norm(text);
  if (/\banteontem\b/.test(t)) return shift(today, -2);
  if (/\bontem\b/.test(t)) return shift(today, -1);
  if (/\bhoje\b/.test(t)) return today;
  const [ty, tm, td] = today.split("-").map(Number);
  let y: number, m: number, d: number;
  const full = t.match(DATE_RE);
  if (full) {
    d = Number(full[1]);
    m = Number(full[2]);
    y = full[3] ? Number(full[3].length === 2 ? "20" + full[3] : full[3]) : ty;
    // Sem ano e a data ficaria no futuro: é do ano passado.
    if (!full[3] && (m > tm || (m === tm && d > td))) y -= 1;
  } else {
    const dia = t.match(/\bdia (\d{1,2})\b/);
    if (!dia) return undefined;
    d = Number(dia[1]);
    m = tm;
    y = ty;
    if (d > td) (m -= 1), m === 0 && ((m = 12), (y -= 1));
  }
  const out = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!Number.isFinite(Date.parse(out)) || iso(new Date(out + "T12:00:00Z")) !== out || out > today) return undefined;
  return out;
}

// Valor em reais escrito como as pessoas escrevem: 2.100 / 2100 / 2.100,00 / 35,9 / R$ 8.
export function parseAmount(text: string): string | undefined {
  const clean = text
    .replace(new RegExp(DATE_RE.source, "g"), " ")
    .replace(/\bdia \d{1,2}\b/gi, " ")
    .replace(/\b\d{1,2}h(\d{2})?\b/gi, " ");
  const tokens = clean.match(/(?:r\$\s*)?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|(?:r\$\s*)?\d+(?:[.,]\d{1,2})?/gi);
  if (!tokens) return undefined;
  const raw = tokens.at(-1)!.replace(/r\$\s*/i, "");
  let n: number;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) n = Number(raw.replace(/\./g, "").replace(",", "."));
  else n = Number(raw.replace(",", "."));
  if (!(n > 0) || n > 9_999_999_999.99) return undefined;
  return n.toFixed(2);
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export type Correction = {
  confirmar?: true;
  cancelar?: true;
  valor?: string;
  data?: string;
  categoria?: string;
  descricao?: string;
};

// Correção do comprovante pendente. Devolve null se a mensagem não parece correção.
export function parseCorrection(text: string, today = brazilToday()): Correction | null {
  const t = norm(text);
  if (/^(sim|s|ok|okay|pode|confirm|registr|isso|certo|beleza|blz|correto|perfeito|manda ver|fechou|👍|✅)\b/.test(t) && !/\d/.test(t))
    return { confirmar: true };
  if (/^(nao|n|cancel|descart|apaga|esquece|deixa (pra|para) la|errado tudo)\b/.test(t) && !/\d/.test(t)) return { cancelar: true };
  const out: Correction = {};
  let rest = text;
  const desc = text.match(/(?:nome|descri[cç][aã]o|loja|estabelecimento|local)\s*(?:é|e|eh|:|=|para|pra)?\s+(.{2,120})$/i);
  if (desc) {
    out.descricao = cap(desc[1].trim().replace(/[.!]+$/, ""));
    rest = text.slice(0, desc.index);
  }
  const cat = norm(rest).match(/(?:categoria|cat)\s*(?:e|eh|:|=|para|pra)?\s+(.+)$/);
  if (cat) {
    const slug = categoryFrom(cat[1]);
    if (slug) out.categoria = slug;
  } else if (!out.descricao) {
    // "é lazer", "lazer", "foi transporte"
    const only = norm(rest).replace(/^(e|eh|foi|era|na verdade|troca pra|troca para|muda pra|muda para)\s+/, "");
    if (only.split(" ").length <= 3 && !/\d/.test(only)) {
      const slug = categoryFrom(only);
      if (slug) out.categoria = slug;
    }
  }
  const data = parseDate(rest, today);
  if (data) out.data = data;
  const valueHint = /(valor|troca|muda|mude|corrig|era|foi|total|r\$|reais|\bpara\b|\bpra\b|\bé\b|\be\b)/i.test(rest);
  const bareNumber = /^\s*(?:r\$\s*)?[\d.,]+\s*(?:reais)?\s*$/i.test(rest);
  if (valueHint || bareNumber) {
    const v = parseAmount(rest);
    if (v) out.valor = v;
  }
  return Object.keys(out).length ? out : null;
}

export type Natural = { type: "expense" | "income"; amount: string; description: string; category: string; date: string };

// "gastei 50 no mercado", "paguei 120 de luz ontem", "recebi 3000 de salário".
export function parseNatural(text: string, today = brazilToday()): Natural | null {
  const t = norm(text);
  const expense = t.match(/^(?:hoje |ontem |anteontem )?(gastei|paguei|comprei|torrei|gasto|gastamos|pagamos|compramos|saiu|deu)\b/);
  const income = t.match(/^(?:hoje |ontem |anteontem )?(recebi|ganhei|entrou|caiu|recebemos|ganhamos)\b/);
  if (!expense && !income) return null;
  const amount = parseAmount(text);
  if (!amount) return null;
  const date = parseDate(text, today) ?? today;
  // Trabalha no texto original (minúsculo, com acentos) para a descrição sair certa.
  const description = cap(
    text
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .replace(new RegExp(DATE_RE.source, "g"), " ")
      .replace(/\b(hoje|ontem|anteontem|dia \d{1,2})\b/g, " ")
      .replace(/^(gastei|paguei|comprei|torrei|gasto|gastamos|pagamos|compramos|saiu|deu|recebi|ganhei|entrou|caiu|recebemos|ganhamos)\b/, " ")
      .replace(/(?:r\$\s*)?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|(?:r\$\s*)?\d+(?:[.,]\d{1,2})?/g, " ")
      .replace(/\b(reais|real|conto|contos|pila|r\$)\b/g, " ")
      .replace(/^\s*(?:(?:no|na|nos|nas|em|de|do|da|dos|das|com|pro|pra|para|pelo|pela|o|a|um|uma)\s+)+/g, "")
      .replace(/\s+(?:no|na|em|de|do|da|com|pro|pra|para)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (income) {
    const cat = INCOME_WORDS.find(([re]) => re.test(t))?.[1] ?? "outros-receitas";
    return { type: "income", amount, description: description || "Receita", category: cat, date };
  }
  const category = categoryFrom(description) ?? classifyExpense(description);
  return { type: "expense", amount, description: description || "Despesa", category, date };
}

// Pergunta em texto livre -> comando do bot.
export function intentOf(text: string): string | undefined {
  const t = norm(text).replace(/[?!.]+$/, "");
  if (/^(oi|ola|opa|eai|e ai|hey|bom dia|boa tarde|boa noite|menu|ajuda|help|comandos|o que voce faz|como funciona)\b/.test(t)) return "ajuda";
  if (/desfaz|apaga(r)? o ultimo|apagar ultimo|cancela(r)? o ultimo/.test(t)) return "desfazer";
  if (/limite|quanto (ainda )?(posso|consigo) gastar|gasto maximo|quanto falta/.test(t)) return "limite";
  if (/categoria|onde (mais )?gastei|com o que (mais )?gastei|em que (mais )?gastei/.test(t)) return "categorias";
  if (/(gastei|gastos?|lancamentos?|despesas?).*\bhoje\b|\bhoje\b.*(gastei|gastos?)/.test(t)) return "hoje";
  if (/extrato|ultim[oa]s? (gastos|lancamentos|transacoes|despesas)/.test(t)) return "extrato";
  if (/quanto gastei|resumo|(esse|este|no|do) mes|mes passado|comparar/.test(t)) return "mes";
  if (/saldo|quanto (eu )?tenho|quanto sobrou|quanto sobra|meu dinheiro/.test(t)) return "saldo";
  if (/\bdica|conselho|como economizar|economizar/.test(t)) return "dica";
  if (/\bsite\b|abrir o cashflow/.test(t)) return "site";
  return undefined;
}

// ---------- IA de texto (reserva) ----------
type Ai = { run: (model: string, input: any) => Promise<any> };
const TEXT_MODELS = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.1-8b-instruct"];
const COMANDOS = ["saldo", "mes", "hoje", "extrato", "categorias", "limite", "dica", "ajuda", "desfazer"];
export type AiReading =
  | { acao: "lancamento"; lancamento: Natural }
  | { acao: "correcao"; correcao: Correction }
  | { acao: "comando"; comando: string }
  | { acao: "outro"; resposta?: string };

export function aiTextInterpreter(ai: Ai | undefined) {
  if (!ai) return undefined;
  return async (text: string, pending: null | { descricao: string; valor: string; data: string; categoria: string }, today = brazilToday()): Promise<AiReading | null> => {
    const system =
      `Você interpreta mensagens em português para o CashFlow, um app de finanças pessoais. Hoje é ${today}. ` +
      "Responda SOMENTE com um JSON, sem texto fora dele, num destes formatos:\n" +
      '{"acao":"lancamento","tipo":"despesa"|"receita","valor":"123.45","descricao":"curta","categoria":"alimentacao|transporte|moradia|saude|educacao|lazer|outros-despesas|salario|freelance|investimentos|outros-receitas","data":"AAAA-MM-DD"}\n' +
      (pending
        ? `{"acao":"correcao","valor":"123.45"?,"data":"AAAA-MM-DD"?,"categoria":"..."?,"descricao":"..."?,"confirmar":true?,"cancelar":true?}  (há um comprovante esperando confirmação: ${JSON.stringify(pending)})\n`
        : "") +
      `{"acao":"comando","comando":"${COMANDOS.join("|")}"}\n` +
      '{"acao":"outro","resposta":"frase curta e simpática em português"}';
    let raw = "";
    for (const model of TEXT_MODELS) {
      try {
        const r = await ai.run(model, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: text.slice(0, 500) },
          ],
          max_tokens: 200,
          temperature: 0,
        });
        raw = typeof r === "string" ? r : (r?.response ?? "");
        if (raw) break;
      } catch {
        // tenta o próximo modelo
      }
    }
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    let d: any;
    try {
      d = JSON.parse(json);
    } catch {
      return null;
    }
    // Tudo o que vem da IA é conferido antes de usar.
    const valor = d.valor != null ? parseAmount(String(d.valor).replace(".", ",")) ?? parseAmount(String(d.valor)) : undefined;
    const data = typeof d.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.data) && d.data <= today ? d.data : undefined;
    if (d.acao === "lancamento" && valor) {
      const type = d.tipo === "receita" ? "income" : "expense";
      const valid = type === "income" ? ["salario", "freelance", "investimentos", "outros-receitas"] : EXPENSE_CATEGORIES;
      const description = cap(String(d.descricao ?? "").trim().slice(0, 120)) || (type === "income" ? "Receita" : "Despesa");
      const category = valid.includes(d.categoria) ? d.categoria : type === "income" ? "outros-receitas" : categoryFrom(description) ?? classifyExpense(description);
      return { acao: "lancamento", lancamento: { type, amount: valor, description, category, date: data ?? today } };
    }
    if (d.acao === "correcao" && pending) {
      const c: Correction = {};
      if (d.confirmar === true) c.confirmar = true;
      if (d.cancelar === true) c.cancelar = true;
      if (valor) c.valor = valor;
      if (data) c.data = data;
      if (EXPENSE_CATEGORIES.includes(d.categoria)) c.categoria = d.categoria;
      if (typeof d.descricao === "string" && d.descricao.trim()) c.descricao = cap(d.descricao.trim().slice(0, 120));
      return Object.keys(c).length ? { acao: "correcao", correcao: c } : null;
    }
    if (d.acao === "comando" && COMANDOS.includes(d.comando)) return { acao: "comando", comando: d.comando };
    if (d.acao === "outro") return { acao: "outro", resposta: typeof d.resposta === "string" ? d.resposta.slice(0, 300) : undefined };
    return null;
  };
}
