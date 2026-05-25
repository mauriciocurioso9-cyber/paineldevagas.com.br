-- ============================================================
-- RecrutadorIA — Supabase Schema v1
-- Executa no SQL Editor do Supabase Dashboard
-- ============================================================

-- ─── EXTENSÕES ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── COMPANIES ───────────────────────────────────────────────
CREATE TABLE companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  cnpj          TEXT,
  sector        TEXT,
  size          TEXT,
  website_url   TEXT,
  instagram     TEXT,
  brand_analysis JSONB,              -- resultado do brand mining
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PROFILES (usuários recrutadores) ────────────────────────
-- Estende auth.users do Supabase
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id    UUID REFERENCES companies(id) ON DELETE SET NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'recruiter',  -- recruiter | admin
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── JOBS ────────────────────────────────────────────────────
CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  seniority_level     TEXT NOT NULL DEFAULT 'Pleno',
  problem_description TEXT NOT NULL,
  activities          TEXT NOT NULL,
  attitudes           TEXT,
  objectives_90_days  TEXT,
  must_have           TEXT[] NOT NULL DEFAULT '{}',
  nice_to_have        TEXT,
  team_context        TEXT,
  city                TEXT,
  status              TEXT NOT NULL DEFAULT 'active',  -- active | paused | closed
  has_q2              BOOLEAN NOT NULL DEFAULT FALSE,
  candidates_count    INT NOT NULL DEFAULT 0,
  avg_score           NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── CLARITY QUESTIONS (perguntas de diagnóstico por vaga) ───
CREATE TABLE clarity_questions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  sort_order INT  NOT NULL DEFAULT 0
);

-- ─── Q1 QUESTIONS (múltipla escolha — triagem cultural) ──────
CREATE TABLE q1_questions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  options       TEXT[] NOT NULL,   -- 4 opções
  correct_option TEXT NOT NULL,    -- 'A'|'B'|'C'|'D'
  category      TEXT,
  disc_tag      TEXT,
  sort_order    INT NOT NULL DEFAULT 0
);

-- ─── Q2 QUESTIONS (abertas — mentalidade) ────────────────────
CREATE TABLE q2_questions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  category      TEXT,
  sort_order    INT NOT NULL DEFAULT 0
);

-- ─── CANDIDATES ──────────────────────────────────────────────
CREATE TABLE candidates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  resume_text   TEXT,              -- texto extraído do PDF/DOCX
  score_q1      NUMERIC(5,2),
  score_q2      NUMERIC(5,2),
  score_resume  NUMERIC(5,2),
  score_final   NUMERIC(5,2),
  disc          TEXT,
  recommendation TEXT,             -- CONTRATAR | NÃO CONTRATAR | RISCO CALCULADO
  ai_report     JSONB,             -- relatório completo gerado pela IA
  status        TEXT NOT NULL DEFAULT 'IN_PROGRESS',  -- IN_PROGRESS | COMPLETED | REJECTED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, email)
);

-- ─── Q1 ANSWERS ──────────────────────────────────────────────
CREATE TABLE candidate_q1_answers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id  UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES q1_questions(id) ON DELETE CASCADE,
  selected_option TEXT NOT NULL,   -- 'A'|'B'|'C'|'D'
  is_correct    BOOLEAN,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(candidate_id, question_id)
);

-- ─── Q2 ANSWERS ──────────────────────────────────────────────
CREATE TABLE candidate_q2_answers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id  UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES q2_questions(id) ON DELETE CASCADE,
  answer_text   TEXT NOT NULL,
  ai_score      NUMERIC(5,2),      -- score dado pela IA para esta resposta
  ai_feedback   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(candidate_id, question_id)
);

