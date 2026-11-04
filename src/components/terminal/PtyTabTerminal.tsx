import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtyOutputSnapshot, PtySession } from '../../types/electron';
import { ptyChunksAfter, type PtyLiveChunk } from '../../lib/ptyReplay';
import { useTimers } from '../../hooks/useTimeoutState';

interface PtyTabTerminalProps {
  session: PtySession;
  isActive: boolean;
}

export const PtyTabTerminal: React.FC<PtyTabTerminalProps> = ({ session, isActive }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  /** Накопленный вывод сессии уже записан — дальше живой поток идёт прямо в xterm. */
  const replayedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  // Отложенный refit/focus: таймер снимается при размонтировании вкладки (TASK-50)
  const { setTimer } = useTimers();

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#0a0d14',
        foreground: '#e2e8f0',
        cursor: '#818cf8',
        cursorAccent: '#0a0d14',
        selectionBackground: '#4f46e550',
        black: '#1e293b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#38bdf8',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#eab308',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#06b6d4',
        brightWhite: '#ffffff'
      },
      fontFamily: 'Consolas, "Fira Code", "Cascadia Code", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: true,
      allowTransparency: true,
      scrollback: 5000
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    replayedRef.current = false;
    let disposed = false;

    // Hook up interactive input
    const onDataDisposable = term.onData((data) => {
      if (window.api?.writePty) {
        window.api.writePty(session.id, data);
      }
    });

    // Живой поток подключается до запроса накопленного вывода: чанки, пришедшие во время запроса, откладываются и
    // дописываются только своей частью после снимка (TASK-292, decision-216).
    const pending: PtyLiveChunk[] = [];
    let cleanupPtyData: (() => void) | null = null;
    if (window.api?.onPtyData) {
      cleanupPtyData = window.api.onPtyData(({ sessionId, data, end }) => {
        if (sessionId !== session.id) return;
        if (replayedRef.current) term.write(data);
        else pending.push({ data, end });
      });
    }

    const fitToPanel = () => {
      try {
        fitAddon.fit();
        window.api?.resizePty?.(session.id, term.cols, term.rows);
      } catch (e) {}
    };

    // Накопленный вывод пишется в размере pty, в котором его рисовал CLI; потом терминал подгоняется под панель — если
    // размер другой, CLI получает resize и перерисовывает экран целиком.
    const replay = (snapshot: PtyOutputSnapshot | null) => {
      if (disposed) return;
      if (snapshot) {
        if (snapshot.cols > 0 && snapshot.rows > 0) term.resize(snapshot.cols, snapshot.rows);
        term.write(snapshot.data + ptyChunksAfter(pending, snapshot.end));
      } else {
        term.write(ptyChunksAfter(pending, -1));
      }
      pending.length = 0;
      replayedRef.current = true;
      term.write('', () => {
        if (disposed) return;
        fitToPanel();
        if (isActiveRef.current) term.focus();
      });
    };
    if (window.api?.getPtyOutput) {
      window.api.getPtyOutput(session.id).then(replay, () => replay(null));
    } else {
      replay(null);
    }

    // Window / Panel resize listener
    const handleResize = () => {
      if (!fitAddonRef.current || !xtermRef.current || !replayedRef.current) return;
      try {
        fitAddonRef.current.fit();
        if (window.api?.resizePty) {
          window.api.resizePty(session.id, xtermRef.current.cols, xtermRef.current.rows);
        }
      } catch (e) {}
    };

    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      onDataDisposable.dispose();
      if (cleanupPtyData) cleanupPtyData();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id]);

  // When tab becomes active, refit and focus
  useEffect(() => {
    // До повтора накопленного вывода размер не трогается: подгонку делает сам повтор.
    if (isActive && fitAddonRef.current && xtermRef.current && replayedRef.current) {
      setTimer(() => {
        try {
          fitAddonRef.current?.fit();
          if (window.api?.resizePty && xtermRef.current) {
            window.api.resizePty(session.id, xtermRef.current.cols, xtermRef.current.rows);
          }
          xtermRef.current?.focus();
        } catch (e) {}
      }, 50);
    }
  }, [isActive, session.id, setTimer]);

  return (
    <div
      style={{ display: isActive ? 'block' : 'none' }}
      className="w-full h-full p-2 bg-ph-base select-text relative"
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};
