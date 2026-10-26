#!/usr/bin/env node
/* ==========================================================================
   AID — Ponte Google Maps -> base (ferramenta padrão, ver README.md)
   Roda o motor gosom/google-maps-scraper (binario proprio, sem Docker) e
   cruzamento de volta na base pelo TELEFONE (chave confiavel).

   O que entra daqui (tudo com origem "maps"):
     - categoria do Maps  -> valida o segmento com dado curado por gente
     - nota + avaliacoes  -> empresa viva vs empresa morta
     - site               -> canal pra achar WhatsApp/e-mail depois
     - telefone           -> confere/corrige o da base
   O que NAO entra: e-mail do modo -email do gosom. Testado em 20 linhas:
   achou 1 e era rastro de rastreio do Wix (sentry-next.wixpress.com) —
   reprovado no teste, entao fica de fora ate ser confiavel.
   ========================================================================== */
const { Client } = require('pg');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARGS = (() => {
  const a = { limite: 100000, profundidade: 3, conc: 2 };
  for (let i = 2; i < process.argv.length; i++) {
    const p = process.argv[i];
    if (p === '--limite') a.limite = parseInt(process.argv[++i], 10);
    else if (p === '--profundidade') a.profundidade = parseInt(process.argv[++i], 10);
    else if (p === '--base') a.base = process.argv[++i];
  }
  return a;
})();

const CFG = {
  tabela: process.env.TABELA || 'prospectos',
  cidade: ARGS.base || process.env.CIDADE || 'Franca SP',
  binario: process.env.GMAPS_BIN ||
    'C:\\Users\\Dyeison\\AppData\\Local\\Temp\\opencode\\gmaps\\gmaps.exe',
  pasta: process.env.GMAPS_PASTA ||
    'C:\\Users\\Dyeison\\AppData\\Local\\Temp\\opencode\\gmaps'
};

/* Normalização: o Maps e a base escrevem o MESMO dado de formas diferentes,
   e casar exige texto idêntico. normTel tira tudo que não é dígito e corta o
   55 de país só quando sobra mais que 11 — mesma lógica do varredor: um
   telefone de 10 dígitos com DDD 55 (Rio Grande do Sul) não pode perder o
   DDD achando que é código do país. nomeNorm tira acento, caixa e pontuação
   porque "São João Lanches" no Maps chega como "Sao Joao Lanches" na base. */
const normTel = t => {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  return d;
};
const nomeNorm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/* categorias do Maps que significam "serve refeicao no local" — alvo do
   Pacto Gorjeta. Curado por gente no Google, muito mais confiavel que o
   CNAE que veio forjado na base. */
const CATEGORIA_ALVO = /restaur|self.?service|churrasc|steak|pizz|sushi|lanch|pastel|hamburg|dog|dogu|acai|cafe|cafeteria|padari|confeit|docer|sorveter|bar\b|pub|cantina|buffet|esfiha|kebab|marmit|comida|gastronom|trattoria|parrilla|bistr|tempero|cozinha|delivery/i;

