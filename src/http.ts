// Roteador mínimo no lugar do Fastify (que não roda em Workers).
// Imita só o que o CashFlow usa: app.get/post, hooks, tratador de erro,
// req.body/cookies/query/headers e reply.code/header/setCookie/redirect.
// Funciona com Request/Response padrão: roda no Worker e no Node (testes).

export interface Logger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}
export interface Req {
  method: string;
  url: string; // caminho + query, como no Fastify
  path: string;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  query: Record<string, string>;
  body: any;
  protocol: "http" | "https";
  host: string;
  ip: string;
  userId: number | null;
  log: Logger;
}
type CookieOptions = {
  path?: string;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  maxAge?: number;
};
export interface Reply {
  statusCode: number;
  code(status: number): Reply;
  header(name: string, value: string): Reply;
  setCookie(name: string, value: string, options?: CookieOptions): Reply;
  clearCookie(name: string, options?: CookieOptions): Reply;
  redirect(location: string, status?: number): Reply;
  send(payload: unknown): Reply;
}
type Handler = (req: Req, reply: Reply) => unknown | Promise<unknown>;
type Hook = (req: Req, reply: Reply) => Promise<void> | void;
type RouteOptions = { config?: { rateLimit?: { max: number; timeWindow: string } } };
type ErrorHandler = (err: any, req: Req, reply: Reply) => unknown;

const consoleLog: Logger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

