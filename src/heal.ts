// Pure decision logic for the heal-zombie-cancels action.
//
// Background: `gt submit --stack` fires two `pull_request.synchronize` webhooks per PR
// (git push + Graphite's REST follow-up). With `cancel-in-progress: true`, one of the
// resulting workflow runs gets killed within ~2s. GitHub's PR Checks sidebar renders the
// run with the highest check_suite_id. When the cancelled run has the higher
// check_suite_id, the sidebar shows a yellow-X even though the sibling succeeded. This
// action detects that case and reruns the cancelled run so attempt 2 produces a
// successful render.

import * as core from '@actions/core'
import * as github from '@actions/github'

export type WorkflowRunPayload = {
  id: number
  check_suite_id: number
  name: string
  path: string
  run_attempt: number
  conclusion: string | null
  event: string
  head_sha: string
  created_at: string
  updated_at: string
  pull_requests: Array<{ number: number }>
}

export type SiblingRun = {
  id: number
  check_suite_id?: number
  path: string
  status: string | null
  conclusion: string | null
  run_attempt?: number
  created_at: string
}

export type HealOctokit = {
  listWorkflowRunsForRepo: (args: {
    owner: string
    repo: string
    head_sha: string
    per_page: number
  }) => Promise<{ data: { workflow_runs: SiblingRun[] } }>
  getPullRequest: (args: {
    owner: string
    repo: string
    pull_number: number
  }) => Promise<{ data: { head: { sha: string } } }>
  reRunWorkflow: (args: { owner: string; repo: string; run_id: number }) => Promise<unknown>
}

export type Logger = { info: (msg: string) => void }

export type HealOptions = {
  octokit: HealOctokit
  payload: WorkflowRunPayload
  owner: string
  repo: string
  dryRun?: boolean
  skipStaleShaCheck?: boolean
  log?: Logger
}

export type HealDecision =
  | { decision: 'skip'; reason: string }
  | { decision: 'heal'; reason: string; runId: number; dispatched: boolean }

export const heal = async (opts: HealOptions): Promise<HealDecision> => {
  const { octokit, payload: self, owner, repo, dryRun = false, skipStaleShaCheck = false } = opts
  const log = opts.log ?? { info: () => {} }

  log.info('=== Zombie-cancel heal evaluating ===')
  log.info(`workflow         = ${self.name} (path=${self.path})`)
  log.info(`self.run_id      = ${self.id}`)
  log.info(`self.check_suite = ${self.check_suite_id}`)
  log.info(`self.run_attempt = ${self.run_attempt}`)
  log.info(`self.conclusion  = ${self.conclusion}`)
  log.info(`self.event       = ${self.event}`)
  log.info(`self.head_sha    = ${self.head_sha}`)
  log.info(`self.created_at  = ${self.created_at}`)
  log.info(`self.updated_at  = ${self.updated_at}`)

  const {
    data: { workflow_runs },
  } = await octokit.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: self.head_sha,
    per_page: 100,
  })
  log.info(`Found ${workflow_runs.length} workflow run(s) at head_sha=${self.head_sha}`)

  const siblings = workflow_runs.filter((r) => r.id !== self.id && r.path === self.path)
  log.info(`Siblings with same workflow path (${self.path}): ${siblings.length}`)
  for (const s of siblings) {
    log.info(
      `  sibling run_id=${s.id} check_suite=${s.check_suite_id} status=${s.status} ` +
        `conclusion=${s.conclusion ?? 'null'} attempt=${s.run_attempt} created_at=${s.created_at}`,
    )
  }

  const lowerSuiteSibling = siblings.find(
    (r) => r.check_suite_id != null && r.check_suite_id < self.check_suite_id,
  )
  if (!lowerSuiteSibling) {
    const reason =
      siblings.length === 0
        ? 'no sibling with same workflow path found at this SHA'
        : 'self does not have the highest check_suite_id — the UI is rendering the sibling, not self'
    log.info('Decision: NO HEAL.')
    log.info(`Reasoning: ${reason}.`)
    return { decision: 'skip', reason }
  }

  const pr = self.pull_requests[0]
  if (!pr) {
    const reason = 'workflow_run payload has no associated PR'
    log.info('Decision: NO HEAL.')
    log.info(`Reasoning: ${reason}.`)
    return { decision: 'skip', reason }
  }

  if (!skipStaleShaCheck) {
    const { data: currentPr } = await octokit.getPullRequest({
      owner,
      repo,
      pull_number: pr.number,
    })

    if (currentPr.head.sha !== self.head_sha) {
      const reason =
        `PR #${pr.number} head has advanced to ${currentPr.head.sha}; ` +
        `self.head_sha=${self.head_sha} is stale. Rerunning would enter the ` +
        `PR-scoped concurrency group and cancel the current SHA's in-progress runs`
      log.info('Decision: NO HEAL.')
      log.info(`Reasoning: ${reason}.`)
      return { decision: 'skip', reason }
    }
  }

  const reason =
    `self.check_suite_id=${self.check_suite_id} > sibling.check_suite_id=${lowerSuiteSibling.check_suite_id} ` +
    `(sibling run_id=${lowerSuiteSibling.id}). PR #${pr.number} head is still ${self.head_sha}. ` +
    'Self has the highest check_suite_id so the UI is rendering this cancelled run. Rerunning self.'
  log.info('Decision: HEAL.')
  log.info(`Reasoning: ${reason}`)

  if (dryRun) {
    log.info('dry-run=true; skipping reRunWorkflow dispatch.')
    return { decision: 'heal', reason, runId: self.id, dispatched: false }
  }

  log.info(`Dispatching rerun of run_id=${self.id}`)
  await octokit.reRunWorkflow({ owner, repo, run_id: self.id })
  log.info(
    `Rerun dispatched. Attempt 2 will run against head_sha=${self.head_sha}. ` +
      'On success, the cancelled status will clear. On failure, the failure ' +
      'will surface to reviewers.',
  )

  return { decision: 'heal', reason, runId: self.id, dispatched: true }
}

// Action entrypoint: reads inputs from the GitHub Actions runtime, builds the
// HealOctokit wrapper around @actions/github's REST client, calls heal(), and
// writes the decision back as Action outputs.
export const runHealAction = async (): Promise<void> => {
  try {
    if (github.context.eventName !== 'workflow_run') {
      core.setFailed(
        `This action must be triggered by 'workflow_run', got '${github.context.eventName}'.`,
      )
      return
    }

    const payload = github.context.payload.workflow_run as WorkflowRunPayload | undefined
    if (!payload) {
      core.setFailed('Missing workflow_run payload.')
      return
    }

    const token = core.getInput('token', { required: true })
    const dryRun = core.getBooleanInput('dry-run')
    const skipStaleShaCheck = core.getBooleanInput('skip-stale-sha-check')

    const rest = github.getOctokit(token).rest
    const octokit: HealOctokit = {
      listWorkflowRunsForRepo: (args) => rest.actions.listWorkflowRunsForRepo(args),
      getPullRequest: (args) => rest.pulls.get(args),
      reRunWorkflow: (args) => rest.actions.reRunWorkflow(args),
    }

    const result = await heal({
      octokit,
      payload,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      dryRun,
      skipStaleShaCheck,
      log: { info: (msg) => core.info(msg) },
    })

    core.setOutput('decision', result.decision)
    core.setOutput('reason', result.reason)
    if (result.decision === 'heal') {
      core.setOutput('rerun_run_id', String(result.runId))
      core.setOutput('dispatched', String(result.dispatched))
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err))
  }
}
