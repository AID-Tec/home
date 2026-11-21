/* Casca do painel — menu fixo + roteador por hash (#/secao).
   ==========================================================================
   Por que existe (dono, 21/11): "Prossiga para unificação. Isso vai
   facilitar no momento de clonar o projeto." Uma URL só, um login só
   (app.js) e uma seção visível por vez.

   Como funciona:
   - #/painel (ou nada) mostra a seção que mora no próprio index.html;
   - seções migradas ficam em pacto/secoes/<nome>.html e são carregadas
     aqui dentro de #sec-frag (o HTML é injetado e os <script> rodam de
     novo — innerHTML sozinho não executa script);
   - seção ainda não migrada continua na página própria: o roteador manda
     para <nome>.html, então nada quebra durante a migração em ondas.

   Regra das seções migradas: o CSS usa o prefixo #sec-frag (só vale ali)
   e o script busca os elementos com $ = querySelector('#sec-frag #id'),
   porque o painel tem ids com o mesmo nome (lista, sync).
   ========================================================================== */
(function () {
  /* onda 1 da migração; as demais entram aqui conforme forem migradas */
  var MIGRADAS = { ideias: 1 };

  /* ainda em página própria (URL antiga continua válida) */
  var PAGINAS = {
    calendario: 'calendario.html',
    copy: 'copy.html',
    conteudo: 'conteudo.html',
    campanha: 'campanha.html',
    validacao: 'validacao.html',
    contato: 'contato.html',
    definicoes: 'definicoes.html'
  };

  function nomeRota() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    return (h.split('?')[0] || 'painel').toLowerCase();
  }

  function marcaMenu(nome) {
    var links = document.querySelectorAll('#menu a');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('ativo', links[i].getAttribute('href') === '#/' + nome);
    }
  }

  function mostraPainel(v) {
    var p = document.getElementById('sec-painel');
    if (p) p.style.display = v ? '' : 'none';
  }

  function alvo() {
    return document.getElementById('sec-frag');
  }

  function limpaSecao() {
    var a = alvo();
    if (a) a.innerHTML = '';
  }

  /* innerHTML não executa <script>: recria cada um para rodar de verdade */
  function rodarScripts(raiz) {
    var scripts = raiz.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var novo = document.createElement('script');
      if (s.src) novo.src = s.src;
      else novo.textContent = s.textContent;
      s.parentNode.replaceChild(novo, s);
    }
  }

  function abrirSecao(nome) {
    var a = alvo();
    if (!a) return;
    a.innerHTML = '<div class="vazio">carregando…</div>';
    fetch('secoes/' + nome + '.html?v=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        a.innerHTML = html;
        rodarScripts(a);
      })
      .catch(function (e) {
        a.innerHTML = '<div class="vazio">não carregou a seção (' +
                      (e.message || e) + ')</div>';
      });
  }

  function rota() {
    var nome = nomeRota();
    if (nome === 'painel') {
      limpaSecao();
      mostraPainel(true);
      marcaMenu(nome);
      window.scrollTo(0, 0);
      return;
    }
    if (!MIGRADAS[nome]) {
      if (PAGINAS[nome]) { location.href = PAGINAS[nome]; return; }
      location.hash = '#/painel';
      return;
    }
    mostraPainel(false);
    marcaMenu(nome);
    abrirSecao(nome);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', rota);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rota);
  } else {
    rota();
  }
})();
