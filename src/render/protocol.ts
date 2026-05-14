import type { Camera, CanvasObject, StrokeObject } from '../types';

export type RenderCommand =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'resize';
      width: number;
      height: number;
      dpr: number;
    }
  | {
      type: 'scene';
      objects: CanvasObject[];
      remoteDrafts: StrokeObject[];
      camera: Camera;
    }
  | {
      type: 'draft';
      draft: StrokeObject | null;
    };

export type RenderEvent =
  | {
      type: 'ready';
    }
  | {
      type: 'error';
      message: string;
    };
