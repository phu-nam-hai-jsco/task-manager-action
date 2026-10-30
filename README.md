# task-manager-action

Repo trung tâm chạy CI/CD cho hệ sinh thái task-manager trên org `phu-nam-hai-jsco`. Có ba nhóm việc:

| Nhóm | Workflow | Cách kích hoạt |
| ---- | -------- | -------------- |
| **Test** | `test-web`, `test-dotnet`, `test-desktop`, `test-database` | Repo con gửi `repository_dispatch` sang đây (hoặc chạy tay) — test **chạy và lưu log ngay tại repo này** |
| **Phụ trợ test** | `test-report`, `update-coverage-badge`, `cleanup-runs` | Nhận báo cáo, cập nhật badge coverage, dọn lịch sử Actions |
| **Publish / Claude** | `publish-docker-*`, `claude` | Reusable workflow (`workflow_call`) / `repository_dispatch` |

Với các reusable workflow (`publish-docker-*`, `test-report`), workflow chạy với **context của caller repo**
(`github.repository`, `context.repo` = caller) — checkout, commit status, báo cáo đều nhắm vào caller repo.

## Repo nguồn — .github/workflows/claude.yml
```yaml

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
              repo: 'task-manager-action',
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

## 🧪 Mô hình chạy test

```
repo con (ci-dispatcher.yml)            task-manager-action
  push / PR / comment `$test`  ──repository_dispatch──▶  test-<loại>.yml  (chạy + lưu log tại đây)
                                                              │
  test-report.yml  ◀────────── repository_dispatch `test-report` ◀──┘  (đăng comment, reaction 🚀 👍/👎)
                                                              │
                                                              └─ artifact `coverage-badge` ─▶ update-coverage-badge.yml ─▶ Gist
```

Các repo **không tự chạy test** nữa mà chỉ gửi event sang đây. Mỗi test workflow checkout **thẳng repo của nó**
(ở thư mục gốc, không submodule):

| Event (`repository_dispatch`) | Workflow           | Repo được checkout                                              | Nội dung                                                         |
| ----------------------------- | ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `test-web`                    | `test-web.yml`     | `task-manager-frontend`                                         | Kiểm tra inline styles + Vitest coverage                          |
| `test-dotnet`                 | `test-dotnet.yml`  | `quan-ly-cong-viec-server`                                      | .NET restore/build/test + coverage                                |
| `test-desktop`                | `test-desktop.yml` | `task-manager-desktop` + `task-manager-frontend`                | Build UI tĩnh (Tauri), `cargo llvm-cov`, build test target Windows |
| `test-database`               | `test-database.yml`| `task-manager-database`                                         | Prisma migrate + seed trên MariaDB, kiểm tra schema/dữ liệu        |

Quy tắc chọn commit: chỉ khi `source_repository` **chính là** repo được checkout thì dùng `ref` đã resolve
(SHA của PR/commit); ngược lại (ví dụ nguồn là repo chính `task-manager`) test `main` của repo đó.
Commit status và báo cáo luôn gửi về `source_repository` + `ref` đã nhận.

### Đầu vào

Mỗi test workflow nhận được từ ba nguồn, cùng một bộ đầu vào:

| Nguồn | Cách truyền |
| ----- | ----------- |
| `repository_dispatch` | `client_payload`: `source_repository`, `ref`, `branch`, `pr_number`, `comment_id`, `caller_run_url`, `trigger` |
| `workflow_dispatch` (chạy tay) | `source_repository` (mặc định `phu-nam-hai-jsco/task-manager`), `ref` (bỏ trống = head của `branch`), `branch` (mặc định `main`), `pr_number`, `comment_id` |
| `workflow_call` (giữ để tương thích ngược) | `ref`, `pr_number`, `comment_id`, `trigger`, `caller_run_url`, `source_repository` |

Job `resolve` ở đầu mỗi workflow: kiểm tra `source_repository` thuộc `TanNhatCMS` hoặc `phu-nam-hai-jsco`,
đổi `ref` (tên branch/tag hoặc rỗng) thành **SHA**, và tính `is_main` (SHA có trùng head của `main` ở repo nguồn
không). Mỗi workflow có `concurrency` riêng theo `test-<loại>-<repo nguồn>-<ref>` (không huỷ run đang chạy);
tên run dạng `Test Web · task-manager-frontend · PR #12 · $test comment` (workflow · repo · PR/branch · trigger).

