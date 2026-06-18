-- ============================================================
-- 005 — Análises de Perfil (Assessment público)
-- Aplicada em produção via Supabase em 2026-06-17.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profile_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  name        text,
  email       text,
  area        text,
  score       integer,
  disc        text,
  strengths   text[],
  weaknesses  text[],
  ai_analysis text
);

CREATE INDEX IF NOT EXISTS idx_profile_analyses_created ON public.profile_analyses (created_at DESC);

-- RLS: anon só INSERT, admin lê via RPC (service_role)
ALTER TABLE public.profile_analyses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_analyses FROM anon, authenticated;
GRANT INSERT ON public.profile_analyses TO anon;

-- RPC para o admin listar as análises (protegida por senha)
CREATE OR REPLACE FUNCTION public.admin_list_profile_analyses(p_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT admin_verify(p_password) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  SELECT jsonb_agg(r ORDER BY r.created_at DESC)
    INTO v
    FROM (
      SELECT id, created_at, name, email, area, score, disc,
             strengths, weaknesses, left(ai_analysis, 300) AS ai_analysis
        FROM profile_analyses
       ORDER BY created_at DESC
       LIMIT 100
    ) r;
  RETURN COALESCE(v, '[]'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION public.admin_list_profile_analyses(text) TO anon, authenticated;
