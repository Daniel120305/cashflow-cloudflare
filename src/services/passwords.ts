import type { Database } from "../db.js";

// O plano gratuito da Cloudflare dá só 10 ms de CPU por requisição, pouco para
// bcrypt. Por isso o cálculo do bcrypt é feito pelo próprio PostgreSQL
// (extensão pgcrypto, ativa por padrão no Supabase). O formato continua bcrypt:
// as senhas atuais funcionam sem mudança e o servidor antigo (Render) também
// entende as senhas novas.

// Hash fictício: quando o email não existe, a conferência demora o mesmo tempo.
const DUMMY = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.5Pj5eKKxfamc4O2JXXiZpaAKw1nwS7e";
// pgcrypto só reconhece o prefixo $2a$; $2b$/$2y$ (bcryptjs/PHP) são o mesmo algoritmo.
export const normalizeHash = (hash: string) => hash.replace(/^\$2[by]\$/, "$2a$");

let schema: string | undefined;
async function pgcrypto(db: Database) {
  if (schema) return schema;
  const r = await db.query(
    "SELECT n.nspname AS s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='gen_salt' ORDER BY (n.nspname='extensions') DESC LIMIT 1",
  );
  if (!r.rows[0])
    throw new Error("Extensão pgcrypto não encontrada no banco. Rode: CREATE EXTENSION pgcrypto;");
  // Nome vindo do catálogo, mas ainda assim só aceita identificador simples.
  if (!/^[a-z_][a-z0-9_]*$/.test(r.rows[0].s)) throw new Error("Esquema pgcrypto inesperado.");
  return (schema = r.rows[0].s as string);
}

export async function hashPassword(db: Database, password: string) {
  const s = await pgcrypto(db);
  const r = await db.query(`SELECT ${s}.crypt($1, ${s}.gen_salt('bf', 12)) AS h`, [password]);
  return r.rows[0].h as string;
}

export async function checkPassword(db: Database, password: string, hash?: string | null) {
  const s = await pgcrypto(db);
  const stored = normalizeHash(hash || DUMMY);
  const r = await db.query(`SELECT ${s}.crypt($1, $2) = $2 AS ok`, [password, stored]);
  return Boolean(hash) && r.rows[0]?.ok === true;
}
