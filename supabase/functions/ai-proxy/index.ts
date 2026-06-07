/**
 * RecrutadorIA — AI Proxy Edge Function
 *
 * Mantém as chaves de IA no servidor. Recursos de confiabilidade:
 *  - Fallback entre provedores (preferido + demais com chave).
 *  - Retry para erros transitórios dos provedores (ex.: Gemini 503 "high demand").
 *  - thinkingBudget 0 no Gemini 2.5 (libera todos os tokens p/ a resposta — evita JSON truncado).
 *  - Saída JSON forçada quando { json: true } (responseMimeType / response_format).
 *  - Auditoria: grava cada chamada em ai_call_logs.
 *
 * Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, AI_PROVIDER,
 *          ANTHROPIC_MODEL, GEMINI_MODEL, OPENAI_MODEL, RATE_LIMIT_RPM,
 *          ALLOWED_ORIGINS, MAX_PROMPT_CHARS  (SUPABASE_URL/SERVICE_ROLE_KEY injetados)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface AIRequest {
  prompt: string;
  max_tokens?: number;
  system?: string;
  kind?: string;   // tipo da chamada p/ auditoria
  json?: boolean;  // força saída JSON
}
interface RateLimitEntry { count: number; reset: number; }

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://www.paineldevagas.com.br,https://paineldevagas.com.br")
  .split(",").map((o) => o.trim()).filter(Boolean);

function corsOrigin(req: Request): string {
  const origin = req.headers.get("origin") ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin; // dev local
  return ALLOWED_ORIGINS[0];
}

// ─── Auditoria (service_role, ignora RLS). Fire-and-forget. ───────────────────
function logAICall(entry: Record<string, unknown>): void {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const p = fetch(`${url}/rest/v1/ai_call_logs`, {
      method: "POST",
      headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify(entry),
    }).catch(() => {});
    (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(p);
  } catch (_) { /* nunca propaga */ }
}

// ─── Rate limiting (por IP) ───────────────────────────────────────────────────
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT = parseInt(Deno.env.get("RATE_LIMIT_RPM") ?? "20");
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) { rateLimitMap.set(ip, { count: 1, reset: now + 60_000 }); return true; }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++; return true;
}

function sanitizePrompt(text: string): string {
  const MAX = parseInt(Deno.env.get("MAX_PROMPT_CHARS") ?? "24000");
  return text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/javascript:/gi, "").slice(0, MAX);
}

// fetch com retry para erros TRANSITÓRIOS dos provedores.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);
async function fetchRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  let res: Response = await fetch(input, init);
  for (let i = 1; i < attempts; i++) {
    if (res.ok || !TRANSIENT_STATUS.has(res.status)) return res;
    await new Promise((r) => setTimeout(r, 900 * i)); // backoff: 0.9s, 1.8s
    res = await fetch(input, init);
  }
  return res;
}

// ─── Providers ────────────────────────────────────────────────────────────────
async function callAnthropic(prompt: string, maxTokens: number, system: string, _json = false): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-latest";
  const res = await fetchRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

async function callOpenAI(prompt: string, maxTokens: number, system: string, json = false): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY não configurada.");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const payload: Record<string, unknown> = {
    model, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
  };
  if (json) payload.response_format = { type: "json_object" };
  const res = await fetchRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(prompt: string, maxTokens: number, system: string, json = false): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY não configurada.");
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingBudget: 0 }, // desliga o "pensamento" → evita JSON truncado
  };
  if (json) generationConfig.responseMimeType = "application/json";
  const res = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: `${system}\n\n${prompt}` }] }], generationConfig }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

const PROVIDERS: Record<string, (p: string, m: number, s: string, j?: boolean) => Promise<string>> = {
  anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI,
};

function providerOrder(): string[] {
  const preferred = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const hasKey: Record<string, boolean> = {
    anthropic: !!Deno.env.get("ANTHROPIC_API_KEY"),
    gemini: !!Deno.env.get("GEMINI_API_KEY"),
    openai: !!Deno.env.get("OPENAI_API_KEY"),
  };
  return [preferred, "anthropic", "gemini", "openai"]
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .filter((p) => PROVIDERS[p] && hasKey[p]);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const allowOrigin = corsOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
      "Vary": "Origin",
    }});
  }
  const corsHeaders = { "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin", "Content-Type": "application/json" };

  try {
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";
    if (!checkRateLimit(ip)) {
      return new Response(JSON.stringify({ error: "Rate limit atingido. Tente novamente em 1 minuto." }), { status: 429, headers: corsHeaders });
    }
    if (!req.headers.get("content-type")?.includes("application/json")) {
      return new Response(JSON.stringify({ error: "Content-Type deve ser application/json." }), { status: 400, headers: corsHeaders });
    }
    let body: AIRequest;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "JSON inválido." }), { status: 400, headers: corsHeaders });
    }
    const { prompt, max_tokens = 1200, system = "", kind = "geral", json = false } = body;
    const origin = req.headers.get("origin") ?? "";
    const t0 = Date.now();
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Campo 'prompt' é obrigatório." }), { status: 400, headers: corsHeaders });
    }
    const cleanPrompt = sanitizePrompt(prompt);
    const cleanSystem = sanitizePrompt(system || "Você é um especialista em recrutamento comportamental com a filosofia Cabeça de Dono. Responda sempre em português brasileiro. Seja preciso, direto e analítico.");

    const order = providerOrder();
    if (order.length === 0) throw new Error("Nenhuma chave de IA configurada.");

    const errors: string[] = [];
    for (const provider of order) {
      try {
        const text = await PROVIDERS[provider](cleanPrompt, max_tokens, cleanSystem, json);
        if (text && text.trim()) {
          logAICall({ kind, provider, success: true, latency_ms: Date.now() - t0, origin });
          return new Response(JSON.stringify({ text, provider }), { status: 200, headers: corsHeaders });
        }
        errors.push(`${provider}: resposta vazia`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[ai-proxy] Falha no provider ${provider}:`, msg);
        errors.push(`${provider}: ${msg}`);
      }
    }
    const allFailMsg = `Todos os provedores de IA falharam. ${errors.join(" | ")}`;
    logAICall({ kind, provider: order.join(">"), success: false, latency_ms: Date.now() - t0, error: allFailMsg.slice(0, 500), origin });
    throw new Error(allFailMsg);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-proxy] Erro:", message);
    return new Response(JSON.stringify({ error: "Erro interno no servidor de IA.", detail: message }), { status: 500, headers: corsHeaders });
  }
});
