import { heal, type HealOctokit, type SiblingRun, type WorkflowRunPayload } from './heal';

function makePayload(overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload {
  return {
    id: 200,
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
  };
}

function makeSibling(overrides: Partial<SiblingRun> = {}): SiblingRun {
  return {
    id: 100,
    path: '.github/workflows/lint.yml',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-04-28T00:00:00Z',
    ...overrides,
  };
}

function makeOctokit(overrides: Partial<HealOctokit> = {}): jest.Mocked<HealOctokit> {
  return {
    listWorkflowRunsForRepo: jest.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
    getPullRequest: jest
      .fn()
      .mockResolvedValue({ data: { head: { sha: 'sha-current' } } }),
    reRunWorkflow: jest.fn().mockResolvedValue({}),
    ...overrides,
  } as jest.Mocked<HealOctokit>;
}

const baseArgs = { owner: 'gather-town', repo: 'gather-town-v2' };

describe('heal', () => {
  it('skips when no sibling exists', async () => {
    const payload = makePayload();
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [{ ...payload, status: 'completed' }] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result.decision).toEqual('skip');
    expect(result.reason).toMatch(/no sibling/);
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled();
  });

  it('skips when only sibling has higher run_id (we are the older arrival)', async () => {
    const payload = makePayload({ id: 100 });
    const sibling = makeSibling({ id: 200 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result.decision).toEqual('skip');
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled();
  });

  it('skips when payload has no PR', async () => {
    const payload = makePayload({ pull_requests: [] });
    const sibling = makeSibling({ id: 100 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result.decision).toEqual('skip');
    expect(result.reason).toMatch(/no associated PR/);
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled();
  });

  it('skips when PR head has advanced past self.head_sha', async () => {
    const payload = makePayload();
    const sibling = makeSibling({ id: 100 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
      getPullRequest: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-newer' } } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result.decision).toEqual('skip');
    expect(result.reason).toMatch(/has advanced/);
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled();
  });

  it('heals when self is newer arrival and PR head still matches', async () => {
    const payload = makePayload();
    const sibling = makeSibling({ id: 100 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result).toEqual(
      expect.objectContaining({ decision: 'heal', runId: 200, dispatched: true }),
    );
    expect(octokit.reRunWorkflow).toHaveBeenCalledWith({
      ...baseArgs,
      run_id: 200,
    });
  });

  it('does not dispatch when dryRun=true', async () => {
    const payload = makePayload();
    const sibling = makeSibling({ id: 100 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload, dryRun: true });

    expect(result).toEqual(
      expect.objectContaining({ decision: 'heal', dispatched: false }),
    );
    expect(octokit.reRunWorkflow).not.toHaveBeenCalled();
  });

  it('skips the stale-SHA pre-flight when skipStaleShaCheck=true', async () => {
    const payload = makePayload();
    const sibling = makeSibling({ id: 100 });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, sibling] } }),
      getPullRequest: jest.fn(),
    });

    const result = await heal({ ...baseArgs, octokit, payload, skipStaleShaCheck: true });

    expect(result.decision).toEqual('heal');
    expect(octokit.getPullRequest).not.toHaveBeenCalled();
  });

  it('ignores siblings on a different workflow path', async () => {
    const payload = makePayload({ id: 200 });
    const otherWorkflow = makeSibling({ id: 100, path: '.github/workflows/other.yml' });
    const octokit = makeOctokit({
      listWorkflowRunsForRepo: jest
        .fn()
        .mockResolvedValue({ data: { workflow_runs: [payload as unknown as SiblingRun, otherWorkflow] } }),
    });

    const result = await heal({ ...baseArgs, octokit, payload });

    expect(result.decision).toEqual('skip');
  });
});
