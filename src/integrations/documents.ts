// Leitura de arquivos enviados ao bot (PDF, Excel, CSV, Word, OpenDocument...).
// 1. O Workers AI converte o arquivo em texto/Markdown (env.AI.toMarkdown).
// 2. Planilhas e extratos: as tabelas são lidas por regras (datas, valores,
//    descrição) — previsível e sem custo de IA.
// 3. Sem tabela reconhecível (ex.: nota fiscal em PDF): uma IA de texto extrai
//    o comprovante ou a lista de lançamentos; tudo é validado antes de usar.
import { brazilToday, classifyExpense } from "./receipt.js";
import { categoryFrom, norm } from "./conversa.js";

export type Row = { date: string; description: string; amount: string; type: "income" | "expense"; category: string };

// Extensões que o conversor da Cloudflare entende (imagens vão para a leitura de foto).
export const DOC_EXTENSIONS = ["pdf", "xlsx", "xlsm", "xlsb", "xls", "et", "ods", "csv", "docx", "odt", "numbers", "html", "htm", "xml", "txt"];
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];
export const extOf = (name = "") => (name.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1] ?? "");
export function docKind(name: string, mime = ""): "image" | "document" | "unsupported" {
  const ext = extOf(name);
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (DOC_EXTENSIONS.includes(ext) || /pdf|spreadsheet|excel|csv|wordprocessing|opendocument|numbers/.test(mime)) return "document";
  return "unsupported";
}

// ---------- Valores e datas de planilhas/extratos ----------
// "R$ -1.234,56", "-1234.56", "1.234,56 D", "(123,45)", "1,234.56" -> número com sinal.
export function signedMoney(raw: string): number | undefined {
  let s = String(raw ?? "").trim();
  // Só dígitos, separadores, sinal, R$ e a marca D/C no fim; texto comum não é valor.
  if (!s || !/\d/.test(s) || /[a-z]{2,}/i.test(s.replace(/r\$|brl|reais|\b(d|c|db|cr|deb)\s*$/gi, ""))) return undefined;
  let neg = /^\(.*\)$/.test(s) || /^-|-\s*$|\s-\s*\d/.test(s.replace(/r\$/i, "").trim()) || /\b(d|db|deb)\s*$/i.test(s);
  s = s.replace(/r\$|brl|reais|[()\s]|\b(d|c|db|cr|deb)\s*$/gi, "").replace(/^[-+]|[-+]$/g, "");
  if (/^-/.test(s)) (neg = true), (s = s.slice(1));
  let n: number;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) n = Number(s.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) n = Number(s.replace(/,/g, ""));
  else if (/^\d+,\d{1,2}$/.test(s)) n = Number(s.replace(",", "."));
  else if (/^\d+(\.\d{1,2})?$/.test(s)) n = Number(s);
  else return undefined;
  if (!Number.isFinite(n) || n === 0) return undefined;
  return neg ? -n : n;
}

// 25/11/2026, 25/11/26, 2026-11-25, 25-11-2026, 25.11.2026 e número de série do Excel (45986).
export function sheetDate(raw: string): string | undefined {
  const s = String(raw ?? "").trim();
  let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/))) {
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (y < 100) y += 2000;
  } else if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 60000) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return dt.toISOString().slice(0, 10);
  } else return undefined;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : undefined;
}

// Tabelas em Markdown: | a | b | c |
function markdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  let cur: string[][] = [];
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // linha separadora |---|
      cur.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    } else if (cur.length) (tables.push(cur), (cur = []));
  }
  if (cur.length) tables.push(cur);
  return tables;
}
// CSV simples (vírgula ou ponto e vírgula), caso venha como texto.
function csvTable(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")));
}

const pct = (col: string[], test: (v: string) => boolean) => (col.length ? col.filter(test).length / col.length : 0);

