#!/usr/bin/env node
/* ==========================================================================
   AID — Varredor de canais (ferramenta padrão, ver README.md)
   Busca o canal que a EMPRESA publicou hoje: WhatsApp, telefone, e-mail,
   site, Instagram. Grava com data + fonte + nivel de confianca.
   NUNCA grava dado sem origem: o que e incerto fica marcado como suspeito.
   Credenciais so por variavel de ambiente. Nada de segredo no Git.
   ========================================================================== */
const { Client } = require('pg');
const https = require('https');
const { URL } = require('url');

/* ------------------------- configuracao (env) --------------------------- */
const ARGS = (() => {
  const a = { fontes: 'ddg,bing,searx,startpage,mojeek', limite: 100000 };
  for (let i = 2; i < process.argv.length; i++) {
    const p = process.argv[i];
    if (p === '--base') a.base = process.argv[++i];
    else if (p === '--limite') a.limite = parseInt(process.argv[++i], 10);
    else if (p === '--fontes') a.fontes = process.argv[++i];
  }
  return a;
})();

const CFG = {
  tabela:    process.env.TABELA || 'prospectos',
  colNome:   process.env.COL_NOME || 'nome',
  colCidade: process.env.COL_CIDADE || null,   // se vazio, usa --base
  /* conc = quantos trabalhadores varrem ao mesmo tempo. 2 porque quase todo
     o tempo de cada varredura é ESPERA (HTTP + 1,5s de intervalo entre
     fontes): dobrar os processos quase dobra o ritmo, e 3+ já cai no
     bloqueio anti-bot das buscas. Detalhe em Promise.all. */
  conc:      parseInt(process.env.CONC || '2', 10),
  espera:    parseInt(process.env.ESPERA || '1500', 10),
  cidade:    ARGS.base || process.env.CIDADE || 'Franca SP'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* --------------------------- http generico ------------------------------ */
function pedido(host, path, metodo = 'GET', corpo = null, hdrs = {}) {
  return new Promise((resolve) => {
    const o = { host, path, method: metodo, timeout: 25000, headers: {
      'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9', ...hdrs } };
    const r = https.request(o, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ s: res.statusCode, d, loc: res.headers.location }));
    });
    r.on('error', e => resolve({ s: 0, d: '', erro: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ s: 0, d: '', erro: 'timeout' }); });
    if (corpo) r.write(corpo);
    r.end();
  });
}
const dorme = ms => new Promise(x => setTimeout(x, ms));

/* --------------------------- extracao ----------------------------------- */
const DOM_LIXO = new Set([
  'google.com','google.com.br','duckduckgo.com','bing.com','yahoo.com','yandex.com',
  'facebook.com','m.facebook.com','x.com','twitter.com','linkedin.com','tiktok.com',
  'youtube.com','youtu.be','wikipedia.org','gov.br','receita.gov.br','instagram.com',
  'web.stagram.com','ifood.com.br','rappi.com.br','tripadvisor.com.br','foursquare.com',
  'yelp.com','zomato.com','telelistas.net','apontador.com.br','guiamais.com.br',
  'brevo.com','sendinblue.com','example.com','sentry.io','wixpress.com','cloudflare.com',
  'cnpj.biz','cnpja.com','econodata.com.br','consultacnpj.com','empresascnpj.com'
]);

const limpaHtml = h => String(h || '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function decodificaBing(href) {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href || '');
  if (!m) return href;
  try {
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Buffer.from(b, 'base64').toString('utf8');
  } catch (e) { return href; }
}

function decodificaUddg(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href || '');
  if (!m) return href;
  try { return decodeURIComponent(m[1]); } catch (e) { return href; }
}

/* extrai canais de um texto livre + lista de URLs; devolve com contadores
   (quantas fontes independentes citam = confianca) */
