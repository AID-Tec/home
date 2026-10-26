<#
  guarda_chave.ps1 - guarda os segredos do disparo FORA do repositorio.

  Rode UMA vez (e de novo so se trocar alguma coisa):

      powershell -ExecutionPolicy Bypass -File .\guarda_chave.ps1

  O arquivo sai em  %LOCALAPPDATA%\aid\chaves.env  - fora da pasta do
  projeto, entao o Git nunca ve. O disparar.js le de la (e de variavel de
  ambiente, se voce preferir definir no terminal).

  O que ja estah salvo ele mantem: so pergunta o que faltar.

  - BrevoKey  : site.brevo.com > SMTP & API > aba SMTP > a chave (xsmtpsib-...)
                ou aba API Keys (xkeysib-...). O tool serve pras duas.
  - SmtpLogin : site.brevo.com > SMTP & API > aba SMTP > "Your SMTP login".
                NAO eh segredo (sem a chave nao serve pra nada).
#>
param(
  [string]$BrevoKey = '',
  [string]$PactoEmail = '',
  [string]$PactoSenha = '',
  [string]$SmtpLogin = ''
)

$dir = Join-Path $env:LOCALAPPDATA 'aid'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$arq = Join-Path $dir 'chaves.env'

# ja existe? guarda o que ja tem - so pergunta o que faltar
$existente = @{}
if (Test-Path $arq) {
  Get-Content $arq | ForEach-Object {
    $l = $_.Trim()
    if ($l -and -not $l.StartsWith('#')) {
      $i = $l.IndexOf('=')
      if ($i -gt 0) {
        $k = $l.Substring(0, $i).Trim()
        $v = $l.Substring($i + 1).Trim().Trim('"', "'")
        if ($k -and -not $existente.ContainsKey($k)) { $existente[$k] = $v }
      }
    }
  }
}

$pares = @(
  @{ v = 'BrevoKey';   k = 'BREVO_API_KEY' },
  @{ v = 'PactoEmail'; k = 'PACTO_EMAIL' },
  @{ v = 'PactoSenha'; k = 'PACTO_SENHA' },
  @{ v = 'SmtpLogin';  k = 'SMTP_LOGIN' }
)
foreach ($p in $pares) {
  $valor = Get-Variable -Name $p.v -ValueOnly -ErrorAction SilentlyContinue
  if (-not $valor -and $existente.ContainsKey($p.k)) {
    Set-Variable -Name $p.v -Value $existente[$p.k]
  }
}

if (-not $BrevoKey)   { $BrevoKey   = (Read-Host 'Chave do Brevo (API xkeysib-... ou SMTP xsmtpsib-...)').Trim() }
if (-not $PactoEmail) { $PactoEmail = (Read-Host 'E-mail do painel (login do Pacto)').Trim() }
if (-not $PactoSenha) { $PactoSenha = (Read-Host 'Senha do painel').Trim() }
if (-not $SmtpLogin)  { $SmtpLogin  = (Read-Host 'SMTP login do Brevo (aba SMTP, "Your SMTP login") - Enter pra pular').Trim() }

# CADA elemento entre parenteses: dentro de @(), o '+' sem parentes vira
# elemento separado no PowerShell (',' tem precedencia maior que '+') e o
# arquivo sairia quebrado, com o valor na linha de baixo da chave.
$linhas = @(
  ('# segredos do disparo - FORA do Git, nao mover pra pasta do projeto')
  ('# gerado em ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  ('BREVO_API_KEY=' + $BrevoKey)
  ('PACTO_EMAIL=' + $PactoEmail)
  ('PACTO_SENHA=' + $PactoSenha)
)
if ($SmtpLogin) { $linhas += ('SMTP_LOGIN=' + $SmtpLogin) }

# UTF-8 com BOM de proposito: o WindowsPowerShell 5.1 le .ps1 sem BOM como
# ANSI e bagunca qualquer caractere fora do ASCII.
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllLines($arq, $linhas, $utf8Bom)

Write-Host ''
Write-Host "Guardado em $arq"
Write-Host 'Fora do repositorio: o Git nao enxerga. Nao copie pra pasta do projeto.'
if (-not $SmtpLogin) {
  Write-Host 'AVISO: sem SMTP login - se a chave for xsmtpsib-, o envio nao autentica.'
}
Write-Host ''
Write-Host 'Testa agora (nao sai nada, so mostra o plano):'
Write-Host '  node ferramentas\disparo\disparar.js'
Write-Host 'E pra validar a chave com 1 e-mail so pra voce:'
Write-Host '  node ferramentas\disparo\disparar.js --teste'
