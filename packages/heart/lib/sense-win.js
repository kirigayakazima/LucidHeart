// Windows 环境采样：通过 PowerShell P/Invoke 获取系统空闲时间与当前前台窗口。
// 零 DSH 依赖，纯 Node 进程管理。
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { toLocalISOString, getSinceMsgMin } from './sense.js'

export const PS_SENSE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinSense {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static long IdleMs() { var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (long)(Environment.TickCount - l.dwTime); }
  public static string Fg() { var h = GetForegroundWindow(); var sb = new StringBuilder(512); GetWindowText(h, sb, 512); uint pid; GetWindowThreadProcessId(h, out pid); try { var p = System.Diagnostics.Process.GetProcessById((int)pid); return p.ProcessName + " | " + sb.ToString(); } catch { return "? | " + sb.ToString(); } }
}
"@
"idle_ms=" + [WinSense]::IdleMs()
"fg=" + [WinSense]::Fg()
`

export async function sampleWin(options = {}) {
  const at = options.now ? new Date(options.now) : new Date()
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
  const sinceMsgMin = getSinceMsgMin(sessionsRoot, at)

  if (typeof options.runner === 'function') {
    return options.runner({ at, sinceMsgMin })
  }

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_SENSE_SCRIPT],
      { timeout: 3000, encoding: 'utf8' },
      (err, stdout) => {
        let idleMs = null
        let fg = null
        let error = null

        if (err) {
          if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
            error = 'powershell-timeout'
          } else {
            error = 'powershell-error'
          }
        } else {
          for (const line of (stdout || '').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (trimmed.startsWith('idle_ms=')) {
              const val = Number(trimmed.slice('idle_ms='.length))
              if (!Number.isNaN(val)) idleMs = Math.max(0, val)
            } else if (trimmed.startsWith('fg=')) {
              const rawFg = trimmed.slice('fg='.length).trim()
              if (rawFg && rawFg !== 'Idle |' && rawFg !== 'Idle' && rawFg !== '? |' && rawFg !== '?') {
                fg = rawFg
              }
            }
          }
        }

        resolve({
          at: toLocalISOString(at),
          idleMs,
          fg,
          sinceMsgMin,
          screen: null,
          net: null,
          battery: null,
          error: error || null,
        })
      }
    )
  })
}
