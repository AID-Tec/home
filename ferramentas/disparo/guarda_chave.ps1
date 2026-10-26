<#
  guarda_chave.ps1 - guarda os segredos do projeto no .env CENTRAL.

  Arquivo central:  <raiz do repo>\.env   (aqui: D:\AIDSoluptions\home\.env)
  O .gitignore bloqueia ele (regra *.env) - o Git nunca sobe. Confira com:
      git check-ignore -v .env

  Rode UMA vez (e de novo so se trocar alguma coisa):

      powershell -ExecutionPolicy Bypass -File .\guarda_chave.ps1

  O que ja estah no .env ele mantem; tambem pega de um backup antigo em
  %LOCALAPPDATA%\aid\chaves.env se faltar algo. So pergunta o que faltar.

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

# raiz do repo = dois niveis acima deste script (ferramentas\disparo\ -> home)
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$arq = Join-Path $raiz '.env'

function Ler-Env([string]$caminho) {
  $d = @{}
  if ($caminho -and (Test-Path $caminho)) {
    Get-Content $caminho | ForEach-Object {
      $l = $_.Trim()
      if ($l -and -not $l.StartsWith('#')) {
        $i = $l.IndexOf('=')
        if ($i -gt 0) {
          $k = $l.Substring(0, $i).Trim()
          $v = $l.Substring($i + 1).Trim().Trim('"', "'")
          if ($k -and -not $d.ContainsKey($k)) { $d[$k] = $v }
        }
      }
    }
  }
  return $d
}

# central primeiro; backup antigo do LOCALAPPDATA so pra completar o que faltar
$existente = Ler-Env $arq
$backup = Ler-Env (Join-Path $env:LOCALAPPDATA 'aid\chaves.env')
foreach ($p in @(
  @{ v = 'BrevoKey';   k = 'BREVO_SMTP_KEY' },
  @{ v = 'PactoEmail'; k = 'PACTO_EMAIL' },
  @{ v = 'PactoSenha'; k = 'PACTO_SENHA' },
  @{ v = 'SmtpLogin';  k = 'BREVO_SMTP_USER' }
)) {
  $valor = Get-Variable -Name $p.v -ValueOnly -ErrorAction SilentlyContinue
  if (-not $valor -and $existente.ContainsKey($p.k)) { $valor = $existente[$p.k] }
  if (-not $valor) {
    # nomes do formato antigo no backup
    $velho = @{ BrevoKey = 'BREVO_API_KEY'; SmtpLogin = 'SMTP_LOGIN' }
    if ($velho.ContainsKey($p.v) -and $backup.ContainsKey($velho[$p.v])) { $valor = $backup[$velho[$p.v]] }
    elseif ($backup.ContainsKey($p.k)) { $valor = $backup[$p.k] }
  }
  if ($valor) { Set-Variable -Name $p.v -Value $valor }
}

if (-not $BrevoKey)   { $BrevoKey   = (Read-Host 'Chave do Brevo (API xkeysib-... ou SMTP xsmtpsib-...)').Trim() }
if (-not $PactoEmail) { $PactoEmail = (Read-Host 'E-mail do painel (login do Pacto)').Trim() }
if (-not $PactoSenha) { $PactoSenha = (Read-Host 'Senha do painel').Trim() }
if (-not $SmtpLogin)  { $SmtpLogin  = (Read-Host 'SMTP login do Brevo (aba SMTP, "Your SMTP login") - Enter pra pular').Trim() }

# monta o novo conteudo SEM perder nada que ja exista no .env
$atual = Ler-Env $arq
if ($SmtpLogin) { $atual['BREVO_SMTP_USER'] = $SmtpLogin }
if ($BrevoKey) { $atual['BREVO_SMTP_KEY'] = $BrevoKey }
if (-not $atual.ContainsKey('BREVO_SMTP_HOST')) { $atual['BREVO_SMTP_HOST'] = 'smtp-relay.brevo.com' }
if (-not $atual.ContainsKey('BREVO_SMTP_PORT')) { $atual['BREVO_SMTP_PORT'] = '587' }
if ($PactoEmail) { $atual['PACTO_EMAIL'] = $PactoEmail }
if ($PactoSenha) { $atual['PACTO_SENHA'] = $PactoSenha }

