# MSP / AOS pipeline glossary and workflow

What each dashboard lane is, how it sits in the AOS/PC build workflow, and
which stages this dashboard actually tracks.

Canonical product docs (SSO):

- [Build Workflows](https://confluence.eng.nutanix.com:8443/spaces/ES/pages/44569858/Build+Workflows) (Engineering Systems)
- [AOS Pipelines](https://confluence.eng.nutanix.com:8443/spaces/DPRO/pages/451952982/AOS+Pipelines) (DPRO)

Live Jenkins URLs for every train: [`PIPELINE-LINKS.md`](PIPELINE-LINKS.md).
Dashboard discovery and alerting: [`PIPELINE-CONTEXT.md`](PIPELINE-CONTEXT.md).

---

## End-to-end workflow

A change moves left-to-right. Later stages consume artifacts from earlier
ones. **Merge** is a Gerrit action, not a Jenkins lane.

```
Precommit → Merge → Local LCC → Global LCC
    → LKG-Builds → LKG-Tests → Current LKG
    → Postcommit → QP / Smoke → Jita
```

| Stage | What it is | On this dashboard? |
|---|---|---|
| **Precommit** | Per-CR compile + unit / component tests. Must pass (or be waived) before submit. | Yes — Devtest, msp-master, patch trains |
| **Merge** | Gerrit submit lands the CR on `master` or a `ganges-*` train. | No — Gerrit, not Jenkins |
| **Local LCC** | First post-merge **Last Commit Check** on a local / limited cluster. | Yes — msp-master and trains that have `LCC_PC` / `LCC_NOS` |
| **Global LCC (GLCC)** | Wider post-merge suite (DIAL / multi-node). Jenkins folder `LCC_Dial_Tests`. | Yes — msp-master and trains that have a Dial job |
| **LKG-Builds** | Produce the Last-Known-Good *candidate* artifacts. | No — not a dashboard column |
| **LKG-Tests** | Validate that candidate. | No — not a dashboard column |
| **Current LKG** | Promoted Last Known Good build other teams consume. | Yes — product `master` + patch **LKG** |
| **LKG ValPromote** | Validation-promote path that advances a verified LKG. | Yes — product `master` + patch **LKG ValPromote**; msp-master LKG *is* this job |
| **Postcommit** | Broader regression after LKG. Jenkins folder `Postcommit`. | Yes — dashboard **Smoke** column |
| **QP / Smoke** | Quality-pipeline smoke: short sanity on the LKG / latest train. | Same Jenkins jobs as Postcommit / Smoke |
| **Jita** | Longer qualification / orchestration (not Nupipe). | No |

MSP-controller work also has a **Devtest** precommit (`msp-controller-precommit`)
that is earlier and narrower than the product Nupipe precommit.

---

## Stage definitions

### Precommit

Runs on every Gerrit change-request **before** merge: compile, unit tests,
static checks, and component-level tests for that CR only. Failure blocks
submit (unless waived).

| Where | Jenkins |
|---|---|
| Devtest (MSP controller) | `msp-controller-precommit` on `10.37.10.188:8080` |
| msp-master | `Nupipe/Precommit_NOS/msp-master` (SB Prod Controller-3) |
| Patch (current trains) | `Nupipe/Precommit_PC/msp-ganges-<ver>-pc` (Controller-4) |
| Patch (older trains) | same path on Harbinger Prod-12 |

### Merge

Not a pipeline. The author submits in Gerrit; the change lands on the branch
and kicks off Local LCC (and later stages).

### Local LCC (Last Commit Check)

First **post-merge** gate. Builds the branch tip and runs a local / limited
cluster suite (NOS or PC). Catches “it compiled on my CR but broke after
merge” before Global LCC and LKG.

| Where | Jenkins |
|---|---|
| msp-master | `Nupipe/LCC_NOS/msp-master` (Controller-2) |
| Patch (current) | `Nupipe/LCC_PC/msp-ganges-<ver>-pc` (Controller-4) |
| Patch (older) | `Nupipe/LCC_PC/msp-ganges-<ver>-pc` (Controller-2) |
| Patch fallback | `Nupipe/LCC_NOS/msp-ganges-<ver>` when no `-pc` sibling exists |

### Global LCC (GLCC)

Wider Last Commit Check after Local LCC. Jenkins name is `LCC_Dial_Tests`
because the extra coverage is **DIAL** (distributed integration) across more
nodes and hardware variants.

| Where | Jenkins |
|---|---|
| msp-master | `Nupipe/LCC_Dial_Tests/msp-master` (Controller-2) |
| Patch (when present) | `Nupipe/LCC_Dial_Tests/msp-ganges-<ver>-pc` (Controller-2) |

Not every patch train has a GLCC job. Missing trains show an empty cell.

### LKG-Builds and LKG-Tests

After LCC, a **candidate** LKG is built (`LKG-Builds`) and tested
(`LKG-Tests`). Those two steps are part of the product workflow but are
**not** columns on this dashboard (they were dropped from the Code Tracker
UI as untracked). Success here is what allows **Current LKG** to move
forward.

### Current LKG (Last Known Good)

The promoted build that passed LKG-Builds + LKG-Tests. Downstream teams
treat it as the latest known-good AOS/PC artifact for that train.

| Where | Jenkins |
|---|---|
| Product master | `Nupipe/LKG/master` (Controller-1) |
| Patch | `Nupipe/LKG/ganges-<ver>-stable-pc` (NOS `-stable` fallback) |

The dashboard hero KPI **Last Successful LKG** is this product-master job,
not ValPromote and not the newest patch LKG.

### LKG ValPromote (validation promote)

A **separate** Nupipe folder (`LKG_ValPromote`) that validation-promotes an
LKG: confirm the candidate, then advance it. It does **not** replace product
LKG.

| Where | Jenkins |
|---|---|
| msp-master LKG column | `Nupipe/LKG_ValPromote/master` (same job, shown as msp-master LKG) |
| Product master + patch | `Nupipe/LKG_ValPromote/master` and `ganges-<ver>-stable-pc` |

Live ValPromote jobs today: `master`, 7.6.1, 7.7. Other trains appear when
Jenkins adds the job.

### Postcommit and QP / Smoke

After Current LKG, **Postcommit** runs a broader regression. **QP** (Quality
Pipeline) **Smoke** is the short sanity slice of that path. This dashboard
maps both to the **Smoke** column, which reads the `Postcommit` folder.

| Where | Jenkins |
|---|---|
| Product master | `Postcommit/master` (Controller-1) |
| Patch | `Postcommit/ganges-<ver>-stable-pc` (NOS `-stable` fallback) |

### Jita

Nutanix qualification / test-orchestration **after** smoke. Longer-running,
not a Nupipe lane, and not polled by this dashboard.

### Devtest

MSP-controller-only precommit on a dedicated Jenkins, independent of Nupipe.
It is the Devtest row, not a master or patch lane.

---

## How the dashboard rows map to the workflow

Two **master** rows, then one row per discovered `ganges-<version>` train.

```
Devtest          Precommit
msp-master       Precommit → Local LCC → GLCC → LKG ValPromote (as LKG)
master           Smoke (Postcommit / QP) → Current LKG → LKG ValPromote
patch <ver>      Precommit → Local LCC → GLCC? → Smoke → LKG → LKG ValPromote
```

- **msp-master** is the MSP-controller product line on `master` (NOS
  precommit / LCC, Dial GLCC, ValPromote as its LKG).
- **master** is the AOS/PC product line: Postcommit smoke + `Nupipe/LKG` +
  ValPromote.
- **Patch** trains (`7.7`, `7.6.1`, …) club every lane that exists for that
  version. Empty cell = no Jenkins job for that lane/version.

NOS vs PC: discovery prefers **PC** jobs (`-pc`, `LCC_PC`,
`ganges-<ver>-stable-pc`). NOS is fallback when a train has no PC sibling.

---

## Acronyms

| Term | Expansion |
|---|---|
| AOS / NOS | Cluster OS (NOS jobs are the non-PC siblings) |
| PC | Prism Central |
| DPRO | Nutanix software delivery / pipeline org |
| Nupipe | Shared Jenkins folder for Precommit, LCC, LKG, ValPromote |
| LCC | Last Commit Check (post-merge) |
| GLCC | Global LCC (`LCC_Dial_Tests`) |
| DIAL | Distributed integration lab tests used by GLCC |
| LKG | Last Known Good |
| ValPromote | Validation promote (advance a verified LKG) |
| QP | Quality Pipeline |
| Smoke / Postcommit | Short / broader post-LKG regression |
| Jita | Post-smoke qualification platform |
| CR | Gerrit change request |
| MSP | Micro-Service Platform (this dashboard’s product) |

---

## Related files

| File | Role |
|---|---|
| [`PIPELINE-LINKS.md`](PIPELINE-LINKS.md) | Live Jenkins URL per train and lane |
| [`PIPELINE-CONTEXT.md`](PIPELINE-CONTEXT.md) | Why discovery, alerting, and row split work this way |
| [`PIPELINE-DESIGN.md`](PIPELINE-DESIGN.md) | Dashboard technical design |
| [`README.md`](README.md) | Install, Slack, API |
