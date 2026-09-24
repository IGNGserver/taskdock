# Android M3E directory UI — round 1

## Device and run

- AVD: `taskdock_api35_review` (Pixel 7 profile), Android 15 / API 35, `sdk_gphone64_x86_64`.
- Display: 1080×2400 px, 420 dpi (about 411×914 dp); portrait; gesture navigation (`secure navigation_mode=2`); font scale 1.0; system night mode off.
- Emulator was headless with software rendering. The screenshot pages use the app's light palette with dynamic color disabled. No real Hub or real credentials were used. The navigation fixture used an isolated owner and an unreachable `127.0.0.1:1` Hub endpoint.
- `:app:connectedDebugAndroidTest` over `WorkspaceScreenTest`: 5 passed, 3 failed. The dedicated `appStartsInDirectoryAndSmartViewsReturnToIt` rerun passed 1/1 twice. Logs and the XML/HTML report are in this directory.

## Page captures

All files under `compose-captures/ui-evidence/` are 1080×2400 Compose root captures written by `WorkspaceScreenTest.screenshot()` (`compose.onRoot().captureToImage()`). They show app content but are **not device screenshots**: status bar icons and the real gesture handle are not part of these captures. In particular, use the separate `device-*.png` files below for system-bar review.

| File                                               | Page / state                                      |
| -------------------------------------------------- | ------------------------------------------------- |
| `compose-captures/ui-evidence/app-directory.png`   | Directory home, fixture folders and one root task |
| `compose-captures/ui-evidence/app-folder.png`      | “IGNG站点” folder with 16 fixture tasks           |
| `compose-captures/ui-evidence/app-today.png`       | Today, empty schedule state                       |
| `compose-captures/ui-evidence/app-schedule.png`    | Schedule, no fixture dates/events                 |
| `compose-captures/ui-evidence/app-workflows.png`   | Workflows, empty state                            |
| `compose-captures/ui-evidence/app-all-tasks.png`   | All tasks and search/filter controls              |
| `compose-captures/ui-evidence/app-task-detail.png` | Fixture task detail                               |
| `compose-captures/ui-evidence/app-settings.png`    | Settings, light theme                             |

The `appStartsInDirectory...` screenshots include the temporary offline snackbar produced by the deliberately unreachable test Hub while it is visible. The app-folder capture also shows the expanded create FAB over a task row.

## Device-level evidence

- `device-main-activity-login-recheck.png`: full-device `adb shell screencap -p` from the installed debug app's real `MainActivity`, fresh unauthenticated login screen. The page surface continues behind the status bar and gesture area; stable status glyphs are dark on the light surface, and the gesture handle sits on the same surface.
- `device-main-activity-login.png`: earlier cold-launch sample from the same screen. It appears to have light status glyphs on the light surface; a later recheck was dark. Treat this as a startup-timing observation that needs another cold-start check, not a stable confirmed defect.
- `device-during-test.png`: full-device `adb shell screencap -p` while the navigation test was showing task detail with the IME open. It includes actual status icons, keyboard, and system gesture area; the keyboard owns its normal bottom surface.
- `device-test-run.mp4` and `device-navigation-run.mp4`: Android `screenrecord` recordings during the full class and focused navigation test. These preserve the real system UI around the app.

`device-frames/` contains transient captures taken after the navigation test had returned to the emulator launcher; they are not page evidence and are excluded from the review.

## Coverage limits

Round 1 did not exercise dark/dynamic color on a real app Activity, three-button navigation, landscape/short screens, 200% font scale, TalkBack, or a populated date/event schedule through the app-level navigation flow. The IME was visible in the device-level detail capture. No claim is made for the unrun configurations.