// Acha colunas de data, valor (ou débito/crédito) e descrição e monta os lançamentos.
export function rowsFromTable(table: string[][], today = brazilToday()): Row[] {
  if (table.length < 2) return [];
  // O cabeçalho pode não ser a primeira linha (títulos acima da tabela).
  let start = 0;
  for (let i = 0; i < Math.min(table.length - 1, 6); i++) {
    if (table[i].some((c) => /data|date|descri|hist|valor|value|amount|lan[cç]/i.test(c))) {
      start = i;
      break;
    }
  }
  const header = table[start].map((h) => norm(h));
  const body = table.slice(start + 1).filter((r) => r.some((c) => c));
  if (!body.length) return [];
  const cols = header.length;
  const column = (i: number) => body.map((r) => r[i] ?? "").filter((v) => v !== "");
  let dateCol = -1, amountCol = -1, debitCol = -1, creditCol = -1, descCol = -1, typeCol = -1;
  for (let i = 0; i < cols; i++) {
    const vals = column(i);
    if (dateCol < 0 && pct(vals, (v) => !!sheetDate(v)) >= 0.6) dateCol = i;
  }
  for (let i = 0; i < cols; i++) {
    const h = header[i], vals = column(i);
    if (i === dateCol) continue;
    const isMoney = pct(vals, (v) => signedMoney(v) !== undefined) >= 0.6;
    // Dia, vencimento, quantidade, parcela ou código não são valores.
    if (/venc|^dia$|\bdia\b|qtd|quant|parcela|^n[oº°]?$|^id$|cod|numero|ordem|item/.test(h)) continue;
    if (isMoney && vals.length >= 3 && vals.every((v) => /^\s*([12]?\d|3[01])\s*$/.test(v))) continue;
    if (/debito|saida|despesa|pagamento|gasto/.test(h) && isMoney) debitCol = i;
    else if (/credito|entrada|receita|deposito/.test(h) && isMoney) creditCol = i;
    else if (/saldo/.test(h)) continue;
    else if (amountCol < 0 && isMoney && (/valor|value|amount|montante|total|quantia|r\$/.test(h) || !h)) amountCol = i;
    else if (/^(tipo|natureza|d\/c|dc|operacao)$/.test(h)) typeCol = i;
  }
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    // Sem cabeçalho de valor: primeira coluna numérica que não é data nem saldo.
    for (let i = 0; i < cols; i++)
      if (i !== dateCol && !/saldo/.test(header[i]) && pct(column(i), (v) => signedMoney(v) !== undefined) >= 0.6) {
        amountCol = i;
        break;
      }
  }
  // Descrição: cabeçalho típico, senão a coluna de texto mais variada.
  descCol = header.findIndex((h, i) => i !== dateCol && /descri|hist|estabelec|lancamento|nome|memo|detalhe|favorecido|title|description|item/.test(h));
  if (descCol < 0) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < cols; i++) {
      if ([dateCol, amountCol, debitCol, creditCol, typeCol].includes(i)) continue;
      const vals = column(i).filter((v) => /\p{L}/u.test(v));
      const score = new Set(vals).size;
      if (score > bestScore) (best = i), (bestScore = score);
    }
    descCol = best;
  }
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) return [];
  const rows: Row[] = [];
  for (const r of body) {
    const desc = (descCol >= 0 ? r[descCol] : "") || "";
    if (/^saldo\b|saldo (anterior|do dia|final|disponivel)|^total\b/i.test(norm(desc))) continue;
    let value: number | undefined;
    if (debitCol >= 0 && signedMoney(r[debitCol] ?? "") !== undefined) value = -Math.abs(signedMoney(r[debitCol])!);
    else if (creditCol >= 0 && signedMoney(r[creditCol] ?? "") !== undefined) value = Math.abs(signedMoney(r[creditCol])!);
    else if (amountCol >= 0) value = signedMoney(r[amountCol] ?? "");
    if (value === undefined) continue;
    let type: "income" | "expense" = value < 0 ? "expense" : "income";
    if (typeCol >= 0) {
      const t = norm(r[typeCol] ?? "");
      if (/^(d|debito|saida|despesa|gasto)/.test(t)) type = "expense";
      else if (/^(c|credito|entrada|receita)/.test(t)) type = "income";
    } else if (amountCol >= 0 && debitCol < 0 && creditCol < 0 && !body.some((x) => (signedMoney(x[amountCol] ?? "") ?? 0) < 0)) {
      // Planilha só com valores positivos e sem coluna de tipo: são gastos.
      type = "expense";
    }
    const date = (dateCol >= 0 ? sheetDate(r[dateCol] ?? "") : undefined) ?? today;
    const description = (desc.replace(/\s+/g, " ").trim().slice(0, 120)) || (type === "income" ? "Receita" : "Despesa");
    const amount = Math.abs(value).toFixed(2);
    if (Number(amount) > 9_999_999_999.99) continue;
    const category =
      type === "income"
        ? /salario|salário|pagamento|folha/i.test(description) ? "salario" : /pix recebido|transferencia recebida|ted recebida/i.test(description) ? "outros-receitas" : "outros-receitas"
        : categoryFrom(description) ?? classifyExpense(description);
    rows.push({ date, description, amount, type, category });
  }
  return rows;
}