// Limite de requisições por IP. Fica na memória de cada instância do Worker:
// segura rajadas (força bruta no login), sem precisar de banco extra.
const hits = new Map<string, { count: number; reset: number }>();
const windowMs = (s: string) => {
  const m = s.match(/^(\d+)\s*(second|minute|hour)s?$/);
  if (!m) return 60000;
  return Number(m[1]) * ({ second: 1000, minute: 60000, hour: 3600000 } as any)[m[2]];
};
function limited(key: string, max: number, window: string) {
  const now = Date.now();
  if (hits.size > 5000)
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  const entry = hits.get(key);
  if (!entry || entry.reset <= now) {
    hits.set(key, { count: 1, reset: now + windowMs(window) });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

class HttpFail extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const parseCookies = (raw: string | null) => {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
};
const cookieString = (name: string, value: string, o: CookieOptions = {}) =>
  [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${o.path ?? "/"}`,
    o.httpOnly ? "HttpOnly" : "",
    o.sameSite ? `SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}` : "",
    o.secure ? "Secure" : "",
    o.maxAge !== undefined ? `Max-Age=${Math.floor(o.maxAge)}` : "",
    o.maxAge === 0 ? "Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "",
  ]
    .filter(Boolean)
    .join("; ");

const BODY_LIMIT = 64 * 1024;
async function readBody(request: Request) {
  if (["GET", "HEAD"].includes(request.method)) return undefined;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > BODY_LIMIT) throw new HttpFail(413, "Envio grande demais.");
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const out: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of form) {
      if (typeof v !== "string") continue; // arquivos não são aceitos
      if (++n > 40 || v.length > 4096) throw new HttpFail(413, "Formulário grande demais.");
      out[k] = v;
    }
    return out;
  }
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new HttpFail(413, "Envio grande demais.");
  if (!text) return undefined;
  if (type.includes("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(text));
  if (type.includes("application/json") || type.includes("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpFail(400, "Os dados enviados não estão em JSON válido.");
    }
  }
  throw new HttpFail(415, "Formato de envio não suportado.");
}

export function createApp(options: { logger?: Logger } = {}) {
  const log = options.logger ?? consoleLog;
  const routes = new Map<string, { handler: Handler; limit?: { max: number; timeWindow: string } }>();
  const hooks: Record<"onRequest" | "preHandler", Hook[]> = { onRequest: [], preHandler: [] };
  let errorHandler: ErrorHandler | undefined;
  let notFound: Handler = (_req, reply) =>
    reply.code(404).send({ status: "error", message: "Página ou rota não encontrada." });
  let globalLimit = { max: 300, timeWindow: "1 minute" };

  const add = (method: string) =>
    (path: string, a: RouteOptions | Handler, b?: Handler) => {
      const handler = (typeof a === "function" ? a : b)!;
      const limit = typeof a === "function" ? undefined : a.config?.rateLimit;
      routes.set(`${method} ${path}`, { handler, limit });
    };

  const app = {
    log,
    get: add("GET"),
    post: add("POST"),
    addHook(name: "onRequest" | "preHandler", hook: Hook) {
      hooks[name].push(hook);
    },
    setErrorHandler(fn: ErrorHandler) {
      errorHandler = fn;
    },
    setNotFoundHandler(fn: Handler) {
      notFound = fn;
    },
    setGlobalRateLimit(max: number, timeWindow: string) {
      globalLimit = { max, timeWindow };
    },
    decorateRequest() {},
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const status = { code: 200 };
      const headers = new Headers();
      let payload: unknown;
      let sent = false;
      let redirectTo: string | undefined;
      const reply: Reply = {
        get statusCode() {
          return status.code;
        },
        code(c) {
          status.code = c;
          return reply;
        },
        header(k, v) {
          headers.set(k, v);
          return reply;
        },
        setCookie(n, v, o) {
          headers.append("Set-Cookie", cookieString(n, v, o));
          return reply;
        },
        clearCookie(n, o) {
          headers.append("Set-Cookie", cookieString(n, "", { ...o, maxAge: 0 }));
          return reply;
        },
        redirect(location, c = 302) {
          status.code = c;
          redirectTo = location;
          sent = true;
          return reply;
        },
        send(p) {
          payload = p;
          sent = true;
          return reply;
        },
      };
      const rawHeaders: Record<string, string> = {};
      request.headers.forEach((v, k) => (rawHeaders[k.toLowerCase()] = v));
      const req: Req = {
        method: request.method,
        url: url.pathname + url.search,
        path: url.pathname,
        headers: rawHeaders,
        cookies: parseCookies(request.headers.get("cookie")),
        query: Object.fromEntries(url.searchParams),
        body: undefined,
        protocol: url.protocol === "https:" ? "https" : "http",
        host: url.host,
        ip: rawHeaders["cf-connecting-ip"] ?? rawHeaders["x-forwarded-for"]?.split(",")[0]?.trim() ?? "local",
        userId: null,
        log,
      };
      const route = routes.get(`${request.method === "HEAD" ? "GET" : request.method} ${url.pathname}`);
      try {
        for (const hook of hooks.onRequest) await hook(req, reply);
        if (!route) {
          await notFound(req, reply);
        } else {
          if (limited(`*|${req.ip}`, globalLimit.max, globalLimit.timeWindow) ||
              (route.limit && limited(`${url.pathname}|${req.ip}`, route.limit.max, route.limit.timeWindow)))
            throw new HttpFail(429, "Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.");
          req.body = await readBody(request);
          for (const hook of hooks.preHandler) await hook(req, reply);
          const result = await route.handler(req, reply);
          if (!sent) payload = result;
        }
      } catch (err) {
        if (!errorHandler) {
          log.error(err);
          status.code = (err as any)?.statusCode ?? 500;
          payload = { status: "error", message: "Erro interno." };
        } else {
          sent = false;
          const r = await errorHandler(err, req, reply);
          if (!sent && r !== undefined) payload = r;
        }
      }
      if (redirectTo) {
        headers.set("Location", redirectTo);
        return new Response(null, { status: status.code, headers });
      }
      if (payload === undefined || payload === null || request.method === "HEAD")
        return new Response(null, { status: status.code === 200 && payload == null ? 204 : status.code, headers });
      if (typeof payload === "string") {
        if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
        return new Response(payload, { status: status.code, headers });
      }
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(payload), { status: status.code, headers });
    },
  };
  return app;
}
export type App = ReturnType<typeof createApp>;
