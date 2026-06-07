-- ============================================================
-- 003 — Auditoria das chamadas de IA (monitoramento/saúde)
-- Aplicada em produção via Supabase em 2026-06-07.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_call_logs (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  kind        text,
  provider    text,
  success     boolean NOT NULL,
  latency_ms  integer,
  error       text,
  origin      text
);

CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON public.ai_call_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_fail    ON public.ai_call_logs (created_at DESC) WHERE NOT success;

-- RLS travado: ninguém lê via anon/authenticated. A Edge Function grava com service_role
-- (ignora RLS) e o admin lê via RPC abaixo.
ALTER TABLE public.ai_call_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_call_logs FROM anon, authenticated;

-- Estatísticas de saúde da IA para o painel admin (protegido por senha).
CREATE OR REPLACE FUNCTION public.admin_ai_stats(p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT admin_verify(p_password) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  SELECT jsonb_build_object(
    'total_24h',      count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
    'ok_24h',         count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND success),
    'fail_24h',       count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND NOT success),
    'avg_latency_ms', round(avg(latency_ms) FILTER (WHERE created_at > now() - interval '24 hours' AND success)),
    'last_success_at',(SELECT max(created_at) FROM ai_call_logs WHERE success),
    'last_error',     (SELECT jsonb_build_object('error', left(error,300), 'kind', kind, 'at', created_at)
                         FROM ai_call_logs WHERE NOT success ORDER BY created_at DESC LIMIT 1),
    'recent',         (SELECT jsonb_agg(r) FROM (
                         SELECT created_at, kind, provider, success, latency_ms, left(error,160) AS error
                         FROM ai_call_logs ORDER BY created_at DESC LIMIT 12) r)
  ) INTO v
  FROM ai_call_logs;
  RETURN COALESCE(v, jsonb_build_object('total_24h', 0));
END $$;

GRANT EXECUTE ON FUNCTION public.admin_ai_stats(text) TO anon, authenticated;
