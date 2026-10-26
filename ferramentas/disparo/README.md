# Disparo do Pacto Gorjeta — ferramenta padrão AID

> O texto que sai é o que está **aprovado no banco**; a lista é a **mesma regra
> da aba Campanha**; quem foi receber vira `status='email'` na hora — então o
> painel, o sorteio diário e o envio nunca se contradizem.

## O que faz

Lê a base do Pacto (`prospectos`), monta a fila com a regra fixa da aba
Campanha (tem e-mail · não é contador · não está fora do escopo · 1 por
e-mail), pega a **copy aprovada** da tabela `copias` (padrão `email_1`,
D+1), personaliza `{{contact.EMPRESA}}` por destinatário, anexa o **rodapé
LGPD** e dispara pelo **Brevo** — um a um, com pausa, no horário comercial.

**Transporte (automático, conforme a chave que existe na máquina):**

| Chave no `.env` | Caminho usado |
|---|---|
| `xsmtpsib-…` (SMTP) | servidor `smtp.brevo.com` via `smtp.js` — **é o caso atual** |
| `xkeysib-…` (API) | API HTTPS `api.brevo.com/v3/smtp/email` (reserva) |

As duas são a mesma conta em abas diferentes do Brevo; o tool serve pras
duas. SMTP exige o `SMTP_LOGIN` (aba SMTP, *"Your SMTP login"*).

**Cópia oculta (BCC) pra você**: todo envio leva `aidtecnologiaresolutiva@gmail.com`
como destinatário oculto — só no **envelope**, nunca como cabeçalho (o
prospect não vê). `--bcc outro@email` troca; `--sem-bcc` desliga.

Por que assim, e não "montar campanha à mão no Brevo": o texto aprovado é o
que sai (não uma cópia colada e esquecida), e **cada envio marca a linha**,
o que resolve três coisas de uma vez:

- **retomável** — rodou hoje os 10, amanhã os próximos 10 saem sozinhos
  (quem recebeu já saiu da fila);
- **o sorteio diário não repete** — ele só pega quem está `pendente`;
- **o passo 4 do fluxo enxerga** quem foi contactado (`email` conta).

Regra de quem **NÃO** recebe (rede de segurança, além do filtro): empresa
ainda **sem decisão** na validação (fora do segmento/CNPJ inativo que o dono
não olhou) e **CNPJ inativo** — primeiro ele decide, depois ele recebe.

## Ritmo: 10 por dia (decisão do dono, não é limite técnico)

| | |
|---|---|
| **Ritmo do projeto** | **10 e-mails por dia**, seg–sex, 8h–18h |
| Cota técnica do Brevo (plano gratuito) | 300/dia — nunca sugerida aqui |
| Lista atual (242 contatos) | ≈ 25 dias nesse ritmo, de propósito |

Poucos por dia = resposta acompanhada, horário comercial respeitado (CLT),
entregabilidade observada. O limite fica na constante `RITMO_DIA` do
`disparar.js`: `--limite` acima de 10 é recusado. O contador do dia vive em
`%LOCALAPPDATA%\aid\ritmo.json` (local, vale mesmo sem estatística do Brevo)
e o tool sempre para em 10 — repetir o comando no mesmo dia só manda o que
falta.

## Como roda

```
node ferramentas\disparo\disparar.js                    # dry-run: só o plano, NÃO envia
node ferramentas\disparo\disparar.js --teste            # 1 e-mail só pra você (valida a chave)
node ferramentas\disparo\disparar.js --limite 3 --enviar # teste pequeno com a lista real
node ferramentas\disparo\disparar.js --enviar            # os 10 do dia
node ferramentas\disparo\disparar.js --copy email_2 --status email --enviar   # follow-up D+4
```

Sem `--enviar` **nada sai**: ele mostra quem entra, quem fica de fora (e por
quê), o assunto, a prévia do 1º e-mail e quanto faltaria no ritmo.

### Segredos — local central: `.env` na raiz do projeto

**`D:\AIDSoluções\home\.env`** é o lugar único das credenciais do projeto.
Está no `.gitignore` (regra `*.env`) — o Git nunca sobe. Confira quando quiser:

