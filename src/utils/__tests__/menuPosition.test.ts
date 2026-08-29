import { describe, it, expect } from 'vitest';
import { clampMenu } from '../menuPosition';

const VIEW_W = 1000;
const VIEW_H = 600;

describe('clampMenu', () => {
  it('đủ chỗ thì giữ nguyên điểm bấm', () => {
    expect(clampMenu(100, 100, 200, 300, VIEW_W, VIEW_H)).toEqual({ left: 100, top: 100 });
  });

  it('hết chỗ bên dưới thì lật lên trên điểm bấm', () => {
    // clicked at y=500 with a 300-tall menu -> 500+300 > 600, so it flips above: 500-300 = 200
    expect(clampMenu(100, 500, 200, 300, VIEW_W, VIEW_H)).toEqual({ left: 100, top: 200 });
  });

  it('hết chỗ bên phải thì lật sang trái điểm bấm', () => {
    expect(clampMenu(950, 100, 200, 300, VIEW_W, VIEW_H)).toEqual({ left: 750, top: 100 });
  });

  it('menu cao hơn khoảng trống thì ép vào trong viewport, không âm', () => {
    // a 590-tall menu: flipping above is negative too -> clamped to 600-590-8 = 2, but never below the margin
    expect(clampMenu(100, 550, 200, 590, VIEW_W, VIEW_H)).toEqual({ left: 100, top: 8 });
  });

  it('lật cả hai chiều khi bấm ở góc dưới phải', () => {
    expect(clampMenu(980, 580, 200, 300, VIEW_W, VIEW_H)).toEqual({ left: 780, top: 280 });
  });
});
