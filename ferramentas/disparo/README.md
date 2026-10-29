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
`disparar.js`: `--limite` acima de 10 é recusado. O contador do dia sai do
**maior** entre três fontes — tabela `envios` no banco (vale no CI, onde não
existe arquivo local), `%LOCALAPPDATA%\aid\ritmo.json` (reserva local) e a
estatística do Brevo (só com chave de API) — e o tool sempre para em 10;
repetir o comando no mesmo dia só manda o que falta.

## Modo `--rotina` e agendamento automático

O modo `--rotina` é o que roda quando **ninguém está olhando**: em vez de
listar por `--status`, ele pergunta **o que venceu**, lendo o histórico da
tabela `envios` (1 linha por e-mail que saiu):

```
node ferramentas\disparo\disparar.js --rotina            # o que venceu AGORA (dry-run)
node ferramentas\disparo\disparar.js --rotina --enviar   # manda o que venceu
```

Regras do plano (por que estão assim):

| Etapa | Espera desde o envio anterior | Faixa horária |
|---|---|---|
| `email_1` | dia do cadastro | 09:00 |
| `email_2` | +4 dias | 15:00 |
| `email_3` | +5 dias (D+9) | 18:00 |

- **Cada gatilho manda tudo que já venceu com faixa ≤ a hora dele** — se um
  gatilho falhar, o próximo pega; nada se perde, nada duplica;
- **vencimento sai do histórico**, nunca de `atualizado_em` (que muda com
  qualquer edição e mentiria a data);
- **interrupção automática**: follow-up só sai de quem continua com
  `status='email'` — decisão do dono (`nao`, `zap`, `ligou`, `demo`,
  `fechou`, `fora`) corta a sequência daquela empresa na hora;
- `prospectos.hora_envio` (preenchido pelo monitor de retorno do n8n, abaixo)
  **sobrescreve** a faixa da etapa, pra aquele contato.

### Quem acorda: GitHub Actions (24/7, sem PC ligado)

`.github/workflows/rotina.yml` roda `--rotina --enviar` em **3 horários de
Brasília** (UTC-3), de segunda a sexta: 09:00 (`0 12 * * 1-5`), 15:00
(`0 18 * * 1-5`) e 18:00 (`0 21 * * 1-5`). Também dispara na mão pelo
Actions → *Run workflow* (vazio = dry-run; marcado = envia de verdade).

- **Segredos**: só no cofre do Actions (Settings → Secrets and variables →
  Actions) — no YAML aparece `${{ secrets.NOME }}`, nunca o valor. Se o cofre
  estiver vazio, o job **avisa e passa reto** (nunca vermelho, nunca envia sem
  chave).
- **Log público**: o repo é público, então a ferramenta liga o **modo sigilo
  sozinho** (detecta `CI=true`) — no log só `prospecto #id`, nunca e-mail nem
  nome de prospecto. No seu PC o log continua completo.
- **Pós-envio**: o job dá um `curl` na webhook do n8n (acorda o Render e
  roda a checagem de retorno/alertas); se o n8n falhar, o envio **não** é
  dado como perdido (`continue-on-error`).

### Quem vigia os retornos: n8n no Render (automático)

O n8n self-hosted (`n8n-aid-ebg9.onrender.com`) monitora a caixa do dono e
age sozinho — é ele que faz a **interrupção automática** acontecer sem
ninguém lembrar:

```
Gatilho IMAP (INBOX, não-lidos, marca como lido)
  → Separa remetentes        (extrai o "De:"; corta o texto citado)
  → Procura no painel        (só quem está com status='email')
  → Cruza e decide           (procura palavra de recusa, sem acento)
      ├─ É recusa?  → sim: Grava recusa (status='nao')  → Avisa recusa
      └─            → não: Ajusta hora (hora_envio)     → Avisa retorno
```

- **Corte de recusa é automático**: `nao quero`, `sem interesse`,
  `tirar da lista`, `descadast…` etc. marcam `status='nao'` no banco — e como
  o `--rotina` só segue quem está `email`, a sequência morre na hora (sem
  precisar de ninguém no painel);
- **A hora da resposta vira `hora_envio`** (09/15/18) — o próximo e-mail dele
  sai na faixa em que ele costuma responder;
- **Texto citado é cortado** antes da busca (`>`, "On … wrote:", "Em …,
  escreveu:"): sem isso, o rodapé LGPD do nosso próprio e-mail citado casaria
  e cortaria gente errada. As cópias `email_1` e `rodape` foram conferidas:
  zero palavra de recusa;
- **Alerta pro dono**: texto completo da resposta no e-mail dele. Canal =
  **SMTP do Gmail na porta 587** (a sonda mostrou que o Render free não
  conecta na 465 e o Brevo 587 não sai da rede do Render) — com retry 3× no
  nó; o banco é gravado **antes** do alerta, então falha de e-mail nunca
  perde o corte;
- **Segredos do n8n**: só no cofre do próprio n8n (`imap-gmail-pacto`,
  `gmail-alerta-587`, `postgres-pacto`) — app password do Gmail, nunca a
  senha da conta;
- **Render free dorme** ~15 min ocioso: o job do cron-job.org (a cada 5 min,
  URL raiz) mantém a instância viva, e o gatilho IMAP lê a caixa a cada
  ~1 min enquanto acordado. O webhook `pacto-retorno` (batida pós-envio do
  Actions) é o outro acordador.

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

**`D:\AIDSolucoes\home\.env`** é o lugar único das credenciais do projeto.
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
| `--rotina` | decide sozinho o que venceu lendo o histórico `envios` (usa com `--enviar`; é o que o Actions roda) |
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
- [x] Todo dia, 1 por dia: `node disparar.js --enviar` (10/dia, seg–sex 8–18h)
- [x] Conferir que as cópias ocultas chegam na sua caixa (BCC)
- [x] Em D+4: `--copy email_2 --status email --enviar` (o 2º da sequência)
- [ ] **Agendado no Actions** (9h/15h/18h seg–sex) — conferir o resultado em
      Actions → `Pacto · rotina de envio`; se cair, rodar `--rotina` na mão
- [ ] Cofre do Actions preenchido (`BREVO_SMTP_*`, `PACTO_EMAIL`, `PACTO_SENHA`,
      `N8N_WEBHOOK`) — enquanto vazio, o job só avisa e não envia
- [ ] Monitor de retorno ativo no n8n (fluxo `Pacto - retorno e alertas`) —
      recusa vira `status='nao'` sozinha e o alerta cai na sua caixa
- [ ] Agendador do cron-job.org a cada 5 min batendo na raiz do Render
      (mantém a instância acordada pro IMAP ler a caixa)