### Phía repo gọi

Mỗi repo gọi (ví dụ `task-manager-frontend`, `task-manager-desktop`) có hai workflow:

- **`ci-dispatcher.yml`** — bắt `push`/`pull_request` (nhánh `main`, `dev`), chạy tay, hoặc comment **`$test`** trên PR
  (chỉ nhận đúng lệnh `$test`, người có quyền `OWNER`/`MEMBER`/`COLLABORATOR`), rồi gửi event của chính repo đó
  (frontend → `test-web`, desktop → `test-desktop`) sang đây, không chờ kết quả. Token gửi là **GitHub App**
  (repo gọi cần variable `APP_CLIENT_ID` + secret `APP_PRIVATE_KEY`, App phải cài trên `task-manager-action`).
- **`test-report.yml`** — nhận `repository_dispatch` `test-report` rồi gọi reusable `test-report.yml` của repo này:

```yaml
on:
  repository_dispatch:
    types: [test-report]

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  report:
    permissions:
      contents: read
      issues: write
      pull-requests: write
    uses: phu-nam-hai-jsco/task-manager-action/.github/workflows/test-report.yml@main
    # runner self-hosted: with: { runner: '["self-hosted","label"]' }
```

`permissions` phải khai báo **ở job gọi**, vì `GITHUB_TOKEN` của reusable workflow là của repo gọi và không tự có thêm quyền.
`repository_dispatch` và `issue_comment` chỉ chạy workflow ở **default branch** (`main`).

### Luồng báo cáo

1. Test workflow bắt đầu: đặt commit status `pending` trên `source_repository`@`ref`. Với lệnh từ comment `$test`, gửi
   `test-report` (`stage: started`) → repo gọi thả 🚀 vào comment lệnh.
2. Kết thúc (kể cả fail): đặt commit status `success`/`failure` và gửi `test-report` (`stage: completed`, kèm `body`
   markdown) → repo gọi đăng comment (quote-reply comment lệnh + 👍/👎, hoặc sticky comment bởi `github-actions[bot]`).
3. Job summary có link tới PR và comment lệnh.

Workflow test **không** comment trực tiếp bằng PAT (comment sẽ mang tên người dùng → bị coi là người).

## 🏷️ Badge coverage

Test web/dotnet/desktop **không** ghi Gist trực tiếp. Khi test đúng head của `main` và thành công, chúng chỉ upload
artifact `coverage-badge` (`badge.json`, giữ 1 ngày). Workflow **`update-coverage-badge.yml`** chạy sau khi các workflow
`Test Web` / `Test API (.NET)` / `Test Desktop (Rust)` hoàn thành (`workflow_run`), tải artifact, kiểm tra tên file,
nhãn, phần trăm theo danh sách cố định rồi cập nhật Gist (`web-coverage.json`, `dotnet-coverage.json`,
`desktop-coverage.json`). Không có artifact (test PR hoặc branch khác) thì bỏ qua.

Cần cấu hình: variable **`COVERAGE_GIST_ID`** và secret **`GIST_TOKEN`** (PAT quyền gist). Thiếu một trong hai thì
workflow bỏ qua và chỉ ghi chú. Lưu ý: `workflow_run` chỉ bắt được run ở repo này, nên caller dùng `uses:` (`workflow_call`)
từ repo khác sẽ **không** cập nhật badge.

## 🧹 Dọn lịch sử Actions

`cleanup-runs.yml` chạy **Chủ nhật 02:17 UTC** hằng tuần hoặc chạy tay (mặc định `dry_run = true` để xem trước).
Chỉ xoá run **đã hoàn thành**; luôn giữ lại `keep_latest` run mới nhất của mỗi workflow, phần còn lại bị xoá khi quá hạn theo kết quả:

| Kết quả run | Mặc định xoá khi quá |
| ----------- | -------------------- |
| `success` | 14 ngày (`success_days`) |
| `failure` / `timed_out` / `startup_failure` | 30 ngày (`failure_days`) |
| `cancelled` / `skipped` / còn lại | 3 ngày (`cancelled_days`) |

