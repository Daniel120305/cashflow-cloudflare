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
  "Use o VALOR TOTAL pago (não subtotal, troco nem desconto). Leia cada dígito com atenção: 1 e 2, 1 e 7, 5 e 6, 0 e 8 se confundem em fotos. " +
  "A data costuma estar no topo, perto do horário. Se não achar a data, use null. " +
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

// Formas de pedir a leitura, da preferida para a reserva. Os modelos de visão
// do Workers AI aceitam formatos diferentes de imagem; a primeira que devolver
// texto vence. (Llama 3.2 Vision exige aceitar a licença da Meta uma vez.)
const LLAMA4 = "@cf/meta/llama-4-scout-17b-16e-instruct";
type Attempt = { name: string; model: string; input: (b64: string, bytes: Uint8Array) => any };
const dataUrl = (b64: string) => `data:image/jpeg;base64,${b64}`;
const withImage = (b64: string) => [
  {
    role: "user",
    content: [
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: dataUrl(b64) } },
    ],
  },
];
export const ATTEMPTS: Attempt[] = [
  { name: "llama4-image_url", model: LLAMA4, input: (b64) => ({ messages: withImage(b64), max_tokens: 300, temperature: 0 }) },
  { name: "llama32-image_url", model: MODEL, input: (b64) => ({ messages: withImage(b64), max_tokens: 300, temperature: 0 }) },
  { name: "llama32-prompt", model: MODEL, input: (b64) => ({ prompt: PROMPT, image: b64, max_tokens: 300, temperature: 0 }) },
  {
    name: "llama32-messages-bytes",
    model: MODEL,
    input: (_b64, bytes) => ({
      messages: [
        { role: "system", content: "Você lê comprovantes fiscais brasileiros e responde só em JSON." },
        { role: "user", content: PROMPT },
      ],
      image: Array.from(bytes),
      max_tokens: 300,
      temperature: 0,
    }),
  },
];

const textOf = (result: any) => {
  if (typeof result === "string") return result;
  const r = result?.response ?? result?.result?.response ?? result?.choices?.[0]?.message?.content;
  return typeof r === "string" ? r : r ? JSON.stringify(r) : "";
};
const isLicense = (e: unknown) => /5016|agree|licen/i.test(String((e as Error)?.message ?? e));

export function workersAiOcr(ai: Ai | undefined, attempts: Attempt[] = ATTEMPTS) {
  if (!ai) return undefined;
  return async (image: Uint8Array) => {
    const b64 = toBase64(image);
    const errors: string[] = [];
    const agreed = new Set<string>();
    for (const attempt of attempts) {
      for (let tries = 0; tries < 2; tries++) {
        try {
          const text = textOf(await ai.run(attempt.model, attempt.input(b64, image)));
          if (text.trim()) {
            console.log("[CashFlow] Comprovante lido via", attempt.name, errors.length ? `(antes: ${errors.join(" | ")})` : "");
            return text;
          }
          errors.push(`${attempt.name}: resposta vazia`);
          break;
        } catch (error) {
          // Licença do modelo: aceita uma vez e tenta de novo. A Cloudflare
          // responde o aceite com um "erro" 5016 ("Thank you for agreeing"),
          // que não é falha.
          if (isLicense(error) && !agreed.has(attempt.model)) {
            agreed.add(attempt.model);
            await ai.run(attempt.model, { prompt: "agree" }).catch(() => {});
            continue;
          }
          errors.push(`${attempt.name}: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
          break;
        }
      }
    }
    throw new Error("Nenhum modelo leu a imagem. " + errors.join(" | "));
  };
}
