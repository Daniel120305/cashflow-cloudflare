import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { userDatabase } from "../db.js";
import { categoryLabel, parseTransaction, brazilToday } from "./receipt.js";
import { readReceipt } from "./ocr.js";
import { parseCorrection, parseNatural, intentOf, parseDelete, wordsToNumbers, EXPENSE_CATEGORIES, type Correction, type AiReading } from "./conversa.js";
type Input = {
  description: string;
  amount: string;
  category: string;
  type: "income" | "expense";
  date: string;
  idempotency_key: string;
};
type Deps = {
  db: Database;
  token?: string;
  fetcher?: typeof fetch;
  ocr?: (image: Uint8Array) => Promise<string>;
  record: (userId: number, input: Input) => Promise<any>;
  summary: (userId: number, month?: string) => Promise<any>;
  // Endereço do site, para os botões "Abrir o CashFlow".
  siteUrl?: string;
  // IA de texto (reserva) para mensagens que as regras não entendem.
  interpret?: (text: string, pending: any) => Promise<AiReading | null>;
  // Transcrição de áudio (Whisper no Workers AI).
  transcribe?: (audio: Uint8Array) => Promise<string>;
};
// Pendência (comprovante lido ou lançamento entendido pela IA) esperando o "Registrar".
// O tipo fica em texto_ocr ("tipo:income"); sem marca, é despesa.
type Pending = { id: number; descricao: string; valor: string; categoria: string; data_transacao: any; texto_ocr: string | null };
const pendingDate = (p: Pending) =>
  p.data_transacao instanceof Date ? p.data_transacao.toISOString().slice(0, 10) : String(p.data_transacao).slice(0, 10);
const pendingType = (p: Pending) => (p.texto_ocr === "tipo:income" ? "income" : "expense");
// Texto do usuário dentro de mensagens HTML do Telegram.
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
// Barra de progresso: ▰▰▰▱▱▱▱▱▱▱ 30%
const bar = (pct: number) => {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▰".repeat(n) + "▱".repeat(10 - n);
};
const monthName = (ym: string) =>
  new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(ym + "-15T12:00:00Z"));
const previousMonth = (ym: string) => {
  const d = new Date(ym + "-15T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const DICAS = [
  "Anote todo gasto no mesmo dia: é mais fácil lembrar e o resumo do mês fica fiel.",
  "Regra 50-30-20: 50% para necessidades, 30% para desejos e 20% para poupar ou investir.",
  "Antes de uma compra por impulso, espere 24 horas. Se ainda quiser, compre sem culpa.",
  "Monte uma reserva de emergência de 3 a 6 meses dos seus gastos fixos antes de investir em risco.",
  "Revise assinaturas e serviços todo mês: streaming e apps esquecidos somam muito no ano.",
  "Defina um gasto máximo mensal no CashFlow: o bot avisa quando você chegar a 80%.",
  "Pague a fatura do cartão inteira: os juros do rotativo estão entre os mais altos do país.",
  "Separe o dinheiro de poupar logo que o salário cair, e não o que sobrar no fim do mês.",
  "Compare o preço por quilo ou por litro no mercado: o pacote maior nem sempre sai mais barato.",
  "Tenha metas com valor e prazo (ex.: R$ 3.000 até dezembro). Metas concretas são mais fáceis de cumprir.",
  "Use /categorias para ver onde mais gasta: o maior corte costuma estar na maior categoria.",
  "Leve marmita alguns dias da semana: pequenas economias diárias viram muito no mês.",
];
export const HELP_TEXT = [
  "<b>💰 CashFlow — comandos</b>",
  "",
  "<b>Registrar</b>",
  "• <code>/despesa mercado 35,90</code> — registra uma despesa",
  "• <code>/receita salário 3000</code> — registra uma receita",
  "• Ou escreva do seu jeito: <code>gastei 50 no mercado</code>, <code>paguei 120 de luz ontem</code>",
  "• 📷 Foto do cupom fiscal — leio e você corrige o que precisar (ex.: <code>valor 2.100</code>)",
  "• 🎙️ Áudio — fale \"gastei cinquenta no mercado\" e confirme",
  "• /desfazer — apaga o último lançamento",
  "• <code>apaga a despesa do mercado</code> — procura e apaga (também por áudio)",
  "",
  "<b>Consultar</b> (ou pergunte: <i>quanto gastei esse mês?</i>)",
  "• /saldo — saldo total e do mês",
  "• /mes — resumo do mês e comparação com o anterior",
  "• /hoje — lançamentos de hoje",
  "• /extrato — últimos 10 lançamentos",
  "• /categorias — onde você mais gastou no mês",
  "• /limite — gasto máximo: quanto já usou e quanto falta",
  "",
  "<b>Outros</b>",
  "• /dica — uma dica rápida de finanças",
  "• /site — abrir o CashFlow",
  "• /desvincular — desligar este Telegram da sua conta",
].join("\n");
const MENU = {
  inline_keyboard: [
    [
      { text: "💰 Saldo", callback_data: "cmd:saldo" },
      { text: "📅 Mês", callback_data: "cmd:mes" },
      { text: "🧾 Extrato", callback_data: "cmd:extrato" },
    ],
    [
      { text: "📊 Categorias", callback_data: "cmd:categorias" },
      { text: "🎯 Limite", callback_data: "cmd:limite" },
      { text: "💡 Dica", callback_data: "cmd:dica" },
    ],
  ],
};
const brl = (value: unknown) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    Number(value ?? 0),
  );