`keep_latest` mặc định 5. Kết quả tổng hợp ghi ở Summary của run.

## 🔧 Reusable workflows

| Workflow                      | Purpose                                                            | Inputs (chính)                                  |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `test-report.yml`             | Nhận `test-report` về repo gọi và đăng comment / reaction 🚀 👍/👎 lên PR | `runner` (JSON, mặc định `"ubuntu-latest"`)     |
| `publish-docker-api.yml`      | Build & push image `qlcv-api` từ `docker/dotnet/Dockerfile`         | `ref`, `version`, `branch`                      |
| `publish-docker-web.yml`      | Build & push image `qlcv-web` (nginx + static export) từ `docker/nextjs/Dockerfile` | `ref`, `version`, `branch`, `env_json` |
| `publish-docker-migrator.yml` | Build & push image `qlcv-db-migrator` từ `docker/db-migrator/Dockerfile` | `ref`, `version`, `branch`                 |

Publish workflows: `version` (tag) và `branch` (lane prefix `<branch>-` cho tag, trừ `main`).
Bốn workflow test cũng còn nhận `workflow_call` để tương thích ngược nhưng **không còn là cách gọi chính**.

## 🗑️ Legacy

- `test-dispatcher.yml` — dispatcher cũ nhận `repository_dispatch` rồi gọi các test qua `uses:`. Các test workflow giờ nhận
  event trực tiếp nên file này **thừa và sẽ bị xoá**. Trong lúc nó còn tồn tại, mỗi event `test-*` kích hoạt cả dispatcher lẫn
  test workflow tương ứng, nên test chạy **hai lần**.
- `publish-docker-nginx.yml` — nginx proxy đã merge vào web image (`docker/nextjs/Dockerfile`).
- `publish-docker-api-base.yml`, `publish-docker-api-runtime.yml` — base/runtime images
  không còn cần thiết (`docker/dotnet/Dockerfile` build trực tiếp từ `mcr.microsoft.com/dotnet`).

## 🔐 Secrets & variables

| Tên | Loại | Dùng cho |
| --- | ---- | -------- |
| `APP_CLIENT_ID` + `APP_PRIVATE_KEY` | variable + secret | Token GitHub App ngắn hạn: workflow test (đọc repo, đặt commit status, gửi `test-report`), `claude.yml`, và `ci-dispatcher.yml` ở các repo gọi (gửi `repository_dispatch` sang đây) |
| `COVERAGE_GIST_ID` | variable | Id Gist chứa các file `*-coverage.json` (`update-coverage-badge.yml`) |
| `GIST_TOKEN` | secret | PAT quyền gist, cập nhật badge (`update-coverage-badge.yml`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | `claude.yml` |
| `SUBMODULE_TOKEN` | secret | Checkout private submodules + caller repo của `publish-docker-*` (PAT scope `repo`) |
| `MAIN_REPO_CHECKOUT_TOKEN` | secret | Fallback checkout / push GHCR của `publish-docker-*` |
| `GHCR_TOKEN` | secret | Push image GHCR — fallback `MAIN_REPO_CHECKOUT_TOKEN`, rồi `GITHUB_TOKEN` (caller cần `packages: write`) |
| `MEDIATR_LICENSE_KEY` | secret | Bake license vào API image (`MEDIATR__LICENSEKEY`) |
| `AG_GRID_LICENSE` / `SENTRY_OBS_API_TOKEN` | secret | Bake vào web image (ưu tiên hơn giá trị trong `env_json`) |

Các secret `SUBMODULE_TOKEN`, `MAIN_REPO_PR_TOKEN`, `MAIN_REPO_CHECKOUT_TOKEN`, `GIST_TOKEN` và input `coverage_gist_id` vẫn được
khai báo trong các test workflow chỉ để caller cũ truyền vào không bị lỗi; test workflow **không còn dùng** chúng.

## 🐳 Docker images

Ảnh publish về **namespace của caller repo** (`ghcr.io/${{ github.repository_owner }}/qlcv-*`)
— `GITHUB_TOKEN` với `permissions: packages: write` đủ quyền push; PAT (`GHCR_TOKEN`) chỉ
cần khi muốn push sang namespace khác. Build context là root của caller repo
(submodules `server/`, `frontend/`, `database/`, `docker/` được checkout recursive).
