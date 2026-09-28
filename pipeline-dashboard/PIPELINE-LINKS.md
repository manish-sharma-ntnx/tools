# MSP Pipeline Jenkins URLs

Live Jenkins job URLs the dashboard tracks after upsert (PC over NOS, Controller-4 over Harbinger leftovers).

Harbinger Prod-14 is in the controller map but unused.

**LKG ValPromote** (`Nupipe/LKG_ValPromote`) is a separate lane from product LKG.
Discovery prefers `ganges-<ver>-stable-pc` and falls back to `ganges-<ver>-stable`.
Live jobs today: `master`, `ganges-7.6.1-stable-pc`, `ganges-7.7-stable-pc`. Other
version URLs below are the PC path discovery will use when those jobs appear.

## Devtest

| Lane | URL |
|---|---|
| Precommit | http://10.37.10.188:8080/job/msp-controller-precommit/ |

## msp-master

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-sb-prod-jenkins-controller-3.corp.p10y.ntnxdpro.com/job/Nupipe/job/Precommit_NOS/job/msp-master/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_NOS/job/msp-master/ |
| GLCC | https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_Dial_Tests/job/msp-master/ |
| LKG (ValPromote) | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/master/ |

## master

| Lane | URL |
|---|---|
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/master/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/master/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/master/ |

## 7.7

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.7-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.7-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.7-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.7-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.7-stable-pc/ |

## 7.6.9.99

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.9.99-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.6.9.99-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.9.99-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.9.99-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.9.99-stable-pc/ |

## 7.6.9.3

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.9.3-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.9.3-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.9.3-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.9.3-stable-pc/ |

## 7.6.9.2

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.9.2-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.9.2-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.9.2-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.9.2-stable-pc/ |

## 7.6.9.1

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.9.1-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.9.1-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.9.1-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.9.1-stable-pc/ |

## 7.6.1

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.1-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.6.1-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.1-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.1-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.1-stable-pc/ |

## 7.6.0.10

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.0.10-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.6.0.10-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.0.10-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.0.10-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.0.10-stable-pc/ |

## 7.6.0.8

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.0.8-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-4.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.6.0.8-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.0.8-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.0.8-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.0.8-stable-pc/ |

## 7.6.0.6

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.0.6-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.0.6-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.0.6-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.0.6-stable-pc/ |

## 7.6.0.1

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6.0.1-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6.0.1-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6.0.1-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6.0.1-stable-pc/ |

## 7.6

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.6-pc/ |
| Local LCC | https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_PC/job/msp-ganges-7.6-pc/ |
| GLCC | https://phx-p10y-sb-prod-jenkins-controller-2.corp.p10y.ntnxdpro.com/job/Nupipe/job/LCC_Dial_Tests/job/msp-ganges-7.6-pc/ |
| Smoke | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Postcommit/job/ganges-7.6-stable-pc/ |
| LKG | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG/job/ganges-7.6-stable-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.6-stable-pc/ |

## 7.5.99

| Lane | URL |
|---|---|
| Precommit | https://phx-p10y-jenkins-harbinger-prod-12.p10y.eng.nutanix.com/job/Nupipe/job/Precommit_PC/job/msp-ganges-7.5.99-pc/ |
| LKG ValPromote | https://phx-p10y-sb-prod-jenkins-controller-1.corp.p10y.ntnxdpro.com/job/Nupipe/job/LKG_ValPromote/job/ganges-7.5.99-stable-pc/ |
