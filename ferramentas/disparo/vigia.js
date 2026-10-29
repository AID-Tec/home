#!/usr/bin/env node
/* =========================================================================
   VIGIA da rotina do Pacto — ferramentas/disparo/vigia.js
   ---------------------------------------------------------------------------
   Por que existe: o rotina.yml avisa a cada execução (sucesso ou falha), mas
   NÃO avisa quando nada acontece — cron que não dispara, workflow travado,
   envio que roda e não sai nada. O dono só descobre vendo o GitHub.

   Este script roda 1x por dia (20:30 de Brasília, depois do último gatilho)
   e responde UMA pergunta: "a rotina de hoje rodou e enviou?"

   O que olha (tudo leitura, nada é enviado):
     1. os runs do workflow "Pacto · rotina de envio" criados HOJE;
     2. se os 3 gatilhos (9h, 15h, 18h de Brasília) dispararam;
     3. quantos e-mails saíram hoje (tabela envios do painel);
     4. o tamanho da fila (dry-run do próprio disparar.js).

   Depois manda UM aviso no WhatsApp/Telegram (notifier local, com reserva no
   Render) com o veredito. Sem dado de prospecto na mensagem — só contagem
   (o log do Actions é público, mesma regra do modo sigilo do disparar.js).

   Uso:
     node vigia.js               avisa (é o que o Actions roda)
     node vigia.js --sem-aviso   só imprime o que seria mandado (teste)
   ========================================================================= */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const BASE = path.join(__dirname, '..', '..');
const ARQ_ENV = path.join(BASE, '.env');
const NOME_WORKFLOW = 'Pacto · rotina de envio';
const RITMO_DIA = 10;
const TZ = 'America/Sao_Paulo';
const GATILHOS_UTC = [12, 18, 21];      // 09:00, 15:00 e 18:00 de Brasília
const TOL_ATRASO_MIN = 210;             // o GitHub já atrasou 3h; 17:51 p/ 18:00
const DIA_EN = { Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex',
                 Sat: 'sab', Sun: 'dom' };

/* ----------------------------- leituras --------------------------------- */
function leChaves() {
  const env = Object.assign({}, process.env);
  try {
    require('fs').readFileSync(ARQ_ENV, 'utf8').split(/\r?\n/).forEach(linha => {
      const l = linha.trim();
      if (!l || l[0] === '#' || l.indexOf('=') < 1) return;
      const k = l.slice(0, l.indexOf('=')).trim();
      let v = l.slice(l.indexOf('=') + 1).trim();
      if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
      if (!(k in env) || env[k] === '') env[k] = v;
    });
  } catch (e) { /* sem arquivo: só o ambiente */ }
  return env;
}

function cfgApp() {
  const fs = require('fs');
  const txt = fs.readFileSync(path.join(BASE, 'pacto', 'app.js'), 'utf8');
  const url = /var SB_URL\s*=\s*'([^']+)'/.exec(txt);
  const key = /var SB_KEY\s*=\s*'([^']+)'/.exec(txt);
  if (!url || !key) throw new Error('nao achei SB_URL/SB_KEY em pacto/app.js');
  return { url: url[1], anon: key[1] };
}

/* relógio de Brasília — mesma ideia do brl() do disparar.js */
function brt(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return {
    iso: g('year') + '-' + g('month') + '-' + g('day'),
    hora: Number(g('hour')),
    rotulo: (DIA_EN[g('weekday')] || g('weekday')) + ' ' + g('day') + '/' + g('month') +
            ' ' + g('hour') + ':' + g('minute')
  };
}

/* ------------------------------ GitHub ---------------------------------- */
async function gh(tok, caminho) {
  const r = await fetch('https://api.github.com/' + caminho, {
    headers: { Authorization: 'token ' + tok, Accept: 'application/vnd.github+json',
               'User-Agent': 'aid-vigia' }
  });
  if (!r.ok) throw new Error('GitHub ' + caminho + ' -> ' + r.status);
  return r.json();
}

