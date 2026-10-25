#!/usr/env node
'use strict';
/* ==========================================================================
   disparar.js — dispara a sequência APROVADA do Pacto Gorjeta pela API do Brevo.

   Por que assim (e não "montar no Brevo à mão"):
   - o texto que sai é o que está APROVADO no banco (tabela copias), não uma
     cópia colada num e-mail de campanha e esquecida depois;
   - a lista é a MESMA regra da aba Campanha (tem e-mail · não é contador ·
     não está fora do escopo · 1 por e-mail) — painel e envio nunca divergem;
   - cada envio marca a linha como status='email' na hora, então o sorteio
     diário (que só pega quem está 'pendente') NUNCA volta a mandar pra quem
     já recebeu, e o placar do passo 4 enxerga o contato;
   - quem ainda está "sem decisão" (fora do segmento/CNPJ inativo que o dono
     não olhou) NÃO recebe: primeiro ele decide na validação.

   Segredos NUNCA no código e NUNCA no Git: a chave do Brevo e a senha do
   painel vêm de variável de ambiente ou de %LOCALAPPDATA%\aid\chaves.env
   (fora do repositório) — veja guarda_chave.ps1 e README.md.

   Padrões: dry-run por padrão (nada sai sem --enviar e --limite explícitos),
   cota diária do plano gratuito respeitada (300), pausa entre envios,
   retomável (quem já recebeu saiu da fila), LGPD (rodapé sempre anexado).

   Uso (ritmo do projeto: 10 por dia — não é cota do Brevo, é cadência):
     node disparar.js                          # só mostra o plano (dry-run)
     node disparar.js --enviar                 # manda os 10 do dia
     node disparar.js --limite 3 --enviar      # teste pequeno antes do bloco
     node disparar.js --copy email_2 --status email --enviar   # follow-up D+4
   ========================================================================== */

const fs = require('fs');
const path = require('path');

/* ----------------------------- constantes ------------------------------- */
/* Ritmo do projeto: 10 e-mails por dia. Não é limite técnico — a cota do
   plano gratuito do Brevo é 300/dia — é ritmo de prospecção: poucos por dia,
   no horário comercial, com resposta acompanhada. 242 contatos ≈ 25 dias.
   Quiser mudar o ritmo, mude AQUI (o tool passa a exigir esse máximo). */
const RITMO_DIA = 10;
const COTA_TECNICA = 300;   // teto técnico do Brevo (plano gratuito) — nunca sugerido
const PAUSA_MS = 400;      // respiro entre envios (e não estoura a cota)
const HORA_INI = 8;        // horário comercial CLT: 8h–18h, seg–sex
const HORA_FIM = 18;
const ARQ_CHAVES = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'aid', 'chaves.env')
  : path.join(process.env.HOME || process.env.USERPROFILE || '.', '.aid', 'chaves.env');
const BREVO = 'https://api.brevo.com/v3/smtp/email';

/* mesma definição do painel (pacto/index.html) — segmento REAL da Receita */
const CLASSES_VIZINHAS = {
  '4721': 1, '4722': 1, '4723': 1, '4724': 1, '4729': 1, '4712': 1, '4713': 1,
  '4618': 1, '4621': 1, '4632': 1, '4633': 1, '4634': 1, '4635': 1, '4637': 1,
  '4639': 1, '4691': 1, '4693': 1, '10': 1, '11': 1
};
function tipoDe(it) {
  const c = String(it.cnae_real || '').replace(/\D/g, '');
  if (!c) return 'sem_dado';
  if (c.startsWith('56') || c.startsWith('55')) return 'ok';
  const pre = c.slice(0, 4), pre3 = c.slice(0, 3), pre2 = c.slice(0, 2);
  if (CLASSES_VIZINHAS[pre] || CLASSES_VIZINHAS[pre3] || CLASSES_VIZINHAS[pre2]) return 'vizinho';
  return 'fora';
}
function inativo(it) {
  const s = String(it.situacao || '').toUpperCase().trim();
  return !!s && s !== 'ATIVA';
}

/* ----------------------------- utilidades ------------------------------- */
const dorme = ms => new Promise(r => setTimeout(r, ms));
const ehEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

