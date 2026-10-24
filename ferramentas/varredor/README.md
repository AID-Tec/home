# Varredor de canais — ferramenta padrão AID

> Toda base de prospecção da AID passa por aqui antes de virar campanha.

## O que faz

Para cada empresa de uma lista (nome + cidade), busca na web o **canal que a
própria empresa publica hoje**: WhatsApp, telefone, e-mail, site e Instagram.
Grava tudo ao lado do cadastro, com **data e fonte** — nada sobrescreve o dado
cadastral original.

Por que é padrão: cadastro de Receita Federal é autodeclarado e ninguém
atualiza (e-mail do contador de 2015, telefone já desligado). Quem tem
WhatsApp hoje é quem publicou hoje. E erro de segmento queima o nome da AID —
então a atividade real do CNPJ (BrasilAPI) entra junto, e o painel de
validação (`pacto/validar-base.html`) transforma isso em decisão.

## Como roda

```
node varredor.js --base "Franca SP" [--limite 50] [--fontes ddg,bing,searx]
```

Credenciais **nunca no código**: vem só de variável de ambiente.

| Variável | O que é |
|---|---|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | conexão com o Postgres (Supabase pooler) |
| `TABELA` | tabela de entrada (padrão: `prospectos`) |
| `COL_NOME` `COL_CIDADE` | colunas do nome e da cidade (padrão: `nome`, cidade = `--base`) |

## Regras de comportamento (as que importam)

- **Falar com quem decide**: a venda B2B é entre pessoas — o alvo é o
  dono/sócio, não o atendente. Então busca o contato do DECISOR quando ele é
  público e profissional (WhatsApp publicado no perfil do negócio, e-mail no
  site/iFood/Google Meu Negócio, cartão que a empresa divulga). LGPD ampara:
  finalidade legítima, contexto profissional (Art. 7º, IX), e a origem fica
  registrada em `web_dica` + `fonte_canal`.
- **O que NÃO entra**: número/e-mail sem procedência comprovável (lista
  comprada, base vazada, perfil privado). Não é só sigilo — é prática: sem
  contexto a pessoa não atende e o contato queima. E por lei: dado vazado não
  vira base legal de uso para ninguém da cadeia (LGPD, Art. 42 e seguintes) —
  finalidade boa não cura origem ilícita. Dado vazado é ainda quase sempre
  dado velho: o mesmo erro de cadastro desatualizado que este varredor existe
  pra corrigir.
- **Rate limit é lei**: cada fonte tem seu cooldown; bloqueio (HTTP 202/403/429)
  põe a fonte em espera e o varredor segue com a próxima em vez de parar.
- **Retomável**: gravando `web_em` por linha; rodar de novo só pega o que faltou.
- **Audável**: `web_dica` guarda o trecho do resultado que justificou o achado,
  e a página de validação mostra tudo pra um humano conferir.

## Fontes (em cadeia, na ordem)

1. **DuckDuckGo HTML** — anônimo, bom sinal, mas bloqueia se for pesado (cooldown 20 min)
2. **Bing** — resultados estáveis, links decodificados
3. **SearxNG** (searx.be, inetol, tiekoetter) — agregadores, sem chave
4. **Direto no site da empresa** quando o cadastro já tem site/Instagram

## Checklist de implantação em um projeto novo

- [ ] Definir `--base` (cidade) e a tabela de entrada
- [ ] Rodar `--limite 10` e conferir 10 linhas à mão antes de soltar tudo
- [ ] Rodar completo (retomável — pode deixar rodando)
- [ ] Abrir `pacto/validar-base.html` e decidir quem entra/sai
- [ ] Só então gerar a campanha (`pacto/campanha.html`)