function extrai(texto, urls) {
  const out = { zaps: new Map(), mails: new Map(), instas: new Map(), sites: new Map(), tels: new Map() };
  const soma = (mapa, chave) => mapa.set(chave, (mapa.get(chave) || 0) + 1);

  for (const m of texto.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/phone=)(?:55)?(\d{10,11})/g))
    soma(out.zaps, m[1]);
  for (const m of texto.matchAll(/whatsapp[^0-9]{0,25}(\(?\d{2}\)?\s?9?\d{4}-?\d{4})/gi)) {
    const d = m[1].replace(/\D/g, '');
    if (d.length >= 10) soma(out.zaps, d.slice(-11));
  }
  for (const m of texto.matchAll(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (!DOM_LIXO.has(e.split('@')[1])) soma(out.mails, e);
  }
  for (const m of texto.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,40})/g))
    if (!/^(p|reel|tv|stories|explore|share)$/i.test(m[1])) soma(out.instas, m[1]);
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, '');
      if (!DOM_LIXO.has(h)) soma(out.sites, h);
    } catch (e) {}
  }
  // telefone fixo direto (sem contexto de whatsapp): serve de conferencia
  for (const m of texto.matchAll(/\(16\)\s?\d{4}-?\d{4}/g)) soma(out.tels, m[0]);
  return out;
}

/* --- zap aceitável --------------------------------------------------------
   Só grava celular de comércio na cidade varrida: 11 dígitos, DDD 16
   (Franca/SP) e nono dígito '9' — fixo/comercial não recebe zap e um DDD
   diferente que apareceu na página de terceiro é número de OUTRA cidade
   (o varredor roda por cidade, então DDD é o filtro de procedência).
   O '55' de país só sai quando sobram 12 dígitos: tirar sempre apagaria o
   DDD 55 (Rio Grande do Sul) de um número nacional de 10 dígitos.
   Devolve null quando o número não passa no filtro: a linha fica sem
   zap_web — melhor sem zap do que zap de outra cidade na ficha. */
function zapBom(dig) {
  const d = String(dig).replace(/\D/g, '');
  const loc = d.length === 12 && d.startsWith('55') ? d.slice(2) : d;
  return (loc.length === 11 && loc.startsWith('16') && loc[2] === '9') ? loc : null;
}

/* --------------------------- fontes -------------------------------------
   Cada fonte: { nome, cooldown, busca(nome, cidade) -> {texto, urls, falhou} }
   ----------------------------------------------------------------------- */
const COOLDOWN = {};   // fonte -> timestamp de liberacao

async function ddg(nome) {
  const q = encodeURIComponent(`"${nome}" ${CFG.cidade} whatsapp`);
  let r = await pedido('html.duckduckgo.com', `/html/?q=${q}`);
  if (r.s !== 200) {
    r = await pedido('lite.duckduckgo.com', `/lite/?q=${q}`);
    if (r.s !== 200) return { falhou: true, motivo: `HTTP ${r.s}` };
  }
  const urls = [];
  for (const m of (r.d || '').matchAll(/href="([^"]*uddg=[^"]+)"/g)) urls.push(decodificaUddg(m[1]));
  const blocos = (r.d || '').match(/result__(?:a|snippet)[^>]*>[\s\S]*?<\/a>/g) || [];
  return { texto: limpaHtml(blocos.join(' ')), urls, bruto: r.d };
}

async function bing(nome) {
  const q = encodeURIComponent(`"${nome}" ${CFG.cidade}`);
  const r = await pedido('www.bing.com', `/search?q=${q}&setlang=pt-br&cc=BR&count=20`);
  if (r.s !== 200) return { falhou: true, motivo: `HTTP ${r.s}` };
  const urls = [];
  for (const m of (r.d || '').matchAll(/<a[^>]+href="([^"]+)"/g)) urls.push(decodificaBing(m[1].replace(/&amp;/g, '&')));
  const blocos = (r.d || '').match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  return { texto: limpaHtml(blocos.length ? blocos.join(' ') : (r.d || '').slice(0, 60000)), urls };
}