function t(texto, nome) {
  return String(texto || '')
    .replace(/\{\{\s*contact\.EMPRESA\s*\}\}|\{\{\s*EMPRESA\s*\}\}/g, nome || 'a equipe');
}
function htmlDe(texto) {
  /* texto puro do banco -> HTML escapado (a copy aprovada manda, não o markup) */
  return String(texto || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
const plural = (n, s) => n + ' ' + s + (n === 1 ? '' : 's');

/* --------------------------- argumentos / env --------------------------- */
function leArgs(argv) {
  const o = {
    enviar: false, limite: RITMO_DIA, copy: 'email_1', status: ['pendente'],
    pausa: PAUSA_MS, forcar: false, ajuda: false, foraHorario: false,
    replyto: null, de: null
  };
  const pega = (i, nome) => {
    if (i >= argv.length) { console.error('faltou o valor de ' + nome); process.exit(2); }
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--enviar') o.enviar = true;
    else if (a === '--limite') o.limite = parseInt(pega(++i, '--limite'), 10);
    else if (a.indexOf('--limite=') === 0) o.limite = parseInt(a.slice(9), 10);
    else if (a === '--copy') o.copy = pega(++i, '--copy');
    else if (a.indexOf('--copy=') === 0) o.copy = a.slice(7);
    else if (a === '--status') o.status = pega(++i, '--status').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.indexOf('--status=') === 0) o.status = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--pausa') o.pausa = parseInt(pega(++i, '--pausa'), 10);
    else if (a === '--replyto') o.replyto = pega(++i, '--replyto');
    else if (a === '--de') o.de = pega(++i, '--de');
    else if (a === '--forcar') o.forcar = true;
    else if (a === '--fora-horario') o.foraHorario = true;
    else if (a === '--ajuda' || a === '--help' || a === '-h') o.ajuda = true;
    else { console.error('argumento desconhecido: ' + a + ' (use --ajuda)'); process.exit(2); }
  }
  if (!Number.isFinite(o.limite) || o.limite < 1) {
    console.error('--limite precisa ser um número maior que zero'); process.exit(2);
  }
  if (o.limite > RITMO_DIA) {
    console.error('--limite ' + o.limite + ' passa do ritmo do projeto (' + RITMO_DIA +
      ' por dia). O plano é poucos por dia, com resposta acompanhada.');
    console.error('Mandou mais que o combinado numa rodada só? Faça a próxima amanhã.');
    process.exit(2);
  }
  if (!o.status.length) o.status = ['pendente'];
  return o;
}

function leChaves() {
  const env = Object.assign({}, process.env);
  try {
    const txt = fs.readFileSync(ARQ_CHAVES, 'utf8');
    txt.split(/\r?\n/).forEach(linha => {
      const l = linha.trim();
      if (!l || l[0] === '#') return;
      const i = l.indexOf('=');
      if (i < 1) return;
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
      if (!(k in env)) env[k] = v;   /* variável do terminal manda sobre o arquivo */
    });
  } catch (e) { /* sem arquivo: só variáveis de ambiente */ }
  return env;
}

function leConfigApp() {
  const arq = path.join(__dirname, '..', '..', 'pacto', 'app.js');
  const txt = fs.readFileSync(arq, 'utf8');
  const url = /var SB_URL\s*=\s*'([^']+)'/.exec(txt);
  const key = /var SB_KEY\s*=\s*'([^']+)'/.exec(txt);
  if (!url || !key) throw new Error('nao achei SB_URL/SB_KEY em pacto/app.js');
  return { url: url[1], anon: key[1] };
}

/* --------------------------- acesso ao Supabase -------------------------- */
async function entrar(cfg, email, senha) {
  const r = await fetch(cfg.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: cfg.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: senha })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error('login do painel falhou (' + r.status + '): ' +
      (j.msg || j.error_description || j.error || 'confira PACTO_EMAIL/PACTO_SENHA'));
  }
  return j.access_token;
}

