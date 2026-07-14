#!/usr/bin/env bash
#
# Controlled, reproducible OpenClaw product image build — the trustworthy equivalent
# of the docker-release CI build, for fast server-side builds on a build account.
#
# Trust does not come from WHERE this runs; it comes from building ONLY a clean, pushed
# git ref (never a dirty working tree) with the standard build-args and base-image pins,
# recording the source commit as a provenance label, then pushing once. The printed
# digest is what a root operator approves via `opsctl image approve`, and opsctl refuses
# any unapproved digest — so a server-side build is as trustworthy as the CI build and
# every slot stays on the one approved digest.
#
# Usage:
#   scripts/build-trusted-product-image.sh <git-ref> <image-tag> [extensions]
# Example:
#   scripts/build-trusted-product-image.sh origin/main main diagnostics-otel,codex
#
set -euo pipefail

REPO="${IMAGE_REPO:-ghcr.io/epicevent/openclaw-jitech}"
REF="${1:?usage: build-trusted-product-image.sh <git-ref> <image-tag> [extensions]}"
TAG="${2:?image tag required}"
# Keep in sync with .github/workflows/docker-release.yml build-args.
EXTENSIONS="${3:-diagnostics-otel,codex}"

toplevel="$(git rev-parse --show-toplevel)"
git -C "$toplevel" fetch -q origin "${REF#origin/}" || git -C "$toplevel" fetch -q --all
sha="$(git -C "$toplevel" rev-parse "${REF}^{commit}")"

work="$(mktemp -d)"
cleanup() {
  git -C "$toplevel" worktree remove --force "$work" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Build from a fresh detached worktree at the exact commit — guarantees a clean tree
# decoupled from whatever the build account currently has checked out.
git -C "$toplevel" worktree add --detach "$work" "$sha" >/dev/null
if [ -n "$(git -C "$work" status --porcelain)" ]; then
  echo "error: build worktree is not clean at $sha" >&2
  exit 1
fi

image_ref="${REPO}:${TAG}"
echo "BUILD_SOURCE_COMMIT=${sha}"
echo "BUILD_EXTENSIONS=${EXTENSIONS}"
echo "BUILD_IMAGE_REF=${image_ref}"

# Version-tracking: record THIS build in the forward-only history, then bake the timeline
# into the build context (moved into dist/ by the Dockerfile). The clean-tree check above
# has already passed; writing versions.json into the worktree now is intentional build
# metadata (like dist/build-info.json), not source — the source-commit label stays $sha.
# Default is the SAFE customer timeline (date + build name only); a customer image must
# never carry internal PR prose. Set VERSIONS_MODE=owner for dev/ops preview images to
# attach each build's PR title + body (ground truth via the commit's "(#NN)").
hist="${BUILD_HISTORY_FILE:-${HOME}/.openclaw-build-history.jsonl}"
node "${work}/scripts/record-build-version.mjs" "${TAG}" "${sha}" "${hist}"
if [ "${VERSIONS_MODE:-customer}" = "owner" ]; then
  ( cd "${work}" && node scripts/generate-versions.mjs "${hist}" "${work}/versions.json" )
  echo "VERSIONS_MODE=owner"
else
  ( cd "${work}" && node scripts/generate-versions.mjs "${hist}" "${work}/versions.json" --safe )
  echo "VERSIONS_MODE=customer"
fi

DOCKER_BUILDKIT=1 docker buildx build \
  --build-arg "OPENCLAW_EXTENSIONS=${EXTENSIONS}" \
  --build-arg "OPENCLAW_BUILD_VERSION=${TAG}" \
  --label "org.opencontainers.image.revision=${sha}" \
  --label "org.opencontainers.image.source=https://github.com/Epicevent/openclaw-jitech" \
  -t "${image_ref}" \
  --push \
  -f "${work}/Dockerfile" \
  "${work}"

digest="$(docker buildx imagetools inspect "${image_ref}" | awk '/^Digest:/ { print $2; exit }')"
case "${digest}" in
  sha256:*) : ;;
  *) echo "error: could not resolve pushed image digest" >&2; exit 1 ;;
esac
pinned="${REPO}@${digest}"
echo "BUILT_IMAGE=${pinned}"
echo "BUILT_SOURCE_COMMIT=${sha}"
echo "APPROVE_CMD=sudo /usr/local/bin/opsctl image approve openclaw product ${pinned} --source-commit ${sha}"
