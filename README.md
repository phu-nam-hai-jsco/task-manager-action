# task-manager-action

Repo chứa **reusable workflows** (`on: workflow_call`) cho hệ sinh thái task-manager trên org
`phu-nam-hai-jsco`. Repo chính `phu-nam-hai-jsco/task-manager` (mono-repo với submodules
`api/`, `server/`, `frontend/`, `desktop/`, `database/`, `docker/` tại root) gọi các workflow
này qua `uses:`:

```yaml
jobs:
  test:
    uses: phu-nam-hai-jsco/task-manager-action/.github/workflows/test-web.yml@main
    with:
      ref: ${{ github.ref }}
    secrets: inherit
```

Khi được gọi, workflow chạy với **context của caller repo** (`github.repository`,
`context.repo` = caller) — checkout, commit status, báo cáo test đều nhắm vào caller repo.
## Repo nguồn — .github/workflows/claude.yml
```

name: Call Central Claude

run-name: Claude request · ${{ github.repository }}

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  dispatch:
    name: Dispatch Claude request
    if: >-
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(github.event.comment.body, '@claude') &&
        contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
      ) ||
      (
        github.event_name == 'pull_request_review_comment' &&
        contains(github.event.comment.body, '@claude') &&
        contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
      ) ||
      (
        github.event_name == 'pull_request_review' &&
        contains(github.event.review.body, '@claude') &&
        contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.review.author_association)
      )

    runs-on: ubuntu-latest

    steps:
      - name: Dispatch to central runner
        uses: actions/github-script@v9
        env:
          SOURCE_REPO: ${{ github.repository }}
          SOURCE_EVENT: ${{ github.event_name }}
          SOURCE_ACTION: ${{ github.event.action }}
          PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number || '' }}
          COMMENT_ID: ${{ github.event.comment.id || '' }}
          REVIEW_ID: ${{ github.event.review.id || '' }}
          REQUESTED_BY: ${{ github.event.comment.user.login || github.event.review.user.login || github.actor }}
        with:
          github-token: ${{ github.token }}
          script: |
            const sourceRepo = process.env.SOURCE_REPO || '';
            const [owner, name, ...extra] = sourceRepo.split('/');
            const allowedOwners = ['TanNhatCMS', 'phu-nam-hai-jsco'];

            if (!allowedOwners.includes(owner) || !name || extra.length) {
              throw new Error(`Source repository is not allowed: ${sourceRepo}`);
            }

            const prNumber = Number(process.env.PR_NUMBER);
            if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
              throw new Error('Invalid pull request number.');
            }

            const sourceEvent = process.env.SOURCE_EVENT;
            const sourceAction = process.env.SOURCE_ACTION;
            const commentId = process.env.COMMENT_ID || '';
            const reviewId = process.env.REVIEW_ID || '';

            const validEvent =
              (sourceEvent === 'issue_comment' &&
                sourceAction === 'created' && commentId) ||
              (sourceEvent === 'pull_request_review_comment' &&
                sourceAction === 'created' && commentId) ||
              (sourceEvent === 'pull_request_review' &&
                sourceAction === 'submitted' && reviewId);

            if (!validEvent) {
              throw new Error('Unsupported or incomplete source event.');
            }

            await github.rest.repos.createDispatchEvent({
              owner: 'phu-nam-hai-jsco',
              repo: 'claude-runner',
              event_type: 'claude-request',
              client_payload: {
                source_repo: sourceRepo,
                source_event: sourceEvent,
                source_action: sourceAction,
                pr_number: prNumber,
                comment_id: commentId || null,
                review_id: reviewId || null,
                requested_by: process.env.REQUESTED_BY || ''
              }
            });

            core.info(`Dispatch sent for ${sourceRepo} PR #${prNumber}.`);