-- ─── KNOWLEDGE BASE DOCUMENTS ────────────────────────────────
CREATE TABLE kb_documents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  content     TEXT,                -- texto extraído (sem binário)
  file_name   TEXT,
  file_size   TEXT,
  storage_path TEXT,               -- path no Supabase Storage
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AI FEEDBACK (treinamento contínuo) ──────────────────────
CREATE TABLE ai_feedback (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  candidate_id  UUID REFERENCES candidates(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,     -- HIRED | REJECTED_INTERVIEW | FEEDBACK_Q
  ai_score      NUMERIC(5,2),
  real_result   TEXT,
  star_rating   INT CHECK (star_rating BETWEEN 1 AND 5),
  comments      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AUDIT LOG ───────────────────────────────────────────────
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  company_id  UUID,
  user_id     UUID,
  action      TEXT NOT NULL,
  table_name  TEXT,
  record_id   UUID,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES
-- ============================================================
CREATE INDEX idx_jobs_company       ON jobs(company_id);
CREATE INDEX idx_candidates_job     ON candidates(job_id);
CREATE INDEX idx_candidates_company ON candidates(company_id);
CREATE INDEX idx_candidates_email   ON candidates(email);
CREATE INDEX idx_kb_company         ON kb_documents(company_id);
CREATE INDEX idx_q1_job             ON q1_questions(job_id);
CREATE INDEX idx_q2_job             ON q2_questions(job_id);
CREATE INDEX idx_ai_feedback_co     ON ai_feedback(company_id);

-- ============================================================
-- TRIGGERS: updated_at automático
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_candidates_updated_at
  BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- TRIGGER: atualiza avg_score e candidates_count na vaga
-- ============================================================
CREATE OR REPLACE FUNCTION update_job_stats()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE jobs
  SET
    candidates_count = (SELECT COUNT(*) FROM candidates WHERE job_id = NEW.job_id),
    avg_score        = COALESCE((SELECT AVG(score_final) FROM candidates WHERE job_id = NEW.job_id AND score_final IS NOT NULL), 0),
    updated_at       = NOW()
  WHERE id = NEW.job_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_job_stats
  AFTER INSERT OR UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION update_job_stats();

-- ============================================================
-- TRIGGER: cria profile automaticamente após signup
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Recrutador'),
    'recruiter'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Cada empresa vê SOMENTE seus próprios dados.
-- ============================================================

ALTER TABLE companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE clarity_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE q1_questions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE q2_questions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_q1_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_q2_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log       ENABLE ROW LEVEL SECURITY;

-- Helper: retorna o company_id do usuário logado
CREATE OR REPLACE FUNCTION my_company_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT company_id FROM profiles WHERE id = auth.uid();
$$;

-- ── companies ──
CREATE POLICY "company_self" ON companies
  FOR ALL USING (id = my_company_id());

-- ── profiles ──
CREATE POLICY "profile_self" ON profiles
  FOR ALL USING (
    id = auth.uid()
    OR company_id = my_company_id()
  );

-- ── jobs ──
CREATE POLICY "jobs_company" ON jobs
  FOR ALL USING (company_id = my_company_id());

-- ── clarity_questions ──
CREATE POLICY "clarity_company" ON clarity_questions
  FOR ALL USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = my_company_id())
  );

-- ── q1_questions ──
CREATE POLICY "q1_company" ON q1_questions
  FOR ALL USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = my_company_id())
  );

-- ── q2_questions ──
CREATE POLICY "q2_company" ON q2_questions
  FOR ALL USING (
    job_id IN (SELECT id FROM jobs WHERE company_id = my_company_id())
  );

-- ── candidates ──
-- Recrutadores leem/gerenciam. Candidatos (anon) só inserem o próprio registro.
CREATE POLICY "candidates_recruiter" ON candidates
  FOR ALL USING (company_id = my_company_id());

CREATE POLICY "candidates_public_insert" ON candidates
  FOR INSERT WITH CHECK (TRUE);

-- ── candidate_q1_answers ──
CREATE POLICY "q1ans_recruiter" ON candidate_q1_answers
  FOR ALL USING (
    candidate_id IN (SELECT id FROM candidates WHERE company_id = my_company_id())
  );

CREATE POLICY "q1ans_public_insert" ON candidate_q1_answers
  FOR INSERT WITH CHECK (TRUE);

-- ── candidate_q2_answers ──
CREATE POLICY "q2ans_recruiter" ON candidate_q2_answers
  FOR ALL USING (
    candidate_id IN (SELECT id FROM candidates WHERE company_id = my_company_id())
  );

CREATE POLICY "q2ans_public_insert" ON candidate_q2_answers
  FOR INSERT WITH CHECK (TRUE);

-- ── kb_documents ──
CREATE POLICY "kb_company" ON kb_documents
  FOR ALL USING (company_id = my_company_id());

-- ── ai_feedback ──
CREATE POLICY "aifb_company" ON ai_feedback
  FOR ALL USING (company_id = my_company_id());

-- ── audit_log: somente inserção, sem leitura direta via anon ──
CREATE POLICY "audit_insert" ON audit_log
  FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "audit_read_company" ON audit_log
  FOR SELECT USING (company_id = my_company_id());

-- ── q1_questions e q2_questions: leitura pública (candidatos precisam) ──
-- mas escrita apenas pelo recrutador da empresa dona
CREATE POLICY "q1_public_read" ON q1_questions
  FOR SELECT USING (TRUE);

CREATE POLICY "q2_public_read" ON q2_questions
  FOR SELECT USING (TRUE);

-- ============================================================
-- STORAGE BUCKET para currículos e KB docs
-- (executar separadamente no dashboard Supabase > Storage)
-- ============================================================
-- INSERT INTO storage.buckets (id, name, public) VALUES
--   ('resumes', 'resumes', false),
--   ('kb-docs', 'kb-docs', false);
--
-- CREATE POLICY "resume_upload" ON storage.objects
--   FOR INSERT WITH CHECK (bucket_id = 'resumes');
--
-- CREATE POLICY "kb_company_access" ON storage.objects
--   FOR ALL USING (
--     bucket_id = 'kb-docs'
--     AND (storage.foldername(name))[1] = my_company_id()::text
--   );
