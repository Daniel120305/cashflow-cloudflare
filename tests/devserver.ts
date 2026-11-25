// Servidor local que imita o Worker: arquivos de public/ + /api via handleApi.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handleApi, type Env } from "../src/worker.js";
import { wrapPool } from "../src/db.js";
import { miniPool } from "./pgmini.js";
import { redirectFor, assetFor, absolutize } from "../src/pages.js";
process.env.NODE_ENV = "development";
process.env.APP_ORIGIN = "http://localhost:8787";
process.env.EMAIL_TOKEN_SECRET = "dev";
const env = { NODE_ENV: "development", APP_ORIGIN: "http://localhost:8787", EMAIL_TOKEN_SECRET: "dev", TELEGRAM_BOT_USERNAME: "CashFlowPIBot" } as unknown as Env;
const db = wrapPool(miniPool() as any);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost:8787");
  // Igual ao Worker: endereço antigo redireciona; endereço curto serve a página
  // com os links relativos corrigidos (no Worker isso é o HTMLRewriter).
  const moved = redirectFor(url);
  if (moved) { res.writeHead(301, { location: moved }); return res.end(); }
  const page = assetFor(url.pathname);
  if (page) {
    const html = (await readFile(join("public", page), "utf8")).replace(/\b(href|src|action)="([^"]*)"/g, (_m, a, v) => `${a}="${absolutize(v, page)}"`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html);
  }
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const { response, background } = await handleApi(request, env, { waitUntil() {} }, db);
    await Promise.allSettled(background);
    const out: Record<string, any> = {}; response.headers.forEach((v, k) => (out[k] = v));
    const cookies = response.headers.getSetCookie(); if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out); return res.end(Buffer.from(await response.arrayBuffer()));
  }
  try {
    const file = join("public", normalize(url.pathname));
    const data = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("404"); }
}).listen(8787, () => console.log("pronto em http://localhost:8787"));
