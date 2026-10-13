import { describe, expect, it } from 'vitest';
import {
  DESK_PULL,
  MAX_POLAR,
  MAX_ZOOM,
  MIN_POLAR,
  MIN_ZOOM,
  QUARTER,
  Tween,
  clampZoom,
  deskPose,
  easeInOut,
  homeAzimuthNear,
  homePose,
  lerpPose,
  snapAzimuth,
  stepAzimuth,
  turnBetween,
} from '../../renderer/camera';
import { HOME_AZIMUTH, POLAR } from '../../renderer/world';

const TURN = 2 * Math.PI;

describe('camera moves', () => {
  it('keeps the zoom between its limits', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.7)).toBe(1.7);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.55, 3.2]);
  });

  it('tilts between near top-down and well above the ground, with home in between', () => {
    expect(MIN_POLAR).toBeGreaterThan(0);
    expect(MIN_POLAR).toBeLessThan(POLAR);
    expect(MAX_POLAR).toBeGreaterThan(POLAR);
    expect(MAX_POLAR).toBeLessThan(Math.PI / 2 - 0.2);
  });

  it('snaps to the nearest quarter turn from home, and steps one quarter on from there', () => {
    expect(snapAzimuth(HOME_AZIMUTH + 0.3)).toBeCloseTo(HOME_AZIMUTH, 10);
    expect(snapAzimuth(HOME_AZIMUTH + 1.2)).toBeCloseTo(HOME_AZIMUTH + QUARTER, 10);
    expect(snapAzimuth(HOME_AZIMUTH - 2)).toBeCloseTo(HOME_AZIMUTH - QUARTER, 10);
    expect(stepAzimuth(HOME_AZIMUTH, 1)).toBeCloseTo(HOME_AZIMUTH + QUARTER, 10);
    expect(stepAzimuth(HOME_AZIMUTH + 0.4, -1)).toBeCloseTo(HOME_AZIMUTH - QUARTER, 10);
    expect(stepAzimuth(HOME_AZIMUTH + 3 * QUARTER, 1)).toBeCloseTo(HOME_AZIMUTH + TURN, 10);
  });

  it('resets to the home azimuth nearest the current one', () => {
    expect(homeAzimuthNear(HOME_AZIMUTH + 3 * QUARTER)).toBeCloseTo(HOME_AZIMUTH + TURN, 10);
    expect(homeAzimuthNear(HOME_AZIMUTH + QUARTER)).toBeCloseTo(HOME_AZIMUTH, 10);
    expect(homeAzimuthNear(HOME_AZIMUTH - 5 * QUARTER)).toBeCloseTo(HOME_AZIMUTH - TURN, 10);
    expect(homePose({ w: 22, h: 12 }, HOME_AZIMUTH + 3 * QUARTER)).toEqual({ target: { x: 11, z: 6 }, azimuth: HOME_AZIMUTH + TURN, polar: POLAR, zoom: 1 });
    expect(homePose({ w: 22, h: 12 }).azimuth).toBe(HOME_AZIMUTH);
  });

  it('pans toward a desk, zooming in without turning or tilting', () => {
    const from = { target: { x: 11, z: 6 }, azimuth: 2, polar: 0.5, zoom: 1 };
    const to = deskPose(from, { x: 3, z: 8 }, { w: 22, h: 12 });
    expect(to.target.x).toBeCloseTo(3 + 8 * DESK_PULL, 10);
    expect(to.target.z).toBeCloseTo(8 - 2 * DESK_PULL, 10);
    expect(to.azimuth).toBe(2);
    expect(to.polar).toBe(0.5);
    expect(to.zoom).toBe(1.25);
    expect(deskPose({ ...from, zoom: 2 }, { x: 3, z: 8 }, { w: 22, h: 12 }).zoom).toBe(2);
    expect(deskPose({ ...from, zoom: 7 }, { x: 3, z: 8 }, { w: 22, h: 12 }).zoom).toBe(MAX_ZOOM);
  });

  it('eases in and out', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(0.25)).toBeCloseTo(0.0625, 10);
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });

  it('tweens from one pose to another over its duration', () => {
    const a = { target: { x: 0, z: 0 }, azimuth: 0, polar: POLAR, zoom: 1 };
    const b = { target: { x: 10, z: -4 }, azimuth: QUARTER, polar: MIN_POLAR, zoom: 2 };
    const t = new Tween(a, b, 1000, 500);
    expect(t.at(1000)).toEqual(a);
    expect(t.done(1000)).toBe(false);
    const mid = t.at(1250);
    expect(mid.target.x).toBeCloseTo(5, 10);
    expect(mid.zoom).toBeCloseTo(1.5, 10);
    expect(mid.polar).toBeCloseTo((POLAR + MIN_POLAR) / 2, 10);
    expect(t.at(1500)).toBe(b);
    expect(t.done(1500)).toBe(true);
    const jump = new Tween(a, b, 1000, 0);
    expect(jump.at(1000)).toBe(b);
    expect(jump.done(1000)).toBe(true);
  });

  it('turns the long way round when told to', () => {
    const a = { target: { x: 0, z: 0 }, azimuth: HOME_AZIMUTH, polar: POLAR, zoom: 1 };
    const b = { ...a, azimuth: HOME_AZIMUTH + 3 * QUARTER };
    expect(new Tween(a, b, 0, 100).at(50).azimuth).toBeCloseTo(HOME_AZIMUTH - QUARTER / 2, 10);
    const long = new Tween(a, b, 0, 100, 3 * QUARTER);
    expect(long.turn).toBe(3 * QUARTER);
    expect(long.at(50).azimuth).toBeCloseTo(HOME_AZIMUTH + 1.5 * QUARTER, 10);
    expect(long.at(100)).toBe(b);
  });

  it('turns the short way round, across the half turn', () => {
    expect(turnBetween(0.9 * Math.PI, -0.9 * Math.PI)).toBeCloseTo(0.2 * Math.PI, 10);
    expect(turnBetween(-HOME_AZIMUTH, HOME_AZIMUTH + TURN)).toBeCloseTo(QUARTER, 10);
    const a = { target: { x: 0, z: 0 }, azimuth: 0.9 * Math.PI, polar: POLAR, zoom: 1 };
    const half = lerpPose(a, { ...a, azimuth: -0.9 * Math.PI }, 0.5);
    expect(Math.cos(half.azimuth)).toBeCloseTo(-1, 10);
  });
});
