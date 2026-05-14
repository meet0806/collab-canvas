/// <reference lib="webworker" />

import type { Camera, CanvasObject, PointerPoint, StrokeObject } from '../types';
import type { RenderCommand, RenderEvent } from './protocol';

type WasmExports = {
  memory: WebAssembly.Memory;
  alloc_bytes: (len: number) => number;
  dealloc_bytes: (ptr: number, len: number) => void;
  clear: (bufferPtr: number, bufferLen: number, r: number, g: number, b: number, a: number) => void;
  rasterize_stroke: (
    pointsPtr: number,
    pointCount: number,
    width: number,
    height: number,
    rgba: number,
    baseRadius: number,
    bufferPtr: number,
    bufferLen: number
  ) => void;
};

const ctx: Worker = self as unknown as Worker;

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let width = 1;
let height = 1;
let dpr = 1;
let camera: Camera = { x: 0, y: 0, zoom: 1 };
let objects: CanvasObject[] = [];
let localDraft: StrokeObject | null = null;
let remoteDrafts: StrokeObject[] = [];
let wasm: WasmExports | null = null;
let renderQueued = false;

ctx.onmessage = async (event: MessageEvent<RenderCommand>) => {
  try {
    await handleCommand(event.data);
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : 'renderer failed'
    });
  }
};

async function handleCommand(command: RenderCommand) {
  if (command.type === 'init') {
    canvas = command.canvas;
    context = canvas.getContext('2d', { alpha: false });
    resize(command.width, command.height, command.dpr);
    wasm = await loadWasm();
    post({ type: 'ready' });
    queueRender();
    return;
  }

  if (command.type === 'resize') {
    resize(command.width, command.height, command.dpr);
    queueRender();
    return;
  }

  if (command.type === 'scene') {
    objects = command.objects;
    remoteDrafts = command.remoteDrafts;
    camera = command.camera;
    queueRender();
    return;
  }

  localDraft = command.draft;
  queueRender();
}

function resize(nextWidth: number, nextHeight: number, nextDpr: number) {
  width = Math.max(1, Math.floor(nextWidth * nextDpr));
  height = Math.max(1, Math.floor(nextHeight * nextDpr));
  dpr = nextDpr;

  if (canvas) {
    canvas.width = width;
    canvas.height = height;
  }
}

async function loadWasm(): Promise<WasmExports> {
  const response = await fetch('/wasm/canvas_wasm.wasm');
  const contentType = response.headers.get('content-type') ?? '';

  if (WebAssembly.instantiateStreaming && contentType.includes('application/wasm')) {
    const result = await WebAssembly.instantiateStreaming(Promise.resolve(response), {});
    return result.instance.exports as WasmExports;
  }

  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, {});
  return result.instance.exports as WasmExports;
}

function queueRender() {
  if (renderQueued) {
    return;
  }

  renderQueued = true;
  scheduleFrame(() => {
    renderQueued = false;
    render();
  });
}

function scheduleFrame(callback: () => void) {
  if ('requestAnimationFrame' in self) {
    self.requestAnimationFrame(callback);
    return;
  }

  setTimeout(callback, 16);
}

function render() {
  if (!context || !wasm) {
    return;
  }

  const bufferLen = width * height * 4;
  const bufferPtr = wasm.alloc_bytes(bufferLen);

  try {
    activeFrameBufferPtr = bufferPtr;
    wasm.clear(bufferPtr, bufferLen, 247, 244, 237, 255);

    for (const object of objects) {
      if (object.type === 'stroke') {
        rasterizeStroke(object, 1);
      }
    }

    for (const draft of remoteDrafts) {
      rasterizeStroke(draft, 0.65);
    }

    if (localDraft) {
      rasterizeStroke(localDraft, 0.85);
    }

    const pixels = new Uint8ClampedArray(wasm.memory.buffer, bufferPtr, bufferLen);
    const frame = new ImageData(new Uint8ClampedArray(pixels), width, height);
    context.putImageData(frame, 0, 0);
    drawGrid(context);
  } finally {
    activeFrameBufferPtr = 0;
    wasm.dealloc_bytes(bufferPtr, bufferLen);
  }
}

function rasterizeStroke(stroke: StrokeObject, opacity: number) {
  if (!wasm || stroke.points.length === 0) {
    return;
  }

  const screenPoints = stroke.points.map(worldToScreenPoint);
  const pointBytes = screenPoints.length * 3 * Float32Array.BYTES_PER_ELEMENT;
  const pointsPtr = wasm.alloc_bytes(pointBytes);

  try {
    const pointBuffer = new Float32Array(wasm.memory.buffer, pointsPtr, screenPoints.length * 3);
    for (let index = 0; index < screenPoints.length; index += 1) {
      const point = screenPoints[index];
      const base = index * 3;
      pointBuffer[base] = point.x;
      pointBuffer[base + 1] = point.y;
      pointBuffer[base + 2] = point.pressure;
    }

    wasm.rasterize_stroke(
      pointsPtr,
      screenPoints.length,
      width,
      height,
      cssColorToRgba(stroke.color, opacity),
      (stroke.width * camera.zoom * dpr) / 2,
      getFrameBufferPtr(),
      width * height * 4
    );
  } finally {
    wasm.dealloc_bytes(pointsPtr, pointBytes);
  }
}

let activeFrameBufferPtr = 0;

function getFrameBufferPtr(): number {
  return activeFrameBufferPtr;
}

function drawGrid(renderContext: OffscreenCanvasRenderingContext2D) {
  const grid = 32 * camera.zoom * dpr;
  if (grid < 8) {
    return;
  }

  const originX = ((camera.x * camera.zoom * dpr) % grid + grid) % grid;
  const originY = ((camera.y * camera.zoom * dpr) % grid + grid) % grid;

  renderContext.strokeStyle = 'rgba(46, 53, 45, 0.08)';
  renderContext.lineWidth = 1;
  renderContext.beginPath();

  for (let x = originX; x < width; x += grid) {
    renderContext.moveTo(x, 0);
    renderContext.lineTo(x, height);
  }

  for (let y = originY; y < height; y += grid) {
    renderContext.moveTo(0, y);
    renderContext.lineTo(width, y);
  }

  renderContext.stroke();
}

function worldToScreenPoint(point: PointerPoint): PointerPoint {
  return {
    x: (point.x + camera.x) * camera.zoom * dpr,
    y: (point.y + camera.y) * camera.zoom * dpr,
    pressure: point.pressure
  };
}

function cssColorToRgba(color: string, opacity: number): number {
  const normalized = color.replace('#', '');
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const a = Math.round(255 * opacity);

  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function post(event: RenderEvent) {
  ctx.postMessage(event);
}
