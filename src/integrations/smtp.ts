// Envio de email por SMTP dentro do Worker (o nodemailer não roda aqui).
// Usa os sockets TCP da Cloudflare (cloudflare:sockets): a porta 25 é
// bloqueada, mas 587 (STARTTLS) e 465 (TLS direto) funcionam.
// Mesmas variáveis do Render: SMTP_HOST, SMTP_PORT, SMTP_SECURE,
// SMTP_USER, SMTP_PASSWORD e SMTP_FROM.

export type SmtpMessage = { subject: string; text: string; html: string };
type Socket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened?: Promise<unknown>;
  close: () => Promise<void> | void;
  startTls?: () => Socket;
};
export type Connector = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean },
) => Socket;
export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean; // true = TLS direto (465); false = STARTTLS (587)
  user?: string;
  password?: string;
  from: string;
  // Só para testes locais: sem TLS nenhum.
  plain?: boolean;
};

const enc = new TextEncoder();
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
// "Nome <email@x>" -> email@x
export const addressOf = (from: string) => from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();

class Conversation {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  constructor(public socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
  // Lê uma resposta completa (várias linhas "250-..." terminando em "250 ...").
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const i = this.buffer.indexOf("\r\n");
      if (i >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 2);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("O servidor SMTP fechou a conexão.");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  async send(line: string) {
    await this.writer.write(enc.encode(line + "\r\n"));
  }
  async command(line: string, expect: number[], label = line.split(" ")[0]) {
    await this.send(line);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${label}: ${r.text}`);
    return r;
  }
}

export function buildMime(from: string, to: string, message: SmtpMessage, now = new Date()) {
  const boundary = "cashflow-" + crypto.randomUUID();
  const domain = addressOf(from).split("@")[1] ?? "cashflow";
  return [
    `From: ${from}`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(message.subject)}?=`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(message.text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(message.html)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function defaultConnector(): Promise<Connector> {
  const name = "cloudflare:sockets";
  const mod: any = await import(/* @vite-ignore */ name);
  return mod.connect;
}

export async function sendSmtp(config: SmtpConfig, to: string, message: SmtpMessage, connector?: Connector) {
  const connect = connector ?? (await defaultConnector());
  const mode = config.plain ? "off" : config.secure ? "on" : "starttls";
  let socket = connect({ hostname: config.host, port: config.port }, { secureTransport: mode, allowHalfOpen: false });
  let talk = new Conversation(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error("O servidor SMTP demorou demais para responder.")), 20000);
  });
  const run = async () => {
    await socket.opened;
    const hello = await talk.reply();
    if (hello.code !== 220) throw new Error(`SMTP saudação: ${hello.text}`);
    let ehlo = await talk.command("EHLO cashflow.workers.dev", [250], "EHLO");
    if (mode === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error("O servidor SMTP não oferece STARTTLS.");
      await talk.command("STARTTLS", [220]);
      talk.release();
      socket = socket.startTls!();
      talk = new Conversation(socket);
      ehlo = await talk.command("EHLO cashflow.workers.dev", [250], "EHLO");
    }
    if (config.user) {
      // A senha de app do Gmail é exibida com espaços; o envio precisa sem eles.
      const password = String(config.password ?? "").replace(/\s+/g, "");
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text))
        await talk.command(`AUTH PLAIN ${b64(`\0${config.user}\0${password}`)}`, [235], "AUTH");
      else {
        await talk.command("AUTH LOGIN", [334], "AUTH");
        await talk.command(b64(config.user), [334], "AUTH usuário");
        await talk.command(b64(password), [235], "AUTH senha");
      }
    }
    await talk.command(`MAIL FROM:<${addressOf(config.from)}>`, [250], "MAIL FROM");
    await talk.command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await talk.command("DATA", [354]);
    // Linhas que começam com "." recebem outro "." (regra do SMTP).
    const body = buildMime(config.from, to, message).replace(/\r\n\./g, "\r\n..");
    await talk.send(body + "\r\n.");
    const done = await talk.reply();
    if (done.code !== 250) throw new Error(`SMTP envio: ${done.text}`);
    await talk.send("QUIT").catch(() => {});
  };
  try {
    await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    try {
      await socket.close();
    } catch {}
  }
}
