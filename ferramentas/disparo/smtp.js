'use strict';
/* ==========================================================================
   smtp.js — cliente SMTP mínimo (zero dependência) pro disparo do Pacto.

   Por que existe: a chave que a conta tem é a chave SMTP do Brevo
   (xsmtpsib-…, aba SMTP & API > SMTP). A API HTTP (xkeysib-…) é outra chave
   e ela recusa a SMTP ("Key not found"). Em vez de exigir chave nova, o tool
   fala direto com o servidor do Brevo — mesmo resultado, mesmo domínio
   autenticado, mesmo plano gratuito.

   Só o que o disparo precisa:
   - conectar com TLS (smtp.brevo.com:465) ou STARTTLS (smtp-relay:587)
   - EHLO · AUTH PLAIN (login + chave SMTP) · MAIL FROM · RCPT TO · DATA
   - mensagem MIME em multipart/alternative (texto + HTML), tudo em base64
     (assim acento não quebra em lugar nenhum)
   - BCC: o destinatário extra entra só no envelope — NUNCA como cabeçalho,
     senão o prospect veria o seu e-mail no rodapé da mensagem.

   A cópia que cai na sua caixa (BCC) chega com o campo "Para:" do prospect
   (é cópia de registro, não é resposta) — e some da lista de "não lidos" sozinha.
   ========================================================================== */

const net = require('net');
const tls = require('tls');

/* ordem de tentativa: TLS direto é o mais simples e o mais estável */
const HOSTS = [
  { host: 'smtp.brevo.com', porta: 465, modo: 'tls' },
  { host: 'smtp-relay.brevo.com', porta: 587, modo: 'starttls' }
];

const TIMEOUT_CMD = 20000;
const TIMEOUT_CON = 15000;

/* ----------------------------- utilidades ------------------------------- */
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const ehAscii = s => /^[\x20-\x7E]+$/.test(s || '');

function encodedWord(s) { return '=?UTF-8?B?' + b64(s) + '?='; }