```



## 🔧 Reusable workflows

| Workflow                      | Purpose                                                            | Inputs (chính)                                  |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `test-web.yml`                | Inline styles check + Vitest coverage (`frontend/`) → báo cáo PR    | `ref`, `pr_number`, `comment_id`, `caller_run_url`, `coverage_gist_id` |
| `test-dotnet.yml`             | .NET build & test + coverage (`server/`) → báo cáo PR               | như trên                                        |
| `test-desktop.yml`            | Tauri UI build + cargo llvm-cov (`desktop/`) → báo cáo PR           | như trên                                        |
| `test-database.yml`           | Prisma migrate + seed trên MariaDB (`database/`) → báo cáo PR       | `ref`, `pr_number`, `comment_id`, `caller_run_url` |
| `publish-docker-api.yml`      | Build & push image `qlcv-api` từ `docker/dotnet/Dockerfile`         | `ref`, `version`, `branch`                      |
| `publish-docker-web.yml`      | Build & push image `qlcv-web` (nginx + static export) từ `docker/nextjs/Dockerfile` | `ref`, `version`, `branch`, `env_json` |
| `publish-docker-migrator.yml` | Build & push image `qlcv-db-migrator` từ `docker/db-migrator/Dockerfile` | `ref`, `version`, `branch`                 |

Inputs chung: `ref` (commit/nhánh cần checkout — rỗng → `github.sha`), `pr_number`,
`comment_id`, `trigger`. Publish workflows thêm `version` (tag) và `branch` (lane prefix
`<branch>-` cho tag, trừ `main`).

## 🗑️ Legacy workflows đã xóa

- `publish-docker-nginx.yml` — nginx proxy đã merge vào web image (`docker/nextjs/Dockerfile`).
- `publish-docker-api-base.yml`, `publish-docker-api-runtime.yml` — base/runtime images
  không còn cần thiết (`docker/dotnet/Dockerfile` build trực tiếp từ `mcr.microsoft.com/dotnet`).

## 🔐 Secrets (tất cả optional — truyền qua `secrets: inherit` từ caller)

| Secret                    | Dùng cho                                                            |
| ------------------------- | ------------------------------------------------------------------- |
| `SUBMODULE_TOKEN`         | Checkout private submodules + caller repo (PAT scope `repo`)         |
| `MAIN_REPO_PR_TOKEN`      | Commit status + gửi báo cáo `test-report` về caller repo (fallback `MAIN_REPO_CHECKOUT_TOKEN`) |
| `GIST_TOKEN`              | Cập nhật badge coverage (gist) — chỉ test workflows                  |
| `GHCR_TOKEN`              | Push image GHCR — fallback `MAIN_REPO_CHECKOUT_TOKEN`, rồi `GITHUB_TOKEN` (caller cần `packages: write`) |
| `MEDIATR_LICENSE_KEY`     | Bake license vào API image (`MEDIATR__LICENSEKEY`)                   |
| `AG_GRID_LICENSE` / `SENTRY_OBS_API_TOKEN` | Bake vào web image (ưu tiên hơn giá trị trong `env_json`) |

## 🧪 Luồng báo cáo test

1. Caller gọi workflow với `pr_number` (+ `comment_id` nếu chạy từ lệnh `$test-*`).
2. Ngay khi bắt đầu (chỉ với lệnh từ comment): gửi dispatch event `test-report` (`stage: started`)
   về caller repo → `test-report.yml` phía caller thả 🚀 vào comment lệnh.
3. Kết thúc (kể cả fail): set commit status trên caller repo + gửi dispatch event
   `test-report` (`stage: completed`, kèm `body` markdown) → caller đăng comment
   (quote-reply comment lệnh + 👍/👎, hoặc sticky comment với GitHub Token `github-actions[bot]`).

Job summary có link tới PR và comment lệnh. Workflow reusable **không** comment trực tiếp
bằng PAT (comment sẽ mang tên user → ci-dispatcher coi là người).

## 🐳 Docker images

Ảnh publish về **namespace của caller repo** (`ghcr.io/${{ github.repository_owner }}/qlcv-*`)
— `GITHUB_TOKEN` với `permissions: packages: write` đủ quyền push; PAT (`GHCR_TOKEN`) chỉ
cần khi muốn push sang namespace khác. Build context là root của caller repo
(submodules `server/`, `frontend/`, `database/`, `docker/` được checkout recursive).
