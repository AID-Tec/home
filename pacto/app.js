/* AID — login compartilhado das páginas do pacto.
   Uso: AID.entrar().then(sess => { if (!sess) return; ... })
   A chave abaixo é a anon (pública por design). O que protege os dados é o RLS no banco.

   Padrão do módulo (IIFE: nada vaza pro global além de window.AID):
   - entrar() é a porta única de entrada: devolve a sessão se já existir,
     senão mostra o gate e FICA DEVENDO a sessão (Promise) até o login —
     assim toda página espera o login sem poluir o código de cada página;
   - quem já está logado nunca vê o gate de novo (getSession resolve);
   - `window.__aidPendente` guarda o resolve da promise pendente;
     `aid:login` (CustomEvent) avisa quem quiser reagir sem usar a promise. */
(function () {
  var SB_URL = 'https://uewqkwmzpmnpebdsldto.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVld3Frd216cG1ucGViZHNsZHRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NjExMDgsImV4cCI6MjEwODMzNzEwOH0.wXPqKO5hkU2FqH3wDPRimoHWprI7NAWX5odknhX6bvY';

  var sb = null;
  try { sb = supabase.createClient(SB_URL, SB_KEY); } catch (e) { console.error('supabase-js nao carregou', e); }

  /* HTML do gate (string, injetado uma vez só). Estilo inline de propósito:
     a página pode carregar sem CSS e o gate ainda precisa ficar utilizável. */
  var HTML =
    '<div id="loginGate" style="position:fixed;inset:0;z-index:9999;background:#0f1430;display:flex;align-items:center;justify-content:center;padding:20px">' +
      '<div style="width:100%;max-width:370px;background:#fff;border-radius:18px;padding:26px 24px;box-shadow:0 24px 60px rgba(0,0,0,.35)">' +
        '<div style="font:700 22px/1.2 Montserrat,system-ui,sans-serif;color:#182A69">AID</div>' +
        '<div style="font:400 13px/1.5 Montserrat,system-ui,sans-serif;color:#5b6478;margin:6px 0 20px">Acesso restrito. Entre com e-mail e senha.</div>' +
        '<form id="formLogin" autocomplete="on">' +
          '<input id="loginEmail" type="email" placeholder="E-mail" autocomplete="username" required style="width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #d8dcea;border-radius:10px;font:400 15px Montserrat,system-ui,sans-serif;margin-bottom:10px">' +
          '<input id="loginSenha" type="password" placeholder="Senha" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:13px 14px;border:1px solid #d8dcea;border-radius:10px;font:400 15px Montserrat,system-ui,sans-serif;margin-bottom:14px">' +
          '<button id="btnEntrar" type="submit" style="width:100%;padding:14px;border:0;border-radius:10px;background:#2E3699;color:#fff;font:700 15px Montserrat,system-ui,sans-serif;cursor:pointer">Entrar</button>' +
          '<div id="loginErro" style="font:400 13px/1.5 Montserrat,system-ui,sans-serif;color:#c0392b;margin-top:12px;min-height:18px"></div>' +
        '</form>' +
      '</div>' +
    '</div>';

  /* Monta o gate uma única vez (guard por getElementById — reabrir não
     duplica) e liga o submit. No sucesso: esconde o gate, mostra os botões
     de conta, dispara 'aid:login' e resolve a promise pendente (se houver).
     O botão fica desabilitado durante o request pra não mandar 2 logins. */
  function abrirGate() {
    if (document.getElementById('loginGate')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap.firstElementChild);
    document.getElementById('formLogin').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = document.getElementById('btnEntrar');
      var erro = document.getElementById('loginErro');
      erro.textContent = '';
      btn.disabled = true; btn.textContent = 'Entrando\u2026';
      sb.auth.signInWithPassword({
        email: document.getElementById('loginEmail').value.trim(),
        password: document.getElementById('loginSenha').value
      }).then(function (r) {
        btn.disabled = false; btn.textContent = 'Entrar';
        if (r.error) { erro.textContent = 'Nao entrou: ' + (r.error.message || 'verifique e-mail e senha'); return; }
        var g = document.getElementById('loginGate');
        if (g) g.style.display = 'none';
        botoes();
        document.dispatchEvent(new CustomEvent('aid:login'));
        if (window.__aidPendente) { var f = window.__aidPendente; window.__aidPendente = null; f(r.data.session); }
      });
    });
  }

  /* Botões flutuantes "Trocar senha / Sair" (canto inferior direito).
     Guard por id: se a página já criou, não cria outro. Sair = signOut +
     reload — recarregar é o jeito mais limpo de voltar pro gate limpo. */
  function botoes() {
    if (document.getElementById('aidConta')) return;
    var d = document.createElement('div');
    d.id = 'aidConta';
    d.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9998;display:flex;gap:8px';
    d.innerHTML =
      '<button id="aidSenha" style="padding:10px 16px;border:1px solid #d8dcea;border-radius:999px;background:#fff;color:#5b6478;font:600 13px Montserrat,system-ui,sans-serif;cursor:pointer">Trocar senha</button>' +
      '<button id="aidSair" style="padding:10px 16px;border:1px solid #d8dcea;border-radius:999px;background:#fff;color:#5b6478;font:600 13px Montserrat,system-ui,sans-serif;cursor:pointer">Sair</button>';
    document.body.appendChild(d);
    document.getElementById('aidSair').onclick = function () {
      sb.auth.signOut().then(function () { location.reload(); });
    };
    document.getElementById('aidSenha').onclick = trocarSenha;
  }

  /* Troca a senha do usuário logado (GoTrue exige mínimo de 6).
     prompt/alert de propósito: recurso raro, não vale uma tela própria. */
  function trocarSenha() {
    var p = window.prompt('Nova senha (minimo 6 caracteres):');
    if (!p) return;
    if (p.length < 6) { window.alert('Curta demais — minimo 6 caracteres.'); return; }
    sb.auth.updateUser({ password: p }).then(function (r) {
      window.alert(r.error ? ('Nao trocou: ' + r.error.message) : 'Senha trocada.');
    });
  }

  /* Porta de entrada de todas as páginas:
     1) sessão já existe (login anterior no mesmo navegador) → resolve na hora;
     2) não existe → guarda o resolve em __aidPendente e abre o gate.
     Enquanto o usuário não logar, a promise fica pendente — as páginas
     chamam AID.entrar().then(...) e só começam a trabalhar com sessão. */
  async function entrar() {
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) { botoes(); return s.data.session; }
    return new Promise(function (resolve) {
      window.__aidPendente = resolve;
      abrirGate();
    });
  }

  window.AID = { sb: sb, entrar: entrar };
})();