/* gatilhos de hoje que NÃO dispararam (janela: -15min a +210min do cron) */
function gatilhosFaltando(runs) {
  const faltando = [];
  for (const h of GATILHOS_UTC) {
    const alvo = h * 60;
    const achou = runs.some(r => {
      if ((r.event || '') !== 'schedule') return false;
      const d = new Date(r.created_at);
      const min = d.getUTCHours() * 60 + d.getUTCMinutes();
      const naJanela = m => m >= alvo - 15 && m <= alvo + TOL_ATRASO_MIN;
      return naJanela(min) || naJanela(min + 1440);
    });
    if (!achou) faltando.push(String(h - 3).padStart(2, '0') + 'h');  // UTC-3 = BRT
  }
  return faltando;
}

/* -------------------------- painel e fila ------------------------------- */
async function enviadosHoje(cfg, env, isoDia) {
  const r = await fetch(cfg.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: cfg.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.PACTO_EMAIL, password: env.PACTO_SENHA })
  });
  if (!r.ok) throw new Error('login do painel falhou (' + r.status + ')');
  const tok = (await r.json()).access_token;
  const ini = isoDia + 'T03:00:00.000Z';            // 00:00 de Brasília
  const q = await fetch(cfg.url + '/rest/v1/envios?select=id&enviado_em=gte.' +
    encodeURIComponent(ini) + '&limit=10000',
    { headers: { apikey: cfg.anon, Authorization: 'Bearer ' + tok } });
  if (!q.ok) throw new Error('nao li envios (' + q.status + ')');
  return (await q.json()).length;
}

/* fila: reaproveita o dry-run testado do disparar.js (nada sai no --rotina) */
function lerFila() {
  const vazio = { vencidos: null, aguardando: null };
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, 'disparar.js'), '--rotina'],
      { cwd: BASE, encoding: 'utf8', timeout: 180000, env: process.env,
        maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    out = String(e.stdout || '');      // pode sair com código != 0 e ainda ter a lista
  }
  if (!out) return vazio;
  const v = /vencidos pra enviar \.+\s*(\d+)/.exec(out);
  const a = /aguardando vencer \.+\s*(\d+)/.exec(out);
  return { vencidos: v ? Number(v[1]) : null, aguardando: a ? Number(a[1]) : null };
}

/* ------------------------------ aviso ----------------------------------- */
async function avisar(env, titulo, mensagem) {
  const local = env.NOTIFIER_LOCAL_URL;
  const nuvem = env.NOTIFIER_URL;
  const chave = env.NOTIFIER_KEY;
  if (!local && !nuvem) { console.log('[sem notifier configurado]'); return false; }
  const corpo = JSON.stringify({ fonte: 'github-actions', titulo, mensagem });
  const manda = async url => {
    try {
      const r = await fetch(url + '/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-notifier-key': chave || '' },
        body: corpo
      });
      return r.ok;
    } catch (e) { return false; }
  };
  if (local && await manda(local)) return true;
  if (nuvem && await manda(nuvem)) return true;
  return false;
}

