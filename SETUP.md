# RecrutadorIA — Guia de Setup Completo

## Visão Geral da Arquitetura

```
Browser (index.html)
    │
    ├── config.js          ← Supabase URL + anon key (PÚBLICO, sem risco)
    │
    └── Supabase
           ├── Auth         ← Login / Registro / JWT
           ├── PostgreSQL   ← Dados isolados por empresa (RLS)
           ├── Storage      ← Currículos e documentos KB
           └── Edge Function: ai-proxy
                   └── Chave de IA (NUNCA sai do servidor)
                           ├── Anthropic Claude
                           ├── OpenAI
                           └── Google Gemini
```

---

## Passo 1 — Criar Projeto no Supabase

1. Acesse [app.supabase.com](https://app.supabase.com) e clique em **New Project**
2. Escolha um nome (ex: `recrutadoria`) e defina uma senha forte para o banco
3. Aguarde ~2 minutos até o projeto estar pronto

---

## Passo 2 — Executar o Schema SQL

1. No painel do Supabase, vá em **SQL Editor**
2. Clique em **New Query**
3. Copie todo o conteúdo de `supabase/migrations/001_schema.sql` e cole
4. Clique em **Run** (deve executar sem erros)

---

## Passo 3 — Criar os Buckets de Storage

No **SQL Editor**, execute:

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('resumes', 'resumes', false),
       ('kb-docs', 'kb-docs', false);

CREATE POLICY "resume_upload" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'resumes');

CREATE POLICY "kb_company_access" ON storage.objects
  FOR ALL USING (
    bucket_id = 'kb-docs'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM profiles WHERE id = auth.uid()
    )
  );
```

---

## Passo 4 — Preencher o config.js

1. No Supabase, vá em **Settings → API**
2. Copie:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** → `SUPABASE_ANON_KEY`
3. Abra `config.js` e substitua os valores:

```js
SUPABASE_URL:      "https://SEU_PROJETO.supabase.co",
SUPABASE_ANON_KEY: "eyJ...",
```

> ✅ Estas chaves são **seguras** para ficarem no código público.
> O Supabase as protege via RLS (cada empresa vê apenas seus dados).

---

## Passo 5 — Configurar as Chaves de IA (Edge Function)

### 5a. Instalar o Supabase CLI

```bash
npm install -g supabase
supabase login
supabase link --project-ref SEU_PROJECT_REF
```

O `project-ref` está na URL do dashboard: `app.supabase.com/project/SEU_PROJECT_REF`

### 5b. Definir os Secrets (chaves NUNCA no código)

Escolha **um** dos providers abaixo (ou todos, e defina `AI_PROVIDER`):

**Anthropic Claude** (recomendado — créditos gratuitos em console.anthropic.com):
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-SUA_CHAVE_AQUI
supabase secrets set AI_PROVIDER=anthropic
```

**Google Gemini** (100% gratuito — aistudio.google.com):
```bash
supabase secrets set GEMINI_API_KEY=AIzaSy-SUA_CHAVE_AQUI
supabase secrets set AI_PROVIDER=gemini
```

**OpenAI** (platform.openai.com):
```bash
supabase secrets set OPENAI_API_KEY=sk-SUA_CHAVE_AQUI
supabase secrets set AI_PROVIDER=openai
```

**Ajustar rate limit** (opcional):
```bash
supabase secrets set RATE_LIMIT_RPM=20
```

### 5c. Fazer deploy da Edge Function

```bash
supabase functions deploy ai-proxy --no-verify-jwt
```

---

## Passo 6 — Deploy do Frontend

O `index.html` + `config.js` são arquivos estáticos. Opções:

### Vercel (recomendado, gratuito)
```bash
npx vercel --prod
```

### Netlify
Arraste a pasta do projeto para [app.netlify.com](https://app.netlify.com)

### GitHub Pages
1. Faça push do repositório
2. Vá em Settings → Pages → Branch: main

### Localmente (testes)
```bash
# Com Python:
python -m http.server 8080

# Com Node:
npx serve .
```

> ⚠️ Não abra diretamente como `file://` — o CORS bloqueia chamadas ao Supabase.

---

## Onde ficam as chaves de API

| Chave | Onde fica | Seguro? |
|---|---|---|
| `SUPABASE_URL` | `config.js` (frontend) | ✅ Sim (protegido por RLS) |
| `SUPABASE_ANON_KEY` | `config.js` (frontend) | ✅ Sim (protegido por RLS) |
| `ANTHROPIC_API_KEY` | Supabase Secrets (servidor) | ✅ Nunca exposta ao browser |
| `OPENAI_API_KEY` | Supabase Secrets (servidor) | ✅ Nunca exposta ao browser |
| `GEMINI_API_KEY` | Supabase Secrets (servidor) | ✅ Nunca exposta ao browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Nunca no frontend | ✅ Apenas scripts admin |

---

## Modo Demo (sem Supabase configurado)

Se o `config.js` não estiver preenchido, o app roda em **Modo Demo** automaticamente:
- Dados simulados em memória (sem banco)
- Persiste no `localStorage` do navegador
- Funciona offline para apresentações
- Banner laranja indica que é modo demo

Para desativar o modo demo, preencha `config.js` com as chaves reais.

---

## Segurança Implementada

- **RLS no banco**: cada empresa vê apenas seus próprios dados
- **Chaves de IA no servidor**: Edge Function intercepta todas as chamadas
- **Rate limiting**: 20 req/min por IP na Edge Function (configurável)
- **Sanitização de inputs**: todos os dados passam por `sanitize()` antes de renderizar
- **Sem SQL injection**: queries via Supabase client tipado
- **Autenticação JWT**: Supabase Auth gerencia tokens automaticamente
- **Validação de senha**: mínimo 8 chars, 1 maiúscula, 1 número

---

## Estrutura de Arquivos

```
RecrutadorIA/
├── index.html                    ← App completo (UI + lógica Supabase)
├── config.js                     ← Chaves públicas (preencher aqui)
├── .env.example                  ← Template de variáveis secretas
├── SETUP.md                      ← Este guia
└── supabase/
    ├── migrations/
    │   └── 001_schema.sql        ← Executar no SQL Editor
    └── functions/
        └── ai-proxy/
            └── index.ts          ← Edge Function (deploy via CLI)
```