const normalize = (s: string) => s.replace(/^@/, "").toLowerCase();
export class TelegramService {
  private fetcher: typeof fetch;
  constructor(private deps: Deps) {
    // No Worker, fetch guardado num objeto e chamado como this.fetcher(...)
    // dá "Illegal invocation"; por isso fica embrulhado numa função.
    this.fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  }
  private async api(method: string, payload: object) {
    if (!this.deps.token) throw new Error("Telegram não configurado.");
    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.deps.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4500),
      },
    );
    if (!response.ok) throw new Error("Falha na comunicação com Telegram.");
    const result = (await response.json()) as any;
    if (!result.ok) throw new Error("Telegram recusou a operação.");
    return result.result;
  }
  async send(chatId: string | number, text: string, options: object = {}) {
    await this.api("sendMessage", {
      ...options,
      chat_id: chatId,
      text: text.slice(0, 4096),
    });
  }
  async handle(update: any): Promise<void> {
    const cb = update.callback_query;
    const message = cb?.message ?? update.message;
    const from = cb?.from ?? message?.from;
    if (
      !message?.chat ||
      message.chat.type !== "private" ||
      String(message.chat.id) !== String(from?.id)
    )
      return;
    const chat = message.chat.id;
    if (cb?.id)
      await this.api("answerCallbackQuery", { callback_query_id: cb.id }).catch(
        () => {},
      );
    const command = String(message.text ?? "").trim();
    const link = command.match(
      /^\/(?:start|vincular)(?:@\w+)?\s+(\S{16,256})$/,
    );
    if (link) {
      if (!from.username) {
        await this.send(
          chat,
          "Defina um nome de usuário no Telegram antes de vincular.",
        );
        return;
      }
      const hash = createHash("sha256").update(link[1]).digest("hex");
      const result = await this.deps.db.query(
        `UPDATE telegram_vinculos SET telegram_id=$1,usado_em=NOW() WHERE token_hash=$2 AND LOWER(LTRIM(nome_telegram,'@'))=$3 AND usado_em IS NULL AND expira_em>NOW() RETURNING usuario_id`,
        [from.id, hash, normalize(String(from.username ?? ""))],
      );
      await this.send(
        chat,
        result.rows.length
          ? "Telegram vinculado com sucesso."
          : "Código inválido, expirado ou usuário diferente.",
      );
      return;
    }
    const linked = await this.deps.db.query(
      "SELECT usuario_id FROM telegram_vinculos WHERE telegram_id=$1 AND usado_em IS NOT NULL",
      [from.id],
    );
    // bigint no Supabase chega como texto: converte para número.
    const userId = linked.rows[0]?.usuario_id == null ? undefined : Number(linked.rows[0].usuario_id);
    const cmd = command.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    const name = cmd?.[1]?.toLowerCase();
    if (!userId) {
      if (name === "ajuda" || name === "help") {
        await this.html(chat, HELP_TEXT + "\n\n<i>Antes, vincule sua conta: no site, Perfil → Telegram → Gerar código.</i>", this.siteButton("Vincular no site", "/perfil"));
        return;
      }
      await this.html(
        chat,
        "👋 <b>Olá! Eu sou o assistente do CashFlow.</b>\n\nPara usar, vincule sua conta:\n1. Entre no site e abra o <b>Perfil</b>\n2. Toque em <b>Telegram</b> e gere o código\n3. Toque em <b>Abrir no Telegram e vincular</b>",
        this.siteButton("Abrir o CashFlow", "/perfil"),
      );
      return;
    }
    if (cb) {
      await this.callback(chat, userId, String(cb.data ?? ""));
      return;
    }
    if (message.photo?.length) {
      await this.photo(chat, userId, message.photo.at(-1));
      return;
    }
    if (message.voice || message.audio) {
      await this.voice(chat, userId, message.voice ?? message.audio, update, message);
      return;
    }
    await this.handleText(chat, userId, command, update, message);
  }
  // Texto escrito ou transcrito de áudio. No áudio (voice=true), lançamentos
  // sempre pedem confirmação: a transcrição pode ouvir um número errado.
  private async handleText(chat: number, userId: number, command: string, update: any, message: any, voice = false) {
    const cmd = command.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    const name = cmd?.[1]?.toLowerCase();
    if (name && (await this.command(chat, userId, name, (cmd![2] ?? "").trim(), update, message))) return;
    // Há um comprovante esperando confirmação? Texto livre pode ser correção.
    const pending = name ? null : await this.pending(userId, chat);
    if (pending) {
      const corr = parseCorrection(command);
      if (corr) {
        await this.applyCorrection(chat, userId, pending, corr);
        return;
      }
    }
    const parsed = parseTransaction(command);
    if (parsed) {
      if (voice) return this.propose(chat, userId, { ...parsed, type: parsed.type as "income" | "expense" }, "🎙️ <b>Entendi assim:</b>");
      await this.register(chat, userId, parsed, update, message);
      return;
    }
    if (!name) {
      const termo = parseDelete(command);
      if (termo) {
        await this.findToDelete(chat, userId, termo);
        return;
      }
      const natural = parseNatural(command);
      if (natural) {
        if (voice) return this.propose(chat, userId, natural, "🎙️ <b>Entendi assim:</b>");
        await this.register(chat, userId, natural, update, message);
        return;
      }
      const intent = intentOf(command);
      if (intent && (await this.command(chat, userId, intent, "", update, message))) return;
      // Reserva: IA de texto. O que ela entende como lançamento pede confirmação.
      const reading = await this.deps.interpret?.(command, pending ? { descricao: pending.descricao, valor: String(pending.valor), data: pendingDate(pending), categoria: pending.categoria } : null).catch(() => null);
      if (reading?.acao === "correcao" && pending) return this.applyCorrection(chat, userId, pending, reading.correcao);
      if (reading?.acao === "comando" && (await this.command(chat, userId, reading.comando, "", update, message))) return;
      if (reading?.acao === "lancamento") return this.propose(chat, userId, reading.lancamento, voice ? "🎙️ <b>Entendi assim:</b>" : "🤖 <b>Entendi assim:</b>");
      if (pending) {
        await this.html(chat, "Não entendi a correção. 🤔 Você pode escrever, por exemplo:\n• <code>valor 2.100</code>\n• <code>data hoje</code> ou <code>foi dia 20</code>\n• <code>categoria lazer</code>\n• <code>nome Shopping Som</code>\nOu use os botões do comprovante.");
        return;
      }
      if (reading?.acao === "outro" && reading.resposta) {
        await this.html(chat, esc(reading.resposta), { reply_markup: MENU });
        return;
      }
    }
    await this.html(
      chat,
      "Não entendi. 🤔\nTente: <code>gastei 50 no mercado</code>, <code>/despesa mercado 35,90</code> ou <code>quanto gastei esse mês?</code>\nToque em <b>Menu</b> ou mande /ajuda para ver tudo.",
      { reply_markup: MENU },
    );
  }
  // Lançamento proposto (áudio ou IA): fica pendente até o "Registrar".
  private async propose(chat: number, userId: number, l: { type: "income" | "expense"; amount: string; description: string; category: string; date: string }, title: string) {
    const r = await this.scoped(userId).query(
      "INSERT INTO ocr_pendencias(telegram_id,usuario_id,descricao,valor,categoria,data_transacao,texto_ocr,expira_em) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '15 minutes') RETURNING *",
      [chat, userId, l.description, l.amount, l.category, l.date, l.type === "income" ? "tipo:income" : null],
    );
    await this.showPending(chat, r.rows[0], title);
  }
  // "apaga a despesa do mercado": acha o lançamento mais recente e pede confirmação.
  private async findToDelete(chat: number, userId: number, termo: string) {
    const r = await this.scoped(userId).query(
      "SELECT id,descricao,valor,tipo,to_char(data_transacao,'DD/MM/YYYY') AS data FROM transacoes WHERE usuario_id=$1 AND (translate(lower(descricao),'áàâãéêíóôõúç','aaaaeeiooouc') LIKE '%'||$2||'%' OR lower(categoria) LIKE '%'||$2||'%') ORDER BY data_transacao DESC,id DESC LIMIT 3",
      [userId, termo.replace(/[%_\\]/g, "")],
    );
    if (!r.rows.length) {
      await this.html(chat, `Não achei lançamento com "<b>${esc(termo)}</b>". 🤔\nVeja os últimos com /extrato ou apague o último com /desfazer.`);
      return;
    }
    const linhas = r.rows.map((t: any) => [{ text: `🗑 ${t.descricao.slice(0, 24)} · ${brl(t.valor)} · ${t.data.slice(0, 5)}`, callback_data: `desfazer:${t.id}` }]);
    await this.html(chat, r.rows.length === 1 ? "Apagar este lançamento?" : "Qual destes você quer apagar?", {
      reply_markup: { inline_keyboard: [...linhas, [{ text: "Manter tudo", callback_data: "manter" }]] },
    });
  }
  // Baixa um arquivo do Telegram com limite de tamanho.
  private async download(fileId: string, max: number, path: RegExp) {
    const file = await this.api("getFile", { file_id: fileId });
    if (!path.test(file.file_path) || file.file_path.includes("..")) throw new Error("Arquivo inválido.");
    const response = await this.fetcher(`https://api.telegram.org/file/bot${this.deps.token}/${file.file_path}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok || Number(response.headers.get("content-length")) > max) throw new Error("Arquivo inválido.");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > max) throw new Error("Arquivo muito grande.");
    return data;
  }
  private async voice(chat: number, userId: number, audio: any, update: any, message: any) {
    if (!this.deps.transcribe) {
      await this.send(chat, "Ainda não consigo ouvir áudios. Escreva, por exemplo: gastei 50 no mercado.");
      return;
    }
    if (Number(audio.duration) > 90 || Number(audio.file_size) > 5 * 1024 * 1024) {
      await this.send(chat, "Esse áudio é longo demais. 🙂 Mande um áudio curto (até 1 minuto e meio), por exemplo: \"gastei 50 reais no mercado\".");
      return;
    }
    await this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    let text = "";
    try {
      const bytes = await this.download(audio.file_id, 5 * 1024 * 1024, /^(voice|music|audio|documents)\/[\w.\/-]+$/);
      text = (await this.deps.transcribe(bytes)).trim();
      bytes.fill(0);
    } catch (error) {
      console.error("Telegram: falha ao transcrever áudio", String((error as Error)?.message ?? error));
      await this.send(chat, "Não consegui entender o áudio agora. 😕 Tente de novo ou escreva a mensagem.");
      return;
    }
    if (!text) {
      await this.send(chat, "Não ouvi nada no áudio. 🤔 Tente falar mais perto do microfone.");
      return;
    }
    await this.html(chat, `🎙️ <i>“${esc(text)}”</i>`);
    const clean = wordsToNumbers(text.replace(/^[\s"“”']+|[\s"“”'.!?]+$/g, ""));
    await this.handleText(chat, userId, clean, update, message, true);
  }
  private async pending(userId: number, chat: number): Promise<Pending | null> {
    const r = await this.scoped(userId).query(
      "SELECT * FROM ocr_pendencias WHERE usuario_id=$1 AND telegram_id=$2 AND confirmado_em IS NULL AND expira_em>NOW() ORDER BY id DESC LIMIT 1",
      [userId, chat],
    );
    return r.rows[0] ?? null;
  }
  private async showPending(chat: number, p: Pending, title = "🧾 <b>Li este comprovante:</b>") {
    const income = pendingType(p) === "income";
    await this.html(
      chat,
      `${title}\n\n🏪 ${esc(p.descricao)}\n💸 <b>${brl(p.valor)}</b>\n📅 ${pendingDate(p).split("-").reverse().join("/")}\n🏷 ${esc(categoryLabel(p.categoria))}\n\nRegistrar como ${income ? "receita" : "despesa"}?\n<i>Algo errado? Toque para editar ou escreva, ex.: "valor 2.100", "data hoje".</i>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Registrar", callback_data: `confirmar:${p.id}` },
              { text: "✖️ Cancelar", callback_data: `cancelar:${p.id}` },
            ],
            [
              { text: "✏️ Valor", callback_data: `editar:valor:${p.id}` },
              { text: "📅 Data", callback_data: `editar:data:${p.id}` },
              ...(income ? [] : [{ text: "🏷 Categoria", callback_data: `editar:cat:${p.id}` }]),
              { text: "🏪 Nome", callback_data: `editar:nome:${p.id}` },
            ],
          ],
        },
      },
    );
  }
  private async applyCorrection(chat: number, userId: number, p: Pending, c: Correction) {
    if (c.cancelar) return this.confirm(chat, userId, `cancelar:${p.id}`);
    const sets: string[] = [];
    const vals: any[] = [];
    const add = (col: string, v: any) => (vals.push(v), sets.push(`${col}=$${vals.length}`));
    if (c.valor) add("valor", c.valor);
    if (c.data) add("data_transacao", c.data);
    if (c.categoria && pendingType(p) === "expense") add("categoria", c.categoria);
    if (c.descricao) add("descricao", c.descricao);
    if (sets.length) {
      vals.push(p.id, userId, chat);
      const n = vals.length;
      const r = await this.scoped(userId).query(
        `UPDATE ocr_pendencias SET ${sets.join(",")},expira_em=NOW()+INTERVAL '15 minutes' WHERE id=$${n - 2} AND usuario_id=$${n - 1} AND telegram_id=$${n} AND confirmado_em IS NULL RETURNING *`,
        vals,
      );
      if (!r.rows[0]) {
        await this.send(chat, "Esse comprovante já foi registrado ou expirou.");
        return;
      }
      p = r.rows[0];
    }
    if (c.confirmar) return this.confirm(chat, userId, `confirmar:${p.id}`);
    await this.showPending(chat, p, "✏️ <b>Pronto, atualizei:</b>");
  }
  private async html(chat: number | string, text: string, options: object = {}) {
    await this.send(chat, text, { parse_mode: "HTML", disable_web_page_preview: true, ...options });
  }
  private siteButton(label: string, path = "/") {
    if (!this.deps.siteUrl) return {};
    return { reply_markup: { inline_keyboard: [[{ text: label, url: new URL(path, this.deps.siteUrl).toString() }]] } };
  }
  private scoped(userId: number) {
    return userDatabase(this.deps.db, userId);
  }
  private async register(chat: number, userId: number, parsed: any, update: any, message: any) {
    try {
      await this.deps.record(userId, {
        ...parsed,
        idempotency_key: `telegram:${update.update_id ?? `${chat}:${message.message_id}`}`,
      });
    } catch (error: any) {
      if (error?.statusCode >= 400 && error?.statusCode < 500) {
        await this.send(chat, error.message);
        return;
      }
      throw error;
    }
    const income = parsed.type === "income";
    await this.html(
      chat,
      `${income ? "🟢 Receita" : "🔴 Despesa"} registrada!\n<b>${esc(parsed.description)}</b> · ${brl(parsed.amount)}\n${esc(categoryLabel(parsed.category))} · ${parsed.date.split("-").reverse().join("/")}`,
      { reply_markup: { inline_keyboard: [[{ text: "↩️ Desfazer", callback_data: "cmd:desfazer" }, { text: "💰 Saldo", callback_data: "cmd:saldo" }]] } },
    );
  }
  // Devolve true se o comando foi reconhecido.
  private async command(chat: number, userId: number, name: string, args: string, update: any, message: any): Promise<boolean> {
    const month = brazilToday().slice(0, 7);
    switch (name) {
      case "start":
      case "ajuda":
      case "help":
      case "menu":
        await this.html(chat, name === "start" ? "👋 <b>Bem-vindo de volta ao CashFlow!</b>\n\n" + HELP_TEXT : HELP_TEXT, { reply_markup: MENU });
        return true;
      case "despesa":
      case "receita": {
        const parsed = args ? parseTransaction(`${name} ${args}`) : null;
        if (!parsed) {
          await this.html(chat, `Use assim: <code>/${name} ${name === "despesa" ? "mercado 35,90" : "salário 3000"}</code>\n(descrição e valor)`);
          return true;
        }
        await this.register(chat, userId, parsed, update, message);
        return true;
      }
      case "saldo": {
        const s = await this.deps.summary(userId);
        const lines = [
          `<b>💰 Saldo total: ${brl(s.saldo_total)}</b>`,
          "",
          `<b>${esc(monthName(s.mes))}</b>`,
          `🟢 Receitas: ${brl(s.receitas)}`,
          `🔴 Despesas: ${brl(s.despesas)}`,
          `= Saldo do mês: ${brl(s.saldo)}`,
        ];
        if (s.gasto_maximo > 0) lines.push("", `🎯 Limite: ${bar(s.percentual)} ${Math.round(s.percentual)}% de ${brl(s.gasto_maximo)}`);
        await this.html(chat, lines.join("\n"), { reply_markup: MENU });
        return true;
      }
      case "mes": {
        const [atual, anterior] = [await this.deps.summary(userId, month), await this.deps.summary(userId, previousMonth(month))];
        const diff = atual.despesas - anterior.despesas;
        const comp = anterior.despesas > 0
          ? `${diff > 0 ? "📈" : "📉"} Despesas ${diff > 0 ? "acima" : "abaixo"} do mês passado em ${brl(Math.abs(diff))} (${Math.round((Math.abs(diff) / anterior.despesas) * 100)}%)`
          : "Sem despesas no mês passado para comparar.";
        await this.html(chat, [
          `<b>📅 ${esc(monthName(month))}</b>`,
          `🟢 Receitas: ${brl(atual.receitas)}`,
          `🔴 Despesas: ${brl(atual.despesas)}`,
          `= Saldo do mês: <b>${brl(atual.saldo)}</b>`,
          "",
          `<i>${esc(monthName(previousMonth(month)))}: despesas de ${brl(anterior.despesas)}</i>`,
          comp,
        ].join("\n"), { reply_markup: MENU });
        return true;
      }
      case "hoje": {
        const r = await this.scoped(userId).query(
          "SELECT descricao,valor,tipo FROM transacoes WHERE usuario_id=$1 AND data_transacao=$2 ORDER BY id",
          [userId, brazilToday()],
        );
        if (!r.rows.length) {
          await this.html(chat, "Nenhum lançamento hoje. 🙂\nRegistre com <code>/despesa café 6,50</code>.");
          return true;
        }
        let gastos = 0, entradas = 0;
        const linhas = r.rows.map((x: any) => {
          if (x.tipo === "income") entradas += Number(x.valor); else gastos += Number(x.valor);
          return `${x.tipo === "income" ? "🟢" : "🔴"} ${esc(x.descricao)} · ${brl(x.valor)}`;
        });
        await this.html(chat, [`<b>📆 Hoje</b>`, ...linhas, "", `Gastos: <b>${brl(gastos)}</b>${entradas ? ` · Entradas: ${brl(entradas)}` : ""}`].join("\n"));
        return true;
      }
      case "extrato": {
        const r = await this.scoped(userId).query(
          "SELECT descricao,valor,tipo,to_char(data_transacao,'DD/MM') AS data FROM transacoes WHERE usuario_id=$1 ORDER BY data_transacao DESC,id DESC LIMIT 10",
          [userId],
        );
        await this.html(
          chat,
          r.rows.length
            ? ["<b>🧾 Últimos lançamentos</b>", ...r.rows.map((x: any) => `${x.data} ${x.tipo === "income" ? "🟢" : "🔴"} ${esc(x.descricao)} · ${x.tipo === "income" ? "+" : "−"}${brl(x.valor)}`)].join("\n")
            : "Nenhum lançamento ainda.",
          this.siteButton("Ver tudo no site", "/home"),
        );
        return true;
      }
      case "categorias": {
        const r = await this.scoped(userId).query(
          "SELECT categoria,SUM(valor) AS total FROM transacoes WHERE usuario_id=$1 AND tipo='expense' AND data_transacao>=($2||'-01')::date AND data_transacao<(($2||'-01')::date+INTERVAL '1 month') GROUP BY categoria ORDER BY total DESC LIMIT 8",
          [userId, month],
        );
        if (!r.rows.length) {
          await this.html(chat, `Nenhuma despesa em ${esc(monthName(month))} ainda.`);
          return true;
        }
        const total = r.rows.reduce((t: number, x: any) => t + Number(x.total), 0);
        await this.html(chat, [
          `<b>📊 Despesas por categoria — ${esc(monthName(month))}</b>`,
          ...r.rows.map((x: any) => {
            const pct = (Number(x.total) / total) * 100;
            return `${esc(categoryLabel(x.categoria))}: <b>${brl(x.total)}</b>\n${bar(pct)} ${Math.round(pct)}%`;
          }),
          "",
          `Total: <b>${brl(total)}</b>`,
        ].join("\n"));
        return true;
      }
      case "limite": {
        const s = await this.deps.summary(userId);
        if (!(s.gasto_maximo > 0)) {
          await this.html(chat, "Você ainda não definiu um gasto máximo mensal. 🎯\nDefina no site e eu aviso quando chegar a 80% e a 100%.", this.siteButton("Definir gasto máximo", "/perfil#gasto-maximo"));
          return true;
        }
        const resta = s.gasto_maximo - s.despesas;
        const hoje = new Date(brazilToday() + "T12:00:00Z");
        const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 0));
        const dias = fim.getUTCDate() - hoje.getUTCDate() + 1;
        await this.html(chat, [
          `<b>🎯 Gasto máximo de ${esc(monthName(s.mes))}</b>`,
          `${bar(s.percentual)} ${Math.round(s.percentual)}%`,
          `Gasto: ${brl(s.despesas)} de ${brl(s.gasto_maximo)}`,
          resta >= 0
            ? `Ainda pode gastar: <b>${brl(resta)}</b> (≈ ${brl(resta / dias)} por dia nos ${dias} dias restantes)`
            : `⚠️ Passou do limite em <b>${brl(-resta)}</b>.`,
        ].join("\n"));
        return true;
      }
      case "desfazer": {
        const r = await this.scoped(userId).query(
          "SELECT id,descricao,valor,tipo,to_char(data_transacao,'DD/MM/YYYY') AS data FROM transacoes WHERE usuario_id=$1 ORDER BY id DESC LIMIT 1",
          [userId],
        );
        const t = r.rows[0];
        if (!t) {
          await this.send(chat, "Não há lançamentos para desfazer.");
          return true;
        }
        await this.html(chat, `Apagar o último lançamento?\n${t.tipo === "income" ? "🟢" : "🔴"} <b>${esc(t.descricao)}</b> · ${brl(t.valor)} · ${t.data}`, {
          reply_markup: { inline_keyboard: [[{ text: "🗑 Apagar", callback_data: `desfazer:${t.id}` }, { text: "Manter", callback_data: "manter" }]] },
        });
        return true;
      }
      case "dica":
        await this.html(chat, `💡 <b>Dica</b>\n${esc(DICAS[Math.floor(Math.random() * DICAS.length)])}`, {
          reply_markup: { inline_keyboard: [[{ text: "💡 Outra dica", callback_data: "cmd:dica" }]] },
        });
        return true;
      case "site":
        await this.html(chat, "Abra o CashFlow pelo botão abaixo:", this.siteButton("🌐 Abrir o CashFlow", "/home"));
        return true;
      case "desvincular":
        await this.html(chat, "Desligar este Telegram da sua conta do CashFlow? Seus dados no site continuam.", {
          reply_markup: { inline_keyboard: [[{ text: "Desvincular", callback_data: "desvincular:sim" }, { text: "Cancelar", callback_data: "manter" }]] },
        });
        return true;
      default:
        return false;
    }
  }
  private async callback(chat: number, userId: number, data: string) {
    if (data.startsWith("cmd:")) {
      await this.command(chat, userId, data.slice(4), "", {}, {});
      return;
    }
    if (data === "manter") {
      await this.send(chat, "Ok, nada foi alterado.");
      return;
    }
    const undo = data.match(/^desfazer:(\d+)$/);
    if (undo) {
      const r = await this.scoped(userId).query(
        "DELETE FROM transacoes WHERE id=$1 AND usuario_id=$2 RETURNING descricao,valor",
        [undo[1], userId],
      );
      await this.html(chat, r.rows[0] ? `🗑 Apagado: <b>${esc(r.rows[0].descricao)}</b> · ${brl(r.rows[0].valor)}` : "Esse lançamento já não existe.");
      return;
    }
    const edit = data.match(/^editar:(valor|data|cat|nome):(\d+)$/);
    if (edit) {
      const [, campo, id] = edit;
      if (campo === "valor") await this.html(chat, "💸 Qual é o valor certo? Mande só o número, ex.: <code>2.100,00</code>");
      else if (campo === "nome") await this.html(chat, "🏪 Qual é o nome certo? Ex.: <code>nome Shopping Som</code>");
      else if (campo === "data")
        await this.html(chat, "📅 Qual é a data? Toque ou mande, ex.: <code>25/11</code>", {
          reply_markup: { inline_keyboard: [[{ text: "Hoje", callback_data: `quando:${id}:hoje` }, { text: "Ontem", callback_data: `quando:${id}:ontem` }, { text: "Anteontem", callback_data: `quando:${id}:anteontem` }]] },
        });
      else {
        const botoes = EXPENSE_CATEGORIES.map((c) => ({ text: categoryLabel(c), callback_data: `cat:${id}:${c}` }));
        const linhas = [];
        for (let i = 0; i < botoes.length; i += 3) linhas.push(botoes.slice(i, i + 3));
        await this.html(chat, "🏷 Escolha a categoria:", { reply_markup: { inline_keyboard: linhas } });
      }
      return;
    }
    const quick = data.match(/^(cat|quando):(\d+):([a-z-]+)$/);
    if (quick) {
      const p = await this.pending(userId, chat);
      if (!p || String(p.id) !== quick[2]) {
        await this.send(chat, "Esse comprovante já foi registrado ou expirou.");
        return;
      }
      const corr: Correction = {};
      if (quick[1] === "cat" && EXPENSE_CATEGORIES.includes(quick[3])) corr.categoria = quick[3];
      if (quick[1] === "quando") {
        const { parseDate } = await import("./conversa.js");
        const d = parseDate(quick[3]);
        if (d) corr.data = d;
      }
      await this.applyCorrection(chat, userId, p, corr);
      return;
    }
    if (data === "desvincular:sim") {
      await this.deps.db.query("DELETE FROM telegram_vinculos WHERE usuario_id=$1 AND telegram_id=$2", [userId, chat]);
      await this.send(chat, "Telegram desvinculado. Para ligar de novo, gere um código no Perfil do site.");
      return;
    }
    await this.confirm(chat, userId, data);
  }
  private async confirm(chat: number, userId: number, data: string) {
    const m = data.match(/^(confirmar|cancelar):(\d+)$/);
    if (!m) return;
    if (m[1] === "cancelar") {
      await userDatabase(this.deps.db, userId).query(
        "DELETE FROM ocr_pendencias WHERE id=$1 AND usuario_id=$2 AND telegram_id=$3 AND confirmado_em IS NULL",
        [m[2], userId, chat],
      );
      await this.send(chat, "Ok, comprovante descartado. Nada foi registrado.");
      return;
    }
    const r = await userDatabase(this.deps.db, userId).query(
      "SELECT * FROM ocr_pendencias WHERE id=$1 AND usuario_id=$2 AND telegram_id=$3 AND confirmado_em IS NULL AND expira_em>NOW()",
      [m[2], userId, chat],
    );
    const p = r.rows[0];
    if (!p) {
      await this.send(chat, "Confirmação expirada ou já processada.");
      return;
    }
    await this.deps.record(userId, {
      description: p.descricao,
      amount: String(p.valor),
      category: p.categoria,
      type: pendingType(p),
      date:
        p.data_transacao instanceof Date
          ? p.data_transacao.toISOString().slice(0, 10)
          : String(p.data_transacao).slice(0, 10),
      idempotency_key: `ocr:${p.id}`,
    });
    await userDatabase(this.deps.db, userId).query(
      "UPDATE ocr_pendencias SET confirmado_em=NOW() WHERE id=$1 AND usuario_id=$2 AND telegram_id=$3 AND confirmado_em IS NULL RETURNING id",
      [p.id, userId, chat],
    );
    await this.html(chat, `✅ ${pendingType(p) === "income" ? "Receita" : "Despesa"} registrada: <b>${esc(p.descricao)}</b> · ${brl(p.valor)}`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ Desfazer", callback_data: "cmd:desfazer" }, { text: "💰 Saldo", callback_data: "cmd:saldo" }]] },
    });
  }
  private async photo(chat: number, userId: number, photo: any) {
    const deadline = Date.now() + 25000;
    let image: Uint8Array | undefined;
    // Aviso imediato: a leitura pela IA leva alguns segundos.
    await this.send(chat, "🔍 Lendo o comprovante, só um instante…").catch(() => {});
    await this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    try {
      if (photo.file_size > 10 * 1024 * 1024)
        throw new Error("Imagem muito grande.");
      const file = await this.api("getFile", { file_id: photo.file_id });
      if (
        !/^photos\/[\w.\/-]+$/.test(file.file_path) ||
        file.file_path.includes("..")
      )
        throw new Error("Imagem inválida.");
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.deps.token}/${file.file_path}`,
        { signal: AbortSignal.timeout(4500) },
      );
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > 10 * 1024 * 1024
      )
        throw new Error("Imagem inválida.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Imagem vazia.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 10 * 1024 * 1024) throw new Error("Imagem muito grande.");
          chunks.push(next.value);
        }
        image = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          image.set(c, offset);
          offset += c.length;
          c.fill(0);
        }
      } finally {
        await reader.cancel().catch(() => {});
        for (const c of chunks) c.fill(0);
      }
      const text = await this.recognize(
        image,
        Math.max(1, deadline - Date.now()),
      );
      image.fill(0);
      image = undefined;
      const receipt = readReceipt(text);
      if (!receipt) {
        await this.send(
          chat,
          "Não consegui identificar o valor nessa foto. 😕\nTente outra foto, com o cupom inteiro, reto e bem iluminado, ou registre com /despesa descrição valor (ex.: /despesa mercado 35,90).",
        );
        return;
      }
      const r = await userDatabase(this.deps.db, userId).query(
        "INSERT INTO ocr_pendencias(telegram_id,usuario_id,descricao,valor,categoria,data_transacao,texto_ocr,expira_em) VALUES($1,$2,$3,$4,$5,$6,NULL,NOW()+INTERVAL '15 minutes') RETURNING *",
        [
          chat,
          userId,
          receipt.description,
          receipt.amount,
          receipt.category,
          receipt.date,
        ],
      );
      await this.showPending(chat, r.rows[0]);
    } catch (error) {
      console.error("Telegram: falha ao ler comprovante", String((error as Error)?.message ?? error));
      await this.send(
        chat,
        "Não consegui ler o comprovante agora. 😕\nTente de novo em instantes ou registre com /despesa descrição valor (ex.: /despesa mercado 35,90).",
      );
    } finally {
      image?.fill(0);
    }
  }
  private async recognize(image: Uint8Array, timeoutMs = 15000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      // No Worker não há tesseract: a leitura da foto vem da função "ocr"
      // (Workers AI), passada ao criar o serviço.
      if (!this.deps.ocr) throw new Error("Leitura de comprovantes indisponível.");
      return this.deps.ocr(image);
    };
    try {
      return await Promise.race([
        run(),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("OCR excedeu o prazo."));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
