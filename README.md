# JI TECH OpenClaw

This repository is the JI TECH OpenClaw product source repository.

It is not the server operations repository. Host install, NAS mount policy, customer slots, image catalog, rollout, drift checks, and the admin console are handled by [`Epicevent/openclaw-nas-agent-baseline`](https://github.com/Epicevent/openclaw-nas-agent-baseline).

## Account And Path Map

| Layer | Account / path | Purpose | Must match |
| --- | --- | --- | --- |
| Product source of truth | `Epicevent/openclaw-jitech` | OpenClaw UI and product code | Source commit used for image release |
| Server development checkout | `openclawdev:/home/openclawdev/src/openclaw-jitech` | Server-side development copy | Same Git repository and commit as this repo when releasing |
| Development preview slot | `dev-oc` | Shows the current OpenClaw dev build through Apache | Must use OpenClaw source mode only on dev slot |
| Development preview URL | `https://dev-oc.ji-tech.co.kr/` | Browser preview of the dev slot container | Must reflect the server dev build |
| Canary customer slot | `oc2` | First image-only customer slot used for important OpenClaw changes | Must run a registry image digest, not source mode |
| Customer OpenClaw slots | `oc1` to `oc14` | Customer slots | Image-only |
| Hermes slots | `oc15` to `oc20` | Hermes customer slots | Managed by the Hermes image lane |

`openclawdev` and `dev-oc` are not the same account.

```text
openclawdev:
  developer/build account
  owns product source
  may build images

dev-oc:
  managed dev slot account
  no sudo/docker role as a customer-like slot
  container may see OpenClaw dev build output

oc2:
  managed customer slot
  canary target
  must only run a published registry image
```

## Repository Responsibility

This repository owns:

- OpenClaw UI and branding changes
- default provider/model UX
- customer-facing OpenClaw behavior
- the source commit used to build an OpenClaw product image

This repository does not own:

- NAS credentials
- Gemini/API keys
- gateway tokens
- `/srv/openclaw-ops`
- Apache vhost files
- customer slot rollout state
- server `.env` files

Secrets and customer data must not be committed here.

## Development Loop

Development happens on the server-side checkout.

```bash
ssh openclawdev@SERVER
cd /home/openclawdev/src/openclaw-jitech
git status
```

The development preview is `dev-oc`.

```text
source:
  /home/openclawdev/src/openclaw-jitech

preview slot:
  dev-oc

preview URL:
  https://dev-oc.ji-tech.co.kr/
```

The intended loop is:

```text
edit source as openclawdev
  -> build/update dev output
  -> inspect https://dev-oc.ji-tech.co.kr/
  -> commit source
  -> publish image from that commit
  -> canary oc2
  -> rollout only after canary passes
```

Do not mount source into `oc1` to `oc14`.

## Product Image Release

Tagging this repository creates the product image.

```bash
git tag vYYYY.M.D-alpha.N
git push origin vYYYY.M.D-alpha.N
```

Example:

```bash
git tag v2026.6.5-alpha.1
git push origin v2026.6.5-alpha.1
```

The `Docker Release` workflow publishes:

```text
ghcr.io/epicevent/openclaw-jitech:<version>-amd64
ghcr.io/epicevent/openclaw-jitech:<version>-arm64
ghcr.io/epicevent/openclaw-jitech:<version>
```

The operating server is ARM64. The ARM64 digest is the input for the operations wrapper image.

## Operations Wrapper Image

Customer slots do not run this product image directly. They run the OpenClaw NAS Agent wrapper image built by the operations repository.

```text
openclaw-jitech source commit
  -> ghcr.io/epicevent/openclaw-jitech:<version>-arm64
  -> openclaw-nas-agent-baseline wrapper workflow
  -> ghcr.io/epicevent/openclaw-nas-agent:<release>
  -> server image catalog
  -> oc2 canary
  -> OpenClaw lane rollout
```

Dispatch the wrapper workflow with the product image digest:

```bash
gh workflow run "Publish OpenClaw Family Runtime Wrapper" \
  -R Epicevent/openclaw-nas-agent-baseline \
  -f image_tag="openclaw-jitech-YYYYMMDD-alphaN" \
  -f base_image="ghcr.io/epicevent/openclaw-jitech@sha256:<arm64_digest>" \
  -f runtime_user="node"
```

## Server Registration

On the server, register and verify the wrapper image with `svcops-control.sh`.

```bash
sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-release-add \
  ghcr.io/epicevent/openclaw-nas-agent:openclaw-jitech-YYYYMMDD-alphaN \
  openclaw-jitech-YYYYMMDD-alphaN

sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-release-verify \
  openclaw-jitech-YYYYMMDD-alphaN
```

Important OpenClaw changes are applied to `oc2` first.

```bash
sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-rollout-slot \
  oc2 openclaw-jitech-YYYYMMDD-alphaN

sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-status oc2

sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh check \
  oc2 oc2.ji-tech.co.kr
```

Only after `oc2` passes browser verification and deployment check should the OpenClaw lane be promoted.

## Rollout Rules

```text
dev-oc:
  source mode is allowed

oc1 to oc14:
  image-only
  source mode is forbidden

oc15 to oc20:
  Hermes lane
  do not apply OpenClaw images
```

Hermes source and images are managed separately.

```text
source repo:
  Epicevent/hermes-jitech

slots:
  oc15 to oc20
```

## Local Checks

```bash
git status
git log --oneline -5
```

Optional source build check:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm ui:build
```

Deployment state is verified in the operations repository and on the server image catalog, not by this repository alone.
