import type { App, Req } from "./http.js";
import { randomBytes } from "node:crypto";
import type { Database } from "./db.js";
import { userDatabase } from "./db.js";
import { HttpError, text, email } from "./validation.js";
import {
  requestReset,
  resetPassword,
  deleteAccount,
  changePassword,
  requestOwnReset,
  tokenHash,
} from "./services/accounts.js";
import {
  saveTransaction,
  monthlySummary,
  quickExpense,
  standardCategories,
} from "./services/finance.js";
export interface RequirementsOptions {
  sendReset?: (email: string, token: string) => Promise<void>;
  telegramSecret?: string;
  externalFetch?: typeof fetch;
  // Chamado quando chega mensagem do Telegram (no Worker: processa logo depois).
  onTelegramUpdate?: () => void;
}
export const requestBody = (req: Req): Record<string, any> => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    throw new HttpError(400, "Envie os campos do formulário.");
  return req.body as Record<string, any>;
};
// Cache das taxas do BCB por instância do Worker (sobrevive entre requisições).
const ratesCache = new Map<string, { at: number; data: any }>();
// Cotações de câmbio (reais por 1 unidade da moeda), por 5 minutos.
const fxCache = new Map<string, { at: number; data: any }>();
export const FX_CURRENCIES = ["USD", "EUR", "GBP", "ARS", "CAD", "AUD", "JPY", "CHF", "CNY"];
const brDate = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
// Workers não manda User-Agent por padrão; algumas APIs recusam sem ele.
const FX_HEADERS = { Accept: "application/json", "User-Agent": "CashFlow/1.0 (+https://app.cashflow-pi.workers.dev)" };
export async function fetchExchangeRate(moeda: string, get: typeof fetch = fetch) {
  const errors: string[] = [];
  const tryJson = async (url: string, ms = 6000) => {
    const r = await get(url, { headers: FX_HEADERS, signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  // 1) AwesomeAPI: cotação comercial em tempo real (a mesma referência do Google).
  try {
    const q = (await tryJson(`https://economia.awesomeapi.com.br/json/last/${moeda}-BRL`))?.[`${moeda}BRL`];
    const bid = Number(q?.bid);
    if (!(bid > 0)) throw new Error("sem cotação");
    const ts = Number(q?.timestamp);
    return {
      moeda,
      cotacao: bid,
      fonte: "AwesomeAPI (comercial)",
      atualizado_em: ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
    };
  } catch (e) {
    errors.push(`AwesomeAPI: ${String((e as Error)?.message ?? e)}`);
  }
  // 2) Taxa de mercado (média) atualizada diariamente, servida por CDN.
  const low = moeda.toLowerCase();
  for (const url of [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${low}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${low}.json`,
  ]) {
    try {
      const j = await tryJson(url);
      const v = Number(j?.[low]?.brl);
      if (!(v > 0)) throw new Error("sem cotação");
      return {
        moeda,
        cotacao: v,
        avisos: [...errors],
        fonte: "Mercado (média diária)",
        atualizado_em: j?.date ? new Date(`${j.date}T12:00:00-03:00`).toISOString() : new Date().toISOString(),
      };
    } catch (e) {
      errors.push(`currency-api: ${String((e as Error)?.message ?? e)}`);
    }
  }
  // 3) ExchangeRate-API (sem chave), também taxa de mercado diária.
  try {
    const j = await tryJson(`https://open.er-api.com/v6/latest/${moeda}`);
    const v = Number(j?.rates?.BRL);
    if (j?.result !== "success" || !(v > 0)) throw new Error("sem cotação");
    return {
      moeda,
      avisos: [...errors],
      cotacao: v,
      fonte: "ExchangeRate-API (mercado)",
      atualizado_em: j?.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : new Date().toISOString(),
    };
  } catch (e) {
    errors.push(`ExchangeRate-API: ${String((e as Error)?.message ?? e)}`);
  }
  // 4) Banco Central (PTAX): referência oficial, última de venda dos últimos 10 dias.: última cotação de venda dos últimos 10 dias.
  try {
    const fim = new Date();
    const ini = new Date(fim.getTime() - 10 * 86400000);
    const url =
      "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
      `?@moeda='${moeda}'&@dataInicial='${brDate(ini)}'&@dataFinalCotacao='${brDate(fim)}'&$top=100&$format=json`;
    const r = await get(url, { headers: FX_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = (((await r.json()) as any)?.value ?? []) as any[];
    const last = rows.filter((x) => Number(x?.cotacaoVenda) > 0).sort((a, b) => String(a.dataHoraCotacao).localeCompare(String(b.dataHoraCotacao))).at(-1);
    if (!last) throw new Error("sem cotação");
    return {
      moeda,
      avisos: [...errors],
      cotacao: Number(last.cotacaoVenda),
      fonte: "Banco Central (PTAX)",
      atualizado_em: new Date(String(last.dataHoraCotacao).replace(" ", "T") + "-03:00").toISOString(),
    };
  } catch (e) {
    errors.push(`BCB PTAX: ${String((e as Error)?.message ?? e)}`);
  }
  throw new Error(errors.join(" | "));
}
export async function requirementsRoutes(
  app: App,
  db: Database,
  options: RequirementsOptions,
) {
  app.get("/api/cambio", async (req, reply) => {
    const moeda = String((req.query as any)?.moeda ?? "").toUpperCase();
    if (!FX_CURRENCIES.includes(moeda)) throw new HttpError(400, "Moeda não suportada.");
    const hit = fxCache.get(moeda);
    if (hit && Date.now() - hit.at < 5 * 60000) return { status: "success", ...hit.data };
    try {
      const data = await fetchExchangeRate(moeda, options.externalFetch ?? fetch);
      fxCache.set(moeda, { at: Date.now(), data });
      return { status: "success", ...data };
    } catch (error) {
      req.log.warn("Cotação indisponível", String((error as Error)?.message ?? error));
      // Cotação antiga (até 12 h) ainda serve, avisando que pode estar defasada.
      if (hit && Date.now() - hit.at < 12 * 3600000) return { status: "success", ...hit.data, desatualizado: true };
      reply.code(503);
      return { status: "error", message: "Não foi possível buscar a cotação agora. Informe a cotação manualmente." };
    }
  });
  app.get("/api/mercado/taxas", async (req, reply) => {
    const now = new Date();
    now.setUTCDate(1);
    now.setUTCMonth(now.getUTCMonth() - 1);
    const month = (req.query as any)?.mes || now.toISOString().slice(0, 7);
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new HttpError(400, "Informe o mês no formato AAAA-MM.");
    const cached = ratesCache.get(month);
    if (cached && Date.now() - cached.at < 30 * 60000) return cached.data;
    // API Olinda (OData). O recurso é TaxasJurosMensalPorMes, com os campos
    // Mes, Modalidade, Posicao, InstituicaoFinanceira, TaxaJurosAoMes,
    // TaxaJurosAoAno, cnpj8 e anoMes. Os "$" precisam ir sem codificação.
    const base =
      "https://olinda.bcb.gov.br/olinda/servico/taxaJuros/versao/v2/odata/TaxasJurosMensalPorMes";
    const olinda = async (params: Record<string, string>) => {
      const query = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      const response = await (options.externalFetch ?? fetch)(
        `${base}?${query}&$format=json`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok) throw new Error(`Olinda HTTP ${response.status}`);
      const data = (await response.json()) as any;
      if (!Array.isArray(data?.value)) throw new Error("Olinda sem dados");
      return data.value as any[];
    };
    const byMonth = (anoMes: string) =>
      olinda({ $filter: `anoMes eq '${anoMes}'`, $top: "5000" });
    try {
      let used = month;
      let rows = await byMonth(month);
      if (!rows.length) {
        // O BCB publica com atraso: usa o mês mais recente disponível.
        const latest = await olinda({
          $orderby: "anoMes desc",
          $top: "1",
          $select: "anoMes",
        });
        const last = latest[0]?.anoMes;
        if (last && last !== month) {
          used = String(last);
          rows = await byMonth(used);
        }
      }
      const data = {
        value: rows,
        mes_solicitado: month,
        mes: used,
        atualizado_em: new Date().toISOString(),
      };
      if (ratesCache.size >= 12)
        ratesCache.delete(ratesCache.keys().next().value!);
      ratesCache.set(month, { at: Date.now(), data });
      return data;
    } catch (error) {
      req.log.warn("Consulta Olinda falhou", String(error));
      if (cached) return { ...cached.data, desatualizado: true };
      reply.code(503);
      return {
        status: "error",
        message:
          "O Banco Central não respondeu agora. Tente novamente em alguns minutos. As outras funções continuam disponíveis.",
      };
    }
  });
  const limited = {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.post("/api/senha/recuperar", limited, async (req) =>
    requestReset(db, requestBody(req).email, options.sendReset),
  );
  app.post("/api/senha/redefinir", limited, async (req) =>
    resetPassword(db, requestBody(req)),
  );
  app.post("/api/senha/alterar", limited, async (req) =>
    changePassword(db, req.userId!, requestBody(req), req.cookies.cashflow_session ?? ""),
  );
  app.post("/api/senha/link", limited, async (req) =>
    requestOwnReset(db, req.userId!, options.sendReset),
  );
  app.post("/api/session/atividade", async (req) => {
    await db.query(
      "UPDATE sessoes SET ultima_atividade=NOW() WHERE token_hash=$1",
      [tokenHash(req.cookies.cashflow_session ?? "")],
    );
    return { status: "success" };
  });
  app.get("/api/resumo", async (req) => ({
    status: "success",
    ...(await monthlySummary(db, req.userId!, (req.query as any)?.mes)),
  }));
  app.get("/api/categorias", async (req) => ({
    status: "success",
    categories: (
      await userDatabase(db, req.userId!).query(
        // "uso": quantas transações usam a categoria (mostrado antes de excluir).
        `SELECT c.id,c.nome,c.tipo,
           (SELECT count(*)::int FROM transacoes t
             WHERE t.usuario_id=c.usuario_id AND lower(t.categoria)=lower(c.nome) AND t.tipo=c.tipo) AS uso
         FROM categorias c WHERE c.usuario_id=$1 ORDER BY c.nome`,
        [req.userId],
      )
    ).rows,
  }));
  // Exclui uma categoria criada pela pessoa. As transações que usavam a categoria
  // passam para "Outros" do mesmo tipo, para nenhum lançamento ficar sem categoria.
  app.post("/api/categorias/excluir", async (req) => {
    const categoriaId = Number(requestBody(req).id);
    if (!Number.isSafeInteger(categoriaId) || categoriaId <= 0)
      throw new HttpError(400, "Categoria inválida.");
    return userDatabase(db, req.userId!).transaction(async (tx) => {
      const r = await tx.query(
        "DELETE FROM categorias WHERE id=$1 AND usuario_id=$2 RETURNING nome,tipo",
        [categoriaId, req.userId],
      );
      if (!r.rows.length) throw new HttpError(404, "Categoria não encontrada.");
      const { nome, tipo } = r.rows[0];
      const destino = tipo === "income" ? "outros-receitas" : "outros-despesas";
      const movidas = await tx.query(
        "UPDATE transacoes SET categoria=$1 WHERE usuario_id=$2 AND lower(categoria)=lower($3) AND tipo=$4",
        [destino, req.userId, nome, tipo],
      );
      return {
        status: "success",
        nome,
        tipo,
        movidas: movidas.rowCount ?? 0,
        message:
          movidas.rowCount
            ? `Categoria "${nome}" excluída. ${movidas.rowCount === 1 ? "1 transação foi" : `${movidas.rowCount} transações foram`} para "Outros".`
            : `Categoria "${nome}" excluída.`,
      };
    });
  });
  app.post("/api/categorias", async (req) => {
    const b = requestBody(req),
      nome = text(b.nome, "nome da categoria", 100);
    if (!["income", "expense"].includes(b.tipo))
      throw new HttpError(
        400,
        "Selecione receita ou despesa para a categoria.",
      );
    if (standardCategories[nome])
      throw new HttpError(409, "Essa categoria já é predefinida.");
    const r = await userDatabase(db, req.userId!).query(
      "INSERT INTO categorias(usuario_id,nome,tipo) VALUES($1,$2,$3) RETURNING id,nome,tipo",
      [req.userId, nome, b.tipo],
    );
    return { status: "success", ...r.rows[0] };
  });
  app.post("/api/transacoes/editar", async (req) =>
    saveTransaction(
      db,
      req.userId!,
      {
        ...requestBody(req),
        idempotency_key:
          requestBody(req).idempotency_key ?? req.headers["idempotency-key"],
      },
      true,
    ),
  );
  app.post("/api/transacoes/rapida", async (req) =>
    saveTransaction(
      db,
      req.userId!,
      quickExpense({
        ...requestBody(req),
        idempotency_key:
          requestBody(req).idempotency_key ?? req.headers["idempotency-key"],
      }),
    ),
  );
  app.post("/api/consentimento", async (req) => {
    if (![true, "true", "on", "1"].includes(requestBody(req).aceito))
      throw new HttpError(400, "Confirme que leu o aviso de privacidade.");
    await userDatabase(db, req.userId!).query(
      "UPDATE usuarios SET consentimento_em=NOW(),consentimento_versao='2026-11-v1' WHERE id=$1",
      [req.userId],
    );
    return { status: "success" };
  });
  app.post("/api/conta/excluir", async (req, reply) => {
    const result = await deleteAccount(db, req.userId!, requestBody(req));
    reply.clearCookie("cashflow_session", { path: "/" });
    return result;
  });
  app.post("/api/telegram", async (req) => {
    const b = requestBody(req),
      uid = req.userId!,
      scoped = userDatabase(db, uid);
    const row = (
      await scoped.query(
        "SELECT nome_telegram,expira_em,usado_em,telegram_id FROM telegram_vinculos WHERE usuario_id=$1",
        [uid],
      )
    ).rows[0];
    if ((b.acao ?? "verificar") === "verificar")
      return {
        status: "success",
        codigo: null,
        nome_telegram: row?.nome_telegram ?? null,
        tem_codigo:
          !!row?.expira_em &&
          !row?.usado_em &&
          new Date(row.expira_em) > new Date(),
        vinculado: !!row?.telegram_id,
        expires_at: row?.expira_em ?? null,
        gerado_agora: false,
        message:
          "Por segurança, o token só é exibido ao gerar. Gere outro se necessário.",
      };
    if (b.acao === "desvincular") {
      await scoped.query("DELETE FROM telegram_vinculos WHERE usuario_id=$1", [uid]);
      return { status: "success", message: "Telegram desconectado." };
    }
    if (b.acao !== "gerar") throw new HttpError(400, "Ação inválida.");
    const username = text(b.nome_telegram, "username Telegram", 33)
      .replace(/^@/, "")
      .toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(username))
      throw new HttpError(
        400,
        "Informe seu username Telegram, com 5 a 32 letras, números ou _.",
      );
    const token = randomBytes(24).toString("hex");
    const r = await scoped.query(
      "INSERT INTO telegram_vinculos(usuario_id,nome_telegram,codigo_vinculo,token_hash,expira_em,usado_em,criado_em) VALUES($1,$2,NULL,$3,NOW()+INTERVAL '10 minutes',NULL,NOW()) ON CONFLICT(usuario_id) DO UPDATE SET nome_telegram=EXCLUDED.nome_telegram,codigo_vinculo=NULL,token_hash=EXCLUDED.token_hash,expira_em=EXCLUDED.expira_em,usado_em=NULL,criado_em=NOW() RETURNING expira_em",
      [uid, username, tokenHash(token)],
    );
    return {
      status: "success",
      codigo: token,
      nome_telegram: username,
      tem_codigo: true,
      expires_at: r.rows[0].expira_em,
      gerado_agora: true,
      message:
        "Envie /vincular seguido deste código no chat privado do bot em até 10 minutos. Ele só pode ser usado uma vez.",
    };
  });
  app.post(
    "/api/telegram/webhook",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (
        !options.telegramSecret ||
        req.headers["x-telegram-bot-api-secret-token"] !==
          options.telegramSecret
      )
        throw new HttpError(403, "Webhook não autorizado.");
      const update = requestBody(req);
      if (!Number.isSafeInteger(update.update_id))
        throw new HttpError(400, "Atualização inválida.");
      await db.query(
        "INSERT INTO telegram_updates(update_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [update.update_id, JSON.stringify(update)],
      );
      options.onTelegramUpdate?.();
      reply.code(200);
      return { ok: true };
    },
  );
}
