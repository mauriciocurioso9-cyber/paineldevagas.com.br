/**
 * RecrutadorIA MCP Server
 *
 * Expõe o RecrutadorIA como ferramentas para Claude Code / agentes IA.
 * Permite consultar candidatos, vagas, relatórios e disparar análises.
 *
 * Configuração em ~/.claude/settings.json:
 * {
 *   "mcpServers": {
 *     "recrutadoria": {
 *       "command": "node",
 *       "args": ["caminho/para/mcp-server/dist/index.js"],
 *       "env": {
 *         "SUPABASE_URL": "https://xxx.supabase.co",
 *         "SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
 *       }
 *     }
 *   }
 * }
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Supabase (service role — bypassa RLS, apenas no servidor MCP) ──
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_SR_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SR_KEY) {
  console.error('[RecrutadorIA MCP] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.');
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SR_KEY);

// ── Helpers ────────────────────────────────────────────────────────
function fmt(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function scoreColor(s: number) {
  return s >= 80 ? '🟢' : s >= 65 ? '🟡' : '🔴';
}

function recLabel(r: string) {
  return r === 'CONTRATAR' ? '✅ CONTRATAR' : r === 'RISCO CALCULADO' ? '⚠️ RISCO CALCULADO' : '❌ NÃO CONTRATAR';
}

// ── Call Anthropic directly (para run_ai_analysis) ─────────────────
async function callClaude(prompt: string, maxTokens = 1500): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY não configurada no ambiente do MCP.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
  const data = await res.json() as { content: Array<{type: string; text: string}> };
  return data.content?.[0]?.text || '';
}

// ── Tool Definitions ───────────────────────────────────────────────
const TOOLS = [
  {
    name: 'recrutadoria_get_stats',
    description: 'Retorna estatísticas gerais da plataforma: total de empresas, vagas, candidatos e taxa de conclusão.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'recrutadoria_list_jobs',
    description: 'Lista vagas de uma empresa. Retorna título, status, candidatos e fit médio.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'ID da empresa (UUID). Opcional — sem ele lista todas.' },
        status:     { type: 'string', enum: ['active', 'paused', 'closed'], description: 'Filtro de status. Padrão: active.' },
        limit:      { type: 'number', description: 'Máximo de resultados. Padrão: 20.' },
      },
      required: [],
    },
  },
  {
    name: 'recrutadoria_get_job',
    description: 'Retorna detalhes completos de uma vaga: descrição, requisitos, questionários gerados e lista de candidatos.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'ID da vaga (UUID).' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'recrutadoria_list_candidates',
    description: 'Lista candidatos de uma vaga, ordenados por score. Inclui recomendação IA e perfil DISC.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id:     { type: 'string', description: 'ID da vaga.' },
        min_score:  { type: 'number', description: 'Score mínimo (0-100). Opcional.' },
        recommendation: { type: 'string', enum: ['CONTRATAR','RISCO CALCULADO','NÃO CONTRATAR'], description: 'Filtro por recomendação. Opcional.' },
        limit:      { type: 'number', description: 'Máximo de resultados. Padrão: 50.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'recrutadoria_get_candidate',
    description: 'Retorna perfil completo de um candidato: scores, relatório IA, respostas dissertativas (Q2) e pontos fortes/atenção.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'ID do candidato (UUID).' },
      },
      required: ['candidate_id'],
    },
  },
  {
    name: 'recrutadoria_search_candidates',
    description: 'Busca candidatos por nome ou e-mail em todas as vagas da plataforma.',
    inputSchema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Nome ou e-mail para buscar.' },
        company_id: { type: 'string', description: 'Restringir a uma empresa. Opcional.' },
        limit:      { type: 'number', description: 'Máximo de resultados. Padrão: 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recrutadoria_run_ai_analysis',
    description: 'Dispara (ou re-dispara) a análise comportamental por IA para um candidato que ainda não tem relatório gerado. Salva resultado no banco.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'ID do candidato.' },
      },
      required: ['candidate_id'],
    },
  },
  {
    name: 'recrutadoria_generate_interview_questions',
    description: 'Gera 10 questões estratégicas para entrevista presencial baseadas nas respostas reais do candidato. Busca contradições e pontos para aprofundar.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', description: 'ID do candidato.' },
        save:         { type: 'boolean', description: 'Salvar questões no banco de dados. Padrão: true.' },
      },
      required: ['candidate_id'],
    },
  },
] as const;

// ── Tool Handlers ──────────────────────────────────────────────────
async function handleGetStats(): Promise<string> {
  const [companies, jobs, jobsActive, candidates, completed] = await Promise.all([
    sb.from('companies').select('id', { count: 'exact', head: true }),
    sb.from('jobs').select('id', { count: 'exact', head: true }),
    sb.from('jobs').select('id', { count: 'exact', head: true }).eq('status','active'),
    sb.from('candidates').select('id', { count: 'exact', head: true }),
    sb.from('candidates').select('id', { count: 'exact', head: true }).eq('status','COMPLETED'),
  ]);
  const totalCands  = candidates.count || 0;
  const totalComp   = completed.count  || 0;
  const pct = totalCands > 0 ? Math.round((totalComp / totalCands) * 100) : 0;
  return `📊 **Estatísticas RecrutadorIA**

🏢 Empresas cadastradas:  ${companies.count ?? '—'}
💼 Vagas totais:          ${jobs.count ?? '—'}
✅ Vagas ativas:          ${jobsActive.count ?? '—'}
👥 Candidatos total:      ${totalCands}
🎯 Processos concluídos:  ${totalComp} (${pct}%)`;
}

async function handleListJobs(args: { company_id?: string; status?: string; limit?: number }): Promise<string> {
  const { company_id, status = 'active', limit = 20 } = args;
  let q = sb.from('jobs')
    .select('id,title,seniority_level,city,status,created_at,company_id,companies(name)')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (company_id) q = q.eq('company_id', company_id);
  const { data, error } = await q;
  if (error) throw new McpError(ErrorCode.InternalError, error.message);
  if (!data?.length) return 'Nenhuma vaga encontrada com os filtros informados.';

  // Conta candidatos por vaga
  const jobIds = data.map((j: Record<string,unknown>) => j.id as string);
  const { data: counts } = await sb
    .from('candidates')
    .select('job_id')
    .in('job_id', jobIds);
  const countMap: Record<string,number> = {};
  (counts || []).forEach((c: Record<string,unknown>) => {
    const jid = c.job_id as string;
    countMap[jid] = (countMap[jid] || 0) + 1;
  });

  const lines = data.map((j: Record<string,unknown>) => {
    const co = (j.companies as Record<string,unknown>)?.name as string || '—';
    return `• **${j.title}** (${co}) | ${j.seniority_level || '—'} | 📍${j.city||'—'} | 👥 ${countMap[j.id as string]||0} candidatos | ID: ${j.id}`;
  });
  return `💼 **Vagas [${status}]** — ${data.length} encontrada(s)\n\n${lines.join('\n')}`;
}

async function handleGetJob(args: { job_id: string }): Promise<string> {
  const { data: job, error } = await sb
    .from('jobs')
    .select('*,companies(name)')
    .eq('id', args.job_id)
    .single();
  if (error || !job) throw new McpError(ErrorCode.InternalError, 'Vaga não encontrada.');

  const { data: cands } = await sb
    .from('candidates')
    .select('id,full_name,score_final,recommendation,disc,status')
    .eq('job_id', args.job_id)
    .order('score_final', { ascending: false })
    .limit(10);

  const candLines = (cands || []).map((c: Record<string,unknown>) =>
    `  ${scoreColor(Number(c.score_final)||0)} ${c.full_name} | Score: ${c.score_final||'—'} | ${recLabel(c.recommendation as string||'')} | DISC: ${c.disc||'—'}`
  ).join('\n');

  return `💼 **${job.title}** — ${(job.companies as Record<string,unknown>)?.name || '—'}

📋 Status: ${job.status} | Nível: ${job.seniority_level} | 📍 ${job.city||'—'}
📅 Criada em: ${new Date(job.created_at).toLocaleDateString('pt-BR')}

**Problema / Dor:**
${job.problem_description || '—'}

**Atividades:**
${job.activities || '—'}

**Requisitos (Must Have):** ${(job.must_have || []).join(', ') || '—'}

**Top Candidatos (${(cands||[]).length}):**
${candLines || 'Nenhum candidato ainda.'}

ID da vaga: ${job.id}`;
}

async function handleListCandidates(args: { job_id: string; min_score?: number; recommendation?: string; limit?: number }): Promise<string> {
  const { job_id, min_score, recommendation, limit = 50 } = args;
  let q = sb.from('candidates')
    .select('id,full_name,email,score_q1,score_q2,score_final,disc,recommendation,status,created_at')
    .eq('job_id', job_id)
    .order('score_final', { ascending: false })
    .limit(limit);
  if (min_score  !== undefined) q = q.gte('score_final', min_score);
  if (recommendation) q = q.eq('recommendation', recommendation);
  const { data, error } = await q;
  if (error) throw new McpError(ErrorCode.InternalError, error.message);
  if (!data?.length) return 'Nenhum candidato encontrado com esses filtros.';

  const lines = data.map((c: Record<string,unknown>, i: number) => {
    const s = Number(c.score_final) || 0;
    return `${i+1}. ${scoreColor(s)} **${c.full_name}** <${c.email}>
   Score: ${c.score_final||'—'} (Q1:${c.score_q1||'—'} | Q2:${c.score_q2||'—'}) | DISC: ${c.disc||'—'}
   ${recLabel(c.recommendation as string||'')} | ${c.status} | ID: ${c.id}`;
  });
  return `👥 **Candidatos da vaga** — ${data.length} encontrado(s)\n\n${lines.join('\n\n')}`;
}

async function handleGetCandidate(args: { candidate_id: string }): Promise<string> {
  const { data: c, error } = await sb
    .from('candidates')
    .select('*,jobs(title)')
    .eq('id', args.candidate_id)
    .single();
  if (error || !c) throw new McpError(ErrorCode.InternalError, 'Candidato não encontrado.');

  const report = (c.ai_report as Record<string,unknown>) || {};
  const q2 = (report.q2_answers as Array<{pergunta:string;resposta:string;categoria:string}>) || [];
  const q2Text = q2.length
    ? q2.map((a,i) => `  ${i+1}. [${a.categoria}] ${a.pergunta}\n     → ${a.resposta||'(sem resposta)'}`)
       .join('\n\n')
    : '  Nenhuma resposta dissertativa registrada.';

  const fortes  = ((report.pontos_fortes  as string[]) || []).map(p => `  ✅ ${p}`).join('\n');
  const atencao = ((report.pontos_atencao as string[]) || []).map(p => `  ⚠️ ${p}`).join('\n');

  return `👤 **${c.full_name}** <${c.email}>
Vaga: ${(c.jobs as Record<string,unknown>)?.title || '—'} | Status: ${c.status}
Data: ${new Date(c.created_at).toLocaleDateString('pt-BR')}

📊 **Scores:**
  Q1 (Cultura):     ${c.score_q1 || '—'}
  Q2 (Mentalidade): ${c.score_q2 || '—'}
  Score Final:      ${scoreColor(Number(c.score_final)||0)} ${c.score_final || '—'}
  DISC:             ${c.disc || '—'}
  Recomendação:     ${recLabel(c.recommendation || '')}

🤖 **Análise IA:**
  Resumo: ${report.resumo as string || '(análise não gerada)'}
  Gerado em: ${report.gerado_em as string || '—'}

${fortes  ? `✅ **Pontos Fortes:**\n${fortes}\n` : ''}
${atencao ? `⚠️ **Pontos de Atenção:**\n${atencao}\n` : ''}

📝 **Respostas Dissertativas (Q2):**
${q2Text}

ID: ${c.id}`;
}

async function handleSearchCandidates(args: { query: string; company_id?: string; limit?: number }): Promise<string> {
  const { query, company_id, limit = 20 } = args;
  const term = `%${query}%`;
  let q = sb.from('candidates')
    .select('id,full_name,email,job_id,score_final,recommendation,status,jobs(title)')
    .or(`full_name.ilike.${term},email.ilike.${term}`)
    .order('score_final', { ascending: false })
    .limit(limit);
  if (company_id) q = q.eq('company_id', company_id);
  const { data, error } = await q;
  if (error) throw new McpError(ErrorCode.InternalError, error.message);
  if (!data?.length) return `Nenhum candidato encontrado para "${query}".`;

  const lines = data.map((c: Record<string,unknown>) =>
    `• **${c.full_name}** <${c.email}> | Vaga: ${(c.jobs as Record<string,unknown>)?.title||'—'} | Score: ${c.score_final||'—'} | ${recLabel(c.recommendation as string||'')} | ID: ${c.id}`
  );
  return `🔍 **Resultados para "${query}"** — ${data.length} encontrado(s)\n\n${lines.join('\n')}`;
}

async function handleRunAIAnalysis(args: { candidate_id: string }): Promise<string> {
  // Busca candidato
  const { data: c, error } = await sb
    .from('candidates')
    .select('*,jobs(title,activities,must_have)')
    .eq('id', args.candidate_id)
    .single();
  if (error || !c) throw new McpError(ErrorCode.InternalError, 'Candidato não encontrado.');

  const report = (c.ai_report as Record<string,unknown>) || {};
  const q2 = (report.q2_answers as Array<{pergunta:string;resposta:string;categoria:string}>) || [];
  const q2Text = q2.length
    ? q2.map((a,i) => `Q${i+1} [${a.categoria}]: ${a.pergunta}\nResposta: ${(a.resposta||'').substring(0,300)}`).join('\n\n')
    : '(sem respostas dissertativas)';

  const job = (c.jobs as Record<string,unknown>);
  const jobCtx = job ? `Vaga: ${job.title}. Requisitos: ${((job.must_have as string[])||[]).join(', ')}.` : '';

  const prompt = `Você é especialista em recrutamento comportamental.

${jobCtx}
CANDIDATO: ${c.full_name}
SCORES: Q1=${c.score_q1} Q2=${c.score_q2} Final=${c.score_final}
DISC estimado: ${c.disc} | Recomendação atual: ${c.recommendation}

RESPOSTAS Q2:
${q2Text}

Gere análise executiva. Responda SOMENTE em JSON minificado:
{"score":85,"disc":"D/I","rec":"CONTRATAR","pontos_fortes":["item1","item2","item3"],"pontos_atencao":["item1","item2"],"resumo":"texto"}`;

  const text = await callClaude(prompt, 1500);
  let parsed: Record<string,unknown>;
  try { parsed = JSON.parse(text.replace(/```json|```/g,'').trim()); }
  catch { throw new McpError(ErrorCode.InternalError, `IA retornou resposta inválida: ${text.slice(0,200)}`); }

  const aiScore = Math.min(100, Math.max(0, (parsed.score as number) || Number(c.score_final)));
  const aiReport = {
    score_ia:       aiScore,
    disc_ia:        parsed.disc || c.disc,
    recomendacao:   parsed.rec  || c.recommendation,
    resumo:         parsed.resumo || '',
    pontos_fortes:  parsed.pontos_fortes  || [],
    pontos_atencao: parsed.pontos_atencao || [],
    gerado_em:      new Date().toISOString(),
    q2_answers:     q2,
  };

  const { error: updErr } = await sb.from('candidates').update({
    score_final:    aiScore,
    disc:           aiReport.disc_ia,
    recommendation: aiReport.recomendacao,
    ai_report:      aiReport,
  }).eq('id', args.candidate_id);

  if (updErr) throw new McpError(ErrorCode.InternalError, `Erro ao salvar: ${updErr.message}`);

  return `✅ **Análise IA gerada e salva** para ${c.full_name}

Score IA:       ${scoreColor(aiScore)} ${aiScore}
DISC:           ${aiReport.disc_ia}
Recomendação:   ${recLabel(aiReport.recomendacao as string)}
Resumo:         ${aiReport.resumo}
Pontos Fortes:  ${(aiReport.pontos_fortes as string[]).join(' | ')}
Pontos Atenção: ${(aiReport.pontos_atencao as string[]).join(' | ')}`;
}

async function handleGenerateInterviewQuestions(args: { candidate_id: string; save?: boolean }): Promise<string> {
  const { candidate_id, save = true } = args;
  const { data: c, error } = await sb
    .from('candidates')
    .select('*,jobs(title,activities,must_have)')
    .eq('id', candidate_id)
    .single();
  if (error || !c) throw new McpError(ErrorCode.InternalError, 'Candidato não encontrado.');

  const report = (c.ai_report as Record<string,unknown>) || {};
  const q2 = (report.q2_answers as Array<{pergunta:string;resposta:string;categoria:string}>) || [];
  const q2Text = q2.length
    ? q2.map((a,i) => `P${i+1} [${a.categoria}]: ${a.pergunta}\nR: ${(a.resposta||'').substring(0,300)}`).join('\n\n')
    : '(sem respostas dissertativas)';

  const prompt = `Você é especialista em recrutamento comportamental.

CANDIDATO: ${c.full_name} | Vaga: ${(c.jobs as Record<string,unknown>)?.title||'—'}
Score: ${report.score_ia||c.score_final} | DISC: ${report.disc_ia||c.disc}
Resumo IA: ${report.resumo||'—'}
Pontos Atenção: ${((report.pontos_atencao as string[])||[]).join('; ')||'—'}

RESPOSTAS Q2:
${q2Text}

Gere 10 questões para entrevista presencial que:
1. Buscam contradições nas respostas
2. Aprofundam pontos de atenção
3. Reafirmam ou contradizem afirmações relevantes

Responda SOMENTE em JSON: [{"question":"...","intent":"...","probe":"..."}]`;

  const text = await callClaude(prompt, 2000);
  let questions: Array<{question:string;intent:string;probe:string}>;
  try {
    const raw = text.replace(/```json|```/g,'').trim();
    questions = JSON.parse(raw.startsWith('[') ? raw : raw.slice(raw.indexOf('[')));
    if (!Array.isArray(questions)) throw new Error('not array');
  } catch {
    throw new McpError(ErrorCode.InternalError, `IA retornou resposta inválida: ${text.slice(0,200)}`);
  }

  if (save) {
    const updReport = { ...(c.ai_report as object||{}), interview_questions: questions };
    await sb.from('candidates').update({ ai_report: updReport }).eq('id', candidate_id);
  }

  const lines = questions.slice(0,10).map((q,i) =>
    `**${i+1}. ${q.question}**\n   🎯 Objetivo: ${q.intent}\n   💡 Se vago: ${q.probe||'—'}`
  ).join('\n\n');

  return `🎯 **10 Questões para Entrevista** — ${c.full_name}\n\n${lines}\n\n${save ? '✅ Questões salvas no banco de dados.' : '(não salvo — use save:true para persistir)'}`;
}

// ── MCP Server ────────────────────────────────────────────────────
const server = new Server(
  { name: 'recrutadoria', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result: string;
    switch (name) {
      case 'recrutadoria_get_stats':
        result = await handleGetStats(); break;
      case 'recrutadoria_list_jobs':
        result = await handleListJobs(args as Parameters<typeof handleListJobs>[0]); break;
      case 'recrutadoria_get_job':
        result = await handleGetJob(args as Parameters<typeof handleGetJob>[0]); break;
      case 'recrutadoria_list_candidates':
        result = await handleListCandidates(args as Parameters<typeof handleListCandidates>[0]); break;
      case 'recrutadoria_get_candidate':
        result = await handleGetCandidate(args as Parameters<typeof handleGetCandidate>[0]); break;
      case 'recrutadoria_search_candidates':
        result = await handleSearchCandidates(args as Parameters<typeof handleSearchCandidates>[0]); break;
      case 'recrutadoria_run_ai_analysis':
        result = await handleRunAIAnalysis(args as Parameters<typeof handleRunAIAnalysis>[0]); break;
      case 'recrutadoria_generate_interview_questions':
        result = await handleGenerateInterviewQuestions(args as Parameters<typeof handleGenerateInterviewQuestions>[0]); break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Ferramenta desconhecida: ${name}`);
    }
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, String(err));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[RecrutadorIA MCP] Servidor iniciado e aguardando comandos...');