export function rowsFromDocument(md: string, today = brazilToday()): Row[] {
  let best: Row[] = [];
  for (const t of markdownTables(md)) {
    const rows = rowsFromTable(t, today);
    if (rows.length > best.length) best = rows;
  }
  if (!best.length) {
    const rows = rowsFromTable(csvTable(md), today);
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// ---------- IA de texto para documentos sem tabela ----------
type Ai = { run: (model: string, input: any) => Promise<any> };
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];
export type DocReading =
  | { tipo: "comprovante"; descricao: string; data?: string; valor: string; receita: boolean }
  | { tipo: "lista"; linhas: Row[] }
  | { tipo: "nada" };

export function aiDocumentReader(ai: Ai | undefined) {
  if (!ai) return undefined;
  return async (text: string, today = brazilToday()): Promise<DocReading> => {
    const system =
      `Você extrai dados financeiros de documentos brasileiros (nota fiscal, cupom, boleto, comprovante de pagamento ou PIX, fatura, extrato). Hoje é ${today}. ` +
      "Responda SOMENTE com JSON, num destes formatos:\n" +
      '{"tipo":"comprovante","estabelecimento":"quem recebeu/loja","data":"AAAA-MM-DD"|null,"total":"123,45","receita":false}  (um único pagamento; use o VALOR TOTAL pago; receita=true se o dinheiro ENTROU para o usuário)\n' +
      '{"tipo":"lista","lancamentos":[{"data":"AAAA-MM-DD","descricao":"...","valor":"123,45","tipo":"despesa"|"receita"}]}  (extrato ou fatura com vários lançamentos; ignore linhas de saldo e totais; no máximo 60)\n' +
      '{"tipo":"nada"}  (sem valores financeiros)';
    let raw = "";
    for (const model of MODELS) {
      try {
        const r = await ai.run(model, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: text.slice(0, 8000) },
          ],
          max_tokens: 2500,
          temperature: 0,
        });
        raw = typeof r === "string" ? r : typeof r?.response === "string" ? r.response : r?.response ? JSON.stringify(r.response) : "";
        if (raw) break;
      } catch {
        // próximo modelo
      }
    }
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { tipo: "nada" };
    let d: any;
    try {
      d = JSON.parse(json);
    } catch {
      return { tipo: "nada" };
    }
    if (d.tipo === "comprovante") {
      const v = signedMoney(String(d.total ?? ""));
      if (!v) return { tipo: "nada" };
      const data = typeof d.data === "string" ? sheetDate(d.data) : undefined;
      return {
        tipo: "comprovante",
        descricao: String(d.estabelecimento ?? "").trim().slice(0, 120) || "Pagamento",
        data,
        valor: Math.abs(v).toFixed(2),
        receita: d.receita === true,
      };
    }
    if (d.tipo === "lista" && Array.isArray(d.lancamentos)) {
      const linhas: Row[] = [];
      for (const l of d.lancamentos.slice(0, 60)) {
        const v = signedMoney(String(l?.valor ?? ""));
        if (!v) continue;
        const type = l.tipo === "receita" || v > 0 && l.tipo !== "despesa" && /receita|credito|entrada/i.test(String(l.tipo)) ? "income" : "expense";
        const description = String(l.descricao ?? "").trim().slice(0, 120) || (type === "income" ? "Receita" : "Despesa");
        linhas.push({
          date: sheetDate(String(l.data ?? "")) ?? today,
          description,
          amount: Math.abs(v).toFixed(2),
          type,
          category: type === "income" ? "outros-receitas" : categoryFrom(description) ?? classifyExpense(description),
        });
      }
      return linhas.length ? { tipo: "lista", linhas } : { tipo: "nada" };
    }
    return { tipo: "nada" };
  };
}

