<#
  guarda_chave.ps1 — guarda os segredos do disparo FORA do repositório.

  Rode UMA vez (e de novo só se trocar a chave):

      powershell -ExecutionPolicy Bypass -File .\guarda_chave.ps1

  O arquivo sai em  %LOCALAPPDATA%\aid\chaves.env  — que é fora da pasta do
  projeto, então o Git nunca vê. O disparar.js lê de lá (e de variável de
  ambiente, se você preferir definir no terminal: quem está no terminal manda).

  Chave do Brevo: site.brevo.com > Seu nome > SMTP & API > Chaves de API >
  Gerar nova chave (v1) com permissão de ENVIO DE E-MAIL. Ela não aparece no
  chat nem no Git — só aqui dentro da sua máquina.
#>
param(
  [string]$BrevoKey = '',
  [string]$PactoEmail = '',
  [string]$PactoSenha = ''
)

$dir = Join-Path $env:LOCALAPPDATA 'aid'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$arq = Join-Path $dir 'chaves.env'

if (-not $BrevoKey) { $BrevoKey = (Read-Host 'Chave da API do Brevo (xkeysib-...)').Trim() }
if (-not $PactoEmail) { $PactoEmail = (Read-Host 'E-mail do painel (login do Pacto)').Trim() }
if (-not $PactoSenha) { $PactoSenha = (Read-Host 'Senha do painel').Trim() }

if (-not $BrevoKey)   { Write-Error 'Sem chave do Brevo nao da pra disparar.'; exit 1 }
if (-not $PactoEmail) { Write-Error 'Sem e-mail do painel nao da pra ler a lista.'; exit 1 }
if (-not $PactoSenha) { Write-Error 'Sem senha do painel nao da pra ler a lista.'; exit 1 }

$linhas = @(
  '# segredos do disparo — FORA do Git, nao mover pra pasta do projeto',
  '# gerado em ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'),
  'BREVO_API_KEY=' + $BrevoKey,
  'PACTO_EMAIL=' + $PactoEmail,
  'PACTO_SENHA=' + $PactoSenha
)

# UTF-8 sem BOM (o leitor do disparar.js casa a linha inteira)
[System.IO.File]::WriteAllText($arq, ($linhas -join "`r`n") + "`r`n",
  (New-Object System.Text.UTF8Encoding($false)))

# quem entra no arquivo pode ler; o diretorio do usuario ja e restrito
Write-Host ''
Write-Host ('Guardado em ' + $arq) -ForegroundColor Green
Write-Host 'Fora do repositorio: o Git nao enxerga. Nao copie pra pasta do projeto.'
Write-Host ''
Write-Host 'Testa agora (nada sai, e so mostra o plano):'
Write-Host '  node ferramentas\disparo\disparar.js'