function comNome(nome, email) {
  if (!nome) return '<' + email + '>';
  const n = String(nome).replace(/["\\]/g, '');
  return (ehAscii(n) ? '"' + n + '"' : encodedWord(n)) + ' <' + email + '>';
}

function quebraBase64(b) {          /* RFC: linhas de 76 chars, CRLF */
  const out = [];
  for (let i = 0; i < b.length; i += 76) out.push(b.slice(i, i + 76));
  return out.join('\r\n');
}

function ultimaLinha(txt) {
  const l = String(txt || '').split('\n');
  return l[l.length - 1] || '';
}

/* --------------------------- conexão + leitura --------------------------- */
function novaConexao() {
  const est = { sock: null, buf: '', espera: null, morto: null };

  function liga(sock) {
    est.sock = sock;
    est.buf = '';
    sock.on('data', d => { est.buf += d.toString('latin1'); processa(); });
    sock.on('error', e => { falha(e); });
    sock.on('close', () => { falha(est.morto || new Error('conexao fechada pelo servidor')); });
  }
  function falha(e) {
    est.morto = est.morto || e;
    if (est.espera) { const x = est.espera; est.espera = null; clearTimeout(x.t); x.rej(e); }
  }
  function processa() {
    if (!est.espera) return;
    for (;;) {
      const i = est.buf.indexOf('\r\n');
      if (i < 0) return;
      const linha = est.buf.slice(0, i);
      est.buf = est.buf.slice(i + 2);
      est.espera.acum.push(linha);
      const m = /^(\d{3})([ -])/.exec(linha);
      if (m && m[2] === ' ') {
        const x = est.espera; est.espera = null; clearTimeout(x.t);
        x.resolve({ codigo: +m[1], texto: x.acum.join('\n') });
        return;
      }
    }
  }
  function resposta() {
    if (est.morto) return Promise.reject(est.morto);
    return new Promise((resolve, rej) => {
      est.espera = {
        resolve, rej, acum: [],
        t: setTimeout(() => {
          if (est.espera && est.espera.rej === rej) {
            est.espera = null;
            rej(new Error('timeout esperando resposta do servidor'));
          }
        }, TIMEOUT_CMD)
      };
      processa();                    /* já pode ter dado resposta no buffer */
    });
  }

  return {
    liga,
    async cmd(linha) {
      if (est.morto) throw est.morto;
      const p = resposta();
      est.sock.write(linha + '\r\n');
      return p;
    },
    aguarda: resposta,
    escrever(bruto) { if (est.morto) throw est.morto; est.sock.write(bruto); },
    upgrade(servername) {
      return new Promise((resolve, rej) => {
        const s = tls.connect({ socket: est.sock, servername: servername }, () => {
          liga(s); resolve();
        });
        s.on('error', rej);
      });
    },
    fechar() { try { est.sock && est.sock.end(); } catch (e) {} try { est.sock && est.sock.destroy(); } catch (e) {} }
  };
}

function conectar(alvo) {
  return new Promise((resolve, rej) => {
    const op = { host: alvo.host, port: alvo.porta, servername: alvo.host };
    const sock = alvo.modo === 'tls' ? tls.connect(op, () => resolve(sock))
                                     : net.connect(op, () => resolve(sock));
    const t = setTimeout(() => { try { sock.destroy(); } catch (e) {} rej(new Error('timeout ao conectar em ' + alvo.host)); }, TIMEOUT_CON);
    sock.on('error', e => { clearTimeout(t); rej(new Error(alvo.host + ': ' + e.message)); });
    sock.once(alvo.modo === 'tls' ? 'secureConnect' : 'connect', () => clearTimeout(t));
  });
}

/* ---------------------------- monta a mensagem --------------------------- */
function montaMensagem(o) {
  const fronteira = '=_pacto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const h = [];
  h.push('From: ' + comNome(o.de.nome, o.de.email));
  h.push('To: ' + comNome(o.para.nome, o.para.email));
  /* Bcc NUNCA como cabeçalho: entra só no envelope (ver mandaEmail) */
  if (o.replyTo) h.push('Reply-To: <' + o.replyTo + '>');
  h.push('Subject: ' + (ehAscii(o.assunto) ? o.assunto : encodedWord(o.assunto)));
  h.push('Date: ' + new Date().toUTCString().replace(/GMT$/, '+0000'));
  h.push('Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@aidtr.com.br>');
  h.push('MIME-Version: 1.0');
  h.push('Content-Type: multipart/alternative; boundary="' + fronteira + '"');
  h.push('');

  const p = [];
  p.push('--' + fronteira);
  p.push('Content-Type: text/plain; charset=utf-8');
  p.push('Content-Transfer-Encoding: base64');
  p.push('');
  p.push(quebraBase64(b64(o.texto || '')));
  p.push('--' + fronteira);
  p.push('Content-Type: text/html; charset=utf-8');
  p.push('Content-Transfer-Encoding: base64');
  p.push('');
  p.push(quebraBase64(b64(o.html || o.texto || '')));
  p.push('--' + fronteira + '--');
  p.push('');

  let msg = h.join('\r\n') + '\r\n' + p.join('\r\n');
  msg = msg.replace(/\r\n\./g, '\r\n..');      /* dot-stuffing (RFC 5321) */
  return msg + '\r\n.\r\n';
}

/* ------------------------------ um envio --------------------------------- */
async function porHost(alvo, o) {
  const sock = await conectar(alvo);
  const c = novaConexao();
  c.liga(sock);
  try {
    let r = await c.aguarda();                              /* 220 banner */
    if (r.codigo !== 220) throw new Error('banner ' + r.codigo + ' ' + ultimaLinha(r.texto));

    r = await c.cmd('EHLO pacto.aidtr.com.br');             /* 250 */
    if (r.codigo !== 250) throw new Error('EHLO ' + r.codigo);

    if (alvo.modo === 'starttls') {
      r = await c.cmd('STARTTLS');
      if (r.codigo !== 220) throw new Error('STARTTLS ' + r.codigo);
      await c.upgrade(alvo.host);
      r = await c.cmd('EHLO pacto.aidtr.com.br');
      if (r.codigo !== 250) throw new Error('EHLO pós-TLS ' + r.codigo);
    }

    /* Autenticação: tenta AUTH PLAIN de uma vez; se o servidor recusar o
       mecanismo (504/500/502) ou as credenciais (535), cai pro AUTH LOGIN
       clássico (334 usuário / 334 senha) — as duas formas valem a mesma chave. */
    let loginOk = null, erroAuth = null;
    for (const login of o.logins) {
      let r = await c.cmd('AUTH PLAIN ' + b64('\0' + login + '\0' + o.senha));
      if (r.codigo === 235) { loginOk = login; break; }

      if ([535, 504, 502, 500, 501].indexOf(r.codigo) >= 0) {
        const r2 = await c.cmd('AUTH LOGIN');
        if (r2.codigo === 334) {
          let r3 = await c.cmd(b64(login));
          if (r3.codigo === 334) r3 = await c.cmd(b64(o.senha));
          if (r3.codigo === 235) { loginOk = login; break; }
          r = r3;
        } else {
          r = r2;
        }
      }
      erroAuth = r.codigo + ' ' + ultimaLinha(r.texto);
      if (r.codigo !== 334 && r.codigo !== 535 && r.codigo !== 504) break;  /* não insiste em erro estranho */
    }
    if (!loginOk) {
      const e = new Error('autenticação recusada (' + erroAuth + ')');
      e.tipo = 'auth';
      throw e;
    }
    if (o.onLogin) o.onLogin(loginOk);

    r = await c.cmd('MAIL FROM:<' + o.de.email + '>');
    if (r.codigo !== 250) throw new Error('MAIL FROM ' + r.codigo + ' ' + ultimaLinha(r.texto));

    /* destinatário + cópia oculta (só no envelope) */
    const destinos = [o.para.email].concat(o.bcc ? [o.bcc] : []);
    for (const d of destinos) {
      r = await c.cmd('RCPT TO:<' + d + '>');
      if (r.codigo !== 250 && r.codigo !== 251) {
        throw new Error('destinatário ' + d + ' recusado (' + r.codigo + ' ' + ultimaLinha(r.texto) + ')');
      }
    }

    r = await c.cmd('DATA');
    if (r.codigo !== 354) throw new Error('DATA ' + r.codigo);

    c.escrever(montaMensagem(o));
    r = await c.aguarda();                                  /* 250 queued */
    if (r.codigo !== 250) throw new Error('fila ' + r.codigo + ' ' + ultimaLinha(r.texto));

    try { await c.cmd('QUIT'); } catch (e) {}
    return { ok: true, codigo: 250, detalhe: ultimaLinha(r.texto), login: loginOk, host: alvo.host };
  } finally {
    c.fechar();
  }
}

/* ------------------------- público: mandaEmail --------------------------- */
/* o  = { de:{nome,email}, para:{nome,email}, bcc, replyTo, assunto, texto, html,
          senha, logins:[...], host?, porta? }   (host/porta: do .env, se tiver) */
async function mandaEmail(o) {
  let ultimo = null;
  const alvos = o.host
    ? [{ host: o.host, porta: Number(o.porta) || 587, modo: Number(o.porta) === 465 ? 'tls' : 'starttls' }]
    : HOSTS;
  for (const alvo of alvos) {
    try {
      const r = await porHost(alvo, o);
      r.host = alvo.host;
      return r;
    } catch (e) {
      ultimo = e;
      if (e.tipo === 'auth') break;     /* a conta é a mesma nos dois hosts */
    }
  }
  const err = ultimo || new Error('falhou em todos os hosts');
  return { ok: false, codigo: err.codigo || 0, detalhe: err.message, tipo: err.tipo || null };
}

module.exports = { mandaEmail };
