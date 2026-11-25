// Testa a conversa SMTP contra um servidor falso local (sem TLS).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Readable, Writable } from "node:stream";
import { sendSmtp, type Connector } from "../src/integrations/smtp.js";

function fakeServer(auth: "PLAIN" | "LOGIN") {
  const log: string[] = [];
  const server = net.createServer((s) => {
    let buf = "", inData = false, data = "", step = 0;
    s.write("220 fake ESMTP\r\n");
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; log.push("DATA:" + data); s.write("250 OK queued\r\n"); }
          else data += line + "\n";
          continue;
        }
        log.push(line);
        if (line.startsWith("EHLO")) s.write(`250-fake\r\n250-AUTH ${auth}\r\n250 SIZE 1000\r\n`);
        else if (line.startsWith("AUTH PLAIN")) s.write("235 ok\r\n");
        else if (line === "AUTH LOGIN") { step = 1; s.write("334 VXNlcm5hbWU6\r\n"); }
        else if (step === 1) { step = 2; s.write("334 UGFzc3dvcmQ6\r\n"); }
        else if (step === 2) { step = 0; s.write("235 ok\r\n"); }
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) s.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; s.write("354 go\r\n"); }
        else if (line === "QUIT") { s.write("221 bye\r\n"); s.end(); }
      }
    });
  });
  return { server, log };
}
const nodeConnector: Connector = ({ hostname, port }) => {
  const sock = net.createConnection({ host: hostname, port });
  return {
    readable: Readable.toWeb(sock) as any,
    writable: Writable.toWeb(sock) as any,
    opened: new Promise((r) => sock.once("connect", r)),
    close: () => void sock.destroy(),
  };
};

for (const auth of ["PLAIN", "LOGIN"] as const)
  test(`SMTP com AUTH ${auth}`, async () => {
    const { server, log } = fakeServer(auth);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    await sendSmtp(
      { host: "127.0.0.1", port, secure: false, plain: true, user: "eu@gmail.com", password: "abcd efgh ijkl mnop", from: "CashFlow <eu@gmail.com>" },
      "cliente@exemplo.com",
      { subject: "Redefinir sua senha ✓", text: "Olá\n.linha com ponto", html: "<p>Olá</p>" },
      nodeConnector,
    );
    server.close();
    const auth64 = Buffer.from("\0eu@gmail.com\0abcdefghijklmnop").toString("base64");
    if (auth === "PLAIN") assert.ok(log.includes(`AUTH PLAIN ${auth64}`), log.join("\n"));
    else assert.ok(log.includes(Buffer.from("abcdefghijklmnop").toString("base64")));
    assert.ok(log.includes("MAIL FROM:<eu@gmail.com>"));
    assert.ok(log.includes("RCPT TO:<cliente@exemplo.com>"));
    const data = log.find((l) => l.startsWith("DATA:"))!;
    assert.match(data, /Subject: =\?UTF-8\?B\?/);
    assert.match(data, /From: CashFlow <eu@gmail.com>/);
  });
