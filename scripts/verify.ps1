[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-PropertyExists {
    param(
        [Parameter(Mandatory)]$Item,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path,
        [string]$Context = ''
    )
    $hasProperty = $Item.PSObject.Properties.Name -contains $Name
    $contextLabel = if ([string]::IsNullOrWhiteSpace($Context)) { '' } else { "$Context " }
    Assert-True $hasProperty "Missing required key '$Name' in $contextLabel$Path."
}

function Read-Toml {
    param([Parameter(Mandatory)][string]$Path)
    $lines = Get-Content -LiteralPath $Path
    $result = [ordered]@{
        version = $null
        setup = [ordered]@{}
        actions = @()
    }
    $currentSection = $null
    $currentAction = $null

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
            continue
        }

        switch -Regex ($line) {
            '^\[setup\]$' {
                $currentSection = 'setup'
                $currentAction = $null
                continue
            }
            '^\[\[actions\]\]$' {
                if ($null -ne $currentAction -and $currentAction.Count -gt 0) {
                    $result.actions += [pscustomobject]$currentAction
                }
                $currentSection = 'actions'
                $currentAction = [ordered]@{}
                continue
            }
            '^version\s*=\s*(\d+)$' {
                $result.version = [int]$Matches[1]
                continue
            }
            '^(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(?<value>.*)"$' {
                $key = $Matches.key
                $value = $Matches.value
                if ($currentSection -eq 'actions' -and $null -ne $currentAction) {
                    $currentAction[$key] = $value
                } elseif ($currentSection -eq 'setup') {
                    $result.setup[$key] = $value
                } else {
                    $result[$key] = $value
                }
                continue
            }
            default {
                throw "Unsupported TOML line in $($Path): $line"
            }
        }
    }

    if ($null -ne $currentAction -and $currentAction.Count -gt 0) {
        $result.actions += [pscustomobject]$currentAction
    }

    $result.setup = [pscustomobject]$result.setup
    $result.actions = @($result.actions)

    return [pscustomobject]$result
}

function Read-SimpleTomlMap {
    param([Parameter(Mandatory)][string]$Path)
    $lines = Get-Content -LiteralPath $Path
    $result = [ordered]@{}
    $currentSection = ''

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
            continue
        }

        if ($line -match '^\[(?<name>[^\[\]]+)\]$') {
            $currentSection = $Matches.name.Trim()
            continue
        }

        if ($line -match '^\[\[') {
            throw "Unsupported TOML array-of-tables in $($Path): $line"
        }

        if ($line -notmatch '^(?<key>[A-Za-z0-9_.:-]+)\s*=\s*(?<value>.+)$') {
            throw "Unsupported TOML line in $($Path): $line"
        }

        $key = $Matches.key
        $rawValue = $Matches.value.Trim()

        if ($rawValue -match '^"(.*)"$') {
            $value = $Matches[1]
        } elseif ($rawValue -eq 'true') {
            $value = $true
        } elseif ($rawValue -eq 'false') {
            $value = $false
        } elseif ($rawValue -match '^-?\d+$') {
            $value = [int]$rawValue
        } else {
            throw "Unsupported TOML value in $($Path): $line"
        }

        $fullKey = if ([string]::IsNullOrWhiteSpace($currentSection)) { $key } else { "$currentSection.$key" }
        $result[$fullKey] = $value
    }

    return $result
}

function Test-RequiredText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Patterns
    )
    $text = Get-Content -LiteralPath $Path -Raw
    foreach ($pattern in $Patterns) {
        Assert-True ($text -match $pattern) "Required pattern '$pattern' was not found in $Path."
    }
}

