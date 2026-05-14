import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, CanvasObject, CursorState, PointerPoint, RoomUser, StrokeObject, Tool } from '../types';

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

type CanvasStageProps = {
  camera: Camera;
  objects: CanvasObject[];
  localDraft: StrokeObject | null;
  remoteDrafts: StrokeObject[];
  remoteUsers: RoomUser[];
  tool: Tool;
  localUser: RoomUser;
  onCameraChange: (camera: Camera) => void;
  onCursorChange: (cursor: CursorState | null) => void;
  onBeginStroke: (point: PointerPoint) => StrokeObject;
  onUpdateStroke: (draft: StrokeObject) => void;
  onCommitStroke: (draft: StrokeObject | null) => void;
  onErase: (point: PointerPoint) => void;
};

type Interaction =
  | {
      type: 'draw';
      draft: StrokeObject;
    }
  | {
      type: 'pan';
      pointerX: number;
      pointerY: number;
      camera: Camera;
    }
  | null;

export function CanvasStage({
  camera,
  objects,
  localDraft,
  remoteDrafts,
  remoteUsers,
  tool,
  localUser,
  onCameraChange,
  onCursorChange,
  onBeginStroke,
  onUpdateStroke,
  onCommitStroke,
  onErase
}: CanvasStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const wasmRef = useRef<WasmExports | null>(null);
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const frameRef = useRef<number | null>(null);
  const interactionRef = useRef<Interaction>(null);
  const latestDraftRef = useRef<StrokeObject | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);

  latestDraftRef.current = localDraft;

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;

    if (!canvas || !host) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      setRendererError('Canvas 2D rendering is not available.');
      return;
    }

    contextRef.current = context;

    const resize = (box: DOMRectReadOnly) => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(box.width * dpr));
      const height = Math.max(1, Math.floor(box.height * dpr));
      sizeRef.current = { width, height, dpr };
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      paintBackground(context, width, height);
    };

    resize(host.getBoundingClientRect());

    const observer = new ResizeObserver(([entry]) => {
      resize(entry.contentRect);
      queueRender();
    });

    observer.observe(host);

    loadWasm()
      .then((exports) => {
        wasmRef.current = exports;
        setRendererReady(true);
        queueRender();
      })
      .catch((error) => {
        setRendererError(error instanceof Error ? error.message : 'WASM renderer failed to load.');
      });

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
      wasmRef.current = null;
      contextRef.current = null;
    };
  }, []);

  useEffect(() => {
    queueRender();
  }, [camera, objects, remoteDrafts, localDraft]);

  const queueRender = useCallback(() => {
    if (frameRef.current !== null) {
      return;
    }

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      renderCanvas({
        context: contextRef.current,
        wasm: wasmRef.current,
        size: sizeRef.current,
        camera,
        objects,
        localDraft: latestDraftRef.current,
        remoteDrafts
      });
    });
  }, [camera, objects, remoteDrafts]);

  const remoteCursors = useMemo(() => remoteUsers.filter((user) => Boolean(user.cursor)), [remoteUsers]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toWorldPoint(event, camera);
    onCursorChange({ x: point.x, y: point.y, tool });

    if (tool === 'pan') {
      interactionRef.current = {
        type: 'pan',
        pointerX: event.clientX,
        pointerY: event.clientY,
        camera
      };
      return;
    }

    if (tool === 'eraser') {
      onErase(point);
      return;
    }

    interactionRef.current = {
      type: 'draw',
      draft: onBeginStroke(point)
    };
  }, [camera, onBeginStroke, onCursorChange, onErase, tool]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const point = toWorldPoint(event, camera);
    onCursorChange({ x: point.x, y: point.y, tool });

    const interaction = interactionRef.current;
    if (!interaction) {
      return;
    }

    if (interaction.type === 'pan') {
      onCameraChange({
        ...interaction.camera,
        x: interaction.camera.x + (event.clientX - interaction.pointerX) / camera.zoom,
        y: interaction.camera.y + (event.clientY - interaction.pointerY) / camera.zoom
      });
      return;
    }

    if (tool === 'eraser') {
      onErase(point);
      return;
    }

    const previous = interaction.draft.points[interaction.draft.points.length - 1];
    if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.8) {
      return;
    }

    const draft = {
      ...interaction.draft,
      points: [...interaction.draft.points, point]
    };

    interactionRef.current = { type: 'draw', draft };
    onUpdateStroke(draft);
  }, [camera, onCameraChange, onCursorChange, onErase, onUpdateStroke, tool]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    const interaction = interactionRef.current;
    interactionRef.current = null;

    if (interaction?.type === 'draw') {
      onCommitStroke(interaction.draft);
    }
  }, [onCommitStroke]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const worldX = screenX / camera.zoom - camera.x;
    const worldY = screenY / camera.zoom - camera.y;
    const zoomFactor = event.deltaY > 0 ? 0.92 : 1.08;
    const nextZoom = clamp(camera.zoom * zoomFactor, 0.25, 4);

    onCameraChange({
      x: screenX / nextZoom - worldX,
      y: screenY / nextZoom - worldY,
      zoom: nextZoom
    });
  }, [camera, onCameraChange]);

  return (
    <section
      ref={hostRef}
      className={`canvasStage canvasStage-${tool}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} className="canvasSurface" aria-label="Collaborative drawing canvas" />

      {!rendererReady && !rendererError ? <div className="canvasNotice">Loading renderer</div> : null}
      {rendererError ? <div className="canvasNotice canvasNoticeError">{rendererError}</div> : null}

      {remoteCursors.map((user) => {
        const cursor = user.cursor!;
        const screen = worldToScreen(cursor, camera);
        return (
          <div
            key={user.clientId}
            className={`remoteCursor remoteCursor-${user.cursorVariant}`}
            style={{
              transform: `translate(${screen.x}px, ${screen.y}px)`,
              '--cursor-color': user.color
            } as React.CSSProperties}
            aria-label={`${user.displayName} cursor`}
          >
            <div className="remoteCursorPointer">
              <div className="remoteCursorPoint" />
            </div>
            <span className="remoteCursorName" style={{
              backgroundColor: user.color
            }}
            >
              {user.displayName}
            </span>
          </div>
        );
      })}

      <div className="localBadge" style={{ borderColor: localUser.color }}>
        {localUser.displayName} | {tool} | {Math.round(camera.zoom * 100)}%
      </div>
    </section>
  );
}

function toWorldPoint(event: React.PointerEvent<HTMLElement>, camera: Camera): PointerPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / camera.zoom - camera.x,
    y: (event.clientY - rect.top) / camera.zoom - camera.y,
    pressure: event.pressure > 0 ? event.pressure : 0.7
  };
}

function worldToScreen(point: { x: number; y: number }, camera: Camera) {
  return {
    x: (point.x + camera.x) * camera.zoom,
    y: (point.y + camera.y) * camera.zoom
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function loadWasm(): Promise<WasmExports> {
  const response = await fetch('/wasm/canvas_wasm.wasm');
  if (!response.ok) {
    throw new Error(`WASM renderer failed to load: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (WebAssembly.instantiateStreaming && contentType.includes('application/wasm')) {
    const result = await WebAssembly.instantiateStreaming(Promise.resolve(response), {});
    return result.instance.exports as WasmExports;
  }

  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, {});
  return result.instance.exports as WasmExports;
}

