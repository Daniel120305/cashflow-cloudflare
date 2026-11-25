import { HttpError } from "../validation.js";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
}
export type GoogleVerifier = (credential: string) => Promise<GoogleProfile>;

// Confere o ID token do Google (botão web ou login nativo do Android) com
// WebCrypto, sem a google-auth-library (que depende do Node).
// O "aud" precisa ser o Client ID Web configurado em GOOGLE_CLIENT_ID.
const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
let keys: { at: number; maxAge: number; list: any[] } | undefined;

async function googleKeys(force = false) {
  if (!force && keys && Date.now() - keys.at < keys.maxAge) return keys.list;
  const response = await fetch(CERTS, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Chaves do Google indisponíveis.");
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
  const list = ((await response.json()) as any).keys ?? [];
  keys = { at: Date.now(), maxAge: maxAge * 1000, list };
  return list;
}

const b64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

export async function verifyGoogleToken(credential: string, clientId: string, now = Date.now()) {
  const [h, p, sig] = credential.split(".");
  if (!h || !p || !sig) throw new Error("Token malformado.");
  const header = json(h);
  const payload = json(p);
  if (header.alg !== "RS256") throw new Error("Algoritmo inesperado.");
  let jwk = (await googleKeys()).find((k: any) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k: any) => k.kid === header.kid);
  if (!jwk) throw new Error("Chave desconhecida.");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("Assinatura inválida.");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss))
    throw new Error("Emissor inválido.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error("Token de outro aplicativo.");
  // 5 minutos de tolerância para relógios desajustados.
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now - 300000)
    throw new Error("Token expirado.");
  return payload;
}

export function googleVerifier(clientId?: string): GoogleVerifier | undefined {
  if (!clientId) return undefined;
  return async (credential) => {
    let payload: any;
    try {
      payload = await verifyGoogleToken(credential, clientId);
    } catch {
      throw new HttpError(401, "Não foi possível confirmar sua conta Google.");
    }
    if (!payload?.sub || !payload.email || payload.email_verified === false || payload.email_verified === "false")
      throw new HttpError(401, "A conta Google não tem email verificado.");
    return {
      sub: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      name: payload.name || String(payload.email).split("@")[0],
    };
  };
}
