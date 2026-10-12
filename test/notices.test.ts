import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

/** The typefaces the UI bundles (M2 decision 2), each under the SIL Open Font License 1.1. */
const FONTS = [
  { family: 'Archivo', pkg: '@fontsource-variable/archivo', licence: 'licenses/archivo-OFL.txt', copyright: 'Copyright 2020 The Archivo Project Authors' },
  { family: 'IBM Plex Sans', pkg: '@fontsource/ibm-plex-sans', licence: 'licenses/ibm-plex-sans-OFL.txt', copyright: 'Copyright 2019 IBM Corp.' },
  { family: 'IBM Plex Mono', pkg: '@fontsource/ibm-plex-mono', licence: 'licenses/ibm-plex-mono-OFL.txt', copyright: 'Copyright 2017 IBM Corp.' },
];

describe('bundled fonts', () => {
  it('ships each licence exactly as its font package has it', () => {
    for (const f of FONTS) {
      const shipped = read(f.licence);
      expect(shipped, f.licence).toBe(read(`node_modules/${f.pkg}/LICENSE`));
      expect(shipped).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(shipped.startsWith(f.copyright)).toBe(true);
    }
  });

  it('names every font, its package version, copyright and licence file in the notices', () => {
    const notices = read('THIRD_PARTY_NOTICES.md');
    const pkg = JSON.parse(read('package.json'));
    for (const f of FONTS) {
      expect(notices).toContain(`| ${f.family} |`);
      expect(notices).toContain(`\`${f.pkg}\` ${pkg.devDependencies[f.pkg]}`);
      expect(notices).toContain(f.copyright);
      expect(notices).toContain(`\`${f.licence}\``);
    }
  });

  it('publishes the notices and the licences with the package', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses']);
  });

  it('loads seven Latin woff2 files from the pinned packages, and nothing else', () => {
    const css = read('ui/styles/fonts.css');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(7);
    for (const url of urls) {
      expect(url).toMatch(/^@fontsource(?:-variable)?\/[\w-]+\/files\/[\w-]+-latin-[\w-]+-normal\.woff2$/);
      expect(existsSync(new URL(`node_modules/${url}`, ROOT)), url).toBe(true);
    }
    expect(css.match(/format\('woff2'\)/g)).toHaveLength(7);
    expect(css).not.toMatch(/\.woff['")]|\.ttf|\/\//);
  });

  it('declares Archivo with its width and weight ranges', () => {
    const archivo = read('ui/styles/fonts.css').match(/@font-face \{[^}]*font-family: 'Archivo';[^}]*\}/)?.[0];
    expect(archivo).toContain('font-weight: 100 900;');
    expect(archivo).toContain('font-stretch: 62% 125%;');
  });

  it('says in the README that the UI bundles OFL fonts', () => {
    const licence = read('README.md').split('## License')[1] ?? '';
    expect(licence).toContain('SIL Open Font License');
    expect(licence).toContain('THIRD_PARTY_NOTICES.md');
  });
});