type RenderInput = {
  context: CanvasRenderingContext2D | null;
  wasm: WasmExports | null;
  size: { width: number; height: number; dpr: number };
  camera: Camera;
  objects: CanvasObject[];
  localDraft: StrokeObject | null;
  remoteDrafts: StrokeObject[];
};

function renderCanvas({ context, wasm, size, camera, objects, localDraft, remoteDrafts }: RenderInput) {
  if (!context) {
    return;
  }

  const { width, height, dpr } = size;

  if (!wasm) {
    paintBackground(context, width, height);
    return;
  }

  const bufferLen = width * height * 4;
  const bufferPtr = wasm.alloc_bytes(bufferLen);

  try {
    wasm.clear(bufferPtr, bufferLen, 247, 244, 237, 255);

    for (const object of objects) {
      if (object.type === 'stroke') {
        rasterizeStroke(wasm, bufferPtr, width, height, dpr, camera, object, 1);
      }
    }

    for (const draft of remoteDrafts) {
      rasterizeStroke(wasm, bufferPtr, width, height, dpr, camera, draft, 0.65);
    }

    if (localDraft) {
      rasterizeStroke(wasm, bufferPtr, width, height, dpr, camera, localDraft, 0.85);
    }

    const pixels = new Uint8ClampedArray(wasm.memory.buffer, bufferPtr, bufferLen);
    const frame = new ImageData(new Uint8ClampedArray(pixels), width, height);
    context.putImageData(frame, 0, 0);
    drawGrid(context, width, height, dpr, camera);
  } finally {
    wasm.dealloc_bytes(bufferPtr, bufferLen);
  }
}

function rasterizeStroke(
  wasm: WasmExports,
  frameBufferPtr: number,
  width: number,
  height: number,
  dpr: number,
  camera: Camera,
  stroke: StrokeObject,
  opacity: number
) {
  if (stroke.points.length === 0) {
    return;
  }

  const screenPoints = stroke.points.map((point) => ({
    x: (point.x + camera.x) * camera.zoom * dpr,
    y: (point.y + camera.y) * camera.zoom * dpr,
    pressure: point.pressure
  }));
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
      frameBufferPtr,
      width * height * 4
    );
  } finally {
    wasm.dealloc_bytes(pointsPtr, pointBytes);
  }
}

function paintBackground(context: CanvasRenderingContext2D, width: number, height: number) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#f7f4ed';
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number, dpr: number, camera: Camera) {
  const grid = 32 * camera.zoom * dpr;
  if (grid < 8) {
    return;
  }

  const originX = ((camera.x * camera.zoom * dpr) % grid + grid) % grid;
  const originY = ((camera.y * camera.zoom * dpr) % grid + grid) % grid;

  context.strokeStyle = 'rgba(46, 53, 45, 0.08)';
  context.lineWidth = 1;
  context.beginPath();

  for (let x = originX; x < width; x += grid) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }

  for (let y = originY; y < height; y += grid) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }

  context.stroke();
}

function cssColorToRgba(color: string, opacity: number): number {
  const normalized = color.replace('#', '');
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const a = Math.round(255 * opacity);

  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}
