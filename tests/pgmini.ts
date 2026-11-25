// Cliente PostgreSQL mínimo SÓ para testes locais (sem rede para instalar o pg).
// Protocolo simples, autenticação "trust" e parâmetros $n como literais.
// Converte tipos como o driver pg: int4 → número, int8/numeric → texto, json → objeto.
import net from "node:net";

const lit = (v: any): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") v = JSON.stringify(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const parse = (oid: number, s: string | null) => {
  if (s === null) return null;
  if ([21, 23, 26, 700, 701].includes(oid)) return Number(s);
  if (oid === 16) return s === "t";
  if (oid === 114 || oid === 3802) return JSON.parse(s);
  if ([1082, 1114, 1184].includes(oid)) return new Date(oid === 1082 ? s + "T00:00:00" : s.replace(" ", "T"));
  return s;
};

class Conn {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  waiter?: () => void;
  chain = Promise.resolve();
  async open(socketPath: string, user: string, database: string) {
    this.sock = net.createConnection({ path: socketPath });
    this.sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiter?.();
    });
    await new Promise<void>((ok, fail) => this.sock.once("connect", ok).once("error", fail));
    const params = Buffer.from(`user\0${user}\0database\0${database}\0client_encoding\0UTF8\0\0`);
    const head = Buffer.alloc(8);
    head.writeInt32BE(8 + params.length, 0);
    head.writeInt32BE(196608, 4);
    this.sock.write(Buffer.concat([head, params]));
    await this.until("Z");
  }
  private async message(): Promise<{ type: string; body: Buffer }> {
    while (this.buf.length < 5 || this.buf.length < 1 + this.buf.readInt32BE(1))
      await new Promise<void>((r) => (this.waiter = r));
    const len = this.buf.readInt32BE(1);
    const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
    this.buf = this.buf.subarray(1 + len);
    return msg;
  }
  private async until(type: string) {
    for (;;) {
      const m = await this.message();
      if (m.type === "E") throw this.error(m.body);
      if (m.type === type) return m;
    }
  }
  private error(body: Buffer) {
    const f: Record<string, string> = {};
    let i = 0;
    while (body[i]) {
      const end = body.indexOf(0, i + 1);
      f[String.fromCharCode(body[i])] = body.toString("utf8", i + 1, end);
      i = end + 1;
    }
    return Object.assign(new Error(f.M), { code: f.C, constraint: f.n, detail: f.D });
  }
  query(sql: string, values: any[] = []) {
    const run = this.chain.then(() => this.run(sql, values));
    this.chain = run.then(() => {}, () => {});
    return run;
  }
  private async run(sql: string, values: any[]) {
    const text = sql.replace(/\$(\d+)/g, (_, n) => lit(values[Number(n) - 1]));
    const q = Buffer.from(text + "\0");
    const head = Buffer.alloc(5);
    head.write("Q");
    head.writeInt32BE(4 + q.length, 1);
    this.sock.write(Buffer.concat([head, q]));
    let fields: { name: string; oid: number }[] = [];
    const rows: any[] = [];
    let rowCount: number | null = null;
    let failure: Error | undefined;
    for (;;) {
      const m = await this.message();
      if (m.type === "T") {
        fields = [];
        let i = 2;
        for (let n = m.body.readInt16BE(0); n > 0; n--) {
          const end = m.body.indexOf(0, i);
          const name = m.body.toString("utf8", i, end);
          fields.push({ name, oid: m.body.readInt32BE(end + 7) });
          i = end + 19;
        }
      } else if (m.type === "D") {
        const row: any = {};
        let i = 2;
        for (const f of fields) {
          const len = m.body.readInt32BE(i);
          i += 4;
          row[f.name] = parse(f.oid, len < 0 ? null : m.body.toString("utf8", i, i + len));
          if (len > 0) i += len;
        }
        rows.push(row);
      } else if (m.type === "C") {
        const tag = m.body.toString("utf8", 0, m.body.length - 1).split(" ");
        rowCount = /^\d+$/.test(tag.at(-1)!) ? Number(tag.at(-1)) : null;
      } else if (m.type === "E") failure = this.error(m.body);
      else if (m.type === "Z") break;
    }
    if (failure) throw failure;
    return { rows, rowCount };
  }
  close() {
    this.sock.end();
  }
}

export function miniPool(opts = { socket: "/var/run/postgresql/.s.PGSQL.5499", user: "dono", database: "cf" }) {
  const idle: Conn[] = [];
  const all: Conn[] = [];
  const get = async () => {
    const c = idle.pop();
    if (c) return c;
    const n = new Conn();
    await n.open(opts.socket, opts.user, opts.database);
    all.push(n);
    return n;
  };
  return {
    async query(sql: string, values?: any[]) {
      const c = await get();
      try {
        return await c.query(sql, values);
      } finally {
        idle.push(c);
      }
    },
    async connect() {
      const c = await get();
      return { query: (s: string, v?: any[]) => c.query(s, v), release: () => void idle.push(c) };
    },
    async end() {
      for (const c of all) c.close();
    },
  };
}
