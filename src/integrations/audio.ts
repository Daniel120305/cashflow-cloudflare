// Transcrição de mensagens de voz do Telegram (OGG/Opus) e arquivos de áudio
// pelo Workers AI (Whisper). Tenta mais de um modelo/formato: o primeiro que
// devolver texto vence. Custo: ~47 Neurons por minuto de áudio (turbo).
type Ai = { run: (model: string, input: any) => Promise<any> };

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

type Attempt = { name: string; model: string; input: (b64: string, bytes: Uint8Array) => any };
export const AUDIO_ATTEMPTS: Attempt[] = [
  {
    name: "whisper-turbo",
    model: "@cf/openai/whisper-large-v3-turbo",
    // initial_prompt ajuda o modelo com o vocabulário de finanças.
    input: (b64) => ({
      audio: b64,
      language: "pt",
      vad_filter: true,
      initial_prompt: "Gastei 35,90 no mercado. Paguei 120 reais de luz. Recebi 3.000 de salário. Quanto gastei este mês?",
    }),
  },
  { name: "whisper", model: "@cf/openai/whisper", input: (_b64, bytes) => ({ audio: Array.from(bytes) }) },
];

export function workersAiTranscriber(ai: Ai | undefined, attempts: Attempt[] = AUDIO_ATTEMPTS) {
  if (!ai) return undefined;
  return async (audio: Uint8Array) => {
    const b64 = toBase64(audio);
    const errors: string[] = [];
    for (const a of attempts) {
      try {
        const r = await ai.run(a.model, a.input(b64, audio));
        const text = String(r?.text ?? r?.response ?? "").trim();
        if (text) {
          console.log("[CashFlow] Áudio transcrito via", a.name, errors.length ? `(antes: ${errors.join(" | ")})` : "");
          return text;
        }
        errors.push(`${a.name}: vazio`);
      } catch (error) {
        errors.push(`${a.name}: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
      }
    }
    throw new Error("Nenhum modelo transcreveu o áudio. " + errors.join(" | "));
  };
}
