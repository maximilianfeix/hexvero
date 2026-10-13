# Cost per unit

Every unit of every question; times are min / median / max over the repeated runs.

## Command line

| question | tool (way) | unit | calls | bytes returned | bytes to side files | cold ms min / median / max | warm ms min / median / max | peak tree RSS MiB | runs | failed | answer hit / missed / false |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | hexvero | dev/notes-app.plain.asar | 3 | 20787 |  | 477 / 536 / 697 | 383 / 462 / 872 | 81 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | dev/notes-app.bundled.asar | 3 | 19393 |  | 661 / 907 / 1301 | 462 / 701 / 1243 | 81 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | dev/notes-app.minified.asar | 3 | 19297 |  | 605 / 775 / 3207 | 492 / 903 / 2752 | 82 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.plain.asar | 3 | 29842 |  | 614 / 725 / 790 | 475 / 619 / 693 | 94 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.bundled.asar | 3 | 27735 |  | 521 / 597 / 829 | 475 / 534 / 684 | 82 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.minified.asar | 3 | 28115 |  | 758 / 2018 / 9123 | 484 / 1177 / 3676 | 92 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | holdout/time-tracker.plain.asar | 3 | 33671 |  | 698 / 847 / 1523 | 515 / 558 / 1351 | 112 | 10 |  | 54 / 34 / 0 |
| Q1 | hexvero | holdout/time-tracker.bundled.asar | 3 | 26182 |  | 584 / 815 / 887 | 458 / 484 / 729 | 96 | 10 |  | 64 / 32 / 0 |
| Q1 | hexvero | holdout/time-tracker.minified.asar | 3 | 26902 |  | 601 / 716 / 1316 | 443 / 507 / 712 | 105 | 10 |  | 64 / 32 / 0 |
| Q1 | rea (summary) | dev/notes-app.plain.asar | 2 | 11812 | 1052406 | 3841 / 5521 / 6968 | 3460 / 4459 / 5538 | 446 | 10 |  | counts only |
| Q1 | rea (summary) | dev/notes-app.bundled.asar | 2 | 11823 | 1246912 | 5410 / 7397 / 18133 | 5392 / 6118 / 12417 | 402 | 10 |  | counts only |
| Q1 | rea (summary) | dev/notes-app.minified.asar | 2 | 11828 | 1145530 | 6441 / 12860 / 38380 | 6023 / 14757 / 33508 | 348 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.plain.asar | 2 | 11850 | 3021423 | 5662 / 5818 / 10672 | 4987 / 6326 / 10925 | 418 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.bundled.asar | 2 | 11860 | 3139988 | 5443 / 5727 / 10074 | 4916 / 6043 / 6931 | 403 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.minified.asar | 2 | 11864 | 3062483 | 6820 / 23645 / 27805 | 6621 / 12738 / 25161 | 350 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.plain.asar | 2 | 11869 | 5684518 | 7245 / 10202 / 38082 | 6966 / 9182 / 27245 | 396 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.bundled.asar | 2 | 11876 | 6470270 | 7387 / 7930 / 15821 | 6336 / 10475 / 20811 | 403 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.minified.asar | 2 | 11881 | 6314924 | 6346 / 6678 / 15157 | 6074 / 6891 / 15226 | 431 | 10 |  | counts only |
| Q1 | rea (filtered) | dev/notes-app.plain.asar | 1 | 145836 |  | 2535 / 3665 / 5257 | 3385 / 3849 / 5853 | 428 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (filtered) | dev/notes-app.bundled.asar | 1 | 147867 |  | 3056 / 4044 / 9809 | 2401 / 3348 / 38401 | 454 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (filtered) | dev/notes-app.minified.asar | 1 | 138521 |  | 5913 / 12135 / 27466 | 4774 / 20504 / 40230 | 346 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (filtered) | validation/chat-app.plain.asar | 1 | 172661 |  | 3867 / 4447 / 5075 | 4089 / 4732 / 5603 | 419 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (filtered) | validation/chat-app.bundled.asar | 1 | 157139 |  | 4009 / 4208 / 4857 | 3672 / 3881 / 5055 | 417 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (filtered) | validation/chat-app.minified.asar | 1 | 146616 |  | 5486 / 6856 / 54157 | 4852 / 7136 / 29542 | 372 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (filtered) | holdout/time-tracker.plain.asar | 1 | 273480 |  | 5366 / 8633 / 11585 | 5565 / 10203 / 42980 | 384 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (filtered) | holdout/time-tracker.bundled.asar | 1 | 199739 |  | 4724 / 6635 / 14767 | 6062 / 6340 / 9632 | 409 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (filtered) | holdout/time-tracker.minified.asar | 1 | 176834 |  | 4499 / 5034 / 23427 | 4065 / 5084 / 17866 | 421 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (complete) | dev/notes-app.plain.asar | 1 | 1052406 |  | 2609 / 3875 / 4708 | 3287 / 4149 / 8838 | 433 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | dev/notes-app.bundled.asar | 1 | 1246912 |  | 2258 / 5255 / 17270 | 5097 / 8118 / 15347 | 464 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | dev/notes-app.minified.asar | 1 | 1145530 |  | 4949 / 12780 / 50289 | 5486 / 7256 / 18026 | 347 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | validation/chat-app.plain.asar | 1 | 3021423 |  | 3942 / 4520 / 5249 | 4464 / 5531 / 6072 | 429 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | validation/chat-app.bundled.asar | 1 | 3139988 |  | 3491 / 4984 / 15261 | 4133 / 4702 / 15355 | 429 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | validation/chat-app.minified.asar | 1 | 3062483 |  | 7542 / 12084 / 21170 | 5565 / 8793 / 35369 | 340 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 5684518 |  | 6659 / 17906 / 66583 | 5552 / 6481 / 20835 | 408 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 6470270 |  | 6935 / 18472 / 23958 | 5317 / 6507 / 8198 | 385 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 6314924 |  | 4983 / 5705 / 11205 | 5043 / 6195 / 10204 | 429 | 10 |  | 28 / 40 / 0 |
| Q2 | hexvero | dev/notes-app.plain.asar | 2 | 19784 |  | 256 / 286 / 399 | 260 / 280 / 300 | 79 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | dev/notes-app.bundled.asar | 2 | 18388 |  | 283 / 541 / 640 | 287 / 420 / 956 | 82 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | dev/notes-app.minified.asar | 2 | 18292 |  | 352 / 558 / 6531 | 368 / 525 / 12854 | 81 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.plain.asar | 2 | 25946 |  | 296 / 336 / 549 | 292 / 338 / 383 | 85 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.bundled.asar | 2 | 23839 |  | 299 / 315 / 451 | 278 / 348 / 493 | 80 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.minified.asar | 2 | 24224 |  | 363 / 448 / 1692 | 358 / 442 / 1344 | 83 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | holdout/time-tracker.plain.asar | 2 | 28443 |  | 301 / 343 / 1819 | 317 / 329 / 926 | 91 | 10 |  | 3 / 8 / 0 |
| Q2 | hexvero | holdout/time-tracker.bundled.asar | 2 | 21136 |  | 302 / 319 / 477 | 309 / 329 / 534 | 93 | 10 |  | 3 / 8 / 0 |
| Q2 | hexvero | holdout/time-tracker.minified.asar | 2 | 22272 |  | 288 / 349 / 699 | 306 / 328 / 580 | 95 | 10 |  | 6 / 5 / 0 |
| Q2 | rea (summary) | dev/notes-app.plain.asar | 2 | 11812 | 1052406 | 3841 / 5521 / 6968 | 3460 / 4459 / 5538 | 446 | 10 |  | counts only |
| Q2 | rea (summary) | dev/notes-app.bundled.asar | 2 | 11823 | 1246912 | 5410 / 7397 / 18133 | 5392 / 6118 / 12417 | 402 | 10 |  | counts only |
| Q2 | rea (summary) | dev/notes-app.minified.asar | 2 | 11828 | 1145530 | 6441 / 12860 / 38380 | 6023 / 14757 / 33508 | 348 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.plain.asar | 2 | 11850 | 3021423 | 5662 / 5818 / 10672 | 4987 / 6326 / 10925 | 418 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.bundled.asar | 2 | 11860 | 3139988 | 5443 / 5727 / 10074 | 4916 / 6043 / 6931 | 403 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.minified.asar | 2 | 11864 | 3062483 | 6820 / 23645 / 27805 | 6621 / 12738 / 25161 | 350 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.plain.asar | 2 | 11869 | 5684518 | 7245 / 10202 / 38082 | 6966 / 9182 / 27245 | 396 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.bundled.asar | 2 | 11876 | 6470270 | 7387 / 7930 / 15821 | 6336 / 10475 / 20811 | 403 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.minified.asar | 2 | 11881 | 6314924 | 6346 / 6678 / 15157 | 6074 / 6891 / 15226 | 431 | 10 |  | counts only |
| Q2 | rea (filtered) | dev/notes-app.plain.asar | 1 | 145836 |  | 2535 / 3665 / 5257 | 3385 / 3849 / 5853 | 428 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (filtered) | dev/notes-app.bundled.asar | 1 | 147867 |  | 3056 / 4044 / 9809 | 2401 / 3348 / 38401 | 454 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (filtered) | dev/notes-app.minified.asar | 1 | 138521 |  | 5913 / 12135 / 27466 | 4774 / 20504 / 40230 | 346 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (filtered) | validation/chat-app.plain.asar | 1 | 172661 |  | 3867 / 4447 / 5075 | 4089 / 4732 / 5603 | 419 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (filtered) | validation/chat-app.bundled.asar | 1 | 157139 |  | 4009 / 4208 / 4857 | 3672 / 3881 / 5055 | 417 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (filtered) | validation/chat-app.minified.asar | 1 | 146616 |  | 5486 / 6856 / 54157 | 4852 / 7136 / 29542 | 372 | 10 |  | 0 / 7 / 0 |
| Q2 | rea (filtered) | holdout/time-tracker.plain.asar | 1 | 273480 |  | 5366 / 8633 / 11585 | 5565 / 10203 / 42980 | 384 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (filtered) | holdout/time-tracker.bundled.asar | 1 | 199739 |  | 4724 / 6635 / 14767 | 6062 / 6340 / 9632 | 409 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (filtered) | holdout/time-tracker.minified.asar | 1 | 176834 |  | 4499 / 5034 / 23427 | 4065 / 5084 / 17866 | 421 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (complete) | dev/notes-app.plain.asar | 1 | 1052406 |  | 2609 / 3875 / 4708 | 3287 / 4149 / 8838 | 433 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (complete) | dev/notes-app.bundled.asar | 1 | 1246912 |  | 2258 / 5255 / 17270 | 5097 / 8118 / 15347 | 464 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (complete) | dev/notes-app.minified.asar | 1 | 1145530 |  | 4949 / 12780 / 50289 | 5486 / 7256 / 18026 | 347 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.plain.asar | 1 | 3021423 |  | 3942 / 4520 / 5249 | 4464 / 5531 / 6072 | 429 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.bundled.asar | 1 | 3139988 |  | 3491 / 4984 / 15261 | 4133 / 4702 / 15355 | 429 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.minified.asar | 1 | 3062483 |  | 7542 / 12084 / 21170 | 5565 / 8793 / 35369 | 340 | 10 |  | 0 / 7 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 5684518 |  | 6659 / 17906 / 66583 | 5552 / 6481 / 20835 | 408 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 6470270 |  | 6935 / 18472 / 23958 | 5317 / 6507 / 8198 | 385 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 6314924 |  | 4983 / 5705 / 11205 | 5043 / 6195 / 10204 | 429 | 10 |  | 0 / 11 / 0 |
| Q3 | hexvero | dev/notes-app.plain.asar | 3 | 22109 |  | 384 / 418 / 587 | 400 / 430 / 817 | 78 | 10 |  | 22 / 0 / 0 |
| Q3 | hexvero | dev/notes-app.bundled.asar | 3 | 20712 |  | 432 / 647 / 1380 | 479 / 597 / 801 | 81 | 10 |  | 22 / 0 / 0 |
| Q3 | hexvero | dev/notes-app.minified.asar | 3 | 20416 |  | 479 / 677 / 32698 | 665 / 1463 / 38433 | 80 | 10 |  | 20 / 1 / 0 |
| Q3 | hexvero | validation/chat-app.plain.asar | 3 | 32085 |  | 458 / 585 / 615 | 476 / 517 / 1052 | 83 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | validation/chat-app.bundled.asar | 3 | 29969 |  | 438 / 468 / 571 | 423 / 464 / 604 | 78 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | validation/chat-app.minified.asar | 3 | 30378 |  | 498 / 642 / 1392 | 580 / 655 / 1850 | 86 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | holdout/time-tracker.plain.asar | 3 | 37078 |  | 514 / 606 / 1840 | 508 / 621 / 1807 | 94 | 10 |  | 35 / 12 / 5 |
| Q3 | hexvero | holdout/time-tracker.bundled.asar | 3 | 29964 |  | 475 / 614 / 675 | 467 / 561 / 898 | 92 | 10 |  | 35 / 12 / 6 |
| Q3 | hexvero | holdout/time-tracker.minified.asar | 3 | 30740 |  | 478 / 549 / 581 | 500 / 523 / 605 | 82 | 10 |  | 35 / 12 / 6 |
| Q3 | rea (summary) | dev/notes-app.plain.asar | 2 | 11812 | 1052406 | 3841 / 5521 / 6968 | 3460 / 4459 / 5538 | 446 | 10 |  | counts only |
| Q3 | rea (summary) | dev/notes-app.bundled.asar | 2 | 11823 | 1246912 | 5410 / 7397 / 18133 | 5392 / 6118 / 12417 | 402 | 10 |  | counts only |
| Q3 | rea (summary) | dev/notes-app.minified.asar | 2 | 11828 | 1145530 | 6441 / 12860 / 38380 | 6023 / 14757 / 33508 | 348 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.plain.asar | 2 | 11850 | 3021423 | 5662 / 5818 / 10672 | 4987 / 6326 / 10925 | 418 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.bundled.asar | 2 | 11860 | 3139988 | 5443 / 5727 / 10074 | 4916 / 6043 / 6931 | 403 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.minified.asar | 2 | 11864 | 3062483 | 6820 / 23645 / 27805 | 6621 / 12738 / 25161 | 350 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.plain.asar | 2 | 11869 | 5684518 | 7245 / 10202 / 38082 | 6966 / 9182 / 27245 | 396 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.bundled.asar | 2 | 11876 | 6470270 | 7387 / 7930 / 15821 | 6336 / 10475 / 20811 | 403 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.minified.asar | 2 | 11881 | 6314924 | 6346 / 6678 / 15157 | 6074 / 6891 / 15226 | 431 | 10 |  | counts only |
| Q3 | rea (filtered) | dev/notes-app.plain.asar | 1 | 145836 |  | 2535 / 3665 / 5257 | 3385 / 3849 / 5853 | 428 | 10 |  | 13 / 5 / 3 |
| Q3 | rea (filtered) | dev/notes-app.bundled.asar | 1 | 147867 |  | 3056 / 4044 / 9809 | 2401 / 3348 / 38401 | 454 | 10 |  | 13 / 5 / 3 |
| Q3 | rea (filtered) | dev/notes-app.minified.asar | 1 | 138521 |  | 5913 / 12135 / 27466 | 4774 / 20504 / 40230 | 346 | 10 |  | 13 / 5 / 3 |
| Q3 | rea (filtered) | validation/chat-app.plain.asar | 1 | 172661 |  | 3867 / 4447 / 5075 | 4089 / 4732 / 5603 | 419 | 10 |  | 13 / 15 / 6 |
| Q3 | rea (filtered) | validation/chat-app.bundled.asar | 1 | 157139 |  | 4009 / 4208 / 4857 | 3672 / 3881 / 5055 | 417 | 10 |  | 13 / 15 / 6 |
| Q3 | rea (filtered) | validation/chat-app.minified.asar | 1 | 146616 |  | 5486 / 6856 / 54157 | 4852 / 7136 / 29542 | 372 | 10 |  | 13 / 15 / 6 |
| Q3 | rea (filtered) | holdout/time-tracker.plain.asar | 1 | 273480 |  | 5366 / 8633 / 11585 | 5565 / 10203 / 42980 | 384 | 10 |  | 9 / 27 / 10 |
| Q3 | rea (filtered) | holdout/time-tracker.bundled.asar | 1 | 199739 |  | 4724 / 6635 / 14767 | 6062 / 6340 / 9632 | 409 | 10 |  | 9 / 27 / 10 |
| Q3 | rea (filtered) | holdout/time-tracker.minified.asar | 1 | 176834 |  | 4499 / 5034 / 23427 | 4065 / 5084 / 17866 | 421 | 10 |  | 9 / 27 / 10 |
| Q3 | rea (complete) | dev/notes-app.plain.asar | 1 | 1052406 |  | 2609 / 3875 / 4708 | 3287 / 4149 / 8838 | 433 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (complete) | dev/notes-app.bundled.asar | 1 | 1246912 |  | 2258 / 5255 / 17270 | 5097 / 8118 / 15347 | 464 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (complete) | dev/notes-app.minified.asar | 1 | 1145530 |  | 4949 / 12780 / 50289 | 5486 / 7256 / 18026 | 347 | 10 |  | 13 / 6 / 3 |
| Q3 | rea (complete) | validation/chat-app.plain.asar | 1 | 3021423 |  | 3942 / 4520 / 5249 | 4464 / 5531 / 6072 | 429 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (complete) | validation/chat-app.bundled.asar | 1 | 3139988 |  | 3491 / 4984 / 15261 | 4133 / 4702 / 15355 | 429 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (complete) | validation/chat-app.minified.asar | 1 | 3062483 |  | 7542 / 12084 / 21170 | 5565 / 8793 / 35369 | 340 | 10 |  | 13 / 17 / 6 |
| Q3 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 5684518 |  | 6659 / 17906 / 66583 | 5552 / 6481 / 20835 | 408 | 10 |  | 10 / 27 / 18 |
| Q3 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 6470270 |  | 6935 / 18472 / 23958 | 5317 / 6507 / 8198 | 385 | 10 |  | 10 / 27 / 18 |
| Q3 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 6314924 |  | 4983 / 5705 / 11205 | 5043 / 6195 / 10204 | 429 | 10 |  | 10 / 27 / 10 |
| Q4 | hexvero | dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64 | 2 | 1805 |  | 240 / 263 / 375 | 240 / 262 / 434 | 77 | 10 |  | 3 / 0 / 0 |
| Q4 | hexvero | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | 5 | 7155 |  | 786 / 1029 / 1099 | 739 / 849 / 876 | 81 | 10 |  | 11 / 0 / 0 |
| Q4 | hexvero | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | 5 | 11651 |  | 1082 / 1149 / 1368 | 784 / 994 / 1394 | 92 | 10 |  | 15 / 0 / 0 |
| Q4 | hexvero | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | 5 | 12161 |  | 933 / 1185 / 1451 | 815 / 1112 / 1711 | 112 | 10 |  | 7 / 11 / 2 |
| Q4 | rea (complete) | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | 3 | 666796 | 2111608 | 8333 / 11427 / 13717 | 8416 / 9601 / 20079 | 425 | 10 |  | 9 / 2 / 0 |
| Q4 | rea (complete) | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | 3 | 868042 | 6040037 | 10416 / 13419 / 36878 | 11475 / 15117 / 17629 | 416 | 10 |  | 7 / 8 / 2 |
| Q4 | rea (complete) | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | 3 | 1410140 | 11356120 | 14389 / 16798 / 30724 | 14146 / 18983 / 29695 | 420 | 10 |  | 0 / 18 / 1 |
| Q5 | hexvero (radare2) | dev/calls.O0.macho-arm64 (radare2) | 4 | 1760 |  | 872 / 979 / 1489 | 794 / 851 / 1811 | 92 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (radare2) | dev/calls.O2.macho-arm64 (radare2) | 4 | 1760 |  | 958 / 1081 / 2439 | 724 / 953 / 2015 | 93 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (radare2) | validation/dispatch.O0.macho-arm64 (radare2) | 13 | 5661 |  | 2993 / 4360 / 5407 | 2800 / 3805 / 6280 | 92 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (radare2) | validation/dispatch.O2.macho-arm64 (radare2) | 13 | 5652 |  | 2444 / 3116 / 4531 | 2598 / 2959 / 3469 | 92 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (radare2) | holdout/exprcalc.O0.macho-arm64 (radare2) | 18 | 7888 |  | 3921 / 5562 / 11840 | 3679 / 6488 / 11187 | 95 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (radare2) | holdout/exprcalc.O2.macho-arm64 (radare2) | 18 | 7874 |  | 3340 / 3806 / 3949 | 3192 / 3524 / 3776 | 92 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (rizin) | dev/calls.O0.macho-arm64 (rizin) | 4 | 1818 |  | 982 / 1033 / 1413 | 941 / 1074 / 1515 | 96 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (rizin) | dev/calls.O2.macho-arm64 (rizin) | 4 | 1818 |  | 773 / 869 / 1173 | 670 / 755 / 1012 | 96 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (rizin) | validation/dispatch.O0.macho-arm64 (rizin) | 13 | 5797 |  | 2967 / 3725 / 4150 | 2741 / 3180 / 3381 | 97 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (rizin) | validation/dispatch.O2.macho-arm64 (rizin) | 13 | 5788 |  | 2498 / 2818 / 3250 | 2457 / 2742 / 3272 | 94 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (rizin) | holdout/exprcalc.O0.macho-arm64 (rizin) | 18 | 8023 |  | 5035 / 6297 / 8172 | 3976 / 6838 / 11042 | 92 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (rizin) | holdout/exprcalc.O2.macho-arm64 (rizin) | 18 | 7422 |  | 3633 / 3713 / 4772 | 3266 / 3914 / 5022 | 96 | 10 | 10 | 16 / 2 / 0 |

