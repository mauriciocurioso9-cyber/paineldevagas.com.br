/**
 * RecrutadorIA — Configuração Pública (segura para commitar)
 *
 * ESTAS CHAVES SÃO PÚBLICAS — protegidas pelas políticas RLS do Supabase.
 * Nunca coloque chaves de AI (Anthropic/OpenAI/Gemini) aqui.
 * As chaves de AI ficam SOMENTE em: Supabase Dashboard > Edge Functions > Secrets
 *
 * Como preencher:
 *   1. Acesse app.supabase.com > seu projeto > Settings > API
 *   2. Copie "Project URL" → SUPABASE_URL
 *   3. Copie "anon public" → SUPABASE_ANON_KEY
 */

const RECRUTADOR_CONFIG = {
  // ──────────────────────────────────────────────────────────────
  // SUPABASE (obrigatório)
  // Obtenha em: app.supabase.com > Settings > API
  // ──────────────────────────────────────────────────────────────
  SUPABASE_URL:      "https://kmrxeollfgresqufllkz.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imttcnhlb2xsZmdyZXNxdWZsbGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Mjc5NDgsImV4cCI6MjA5MjAwMzk0OH0.gePqjZaBJMExs9BCmUcKnbTIMqHEc0hSZbTljTBOai0",

  // ──────────────────────────────────────────────────────────────
  // NOME DO EDGE FUNCTION (não alterar se usou o padrão)
  // ──────────────────────────────────────────────────────────────
  AI_FUNCTION_NAME: "ai-proxy",

  // ──────────────────────────────────────────────────────────────
  // CONFIGURAÇÕES DO APP
  // ──────────────────────────────────────────────────────────────
  APP_NAME:    "RecrutadorIA",
  APP_VERSION: "2.0.0",
  DEMO_MODE:   false,
};

// Validação em tempo de carregamento
(function validateConfig() {
  const missing = [];
  if (!RECRUTADOR_CONFIG.SUPABASE_URL || RECRUTADOR_CONFIG.SUPABASE_URL.startsWith("COLE_")) {
    missing.push("SUPABASE_URL");
  }
  if (!RECRUTADOR_CONFIG.SUPABASE_ANON_KEY || RECRUTADOR_CONFIG.SUPABASE_ANON_KEY.startsWith("COLE_")) {
    missing.push("SUPABASE_ANON_KEY");
  }
  if (missing.length && !RECRUTADOR_CONFIG.DEMO_MODE) {
    console.warn(
      `[RecrutadorIA] config.js incompleto. Campos faltando: ${missing.join(", ")}.\n` +
      "O app rodará em MODO DEMO até que o config.js seja preenchido.\n" +
      "Consulte SETUP.md para instruções."
    );
    RECRUTADOR_CONFIG.DEMO_MODE = true;
  }
})();
