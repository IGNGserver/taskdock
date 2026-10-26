# Android client updates

The device reads `https://raw.githubusercontent.com/IGNGserver/taskdock/updates/updates.json` directly. It does not call the Hub or the GitHub Releases API. Downloaded APKs come directly from this repository's GitHub Release assets. Feed schema and publishing are documented in `UPDATES.md`.

Settings → About and updates has independent stable and preview choices. Before configuring or logging into a Hub, the login screen also exposes About and updates in a local sheet using the same update service and controls. Preview includes stable releases. On upgrade, the existing channel inferred from the installed build is saved once; later updates never change the user's choice. Switching channels re-evaluates the cached feed without making a network request or downgrading the installation.

A candidate must have a valid strictly newer SemVer, a complete matching Android APK, a positive size and SHA-256. Stable ignores both the GitHub prerelease flag and SemVer prerelease suffixes. Drafts and incomplete assets are ignored before selecting the highest compatible version. Optional feed versionCode must exceed the installed code. The downloaded APK is always checked for SHA-256, package identity, exact version, strictly greater Android versionCode and the installed signing certificate before the system installer is opened.

The JSON body, ETag and request schedule survive process restarts. Automatic checks wait six hours plus up to fifteen minutes of jitter; manual requests wait at least sixty seconds. All failed requests back off exponentially from one minute to six hours and honor Retry-After (seconds or HTTP date) and X-RateLimit-Reset. Neither changing channels nor restarting bypasses cooldowns. A damaged cache triggers a full request instead of a conditional request. An inaccessible feed is an update failure, never a fallback through the Hub or API.

## Android versionCode migration

Historical published tags through `v2.0.0-rc.59` used codes up to `200000059`. New builds reserve an epoch of `300000000`, followed by `major * 100000000 + minor * 1000000 + patch * 10000 + stage * 1000 + sequence`. Stage is alpha=0, beta=1, rc=2, stable=3; stable sequence is zero. Minor and patch are limited to 0..99, prerelease sequence to 0..998, and the final code must remain at or below Android's 2100000000 ceiling. This preserves alpha → beta → rc → stable ordering and upgrades from all historical codes. Already published APKs are immutable; the release pipeline must reject a new SemVer/code pair that does not increase over published versions.

## Validation

Run Android update tests with `:app:testDebugUnitTest --tests 'com.devtodo.app.data.update.*'`. These cover channels, strict upgrades, complete assets, feed identity, SemVer edges, ETag/304 reuse, persisted throttling and server retry deadlines. Full APK packaging and UI/device installation remain release CI/device checks.
