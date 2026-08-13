# oc14 generic RAG user-visible terminal

<!-- markdownlint-disable MD060 -->

## One-sentence terminal

The terminal is one actual oc14 Control UI turn in which a user's question traverses `mounted corpus -> active index -> dense retrieval/GPU rerank -> bounded context -> selected provider` and returns the provider's answer in that same UI, with corpus-scope ambiguity `0` and provider ambiguity `0`; the negative control then proves `RAG OFF` remains off after restart, and rollback restores the last positive terminal.

## Layer separation

| Layer | Required proof | Current state |
| --- | --- | --- |
| Source | The exact OpenClaw ref containing the generic-RAG contract is named and clean. | `[실측]` Local branch `codex/oc14-generic-rag` was clean at `7f76b5447bbe84b43c44513e3191e1a805236c3f`; its configured `origin` is `https://github.com/Epicevent/openclaw-jitech.git`, and the local remote-tracking ref had the same SHA. Remote freshness beyond that local observation is `[미확인]`. |
| Build | A trusted OpenClaw product-image digest exists and its source revision label resolves to the selected clean source ref. | `[미확인]` No trusted-build receipt, immutable product digest, or image revision-label observation is available. |
| Install | The approved product/wrapper digests and the actual oc14 installation resolve to the intended artifact. | `[미확인]` No product approval, wrapper build/approval, image-plan, canary-apply, or install receipt is available. |
| Runtime | Live oc14 exposes the intended mounted corpus, active index, dense retriever, GPU reranker, bounded-context configuration, selected provider, and `RAG` state. | `[미확인]` No live manifest, running digest, configuration, restart, or component-health receipt is available. |
| Actual turn | A real question entered in the oc14 UI produces an answer whose per-turn receipt binds every terminal stage. | `[미확인]` No actual UI-turn receipt or negative-control/rollback receipt is available. |

These layers are not interchangeable: source or tests cannot prove a build; a build cannot prove install; install or process survival cannot prove runtime routing; runtime health or HTTP 200 cannot prove the requested UI turn.

## First non-substitutable blocker

`[미확인]` The first missing proof after the selected clean source ref is a trusted product image built from that ref, identified by an immutable digest and a matching source revision label. Until that artifact exists and is observed, no later wrapper, approval, oc14 install, runtime, or actual-turn receipt can establish that this source is what the user exercised.

## Dependency owner, input, and output

| Dependency | Owner/mechanism | Required input | Required output | Current evidence |
| --- | --- | --- | --- | --- |
| Trusted OpenClaw product build | `openclawdev` running `scripts/build-trusted-product-image.sh` | Pushed, clean `Epicevent/openclaw-jitech` ref `codex/oc14-generic-rag` at `7f76b5447bbe84b43c44513e3191e1a805236c3f` | Immutable OpenClaw product-image digest plus image source revision label equal to the input SHA, and complete build receipt | `[미확인]` Build has not been observed in this task. |

The owner/mechanism above identifies the next product boundary; it does not assert authorization or completion. Wrapper publication, digest approvals, image-plan, oc14 canary application, verification, and promotion remain separate boundaries.

## Positive receipt

One positive receipt must bind a single actual oc14 UI turn to all of the following observations. Missing any row leaves the terminal `[미확인]`.

| Receipt field | Required observation |
| --- | --- |
| UI input | Exact user question, UI session/turn identifier, and submission timestamp. |
| Mounted corpus | Stable corpus identity, exact mounted source/path, mount revision or content digest, and scope selected for this turn. |
| Scope resolution | Exactly one corpus scope selected; ambiguity count `0`. |
| Active index | Index identity/revision tied to that corpus digest and observed active for the turn. |
| Dense retrieval | Query/turn correlation plus selected candidate identifiers and scores from the active index. |
| GPU rerank | GPU reranker identity/revision, input candidate identifiers, ordered output identifiers/scores, and successful turn correlation. CPU or mock substitution does not satisfy this field. |
| Bounded context | Exact context items passed onward, their corpus provenance, and measured item/token/byte bounds within the configured limit. |
| Provider resolution | Exactly one provider/model selected; provider ambiguity count `0`, with runtime evidence naming that provider/model for the turn. |
| Provider answer | Provider request/response correlation and the answer payload returned for the turn. |
| UI output | The same turn renders the provider answer in oc14, with enough provenance to bind displayed answer to the bounded corpus context. |

Current positive receipt: `[미확인]`.

## Negative control and rollback

1. Capture the last known positive receipt above and its exact oc14 configuration revision. Current baseline: `[미확인]`.
2. Change only the isolated verification session/configuration to `RAG OFF`, observe the state change, restart the relevant oc14 runtime through its installed control path, and observe that `RAG OFF` persists after restart.
3. Submit the same UI question. The receipt must show no corpus lookup, no active-index use, no dense retrieval, no GPU rerank, and no corpus-derived bounded context. A provider may answer without RAG only if the receipt clearly distinguishes that path; any corpus-derived answer fails the negative control.
4. Restore the captured configuration revision, restart through the same control path, observe `RAG ON`, then repeat the same UI question and reproduce the positive terminal with scope ambiguity `0` and provider ambiguity `0`.
5. Compare the restored receipt with the last known positive normal values. If restoration cannot be observed, rollback remains `[미확인]` and the terminal is not complete.

Current negative-control receipt: `[미확인]`. Current rollback receipt: `[미확인]`.

## Current live provenance

Observation time: 2026-08-12 (Asia/Seoul); exact command timestamps were not captured, so finer time is `[미확인]`.

```text
git remote -v
origin  https://github.com/Epicevent/openclaw-jitech.git (fetch) [blob:none]
origin  https://github.com/Epicevent/openclaw-jitech.git (push)

git branch --show-current
codex/oc14-generic-rag

git rev-parse HEAD
7f76b5447bbe84b43c44513e3191e1a805236c3f

git rev-parse origin/codex/oc14-generic-rag
7f76b5447bbe84b43c44513e3191e1a805236c3f

git status --porcelain=v2 --branch
# branch.oid 7f76b5447bbe84b43c44513e3191e1a805236c3f
# branch.head codex/oc14-generic-rag
# branch.upstream origin/codex/oc14-generic-rag
# branch.ab +0 -0
```

The clean observation above preceded creation of this documentation file. After this file is created, it is the only intended worktree difference. Live oc14 canary coordinates, current slot class/state, manifests, running digests, image labels, installed source, RAG configuration, provider selection, and actual UI behavior are all `[미확인]` because no runtime probe was performed.

## Next runnable action

At the next explicitly authorized external boundary, the trusted-build operator should re-confirm that the remote ref is pushed and clean at `7f76b5447bbe84b43c44513e3191e1a805236c3f`, then run the installed trusted product build on `openclawdev` and return the complete build receipt, immutable product-image digest, and matching source revision label. This task does not authorize or perform that action; no wrapper publication, approvals, image-plan, canary, verification, or promotion follows automatically.

## Supersession history

| Date | Superseded statement | Replacement |
| --- | --- | --- |
| 2026-08-12 | `[미확인]` No earlier `docs/USER_VISIBLE_TERMINAL.md` existed in this worktree at inspection time; no broader historical terminal record was searched or inferred. | This document establishes the terminal definition and records source evidence separately from `[미확인]` build, install, runtime, actual-turn, negative-control, and rollback evidence. |

Future entries must name the exact prior conclusion being superseded, preserve its receipt or mark it `[미확인]`, and identify the new observation that changes the conclusion.
