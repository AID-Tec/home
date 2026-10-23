/* AID — login compartilhado das páginas de campo.
   Uso: AID.entrar().then(sess => { if (!sess) return; ... })
   A chave abaixo é a anon (pública por design). O que protege os dados é o RLS no banco. */
(function () {
  var SB_URL = 'https://uewqkwmzpmnpebdsldto.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVld3Frd216cG1ucGViZHNsZHRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NjExMDgsImV4cCI6MjEwODMzNzEwOH0.wXPqKO5hkU2FqH3wDPRimoHWprI7NAWX5odknhX6bvY';

  var sb = null;
  try { sb = supabase.createClient(SB_URL, SB_KEY); } catch (e) { console.error('supabase-js nao carregou', e); }

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
        document.dispatchEvent(new CustomEvent('aid:login'));
        if (window.__aidPendente) { var f = window.__aidPendente; window.__aidPendente = null; f(r.data.session); }
      });
    });
  }

  async function entrar() {
    var s = await sb.auth.getSession();
    if (s.data && s.data.session) return s.data.session;
    return new Promise(function (resolve) {
      window.__aidPendente = resolve;
      abrirGate();
    });
  }

  window.AID = { sb: sb, entrar: entrar };
})();
