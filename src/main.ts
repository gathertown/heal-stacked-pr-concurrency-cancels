import * as core from '@actions/core'
import * as github from '@actions/github'
import { heal, type HealOctokit, type WorkflowRunPayload } from './heal'

async function run(): Promise<void> {
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

void run()
