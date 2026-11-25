// Endereços curtos das telas (/home, /perfil...) no lugar dos caminhos com
// pasta e .html. O endereço antigo redireciona para o novo, então links
// salvos, favoritos e emails já enviados continuam funcionando.
export const PAGES: Record<string, string> = {
  "/login": "/CashFlow_Tela_de_Login/login.html",
  "/cadastro": "/CashFlow_Tela_de_Cadastro/dadospessoais.html",
  "/cadastro/endereco": "/CashFlow_Tela_de_Cadastro/endereco.html",
  "/cadastro/finalizacao": "/CashFlow_Tela_de_Cadastro/finalizacao.html",
  "/home": "/CashFlow_Tela_HomePage/home.html",
  "/perfil": "/CashFlow_Tela_Perfil/perfil.html",
  "/configuracoes": "/CashFlow_Tela_Config/config.html",
  "/recuperar-senha": "/recuperar-senha.html",
  "/redefinir-senha": "/redefinir-senha.html",
  "/confirmar-email": "/confirmar-email.html",
  "/privacidade": "/privacidade.html",
};
const OLD: Record<string, string> = Object.fromEntries(
  Object.entries(PAGES).map(([clean, file]) => [file, clean]),
);
OLD["/"] = "/login";
OLD["/index.html"] = "/login";

// Caminhos que o Worker atende antes dos arquivos estáticos (wrangler.jsonc).
export const WORKER_FIRST = ["/api/*", ...Object.keys(OLD), ...Object.keys(PAGES)];

export function redirectFor(url: URL) {
  const clean = OLD[url.pathname];
  return clean ? new URL(clean + url.search, url).toString() : undefined;
}
export function assetFor(pathname: string) {
  return PAGES[pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname];
}

// A página foi feita para morar na pasta dela: links relativos como
// "homeStyle.css" ou "../image.png" viram caminhos absolutos daquela pasta.
export function absolutize(value: string | null, file: string) {
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
  const target = new URL(value, "https://cashflow.local" + file);
  const path = OLD[target.pathname] ?? target.pathname;
  return path + target.search + target.hash;
}

declare const HTMLRewriter: any;
export function rewritePage(response: Response, file: string) {
  if (typeof HTMLRewriter === "undefined" || !response.headers.get("content-type")?.includes("text/html"))
    return response;
  const fix = (attr: string) => ({
    element(el: any) {
      const v = el.getAttribute(attr);
      const n = absolutize(v, file);
      if (n !== v && n !== null) el.setAttribute(attr, n);
    },
  });
  return new HTMLRewriter()
    .on("[href]", fix("href"))
    .on("[src]", fix("src"))
    .on("form[action]", fix("action"))
    .transform(response);
}
