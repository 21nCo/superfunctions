import { describe, it, expect, beforeEach } from 'vitest';
import { Drawfn } from '../src/drawfn';

describe('Drawfn', () => {
  let canvas: HTMLCanvasElement;
  let drawfn: Drawfn;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    drawfn = new Drawfn({ canvas });
  });

  it('should create an instance', () => {
    expect(drawfn).toBeDefined();
  });

  it('should have a default scene', () => {
    const scene = drawfn.getScene();
    expect(scene).toBeDefined();
    expect(scene.version).toBe(1);
    expect(scene.elements).toEqual([]);
    expect(scene.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('should add an element', () => {
    const id = drawfn.add({
      id: 'test',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    expect(id).toBe('test');
    const scene = drawfn.getScene();
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].type).toBe('rectangle');
  });

  it('should remove an element', () => {
    const id = drawfn.add({
      id: 'test',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    drawfn.remove(id);
    const scene = drawfn.getScene();
    expect(scene.elements).toHaveLength(0);
  });

  it('should update an element', () => {
    const id = drawfn.add({
      id: 'test',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    drawfn.update(id, { x: 50, y: 60 });
    
    const element = drawfn.getElementById(id);
    expect(element?.x).toBe(50);
    expect(element?.y).toBe(60);
  });

  it('should set and get camera', () => {
    drawfn.setCamera({ x: 100, y: 200, zoom: 1.5 });
    const camera = drawfn.getCamera();
    
    expect(camera.x).toBe(100);
    expect(camera.y).toBe(200);
    expect(camera.zoom).toBe(1.5);
  });

  it('should switch tools', () => {
    drawfn.setTool('pen');
    expect(drawfn.getTool()).toBe('pen');

    drawfn.setTool('rectangle');
    expect(drawfn.getTool()).toBe('rectangle');
  });

  it('should clear the scene', () => {
    drawfn.add({
      id: 'test',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    drawfn.clear();
    const scene = drawfn.getScene();
    expect(scene.elements).toHaveLength(0);
  });

  it('should handle undo/redo', () => {
    const id = drawfn.add({
      id: 'test',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    expect(drawfn.getScene().elements).toHaveLength(1);

    drawfn.undo();
    expect(drawfn.getScene().elements).toHaveLength(0);

    drawfn.redo();
    expect(drawfn.getScene().elements).toHaveLength(1);
  });

  it('should manage selection', () => {
    const id1 = drawfn.add({
      id: 'test1',
      type: 'rectangle',
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      rotation: 0,
      stroke: '#000000',
      fill: 'transparent',
      strokeWidth: 2,
      opacity: 1,
    });

    drawfn.setSelection([id1]);
    expect(drawfn.getSelectedIds()).toEqual([id1]);

    drawfn.setSelection([]);
    expect(drawfn.getSelectedIds()).toEqual([]);
  });
});