```
git check-ignore -v .env     # tem que apontar uma regra do .gitignore
```

Para gravar/atualizar (mantém o que já existe, só pergunta o que faltar):

```
powershell -ExecutionPolicy Bypass -File ferramentas\disparo\guarda_chave.ps1
```

Ordem de leitura do `disparar.js`: **variável de terminal > `.env` do projeto >
backup antigo** `%LOCALAPPDATA%\aid\chaves.env` (legado, ignorado enquanto o
`.env` tiver valor). Copiar segredo pro chat ou pro Git = trocar a chave.

| Variável no `.env` | O que é |
|---|---|
| `BREVO_SMTP_USER` | login SMTP (aba SMTP, *"Your SMTP login"*) — não é segredo, só serve com a chave |
| `BREVO_SMTP_KEY` | chave do Brevo: `xsmtpsib-` (SMTP, atual) ou `xkeysib-` (API, reserva) |
| `BREVO_SMTP_HOST` `BREVO_SMTP_PORT` | servidor de saída (padrão `smtp-relay.brevo.com:587`) |
| `PACTO_EMAIL` `PACTO_SENHA` | login do painel — o tool LÊ a lista e MARCA o enviado como esse usuário autenticado (o anon não passa do RLS) |
| `SUPABASE_DB_*` | host/porta/banco/usuário/senha do Postgres (pooler) — dos scripts de conferência |

### Opções

| Flag | O que faz |
|---|---|
| `--teste` | 1 e-mail só pra você (assunto `[teste] …`) — valida chave/domínio sem tocar na lista |
| `--limite N` | quantos envia (padrão e máximo: 10) |
| `--copy CHAVE` | qual copy manda (padrão `email_1`; aprovadas: `email_1`, `email_2`, `email_3`) |
| `--status LISTA` | de quem recebe (padrão `pendente`; pro D+4: `--status email`) |
| `--replyto EMAIL` | para onde cai a resposta (padrão: `aidtecnologiaresolutiva@gmail.com`) |
| `--de "Nome <e>"` | remetente (padrão: Dyeison — AID Tecnologia <dyeison@aidtr.com.br>) |
| `--bcc EMAIL` / `--sem-bcc` | troca / desliga a cópia oculta que cai na sua caixa |
| `--pausa MS` | pausa entre envios (padrão 400 ms) |
| `--fora-horario` | libera envio fora das 8h–18h seg–sex |
| `--forcar` | envia copy não aprovada (só teste) |

## Segurança e LGPD (as que importam)

- **Origem lícita**: os e-mails vêm de cadastro público da Receita/portal
  público da própria empresa ou de canal que a empresa publica — contexto
  profissional, finalidade legítima (LGPD, Art. 7º, IX). Lista comprada ou
  vazada não entra nunca (Art. 42 e seguintes).
- **Rodapé LGPD sempre**: o tool anexa a copy `rodape` em todo envio; se ela
  faltar, avisa e recusa o dia.
- **Horário comercial**: fora de seg–sex 8h–18h ele recusa (CLT), a menos
  `--fora-horario`.
- **Sem spam**: 10/dia por vez, pausa entre envios, quem recebeu sai da fila
  na hora, seguimento D+4/D+9 só com copy aprovada e separada.
- **Resposta cai em você**: remetente `dyeison@aidtr.com.br` (domínio
  autenticado no Brevo) e MX do `aidtr.com.br` encaminha pro seu e-mail.

## Checklist — primeira vez

- [x] Rodar `guarda_chave.ps1` (chave do Brevo + login do painel + SMTP login)
- [x] `node disparar.js` — conferir o dry-run: contagem, assunto, prévia
- [x] `node disparar.js --teste` — 1 e-mail cai na sua caixa (chave + domínio ok)
- [x] `node disparar.js --limite 3 --enviar` — 3 e-mails reais, ver se chegam
- [x] Conferir no painel: os 3 viraram `email`, saíram do sorteio
- [ ] Todo dia, 1 por dia: `node disparar.js --enviar` (10/dia, seg–sex 8–18h)
- [ ] Conferir que as cópias ocultas chegam na sua caixa (BCC)
- [ ] Em D+4: `--copy email_2 --status email --enviar` (o 2º da sequência)
