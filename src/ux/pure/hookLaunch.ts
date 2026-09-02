/**
 * How the Doctor runs the hook for its "Hook wiring live test". Pure (no `vscode`, no I/O) so the
 * choice is unit-testable.
 *
 * The assistants never run the hook script directly: they run the wrapper the installer wrote into
 * `<home>/hooks/` (it pins the Node runtime and the ExplainIT home). The live test therefore prefers
 * that wrapper, so it exercises the same path the assistants use. Only when no wrapper is installed
 * does it fall back to running the script with this process's own Node.
 */

export interface HookLaunchInput {
  /** Wrapper paths recorded by the installers (`state.adapters.<agent>.wrapperPath`), in preference order. */
  wrapperCandidates: (string | undefined)[];
  /** The hook script to run directly when no wrapper is installed. */
  scriptPath: string;
  platform: NodeJS.Platform;
  /** This process's executable: VS Code's Electron inside the extension host, plain node in tests. */
  execPath: string;
  exists: (p: string) => boolean;
  /** Passed as `--watchdog`; the hook answers "ask" by itself after this many seconds of silence. */
  watchdogSeconds: number;
  /** ExplainIT home, passed as `--home` so the hook never depends on the environment to find the gate. */
  home: string;
  agent?: 'claude' | 'codex';
}

export interface HookLaunchPlan {
  via: 'wrapper' | 'script';
  /** Absolute path of the wrapper or script that is exercised. */
  target: string;
  command: string;
  args: string[];
  /** Extra environment for the child process, on top of the parent's. */
  env: Record<string, string>;
  /** Windows only: the cmd.exe command line in `args` is already quoted and must be passed verbatim. */
  windowsVerbatimArguments: boolean;
  /** Plain-English phrase for the Doctor detail, e.g. "through the installed wrapper /home/x/.explainit/hooks/explainit-hook.sh". */
  description: string;
}

export interface HookLaunchError {
  error: string;
}

/** The hook's own arguments (identical whichever launcher is used). */
export function hookArgs(agent: 'claude' | 'codex', watchdogSeconds: number, home: string): string[] {
  return ['--agent', agent, '--watchdog', String(Math.max(1, Math.floor(watchdogSeconds))), '--home', home];
}

/** One cmd.exe argument: quoted when it carries spaces or shell-special characters. Quotes are not legal in Windows paths. */
export function cmdArg(s: string): string {
  const clean = s.replace(/"/g, '');
  return /[\s&|<>^()%!]/.test(clean) || clean === '' ? `"${clean}"` : clean;
}

export function planHookLaunch(i: HookLaunchInput): HookLaunchPlan | HookLaunchError {
  const agent = i.agent ?? 'claude';
  const args = hookArgs(agent, i.watchdogSeconds, i.home);
  const wrapper = i.wrapperCandidates.find((w): w is string => typeof w === 'string' && w.trim() !== '' && i.exists(w));

  if (wrapper) {
    if (i.platform === 'win32') {
      // cmd /s strips the outermost quotes of the /c string, so the whole line is wrapped once more.
      const line = `"${[cmdArg(wrapper), ...args.map(cmdArg)].join(' ')}"`;
      return {
        via: 'wrapper',
        target: wrapper,
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', line],
        env: {},
        windowsVerbatimArguments: true,
        description: `through the installed wrapper ${wrapper}`,
      };
    }
    // Run through sh explicitly so a lost executable bit is reported by the hook test, not hidden by it.
    const sh = i.exists('/bin/sh') ? '/bin/sh' : 'sh';
    return {
      via: 'wrapper',
      target: wrapper,
      command: sh,
      args: [wrapper, ...args],
      env: {},
      windowsVerbatimArguments: false,
      description: `through the installed wrapper ${wrapper}`,
    };
  }

  if (!i.scriptPath || !i.exists(i.scriptPath)) {
    return { error: `no hook wrapper is installed and the hook script is missing (${i.scriptPath || 'no path'}); connect an assistant or reinstall the hooks` };
  }
  // No wrapper yet (nothing connected): run the script with this process's Node. ELECTRON_RUN_AS_NODE
  // makes VS Code's executable behave as plain Node and is harmless under a real node binary.
  return {
    via: 'script',
    target: i.scriptPath,
    command: i.execPath,
    args: [i.scriptPath, ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    windowsVerbatimArguments: false,
    description: `by running the hook script directly (${i.scriptPath}) because no wrapper is installed yet`,
  };
}
