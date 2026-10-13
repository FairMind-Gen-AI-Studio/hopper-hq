import { describe, expect, it } from 'vitest';
import { Color, type MeshStandardMaterial } from 'three';
import { GLASS_OPACITY, JOINT_SHADE, Materials, ROOM_MIX, RUG_MIX } from '../../renderer/materials';
import { dayTheme, type ThemeTokens } from '../../renderer/theme';

const hex = (c: Color) => '#' + c.getHexString();

function nightTheme(): ThemeTokens {
  const t = dayTheme();
  t.colors['scene-floor'] = '#3a3f55';
  t.colors['scene-desk'] = '#8c877c';
  t.colors['bot-visor'] = '#8ff0ff';
  t.colors['s-working'] = '#ffd27a';
  t.colors['repo-2'] = '#123456';
  t.colors['feature-4'] = '#654321';
  t.colors.accent = '#7ea4ff';
  t.colors['scene-board'] = '#c9ced8';
  t.colors['bot-hardhat'] = '#d3d8e0';
  t.colors['bot-jet'] = '#9aa3b2';
  t.colors['s-meeting'] = '#9b8cff';
  t.numbers['visor-int'] = 1.8;
  t.numbers['screen-int'] = 2;
  return t;
}

describe('materials', () => {
  it('colours each surface from its token', () => {
    const theme = dayTheme();
    const m = new Materials(theme);
    expect(hex(m.surface.floor.color)).toBe(theme.colors['scene-floor']);
    expect(hex(m.surface.wall.color)).toBe(theme.colors['scene-wall']);
    expect(hex(m.surface.desk.color)).toBe(theme.colors['scene-desk']);
    expect(hex(m.surface.monitor.color)).toBe(theme.colors['scene-monitor']);
    expect(hex(m.surface.shell.color)).toBe(theme.colors['bot-shell']);
    expect(m.surface.desk.roughness).toBe(0.7);
    expect(m.surface.floor.roughness).toBe(0.85);
  });

  it('makes the visor, the windows and the lamps glow with their intensities', () => {
    const theme = dayTheme();
    const m = new Materials(theme);
    const glow = (mat: MeshStandardMaterial) => [hex(mat.emissive), mat.emissiveIntensity];
    expect(glow(m.surface.visor)).toEqual([theme.colors['bot-visor'], theme.numbers['visor-int']]);
    expect(glow(m.surface.window)).toEqual([theme.colors['window-glow'], theme.numbers['window-int']]);
    expect(glow(m.surface.lamp)).toEqual([theme.colors['lamp-glow'], theme.numbers['lamp-int']]);
    expect(glow(m.surface.wall)).toEqual(['#000000', 1]);
  });

  it('colours the whiteboard, the hard hats and the jetpacks from their tokens, and tints a room floor toward the meeting colour', () => {
    const theme = dayTheme();
    const m = new Materials(theme);
    expect(hex(m.surface.board.color)).toBe(theme.colors['scene-board']);
    expect(hex(m.surface.hardhat.color)).toBe(theme.colors['bot-hardhat']);
    expect(hex(m.surface.jet.color)).toBe(theme.colors['bot-jet']);
    const tint = new Color(theme.colors['scene-floor']).lerp(new Color(theme.colors['s-meeting']), ROOM_MIX);
    expect(hex(m.surface.roomFloor.color)).toBe(hex(tint));
    expect([m.surface.board.transparent, m.surface.hardhat.transparent, m.surface.roomFloor.transparent]).toEqual([false, false, false]);
  });

  it('makes the partitions see-through glass in the glass colour, which writes no depth', () => {
    const theme = dayTheme();
    const glass = new Materials(theme).surface.glass;
    expect(hex(glass.color)).toBe(theme.colors['scene-glass']);
    expect([glass.transparent, glass.opacity, glass.depthWrite]).toEqual([true, GLASS_OPACITY, false]);
    expect(GLASS_OPACITY).toBeLessThan(0.5);
    expect(hex(glass.emissive)).toBe('#000000');
  });

  it('gives each repo slot a body, darker joints and a rug, and each feature slot a tie', () => {
    const theme = dayTheme();
    const m = new Materials(theme);
    expect(hex(m.body(2).color)).toBe(theme.colors['repo-2']);
    expect(m.joint(2).color.r).toBeCloseTo(new Color(theme.colors['repo-2']).r * JOINT_SHADE, 6);
    const rug = new Color(theme.colors['scene-floor']).lerp(new Color(theme.colors['repo-2']), RUG_MIX);
    expect(hex(m.rug(2).color)).toBe(hex(rug));
    expect(hex(m.tie(4).color)).toBe(theme.colors['feature-4']);
    expect(hex(m.tie(null).color)).toBe(theme.colors['feature-none']);
    expect(m.body(3)).not.toBe(m.body(2));
    expect(m.body(10)).toBe(m.body(2));
    expect(m.tie(-4)).toBe(m.tie(4));
    expect(m.body(1.5)).toBe(m.body(0));
  });

  it('lights a screen in its state colour and leaves idle and dormant screens off', () => {
    const theme = dayTheme();
    const m = new Materials(theme);
    const lit = { working: 's-working', needs_you: 's-needs', done: 's-done', in_meeting: 's-meeting', no_signal: 's-nosignal' } as const;
    for (const [state, token] of Object.entries(lit) as Array<[keyof typeof lit, (typeof lit)[keyof typeof lit]]>) {
      expect(hex(m.screen(state).emissive), state).toBe(theme.colors[token]);
      expect(m.screen(state).emissiveIntensity).toBe(theme.numbers['screen-int']);
    }
    expect(new Set(Object.keys(lit).map((s) => m.screen(s as keyof typeof lit))).size).toBe(5);
    expect(m.screen('idle')).toBe(m.screen('dormant'));
    expect(m.screen('idle').emissiveIntensity).toBe(0);
    expect(hex(m.screen('idle').emissive)).toBe('#000000');
  });

  it('recolours the same materials in place when the theme changes', () => {
    const m = new Materials(dayTheme());
    const before = m.all();
    const floor = m.surface.floor;
    const working = m.screen('working');
    const night = nightTheme();
    m.applyTheme(night);
    expect(m.all()).toEqual(before);
    expect(m.all().every((x, i) => x === before[i])).toBe(true);
    expect(m.surface.floor).toBe(floor);
    expect(hex(floor.color)).toBe('#3a3f55');
    expect(hex(m.surface.desk.color)).toBe('#8c877c');
    expect(hex(m.surface.deskOff.color)).not.toBe('#8c877c');
    expect(m.surface.visor.emissiveIntensity).toBe(1.8);
    expect(m.screen('working')).toBe(working);
    expect(hex(working.emissive)).toBe('#ffd27a');
    expect(working.emissiveIntensity).toBe(2);
    expect(hex(m.body(2).color)).toBe('#123456');
    expect(hex(m.tie(4).color)).toBe('#654321');
    expect(hex(m.ring.color)).toBe('#7ea4ff');
    expect(hex(m.surface.board.color)).toBe('#c9ced8');
    expect(hex(m.surface.hardhat.color)).toBe('#d3d8e0');
    expect(hex(m.surface.jet.color)).toBe('#9aa3b2');
    expect(hex(m.surface.roomFloor.color)).toBe(hex(new Color('#3a3f55').lerp(new Color('#9b8cff'), ROOM_MIX)));
  });

  it('frees every material once', () => {
    const m = new Materials(dayTheme());
    let freed = 0;
    for (const x of m.all()) x.addEventListener('dispose', () => freed++);
    m.dispose();
    expect(freed).toBe(m.all().length);
    expect(m.all().length).toBe(24 + 3 * 8 + 8 + 1 + 6 + 1);
  });
});
