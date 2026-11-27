import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchExchangeRate } from "../src/routes-requirements.js";

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("câmbio: usa a AwesomeAPI quando ela responde", async () => {
  const urls: string[] = [];
  const r = await fetchExchangeRate("USD", (async (u: string) => {
    urls.push(String(u));
    return json({ USDBRL: { bid: "5.4321", timestamp: "1795750000" } });
  }) as any);
  assert.equal(r.cotacao, 5.4321);
  assert.match(r.fonte, /AwesomeAPI/);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /economia\.awesomeapi\.com\.br\/json\/last\/USD-BRL/);
});

test("câmbio: AwesomeAPI fora do ar → PTAX do Banco Central (última cotação)", async () => {
  const r = await fetchExchangeRate("EUR", (async (u: string) => {
    if (String(u).includes("awesomeapi")) return json({ message: "erro" }, 503);
    assert.match(String(u), /olinda\.bcb\.gov\.br.*PTAX.*@moeda='EUR'/);
    return json({ value: [
      { cotacaoVenda: 6.1, dataHoraCotacao: "2026-11-25 13:05:00.000" },
      { cotacaoVenda: 6.25, dataHoraCotacao: "2026-11-26 13:04:00.000" },
    ] });
  }) as any);
  assert.equal(r.cotacao, 6.25);
  assert.match(r.fonte, /PTAX/);
  assert.equal(r.atualizado_em, "2026-11-26T16:04:00.000Z");
});

test("câmbio: as duas fontes falham → erro (o site abre o campo manual)", async () => {
  await assert.rejects(
    fetchExchangeRate("GBP", (async () => { throw new Error("offline"); }) as any),
    /AwesomeAPI: offline \| BCB PTAX: offline/,
  );
});
