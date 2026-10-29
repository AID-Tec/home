<#
  ==========================================================================
  troca_pat.ps1 — Troca o "crachá" (Personal Access Token) do GitHub no PC.

  Por que existe: o token antigo (a) tinha permissão menor e o GitHub recusa
  o arquivo de agendamento (.github/workflows/rotina.yml) sem o escopo
  "workflow", e (b) vazou numa conversa — credencial vazada se troca, ponto.

  O que ele faz, nessa ordem:
    1) pergunta o token novo com a tela ESCURA (não aparece, não é gravado
       em arquivo nenhum e nunca passa pelo chat);
    2) confere na API do GitHub se o token tem as permissões certas
       (repo + workflow) — avisa na hora se faltou caixinha;
    3) guarda o token no COFRE DO WINDOWS (credencial do git), não no
       endereço do repositório;
    4) deixa o endereço LIMPO (https://github.com/AID-Tec/home.git) — assim
       "git remote -v" nunca mais mostra token nenhum;
    5) testa com um "git ls-remote" de verdade.

  Uso: powershell -ExecutionPolicy Bypass -File troca_pat.ps1
  Depois de rodar: apagar o token ANTIGO em github.com/settings/tokens.
  ==========================================================================
#>

$ErrorActionPreference = 'Stop'

/* raiz do repo: o script mora em ferramentas\disparo, sobe 2 níveis */
$raiz = if ($PSScriptRoot) { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
        else { 'D:\AIDSolucoes\home' }

Write-Host '=== Troca do token do GitHub ===' -ForegroundColor Cyan
Write-Host 'Cole o token NOVO abaixo (a tela fica escura de propósito: nada aparece).'

/* 1) lê o token sem mostrar nada na tela */
$seguro = Read-Host -Prompt 'Token novo'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
try   { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if (-not $token -or ($token -notmatch '^(ghp_|github_pat_)')) {
  Write-Host 'ERRO: isso não parece um token do GitHub (começa com ghp_ ou github_pat_).' -ForegroundColor Red
  Write-Host 'Rode o script de novo.' ; exit 1
}

/* 2) confere permissões na API (o token só vai na memória, nunca é impresso) */
try {
  $r = Invoke-WebRequest -Uri 'https://api.github.com/user' -Headers @{
    Authorization = "Bearer $token"
    'User-Agent'  = 'aid-troca-pat'
  } -UseBasicParsing
  $escopos = $r.Headers['X-OAuth-Scopes']
  $login = ($r.Content | ConvertFrom-Json).login
} catch {
  Write-Host ('ERRO: o GitHub recusou o token (' + $_.Exception.Message + '). Confira se copiou inteiro.') -ForegroundColor Red
  exit 1
}
Write-Host ('GitHub reconheceu o token (conta: ' + $login + ', escopos: ' + $escopos + ')')

$falta = @()
if ($escopos -notmatch '\brepo\b')    { $falta += 'repo' }
if ($escopos -notmatch '\bworkflow\b'){ $falta += 'workflow' }
if ($falta.Count -gt 0) {
  Write-Host ('FALTAM as caixinhas: ' + ($falta -join ', ')) -ForegroundColor Red
  Write-Host 'Gere outro token marcando repo e workflow, e rode o script de novo.'
  exit 1
}
Write-Host 'Permissões completas (repo + workflow).' -ForegroundColor Green

/* 3) guarda no cofre do Windows (o git passa a achar o token sozinho) */
$entrada = "protocol=https`nhost=github.com`nusername=$login`npassword=$token`n"
$entrada | git credential approve 2>$null
$token = $null; $seguro = $null; $entrada = $null   /* limpa da memória */

/* 4) endereço limpo — sem token no meio (é assim que o antigo vazou) */
git -C $raiz remote set-url origin https://github.com/AID-Tec/home.git
Write-Host 'Endereço do repositório limpo: https://github.com/AID-Tec/home.git'

/* 5) teste de verdade: falar com o GitHub usando o token guardado */
$saida = git -C $raiz ls-remote origin HEAD 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host 'OK — git conectou com o token novo (cofre do Windows funcionando).' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Falta SÓ você: apague o token antigo em github.com/settings/tokens (lixeira ao lado dele).'
  Write-Host 'Depois avisa eu — subo o agendamento e valido o primeiro envio.'
} else {
  Write-Host ('Atenção: o teste falhou -> ' + ($saida -join ' | ')) -ForegroundColor Yellow
  Write-Host 'Rode o script de novo.'
}
