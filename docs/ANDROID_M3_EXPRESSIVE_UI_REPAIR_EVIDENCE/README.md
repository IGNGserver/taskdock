# Android M3 Expressive repair evidence

These are after-change screenshots captured by the native Compose instrumentation suite with isolated test data. The fixture contains the seven folders and root task from the repair brief; the planner fixture includes today, a future date with a task, an older empty date, and the `Launch review` event.

## Screenshots

- Root set: 320×640, 160 dpi, font scale 1.0. Includes dark and light settings and planner screens, the folder directory, all-task search, and task detail.
- [`font-200/`](font-200/): the same screen suite at Android font scale 2.0. Create actions move out of the floating overlay so they do not cover large task text.
- [`landscape-640x320/`](landscape-640x320/): the same suite in a 640×320 viewport at font scale 1.0. Short viewports use inline create actions to keep the search/filter area clear.

## Verification

- `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `:app:lintDebug`, `:app:assembleDebug`, and `:app:assembleDebugAndroidTest` passed.
- `WorkspaceScreenTest`: 6/6 passed at 320×640, font scale 1.0; 6/6 at 320×640, font scale 2.0; and 6/6 at 640×320, font scale 1.0.
- The planner unit tests cover display grouping, rank order within a date, and time-zone-safe calendar-date formatting.

## Limits

The only available running device was an Android 11 / API 30 emulator. Android dynamic color requires Android 12 or later, so these images use the app's static light/dark palettes. The screenshots are not a same-physical-device before/after pair. A physical-device run, TalkBack review, animation-scale review, and interaction recording remain unverified.