$ordem = @(
  'BREVO_SMTP_USER', 'BREVO_SMTP_KEY', 'BREVO_SMTP_HOST', 'BREVO_SMTP_PORT',
  'PACTO_EMAIL', 'PACTO_SENHA',
  'SUPABASE_DB_HOST', 'SUPABASE_DB_PORT', 'SUPABASE_DB_NAME',
  'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD'
)

# CADA elemento entre parenteses: dentro de @(), o '+' sem parentes vira
# elemento separado no PowerShell (',' tem precedencia maior que '+') e o
# arquivo sairia quebrado, com o valor na linha de baixo da chave.
$linhas = @(
  ('# Credenciais do projeto (Pacto Gorjeta) - LOCAL ONLY, o .gitignore bloqueia o Git.')
  ('# gerado em ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  ('')
  ('# Brevo (envio de e-mail)')
)
foreach ($k in @('BREVO_SMTP_USER', 'BREVO_SMTP_KEY', 'BREVO_SMTP_HOST', 'BREVO_SMTP_PORT')) {
  if ($atual.ContainsKey($k)) { $linhas += ($k + '=' + $atual[$k]) }
}
$linhas += ('')
$linhas += ('# Painel Pacto (login GoTrue: o tool le a lista e marca o enviado)')
foreach ($k in @('PACTO_EMAIL', 'PACTO_SENHA')) {
  if ($atual.ContainsKey($k)) { $linhas += ($k + '=' + $atual[$k]) }
}
if (($ordem | Where-Object { $atual.ContainsKey($_) -and $_ -like 'SUPABASE_*' }).Count -gt 0) {
  $linhas += ('')
  $linhas += ('# Banco Supabase - Postgres via pooler (scripts de conferencia)')
  foreach ($k in @('SUPABASE_DB_HOST', 'SUPABASE_DB_PORT', 'SUPABASE_DB_NAME', 'SUPABASE_DB_USER', 'SUPABASE_DB_PASSWORD')) {
    if ($atual.ContainsKey($k)) { $linhas += ($k + '=' + $atual[$k]) }
  }
}
# qualquer outra credencial que voce tenha posto no .env: mantem
$extras = @($atual.Keys | Where-Object { $ordem -notcontains $_ } | Sort-Object)
if ($extras.Count -gt 0) {
  $linhas += ('')
  $linhas += ('# Outras credenciais do projeto')
  foreach ($k in $extras) { $linhas += ($k + '=' + $atual[$k]) }
}

# UTF-8 (conteudo ASCII): o WindowsPowerShell 5.1 le .ps1 sem BOM como ANSI
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($arq, $linhas, $utf8)

# protecao: confirma que o Git ignora o arquivo
$ignorado = & git -C $raiz check-ignore -q '.env' 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'ALERTA: o .env NAO esta no .gitignore! Adicionando a regra *.env agora...'
  Add-Content -Path (Join-Path $raiz '.gitignore') -Value '*.env' -Encoding ASCII
}

Write-Host ''
Write-Host "Guardado em $arq  (central do projeto)"
Write-Host 'Bloqueado pro Git pelo .gitignore. Nao copie o conteudo pra chat/repo.'
if (-not $SmtpLogin) {
  Write-Host 'AVISO: sem SMTP login - se a chave for xsmtpsib-, o envio nao autentica.'
}
Write-Host ''
Write-Host 'Testa agora (nao sai nada, so mostra o plano):'
Write-Host '  node ferramentas\disparo\disparar.js'
Write-Host 'E pra validar a chave com 1 e-mail so pra voce:'
Write-Host '  node ferramentas\disparo\disparar.js --teste'
