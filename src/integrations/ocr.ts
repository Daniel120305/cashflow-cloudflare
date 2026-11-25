// Leitura de comprovantes pelo Workers AI (modelo de visão), no lugar do
// tesseract, que não roda dentro de um Worker.
//
// O modelo devolve um JSON com estabelecimento, data e total. O texto vai para
// readReceipt(), que entende esse JSON e, se não vier JSON, cai no
// extractReceipt() antigo (procura TOTAL, data e estabelecimento no texto).
import { extractReceipt, classifyExpense, brazilToday } from "./receipt.js";
import { money } from "../validation.js";

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const PROMPT =
  "Você recebe a foto de um cupom fiscal, nota fiscal ou comprovante de pagamento brasileiro. " +
  'Responda SOMENTE com um JSON neste formato: {"estabelecimento":"nome da loja","data":"DD/MM/AAAA","total":"123,45"}. ' +
  "Use o VALOR TOTAL pago (não subtotal, troco nem desconto). Se não achar a data, use null. " +
  'Se a imagem não for um comprovante, responda {"erro":"nao_e_comprovante"}.';

type Ai = { run: (model: string, input: any) => Promise<any> };
type Receipt = { description: string; amount: string; date: string; category: string };

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// Entende a resposta do modelo (JSON) ou, sem JSON, o texto do cupom.
export function readReceipt(text: string, today = brazilToday()): Receipt | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const d = JSON.parse(json);
      if (d.erro) return null;
      const amount = money(String(d.total ?? "").replace(/[^\d.,]/g, ""), "valor");
      if (!(Number(amount) > 0)) return null;
      const m = String(d.data ?? "").match(/(\d{2})[/.-](\d{2})[/.-](\d{2,4})/);
      let date = today;
      if (m) {
        const year = m[3].length === 2 ? "20" + m[3] : m[3];
        const iso = `${year}-${m[2]}-${m[1]}`;
        // Data válida e não no futuro; senão, hoje.
        if (Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso && iso <= today) date = iso;
      }
      const description = String(d.estabelecimento ?? "").trim().slice(0, 120) || "Compra (cupom fiscal)";
      return { description, amount, date, category: classifyExpense(description) };
    } catch {
      // segue para o texto
    }
  }
  return extractReceipt(text);
}

export function workersAiOcr(ai: Ai | undefined) {
  if (!ai) return undefined;
  return async (image: Uint8Array) => {
    const ask = (img: string | number[]) =>
      ai.run(MODEL, {
        messages: [{ role: "user", content: PROMPT }],
        image: img,
        max_tokens: 300,
        temperature: 0,
      });
    const run = async () => {
      try {
        // Base64 é rápido de montar (pouca CPU no plano gratuito).
        return await ask(toBase64(image));
      } catch (error) {
        if (/agree|licen/i.test(String((error as Error)?.message ?? error))) throw error;
        // Alguns modelos só aceitam a imagem como lista de bytes.
        return await ask(Array.from(image));
      }
    };
    let result: any;
    try {
      result = await run();
    } catch (error) {
      // Na primeira vez a conta precisa aceitar a licença do modelo da Meta.
      if (!/agree|licen/i.test(String((error as Error)?.message ?? error))) throw error;
      await ai.run(MODEL, { prompt: "agree" });
      result = await run();
    }
    const text = typeof result === "string" ? result : (result?.response ?? "");
    if (!text) throw new Error("O modelo não devolveu texto.");
    return String(text);
  };
}