const c = new Client({
  host: process.env.PGHOST || 'aws-0-us-east-1.pooler.supabase.com',
  port: parseInt(process.env.PGPORT || '6543', 10),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres.uewqkwmzpmnpebdsldto',
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  if (!fs.existsSync(CFG.binario)) {
    console.log('binario do gosom nao encontrado em:', CFG.binario);
    console.log('baixe em: https://github.com/gosom/google-maps-scraper/releases');
    process.exit(1);
  }
  await c.connect();

  // colunas novas (idempotente)
  const novos = [
    ['categoria_maps', 'text'], ['nota_maps', 'text'], ['avaliacoes_maps', 'integer'],
    ['site_maps', 'text'], ['maps_em', 'timestamptz'], ['fonte_canal', 'text']
  ];
  const cols = await c.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name=$1`, [CFG.tabela]);
  const tem = new Set(cols.rows.map(r => r.column_name));
  for (const [n, t] of novos)
    if (!tem.has(n)) { await c.query(`alter table ${CFG.tabela} add column ${n} ${t}`); console.log('coluna criada:', n); }

  const pend = await c.query(`
    select id, nome, telefone from ${CFG.tabela}
    where status <> 'fora'
      and (maps_em is null or maps_em < now() - interval '90 days')
    order by id limit ${ARGS.limite}`);
  console.log(`pendentes: ${pend.rowCount} | cidade: ${CFG.cidade}`);
  if (!pend.rowCount) { await c.end(); return; }

  /* Pipeline em 4 etapas: (1) escreve as consultas "nome" + cidade numa
     lista pro motor; (2) roda o gosom, que busca no Google Maps e grava JSON
     Lines; (3) casa cada linha devolvida com a base — telefone primeiro, nome
     depois; (4) grava categoria/nota/site ao lado do cadastro. */
  // 1) gera as consultas — nome + cidade, aspas pra prender o nome inteiro
  fs.mkdirSync(CFG.pasta, { recursive: true });
  const arqIn = path.join(CFG.pasta, 'consulta_padrao.txt');
  const arqOut = path.join(CFG.pasta, 'resultado_padrao.json');
  fs.writeFileSync(arqIn,
    pend.rows.map(r => `"${r.nome}" ${CFG.cidade}`).join('\n'), 'utf8');
  if (fs.existsSync(arqOut)) fs.unlinkSync(arqOut);

  /* Etapa 2 — execução SÍNCRONA: o arquivo de saída só existe quando o motor
     termina, então não há o que fazer enquanto ele roda. -exit-on-inactivity 5m
     é a trava que impede processo pendurado pra sempre numa consulta sem
     resultado; DISABLE_TELEMETRY desliga o relatório do gosom. O catch NÃO
     aborta: se o motor cair no meio, as linhas já gravadas continuam boas e o
     cruzamento usa o que houver. */
  console.log('rodando o motor do Google Maps (pode levar varios minutos)…');
  /* CÓDIGO MORTO (p/ remoção): o flag '-email' (na lista de args abaixo, na
     mesma linha do -lang) contradiz o cabeçalho deste arquivo e o README —
     ele manda o gosom coletar e-mail, e o cabeçalho registra que o modo de e-mail foi REPROVADO no teste (1/20 e
     era rastro de rastreio do Wix), então não entra na ponte. Confirmação de
     que é morto: a leitura da saída abaixo só usa title, phone, category,
     reviews e web_site — nenhum campo de e-mail é lido, ou seja, o motor
     trabalha pra nada. Remover '-email' dos args não muda resultado nenhum. */
  const args = ['-input', arqIn, '-results', arqOut, '-json',
    '-depth', String(ARGS.profundidade), '-c', String(ARGS.conc),
    '-lang', 'pt', '-email', '-exit-on-inactivity', '5m'];
  try {
    execFileSync(CFG.binario, args, { stdio: 'inherit', env: { ...process.env, DISABLE_TELEMETRY: '1' } });
  } catch (e) {
    console.log('motor saiu com erro (vamos usar o que gravou):', e.message);
  }
  /* Sem arquivo de saída não há nada pra cruzar (o motor nem começou a
     gravar) — aí aborta; diferente do catch acima, que segue com o parcial. */
  if (!fs.existsSync(arqOut)) { console.log('motor nao gerou saida'); process.exit(1); }

  /* Saída do gosom é JSON Lines (um objeto por linha), não array: parse linha
     a linha e descarta o que não fechar. Por quê: o motor pode ser
     interrompido (-exit-on-inactivity) e a última linha sai cortada — uma
     linha inválida não pode derrubar as N mil que já estão boas. */
  const linhas = fs.readFileSync(arqOut, 'utf8').split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
  console.log(`\nMaps devolveu ${linhas.length} estabelecimentos`);

  // 2) cruzamento de volta: telefone primeiro, depois nome
  const base = await c.query(`select id, nome, telefone, email from ${CFG.tabela}`);
  const porTel = new Map(), porNome = new Map();
  base.rows.forEach(r => {
    const t = normTel(r.telefone);
    if (t) porTel.set(t, r);
    porNome.set(nomeNorm(r.nome), r);
  });

  let casados = 0, gravados = 0, foraAlvo = 0, semTel = 0;
  const foraAlvoLista = [];

  for (const m of linhas) {
    const t = normTel(m.phone);
    let r = t ? porTel.get(t) : null;
    if (!r) {
      const nm = nomeNorm(m.title);
      r = porNome.get(nm);
      /* Última tentativa: match por SUBSTRING — é aqui que o erro mora.
         "bar do zé" casa com "bar do zé & filhos"; um nome curto casa com
         qualquer linha que o contenha; e o laço quebra no PRIMEIRO parcial,
         que é a ordem do SELECT (por id), não o candidato mais parecido. Ou
         seja: este passo troca segurança por alcance — só roda quando telefone e
         nome exato falharam, e é por isso que o dono confere o casamento na
         validação (ali o telefone é o árbitro, não o nome). */
      if (!r) for (const [k, v] of porNome) if (k && nm && (k.includes(nm) || nm.includes(k))) { r = v; break; }
    }
    if (!r) { if (!t) semTel++; continue; }
    casados++;

    const cat = m.category || (Array.isArray(m.categories) ? m.categories[0] : '') || null;
    const nota = m.review_rating != null ? String(m.review_rating) : null;
    const aval = m.review_count != null ? parseInt(m.review_count, 10) : null;
    const site = m.web_site || null;

    /* Duas direções de coalesce, de propósito:
       - categoria_maps/nota/avaliacoes/site_maps usam coalesce($n, coluna):
         o que o Maps diz HOJE prevalece — é a leitura mais nova do canal;
       - site e fonte_canal usam coalesce(coluna, $n): quem já tem valor
         mantém — o site declarado pela empresa não é substituído por link de
         rodapé do Maps, e a PRIMEIRA fonte que encheu fica registrada.
       maps_em = now() é a data do re-scan (mesma janela de 90 dias do
       varredor), o que torna a ponte retomável. */
    await c.query(`
      update ${CFG.tabela} set
        categoria_maps   = coalesce($2, categoria_maps),
        nota_maps        = coalesce($3, nota_maps),
        avaliacoes_maps  = coalesce($4, avaliacoes_maps),
        site_maps        = coalesce($5, site_maps),
        site             = coalesce(site, $5),
        fonte_canal      = coalesce(fonte_canal, 'maps'),
        maps_em          = now()
      where id = $1`,
      [r.id, cat, nota, aval, site]);
    gravados++;

    if (cat && !CATEGORIA_ALVO.test(cat)) {
      foraAlvo++;
      foraAlvoLista.push(`${r.nome}  ->  Maps diz: ${cat}`);
    }
  }

  console.log('\n=== CRUZAMENTO ===');
  console.log(`casados com a base: ${casados}/${linhas.length} (gravados: ${gravados})`);
  console.log(`categoria do Maps FORA do alvo: ${foraAlvo}`);
  if (foraAlvoLista.length) {
    console.log('\n--- quem o Google Maps diz que NÃO é lugar de refeicao ---');
    foraAlvoLista.slice(0, 40).forEach(x => console.log('  ' + x));
    if (foraAlvoLista.length > 40) console.log(`  ... +${foraAlvoLista.length - 40}`);
  }

  const resumo = await c.query(`
    select count(*) filter (where coalesce(categoria_maps,'')<>'')::int com_categoria,
           count(*) filter (where coalesce(nota_maps,'')<>'')::int com_nota,
           count(*) filter (where coalesce(site_maps,'')<>'')::int com_site,
           count(*) filter (where coalesce(avaliacoes_maps,0) < 30)::int poucas_avaliacoes
    from ${CFG.tabela} where status <> 'fora'`);
  console.log('\n=== RESUMO MAPS NA BASE ===', JSON.stringify(resumo.rows[0]));
  await c.end();
})().catch(e => { console.log('ERRO', e.message); process.exit(1); });
