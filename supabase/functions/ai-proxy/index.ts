/**
 * RecrutadorIA — AI Proxy Edge Function
 *
 * Propósito: manter chaves de API NO SERVIDOR, nunca expô-las ao browser.
 * O frontend chama esta função via Supabase client; a função chama o provider
 * de IA com a chave secreta armazenada em variáveis de ambiente do Supabase.
 *
 * Deploy:
 *   supabase functions deploy ai-proxy --no-verify-jwt
 *
 * Variáveis de ambiente (definir em Supabase Dashboard > Functions > Secrets):
 *   ANTHROPIC_API_KEY   → console.anthropic.com
 *   OPENAI_API_KEY      → platform.openai.com      (opcional)
 *   GEMINI_API_KEY      → aistudio.google.com       (opcional)
 *   AI_PROVIDER         → "anthropic" | "openai" | "gemini"  (default: anthropic)
 *   RATE_LIMIT_RPM      → chamadas por minuto por IP (default: 20)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface AIRequest {
  prompt: string;
  max_tokens?: number;
  system?: string;
  job_context?: Record<string, unknown>;  // contexto extra (vaga, empresa)
}

interface RateLimitEntry { count: number; reset: number; }

// ─── Rate limiting em memória (por IP, reinicia a cada minuto) ────────────────
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

// ─── Sanitização básica do prompt ─────────────────────────────────────────────
function sanitizePrompt(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .slice(0, 8000);  // limite de segurança
}

// ─── Providers ────────────────────────────────────────────────────────────────
async function callAnthropic(prompt: string, maxTokens: number, system: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
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

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
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

// ─── Handler principal ────────────────────────────────────────────────────────
serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin":  "*",
    "Content-Type": "application/json",
  };

  try {
    // ── Rate limit por IP ──────────────────────────────────────────────────
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";
    if (!checkRateLimit(ip)) {
      return new Response(
        JSON.stringify({ error: "Rate limit atingido. Tente novamente em 1 minuto." }),
        { status: 429, headers: corsHeaders }
      );
    }

    // ── Valida Content-Type ────────────────────────────────────────────────
    if (!req.headers.get("content-type")?.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "Content-Type deve ser application/json." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ── Parse body ────────────────────────────────────────────────────────
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

    // ── Seleciona provider (auto-detect se AI_PROVIDER não setado) ────────
    let provider = (Deno.env.get("AI_PROVIDER") ?? "").toLowerCase();
    if (!provider) {
      if (Deno.env.get("GEMINI_API_KEY"))    provider = "gemini";
      else if (Deno.env.get("ANTHROPIC_API_KEY")) provider = "anthropic";
      else if (Deno.env.get("OPENAI_API_KEY"))    provider = "openai";
      else throw new Error("Nenhuma chave de IA configurada. Configure GEMINI_API_KEY, ANTHROPIC_API_KEY ou OPENAI_API_KEY.");
    }
    console.log(`[ai-proxy] Usando provider: ${provider}`);

    let text: string;
    switch (provider) {
      case "openai":
        text = await callOpenAI(cleanPrompt, max_tokens, cleanSystem);
        break;
      case "gemini":
        text = await callGemini(cleanPrompt, max_tokens, cleanSystem);
        break;
      case "anthropic":
        text = await callAnthropic(cleanPrompt, max_tokens, cleanSystem);
        break;
      default:
        throw new Error(`Provider desconhecido: ${provider}`);
    }

    return new Response(
      JSON.stringify({ text, provider }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-proxy] Erro:", message);
    return new Response(
      JSON.stringify({ error: "Erro interno no servidor de IA.", detail: message }),
      { status: 500, headers: corsHeaders }
    );
  }
});
