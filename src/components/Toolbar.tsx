import { Eraser, Hand, PenLine, Redo2, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tool } from '../types';

const COLORS = ['#111827', '#b91c1c', '#0369a1', '#047857', '#7c2d12', '#6d28d9'];

type ToolbarProps = {
  tool: Tool;
  color: string;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onWidthChange: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onResetView: () => void;
};

export function Toolbar({
  tool,
  color,
  width,
  canUndo,
  canRedo,
  onToolChange,
  onColorChange,
  onWidthChange,
  onUndo,
  onRedo,
  onClear,
  onResetView
}: ToolbarProps) {
  return (
    <aside className="toolbar" aria-label="Canvas tools">
      <div className="toolGroup">
        <ToolButton label="Pen" active={tool === 'pen'} onClick={() => onToolChange('pen')}>
          <PenLine size={18} />
        </ToolButton>
        <ToolButton label="Eraser" active={tool === 'eraser'} onClick={() => onToolChange('eraser')}>
          <Eraser size={18} />
        </ToolButton>
        <ToolButton label="Pan" active={tool === 'pan'} onClick={() => onToolChange('pan')}>
          <Hand size={18} />
        </ToolButton>
      </div>

      <div className="toolGroup colorGroup" aria-label="Stroke colors">
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            className={`colorSwatch ${color === swatch ? 'isActive' : ''}`}
            style={{ backgroundColor: swatch }}
            aria-label={`Use color ${swatch}`}
            onClick={() => onColorChange(swatch)}
          />
        ))}
      </div>

      <label className="widthControl">
        <span>{width}px</span>
        <input
          type="range"
          min="2"
          max="28"
          step="1"
          value={width}
          onChange={(event) => onWidthChange(Number(event.target.value))}
        />
      </label>

      <div className="toolGroup">
        <ToolButton label="Undo" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="Redo" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={18} />
        </ToolButton>
        <ToolButton label="Reset view" onClick={onResetView}>
          <RotateCcw size={18} />
        </ToolButton>
        <ToolButton label="Clear canvas" danger onClick={onClear}>
          <Trash2 size={18} />
        </ToolButton>
      </div>
    </aside>
  );
}

type ToolButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
  onClick: () => void;
};

function ToolButton({ label, active, disabled, danger, children, onClick }: ToolButtonProps) {
  return (
    <button
      className={`iconButton ${active ? 'isActive' : ''} ${danger ? 'isDanger' : ''}`}
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
