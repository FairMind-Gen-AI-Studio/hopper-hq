# Third-party notices

hopper-hq has no runtime dependencies. Its browser UI bundles three typefaces and three JavaScript libraries, which the local daemon serves from `dist/ui/assets/`; nothing is fetched from a font service.

Each typeface is licensed under the SIL Open Font License, Version 1.1. The licence text, with each family's copyright notice, is in `licenses/`, copied unchanged from the package the files come from.

| Typeface | Files bundled | Source | Copyright | Licence |
|---|---|---|---|---|
| Archivo | `archivo-latin-wdth-normal.woff2` (variable: width 62–125, weight 100–900), Latin subset | `@fontsource-variable/archivo` 5.3.0 | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) | SIL OFL 1.1, `licenses/archivo-OFL.txt` |
| IBM Plex Sans | `ibm-plex-sans-latin-{400,500,600}-normal.woff2`, Latin subset | `@fontsource/ibm-plex-sans` 5.3.0 | Copyright 2019 IBM Corp. All rights reserved. | SIL OFL 1.1, `licenses/ibm-plex-sans-OFL.txt` |
| IBM Plex Mono | `ibm-plex-mono-latin-{400,500,600}-normal.woff2`, Latin subset | `@fontsource/ibm-plex-mono` 5.3.0 | Copyright 2017 IBM Corp. All rights reserved. | SIL OFL 1.1, `licenses/ibm-plex-mono-OFL.txt` |

The font files are distributed unmodified, as the packages above publish them.

## Libraries

The browser UI's JavaScript bundle includes code from the libraries below, each under the MIT licence. The licence text, with each library's copyright notice, is in `licenses/`, copied unchanged from the installed package.

| Library | Source | Copyright | Licence |
|---|---|---|---|
| Svelte | `svelte` 5.57.1 | Copyright (c) 2016-2025 [Svelte Contributors](https://github.com/sveltejs/svelte/graphs/contributors) | MIT, `licenses/svelte-MIT.txt` |
| clsx | `clsx` 2.1.1 | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) | MIT, `licenses/clsx-MIT.txt` |
| three.js | `three` 0.186.1 | Copyright © 2010-2026 three.js authors | MIT, `licenses/three-MIT.txt` |

## Agent icons

The Codex and Claude Code (Clawd) SVG marks in `ui/assets/agents/` come from `@lobehub/icons-static-svg` 1.95.1 ([LobeHub Icons](https://github.com/lobehub/lobe-icons)), Copyright (c) 2023 LobeHub, under the MIT licence in `licenses/lobe-icons-MIT.txt`. Presentation attributes are adjusted for local CSS sizing. The SVGs are bundled with the UI; no icon service is contacted. Product marks remain the trademarks of their respective owners.