// ---------- Orçamento mensal em grade (linhas = itens, colunas = meses) ----------
// Ex.: | Item | Vencimento | JAN | FEV | ... | DEZ | (total) |
// A coluna de total é achada pelos valores (bate com a soma dos meses), em
// qualquer posição e mesmo sem título. Seções ("Renda", "Despesas", "Casa",
// "Transporte") definem tipo e categoria; linhas de total/saldo são puladas.
const MONTHS: [RegExp, number][] = [
  [/^jan(eiro)?\.?$/, 1], [/^fev(ereiro)?\.?$/, 2], [/^mar(co)?\.?$/, 3], [/^abr(il)?\.?$/, 4],
  [/^mai(o)?\.?$/, 5], [/^jun(ho)?\.?$/, 6], [/^jul(ho)?\.?$/, 7], [/^ago(sto)?\.?$/, 8],
  [/^set(embro)?\.?$/, 9], [/^out(ubro)?\.?$/, 10], [/^nov(embro)?\.?$/, 11], [/^dez(embro)?\.?$/, 12],
];
export const MONTH_NAMES = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
function monthOf(cell: string): number | undefined {
  const t = norm(cell).replace(/\s+/g, "");
  for (const [re, m] of MONTHS) if (re.test(t)) return m;
  const r = t.match(/^(\d{1,2})[/.-](\d{2}|\d{4})$/) ?? t.match(/^(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*[/.-](\d{2,4})$/);
  if (r && /^\d/.test(t)) {
    const m = Number(r[1]);
    if (m >= 1 && m <= 12) return m;
  }
  const m2 = t.match(/^([a-z]{3})[a-z]*[/.-]\d{2,4}$/);
  if (m2) for (const [re, m] of MONTHS) if (re.test(m2[1])) return m;
  return undefined;
}
const num = (cell: string | undefined) => {
  const v = signedMoney(cell ?? "");
  return v === undefined ? (/^\s*0([.,]0+)?\s*$/.test(cell ?? "") ? 0 : undefined) : v;
};

export type MatrixItem = { label: string; type: "income" | "expense"; category: string; months: Record<number, number>; total?: number; due?: number };
export type Matrix = { months: { col: number; month: number; label: string }[]; totalCol: number | null; items: MatrixItem[] };

const SKIP_LABEL = /^(total|subtotal|sub-total|saldo|resultado|renda total|despesas? totais|receitas? totais|saldo projetado|saldo inicial|saldo final|soma|balanco|liquido)\b/;
const INCOME_SECTION = /\b(renda|receita|entrada|ganho|salario|proventos|faturamento)/;
const SAVING_SECTION = /\b(economi|investiment|poupanc|reserva|aplicac)/;
const EXPENSE_SECTION = /\b(despesa|gasto|custo|conta|saida|pagamento)/;
const SECTION_CATEGORY: [RegExp, string][] = [
  [/casa|moradia|habitac|lar\b/, "moradia"],
  [/transporte|carro|veiculo/, "transporte"],
  [/saude|medic/, "saude"],
  [/educa|estudo|escola|curso/, "educacao"],
  [/lazer|entreteni|diversao|viage/, "lazer"],
  [/aliment|mercado|comida/, "alimentacao"],
];

export function findMatrix(md: string): Matrix | null {
  const tables = markdownTables(md);
  if (!tables.length) {
    const csv = csvTable(md);
    if (csv.length) tables.push(csv);
  }
  for (const table of tables) {
    // Linha com 3+ meses = cabeçalho.
    let hdr = -1;
    let months: { col: number; month: number; label: string }[] = [];
    for (let i = 0; i < Math.min(table.length, 40); i++) {
      const found = table[i].map((c, col) => ({ col, month: monthOf(c), label: c.trim() })).filter((x) => x.month) as { col: number; month: number; label: string }[];
      if (found.length >= 3) {
        hdr = i;
        months = found;
        break;
      }
    }
    if (hdr < 0) continue;
    const monthCols = new Set(months.map((m) => m.col));
    const body = table.slice(hdr + 1);
    const width = Math.max(...table.map((r) => r.length));
    // Coluna do rótulo: a com mais textos (letras) nas linhas.
    let labelCol = 0, best = -1;
    for (let c = 0; c < width; c++) {
      if (monthCols.has(c)) continue;
      const n = body.filter((r) => /\p{L}{2,}/u.test(r[c] ?? "")).length;
      if (n > best) (best = n), (labelCol = c);
    }
    // Coluna de vencimento (dia 1–31), se houver.
    const header = table[hdr].map((h) => norm(h));
    const aboveHeader = table.slice(Math.max(0, hdr - 3), hdr + 3).map((r) => r.map((h) => norm(h)));
    let dueCol: number | null = null;
    for (let c = 0; c < width; c++) {
      if (c === labelCol || monthCols.has(c)) continue;
      if (aboveHeader.some((r) => /venc|dia\b|vencto|data de pag/.test(r[c] ?? ""))) dueCol = c;
    }
    // Coluna de total: título "total/anual/ano" ou valores = soma dos meses.
    let totalCol: number | null = null;
    for (let c = 0; c < width; c++) {
      if (c === labelCol || c === dueCol || monthCols.has(c)) continue;
      if (/total|anual|\bano\b|acumulado/.test(header[c] ?? "")) {
        totalCol = c;
        break;
      }
      let hits = 0, tries = 0;
      for (const r of body) {
        const t = num(r[c]);
        if (t === undefined) continue;
        const sum = months.reduce((s, m) => s + (num(r[m.col]) ?? 0), 0);
        tries++;
        if (Math.abs(sum - t) < 0.05 + Math.abs(t) * 0.001) hits++;
      }
      if (tries >= 3 && hits / tries >= 0.7) {
        totalCol = c;
        break;
      }
    }
    // Itens por seção.
    let type: "income" | "expense" = "expense";
    let sectionCategory: string | undefined;
    let seenSection = false;
    const items: MatrixItem[] = [];
    // Totais que a própria planilha declara ("Renda Total", "Despesas Totais")
    // e as linhas "TOTAL" com a posição em que aparecem: servem para achar
    // onde termina o orçamento e começam anexos (ex.: "Renda Bruta", descontos).
    const declared: (number | undefined)[][] = [];
    const totalRows: { at: number; values: (number | undefined)[] }[] = [];
    for (const r of body) {
      const label = (r[labelCol] ?? "").replace(/\s+/g, " ").trim();
      const values = months.map((m) => num(r[m.col]));
      if (/^(renda|receitas?|entradas?|despesas?|gastos?|saidas?)s? totais?\b|^total (de|das|dos) (receitas?|despesas?|gastos?|entradas?|saidas?)/.test(norm(label))) declared.push(values);
      if (/^total\b/.test(norm(label))) totalRows.push({ at: items.length, values });
      const hasNumbers = values.some((v) => v !== undefined) || (totalCol !== null && num(r[totalCol]) !== undefined);
      const nl = norm(label);
      if (!label) continue; // linha de soma sem rótulo
      if (!hasNumbers) {
        // Título de seção.
        if (INCOME_SECTION.test(nl)) (type = "income"), (sectionCategory = undefined), (seenSection = true);
        else if (SAVING_SECTION.test(nl)) (type = "expense"), (sectionCategory = "outros-despesas"), (seenSection = true);
        else if (EXPENSE_SECTION.test(nl)) (type = "expense"), (sectionCategory = undefined), (seenSection = true);
        else if (type === "expense") sectionCategory = SECTION_CATEGORY.find(([re]) => re.test(nl))?.[1] ?? sectionCategory;
        continue;
      }
      if (SKIP_LABEL.test(nl)) continue;
      const monthValues: Record<number, number> = {};
      months.forEach((m, i) => {
        if (values[i] !== undefined && values[i] !== 0) monthValues[m.month] = Math.abs(values[i]!);
      });
      const total = totalCol !== null ? num(r[totalCol]) : undefined;
      const dueRaw = dueCol !== null ? (r[dueCol] ?? "").match(/\b([12]?\d|3[01])\b/)?.[1] : undefined;
      const itemType = !seenSection && INCOME_SECTION.test(nl) ? "income" : type;
      const category =
        itemType === "income"
          ? /salario/.test(nl) ? "salario" : /freela|pj\b/.test(nl) ? "freelance" : /invest|rendiment|dividend/.test(nl) ? "investimentos" : "outros-receitas"
          : (sectionCategory && sectionCategory !== "outros-despesas" ? sectionCategory : undefined) ?? categoryFrom(label) ?? sectionCategory ?? classifyExpense(label);
      items.push({ label: label.slice(0, 120), type: itemType, category, months: monthValues, total: total === undefined ? undefined : Math.abs(total), due: dueRaw ? Number(dueRaw) : undefined });
    }
    // Corta o que vem depois da última linha TOTAL que repete um total declarado.
    const same = (a: (number | undefined)[], b: (number | undefined)[]) => {
      let ok = 0, n = 0;
      a.forEach((v, i) => {
        if (v === undefined || b[i] === undefined) return;
        n++;
        if (Math.abs(v - b[i]!) <= 0.05 + Math.abs(v) * 0.001) ok++;
      });
      return n >= 3 && ok / n >= 0.8;
    };
    let cut = -1;
    for (const t of totalRows) if (declared.some((d) => same(d, t.values))) cut = Math.max(cut, t.at);
    const kept = cut > 0 ? items.slice(0, cut) : items;
    if (kept.length) return { months, totalCol, items: kept };
  }
  return null;
}

// Monta os lançamentos de uma escolha: total do ano (data de hoje) ou um mês.
export function rowsFromMatrix(m: Matrix, choice: "total" | number, today = brazilToday()): Row[] {
  const year = Number(today.slice(0, 4));
  const rows: Row[] = [];
  for (const it of m.items) {
    let value: number;
    let date = today;
    if (choice === "total") {
      value = it.total ?? Object.values(it.months).reduce((a, b) => a + b, 0);
    } else {
      value = it.months[choice] ?? 0;
      const last = new Date(Date.UTC(year, choice, 0)).getUTCDate();
      const day = Math.min(it.due && it.due >= 1 ? it.due : 1, last);
      date = `${year}-${String(choice).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    if (!(value > 0)) continue;
    rows.push({ date, description: it.label, amount: value.toFixed(2), type: it.type, category: it.category });
  }
  return rows;
}

// "última coluna", "coluna total", "o total", "novembro", "mês atual", "primeiro mês".
export function matrixChoice(text: string, m: Matrix, today = brazilToday()): "total" | number | undefined {
  const t = norm(text);
  if (/\b(total|ultima coluna|coluna final|anual|ano todo|ano inteiro|tudo somado|soma)\b/.test(t)) return "total";
  if (/\b(mes atual|este mes|esse mes|deste mes|desse mes|mes corrente)\b/.test(t)) return Number(today.slice(5, 7));
  if (/\b(primeira coluna|primeiro mes)\b/.test(t)) return m.months[0]?.month;
  for (const w of t.split(/[^a-z0-9]+/)) {
    const mo = monthOf(w);
    if (mo && m.months.some((x) => x.month === mo)) return mo;
  }
  return undefined;
}
