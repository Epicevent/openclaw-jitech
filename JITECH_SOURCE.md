# JiTech OpenClaw Source

This repository is the JiTech OpenClaw custom source tree.

Seed source:

```text
upstream_repo=https://github.com/openclaw/openclaw.git
upstream_commit=989e53c20d395d3c8bf47efc21fdb9d56e7227b0
server_seed=gx10-947d:/home/oc1/openclaw
```

Initial JiTech changes:

```text
ui/index.html
ui/src/ui/views/login-gate.ts
ui/src/ui/app-render.ts
ui/public/favicon.svg
ui/public/favicon.ico
ui/public/favicon-32.png
ui/public/apple-touch-icon.png
```

Do not commit server runtime state here:

```text
.env
docker-compose*.yml
Apache deploy conf
backup files
credential files
chmod-only changes
```

OpenClaw NAS Agent images are built from this repository by passing this
repository URL and an exact commit SHA to the image publishing workflow in
`Epicevent/openclaw-nas-agent-baseline`.
