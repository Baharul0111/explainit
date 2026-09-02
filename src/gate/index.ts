/**
 * Gate module factory (CONTRACTS "Factories"): the loopback server + the decision flow.
 */
import type { Disposable, EventLike, GateDeps, GateServer, GateSessionInfo, HookEnvelope, Listener, SafetyKit } from '../core/interfaces';
import type { GateRequest, HookDecision } from '../core/types';
import { GateController } from './controller';
import { GateHttpServer } from './server';

export const HEARTBEAT_MS = 5_000;

export function createGateServer(deps: GateDeps & { safetyFor: (path: string) => SafetyKit | undefined; disposables: Disposable[] }): GateServer {
  const controller = new GateController(deps);
  const server = new GateHttpServer({
    logger: deps.logger,
    version: deps.version,
    folders: deps.workspaceFolders,
    paused: () => controller.paused,
    handle: (envelope, requestId) => controller.handle(envelope, requestId),
    disposables: deps.disposables,
  });

  const heartbeatListeners = new Set<Listener<{ ts: string; pending: number }>>();
  const sameFolders = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  const beat = (): void => {
    // Workspace folders can change while the window lives; the hook script picks its session by folder.
    const info = server.info;
    if (info) {
      try {
        if (!sameFolders(info.folders, deps.workspaceFolders())) server.refreshFolders();
      } catch (err) {
        deps.logger.warn('could not refresh the session folders', err);
      }
    }
    const e = { ts: new Date().toISOString(), pending: controller.pending };
    for (const l of heartbeatListeners) {
      try {
        l(e);
      } catch (err) {
        deps.logger.warn('heartbeat listener failed', err);
      }
    }
  };
  const interval = setInterval(beat, HEARTBEAT_MS);
  interval.unref?.();
  deps.disposables.push({ dispose: () => clearInterval(interval) });

  const onHeartbeat: EventLike<{ ts: string; pending: number }> = (listener) => {
    heartbeatListeners.add(listener);
    return { dispose: () => heartbeatListeners.delete(listener) };
  };
  const onRequest: EventLike<GateRequest> = (listener) => controller.onRequest(listener);

  const gate: GateServer = {
    async start(): Promise<GateSessionInfo> {
      const info = await server.start();
      beat();
      return info;
    },
    stop: () => server.stop(),
    get info() {
      return server.info;
    },
    setPaused: (p) => {
      controller.setPaused(p);
      beat();
    },
    get paused() {
      return controller.paused;
    },
    onRequest,
    onHeartbeat,
    handle: (envelope: HookEnvelope): Promise<HookDecision> => controller.handle(envelope),
  };
  return gate;
}

export { GateController, IngressValidationError } from './controller';
export { GateHttpServer } from './server';
