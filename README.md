<p align="center">
  <img src="heal-ci-icon.png" alt="Heal CI" width="200">
</p>

# Heal Stacked-PR Concurrency Cancels

Reruns workflow runs cancelled by `cancel-in-progress` when stacked-PR tools (notably [Graphite's `gt submit --stack`](https://graphite.com/)) can deliver two webhooks per submit, so the PR Checks sidebar reflects the surviving sibling's status.

## The problem

Some stacked-PR tools — notably Graphite's `gt submit --stack` — can cause GitHub to deliver two `pull_request.synchronize` webhooks per PR. Per [Graphite's own troubleshooting docs](https://graphite.com/docs/troubleshooting): _"Because `gt submit` both performs a `git push` and a GitHub API call, occasionally GitHub will pick up both as a synchronize event on the PR."_ With `cancel-in-progress: true` on a PR-scoped concurrency group, the two resulting workflow runs race and one gets killed within ~2 seconds.

GitHub's PR Checks sidebar renders the workflow run with the **highest `check_suite_id`**. When the cancelled run has the higher `check_suite_id` — which doesn't necessarily correspond to the higher `run_id` — reviewers see a yellow-X even though the sibling succeeded and branch protection is satisfied. Branch protection passes; humans see red.

## What this does

Runs on `workflow_run: completed` for any workflow you nominate. When it sees a cancelled first-attempt run that has a sibling at the same `head_sha` with a _lower_ `check_suite_id`, it concludes "this is the one the sidebar is showing" and reruns it. Attempt 2 produces a fresh, successful render.

Includes a pre-flight that bails if the PR head has advanced past the cancelled run's SHA — rerunning a stale SHA enters the same PR-scoped concurrency group as the current SHA's in-progress runs and would cancel them.

## Setup

Healing only matters if you've already configured `cancel-in-progress` concurrency on your workflows — that's what produces the cancelled runs in the first place. Two steps:

### 1. Concurrency on your existing workflows

Add this to each workflow you want to heal. This is [Graphite's recommended snippet](https://graphite.com/docs/troubleshooting):

```yaml
concurrency:
  group: ${{ github.repository }}-${{ github.workflow }}-${{ github.ref }}-${{ github.ref == 'refs/heads/main' && github.sha || ''}}
  cancel-in-progress: true
```

The trailing `github.sha` on `main` keeps every push to main as its own group so back-to-back main builds don't cancel each other; on PRs the suffix collapses to empty so all events for a given PR ref share one group and supersede correctly.

### 2. The healing workflow

Then add a `workflow_run` listener that calls this action when one of your workflows finishes:

```yaml
# .github/workflows/heal-stacked-pr-concurrency-cancels.yml
name: Heal Stacked-PR Concurrency Cancels
on:
  workflow_run:
    workflows: [Lint, Test, Build] # the workflows you want healed
    types: [completed]

jobs:
  heal: # whatever name you want
    if: >-
      github.event.workflow_run.conclusion == 'cancelled'
      && github.event.workflow_run.run_attempt == 1
      && github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    permissions: # these permissions are required for the action to work
      actions: write
      pull-requests: read
    steps:
      - id: heal
        uses: gathertown/heal-stacked-pr-concurrency-cancels@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          dry-run: false
          skip-stale-sha-check: false
      - name: Log decision # optional, for demo / debugging
        run: |
          echo "decision=${{ steps.heal.outputs.decision }}"
          echo "reason=${{ steps.heal.outputs.reason }}"
          echo "rerun_run_id=${{ steps.heal.outputs.rerun_run_id }}"
          echo "dispatched=${{ steps.heal.outputs.dispatched }}"
```

With those inputs, the action evaluates the cancelled run and emits one of:

```text
# When self has the highest check_suite_id and a sibling exists at the same head SHA
decision=heal
reason=self.check_suite_id=70053435199 > sibling.check_suite_id=70053435118 ...
rerun_run_id=26204503356
dispatched=true

# When the PR head has advanced past the cancelled run's SHA
decision=skip
reason=PR head advanced past cancelled run's head_sha; rerun would cancel current runs
rerun_run_id=
dispatched=

# When self does not have the highest check_suite_id
decision=skip
reason=self does not have the highest check_suite_id — the UI is rendering the sibling, not self
rerun_run_id=
dispatched=

# When no sibling matches the heal pattern
decision=skip
reason=no sibling with same workflow path found at this SHA
rerun_run_id=
dispatched=
```

The `if:` filter is important — it keeps the action from firing on already-rerun attempts (preventing self-loops) and on non-PR events.

## Inputs

| Input                  | Default               | Description                                                                                                                           |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                | `${{ github.token }}` | Token with `actions: write` and `pull-requests: read`.                                                                                |
| `dry-run`              | `false`               | Log the decision without dispatching the rerun.                                                                                       |
| `skip-stale-sha-check` | `false`               | Skip the pre-flight that bails when the PR head moved past `self.head_sha`. Only flip this if your concurrency keys aren't PR-scoped. |

## Outputs

| Output         | Description                                                                             |
| -------------- | --------------------------------------------------------------------------------------- |
| `decision`     | `heal` or `skip`.                                                                       |
| `reason`       | Human-readable reason for the decision.                                                 |
| `rerun_run_id` | The run ID that was (or would have been) rerun. Only set when `decision=heal`.          |
| `dispatched`   | `true` if a rerun was dispatched, `false` under dry-run. Only set when `decision=heal`. |

## Required permissions

The calling job must declare:

```yaml
permissions:
  actions: write # to dispatch the rerun
  pull-requests: read # to check whether the PR head has moved
```

## License

MIT