const SEARX = ['searx.be', 'search.inetol.net', 'searx.tiekoetter.com', 'priv.au', 'searxng.site'];
let idxSearx = 0;
async function searx(nome) {
  for (let t = 0; t < SEARX.length; t++) {
    const host = SEARX[(idxSearx + t) % SEARX.length];
    const q = encodeURIComponent(`"${nome}" ${CFG.cidade}`);
    const r = await pedido(host, `/search?q=${q}&language=pt-BR`);
    if (r.s === 200 && r.d && (r.d.match(/class="result/g) || []).length > 0) {
      idxSearx = (idxSearx + t) % SEARX.length;
      const urls = [];
      for (const m of (r.d || '').matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) urls.push(m[1]);
      const blocos = (r.d || '').match(/<article[\s\S]*?<\/article>/g) || [];
      return { texto: limpaHtml(blocos.join(' ') || r.d), urls };
    }
  }
  return { falhou: true, motivo: 'todas as instancias bloquearam' };
}

async function startpage(nome) {
  const q = encodeURIComponent(`"${nome}" ${CFG.cidade}`);
  const r = await pedido('www.startpage.com', `/sp/search?query=${q}`);
  if (r.s !== 200) return { falhou: true, motivo: `HTTP ${r.s}` };
  const urls = [];
  for (const m of (r.d || '').matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) urls.push(m[1]);
  return { texto: limpaHtml(r.d || ''), urls };
}

async function mojeek(nome) {
  const q = encodeURIComponent(`"${nome}" ${CFG.cidade}`);
  const r = await pedido('www.mojeek.com', `/search?q=${q}`);
  if (r.s !== 200) return { falhou: true, motivo: `HTTP ${r.s}` };
  const urls = [];
  for (const m of (r.d || '').matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) urls.push(m[1]);
  const blocos = (r.d || '').match(/<li class="[\s\S]*?<\/li>/g) || [];
  return { texto: limpaHtml(blocos.join(' ') || r.d), urls };
}

const FONTES = { ddg, bing, searx, startpage, mojeek };
const COOLDOWN_MS = { ddg: 20 * 60e3, bing: 0, searx: 10 * 60e3, startpage: 5 * 60e3, mojeek: 5 * 60e3 };

/* --------------------------- motor -------------------------------------- */
const c = new Client({
  host: process.env.PGHOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: parseInt(process.env.PGPORT || '6543', 10),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres.uewqkwmzpmnpebdsldto',
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function varreEmpresa(row) {
  const zaps = new Map(), mails = new Map(), instas = new Map(), sites = new Map(), tels = new Map();
  const dicas = [];
  let fontesOk = 0;

  for (const nomeFonte of ARGS.fontes.split(',')) {
    const f = nomeFonte.trim();
    if (!FONTES[f]) continue;
    if (COOLDOWN[f] && Date.now() < COOLDOWN[f]) continue;   // em espera
    let r;
    try { r = await FONTES[f](row[CFG.colNome]); } catch (e) { r = { falhou: true, motivo: e.message }; }
    if (r && r.falhou) {
      if (COOLDOWN_MS[f]) COOLDOWN[f] = Date.now() + COOLDOWN_MS[f];
      continue;
    }
    if (!r) continue;
    fontesOk++;
    const e = extrai(r.texto || '', r.urls || []);
    e.zaps.forEach((n, k) => zaps.set(k, (zaps.get(k) || 0) + n));
    e.mails.forEach((n, k) => mails.set(k, (mails.get(k) || 0) + n));
    e.instas.forEach((n, k) => instas.set(k, (instas.get(k) || 0) + n));
    e.sites.forEach((n, k) => sites.set(k, (sites.get(k) || 0) + n));
    e.tels.forEach((n, k) => tels.set(k, (tels.get(k) || 0) + n));
    const trecho = limpaHtml(r.texto || '').slice(0, 220);
    if (trecho.length > 40) dicas.push(`[${f}] ${trecho}`);
    await dorme(CFG.espera);
  }

  // ---- confianca ----
  // ALTA: zap com link wa.me/whatsapp do proprio estabelecimento, ou citado
  //       por 2+ fontes. MEDIA: 1 fonte. BAIXA: so telefone parecido.
  const telBase = String(row.telefone || '').replace(/\D/g, '').slice(-8);
  let zapEscolhido = null, zapNivel = null;
  const zapsOrd = [...zaps.entries()].filter(([d]) => zapBom(d)).sort((a, b) => b[1] - a[1]);
  if (zapsOrd.length) {
    const [melhor, vezes] = zapsOrd[0];
    zapEscolhido = zapBom(melhor);
    zapNivel = vezes >= 2 ? 'alta' : 'media';
  }

  let mailEscolhido = null;
  const mailsOrd = [...mails.entries()].sort((a, b) => b[1] - a[1]);
  if (mailsOrd.length) mailEscolhido = mailsOrd[0][0];

  const siteEscolhido = [...sites.entries()].sort((a, b) => b[1] - a[1])[0];
  const instaEscolhido = [...instas.entries()].sort((a, b) => b[1] - a[1])[0];
  const telConf = [...tels.entries()].find(([t]) => String(t).replace(/\D/g, '').slice(-8) === telBase);

  return {
    zap_web: zapEscolhido,
    zap_nivel: zapNivel,
    email_web: mailEscolhido,
    site: siteEscolhido ? siteEscolhido[0] : null,
    instagram: instaEscolhido ? instaEscolhido[0] : null,
    tel_confere: telConf ? 'sim' : (tels.size ? 'nao' : null),
    web_dica: dicas.join(' … ').slice(0, 400) || null,
    fontes_ok: fontesOk
  };
}

(async () => {
  await c.connect();
  // colunas novas (idempotente) — verificado com o banco ja existente
  const novos = [
    ['zap_web','text'], ['zap_nivel','text'], ['email_web','text'], ['site','text'],
    ['instagram','text'], ['tel_confere','text'], ['web_dica','text'], ['web_em','timestamptz']
  ];
  const cols = await c.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name=$1`, [CFG.tabela]);
  const tem = new Set(cols.rows.map(r => r.column_name));
  for (const [n, t] of novos)
    if (!tem.has(n)) { await c.query(`alter table ${CFG.tabela} add column ${n} ${t}`); console.log('coluna criada:', n); }

  /* CÓDIGO MORTO (p/ remoção): cidadeFiltro é calculada e NUNCA é lida — os
     dois ramos do ternário dão '' (o filtro por coluna de cidade nunca foi
     implementado). É inofensiva, mas sugere um filtro que não existe: a
     cidade só entra na busca de texto, via CFG.cidade. */
  const cidadeFiltro = CFG.colCidade ? '' : '';

  /* Re-scan de 90 dias: 'web_em' é a data da última varredura e o WHERE pega
     só quem nunca varreu ou varreu há mais de 3 meses. Por que 90 e não
     "sempre" nem "toda rodada":
       - canal publicado MUDA (número trocado, site novo, Instagram outro) e
         dado velho é exatamente o defeito que este varredor existe pra corrigir;
       - 90 dias é o ponto em que o custo de busca compensa: a cada ciclo a
         fila encolhe e revarrer tudo toda semana gastaria cota de busca à
         toa, sem ganho de qualidade;
       - 'web_em' é gravado POR LINHA, o que torna a rodada RETOMÁVEL: parou
         no meio, rodar de novo pega só o que falta. */
  const pend = await c.query(`
    select *, ${CFG.colNome} as nome from ${CFG.tabela}
    where status <> 'fora'
      and (web_em is null or web_em < now() - interval '90 days')
    order by id limit ${ARGS.limite}`);
  console.log('pendentes:', pend.rowCount, '| fontes:', ARGS.fontes, '| base:', CFG.cidade);
  if (!pend.rowCount) { await c.end(); return; }

  const fila = pend.rows.slice();
  let feitos = 0, zaps = 0, zapsAlta = 0, mails = 0, sites = 0, instas = 0, semNada = 0;

  /* Trabalhador: consome a fila até esvaziar. Exceção não derruba a rodada —
     varreEmpresa já devolve null, e null conta como "sem nada": a linha NÃO é
     atualizada (web_em continua valendo a rodada anterior), então ela volta
     na próxima execução em vez de ficar marcada como varrida sem ter sido. */
  async function trabalhar() {
    for (;;) {
      const row = fila.shift();
      if (!row) return;
      let d = null;
      try { d = await varreEmpresa(row); } catch (e) { d = null; }
      if (d) {
        /* coalesce($n, coluna): só grava se o valor NOVO veio preenchido —
           fonte que não achou nada NÃO apaga canal já confirmado antes (se o
           DDG bloquear desta vez, o zap_web bom continua lá). E é UPDATE por
           id, nunca INSERT: a rodada não cria linha nova, por isso não tem
           como duplicar empresa/CNPJ — o dedupe é por construção, não por
           SELECT. web_em = now() marca que a linha foi coberta neste ciclo
           (é o que some ela do WHERE dos 90 dias). */
        await c.query(`
          update ${CFG.tabela} set
            zap_web     = coalesce($2, zap_web),
            zap_nivel   = coalesce($3, zap_nivel),
            email_web   = coalesce($4, email_web),
            site        = coalesce($5, site),
            instagram   = coalesce($6, instagram),
            tel_confere = coalesce($7, tel_confere),
            web_dica    = coalesce($8, web_dica),
            web_em      = now()
          where id = $1`,
          [row.id, d.zap_web, d.zap_nivel, d.email_web, d.site, d.instagram, d.tel_confere, d.web_dica]);
        if (d.zap_web) { zaps++; if (d.zap_nivel === 'alta') zapsAlta++; }
        if (d.email_web) mails++;
        if (d.site) sites++;
        if (d.instagram) instas++;
        if (!d.zap_web && !d.email_web && !d.site && !d.instagram) semNada++;
      } else semNada++;
      feitos++;
      if (feitos % 10 === 0 || feitos === pend.rowCount)
        console.log(`${feitos}/${pend.rowCount} zap:${zaps}(alta ${zapsAlta}) mail:${mails} site:${sites} insta:${instas} semnada:${semNada}`);
    }
  }
  /* Concorrência = CFG.conc (padrão 2) trabalhadores sobre a MESMA fila.
     Por que 2: quase todo o tempo é espera (HTTP de até 25s + 1,5s entre
     fontes), então dobrar os processos quase dobra o ritmo — 3+ começa a
     cair no bloqueio anti-bot das buscas e não ganha quase nada. fila.shift()
     é seguro porque só corre um por vez no event loop, e as escrita passam
     por um único Client do pg, que já serializa as queries. */
  await Promise.all(Array.from({ length: CFG.conc }, trabalhar));

  const r = await c.query(`
    select count(*) filter (where coalesce(zap_web,'')<>'')::int com_zap,
           count(*) filter (where zap_nivel='alta')::int zap_alta,
           count(*) filter (where coalesce(site,'')<>'')::int com_site,
           count(*) filter (where coalesce(instagram,'')<>'')::int com_insta,
           count(*) filter (where coalesce(email_web,'')<>'')::int com_email_web,
           count(*) filter (where coalesce(email,'')='' and coalesce(zap_web,'')='')::int ainda_sem_nada
    from ${CFG.tabela} where status <> 'fora'`);
  console.log('\n=== RESUMO CANAIS ===', JSON.stringify(r.rows[0]));
  await c.end();
})().catch(e => { console.log('ERRO', e.message); process.exit(1); });
