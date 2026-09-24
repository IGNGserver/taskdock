# Round 1 visual and interaction review

## Confirmed strengths

- The app-level navigation test confirms the directory is the launch destination, the four smart views are ahead of directory rows, the phone bottom dock is gone, Settings opens from the header, and smart views return to the directory. Folder → task detail → folder → root navigation also passes in `appStartsInDirectoryAndSmartViewsReturnToIt`.
- The home information structure follows the concept: title/search/settings, a compact grouped set of four smart views, then the directory heading and mixed folder/task rows. Folder and task names/counts come from fixture data; the design does not add the concept art's unsupported progress percentage or tags.
- The populated folder view has readable status grouping and direct completion controls. All Tasks exposes search and status filters. Today and Workflow empty states explain the next action.
- The stable real-Activity light screenshot shows one continuous app surface under the status bar and behind the gesture handle. The task-detail device screenshot shows the system IME and its own navigation area; app fields stay above the keyboard. Header controls appear below the status safe area.

## Changes requested

### P1 — Keep screenshot fixtures from covering the screen with an offline snackbar

`compose-captures/ui-evidence/app-directory.png`, `app-today.png`, `app-schedule.png`, and `app-all-tasks.png` show the message “暂时无法恢复中枢连接，登录状态已保留” across the lower screen. It covers directory rows and the page-level action in several captures, so the visual comparison cannot judge those areas reliably. The fixture in `WorkspaceScreenTest.kt` sets a refresh token and `http://127.0.0.1:1`; `TaskDockApp.kt:69,85-89` displays the resulting message through the shared snackbar host.

Make the navigation fixture deterministic without a real Hub: suppress or settle the expected offline restore notice before each screenshot, while retaining a separate check that offline data remains visible. If the same notice can recur in normal offline use, keep it from covering the primary action and list rows.

### P2 — Move the folder create action clear of visible task rows

In `compose-captures/ui-evidence/app-folder.png`, the expanded “新建任务” FAB obscures the title/body of a visible task row around “IGNG站点待办 9”. This is the folder screen at its initial scroll position. `TreeScreen.kt:204-244` anchors the FAB over the scrolling list and adds 120 dp of bottom padding; that padding may make the final row reachable after scrolling, but it does not prevent the current row from being covered. Keep the create action outside the row hit/reading area, for example by using an in-flow action or reducing/hiding the FAB while the list is being read. Verify the final row at maximum scroll after the adjustment.

### P2 — Recheck status glyph contrast on a cold launch

The first full-device capture, `device-main-activity-login.png`, shows very light status glyphs over the light login surface. The later capture, `device-main-activity-login-recheck.png`, shows dark glyphs on the same surface. The steady state is legible and the edge surface is continuous; the startup transition needs one more fresh-launch check to determine whether the first sample caught an appearance update delay. Relevant ownership is `MainActivity.kt:27-43` (`enableEdgeToEdge`) and `Theme.kt:158-174` (status-bar appearance).

## Test evidence / harness issues

- Full class: `WorkspaceScreenTest` ran on API 35; 5/8 passed, 3/8 failed. `directoryDrillDownAndSearchKeepTaskReachable` and `settingsChoicesRemainSelectableInGroupedLayout` fail inside `screenshot()` with `Failed waiting for PixelCopy!` (`WorkspaceScreenTest.kt:191`, calls at lines 224 and 373). These failures prevent those cases from reaching their subsequent interaction assertions on this headless emulator.
- `shortcutViewsHaveBackActionsAndDistinctScreens` fails at its second `compose.setContent` call with `IllegalStateException: Cannot call setContent twice per test!` (`WorkspaceScreenTest.kt:256`). Split these screens into separate tests or keep one content tree and switch the screen under test.
- The focused app navigation test passes 1/1 on API 35, twice. `navigation-test.log` and `device-screen-test.log` record the successful runs. `full-class-results.xml`, `full-class-runner.log`, and `full-class-report.html` preserve the full-class failures.

## Page-by-page comparison

| Screen         | Round 1 result                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory home | Information order and no-dock navigation match the concept. Folder rows and smart-view rows are scan-friendly. The test snackbar blocks the lower screen; inspect a clean capture before judging bottom spacing.           |
| Folder         | Folder summary and task-state grouping are clear. Expanded FAB overlaps a visible row; correct before sign-off. Back and task-detail navigation pass in the focused app flow.                                              |
| Today          | The empty-state title and “打开目录” action are clear. The app-level fixture has no today placements, so this does not compare a populated Today list. Snackbar covers the lower action area in the capture.               |
| Schedule       | Direct entry and return work. This app-level fixture has no date/event records, so only the empty “今天” state is shown; event/date hierarchy remains unreviewed from this capture. Snackbar covers the lower action area. |
| Workflows      | Empty state is understandable and the direct route works. Populated stages, ordering, and member actions were not covered by this fixture.                                                                                 |
| All Tasks      | Search/filter hierarchy is visible and the fixture includes multiple tasks. Snackbar overlays the lower rows/action area; a clean bottom-of-list capture is still needed.                                                  |
| Settings       | Header entry/back behavior passes. Light account summary is readable. Dark and dynamic-color behavior was not run through the real Activity.                                                                               |

## Not covered

This round used light theme, static color, 100% font scale, portrait, and gesture navigation. Dark/dynamic color, three-button navigation, landscape/short display, 200% font scale, TalkBack, and populated schedule/workflow app flows remain open. No app source was edited in this review.