function Test-StateDocument {
    param([Parameter(Mandatory)][string]$Path)
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($key in @(
        'version',
        'current_goal_id',
        'current_task_id',
        'cycle_status',
        'run_mode',
        'last_planner_run_at',
        'last_worker_run_at',
        'last_result',
        'consecutive_worker_failures',
        'needs_human_review',
        'open_blocker_count',
        'report_thread_id',
        'autonomy_branch',
        'sprint_active',
        'paused',
        'pause_reason'
    )) {
        Assert-PropertyExists -Item $state -Name $key -Path $Path
    }
    if ($state.PSObject.Properties.Name -contains 'last_thread_summary_sent_at' -and $null -ne $state.last_thread_summary_sent_at) {
        $threadSummarySentAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$state.last_thread_summary_sent_at, [ref]$threadSummarySentAt)) "Invalid last_thread_summary_sent_at in $Path."
    }
    if ($state.PSObject.Properties.Name -contains 'last_inbox_run_at' -and $null -ne $state.last_inbox_run_at) {
        $inboxRunAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$state.last_inbox_run_at, [ref]$inboxRunAt)) "Invalid last_inbox_run_at in $Path."
    }

    Assert-True (@('idle','planning','working','blocked','review_pending') -contains [string]$state.cycle_status) "Invalid cycle_status in $Path."
    Assert-True ($null -eq $state.run_mode -or @('sprint','cruise') -contains [string]$state.run_mode) "Invalid run_mode in $Path."
    Assert-True (@('noop','planned','passed','failed','blocked') -contains [string]$state.last_result) "Invalid last_result in $Path."
}

function Test-TaskCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'tasks' -Path $Path

    foreach ($task in @($doc.tasks)) {
        foreach ($key in @(
            'id',
            'goal_id',
            'title',
            'status',
            'priority',
            'depends_on',
            'acceptance',
            'file_hints',
            'retry_count',
            'last_error',
            'updated_at',
            'commit_hash',
            'review_status',
            'source',
            'source_task_id'
        )) {
            Assert-PropertyExists -Item $task -Name $key -Path $Path -Context 'a task from'
        }

        Assert-True (@('queued','ready','in_progress','verify_failed','blocked','done') -contains [string]$task.status) "Invalid task status in $Path."
        Assert-True (@('P0','P1','P2','P3') -contains [string]$task.priority) "Invalid task priority in $Path."
        Assert-True (@('not_reviewed','passed','followup_required') -contains [string]$task.review_status) "Invalid review_status in $Path."
        Assert-True (@('proposal','followup') -contains [string]$task.source) "Invalid task source in $Path."
    }
}

function Test-GoalCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'goals' -Path $Path

    foreach ($goal in @($doc.goals)) {
        foreach ($key in @(
            'id',
            'title',
            'objective',
            'success_criteria',
            'constraints',
            'out_of_scope',
            'status',
            'run_mode',
            'created_at',
            'approved_at',
            'completed_at'
        )) {
            Assert-PropertyExists -Item $goal -Name $key -Path $Path -Context 'a goal from'
        }

        Assert-True (@('draft','awaiting_confirmation','approved','active','completed','blocked','cancelled') -contains [string]$goal.status) "Invalid goal status in $Path."
        Assert-True (@('sprint','cruise') -contains [string]$goal.run_mode) "Invalid goal run_mode in $Path."
    }
}

function Test-ProposalCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'proposals' -Path $Path

    foreach ($proposal in @($doc.proposals)) {
        foreach ($key in @(
            'goal_id',
            'status',
            'summary',
            'tasks',
            'created_at',
            'approved_at'
        )) {
            Assert-PropertyExists -Item $proposal -Name $key -Path $Path -Context 'a proposal from'
        }

        Assert-True (@('awaiting_confirmation','approved','superseded','cancelled') -contains [string]$proposal.status) "Invalid proposal status in $Path."

        foreach ($task in @($proposal.tasks)) {
            foreach ($key in @('id','title','priority','depends_on','acceptance','file_hints')) {
                Assert-PropertyExists -Item $task -Name $key -Path $Path -Context 'a proposed task from'
            }
        }
    }
}

