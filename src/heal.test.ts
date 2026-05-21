import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  heal,
  runHealAction,
  type HealOctokit,
  type SiblingRun,
  type WorkflowRunPayload,
} from './heal'

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
}))

jest.mock('@actions/github', () => ({
  context: { eventName: '', repo: { owner: '', repo: '' }, payload: {} },
  getOctokit: jest.fn(),
}))

const mockedCore = jest.mocked(core)
const mockedGithub = jest.mocked(github)

const makePayload = (overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => {
  return {
    id: 200,
    check_suite_id: 9000,
    name: 'Lint',
    path: '.github/workflows/lint.yml',
    run_attempt: 1,
    conclusion: 'cancelled',
    event: 'pull_request',
    head_sha: 'sha-current',
    created_at: '2026-04-28T00:00:00Z',
    updated_at: '2026-04-28T00:00:02Z',
    pull_requests: [{ number: 42 }],
    ...overrides,
  }
}

const makeSibling = (overrides: Partial<SiblingRun> = {}): SiblingRun => {
  return {
    id: 100,
    check_suite_id: 8000,
    path: '.github/workflows/lint.yml',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-04-28T00:00:00Z',
    ...overrides,
  }
}

function makeOctokit(overrides: Partial<HealOctokit> = {}): jest.Mocked<HealOctokit> {
  return {
    listWorkflowRunsForRepo: jest.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
    getPullRequest: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-current' } } }),
    reRunWorkflow: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as jest.Mocked<HealOctokit>
}

const baseArgs = { owner: 'my-org', repo: 'my-repo' }

describe('heal', () => {
  it('skips when no sibling exists', async () => {
    const payload = makePayload()
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [{ ...payload, status: 'completed' }] } }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('skip')
    expect(result.reason).toMatch(/no sibling with same workflow path/)
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled()
  })

  it('skips when self has the lower check_suite_id (UI is rendering the sibling)', async () => {
    const payload = makePayload({ check_suite_id: 8000 })
    const sibling = makeSibling({ check_suite_id: 9000 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('skip')
    expect(result.reason).toMatch(/UI is rendering the sibling/)
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled()
  })

  it('heals when self has higher check_suite_id but lower run_id (GCO-1620 race)', async () => {
    const payload = makePayload({ id: 100, check_suite_id: 9000 })
    const sibling = makeSibling({ id: 200, check_suite_id: 8000, status: 'queued', conclusion: null })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('heal')
    expect(octokit.reRunWorkflow).toHaveBeenCalledWith({ ...baseArgs, run_id: 100 })
  })

  it('heals when sibling is in_progress and self has higher check_suite_id', async () => {
    const payload = makePayload({ id: 100, check_suite_id: 9000 })
    const sibling = makeSibling({ id: 200, check_suite_id: 8000, status: 'in_progress', conclusion: null })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('heal')
    expect(octokit.reRunWorkflow).toHaveBeenCalledWith({ ...baseArgs, run_id: 100 })
  })

  it('skips when payload has no PR', async () => {
    const payload = makePayload({ pull_requests: [] })
    const sibling = makeSibling({ id: 100 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('skip')
    expect(result.reason).toMatch(/no associated PR/)
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled()
  })

  it('skips when PR head has advanced past self.head_sha', async () => {
    const payload = makePayload()
    const sibling = makeSibling({ id: 100 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
      getPullRequest: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-newer' } } }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('skip')
    expect(result.reason).toMatch(/has advanced/)
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled()
  })

  it('heals when self has higher check_suite_id and PR head still matches', async () => {
    const payload = makePayload()
    const sibling = makeSibling({ id: 100 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result).toEqual(
      expect.objectContaining({ decision: 'heal', runId: 200, dispatched: true }),
    )
    expect(octokit.reRunWorkflow).toHaveBeenCalledWith({
      ...baseArgs,
      run_id: 200,
    })
  })

  it('does not dispatch when dryRun=true', async () => {
    const payload = makePayload()
    const sibling = makeSibling({ id: 100 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload, dryRun: true })

    expect(result).toEqual(expect.objectContaining({ decision: 'heal', dispatched: false }))
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled()
  })

  it('skips the stale-SHA pre-flight when skipStaleShaCheck=true', async () => {
    const payload = makePayload()
    const sibling = makeSibling({ id: 100 })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [sibling] },
      }),
      getPullRequest: jest.fn(),
    })

    const result = await heal({ ...baseArgs, octokit, payload, skipStaleShaCheck: true })

    expect(result.decision).toEqual('heal')
    expect(octokit.getPullRequest).not.toHaveBeenCalled()
  })

  it('ignores siblings on a different workflow path', async () => {
    const payload = makePayload({ id: 200 })
    const otherWorkflow = makeSibling({ id: 100, path: '.github/workflows/other.yml' })
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
        data: { workflow_runs: [otherWorkflow] },
      }),
    })

    const result = await heal({ ...baseArgs, octokit, payload })

    expect(result.decision).toEqual('skip')
  })
})

describe('runHealAction', () => {
  it('heals a stacked-PR concurrency cancellation end-to-end', async () => {
    Object.assign(mockedGithub.context, {
      eventName: 'workflow_run',
      repo: { owner: 'my-org', repo: 'my-repo' },
      payload: { workflow_run: makePayload() },
    })

    const reRunWorkflow = jest.fn().mockResolvedValue({})
    mockedGithub.getOctokit.mockReturnValue({
      rest: {
        actions: {
          listWorkflowRunsForRepo: jest.fn().mockResolvedValue({
            data: { workflow_runs: [makeSibling({ id: 100 })] },
          }),
          reRunWorkflow,
        },
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-current' } } }),
        },
      },
    } as unknown as ReturnType<typeof github.getOctokit>)

    mockedCore.getInput.mockReturnValue('test-token')
    mockedCore.getBooleanInput.mockReturnValue(false)

    await runHealAction()

    expect(mockedCore.setOutput).toHaveBeenCalledWith('decision', 'heal')
    expect(mockedCore.setOutput).toHaveBeenCalledWith('rerun_run_id', '200')
    expect(mockedCore.setOutput).toHaveBeenCalledWith('dispatched', 'true')
    expect(reRunWorkflow).toHaveBeenCalledWith({
      owner: 'my-org',
      repo: 'my-repo',
      run_id: 200,
    })
    expect(mockedCore.setFailed).not.toHaveBeenCalled()
  })
})
