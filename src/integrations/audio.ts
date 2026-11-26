// Transcrição de mensagens de voz do Telegram (OGG/Opus) e arquivos de áudio
// pelo Workers AI (Whisper). Tenta mais de um modelo/formato: o primeiro que
// devolver texto vence. Custo: ~47 Neurons por minuto de áudio (turbo).
type Ai = { run: (model: string, input: any) => Promise<any> };

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// O Whisper "inventa" texto quando o áudio é só silêncio ou ruído (microfone
// mutado): repete frases como "Thank you very much", "I'm sorry",
// "Obrigado por assistir". Estas regras descartam essas transcrições.
const HALLUCINATIONS = [
  /thank(s| you)( very much)?( for watching)?/i,
  /i'?m sorry/i,
  /please subscribe|subscribe to/i,
  /subtitles? (by|from)/i,
  /obrigad[oa] por assistir/i,
  /inscreva-?se/i,
  /legendas? (pela|por|da)/i,
  /amara\.org/i,
  /tchau,? tchau/i,
  /^\W*(you|bye|ok|okay|hmm+|uh+|ah+|music|♪+)\W*$/i,
];
export function looksLikeNoise(text: string, durationSec = 0, result?: any): boolean {
  const t = text.trim();
  if (!t) return true;
  const words = t.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  if (!words.length) return true;
  // Mais palavras do que uma pessoa consegue falar no tempo do áudio (~4/s).
  if (durationSec > 0 && words.length > durationSec * 4 + 8) return true;
  // Repetição: poucas palavras diferentes num texto comprido.
  if (words.length >= 12 && new Set(words).size / words.length < 0.35) return true;
  // A mesma frase 3 vezes ou mais seguidas.
  const frases = t.split(/[.!?]+(?:\s+|$)/).map((f) => f.trim().toLowerCase()).filter(Boolean);
  for (let i = 0; i + 2 < frases.length; i++) if (frases[i] === frases[i + 1] && frases[i] === frases[i + 2]) return true;
  // Só frases típicas de alucinação.
  const resto = frases.filter((f) => !HALLUCINATIONS.some((re) => re.test(f)));
  if (frases.length && !resto.length) return true;
  // O modelo acha que não havia fala.
  const segs = result?.segments ?? result?.transcription_info?.segments;
  if (Array.isArray(segs) && segs.length) {
    const probs = segs.map((s: any) => Number(s.no_speech_prob)).filter((n: number) => Number.isFinite(n));
    if (probs.length && probs.reduce((a: number, b: number) => a + b, 0) / probs.length > 0.6) return true;
  }
  return false;
}

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
  // Devolve "" quando o áudio não tem fala (silêncio, microfone mutado, ruído).
  return async (audio: Uint8Array, durationSec = 0) => {
    const b64 = toBase64(audio);
    const errors: string[] = [];
    for (const a of attempts) {
      try {
        const r = await ai.run(a.model, a.input(b64, audio));
        const text = String(r?.text ?? r?.response ?? "").trim();
        if (text && looksLikeNoise(text, durationSec, r)) {
          console.log("[CashFlow] Áudio sem fala (descartado):", a.name, text.slice(0, 80));
          return "";
        }
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
