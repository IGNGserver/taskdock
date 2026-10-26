# PWA and adaptive web client

The normal business URL is the installable application. `/manifest.webmanifest` and `/sw.js`
are stable public endpoints; the application id and scope remain `/`, and its launch route
remains `/today`. No separate PWA or mobile site is required. The marketing website is a
separate product surface and does not install a second copy of the task workbench.

## Installation and icons

Installation help is reachable before login, from Settings, and from More. A supported
`beforeinstallprompt` event enables the native prompt; absence of the event does not mean
that the website is unusable or that manual installation is unavailable. iOS/iPadOS users
use Safari's Share menu and Add to Home Screen. Android browser versions differ, including
Edge; Chrome and Edge must be validated separately on physical devices.

`scripts/brand-assets.ts` generates the PNG set from the existing TaskDock master image.
PWA assets are composited onto an opaque brand canvas. Normal and maskable images have
separate padding and include 192, 512 and 1024 px versions; Apple images include 180, 167
and 152 px versions. The HTML and manifest refer to `/icons/<content revision>/` while
stable root aliases remain for automatic Apple probes and older installations. Run
`pnpm exec tsx scripts/brand-assets.ts --web-only` for a web-only regeneration.

## Version updates and offline state

The Vite PWA adapter uses Workbox injectManifest. The worker caches only the build's public
shell graph and immutable JS/CSS assets; API, authentication and user uploads are excluded.
The new worker waits until the user chooses to update. The UI checks the durable outbox and
protocol upgrade queue, waits for active synchronization to finish, and asks the user to
save inputs before reopening. It never deletes IndexedDB or queued task mutations.

Before old precache entries are removed, their immutable JS/CSS assets are copied to a
bounded TaskDock cache (96 entries). This allows other already-open tabs to finish loading
their cached release graph. An optional old chunk that was never cached still requires the
server to retain that immutable file; deployment must not assume all clients close at once.

HTML, the canonical manifest and the worker use `no-store, no-cache, max-age=0,
must-revalidate`. Content-addressed assets remain immutable. Cloudflare/CDN rules must
respect origin cache directives or bypass caching for these exact PWA control endpoints
and navigational HTML on the business host. Do not lower cache TTL across an entire zone.
A source change alone does not prove that the running deployment or CDN was updated.

## Phone and tablet layouts

Device identity and available window space are separate. Rotating a phone keeps phone
navigation; a large iPad or Android tablet keeps tablet navigation. A tablet's compact
split-screen window uses a single pane and mobile navigation. Supporting panes start at
840 px, and keyboard overlays use VisualViewport bounds on large tablets too. Preserve
safe-area insets, text scaling and pinch zoom.

Acceptance includes all main routes, login, task capture, directory, workflow, calendar,
events, settings, overlays, error and offline states at phone widths 320/390/430, tablet
widths 600/768/834/1024/1366, both orientations and tablet split view. Physical iOS 27 and
Android Chrome/Edge installation, home-screen artwork, standalone launch and update checks
are required in addition to automated browser tests. Desktop WebKit emulation cannot prove
iOS launcher icon selection or an Android Edge installation path.
