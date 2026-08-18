SOURCE_RUN_ID='${{ github.event.workflow_run.id }}'
SOURCE_RUN_ATTEMPT='${{ github.event.workflow_run.run_attempt }}'
SOURCE_WORKFLOW_PATH='.github/workflows/dependabot-auto-merge-signal.yml'
SOURCE_REPOSITORY=pgorbachev/ikpk
SOURCE_ACTION=opened
SOURCE_CONCLUSION=success
SOURCE_ACTOR='dependabot[bot]'
SOURCE_PR_NUMBER=135
SOURCE_HEAD_SHA=1111111111111111111111111111111111111111
ARTIFACT_COUNT='artifacts | length == 1 source run_attempt'
ARTIFACT_DIGEST='digest sha256 sha256sum'
ARCHIVE_MEMBERS='zipinfo -1 signal.zip'
SIGNAL_SCHEMA='dependabot-auto-merge-signal/v1'
jq -e '.path == $path and .repository.full_name == $repository and .event == "pull_request_target" and .action == "opened" and .conclusion == "success" and .actor.login == "dependabot[bot]" and (.pull_requests | length == 1) and .head_sha == $head' source-run.json
