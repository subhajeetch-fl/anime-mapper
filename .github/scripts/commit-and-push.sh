#!/usr/bin/env bash
set -euo pipefail

COMMIT_MESSAGE="${1:?Commit message is required}"
POST_REBASE_ACTION="${2:-none}"
BRANCH="${GITHUB_REF_NAME:-}"

if [ -z "$BRANCH" ] && [ -n "${GITHUB_REF:-}" ]; then
  BRANCH="${GITHUB_REF#refs/heads/}"
fi

if [ -z "$BRANCH" ] || [ "$BRANCH" = "${GITHUB_REF:-}" ]; then
  BRANCH="main"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

rebuild_indexes_if_requested() {
  if [ "$POST_REBASE_ACTION" = "rebuild-indexes" ]; then
    node scripts/build-indexes.js
  fi
}

has_staged_changes() {
  ! git diff --cached --quiet
}

has_worktree_changes() {
  ! git diff --quiet || ! git diff --cached --quiet
}

commit_pending_changes() {
  git add -A

  if ! has_staged_changes; then
    return 1
  fi

  local ahead_count
  ahead_count="$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)"

  if [ "$ahead_count" -gt 0 ]; then
    git commit --amend --no-edit
  else
    git commit -m "$COMMIT_MESSAGE"
  fi

  return 0
}

rebuild_indexes_if_requested

git add -A
if ! has_staged_changes; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"

for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:$BRANCH"; then
    echo "Push succeeded."
    exit 0
  fi

  echo "Push was rejected or interrupted. Syncing with origin/$BRANCH and retrying ($attempt/5)."
  git fetch origin "$BRANCH"

  if ! git rebase -X theirs "origin/$BRANCH"; then
    echo "::error::Could not automatically rebase workflow changes on top of origin/$BRANCH."
    git status --short
    exit 1
  fi

  rebuild_indexes_if_requested

  if has_worktree_changes; then
    commit_pending_changes
  fi

  if command -v sleep >/dev/null 2>&1; then
    sleep $((attempt * 10))
  fi
done

echo "::error::Push failed after 5 attempts."
exit 1
