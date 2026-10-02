# TaskDock brand assets

`taskdock-icon.png` is the exact selected ImageGen output. It is the full-bleed
master artwork for app icons, favicons, PWA icons, splash screens, and desktop
packaging. It must not be redrawn as a new SVG or assembled from separate
shapes.

Run `pnpm brand:sync` after replacing the master PNG. The script creates
pixel-size derivatives by resizing or center-cropping that image, including the
ICO and Android resources. It also samples the master background to keep the
Android adaptive-icon and splash-screen background colors consistent.

The selected image combines three product ideas with soft, shallow relief:

- the rounded sage-green check represents completed tasks;
- the subdued folder behind it represents project organization;
- the two small marks on the short arm represent development notes.

Android themed launchers use `ic_launcher_monochrome.xml`, a simplified
single-color folder-and-check silhouette. This system-specific variant retains
the rounded geometry without reproducing the artwork's lighting or fine notes.
Update it alongside the master when the brand silhouette changes.