async function rest(cfg, tok, caminho, metodo, corpo, extra) {
  const h = Object.assign({ apikey: cfg.anon, Authorization: 'Bearer ' + tok }, extra || {});
  if (corpo !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(cfg.url + '/rest/v1/' + caminho, {
    method: metodo || 'GET', headers: h,
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) throw new Error('Supabase ' + (metodo || 'GET') + ' ' + caminho +
    ' -> ' + r.status + ': ' + String(txt).slice(0, 200));
  return j;
}

/* ------------------------------- envio ---------------------------------- */
async function enviaBrevo(chave, pacote) {
  const r = await fetch(BREVO, {
    method: 'POST',
    headers: { 'api-key': chave, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(pacote)
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { j = null; }
  return { ok: r.ok, status: r.status, j: j, txt: txt };
}

/* já enviados hoje no Brevo? (melhor esforço — se a conta não devolver, segue) */
async function enviadosHoje(chave) {
  try {
    const hoje = new Date();
    const d = hoje.getFullYear() + '-' +
      String(hoje.getMonth() + 1).padStart(2, '0') + '-' +
      String(hoje.getDate()).padStart(2, '0');
    const r = await fetch('https://api.brevo.com/v3/smtp/statistics?startDate=' + d +
      '&endDate=' + d, { headers: { 'api-key': chave, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && typeof j.requests === 'number') ? j.requests : null;
  } catch (e) { return null; }
}

/* ------------------------------ escolha da lista ------------------------ */
function montaLista(rows, statusAlvo) {
  const cont = { sem_email: 0, contador: 0, statusFora: 0, sem_decisao: 0, inativo: 0 };
  const porTipo = { ok: 0, vizinho: 0, fora: 0, sem_dado: 0 };
  const vistos = new Map();          /* email minúsculo -> linha (1 por e-mail) */
  let duplicados = 0;

  rows.forEach(x => {
    const email = String(x.email || '').trim();
    if (!ehEmail(email)) { cont.sem_email++; return; }
    if (String(x.email_marcado || '').trim().toLowerCase() === 'contador') { cont.contador++; return; }
    if (String(x.status || 'pendente') === 'fora') { cont.statusFora++; return; }
    if (statusAlvo.indexOf(String(x.status || 'pendente')) < 0) { cont.statusFora++; return; }
    /* rede de segurança: quem o dono ainda não decidiu não recebe e-mail */
    const marcado = tipoDe(x) === 'fora' || inativo(x);
    if (marcado && x.status === 'pendente' && !x.revisado_em) { cont.sem_decisao++; return; }
    if (inativo(x)) { cont.inativo++; return; }

    const chave = email.toLowerCase();
    if (vistos.has(chave)) { duplicados++; return; }
    vistos.set(chave, x);
  });

  const lista = [];
  vistos.forEach(x => {
    const tp = tipoDe(x);
    porTipo[tp]++;
    lista.push({ id: x.id, cnpj: x.cnpj, nome: x.nome || x.razao || '(sem nome)', email: x.email.trim(), tipo: tp });
  });
  return { lista: lista, cont: cont, porTipo: porTipo, duplicados: duplicados, linhas: rows.length };
}

/* ------------------------------ rodapé LGPD ----------------------------- */
function montaTexto(copias, chaveCopy, nome) {
  const c = copias.find(x => x.chave === chaveCopy);
  if (!c) return null;
  const rod = copias.find(x => x.chave === 'rodape');
  const corpo = t(c.corpo, nome);
  const texto = corpo + (corpo.slice(-1) === '\n' ? '' : '\n') +
    (rod ? '\n' + t(rod.corpo, nome) : '');
  return { assunto: t(c.assunto, nome), corpo: texto, copy: c, temRodape: !!rod };
}

/* -------------------------------- ajuda --------------------------------- */
const AJUDA = `
Disparo automático do Pacto Gorjeta (API do Brevo)

Ritmo do projeto: ${RITMO_DIA} e-mails por dia, em horário comercial
(seg–sex, 8h–18h). A lista atual leva ~${Math.ceil(242 / RITMO_DIA)} dias
nesse ritmo — é de propósito: poucos por dia dá pra acompanhar resposta.
(O Brevo deixaria ir a ${COTA_TECNICA}/dia de graça; aqui isso nunca é sugerido.)

  node disparar.js                       dry-run: mostra o plano, NÃO envia
  node disparar.js --enviar              manda os ${RITMO_DIA} do dia
  node disparar.js --limite 3 --enviar   teste pequeno (antes do bloco do dia)

Opções
  --limite N        quantos envia nesta rodada (padrão e máximo: ${RITMO_DIA})
  --copy CHAVE      qual copy manda (padrão: email_1). Aprovadas: email_1, email_2, email_3
  --status LISTA    de quem recebe (padrão: pendente). Pro follow-up D+4: --status email
  --replyto EMAIL   para onde cai a resposta (padrão: aidtecnologiaresolutiva@gmail.com)
  --de "Nome <e>"   remetente (padrão: Dyeison — AID Tecnologia <dyeison@aidtr.com.br>)
  --pausa MS        pausa entre envios (padrão: ${PAUSA_MS} ms)
  --forcar          envia copy sem aprovação
  --fora-horario    permite enviar fora das 8h–18h de segunda a sexta (CLT)
  --ajuda           este texto

Chave do Brevo: uma vez só, rode .\\guarda_chave.ps1 (guarda fora do Git).
`;

/* --------------------------------- main --------------------------------- */
(async function main() {
  const args = leArgs(process.argv.slice(2));
  if (args.ajuda) { console.log(AJUDA); return; }

  const env = leChaves();
  const cfg = leConfigApp();

  /* --- credenciais do painel (para LER a lista e marcar o que foi enviado) --- */
  const emailPacto = env.PACTO_EMAIL, senhaPacto = env.PACTO_SENHA;
  if (!emailPacto || !senhaPacto) {
    console.error('Falta PACTO_EMAIL/PACTO_SENHA (o tool precisa entrar no painel pra ler a lista).');
    console.error('Rode uma vez:  .\\guarda_chave.ps1');
    process.exit(2);
  }

  /* --- aviso de horário comercial (CLT): 8h–18h, seg–sex --- */
  const agora = new Date();
  const diaSem = agora.getDay();               /* 0=dom 6=sab */
  const hora = agora.getHours();
  const noHorario = diaSem >= 1 && diaSem <= 5 && hora >= HORA_INI && hora < HORA_FIM;
  if (!noHorario && args.enviar && !args.foraHorario && !args.forcar) {
    console.error('Agora são ' + String(hora).padStart(2, '0') + 'h de ' +
      ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][diaSem] +
      ' — fora do horário comercial (CLT).');
    console.error('Melhor rodar de segunda a sexta, das ' + HORA_INI + 'h às ' + HORA_FIM + 'h.');
    console.error('Se for de propósito: node disparar.js ... --fora-horario');
    process.exit(3);
  }

  console.log('Pacto Gorjeta · disparo ' + (args.enviar ? 'REAL' : '(dry-run — nada sai)'));
  const tok = await entrar(cfg, emailPacto, senhaPacto);
  console.log('painel conectado ✓');

  /* --- dados --- */
  const rows = await rest(cfg, tok, 'prospectos?select=id,cnpj,nome,razao,email,email_marcado,status,situacao,cnae_real,revisado_em&order=cnpj.asc&limit=5000', 'GET');
  const copias = await rest(cfg, tok, 'copias?select=chave,titulo,assunto,corpo,status,quando&order=ordem.asc', 'GET');
  console.log('base: ' + rows.length + ' linhas · copias: ' + copias.length + ' no banco');

  /* --- a copy escolhida --- */
  const alvo = montaLista(rows, args.status);
  const previa = montaTexto(copias, args.copy, alvo.lista.length ? alvo.lista[0].nome : null);
  if (!previa) {
    console.error('Não achei a copy "' + args.copy + '" no banco. Chaves: ' +
      copias.map(x => x.chave).join(', '));
    process.exit(2);
  }
  if (!previa.copy.assunto || !String(previa.copy.assunto).trim()) {
    console.error('A copy "' + args.copy + '" é de WhatsApp (sem assunto) — WhatsApp não sai por e-mail.');
    process.exit(2);
  }
  if (previa.copy.status !== 'aprovado' && !args.forcar) {
    console.error('A copy "' + args.copy + '" está como "' + previa.copy.status + '" (não aprovada).');
    console.error('Aprove em pacto/copy.html, ou --forcar se for teste.');
    process.exit(2);
  }
  if (!previa.temRodape) console.log('ALERTA: não achei a copy "rodape" (LGPD) — o e-mail sai sem ela.');

  /* --- relatório do plano --- */
  const c = alvo.cont;
  console.log('\n--- quem entra ---');
  console.log('  lista final ............ ' + alvo.lista.length + ' e-mails distintos');
  console.log('  linhas (com duplicado) .. ' + (alvo.lista.length + alvo.duplicados) +
    ' · duplicados no mesmo e-mail: ' + alvo.duplicados);
  console.log('  por segmento ........... ' + alvo.porTipo.ok + ' restaurante · ' +
    alvo.porTipo.vizinho + ' vizinho (comércio de alimentos) · ' +
    alvo.porTipo.fora + ' fora do segmento · ' + alvo.porTipo.sem_dado + ' sem CNAE');
  if (alvo.porTipo.vizinho) {
    console.log('    (vizinho = mercearia/açougue/etc. Se não quiser mandar, marque');
    console.log('     "fora do escopo" na aba Campanha — aí já sai daqui também.)');
  }
  console.log('\n--- quem NÃO entra ---');
  console.log('  sem e-mail válido ...... ' + c.sem_email);
  console.log('  marcado contador ....... ' + c.contador);
  console.log('  fora do escopo ......... ' + c.statusFora);
  console.log('  ainda sem decisão ...... ' + c.sem_decisao + ' (decida na validação)');
  console.log('  CNPJ inativo ........... ' + c.inativo);

  /* --- a copy, como vai sair --- */
  console.log('\n--- o que manda ---');
  console.log('  copy: ' + args.copy + ' (' + previa.copy.status + ')' +
    (previa.copy.quando ? ' · ' + previa.copy.quando : '') + ' — ' + previa.copy.titulo);
  console.log('  assunto: ' + previa.assunto);
  console.log('  rodapé LGPD: ' + (previa.temRodape ? 'anexado ✓' : 'AUSENTE'));

  if (!alvo.lista.length) {
    console.log('\nNinguém na fila com --status ' + args.status.join(',') + '. Nada a fazer.');
    return;
  }

  /* --- prévia do primeiro (dry-run mostra como fica de verdade) --- */
  const p0 = alvo.lista[0];
  const v0 = montaTexto(copias, args.copy, p0.nome);
  console.log('\n--- prévia do 1º ---');
  console.log('  para: ' + p0.email + '  (' + p0.nome + ')');
  console.log('  assunto: ' + v0.assunto);
  console.log('  texto (3 primeiras linhas):');
  v0.corpo.split('\n').slice(0, 3).forEach(l => console.log('    ' + l));

  if (!args.enviar) {
    const dias = Math.ceil(alvo.lista.length / RITMO_DIA);
    console.log('\n=== DRY RUN: nada foi enviado ===');
    console.log('Ritmo do projeto: ' + RITMO_DIA + ' e-mails por dia (seg–sex, 8h–18h).');
    console.log('  lista inteira levaria ' + plural(dias, 'dia') + ' — ' +
      (alvo.lista.length > RITMO_DIA ? 'é de propósito: poucos por dia, com resposta acompanhada.' : 'de uma vez só.'));
    console.log('  hoje eu mandaria: ' + Math.min(args.limite, alvo.lista.length) + ' (--limite ' + args.limite + ')');
    console.log('\nPro dia:        node disparar.js --enviar');
    console.log('Teste de 3:     node disparar.js --limite 3 --enviar');
    return;
  }

  /* --- envio real --- */
  const chaveBrevo = env.BREVO_API_KEY;
  if (!chaveBrevo) {
    console.error('\nFalta BREVO_API_KEY. Rode uma vez:  .\\guarda_chave.ps1');
    console.error('(a chave fica só na sua máquina, fora do Git)');
    process.exit(2);
  }
  /* ritmo do dia já cumprido? (melhor esforço — se o Brevo não devolver, segue) */
  const jaHoje = await enviadosHoje(chaveBrevo);
  if (jaHoje !== null) {
    console.log('\nJá enviados hoje no Brevo: ' + jaHoje + ' · ritmo do projeto: ' + RITMO_DIA + '/dia');
    if (jaHoje >= RITMO_DIA) {
      console.error('Ritmo de hoje já cumprido (' + jaHoje + ' de ' + RITMO_DIA + ').');
      console.error('Amanhã sai o próximo bloco (quem recebeu já saiu da fila).');
      process.exit(3);
    }
    if (jaHoje + args.limite > RITMO_DIA) {
      args.limite = RITMO_DIA - jaHoje;
      console.log('Ajustando pra caber no ritmo de hoje: --limite ' + args.limite);
    }
    if (jaHoje + args.limite > COTA_TECNICA) {
      console.error('Passaria da cota técnica do Brevo (' + COTA_TECNICA + '/dia).');
      process.exit(2);
    }
  }

  const remetente = parseRemetente(args.de);
  const replyTo = args.replyto || 'aidtecnologiaresolutiva@gmail.com';
  const fila = alvo.lista.slice(0, args.limite);
  console.log('\n=== ENVIANDO ' + fila.length + ' e-mail(s) · pausa ' + args.pausa + ' ms ===');

  const enviados = [];
  const falhas = [];
  let seguidas = 0;

  for (let i = 0; i < fila.length; i++) {
    const p = fila[i];
    const v = montaTexto(copias, args.copy, p.nome);
    const pacote = {
      sender: remetente,
      to: [{ email: p.email, name: p.nome }],
      replyTo: { email: replyTo },
      subject: v.assunto,
      textContent: v.corpo,
      htmlContent: htmlDe(v.corpo)
    };
    const r = await enviaBrevo(chaveBrevo, pacote);
    const ag = new Date().toTimeString().slice(0, 8);

    if (r.ok) {
      enviados.push(p);
      seguidas = 0;
      /* marca NA HORA: retomável e o sorteio diário não repete */
      try {
        await rest(cfg, tok, 'prospectos?id=eq.' + encodeURIComponent(p.id), 'PATCH',
          { status: 'email', atualizado_em: new Date().toISOString() },
          { Prefer: 'return=minimal' });
      } catch (e) {
        console.log('  [' + (i + 1) + '/' + fila.length + '] ' + p.email +
          ' · enviado, MAS NÃO MARCOU NO BANCO: ' + e.message);
        console.log('    -> confira a linha ' + p.cnpj + ' antes de rodar de novo (senão repete)');
      }
      console.log('  [' + (i + 1) + '/' + fila.length + '] ' + ag + ' ✓ ' +
        p.email + ' (' + p.nome + ')');
    } else {
      const motivo = (r.j && r.j.message) ? r.j.message : r.txt;
      falhas.push({ p: p, status: r.status, motivo: motivo });
      console.log('  [' + (i + 1) + '/' + fila.length + '] ✗ ' + p.email +
        ' -> ' + r.status + ' ' + String(motivo).slice(0, 160));
      if (r.status === 429) {
        console.log('\nCota/limite do Brevo atingido — parando aqui.');
        console.log('O que já saiu está marcado; o resto vai na próxima rodada.');
        break;
      }
      seguidas++;
      if (seguidas >= 3) {
        console.log('\n3 falhas seguidas — parei pra não martelar a API.');
        console.log('Confira a chave (--ajuda) e rode de novo (é retomável).');
        break;
      }
    }
    if (i < fila.length - 1) await dorme(args.pausa);
  }

  /* --- resumo --- */
  const sobrou = Math.max(0, alvo.lista.length - enviados.length);
  const proximo = Math.min(RITMO_DIA, sobrou);
  const diasQueFaltam = Math.ceil(sobrou / RITMO_DIA);
  console.log('\n=== RESUMO ===');
  console.log('  enviados ....... ' + enviados.length + ' de ' + fila.length);
  console.log('  falhas ......... ' + falhas.length + ' (não marcadas — vão de novo)');
  console.log('  marcado "email" no painel: ' + enviados.length);
  console.log('  fila que sobrou: ' + sobrou +
    (sobrou ? ' · no ritmo de ' + RITMO_DIA + '/dia faltam ' + plural(diasQueFaltam, 'dia') : ''));
  if (enviados.length) {
    console.log('\nPróximos passos:');
    if (proximo) console.log('  · amanhã (próximo bloco): node disparar.js --enviar');
    console.log('  · em D+4 (2º e-mail da sequência): node disparar.js --copy email_2 --status email --enviar');
    console.log('  · o placar do passo 4 do painel enxerga quem foi marcado.');
  }
  if (falhas.length) console.log('\nFalhas (não marcadas, vão de novo na próxima):');
  falhas.forEach(f => console.log('  ' + f.p.email + ' — ' + f.status + ' ' + String(f.motivo).slice(0, 120)));
})().catch(e => {
  console.error('\nERRO: ' + e.message);
  process.exit(1);
});

/* remetente: "Nome <email>" ou só email */
function parseRemetente(de) {
  if (!de) return { name: 'Dyeison — AID Tecnologia', email: 'dyeison@aidtr.com.br' };
  const m = /^(.*?)<\s*([^>]+)\s*>$/.exec(de.trim());
  if (m) return { name: m[1].trim() || 'Dyeison', email: m[2].trim() };
  return { name: 'Dyeison', email: de.trim() };
}
