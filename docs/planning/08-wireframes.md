# Conceptual screen wireframes

These are low-fidelity planning layouts, not implemented screens or observed metrics. Labels are placeholders for validated content. No sample values should appear as real observations in the product.

## Desktop overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ PrimusScope · Independent    [ Search task / transaction / address ]       │
├───────────────────┬───────────────────────────────────────────────────────┤
│ Overview          │ What changed                 [Mainnet] [Period]      │
│ Network           │ Coverage summary · Last trustworthy observation       │
│ Explorer          │                                                       │
│ Vaults*           │ [Network requests] [Observed outcomes*] [Fees by token]│
│ Workspace         │                                                       │
│ Developers*       │ [Trend + comparable previous period + annotations]    │
│                   │ [Chart / Table]                  [Definition / CSV]   │
│ Sources & status  │                                                       │
│                   │ Followed public objects      Recent source changes    │
│                   │ [Saved chain/task/vault*]    [Upgrade / delay / gap]   │
└───────────────────┴───────────────────────────────────────────────────────┘
* Capability-gated. Finance gets a distinct panel when useful data is approved.
```

Keep the first screen focused: one main chart, three useful metrics and a next action. When both domains are supported, give Network and Finance separate labelled panels rather than a combined proof/activity total. Each panel has its own freshness and coverage. Hide metrics with no supported capability; explain an outage on a previously supported metric.

## Desktop task detail

```text
← Search results                 Chain / Contract / Task ID    [Copy link]
Native state: [observed state]   As-of block / finality / coverage

┌─────────────────────────────────────┬──────────────────────────────────┐
│ TASK OBSERVATIONS                   │ ATTESTATION CHECKS               │
│ Request observed                    │ No attestation available         │
│   Assigned attestors                │ or separately executed checks:   │
│ Attestor report(s)                   │ • Schema/version                 │
│   Report identity / fees / source   │ • Signature and signer trust     │
│ Native-state observation            │ • Context/recipient policy       │
│   Exact timestamp or interval       │ • Freshness, where defined       │
│ [Original transaction / contract]   │ [Inspect locally*]               │
└─────────────────────────────────────┴──────────────────────────────────┘
Fee breakdown by component/token · Why this state? · Sources/methodology
```

Two independent lanes prevent task settlement being mistaken for proof validity. An unavailable check stays unavailable. Reports do not produce a guessed completion animation. Task state comes first; full hashes and ABI details are secondary but easy to reach.

## Mobile workspace

```text
PrimusScope                         [Search] [Menu]
Workspace
Saved in this browser · [Manage / clear]

[Changes since last trustworthy visit]
[Followed object → meaningful update → source]
[Saved analysis → filters and comparable period]

Public task lookup
[Chain] [Public address] [Find tasks]
Watching an address does not establish ownership.

[Sources / coverage / last observation]
```

Use single-column cards, short labels and a detail view instead of wide raw tables. Preserve filter context across back navigation. No Connect Wallet control is needed for these public workflows. Later private positions have a distinct authorization entry point and clear local-processing explanation.

## Visual-system direction

Proposed direction: quiet research terminal with readable density. Use the PRD's dark-first palette as a starting point—canvas `#0B1117`, surfaces `#131D26`, text `#EAF3F6`, muted text `#93A6B0`, accent `#20C9A2`—and a complete light theme. These are design candidates, not tested accessibility results. Test actual text/control combinations, particularly accent text on light backgrounds.

Use a well-rendered sans font, tabular numerals for metrics and monospace only for technical identifiers. Keep 4/8-pixel spacing rhythm, restrained borders, 8–12-pixel control radii and 44-pixel minimum touch targets. Error, warning, pending and confidential states use words/icons as well as color. Movement communicates updates only, respects reduced motion and never simulates live activity.

Every chart needs a sentence explaining its question, clear units/period, a table alternative and a source action. Avoid decorative charts, animated counters and yield leaderboards without meaningful source context. Validate typography and navigation with real long hashes, absent values, multiple token units, partial coverage and slow-loading states before high-fidelity polish.
