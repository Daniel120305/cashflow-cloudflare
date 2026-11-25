import pg from "pg";

export interface Database {
  query(
    text: string,
    values?: any[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>, userId?: number): Promise<T>;
}

// Toda consulta "do usuário" roda numa transação com o papel cashflow_app e
// app.user_id definido: as políticas RLS do banco só mostram os dados dele.
export function userDatabase(db: Database, rawUserId: number | string): Database {
  // No Supabase algumas colunas de id são bigint e o driver devolve texto ("2").
  const userId = typeof rawUserId === "string" && /^\d+$/.test(rawUserId) ? Number(rawUserId) : rawUserId;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Usuário inválido para transação.");
  return {
    query: (sql, values) =>
      db.transaction((tx) => tx.query(sql, values), userId),
    transaction: (fn) => db.transaction(fn, userId),
  };
}

type Client = {
  query: (sql: string, values?: any[]) => Promise<any>;
  release: () => void;
};

// Envolve qualquer "pool" (pg.Pool no Worker, cliente de teste no Node).
export function wrapPool(pool: {
  query: (sql: string, values?: any[]) => Promise<any>;
  connect: () => Promise<Client>;
  end: () => Promise<void>;
}) {
  const database: Database & { end: () => Promise<void> } = {
    query: (sql, values) => pool.query(sql, values),
    end: () => pool.end(),
    transaction: async (fn, userId) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (userId !== undefined) {
          await client.query("SET LOCAL ROLE cashflow_app");
          await client.query("SELECT set_config('app.user_id',$1,true)", [
            String(userId),
          ]);
        }
        const tx: Database = {
          query: (sql, values) => client.query(sql, values),
          transaction: async (cb) => cb(tx),
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return database;
}

// No Worker a conexão passa pelo Hyperdrive: ele mantém conexões abertas
// perto do Supabase, então abrir um pool por requisição é barato.
export function connectDatabase(connectionString: string) {
  if (!connectionString)
    throw new Error("Banco não configurado: falta o Hyperdrive (binding HYPERDRIVE).");
  const pool = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  // Erro de uma conexão ociosa não pode derrubar o Worker.
  pool.on("error", (error: Error) => console.error("Conexão com o banco caiu:", error.message));
  return wrapPool(pool as any);
}