function Test-SettingsDocument {
    param([Parameter(Mandatory)][string]$Path)
    $settings = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($key in @(
        'version',
        'install_source',
        'initial_confirmation_required',
        'report_surface',
        'auto_commit',
        'autonomy_branch',
        'auto_continue_within_goal',
        'block_on_major_decision',
        'default_cruise_cadence',
        'default_sprint_heartbeat_minutes'
    )) {
        Assert-PropertyExists -Item $settings -Name $key -Path $Path
    }

    Assert-True ([string]$settings.install_source -eq 'local_package') "Invalid install_source in $Path."
    Assert-True ([string]$settings.report_surface -eq 'thread_and_inbox') "Invalid report_surface in $Path."
    Assert-True (@('disabled','autonomy_branch') -contains [string]$settings.auto_commit) "Invalid auto_commit mode in $Path."
    Assert-True ($settings.auto_continue_within_goal -is [bool]) "auto_continue_within_goal must be a boolean in $Path."
    Assert-True ($settings.block_on_major_decision -is [bool]) "block_on_major_decision must be a boolean in $Path."

    $cadence = $settings.default_cruise_cadence
    foreach ($key in @('planner_hours','worker_hours','reviewer_hours')) {
        Assert-PropertyExists -Item $cadence -Name $key -Path $Path -Context 'default_cruise_cadence from'
    }
}

function Test-ResultsDocument {
    param([Parameter(Mandatory)][string]$Path)
    $results = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $results -Name 'version' -Path $Path
    if ($results.PSObject.Properties.Name -contains 'last_thread_summary_sent_at' -and $null -ne $results.last_thread_summary_sent_at) {
        $threadSummarySentAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$results.last_thread_summary_sent_at, [ref]$threadSummarySentAt)) "Invalid last_thread_summary_sent_at in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'last_inbox_run_at' -and $null -ne $results.last_inbox_run_at) {
        $inboxRunAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$results.last_inbox_run_at, [ref]$inboxRunAt)) "Invalid last_inbox_run_at in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'last_summary_kind') {
        Assert-True ($null -eq $results.last_summary_kind -or @('normal_success','thread_summary','immediate_exception','goal_transition') -contains [string]$results.last_summary_kind) "Invalid last_summary_kind in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'latest_goal_transition' -and $null -ne $results.latest_goal_transition) {
        $transition = $results.latest_goal_transition
        foreach ($key in @('from_goal_id','to_goal_id','happened_at')) {
            Assert-PropertyExists -Item $transition -Name $key -Path $Path -Context 'latest_goal_transition from'
        }
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$transition.from_goal_id)) "Invalid latest_goal_transition.from_goal_id in $Path."
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$transition.to_goal_id)) "Invalid latest_goal_transition.to_goal_id in $Path."
        if ($null -ne $transition.happened_at) {
            $transitionAt = [datetime]::MinValue
            Assert-True ([DateTime]::TryParse([string]$transition.happened_at, [ref]$transitionAt)) "Invalid latest_goal_transition.happened_at in $Path."
        }
    }

    foreach ($entryName in @('planner','worker','review','commit','reporter')) {
        Assert-PropertyExists -Item $results -Name $entryName -Path $Path
        $entry = $results.$entryName
        foreach ($key in @('status','goal_id','summary')) {
            Assert-PropertyExists -Item $entry -Name $key -Path $Path -Context "$entryName entry from"
        }

        Assert-True (@('not_run','noop','planned','passed','failed','blocked','sent','skipped') -contains [string]$entry.status) "Invalid $entryName result status in $Path."
    }
}

function Test-VerificationDocument {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'goal_id' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'policy' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'axes' -Path $Path

    Assert-True (@('strong_template') -contains [string]$doc.policy) "Invalid verification policy in $Path."
    foreach ($axis in @($doc.axes)) {
        foreach ($key in @('id','title','required','status','evidence','source_task_id','last_checked_at','reason')) {
            Assert-PropertyExists -Item $axis -Name $key -Path $Path -Context 'a verification axis from'
        }

        Assert-True (@('pending','passed','failed','blocked','not_applicable') -contains [string]$axis.status) "Invalid verification axis status in $Path."
    }
}