/* ------------------------------- main ----------------------------------- */
(async function main() {
  const semAviso = process.argv.includes('--sem-aviso');
  const env = leChaves();
  const agora = new Date();
  const hoje = brt(agora);

  /* 1) runs de hoje */
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || env.TOKEN_CLASSIC;
  const repo = process.env.GITHUB_REPOSITORY || 'AID-Tec/home';
  if (!token) throw new Error('sem token do GitHub (GH_TOKEN ou TOKEN_CLASSIC)');

  const wfs = await gh(token, 'repos/' + repo + '/actions/workflows?per_page=100');
  const wf = (wfs.workflows || []).find(w => w.name === NOME_WORKFLOW);
  if (!wf) throw new Error('nao achei o workflow "' + NOME_WORKFLOW + '"');

  const rr = await gh(token, 'repos/' + repo + '/actions/workflows/' + wf.id +
    '/runs?per_page=50');
  const runs = (rr.workflow_runs || []).filter(r => brt(new Date(r.created_at)).iso === hoje.iso);
  const agendados = runs.filter(r => (r.event || '') === 'schedule');
  const ok = runs.filter(r => r.conclusion === 'success').length;
  const falhou = runs.filter(r => r.conclusion === 'failure').length;
  const rodando = runs.filter(r => r.status === 'queued' || r.status === 'in_progress').length;
  const faltando = gatilhosFaltando(agendados);

  /* 2) quanto saiu hoje + fila */
  const cfg = cfgApp();
  const enviados = await enviadosHoje(cfg, env, hoje.iso);
  const fila = lerFila();

  /* 3) veredito
     Só depois das 19h de Brasília dá pra julgar "os gatilhos de hoje" — antes
     disso o dia mal começou e a fila ainda está em faixa futura (o --rotina
     esconde o que só sai às 9h/15h/18h). Rodando cedo, ele só informa. */
  const depoisDosGatilhos = hoje.hora >= 19;
  let nivel = 'ok';                    // ok | alerta | erro
  const motivos = [];
  if (!depoisDosGatilhos) {
    nivel = 'info';
    motivos.push('fora do horário de verificação (20:30) — só leitura, sem julgar o dia.');
  } else if (agendados.length === 0 && rodando === 0) {
    nivel = 'erro';
    motivos.push('NENHUM gatilho disparou hoje — o cron não rodou.');
  } else if (faltando.length) {
    nivel = 'alerta';
    motivos.push('gatilho das ' + faltando.join(' e ') + ' não disparou (ou está atrasado).');
  }
  if (depoisDosGatilhos) {
    if (falhou) {
      if (nivel !== 'erro') nivel = 'alerta';
      motivos.push(falhou + ' execução(ões) FALHOU — ver o log do Actions.');
    }
    if (enviados === 0 && (fila.vencidos || 0) > 0 && agendados.length + rodando > 0) {
      nivel = 'erro';
      motivos.push('rodou mas NADA saiu (' + fila.vencidos +
        ' vencidos na fila) — pode ser cofre de segredos vazio ou trava de horário.');
    } else if (enviados > 0 && enviados < RITMO_DIA && (fila.vencidos || 0) >= RITMO_DIA) {
      if (nivel === 'ok') nivel = 'alerta';
      motivos.push('só ' + enviados + ' de ' + RITMO_DIA + ' saíram com ' +
        fila.vencidos + ' vencidos.');
    }
    if (rodando) motivos.push(rodando + ' execução ainda rodando.');
  }

  const icone = nivel === 'erro' ? '🔴' : nivel === 'alerta' ? '⚠️' :
    nivel === 'info' ? 'ℹ️' : '✅';
  const titulo = icone + ' Pacto · vigia ' +
    (nivel === 'ok' ? '— tudo certo' : nivel === 'alerta' ? '— atenção' :
     nivel === 'info' ? '— leitura' : '— PROBLEMA');

  const linhas = [
    hoje.rotulo,
    'gatilhos: ' + (agendados.length + rodando) + ' de ' + GATILHOS_UTC.length +
      (ok ? ' · ' + ok + ' ok' : '') + (falhou ? ' · ' + falhou + ' falhou ❌' : ''),
    'enviados hoje: ' + enviados + ' de ' + RITMO_DIA,
    'fila: ' + (fila.vencidos != null ? fila.vencidos + ' vencidos' : '?') +
      (fila.aguardando != null ? ' · ' + fila.aguardando + ' aguardando' : '')
  ];
  if (motivos.length) {
    linhas.push('');
    motivos.forEach(m => linhas.push('• ' + m));
    linhas.push('');
    linhas.push('https://github.com/' + repo + '/actions');
  }
  const mensagem = linhas.join('\n');

  console.log(titulo);
  console.log('-'.repeat(60));
  console.log(mensagem);

  if (semAviso) { console.log('\n(--sem-aviso: nada foi mandado)'); return; }

  const entregue = await avisar(env, titulo, mensagem);
  console.log('\naviso: ' + (entregue ? 'entregue ✓' : 'NÃO entregue (notifier off?)'));
  if (!entregue) process.exitCode = 1;   // o Actions mostra vermelho e tenta de novo
})().catch(e => {
  console.error('VIGIA QUEBROU: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
