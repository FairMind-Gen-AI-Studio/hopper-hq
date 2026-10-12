# Third-party notices

scranton-hq has no runtime dependencies. Its browser UI bundles three typefaces, which the local daemon serves from `dist/ui/assets/`; nothing is fetched from a font service.

Each typeface is licensed under the SIL Open Font License, Version 1.1. The licence text, with each family's copyright notice, is in `licenses/`, copied unchanged from the package the files come from.

| Typeface | Files bundled | Source | Copyright | Licence |
|---|---|---|---|---|
| Archivo | `archivo-latin-wdth-normal.woff2` (variable: width 62–125, weight 100–900), Latin subset | `@fontsource-variable/archivo` 5.3.0 | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) | SIL OFL 1.1, `licenses/archivo-OFL.txt` |
| IBM Plex Sans | `ibm-plex-sans-latin-{400,500,600}-normal.woff2`, Latin subset | `@fontsource/ibm-plex-sans` 5.3.0 | Copyright 2019 IBM Corp. All rights reserved. | SIL OFL 1.1, `licenses/ibm-plex-sans-OFL.txt` |
| IBM Plex Mono | `ibm-plex-mono-latin-{400,500,600}-normal.woff2`, Latin subset | `@fontsource/ibm-plex-mono` 5.3.0 | Copyright 2017 IBM Corp. All rights reserved. | SIL OFL 1.1, `licenses/ibm-plex-mono-OFL.txt` |

The font files are distributed unmodified, as the packages above publish them.