function Test-BlockerCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'blockers' -Path $Path

    foreach ($blocker in @($doc.blockers)) {
        foreach ($key in @(
            'id',
            'task_id',
            'question',
            'severity',
            'status',
            'resolution',
            'opened_at',
            'resolved_at'
        )) {
            Assert-PropertyExists -Item $blocker -Name $key -Path $Path -Context 'a blocker from'
        }

        Assert-True (@('low','medium','high') -contains [string]$blocker.severity) "Invalid blocker severity in $Path."
        Assert-True (@('open','resolved') -contains [string]$blocker.status) "Invalid blocker status in $Path."
    }
}

function Invoke-CliHarness {
    $cliDir = Join-Path $repoRoot 'tools/codex-supervisor'
    $packageJson = Join-Path $cliDir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        return
    }

    $tsc = Join-Path $cliDir 'node_modules/.bin/tsc.cmd'
    $vitestModule = Join-Path $cliDir 'node_modules/vitest/vitest.mjs'
    Assert-True (Test-Path -LiteralPath $tsc) 'Missing local TypeScript CLI. Run scripts/setup.windows.ps1 first.'
    Assert-True (Test-Path -LiteralPath $vitestModule) 'Missing local Vitest module. Run scripts/setup.windows.ps1 first.'

    Push-Location $cliDir
    try {
        & $tsc -p tsconfig.json --noEmit
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript validation failed with exit code $LASTEXITCODE."
        }

        & node $vitestModule run
        if ($LASTEXITCODE -ne 0) {
            throw "Vitest failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

Write-Host 'Verifying repo control surface...'

foreach ($requiredPath in @(
    'AGENTS.md',
    '.agents/skills/$autonomy-plan/SKILL.md',
    '.agents/skills/$autonomy-work/SKILL.md',
    '.agents/skills/$autonomy-intake/SKILL.md',
    '.agents/skills/$autonomy-review/SKILL.md',
    '.agents/skills/$autonomy-report/SKILL.md',
    '.agents/skills/$autonomy-sprint/SKILL.md',
    '.codex/environments/environment.toml',
    '.codex/config.toml',
    'scripts/setup.windows.ps1',
    'scripts/verify.ps1',
    'scripts/smoke.ps1',
    'scripts/review.ps1',
    'autonomy/goal.md',
    'autonomy/journal.md',
    'autonomy/tasks.json',
    'autonomy/goals.json',
    'autonomy/proposals.json',
    'autonomy/state.json',
    'autonomy/settings.json',
    'autonomy/results.json',
    'autonomy/verification.json',
    'autonomy/blockers.json',
    'autonomy/schema/tasks.schema.json',
    'autonomy/schema/goals.schema.json',
    'autonomy/schema/proposals.schema.json',
    'autonomy/schema/state.schema.json',
    'autonomy/schema/settings.schema.json',
    'autonomy/schema/results.schema.json',
    'autonomy/schema/blockers.schema.json',
    'autonomy/schema/verification.schema.json',
    'autonomy/locks'
)) {
    Assert-True (Test-Path -LiteralPath (Join-Path $repoRoot $requiredPath)) "Missing required path: $requiredPath"
}

Test-RequiredText -Path (Join-Path $repoRoot 'AGENTS.md') -Patterns @(
    '一次只处理一个任务',
    'scripts/verify.ps1',
    'scripts/review.ps1',
    'autonomy/\*',
    'cycle\.lock',
    'UTC ISO 8601',
    'repo-relative forward-slash',
    'codex/autonomy',
    'Reporter 只有异常',
    'Sprint runner 的 heartbeat 只是唤醒间隔'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-plan/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-plan',
    'autonomy/goals\.json',
    'awaiting_confirmation',
    'Keep at most 5 tasks in'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-work/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-work',
    'Select exactly one',
    'scripts/review\.ps1',
    'codex/autonomy',
    'review_pending'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-intake/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-intake',
    'Normalize a user goal'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-review/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-review',
    'scripts/review\.ps1'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-report/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-report',
    'Summarize the current autonomy state'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-sprint/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-sprint',
    'short, bounded execution loops'
)

Test-RequiredText -Path (Join-Path $repoRoot 'autonomy/goal.md') -Patterns @(
    '(?m)^# Objective',
    '(?m)^## Success Criteria',
    '(?m)^## Constraints',
    '(?m)^## Out of Scope'
)

Test-RequiredText -Path (Join-Path $repoRoot 'autonomy/journal.md') -Patterns @(
    'Append one entry per run',
    'Entry Template',
    'result: planned \| passed \| failed \| blocked \| noop'
)

$environment = Read-Toml -Path (Join-Path $repoRoot '.codex/environments/environment.toml')
Assert-True ($environment.version -eq 1) 'environment.toml version must be 1.'
Assert-True ($environment.setup.script -match 'scripts/setup.windows.ps1') 'environment.toml setup script must point to scripts/setup.windows.ps1.'

$actions = @($environment.actions)
Assert-True ($actions.Count -ge 3) 'environment.toml must define at least three actions.'
foreach ($requiredAction in @('verify', 'smoke', 'review')) {
    $match = $actions | Where-Object { $_.name -eq $requiredAction } | Select-Object -First 1
    Assert-True ($null -ne $match) "Missing action '$requiredAction' in environment.toml."
    Assert-True ($match.command -match "scripts/$requiredAction\.ps1") "Action '$requiredAction' must point to scripts/$requiredAction.ps1."
    Assert-True ($match.platform -eq 'windows') "Action '$requiredAction' must target windows."
}

$config = Read-SimpleTomlMap -Path (Join-Path $repoRoot '.codex/config.toml')
Assert-True ($config.Contains('approval_policy')) 'config.toml must define a top-level approval_policy.'
Assert-True (@('untrusted', 'on-request', 'never') -contains [string]$config['approval_policy']) 'config.toml approval_policy is invalid.'
Assert-True ($config.Contains('sandbox_mode')) 'config.toml must define a top-level sandbox_mode.'
Assert-True (@('read-only', 'workspace-write', 'danger-full-access') -contains [string]$config['sandbox_mode']) 'config.toml sandbox_mode is invalid.'
Assert-True ($config.Contains('model')) 'config.toml must define a top-level model.'
Assert-True ([string]$config['model'] -eq 'gpt-5.4') 'config.toml model must be gpt-5.4.'
Assert-True ($config.Contains('model_reasoning_effort')) 'config.toml must define a top-level model_reasoning_effort.'
Assert-True ([string]$config['model_reasoning_effort'] -eq 'xhigh') 'config.toml model_reasoning_effort must be xhigh.'
Assert-True ($config.Contains('service_tier')) 'config.toml must define a top-level service_tier.'
Assert-True ([string]$config['service_tier'] -eq 'fast') 'config.toml service_tier must be fast.'
Assert-True ($config.Contains('sandbox_workspace_write.network_access')) 'config.toml must define sandbox_workspace_write.network_access.'
Assert-True ($config['sandbox_workspace_write.network_access'] -is [bool]) 'config.toml sandbox_workspace_write.network_access must be a boolean.'
Assert-True ($config.Contains('windows.sandbox')) 'config.toml must define windows.sandbox.'
Assert-True (@('unelevated', 'elevated') -contains [string]$config['windows.sandbox']) 'config.toml windows.sandbox is invalid.'

Test-StateDocument -Path (Join-Path $repoRoot 'autonomy/state.json')
Test-TaskCollection -Path (Join-Path $repoRoot 'autonomy/tasks.json')
Test-GoalCollection -Path (Join-Path $repoRoot 'autonomy/goals.json')
Test-ProposalCollection -Path (Join-Path $repoRoot 'autonomy/proposals.json')
Test-SettingsDocument -Path (Join-Path $repoRoot 'autonomy/settings.json')
Test-ResultsDocument -Path (Join-Path $repoRoot 'autonomy/results.json')
Test-VerificationDocument -Path (Join-Path $repoRoot 'autonomy/verification.json')
Test-BlockerCollection -Path (Join-Path $repoRoot 'autonomy/blockers.json')

Invoke-CliHarness

Write-Host 'Install verify passed.'
