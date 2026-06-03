-- ============================================================
-- 002 — Hardening de segurança (RLS, colunas, storage)
-- Origem: relatórios de consultoria (Segurança + Aptidão de Venda), 2026-06.
-- Aplicada em produção via Supabase em 2026-06-02.
-- ============================================================

-- 1) COMPANIES: anônimo só pode ler id e name (esconde CNPJ, brand_analysis,
--    instagram, website_url, etc.). O recrutador autenticado segue com acesso total.
REVOKE SELECT ON public.companies FROM anon;
GRANT  SELECT (id, name) ON public.companies TO anon;

-- 2) CANDIDATES: anônimo (candidato) só pode atualizar as colunas de resultado
--    da IA e apenas em registros recém-criados (janela de 2h), nunca mudar
--    identidade/empresa/e-mail de qualquer candidato.
REVOKE UPDATE ON public.candidates FROM anon;
GRANT  UPDATE (score_final, disc, recommendation, ai_report) ON public.candidates TO anon;

DROP POLICY IF EXISTS candidates_anon_update ON public.candidates;
CREATE POLICY candidates_anon_update ON public.candidates
  FOR UPDATE TO anon
  USING      (created_at > now() - interval '2 hours')
  WITH CHECK (created_at > now() - interval '2 hours');

-- 3) STORAGE (resumes): tornar o bucket privado e remover a leitura anônima.
--    Currículos passam a ser acessados pelo recrutador via URL assinada.
UPDATE storage.buckets SET public = false WHERE id = 'resumes';
DROP POLICY IF EXISTS resumes_anon_read ON storage.objects;

-- 4) HARDENING DE FUNÇÕES: fixa search_path (corrige alerta do linter).
ALTER FUNCTION public.set_updated_at()  SET search_path = public, pg_temp;
ALTER FUNCTION public.my_company_id()   SET search_path = public, pg_temp;

-- 5) Remove exposição RPC de funções que são apenas gatilhos internos
--    (não devem ser chamáveis via API). Os gatilhos continuam funcionando.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()   FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_job_stats()  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at()    FROM anon, authenticated;
