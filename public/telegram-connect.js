// Conexão com o Telegram: card na Home, item no menu do usuário e seção no
// Perfil abrem o mesmo assistente em 3 passos. Depois de abrir o bot, a tela
// confere sozinha (a cada 3 s) se a conta foi vinculada.
//
// Uso no HTML:
//   <div data-telegram-card></div>       card de convite (some se já conectado)
//   <a data-telegram-open>...</a>         qualquer elemento que abre o assistente
//   <span data-telegram-status></span>    "Conectado" / "Conectar"
//   <button data-telegram-label>          texto do botão conforme o status
(function () {
  if (window.CashFlowTelegram) return;
  const DISMISS_KEY = "cashflowTelegramDispensado";
  const PLANE =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="M21.94 4.3 18.7 19.6c-.24 1.07-.88 1.34-1.78.83l-4.93-3.63-2.38 2.29c-.26.26-.48.48-.99.48l.35-5.02 9.14-8.26c.4-.35-.09-.55-.62-.2L6.2 13.2l-4.86-1.52c-1.06-.33-1.08-1.06.22-1.57L20.55 2.8c.88-.32 1.65.21 1.39 1.5Z"/></svg>';
  // Logo oficial do Telegram (círculo azul com o avião), em SVG: nítida em qualquer tamanho.
  const LOGO = '<svg class="tg-logo-svg" viewBox="0 0 240 240" aria-hidden="true" focusable="false"><circle cx="120" cy="120" r="120" fill="#229ED9"/><path fill="#fff" d="M54.3 118.8c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.3-16.3 44.8-16.4 1 0 3.2.2 4.7 1.4 1.2 1 1.5 2.3 1.7 3.3.2 1 .4 3.1.2 4.7-1.8 19-9.6 65.1-13.6 86.3-1.7 9-5 12-8.2 12.3-7 .6-12.3-4.6-19-9-10.6-6.9-16.5-11.2-26.8-18-11.9-7.8-4.2-12.1 2.6-19.1 1.8-1.8 32.5-29.8 33.1-32.3.1-.3.1-1.5-.6-2.1-.7-.6-1.7-.4-2.5-.2-1.1.2-17.8 11.3-50.3 33.3-4.8 3.3-9.1 4.9-13 4.8-4.3-.1-12.5-2.4-18.7-4.4-7.5-2.4-13.5-3.7-13-7.9.3-2.2 3.3-4.4 8.9-6.7z"/></svg>';
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const css = `
  .tgc-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10000;animation:tgcFade .15s ease}
  .tgc-modal{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#0f172a;border-radius:20px;box-shadow:0 24px 60px rgba(15,23,42,.35);padding:26px 22px 20px;font-family:inherit;animation:tgcUp .2s ease}
  .tgc-close{position:absolute;top:10px;right:12px;width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:#64748b;font-size:24px;cursor:pointer}
  .tgc-close:hover{background:#f1f5f9}
  .tgc-head{display:flex;gap:14px;align-items:center;margin-bottom:16px}
  .tgc-logo{flex:none;width:52px;height:52px;display:block;line-height:0}
  .tgc-logo .tg-logo-svg{width:100%;height:100%;display:block}
  .tg-logo-svg{display:block}
  .tg-logo-inline{display:inline-flex;align-items:center;gap:8px}
  .tg-logo-inline .tg-logo-svg{width:1.15em;height:1.15em;flex:none}
  .tgc-head h2{margin:0;font-size:1.25rem;line-height:1.2}
  .tgc-head p{margin:4px 0 0;color:#64748b;font-size:.9rem}
  .tgc-benefits{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:10px}
  .tgc-benefits li{display:flex;gap:10px;align-items:flex-start;background:#f8fafc;border-radius:12px;padding:10px 12px;font-size:.92rem;line-height:1.35}
  .tgc-benefits b{display:block}
  .tgc-benefits code{background:#e0f2fe;color:#0369a1;border-radius:6px;padding:1px 6px;font-size:.85em}
  .tgc-benefits .ico{font-size:1.3rem;line-height:1}
  .tgc-steps{display:flex;gap:6px;margin:0 0 16px}
  .tgc-steps span{flex:1;height:5px;border-radius:5px;background:#e2e8f0}
  .tgc-steps span.on{background:#229ed9}
  .tgc-label{display:block;font-weight:700;font-size:.92rem;margin:0 0 6px}
  .tgc-input{display:flex;align-items:center;border:1.5px solid #cbd5e1;border-radius:12px;padding:0 12px;background:#fff}
  .tgc-input:focus-within{border-color:#229ed9;box-shadow:0 0 0 3px rgba(34,158,217,.18)}
  .tgc-input span{color:#64748b;font-weight:700}
  .tgc-input input{flex:1;min-width:0;border:0;outline:0;padding:12px 6px;font-size:1rem;background:transparent;color:inherit}
  .tgc-hint{display:block;color:#64748b;font-size:.8rem;margin-top:6px;line-height:1.4}
  .tgc-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;margin-top:14px;border:0;border-radius:12px;background:#229ed9;color:#fff;font-weight:800;font-size:1rem;text-decoration:none;cursor:pointer;box-sizing:border-box;padding:10px 16px;text-align:center}
  .tgc-btn:hover{background:#1b8cc2}
  .tgc-btn:disabled{opacity:.55;cursor:not-allowed}
  .tgc-btn.sec{background:#fff;color:#0369a1;border:1.5px solid #bae6fd}
  .tgc-btn.sec:hover{background:#f0f9ff}
  .tgc-btn.link{background:transparent;color:#64748b;min-height:40px;font-weight:600;margin-top:6px}
  .tgc-msg{min-height:1.2em;margin:10px 0 0;font-size:.88rem;color:#64748b;text-align:center}
  .tgc-msg[data-type=error]{color:#dc2626}
  .tgc-wait{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:16px;padding:12px;border-radius:12px;background:#f0f9ff;color:#0369a1;font-weight:600;font-size:.92rem}
  .tgc-spin{width:18px;height:18px;border:3px solid #bae6fd;border-top-color:#229ed9;border-radius:50%;animation:tgcSpin .8s linear infinite}
  .tgc-alt{margin-top:14px;font-size:.88rem;color:#475569}
  .tgc-alt summary{cursor:pointer;font-weight:600;color:#0369a1}
  .tgc-alt code{display:block;margin:8px 0;padding:10px;border-radius:10px;background:#f1f5f9;word-break:break-all;font-size:.85rem;user-select:all}
  .tgc-ok{text-align:center;padding:6px 0}
  .tgc-check{width:76px;height:76px;margin:4px auto 12px;border-radius:50%;background:#dcfce7;color:#16a34a;display:flex;align-items:center;justify-content:center;font-size:42px;animation:tgcPop .35s ease}
  .tgc-ok h3{margin:0 0 6px;font-size:1.3rem}
  .tgc-ok p{margin:0;color:#475569;line-height:1.45}
  .tgc-ok code{background:#e0f2fe;color:#0369a1;border-radius:6px;padding:1px 6px}
  .tgc-card{display:flex;gap:16px;align-items:center;margin:0 0 20px;padding:18px 20px;border-radius:18px;background:linear-gradient(135deg,#e0f2fe,#f0f9ff 60%);border:1px solid #bae6fd;color:#0f172a}
  .tgc-card .tgc-logo{width:54px;height:54px}
  .tgc-card-txt{flex:1;min-width:0}
  .tgc-card-txt b{display:block;font-size:1.05rem;margin-bottom:2px}
  .tgc-card-txt span{color:#475569;font-size:.92rem;line-height:1.4}
  .tgc-card-txt code{background:#bae6fd;color:#075985;border-radius:6px;padding:1px 6px;font-size:.88em;white-space:nowrap}
  .tgc-card-act{display:flex;gap:8px;flex:none;align-items:center}
  .tgc-card-act .tgc-btn{width:auto;margin:0;min-height:44px;padding:8px 18px;white-space:nowrap}
  .tgc-card-act .tgc-btn.link{margin:0;padding:8px 10px}
  .tgc-chip{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;font-size:.75rem;font-weight:700;background:#e2e8f0;color:#475569;vertical-align:middle}
  .tgc-chip.on{background:#dcfce7;color:#15803d}
  .tgc-chip.off{background:#e0f2fe;color:#0369a1}
  @media (max-width:640px){.tgc-card{flex-wrap:wrap;padding:16px}.tgc-card-act{width:100%}.tgc-card-act .tgc-btn:not(.link){flex:1}}
  @keyframes tgcFade{from{opacity:0}}@keyframes tgcUp{from{transform:translateY(12px);opacity:0}}
  @keyframes tgcSpin{to{transform:rotate(360deg)}}@keyframes tgcPop{0%{transform:scale(.4)}80%{transform:scale(1.08)}}
  body.theme-dark .tgc-modal{background:#0f172a;color:#e2e8f0;box-shadow:0 24px 60px rgba(0,0,0,.6)}
  body.theme-dark .tgc-close:hover{background:#1e293b}
  body.theme-dark .tgc-head p,body.theme-dark .tgc-hint,body.theme-dark .tgc-msg,body.theme-dark .tgc-ok p,body.theme-dark .tgc-alt{color:#94a3b8}
  body.theme-dark .tgc-benefits li{background:#1e293b}
  body.theme-dark .tgc-benefits code,body.theme-dark .tgc-ok code{background:#0c4a6e;color:#bae6fd}
  body.theme-dark .tgc-steps span{background:#334155}
  body.theme-dark .tgc-steps span.on{background:#38bdf8}
  body.theme-dark .tgc-input{background:#1e293b;border-color:#475569}
  body.theme-dark .tgc-btn.sec{background:transparent;color:#7dd3fc;border-color:#0c4a6e}
  body.theme-dark .tgc-wait{background:#0c4a6e;color:#e0f2fe}
  body.theme-dark .tgc-alt summary{color:#7dd3fc}
  body.theme-dark .tgc-alt code{background:#1e293b;color:#e2e8f0}
  body.theme-dark .tgc-check{background:#14532d;color:#86efac}
  body.theme-dark .tgc-card{background:linear-gradient(135deg,#0c4a6e,#0f172a 70%);border-color:#075985;color:#e2e8f0}
  body.theme-dark .tgc-card-txt span{color:#cbd5e1}
  body.theme-dark .tgc-card-txt code{background:#075985;color:#e0f2fe}
  body.theme-dark .tgc-chip{background:#334155;color:#cbd5e1}
  body.theme-dark .tgc-chip.on{background:#14532d;color:#86efac}
  body.theme-dark .tgc-chip.off{background:#0c4a6e;color:#bae6fd}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  let bot = null;
  let state = null; // resposta de /api/telegram (verificar)
  const listeners = new Set();

  async function post(body) {
    const res = await fetch("/api/telegram", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return res.json();
  }
  async function refresh() {
    try {
      const [cfg, st] = await Promise.all([
        bot ? Promise.resolve({ telegramBot: bot }) : fetch("/api/config/publica").then((r) => r.json()),
        post({ acao: "verificar" }),
      ]);
      bot = cfg.telegramBot || bot;
      if (st && st.status === "success") state = st;
    } catch {}
    listeners.forEach((fn) => fn(state));
    return state;
  }
  const linked = () => Boolean(state && state.vinculado);
  const botLink = (start) => (bot ? `https://t.me/${encodeURIComponent(bot)}${start ? `?start=${encodeURIComponent(start)}` : ""}` : null);

  // ---------- Assistente (modal) ----------
  let modal = null;
  let poll = null;
  function close() {
    clearInterval(poll);
    poll = null;
    modal?.remove();
    modal = null;
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    refresh();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  function shell(inner, step) {
    const steps = step ? `<div class="tgc-steps" aria-hidden="true">${[1, 2, 3].map((n) => `<span class="${n <= step ? "on" : ""}"></span>`).join("")}</div>` : "";
    modal.querySelector(".tgc-body").innerHTML = steps + inner;
  }
  function showIntro() {
    shell(
      `<ul class="tgc-benefits">
        <li><span class="ico">✍️</span><div><b>Registre em segundos</b><code>/despesa mercado 35,90</code> ou <code>/receita salário 3000</code></div></li>
        <li><span class="ico">📷</span><div><b>Foto do cupom fiscal</b>Eu leio o valor e você só confirma.</div></li>
        <li><span class="ico">🔔</span><div><b>Alertas de limite</b>Aviso quando você chegar a 80% do gasto máximo.</div></li>
        <li><span class="ico">📊</span><div><b>Consultas rápidas</b><code>/saldo</code>, <code>/mes</code>, <code>/extrato</code>, <code>/categorias</code> e <code>/limite</code></div></li>
      </ul>
      <label class="tgc-label" for="tgcUser">Seu nome de usuário no Telegram</label>
      <div class="tgc-input"><span>@</span><input id="tgcUser" type="text" placeholder="seuusuario" maxlength="33" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(state?.nome_telegram || "")}"></div>
      <small class="tgc-hint">No Telegram: <b>Configurações → Nome de usuário</b>. Se não tiver, crie um lá (5 a 32 letras, números ou _).</small>
      <button class="tgc-btn" id="tgcGen" type="button">${PLANE} Conectar meu Telegram</button>
      <p class="tgc-msg" id="tgcMsg" role="status"></p>`,
      1,
    );
    const input = modal.querySelector("#tgcUser");
    const btn = modal.querySelector("#tgcGen");
    const msg = modal.querySelector("#tgcMsg");
    const ok = () => /^[a-z0-9_]{5,32}$/i.test(input.value.trim().replace(/^@/, ""));
    const sync = () => (btn.disabled = !ok());
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => e.key === "Enter" && !btn.disabled && btn.click());
    sync();
    setTimeout(() => input.focus(), 60);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="tgc-spin"></span> Gerando...';
      msg.textContent = "";
      try {
        const data = await post({ acao: "gerar", nome_telegram: input.value.trim().replace(/^@/, "") });
        if (data.status === "success" && data.codigo) return showLink(data);
        msg.dataset.type = "error";
        msg.textContent = data.message || "Não foi possível gerar o link. Tente de novo.";
      } catch {
        msg.dataset.type = "error";
        msg.textContent = "Sem conexão com o servidor. Tente de novo.";
      }
      btn.innerHTML = `${PLANE} Conectar meu Telegram`;
      sync();
    });
  }
  function showLink(data) {
    const link = botLink(data.codigo);
    const hora = data.expires_at ? new Date(data.expires_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
    shell(
      `<p style="margin:0 0 4px;font-weight:700">Quase lá! Abra o bot e toque em <b>Iniciar</b>.</p>
      <p class="tgc-hint" style="margin:0">O link vale ${hora ? `até ${hora}` : "por 10 minutos"} e só funciona para @${esc(data.nome_telegram)}.</p>
      ${link ? `<a class="tgc-btn" id="tgcOpen" href="${link}" target="_blank" rel="noopener">${PLANE} Abrir no Telegram</a>` : ""}
      ${link ? `<button class="tgc-btn sec" id="tgcCopyLink" type="button">📋 Copiar link (para abrir no celular)</button>` : ""}
      <div class="tgc-wait" id="tgcWait"><span class="tgc-spin"></span> Aguardando você tocar em Iniciar no bot…</div>
      <details class="tgc-alt"${link ? "" : " open"}>
        <summary>O botão não abriu?</summary>
        Abra o bot${bot ? ` <b>@${esc(bot)}</b>` : ""} no Telegram e envie esta mensagem:
        <code id="tgcCmd">/vincular ${esc(data.codigo)}</code>
        <button class="tgc-btn sec" id="tgcCopyCmd" type="button" style="margin-top:4px">📋 Copiar mensagem</button>
      </details>
      <button class="tgc-btn link" id="tgcBack" type="button">← Trocar o nome de usuário</button>`,
      2,
    );
    const copy = async (text, btn, label) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const a = document.createElement("textarea");
        a.value = text;
        document.body.appendChild(a);
        a.select();
        document.execCommand("copy");
        a.remove();
      }
      btn.textContent = "✓ Copiado";
      setTimeout(() => (btn.textContent = label), 2000);
    };
    modal.querySelector("#tgcCopyLink")?.addEventListener("click", (e) => copy(link, e.currentTarget, "📋 Copiar link (para abrir no celular)"));
    modal.querySelector("#tgcCopyCmd").addEventListener("click", (e) => copy(`/vincular ${data.codigo}`, e.currentTarget, "📋 Copiar mensagem"));
    modal.querySelector("#tgcBack").addEventListener("click", () => {
      clearInterval(poll);
      showIntro();
    });
    // Confere a cada 3 s se o bot já vinculou (até o código expirar).
    const until = data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 600000;
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!modal) return clearInterval(poll);
      if (Date.now() > until) {
        clearInterval(poll);
        const w = modal.querySelector("#tgcWait");
        if (w) w.innerHTML = "⏱ O link expirou. Volte e gere outro.";
        return;
      }
      const st = await refresh();
      if (st?.vinculado) {
        clearInterval(poll);
        showDone(true);
      }
    }, 3000);
  }
  function showDone(fresh) {
    const link = botLink();
    shell(
      `<div class="tgc-ok">
        <div class="tgc-check">✓</div>
        <h3>${fresh ? "Telegram conectado!" : "Seu Telegram está conectado"}</h3>
        <p>${state?.nome_telegram ? `Conta @${esc(state.nome_telegram)}. ` : ""}Agora é só mandar <code>/despesa mercado 35,90</code>, <code>/saldo</code> ou a foto de um cupom fiscal. Toque em <b>Menu</b> no bot para ver todos os comandos.</p>
      </div>
      ${link ? `<a class="tgc-btn" href="${link}" target="_blank" rel="noopener">${PLANE} Abrir conversa com o bot</a>` : ""}
      <button class="tgc-btn sec" id="tgcRelink" type="button">Conectar outro Telegram</button>
      <button class="tgc-btn link" id="tgcUnlink" type="button">Desconectar</button>
      <p class="tgc-msg" id="tgcMsg" role="status"></p>`,
      fresh ? 3 : 0,
    );
    modal.querySelector("#tgcRelink").addEventListener("click", showIntro);
    modal.querySelector("#tgcUnlink").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.confirm !== "1") {
        btn.dataset.confirm = "1";
        btn.textContent = "Toque de novo para confirmar";
        btn.style.color = "#dc2626";
        return;
      }
      btn.disabled = true;
      const data = await post({ acao: "desvincular" }).catch(() => null);
      if (data?.status === "success") {
        await refresh();
        showIntro();
      } else {
        const msg = modal.querySelector("#tgcMsg");
        msg.dataset.type = "error";
        msg.textContent = data?.message || "Não foi possível desconectar agora.";
        btn.disabled = false;
      }
    });
  }
  async function open(e) {
    e?.preventDefault?.();
    document.querySelectorAll(".user-dropdown").forEach((d) => d.style.removeProperty("display"));
    if (modal) return;
    modal = document.createElement("div");
    modal.className = "tgc-backdrop";
    modal.innerHTML = `<div class="tgc-modal" role="dialog" aria-modal="true" aria-labelledby="tgcTitle">
        <button class="tgc-close" type="button" aria-label="Fechar">&times;</button>
        <div class="tgc-head"><div class="tgc-logo">${LOGO}</div><div><h2 id="tgcTitle">CashFlow no Telegram</h2><p>Controle suas finanças por mensagem.</p></div></div>
        <div class="tgc-body"><div class="tgc-wait"><span class="tgc-spin"></span> Carregando…</div></div>
      </div>`;
    modal.addEventListener("click", (ev) => ev.target === modal && close());
    modal.querySelector(".tgc-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(modal);
    document.body.style.overflow = "hidden";
    await refresh();
    if (!modal) return;
    linked() ? showDone(false) : showIntro();
  }

  // ---------- Card, itens de menu e status ----------
  function renderCard(el) {
    const dismissed = Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now();
    if (!state || linked() || dismissed) {
      el.innerHTML = "";
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `<section class="tgc-card" aria-label="Conectar Telegram">
        <div class="tgc-logo">${LOGO}</div>
        <div class="tgc-card-txt"><b>Registre gastos pelo Telegram</b><span>Mande <code>/despesa mercado 35,90</code> ou a foto do cupom fiscal e o CashFlow registra para você. Leva 1 minuto para conectar.</span></div>
        <div class="tgc-card-act">
          <button class="tgc-btn" type="button" data-tgc-open>${PLANE} Conectar</button>
          <button class="tgc-btn link" type="button" data-tgc-later>Agora não</button>
        </div>
      </section>`;
    el.querySelector("[data-tgc-open]").addEventListener("click", open);
    el.querySelector("[data-tgc-later]").addEventListener("click", () => {
      // Volta a aparecer depois de 14 dias.
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now() + 14 * 86400000));
      } catch {}
      renderCard(el);
    });
  }
  function renderStatus(el) {
    if (!state) return;
    el.className = `tgc-chip ${linked() ? "on" : "off"}`;
    el.textContent = linked() ? "Conectado" : "Conectar";
  }
  function bind() {
    document.querySelectorAll("[data-telegram-open]").forEach((el) => {
      if (el.dataset.tgcBound) return;
      el.dataset.tgcBound = "1";
      el.addEventListener("click", open);
    });
    const paint = () => {
      document.querySelectorAll("[data-telegram-card]").forEach(renderCard);
      document.querySelectorAll("[data-telegram-status]").forEach(renderStatus);
      if (state)
        document.querySelectorAll("[data-telegram-label]").forEach((el) => {
          el.textContent = linked() ? "Gerenciar conexão" : "Conectar Telegram";
        });
    };
    listeners.add(paint);
    refresh();
  }
  window.CashFlowTelegram = { abrir: open, atualizar: refresh, estado: () => state };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
  // Link direto: /home#telegram abre o assistente.
  if (location.hash === "#telegram") setTimeout(open, 400);
})();
