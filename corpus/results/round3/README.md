# Round 3: blind measurement on `holdout2` (2026-10-14)

`corpus/holdout2/` was written by an independent agent under the access rules in its README
(no analyzer source, no results, no analyzer run). It was measured once, before anything in it was
looked at, with two builds:

- **before**: commit `bdb69b6` (end of round 4, before the bounded expression resolver);
- **after**: the working tree with `packages/core/src/javascript/resolve.ts`, re-export chains,
  `Object.assign` and factory-parameter window options (committed right after this measurement).

Totals over the plain, bundled and minified builds of both applications (hit of expected,
false reports):

| Class | before | after |
| --- | --- | --- |
| IPC channels | 90 of 126 | 90 of 126 |
| IPC senders and receivers | 173 of 180 | 173 of 180 |
| Window settings | 42 of 63, 6 false | 42 of 63, 6 false |
| Bridge members | 78 of 135 | 78 of 135 |
| Bridge member channel | 65 of 78 | 65 of 78 |
| Endpoints | 15 of 57, 10 false | 15 of 57, 10 false |
| Storage keys | 47 of 57, 1 false | 47 of 57, 1 false |

The resolver work raised the earlier hold-out (`corpus/holdout`) from 43 to 60 of 72 IPC
channels, but changed nothing here. The idioms it handles were chosen from the earlier hold-out's
documented misses; this set uses others. That is the honest reading: the earlier hold-out is no
longer a blind measure, and the gain on it does not carry over to code the work was not fitted to.

After this measurement `holdout2` was used to find defect classes, so later results on it are not
blind either. A new set is needed for the next blind measurement.
