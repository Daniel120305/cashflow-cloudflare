// Leitura de comprovantes pelo Workers AI (modelo de visão), no lugar do
// tesseract, que não roda dentro de um Worker. O texto devolvido segue para o
// mesmo extractReceipt() de antes (procura TOTAL, data e estabelecimento).
const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const PROMPT =
  "Transcreva todo o texto desta foto de comprovante ou nota fiscal brasileira, " +
  "linha por linha, exatamente como aparece (nome do estabelecimento, data no formato DD/MM/AAAA, " +
  "itens e a linha do TOTAL com o valor). Não resuma, não traduza e não comente: devolva só o texto.";

type Ai = { run: (model: string, input: any) => Promise<any> };

export function workersAiOcr(ai: Ai | undefined) {
  if (!ai) return undefined;
  return async (image: Uint8Array) => {
    const ask = () =>
      ai.run(MODEL, {
        messages: [{ role: "user", content: PROMPT }],
        image: Array.from(image),
        max_tokens: 800,
        temperature: 0,
      });
    let result: any;
    try {
      result = await ask();
    } catch (error) {
      // Na primeira vez a conta precisa aceitar a licença do modelo da Meta.
      if (!/agree|licen/i.test(String((error as Error)?.message ?? error))) throw error;
      await ai.run(MODEL, { prompt: "agree" });
      result = await ask();
    }
    const text = typeof result === "string" ? result : (result?.response ?? "");
    if (!text) throw new Error("O modelo não devolveu texto.");
    return String(text);
  };
}
