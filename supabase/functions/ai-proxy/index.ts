/**
 * RecrutadorIA — AI Proxy Edge Function
 *
 * Mantém as chaves de IA no servidor. Tenta os provedores em cascata
 * (preferido primeiro, depois os demais) e usa o primeiro que responder —
 * assim, se um provedor estiver sem cota/indisponível, outro atende.
 *
 * Secrets (Supabase > Functions > Secrets):
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
 *   AI_PROVIDER      → provedor preferido: "anthropic" | "gemini" | "openai" (default: anthropic)
 *   ANTHROPIC_MODEL  → default "claude-3-5-haiku-latest"
 *   GEMINI_MODEL     → default "gemini-2.0-flash"
 *   RATE_LIMIT_RPM   → chamadas por minuto por IP (default: 20)
 *   ALLOWED_ORIGINS  → origens permitidas no CORS (lista separada por vírgula)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface AIRequest {
  prompt: string;
  max_tokens?: number;
  system?: string;
  job_context?: Record<string, unknown>;
}

interface RateLimitEntry { count: number; reset: number; }

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS")
  ?? "https://www.paineldevagas.com.br,https://paineldevagas.com.br")
  .split(",").map((o) => o.trim()).filter(Boolean);

function corsOrigin(req: Request): string {
  const origin = req.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// ─── Rate limiting em memória (por IP) ─────────────────────────────────────────
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT = parseInt(Deno.env.get("RATE_LIMIT_RPM") ?? "20");

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function sanitizePrompt(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 8000);
}

// ─── Providers ──────────────────────────────────────────────────────────────
async function callAnthropic(prompt: string, maxTokens: number, system: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-latest";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

async function callOpenAI(prompt: string, maxTokens: number, system: string): Promise<string> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY não configurada.");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(prompt: string, maxTokens: number, system: string): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY não configurada.");
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${system}\n\n${prompt}` }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

const PROVIDERS: Record<string, (p: string, m: number, s: string) => Promise<string>> = {
  anthropic: callAnthropic,
  gemini:    callGemini,
  openai:    callOpenAI,
};

// Ordem de tentativa: provedor preferido + os demais que tenham chave configurada.
function providerOrder(): string[] {
  const preferred = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const hasKey: Record<string, boolean> = {
    anthropic: !!Deno.env.get("ANTHROPIC_API_KEY"),
    gemini:    !!Deno.env.get("GEMINI_API_KEY"),
    openai:    !!Deno.env.get("OPENAI_API_KEY"),
  };
  const order = [preferred, "anthropic", "gemini", "openai"]
    .filter((p, i, arr) => arr.indexOf(p) === i)  // remove duplicados
    .filter((p) => PROVIDERS[p] && hasKey[p]);     // só provedores com chave
  return order;
}

// ─── Handler ────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const allowOrigin = corsOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  allowOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
        "Vary": "Origin",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin":  allowOrigin,
    "Vary": "Origin",
    "Content-Type": "application/json",
  };

  try {
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";
    if (!checkRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: "Rate limit atingido. Tente novamente em 1 minuto." }),
        { status: 429, headers: corsHeaders }
      );
    }

    if (!req.headers.get("content-type")?.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "Content-Type deve ser application/json." }),
        { status: 400, headers: corsHeaders }
      );
    }

    let body: AIRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "JSON inválido." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const { prompt, max_tokens = 1200, system = "" } = body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Campo 'prompt' é obrigatório." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const cleanPrompt = sanitizePrompt(prompt);
    const cleanSystem = sanitizePrompt(
      system ||
      "Você é um especialista em recrutamento comportamental com a filosofia Cabeça de Dono. " +
      "Responda sempre em português brasileiro. Seja preciso, direto e analítico."
    );

    const order = providerOrder();
    if (order.length === 0) {
      throw new Error("Nenhuma chave de IA configurada (ANTHROPIC_API_KEY, GEMINI_API_KEY ou OPENAI_API_KEY).");
    }

    // Tenta cada provedor na ordem; usa o primeiro que responder.
    const errors: string[] = [];
    for (const provider of order) {
      try {
        const text = await PROVIDERS[provider](cleanPrompt, max_tokens, cleanSystem);
        if (text && text.trim()) {
          return new Response(
            JSON.stringify({ text, provider }),
            { status: 200, headers: corsHeaders }
          );
        }
        errors.push(`${provider}: resposta vazia`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[ai-proxy] Falha no provider ${provider}:`, msg);
        errors.push(`${provider}: ${msg}`);
      }
    }

    // Todos falharam
    throw new Error(`Todos os provedores de IA falharam. ${errors.join(" | ")}`);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-proxy] Erro:", message);
    return new Response(
      JSON.stringify({ error: "Erro interno no servidor de IA.", detail: message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
