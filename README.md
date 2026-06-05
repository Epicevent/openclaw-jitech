# JI TECH OpenClaw

This repository is the JI TECH OpenClaw product source repository.

It is not the server operations repository. Host install, NAS mount policy, customer slots, image catalog, rollout, drift checks, and the admin console are handled by [`Epicevent/openclaw-nas-agent-baseline`](https://github.com/Epicevent/openclaw-nas-agent-baseline).

## Responsibility

This repository owns:

- OpenClaw UI and branding changes
- default provider/model UX
- customer-facing OpenClaw behavior
- the source commit used to build an OpenClaw product image

This repository does not own:

- customer slot assignment
- canary slot selection
- production lane rollout
- NAS credentials
- Gemini/API keys
- gateway tokens
- `/srv/openclaw-ops`
- Apache vhost files
- server `.env` files

Secrets and customer data must not be committed here.

## Account And Environment Boundaries

The source repository, server development checkout, dev preview slot, and customer slots are different layers.

| Layer | Example | Purpose | Source of truth |
| --- | --- | --- | --- |
| Product source | `Epicevent/openclaw-jitech` | OpenClaw code that JI TECH changes | This repository |
| Server development checkout | `/home/openclawdev/src/openclaw-jitech` | Server-side working copy used by the developer account | This repository after push/pull |
| Dev preview slot | configured in operations | Shows the development build through Apache | Operations repo and `/srv/openclaw-ops` |
| Customer slot | configured in operations | Runs a published image digest | Operations repo and `/srv/openclaw-ops` |

The developer account and the dev preview slot are not the same thing.

```text
developer account:
  owns and edits the product source checkout
  may run build and image release work

dev preview slot:
  managed slot used to inspect the development build in a browser
  may use source mode when operations policy allows it

customer slot:
  managed slot used by a real tester or customer
  must run only a published registry image digest
```

This repository must not decide which customer slot is used for canary. That decision belongs to operations state.

## Development Loop

Development happens in the product source checkout.

```bash
cd /home/openclawdev/src/openclaw-jitech
git status
```

The intended loop is:

```text
edit source
  -> build/update dev output
  -> inspect through the configured dev preview URL
  -> commit source
  -> push source
  -> publish product image from that commit
  -> operations wrapper image
  -> operations-selected canary slot
  -> rollout only after canary passes
```

Customer slots do not use source mode.

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

Use the architecture digest that matches the target server. The image tag is a human-readable name; digest is the deployment identity.

## Operations Wrapper Image

Customer slots do not run this product image directly. They run the OpenClaw NAS Agent wrapper image built by the operations repository.

```text
openclaw-jitech source commit
  -> ghcr.io/epicevent/openclaw-jitech:<version>-<arch>
  -> openclaw-nas-agent-baseline wrapper workflow
  -> ghcr.io/epicevent/openclaw-nas-agent:<release>
  -> server image catalog
  -> operations-selected canary slot
  -> OpenClaw lane rollout
```

Dispatch the wrapper workflow from the operations repository with the product image digest:

```bash
gh workflow run "Publish OpenClaw Family Runtime Wrapper" \
  -R Epicevent/openclaw-nas-agent-baseline \
  -f image_tag="openclaw-jitech-YYYYMMDD-alphaN" \
  -f base_image="ghcr.io/epicevent/openclaw-jitech@sha256:<digest>" \
  -f runtime_user="node"
```

## Server Registration

Server registration and rollout are operations work. Use the operations repository and `svcops-control.sh`.

```bash
sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-release-add \
  ghcr.io/epicevent/openclaw-nas-agent:openclaw-jitech-YYYYMMDD-alphaN \
  openclaw-jitech-YYYYMMDD-alphaN

sudo -n /opt/openclaw-nas-agent-baseline/scripts/svcops-control.sh image-release-verify \
  openclaw-jitech-YYYYMMDD-alphaN
```

The operations state chooses the canary slot and rollout lane. This repository only produces the product source and product image.

## OpenClaw And Hermes Separation

OpenClaw and Hermes are separate product lanes.

```text
OpenClaw source:
  Epicevent/openclaw-jitech

Hermes source:
  Epicevent/hermes-jitech
```

Do not apply an OpenClaw image to the Hermes lane. Do not apply a Hermes image to the OpenClaw lane.

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

Deployment state is verified in the operations repository and server image catalog, not by this repository alone.