## MCP

| question | tool (way) | unit | calls | bytes returned | bytes to side files | cold ms min / median / max | warm ms min / median / max | peak tree RSS MiB | runs | failed | answer hit / missed / false |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | hexvero | dev/notes-app.plain.asar | 4 | 14004 |  | 277 / 316 / 377 | 167 / 186 / 323 | 89 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | dev/notes-app.bundled.asar | 4 | 13214 |  | 304 / 318 / 400 | 168 / 193 / 199 | 93 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | dev/notes-app.minified.asar | 4 | 13123 |  | 293 / 323 / 383 | 173 / 177 / 209 | 82 | 10 |  | 29 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.plain.asar | 4 | 19555 |  | 364 / 448 / 947 | 250 / 322 / 349 | 104 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.bundled.asar | 4 | 18290 |  | 371 / 485 / 555 | 207 / 258 / 279 | 111 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | validation/chat-app.minified.asar | 4 | 18506 |  | 277 / 290 / 568 | 178 / 181 / 407 | 92 | 10 |  | 78 / 0 / 0 |
| Q1 | hexvero | holdout/time-tracker.plain.asar | 4 | 21845 |  | 329 / 349 / 375 | 194 / 207 / 324 | 92 | 10 |  | 54 / 34 / 0 |
| Q1 | hexvero | holdout/time-tracker.bundled.asar | 4 | 17590 |  | 300 / 325 / 352 | 184 / 191 / 285 | 86 | 10 |  | 64 / 32 / 0 |
| Q1 | hexvero | holdout/time-tracker.minified.asar | 4 | 17987 |  | 290 / 312 / 326 | 183 / 192 / 198 | 86 | 10 |  | 64 / 32 / 0 |
| Q1 | rea (summary) | dev/notes-app.plain.asar | 1 | 24234 |  | 3604 / 4200 / 4677 | 3269 / 3728 / 4674 | 482 | 10 |  | counts only |
| Q1 | rea (summary) | dev/notes-app.bundled.asar | 1 | 24256 |  | 3760 / 4401 / 8860 | 3937 / 5081 / 5821 | 463 | 10 |  | counts only |
| Q1 | rea (summary) | dev/notes-app.minified.asar | 1 | 24266 |  | 3496 / 3883 / 5060 | 3378 / 4447 / 7794 | 477 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.plain.asar | 1 | 24310 |  | 5860 / 6710 / 10418 | 5247 / 5940 / 9506 | 430 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.bundled.asar | 1 | 24330 |  | 4196 / 5662 / 15007 | 3936 / 5346 / 6294 | 451 | 10 |  | counts only |
| Q1 | rea (summary) | validation/chat-app.minified.asar | 1 | 24338 |  | 4114 / 4704 / 5074 | 3730 / 4643 / 9795 | 475 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.plain.asar | 1 | 24348 |  | 4236 / 5697 / 6994 | 4458 / 5159 / 7943 | 453 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.bundled.asar | 1 | 24362 |  | 4682 / 5202 / 6329 | 4249 / 4325 / 8345 | 467 | 10 |  | counts only |
| Q1 | rea (summary) | holdout/time-tracker.minified.asar | 1 | 24372 |  | 4271 / 4887 / 5831 | 4795 / 5060 / 6402 | 501 | 10 |  | counts only |
| Q1 | rea (complete) | dev/notes-app.plain.asar | 1 | 2205117 |  | 3271 / 3648 / 4206 | 3377 / 4415 / 4527 | 466 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | dev/notes-app.bundled.asar | 1 | 2612591 |  | 3070 / 4125 / 4494 | 3771 / 4162 / 4694 | 479 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | dev/notes-app.minified.asar | 1 | 2400503 |  | 4140 / 4391 / 7160 | 3474 / 5921 / 12736 | 449 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (complete) | validation/chat-app.plain.asar | 1 | 6330850 |  | 4481 / 6198 / 7258 | 5597 / 6236 / 12277 | 454 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | validation/chat-app.bundled.asar | 1 | 6579496 |  | 4772 / 5419 / 7996 | 5233 / 6340 / 8047 | 421 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | validation/chat-app.minified.asar | 1 | 6417426 |  | 4414 / 4991 / 5225 | 4598 / 5154 / 6418 | 436 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 1594 |  | 4695 / 5679 / 7937 | 5187 / 6296 / 10985 | 463 | 10 | 10 | 0 / 47 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 1594 |  | 4572 / 5001 / 6198 | 4223 / 5175 / 5903 | 479 | 10 | 10 | 0 / 47 / 0 |
| Q1 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 1594 |  | 4722 / 6003 / 6282 | 4333 / 5132 / 8787 | 481 | 10 | 10 | 0 / 47 / 0 |
| Q1 | rea (export) | dev/notes-app.plain.asar | 2 | 24742 | 1064619 | 2207 / 3269 / 5283 | 2289 / 2866 / 4861 | 476 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (export) | dev/notes-app.bundled.asar | 2 | 24768 | 1259136 | 2934 / 3676 / 3860 | 3771 / 3929 / 4694 | 467 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (export) | dev/notes-app.minified.asar | 2 | 24780 | 1157759 | 2821 / 3752 / 3902 | 3075 / 4100 / 5141 | 494 | 10 |  | 17 / 3 / 0 |
| Q1 | rea (export) | validation/chat-app.plain.asar | 2 | 24830 | 3033674 | 2616 / 3222 / 3424 | 2549 / 2723 / 3053 | 503 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (export) | validation/chat-app.bundled.asar | 2 | 24854 | 3152249 | 2819 / 3899 / 4181 | 3611 / 3765 / 3916 | 480 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (export) | validation/chat-app.minified.asar | 2 | 24864 | 3074748 | 3601 / 3702 / 3779 | 3462 / 3826 / 4181 | 475 | 10 |  | 38 / 18 / 0 |
| Q1 | rea (export) | holdout/time-tracker.plain.asar | 2 | 24870 | 5696788 | 4203 / 4851 / 5085 | 4242 / 4498 / 5011 | 494 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (export) | holdout/time-tracker.bundled.asar | 2 | 24888 | 6482547 | 4215 / 4802 / 6527 | 3989 / 4333 / 8717 | 508 | 10 |  | 28 / 40 / 0 |
| Q1 | rea (export) | holdout/time-tracker.minified.asar | 2 | 24900 | 6327206 | 4117 / 4526 / 5053 | 4167 / 4218 / 4418 | 501 | 10 |  | 28 / 40 / 0 |
| Q2 | hexvero | dev/notes-app.plain.asar | 3 | 13257 |  | 169 / 187 / 198 | 173 / 183 / 252 | 88 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | dev/notes-app.bundled.asar | 3 | 12465 |  | 175 / 208 / 271 | 184 / 197 / 244 | 98 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | dev/notes-app.minified.asar | 3 | 12373 |  | 168 / 174 / 199 | 166 / 174 / 191 | 94 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.plain.asar | 3 | 16777 |  | 271 / 283 / 414 | 221 / 235 / 286 | 93 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.bundled.asar | 3 | 15512 |  | 195 / 216 / 438 | 183 / 200 / 787 | 103 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | validation/chat-app.minified.asar | 3 | 15734 |  | 183 / 191 / 278 | 181 / 188 / 528 | 86 | 10 |  | 7 / 0 / 0 |
| Q2 | hexvero | holdout/time-tracker.plain.asar | 3 | 17950 |  | 187 / 211 / 315 | 193 / 206 / 270 | 99 | 10 |  | 3 / 8 / 0 |
| Q2 | hexvero | holdout/time-tracker.bundled.asar | 3 | 13890 |  | 188 / 201 / 271 | 183 / 195 / 197 | 99 | 10 |  | 3 / 8 / 0 |
| Q2 | hexvero | holdout/time-tracker.minified.asar | 3 | 14597 |  | 183 / 199 / 216 | 183 / 197 / 387 | 100 | 10 |  | 6 / 5 / 0 |
| Q2 | rea (summary) | dev/notes-app.plain.asar | 1 | 24234 |  | 3604 / 4200 / 4677 | 3269 / 3728 / 4674 | 482 | 10 |  | counts only |
| Q2 | rea (summary) | dev/notes-app.bundled.asar | 1 | 24256 |  | 3760 / 4401 / 8860 | 3937 / 5081 / 5821 | 463 | 10 |  | counts only |
| Q2 | rea (summary) | dev/notes-app.minified.asar | 1 | 24266 |  | 3496 / 3883 / 5060 | 3378 / 4447 / 7794 | 477 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.plain.asar | 1 | 24310 |  | 5860 / 6710 / 10418 | 5247 / 5940 / 9506 | 430 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.bundled.asar | 1 | 24330 |  | 4196 / 5662 / 15007 | 3936 / 5346 / 6294 | 451 | 10 |  | counts only |
| Q2 | rea (summary) | validation/chat-app.minified.asar | 1 | 24338 |  | 4114 / 4704 / 5074 | 3730 / 4643 / 9795 | 475 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.plain.asar | 1 | 24348 |  | 4236 / 5697 / 6994 | 4458 / 5159 / 7943 | 453 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.bundled.asar | 1 | 24362 |  | 4682 / 5202 / 6329 | 4249 / 4325 / 8345 | 467 | 10 |  | counts only |
| Q2 | rea (summary) | holdout/time-tracker.minified.asar | 1 | 24372 |  | 4271 / 4887 / 5831 | 4795 / 5060 / 6402 | 501 | 10 |  | counts only |
| Q2 | rea (complete) | dev/notes-app.plain.asar | 1 | 2205117 |  | 3271 / 3648 / 4206 | 3377 / 4415 / 4527 | 466 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (complete) | dev/notes-app.bundled.asar | 1 | 2612591 |  | 3070 / 4125 / 4494 | 3771 / 4162 / 4694 | 479 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (complete) | dev/notes-app.minified.asar | 1 | 2400503 |  | 4140 / 4391 / 7160 | 3474 / 5921 / 12736 | 449 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.plain.asar | 1 | 6330850 |  | 4481 / 6198 / 7258 | 5597 / 6236 / 12277 | 454 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.bundled.asar | 1 | 6579496 |  | 4772 / 5419 / 7996 | 5233 / 6340 / 8047 | 421 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (complete) | validation/chat-app.minified.asar | 1 | 6417426 |  | 4414 / 4991 / 5225 | 4598 / 5154 / 6418 | 436 | 10 |  | 0 / 7 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 1594 |  | 4695 / 5679 / 7937 | 5187 / 6296 / 10985 | 463 | 10 | 10 | 0 / 11 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 1594 |  | 4572 / 5001 / 6198 | 4223 / 5175 / 5903 | 479 | 10 | 10 | 0 / 11 / 0 |
| Q2 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 1594 |  | 4722 / 6003 / 6282 | 4333 / 5132 / 8787 | 481 | 10 | 10 | 0 / 11 / 0 |
| Q2 | rea (export) | dev/notes-app.plain.asar | 2 | 24742 | 1064619 | 2207 / 3269 / 5283 | 2289 / 2866 / 4861 | 476 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (export) | dev/notes-app.bundled.asar | 2 | 24768 | 1259136 | 2934 / 3676 / 3860 | 3771 / 3929 / 4694 | 467 | 10 |  | 4 / 3 / 0 |
| Q2 | rea (export) | dev/notes-app.minified.asar | 2 | 24780 | 1157759 | 2821 / 3752 / 3902 | 3075 / 4100 / 5141 | 494 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (export) | validation/chat-app.plain.asar | 2 | 24830 | 3033674 | 2616 / 3222 / 3424 | 2549 / 2723 / 3053 | 503 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (export) | validation/chat-app.bundled.asar | 2 | 24854 | 3152249 | 2819 / 3899 / 4181 | 3611 / 3765 / 3916 | 480 | 10 |  | 1 / 6 / 0 |
| Q2 | rea (export) | validation/chat-app.minified.asar | 2 | 24864 | 3074748 | 3601 / 3702 / 3779 | 3462 / 3826 / 4181 | 475 | 10 |  | 0 / 7 / 0 |
| Q2 | rea (export) | holdout/time-tracker.plain.asar | 2 | 24870 | 5696788 | 4203 / 4851 / 5085 | 4242 / 4498 / 5011 | 494 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (export) | holdout/time-tracker.bundled.asar | 2 | 24888 | 6482547 | 4215 / 4802 / 6527 | 3989 / 4333 / 8717 | 508 | 10 |  | 0 / 11 / 0 |
| Q2 | rea (export) | holdout/time-tracker.minified.asar | 2 | 24900 | 6327206 | 4117 / 4526 / 5053 | 4167 / 4218 / 4418 | 501 | 10 |  | 0 / 11 / 0 |
| Q3 | hexvero | dev/notes-app.plain.asar | 4 | 15152 |  | 171 / 175 / 231 | 172 / 179 / 193 | 90 | 10 |  | 22 / 0 / 0 |
| Q3 | hexvero | dev/notes-app.bundled.asar | 4 | 14359 |  | 200 / 207 / 224 | 187 / 197 / 215 | 99 | 10 |  | 22 / 0 / 0 |
| Q3 | hexvero | dev/notes-app.minified.asar | 4 | 14115 |  | 175 / 185 / 193 | 188 / 190 / 222 | 84 | 10 |  | 20 / 1 / 0 |
| Q3 | hexvero | validation/chat-app.plain.asar | 4 | 21672 |  | 208 / 222 / 288 | 223 / 254 / 403 | 99 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | validation/chat-app.bundled.asar | 4 | 20398 |  | 182 / 187 / 728 | 200 / 275 / 711 | 104 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | validation/chat-app.minified.asar | 4 | 20644 |  | 174 / 183 / 201 | 174 / 195 / 229 | 83 | 10 |  | 37 / 0 / 0 |
| Q3 | hexvero | holdout/time-tracker.plain.asar | 4 | 24739 |  | 181 / 200 / 224 | 184 / 199 / 264 | 83 | 10 |  | 35 / 12 / 5 |
| Q3 | hexvero | holdout/time-tracker.bundled.asar | 4 | 20828 |  | 194 / 199 / 231 | 192 / 206 / 212 | 99 | 10 |  | 35 / 12 / 6 |
| Q3 | hexvero | holdout/time-tracker.minified.asar | 4 | 21281 |  | 181 / 189 / 248 | 187 / 196 / 223 | 93 | 10 |  | 35 / 12 / 6 |
| Q3 | rea (summary) | dev/notes-app.plain.asar | 1 | 24234 |  | 3604 / 4200 / 4677 | 3269 / 3728 / 4674 | 482 | 10 |  | counts only |
| Q3 | rea (summary) | dev/notes-app.bundled.asar | 1 | 24256 |  | 3760 / 4401 / 8860 | 3937 / 5081 / 5821 | 463 | 10 |  | counts only |
| Q3 | rea (summary) | dev/notes-app.minified.asar | 1 | 24266 |  | 3496 / 3883 / 5060 | 3378 / 4447 / 7794 | 477 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.plain.asar | 1 | 24310 |  | 5860 / 6710 / 10418 | 5247 / 5940 / 9506 | 430 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.bundled.asar | 1 | 24330 |  | 4196 / 5662 / 15007 | 3936 / 5346 / 6294 | 451 | 10 |  | counts only |
| Q3 | rea (summary) | validation/chat-app.minified.asar | 1 | 24338 |  | 4114 / 4704 / 5074 | 3730 / 4643 / 9795 | 475 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.plain.asar | 1 | 24348 |  | 4236 / 5697 / 6994 | 4458 / 5159 / 7943 | 453 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.bundled.asar | 1 | 24362 |  | 4682 / 5202 / 6329 | 4249 / 4325 / 8345 | 467 | 10 |  | counts only |
| Q3 | rea (summary) | holdout/time-tracker.minified.asar | 1 | 24372 |  | 4271 / 4887 / 5831 | 4795 / 5060 / 6402 | 501 | 10 |  | counts only |
| Q3 | rea (complete) | dev/notes-app.plain.asar | 1 | 2205117 |  | 3271 / 3648 / 4206 | 3377 / 4415 / 4527 | 466 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (complete) | dev/notes-app.bundled.asar | 1 | 2612591 |  | 3070 / 4125 / 4494 | 3771 / 4162 / 4694 | 479 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (complete) | dev/notes-app.minified.asar | 1 | 2400503 |  | 4140 / 4391 / 7160 | 3474 / 5921 / 12736 | 449 | 10 |  | 13 / 6 / 3 |
| Q3 | rea (complete) | validation/chat-app.plain.asar | 1 | 6330850 |  | 4481 / 6198 / 7258 | 5597 / 6236 / 12277 | 454 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (complete) | validation/chat-app.bundled.asar | 1 | 6579496 |  | 4772 / 5419 / 7996 | 5233 / 6340 / 8047 | 421 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (complete) | validation/chat-app.minified.asar | 1 | 6417426 |  | 4414 / 4991 / 5225 | 4598 / 5154 / 6418 | 436 | 10 |  | 13 / 17 / 6 |
| Q3 | rea (complete) | holdout/time-tracker.plain.asar | 1 | 1594 |  | 4695 / 5679 / 7937 | 5187 / 6296 / 10985 | 463 | 10 | 10 | 0 / 32 / 0 |
| Q3 | rea (complete) | holdout/time-tracker.bundled.asar | 1 | 1594 |  | 4572 / 5001 / 6198 | 4223 / 5175 / 5903 | 479 | 10 | 10 | 0 / 32 / 0 |
| Q3 | rea (complete) | holdout/time-tracker.minified.asar | 1 | 1594 |  | 4722 / 6003 / 6282 | 4333 / 5132 / 8787 | 481 | 10 | 10 | 0 / 32 / 0 |
| Q3 | rea (export) | dev/notes-app.plain.asar | 2 | 24742 | 1064619 | 2207 / 3269 / 5283 | 2289 / 2866 / 4861 | 476 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (export) | dev/notes-app.bundled.asar | 2 | 24768 | 1259136 | 2934 / 3676 / 3860 | 3771 / 3929 / 4694 | 467 | 10 |  | 14 / 5 / 4 |
| Q3 | rea (export) | dev/notes-app.minified.asar | 2 | 24780 | 1157759 | 2821 / 3752 / 3902 | 3075 / 4100 / 5141 | 494 | 10 |  | 13 / 6 / 3 |
| Q3 | rea (export) | validation/chat-app.plain.asar | 2 | 24830 | 3033674 | 2616 / 3222 / 3424 | 2549 / 2723 / 3053 | 503 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (export) | validation/chat-app.bundled.asar | 2 | 24854 | 3152249 | 2819 / 3899 / 4181 | 3611 / 3765 / 3916 | 480 | 10 |  | 15 / 15 / 8 |
| Q3 | rea (export) | validation/chat-app.minified.asar | 2 | 24864 | 3074748 | 3601 / 3702 / 3779 | 3462 / 3826 / 4181 | 475 | 10 |  | 13 / 17 / 6 |
| Q3 | rea (export) | holdout/time-tracker.plain.asar | 2 | 24870 | 5696788 | 4203 / 4851 / 5085 | 4242 / 4498 / 5011 | 494 | 10 |  | 10 / 27 / 18 |
| Q3 | rea (export) | holdout/time-tracker.bundled.asar | 2 | 24888 | 6482547 | 4215 / 4802 / 6527 | 3989 / 4333 / 8717 | 508 | 10 |  | 10 / 27 / 18 |
| Q3 | rea (export) | holdout/time-tracker.minified.asar | 2 | 24900 | 6327206 | 4117 / 4526 / 5053 | 4167 / 4218 / 4418 | 501 | 10 |  | 10 / 27 / 10 |
| Q4 | hexvero | dev/calls.O2.macho-arm64 → dev/calls-v2.O2.macho-arm64 | 4 | 2349 |  | 168 / 178 / 321 | 163 / 177 / 220 | 89 | 10 |  | 3 / 0 / 0 |
| Q4 | hexvero | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | 7 | 6149 |  | 252 / 312 / 618 | 177 / 251 / 288 | 107 | 10 |  | 11 / 0 / 0 |
| Q4 | hexvero | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | 7 | 6482 |  | 336 / 340 / 1370 | 199 / 227 / 322 | 124 | 10 |  | 15 / 0 / 0 |
| Q4 | hexvero | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | 7 | 6412 |  | 287 / 297 / 324 | 188 / 200 / 209 | 134 | 10 |  | 7 / 11 / 2 |
| Q4 | rea (summary) | dev/notes-app.plain.asar → dev/notes-app-v2.plain.asar | 3 | 1443202 |  | 4965 / 5179 / 9675 | 4998 / 6056 / 14531 | 462 | 10 |  | 9 / 2 / 0 |
| Q4 | rea (summary) | validation/chat-app.plain.asar → validation/chat-app-v2.plain.asar | 3 | 1865386 |  | 6520 / 7263 / 7364 | 5721 / 6221 / 7688 | 469 | 10 |  | 7 / 8 / 2 |
| Q4 | rea (summary) | holdout/time-tracker.plain.asar → holdout/time-tracker-v2.plain.asar | 3 | 2998028 |  | 5771 / 6337 / 6746 | 5614 / 5925 / 6646 | 513 | 10 |  | 0 / 18 / 1 |
| Q5 | hexvero (radare2) | dev/calls.O0.macho-arm64 (radare2) | 5 | 1994 |  | 415 / 439 / 1944 | 305 / 331 / 339 | 95 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (radare2) | dev/calls.O2.macho-arm64 (radare2) | 5 | 1994 |  | 358 / 446 / 650 | 307 / 339 / 387 | 95 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (radare2) | validation/dispatch.O0.macho-arm64 (radare2) | 14 | 5726 |  | 728 / 759 / 999 | 669 / 685 / 711 | 97 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (radare2) | validation/dispatch.O2.macho-arm64 (radare2) | 14 | 5717 |  | 717 / 759 / 853 | 655 / 706 / 753 | 96 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (radare2) | holdout/exprcalc.O0.macho-arm64 (radare2) | 19 | 7891 |  | 933 / 1052 / 1206 | 918 / 936 / 1043 | 96 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (radare2) | holdout/exprcalc.O2.macho-arm64 (radare2) | 19 | 7877 |  | 916 / 1015 / 1037 | 873 / 897 / 932 | 96 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (rizin) | dev/calls.O0.macho-arm64 (rizin) | 5 | 2037 |  | 357 / 397 / 405 | 296 / 314 / 327 | 95 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (rizin) | dev/calls.O2.macho-arm64 (rizin) | 5 | 2037 |  | 352 / 383 / 475 | 307 / 339 / 468 | 95 | 10 |  | 4 / 0 / 0 |
| Q5 | hexvero (rizin) | validation/dispatch.O0.macho-arm64 (rizin) | 14 | 5827 |  | 720 / 758 / 896 | 663 / 697 / 783 | 97 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (rizin) | validation/dispatch.O2.macho-arm64 (rizin) | 14 | 5818 |  | 735 / 790 / 947 | 724 / 769 / 922 | 99 | 10 |  | 13 / 0 / 0 |
| Q5 | hexvero (rizin) | holdout/exprcalc.O0.macho-arm64 (rizin) | 19 | 7991 |  | 935 / 1004 / 1186 | 879 / 933 / 1004 | 100 | 10 |  | 18 / 0 / 0 |
| Q5 | hexvero (rizin) | holdout/exprcalc.O2.macho-arm64 (rizin) | 19 | 7488 |  | 931 / 939 / 1114 | 854 / 885 / 894 | 99 | 10 | 10 | 16 / 2 / 0 |
