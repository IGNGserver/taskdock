# TaskDock brand assets

`taskdock-icon.png` is the exact selected ImageGen output. It is the full-bleed
master artwork for app icons, favicons, PWA icons, splash screens, and desktop
packaging. It must not be redrawn as a new SVG or assembled from separate
shapes.

Run `pnpm brand:sync` after replacing the master PNG. The script only creates
pixel-size derivatives by resizing or center-cropping that image, including the
ICO and Android resources.

The selected image combines three product ideas without adding a border or an
outer glow:

- the ivory check is the todo/action;
- the indigo caret is the developer cue;
- the indigo branch and nodes are the project structure, with the amber node
  marking a completed destination.
