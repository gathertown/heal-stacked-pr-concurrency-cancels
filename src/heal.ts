// Pure decision logic for the heal-zombie-cancels action.
//
// Background: `gt submit --stack` fires two `pull_request.synchronize` webhooks per PR
// (git push + Graphite's REST follow-up). With `cancel-in-progress: true`, one of the
// resulting workflow runs gets killed within ~2s. When the higher-id run is the one
// cancelled, the GitHub PR Checks sidebar renders a yellow-X even though the sibling
// succeeded. This action detects that case and reruns the cancelled higher-id run so
// attempt 2 produces a successful render.

export type WorkflowRunPayload = {
  id: number;
  name: string;
  path: string;
  run_attempt: number;
  conclusion: string | null;
  event: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  pull_requests: Array<{ number: number }>;
};

export type SiblingRun = {
  id: number;
  path: string;
  status: string | null;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
};

export type HealOctokit = {
  listWorkflowRunsForRepo: (args: {
    owner: string;
    repo: string;
    head_sha: string;
    per_page: number;
  }) => Promise<{ data: { workflow_runs: SiblingRun[] } }>;
  getPullRequest: (args: {
    owner: string;
    repo: string;
    pull_number: number;
  }) => Promise<{ data: { head: { sha: string } } }>;
  reRunWorkflow: (args: { owner: string; repo: string; run_id: number }) => Promise<unknown>;
};

export type Logger = { info: (msg: string) => void };

export type HealOptions = {
  octokit: HealOctokit;
  payload: WorkflowRunPayload;
  owner: string;
  repo: string;
  dryRun?: boolean;
  skipStaleShaCheck?: boolean;
  log?: Logger;
};

export type HealDecision =
  | { decision: 'skip'; reason: string }
  | { decision: 'heal'; reason: string; runId: number; dispatched: boolean };

export async function heal(opts: HealOptions): Promise<HealDecision> {
  const { octokit, payload: self, owner, repo, dryRun = false, skipStaleShaCheck = false } = opts;
  const log = opts.log ?? { info: () => {} };

  log.info('=== Zombie-cancel heal evaluating ===');
  log.info(`workflow         = ${self.name} (path=${self.path})`);
  log.info(`self.run_id      = ${self.id}`);
  log.info(`self.run_attempt = ${self.run_attempt}`);
  log.info(`self.conclusion  = ${self.conclusion}`);
  log.info(`self.event       = ${self.event}`);
  log.info(`self.head_sha    = ${self.head_sha}`);
  log.info(`self.created_at  = ${self.created_at}`);
  log.info(`self.updated_at  = ${self.updated_at}`);

  const {
    data: { workflow_runs },
  } = await octokit.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: self.head_sha,
    per_page: 100,
  });
  log.info(`Found ${workflow_runs.length} workflow run(s) at head_sha=${self.head_sha}`);

  const siblings = workflow_runs.filter((r) => r.id !== self.id && r.path === self.path);
  log.info(`Siblings with same workflow path (${self.path}): ${siblings.length}`);
  for (const s of siblings) {
    log.info(
      `  sibling run_id=${s.id} status=${s.status} conclusion=${s.conclusion ?? 'null'} ` +
        `attempt=${s.run_attempt} created_at=${s.created_at}`,
    );
  }

  const lowerIdSibling = siblings.find((r) => r.id < self.id);
  if (!lowerIdSibling) {
    const reason = 'no sibling with lower run_id found';
    log.info('Decision: NO HEAL.');
    log.info(`Reasoning: ${reason}.`);
    return { decision: 'skip', reason };
  }

  const pr = self.pull_requests[0];
  if (!pr) {
    const reason = 'workflow_run payload has no associated PR';
    log.info('Decision: NO HEAL.');
    log.info(`Reasoning: ${reason}.`);
    return { decision: 'skip', reason };
  }

  if (!skipStaleShaCheck) {
    const { data: currentPr } = await octokit.getPullRequest({
      owner,
      repo,
      pull_number: pr.number,
    });

    if (currentPr.head.sha !== self.head_sha) {
      const reason =
        `PR #${pr.number} head has advanced to ${currentPr.head.sha}; ` +
        `self.head_sha=${self.head_sha} is stale. Rerunning would enter the ` +
        `PR-scoped concurrency group and cancel the current SHA's in-progress runs`;
      log.info('Decision: NO HEAL.');
      log.info(`Reasoning: ${reason}.`);
      return { decision: 'skip', reason };
    }
  }

  const reason =
    `self.id=${self.id} > sibling.id=${lowerIdSibling.id}, and PR #${pr.number} ` +
    `head is still ${self.head_sha}. Self is the newer run and was cancelled, so ` +
    'the PR Checks UI is rendering this workflow as cancelled. Rerunning self.';
  log.info('Decision: HEAL.');
  log.info(`Reasoning: ${reason}`);

  if (dryRun) {
    log.info('dry-run=true; skipping reRunWorkflow dispatch.');
    return { decision: 'heal', reason, runId: self.id, dispatched: false };
  }

  log.info(`Dispatching rerun of run_id=${self.id}`);
  await octokit.reRunWorkflow({ owner, repo, run_id: self.id });
  log.info(
    `Rerun dispatched. Attempt 2 will run against head_sha=${self.head_sha}. ` +
      'On success, the cancelled status will clear. On failure, the failure ' +
      'will surface to reviewers.',
  );

  return { decision: 'heal', reason, runId: self.id, dispatched: true };
}
