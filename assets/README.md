# Project renders

CAD renders shown in the project detail modal (see `main.js` → `PROJECTS`).
The modal hides its image panel gracefully if a file is missing, so nothing
breaks if one is absent.

| File(s)                    | Project      | Notes                          |
| -------------------------- | ------------ | ------------------------------ |
| `scorpion.webp`            | SCORPION     | single image                   |
| `car1.webp`, `car2.webp`   | FTAD Chassis | two angles → thumbnail gallery |
| `vex.webp`                 | VEX Robotics | single image                   |

To add/replace: drop a file here and update the path in `main.js` (`img` for a
single render, or the `imgs: [...]` array for a multi-image gallery). `.webp`,
`.png`, and `.jpg` all work. Landscape renders on a white/transparent
background look best.
