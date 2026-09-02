import * as assert from 'node:assert/strict';
import { cmdArg, hookArgs, planHookLaunch, type HookLaunchInput, type HookLaunchPlan } from '../../../src/ux/pure/hookLaunch';

const HOME = '/home/pat/.explainit';
const WRAPPER_SH = `${HOME}/hooks/explainit-hook.sh`;
const WRAPPER_CMD = 'C:\\Users\\Pat Smith\\.explainit\\hooks\\explainit-hook.cmd';
const SCRIPT = `${HOME}/hooks/explainit-hook.js`;

function input(over: Partial<HookLaunchInput> = {}): HookLaunchInput {
  const present = new Set([WRAPPER_SH, SCRIPT, '/bin/sh']);
  return {
    wrapperCandidates: [WRAPPER_SH],
    scriptPath: SCRIPT,
    platform: 'linux',
    execPath: '/usr/share/code/code',
    exists: (p) => present.has(p),
    watchdogSeconds: 6,
    home: HOME,
    ...over,
  };
}

function plan(over: Partial<HookLaunchInput> = {}): HookLaunchPlan {
  const p = planHookLaunch(input(over));
  assert.ok(!('error' in p), 'error' in p ? p.error : '');
  return p as HookLaunchPlan;
}

suite('ux/pure/hookLaunch', () => {
  test('uses the installed wrapper when present (POSIX: sh <wrapper> --agent claude --watchdog N --home <home>)', () => {
    const p = plan();
    assert.equal(p.via, 'wrapper');
    assert.equal(p.target, WRAPPER_SH);
    assert.equal(p.command, '/bin/sh');
    assert.deepEqual(p.args, [WRAPPER_SH, '--agent', 'claude', '--watchdog', '6', '--home', HOME]);
    assert.equal(p.windowsVerbatimArguments, false);
    assert.deepEqual(p.env, {}, 'the wrapper pins ELECTRON_RUN_AS_NODE itself; the doctor adds nothing');
    assert.ok(p.description.includes('installed wrapper'));
    assert.ok(p.description.includes(WRAPPER_SH));
  });

  test('uses the installed wrapper when present (Windows: cmd.exe /d /s /c with a verbatim, quoted line)', () => {
    const p = plan({ platform: 'win32', wrapperCandidates: [WRAPPER_CMD], exists: (x) => x === WRAPPER_CMD || x === SCRIPT, home: 'C:\\Users\\Pat Smith\\.explainit' });
    assert.equal(p.via, 'wrapper');
    assert.equal(p.command, 'cmd.exe');
    assert.equal(p.windowsVerbatimArguments, true);
    assert.deepEqual(p.args.slice(0, 3), ['/d', '/s', '/c']);
    const line = p.args[3];
    assert.ok(line.startsWith('"') && line.endsWith('"'), 'outer quotes for cmd /s');
    assert.ok(line.includes(`"${WRAPPER_CMD}"`), 'a path with a space is quoted');
    assert.ok(line.includes('--agent claude --watchdog 6 --home "C:\\Users\\Pat Smith\\.explainit"'));
    assert.equal(p.args.length, 4);
  });

  test('falls back to sh from PATH when /bin/sh does not exist', () => {
    const p = plan({ exists: (x) => x === WRAPPER_SH || x === SCRIPT });
    assert.equal(p.command, 'sh');
    assert.equal(p.args[0], WRAPPER_SH);
  });

  test('takes the first wrapper candidate that exists, skipping blanks and missing files', () => {
    const codexWrapper = '/srv/other/explainit-hook.sh';
    const p = plan({ wrapperCandidates: [undefined, '', '/gone/explainit-hook.sh', codexWrapper], exists: (x) => x === codexWrapper || x === SCRIPT || x === '/bin/sh' });
    assert.equal(p.via, 'wrapper');
    assert.equal(p.target, codexWrapper);
  });

  test('falls back to process.execPath + script only when no wrapper is installed, with ELECTRON_RUN_AS_NODE', () => {
    const p = plan({ wrapperCandidates: [undefined, '/gone/explainit-hook.sh'] });
    assert.equal(p.via, 'script');
    assert.equal(p.command, '/usr/share/code/code');
    assert.deepEqual(p.args, [SCRIPT, '--agent', 'claude', '--watchdog', '6', '--home', HOME]);
    assert.deepEqual(p.env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(p.windowsVerbatimArguments, false);
    assert.ok(p.description.includes('no wrapper is installed'));
    assert.ok(p.description.includes(SCRIPT));
  });

  test('no wrapper and no script -> a plain-English error naming the script path', () => {
    const p = planHookLaunch(input({ wrapperCandidates: [], exists: () => false }));
    assert.ok('error' in p);
    assert.ok(p.error.includes(SCRIPT));
    assert.ok(p.error.includes('reinstall'));
    const noPath = planHookLaunch(input({ wrapperCandidates: [], scriptPath: '', exists: () => false }));
    assert.ok('error' in noPath && !noPath.error.includes('undefined'));
  });

  test('hookArgs clamps the watchdog to a whole number of at least one second and pins --home', () => {
    assert.deepEqual(hookArgs('codex', 0.4, HOME), ['--agent', 'codex', '--watchdog', '1', '--home', HOME]);
    assert.deepEqual(hookArgs('claude', 7.9, HOME).slice(2, 4), ['--watchdog', '7']);
  });

  test('cmdArg quotes only when needed and never emits embedded quotes', () => {
    assert.equal(cmdArg('--agent'), '--agent');
    assert.equal(cmdArg('C:\\plain\\path.cmd'), 'C:\\plain\\path.cmd');
    assert.equal(cmdArg('C:\\with space\\x.cmd'), '"C:\\with space\\x.cmd"');
    assert.equal(cmdArg('a&b'), '"a&b"');
    assert.equal(cmdArg('say "hi"'), '"say hi"');
    assert.equal(cmdArg(''), '""');
  });
});
