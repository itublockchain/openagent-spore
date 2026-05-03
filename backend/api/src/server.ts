import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import Dockerode from 'dockerode';
import { IStoragePort, INetworkPort } from '../../../shared/ports';
import { AgentManager } from './AgentRunner';
import { CentralComputeProxy } from './CentralComputeProxy';
import { TaskSchema, AgentPrepareSchema, AgentDeploySchema, AgentIdParamsSchema, AgentWithdrawSchema, AgentTopupSchema } from './schemas';
import { ethers } from 'ethers';
import DAGRegistryABI from '../../../contracts/artifacts/src/DAGRegistry.sol/DAGRegistry.json';
import deployments from '../../../contracts/deployments/og_testnet.json';
import { getChainClient, USDC_DECIMALS, sendWithNonceRetry } from './v1/chain';
import { EventType } from '../../../shared/types';
import { generateNonce, SiweMessage } from 'siwe'
import jwt from 'jsonwebtoken'
import { KeyStore } from './v1/keystore'
import { TaskIndex } from './v1/tasksIndex'
import { TaskStateStore } from './v1/taskStateStore'
import { ColonyStore } from './v1/colonyStore'
import { registerColoniesRoutes } from './v1/coloniesRoutes'
import { registerKeysRoutes } from './v1/keysRoutes'
import { registerTasksRoutes } from './v1/tasksRoutes'
import { registerBalanceRoutes } from './v1/balanceRoutes'
import { registerAgentsRoutes } from './v1/agentsRoutes'
import { registerProfileRoutes } from './v1/profileRoutes'
import { registerWithdrawRoutes } from './v1/withdrawRoutes'
import { registerCctpRoutes } from './v1/cctpRoutes'
import { BridgeWatcher } from './BridgeWatcher'
import { CCTPRelayer } from './CCTPRelayer'
import { SlashWatcher } from './SlashWatcher'
import { registerSporeiseRoutes } from './v1/sporeiseRoutes'

const DEFAULT_JWT_SECRET = 'swarm-dev-secret'
const JWT_SECRET = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
  throw new Error('[API] JWT_SECRET must be set to a non-default value in production')
}
const nonces = new Map<string, number>() // nonce → expiry

export interface ServerDeps {
  storage: IStoragePort;
  network: INetworkPort;
  manager: AgentManager;
  /**
   * Optional shared compute proxy. Mounted only when COMPUTE_MODE=central.
   * Agents in central mode hit /internal/compute/chat which forwards here.
   */
  computeProxy?: CentralComputeProxy;
}

export default async function createServer(deps: ServerDeps) {
  const fastify = Fastify({
    logger: true,
    ignoreTrailingSlash: true
  });

  // Global request logger
  fastify.addHook('onRequest', async (request) => {
    console.log(`[BACKEND] Incoming request: ${request.method} ${request.url}`);
  });

  // SQLite-backed mirror of every per-task / per-node lifecycle event.
  // Replaces two ex-in-memory Maps (`taskResults` + `dagCache`) so a server
  // crash / redeploy doesn't lose:
  //   - per-node final answers + reasoning trace + tool list
  //   - DAG ordering and per-node status (idle/claimed/pending/done/failed)
  // KeyStore + TaskIndex open the same SQLite file later — WAL mode lets
  // all three connections coexist without locking.
  const dbPath = process.env.API_DB_PATH ?? '/data/api.db'
  const taskState = new TaskStateStore({ dbPath })

  // Per-task plannerAgentId — small enough to keep in-memory (handful of
  // bytes per active task, reset on restart is fine because the next
  // PLANNER_SELECTED rebuilds it).
  const plannerByTask = new Map<string, string | undefined>()

  // Read shim so legacy code paths that expect `{ nodes: [{nodeId, result}] }`
  // get a fresh slice from SQLite without holding a stale in-memory copy.
  const taskResultsView = (taskId: string) => {
    const nodes = taskState.listResults(taskId)
    return nodes.length > 0 ? { nodes } : null
  }

  deps.network.on(EventType.DAG_READY, (event: any) => {
    const { taskId, nodes, plannerAgentId } = event.payload ?? {}
    if (!taskId || !Array.isArray(nodes)) return
    taskState.seedDag(
      taskId,
      nodes.map((n: any) => ({ id: n.id, subtask: n.subtask })),
    )
    if (plannerAgentId) {
      plannerByTask.set(taskId, plannerAgentId)
      // Persist for restart-survival. taskIndex is initialised below this
      // listener — guard the call so the seed events that arrive in the
      // ~ms-window before init don't crash. After init the call is cheap
      // (UPDATE … WHERE planner_id IS NULL) and idempotent.
      try {
        taskIndex?.setPlanner(taskId, plannerAgentId)
      } catch (err) {
        console.warn(`[server] taskIndex.setPlanner failed for ${taskId}:`, err)
      }
    }
  })

  deps.network.on(EventType.SUBTASK_CLAIMED, (event: any) => {
    const { taskId, nodeId, agentId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'claimed', agentId })
  })

  deps.network.on(EventType.SUBTASK_VALIDATED, (event: any) => {
    const { taskId, nodeId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'done' })
  })

  deps.network.on(EventType.SUBTASK_PEER_VALIDATED, (event: any) => {
    const { taskId, nodeId } = event.payload ?? {}
    if (taskId && nodeId) taskState.setStatus(taskId, nodeId, { status: 'done' })
  })

  // Persist task completion to SQLite as soon as the planner-keeper emits
  // DAG_COMPLETED with settled=true. This is what makes profile/page
  // remember the "completed" status across API restarts — taskResults
  // (in-memory) is what derives status today, and a process restart
  // empties it, leaving every previously-completed task showing as
  // "pending" until SUBTASK_DONE events fire again (which they don't,
  // because the task is already over).
  deps.network.on(EventType.DAG_COMPLETED, (event: any) => {
    const { taskId, result, settled } = event.payload ?? {}
    if (!taskId || !settled) return
    try {
      taskIndex.markCompleted(taskId, undefined, result)
    } catch (err) {
      console.warn(`[server] markCompleted failed for ${taskId}:`, err)
    }
  })

  // Per-owner task index — same dbPath as taskState/KeyStore.
  const taskIndex = new TaskIndex({ dbPath })

  // SUBTASK_DONE → persist EVERYTHING the agent broadcast (final answer,
  // transcript, tool list, iteration counters). This is the row that
  // makes "agent logs uçar" no longer true — even if the API process
  // dies the next instant, every detail is on disk.
  deps.network.on(EventType.SUBTASK_DONE, (event: any) => {
    const p = event.payload ?? {}
    if (!p.taskId || !p.nodeId || !p.result) return
    try {
      taskState.recordResult({
        taskId: p.taskId,
        nodeId: p.nodeId,
        result: p.result,
        outputHash: p.outputHash,
        agentId: p.agentId,
        transcript: p.transcript,
        iterations: p.iterations,
        stopReason: p.stopReason,
        toolsUsed: p.toolsUsed,
      })
    } catch (err) {
      console.warn(`[server] taskState.recordResult failed for ${p.taskId}/${p.nodeId}:`, err)
    }
  })

  // Global event log — records every broadcasted event to the DB so
  // terminal output can be replayed after a refresh or restart.
  deps.network.on('*', (event: any) => {
    const taskId = event.payload?.taskId
    if (taskId) {
      taskState.recordEvent(taskId, event.type, event.payload)
    }
  })

  // JWT helpers — declared early so all routes can use them
  function verifyJWT(token: string): { address: string; chainId: number } | null {
    try {
      return jwt.verify(token, JWT_SECRET) as any
    } catch {
      return null
    }
  }
  function requireAuth(request: any, reply: any): { address: string; chainId: number } | null {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Unauthorized' })
      return null
    }
    const user = verifyJWT(authHeader.slice(7))
    if (!user) {
      reply.status(401).send({ error: 'Invalid token' })
      return null
    }
    return user
  }

  // CORS allow-list — accept comma-separated origins via env in production
  const corsEnv = process.env.CORS_ORIGINS?.trim()
  const corsOrigins: string[] | true = corsEnv
    ? corsEnv.split(',').map(s => s.trim()).filter(Boolean)
    : true
  if (process.env.NODE_ENV === 'production' && corsOrigins === true) {
    throw new Error('[API] CORS_ORIGINS must be set to an explicit allow-list in production')
  }
  await fastify.register(cors, {
    origin: corsOrigins,
  });

  await fastify.register(websocket);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  /**
   * POST /internal/compute/chat
   * Shared 0G Compute relay for agents running with COMPUTE_MODE=central.
   * Agent passes messages + maxTokens, proxy forwards to a pooled broker
   * wallet on the API host. NOT user-facing — only agents on the
   * swarm_default Docker network reach this; outside the network it's
   * unreachable.
   */
  if (deps.computeProxy) {
    fastify.post('/internal/compute/chat', async (request, reply) => {
      const body = (request.body ?? {}) as {
        messages?: Array<{ role: string; content: string }>
        maxTokens?: number
        temperature?: number
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.status(400).send({ error: 'messages[] required' })
      }
      try {
        const content = await deps.computeProxy!.chat(
          body.messages,
          body.maxTokens ?? 1024,
          typeof body.temperature === 'number' ? body.temperature : 0.3,
        )
        return { content }
      } catch (err: any) {
        console.error('[/internal/compute/chat] error:', err)
        return reply.status(502).send({ error: err?.message ?? String(err) })
      }
    });
  }

  /**
   * POST /internal/execute
   * Sandbox runtime for the CodeExecutor agent tool. Spawns an ephemeral
   * container with `NetworkMode: none` so even an LLM-generated exfiltration
   * attempt has nowhere to send data. 30s wall timeout. Output capped.
   *
   * NOT user-facing — only reachable from inside the swarm_default Docker
   * network (i.e. agent containers). The agent's own network does not have
   * docker-proxy access; that's why this endpoint exists rather than letting
   * the agent spawn containers directly.
   */
  const execDocker = process.env.DOCKER_HOST
    ? new Dockerode({
      host: process.env.DOCKER_HOST.replace('tcp://', '').split(':')[0],
      port: Number(process.env.DOCKER_HOST.split(':').pop()) || 2375,
    })
    : new Dockerode({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

  const EXEC_IMAGES: Record<'python' | 'javascript', string> = {
    python: 'python:3.11-alpine',
    javascript: 'node:22-alpine',
  };
  const EXEC_TIMEOUT_MS = 30_000;
  const EXEC_OUTPUT_LIMIT = 8_000; // chars

  // Pre-pull sandbox images at boot so the first execute_code call doesn't
  // 404 with "no such image". Non-blocking — server can serve other routes
  // while pulls run in the background. Most LLM-driven tasks reach
  // execute_code only after planning + claim + chain tx (~30s) which is
  // plenty of head-start for a ~10MB alpine pull.
  void (async () => {
    for (const ref of Object.values(EXEC_IMAGES)) {
      try {
        await execDocker.getImage(ref).inspect()
        console.log(`[Docker] sandbox image ready: ${ref}`)
      } catch {
        console.log(`[Docker] pulling sandbox image: ${ref}...`)
        try {
          await new Promise<void>((resolve, reject) => {
            execDocker.pull(ref, (err: any, stream: any) => {
              if (err) return reject(err)
              execDocker.modem.followProgress(stream, (e: any) => (e ? reject(e) : resolve()))
            })
          })
          console.log(`[Docker] sandbox image pulled: ${ref}`)
        } catch (err) {
          console.warn(`[Docker] failed to pull ${ref} (execute_code calls for that runtime will 404 until a manual pull):`, err)
        }
      }
    }
  })()

  // Concurrency caps for sandbox container spawns. Each running container
  // reserves 256 MiB; without these limits an LLM in a tight loop could
  // exhaust the host. Per-agent cap protects against a single misbehaving
  // agent; the global cap protects against a fleet collectively saturating
  // the daemon.
  const EXEC_MAX_PER_AGENT = 2;
  const EXEC_MAX_TOTAL = 8;
  const inflightExec = new Map<string, number>();
  let totalInflight = 0;

  fastify.post('/internal/execute', async (request, reply) => {
    const { code, language, agentId } = (request.body ?? {}) as {
      code?: string;
      language?: string;
      agentId?: string;
    };
    if (!code || (language !== 'python' && language !== 'javascript')) {
      return reply.status(400).send({ error: 'code + language (python|javascript) required' });
    }
    const aid = agentId?.trim() || 'unknown';

    if (totalInflight >= EXEC_MAX_TOTAL) {
      reply.header('Retry-After', '5');
      return reply.status(429).send({ error: `Sandbox saturated (${totalInflight}/${EXEC_MAX_TOTAL}), retry later` });
    }
    const cur = inflightExec.get(aid) ?? 0;
    if (cur >= EXEC_MAX_PER_AGENT) {
      reply.header('Retry-After', '5');
      return reply.status(429).send({ error: `Agent ${aid}: too many concurrent executions (${cur}/${EXEC_MAX_PER_AGENT})` });
    }
    inflightExec.set(aid, cur + 1);
    totalInflight++;

    const image = EXEC_IMAGES[language as 'python' | 'javascript'];
    const cmd =
      language === 'python'
        ? ['python', '-c', code as string]
        : ['node', '-e', code as string];

    let container: Dockerode.Container | null = null;
    let timedOut = false;
    try {
      container = await execDocker.createContainer({
        Image: image,
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
          NetworkMode: 'none',
          AutoRemove: false,
          Memory: 256 * 1024 * 1024, // 256 MiB
          PidsLimit: 64,
        },
      });

      // Stream output before start so we don't miss the first bytes.
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      // Demux Docker's multiplexed stream manually (no Tty).
      execDocker.modem.demuxStream(
        stream,
        { write: (b: Buffer) => { stdoutChunks.push(Buffer.from(b)) } } as any,
        { write: (b: Buffer) => { stderrChunks.push(Buffer.from(b)) } } as any,
      );

      await container.start();

      const timer = setTimeout(() => {
        timedOut = true;
        container?.kill().catch(() => { });
      }, EXEC_TIMEOUT_MS);

      const wait = await container.wait();
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').slice(0, EXEC_OUTPUT_LIMIT);
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, EXEC_OUTPUT_LIMIT);

      return { stdout, stderr, exitCode: wait.StatusCode ?? -1, timedOut };
    } catch (err: any) {
      console.error('[/internal/execute] error:', err);
      return reply.status(500).send({ error: err?.message ?? String(err) });
    } finally {
      if (container) {
        try { await container.remove({ force: true }); } catch { }
      }
      const next = (inflightExec.get(aid) ?? 1) - 1;
      if (next <= 0) inflightExec.delete(aid);
      else inflightExec.set(aid, next);
      totalInflight = Math.max(0, totalInflight - 1);
    }
  });

  // GET /auth/nonce
  fastify.get('/auth/nonce', async () => {
    const nonce = generateNonce()
    nonces.set(nonce, Date.now() + 5 * 60 * 1000) // 5 dakika
    return { nonce }
  })

  // POST /auth/verify
  fastify.post('/auth/verify', async (request, reply) => {
    const { message, signature } = request.body as any

    try {
      const siwe = new SiweMessage(message)

      // Nonce kontrolü
      const expiry = nonces.get(siwe.nonce)
      if (!expiry || expiry < Date.now()) {
        return reply.status(401).send({ error: 'Invalid or expired nonce' })
      }

      const { data, error } = await siwe.verify({ signature })

      if (error || !data) {
        return reply.status(401).send({ error: 'Invalid signature' })
      }

      // Nonce kullanıldı, sil
      nonces.delete(siwe.nonce)

      // JWT oluştur
      const token = jwt.sign(
        { address: data.address, chainId: data.chainId },
        JWT_SECRET,
        { expiresIn: '24h' }
      )

      return { token, address: data.address }
    } catch (err) {
      console.error('[AUTH] Verify error:', err)
      return reply.status(401).send({ error: 'Auth failed' })
    }
  })

  // Shared L2 helpers — read-only RPC for DAG state lookups.
  const rpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
  const readProvider = new ethers.JsonRpcProvider(rpcUrl);
  const dagRegistryAddr = process.env.L2_DAG_REGISTRY_ADDRESS || deployments.DAGRegistry;
  const readDagRegistry = new ethers.Contract(dagRegistryAddr, DAGRegistryABI.abi, readProvider);

  function deriveTaskId(specHash: string): string {
    return specHash.startsWith('0x') && specHash.length === 66
      ? specHash
      : ethers.keccak256(ethers.toUtf8Bytes(specHash));
  }

  /**
   * POST /task
   * Backend-relayed task submission for the explorer's browser flow.
   * Debits the user's Treasury balance via operator-signed
   * `spendOnBehalfOf` and broadcasts to AXL. The user signs nothing
   * on-chain — they only proved ownership of the address via SIWE.
   */
  fastify.post('/task', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return

    const body = TaskSchema.parse(request.body);
    const specHash = await deps.storage.append(body);
    const taskIdBytes32 = deriveTaskId(specHash);

    const { readTreasury, writeTreasury, treasuryAddr, operatorAddress } = getChainClient();
    if (!writeTreasury || !operatorAddress) {
      return reply.status(503).send({ error: 'Operator wallet not configured', code: 'OPERATOR_DOWN' });
    }

    let budgetWei: bigint;
    try {
      budgetWei = ethers.parseUnits(body.budget, USDC_DECIMALS);
    } catch {
      return reply.status(400).send({ error: 'Invalid budget format' });
    }
    if (budgetWei <= 0n) {
      return reply.status(400).send({ error: 'Budget must be > 0' });
    }

    // Pre-flight balance — clean 402 before sending the spend tx.
    let balance: bigint;
    try {
      balance = (await readTreasury.balanceOf(user.address)) as bigint;
    } catch (err) {
      console.error('[L2] Treasury read failed:', err);
      return reply.status(502).send({ error: 'L2 RPC unreachable', code: 'RPC_DOWN' });
    }
    if (balance < budgetWei) {
      return reply.status(402).send({
        error: 'Insufficient Treasury balance',
        code: 'INSUFFICIENT_BALANCE',
        balance: ethers.formatUnits(balance, USDC_DECIMALS),
        required: body.budget,
      });
    }

    // Operator signs spendOnBehalfOf → Treasury debits user, Escrow records task.
    // Wrap in sendWithNonceRetry: the operator NonceManager can drift out
    // of sync with chain when external txs share the same key (e.g. an
    // agent container reusing PRIVATE_KEY) — without retry the user sees
    // a hard "nonce has already been used" 400 even though their submit
    // is fine. The helper does up-to-3 retries with NonceManager.reset()
    // between attempts so the next send re-fetches the chain `pending`
    // value and aligns.
    let treasuryTxHash: string;
    try {
      const tx = await sendWithNonceRetry('treasury.spendOnBehalfOf', () =>
        writeTreasury.spendOnBehalfOf(user.address, taskIdBytes32, budgetWei),
      );
      const receipt = await tx.wait();
      treasuryTxHash = receipt?.hash ?? tx.hash;
    } catch (err: any) {
      const reason = err?.shortMessage ?? err?.reason ?? err?.message ?? 'unknown';
      console.error('[L2] spendOnBehalfOf failed:', reason);
      const status = /insufficient/i.test(reason) ? 402 : 400;
      return reply.status(status).send({ error: reason, code: 'TX_REVERTED' });
    }
    console.log(`[L2] /task spendOnBehalfOf user=${user.address} task=${taskIdBytes32.slice(0, 12)} tx=${treasuryTxHash}`);

    // Colony scope authorization. If the task is tagged with a colonyId,
    // verify the caller is allowed to dispatch there:
    //   private  → only the colony owner can submit
    //   public   → anyone can submit
    //   missing  → 404, can't route to a non-existent colony
    if (body.colonyId) {
      const colony = colonyStore.get(body.colonyId)
      if (!colony || colony.archivedAt) {
        return reply.status(404).send({ error: 'Colony not found', colonyId: body.colonyId });
      }
      if (colony.visibility === 'private' && colony.owner !== user.address.toLowerCase()) {
        return reply.status(403).send({
          error: 'Colony is private — only its owner can submit tasks here',
          colonyId: body.colonyId,
        });
      }
    }

    const event = {
      type: EventType.TASK_SUBMITTED,
      payload: { ...body, taskId: specHash, specHash, submittedBy: user.address },
      timestamp: Date.now(),
      agentId: 'api-server'
    };

    await deps.network.emit(event);

    // Stamp the per-owner index so /v1/me/tasks can list this task on
    // the profile page. INSERT OR IGNORE — re-broadcasts of the same
    // content-addressed spec keep the original row.
    try {
      taskIndex.record({
        taskId: specHash,
        owner: user.address,
        spec: body.spec,
        budget: body.budget,
        source: 'web',
        model: (body as any).model ?? null,
        colonyId: body.colonyId ?? null,
      })
    } catch (err) {
      // Index failure must never block /task — log + continue.
      console.warn('[API] taskIndex.record failed (non-fatal):', err)
    }

    return { taskId: specHash, taskIdBytes32, treasuryTxHash };
  });

  /**
   * POST /agent/prepare
   * Validates the user has enough Treasury balance, mints a fresh wallet,
   * prefunds gas, commits the stake on-chain (Treasury debit + Escrow
   * agent credit). User signs nothing — the operator handles all moves.
   */
  fastify.post('/agent/prepare', async (request: any, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const body = AgentPrepareSchema.parse(request.body)
    try {
      const result = await deps.manager.prepare({
        name: body.name,
        model: body.model,
        stakeAmount: body.stakeAmount,
        systemPrompt: body.systemPrompt,
        ownerAddress: user.address,
      })
      return result;
    } catch (err) {
      console.error('[API] /agent/prepare failed:', err)
      return reply.status(500).send({ error: (err as Error).message })
    }
  });

  // POST /agent/deploy — spawns the container; stake was already committed in /agent/prepare.
  fastify.post('/agent/deploy', async (request: any, reply) => {
    if (!requireAuth(request, reply)) return
    const body = AgentDeploySchema.parse(request.body)
    try {
      const record = await deps.manager.deploy(body.agentId)
      return { containerId: record.containerId, agentId: record.agentId, agentAddress: record.agentAddress }
    } catch (err) {
      const msg = (err as Error).message
      console.error('[API] /agent/deploy failed:', msg)
      // Stake-not-arrived case is a 402 (Payment Required) — UI should retry
      // after the transfer confirms.
      const status = msg.includes('Transfer USDC') ? 402 : 500
      return reply.status(status).send({ error: msg })
    }
  });

  // GET /agent/pool
  fastify.get('/agent/pool', async () => {
    const list = await deps.manager.list();
    // Hydrate each agent with its colony memberships so the pool page can
    // cluster agents into colony sections without N+1 fetches. SQLite
    // listColoniesForAgent is a single indexed query per agent — fine for
    // demo-scale N. colonyStore is declared further down in createServer;
    // the closure resolves it lazily on request, by which time init ran.
    return list.map(a => ({
      ...a,
      colonies: colonyStore.listColoniesForAgent(a.agentId),
    }));
  });

  // GET /task/:taskId
  // Owner-scoped: only the wallet that submitted the task may read its DAG /
  // results. Anyone hitting a deep link without auth (or with a non-owner
  // wallet) gets a 403 and the explorer flips into the "unauthorized" empty
  // state. Live state is reconstructed by frontend via WebSocket.
  fastify.get('/task/:taskId', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { taskId } = request.params as any;
    const owner = resolveTaskOwner(taskId)
    if (!owner) {
      // Unknown task — return 404 instead of 403 so we don't leak the
      // existence of arbitrary taskIds via timing/error-code probes.
      reply.code(404)
      return { error: 'Task not found', taskId }
    }
    if (owner !== user.address.toLowerCase()) {
      reply.code(403)
      return { error: 'Forbidden — not the task owner', code: 'FORBIDDEN' }
    }
    let task: unknown = null
    try {
      task = await deps.storage.fetch(taskId);
    } catch (err) {
      // Storage miss is non-fatal — DB may still have a DAG snapshot for
      // a task whose spec we can't fetch (storage retried out).
      console.warn(`[GET /task/${taskId}] storage.fetch failed:`, err)
    }

    // Primary: SQLite-backed DAG snapshot. Survives API restarts.
    // Surface the full reasoning payload (result + transcript + counters)
    // so a deep-link reload repaints the explorer's per-node detail panel
    // without a separate fetch. JSON columns are parsed defensively —
    // bad rows fall back to undefined rather than 500-ing the whole task.
    const safeJsonParse = <T>(raw: string | null): T | undefined => {
      if (!raw) return undefined
      try { return JSON.parse(raw) as T } catch { return undefined }
    }
    let dagNodes = taskState.getDag(taskId).map(n => ({
      id: n.nodeId,
      subtask: n.subtask ?? '',
      status: n.status,
      agentId: n.agentId ?? undefined,
      outputHash: n.outputHash ?? undefined,
      result: n.result ?? undefined,
      transcript: safeJsonParse<unknown[]>(n.transcriptJson),
      toolsUsed: safeJsonParse<string[]>(n.toolsUsedJson),
      iterations: n.iterations ?? undefined,
      stopReason: n.stopReason ?? undefined,
    }))

    // Chain-fallback rebuild. If the DB has no rows (typical for tasks
    // whose live events fired before this DB existed) walk DAGRegistry,
    // then seed the rows so subsequent reads are cheap.
    if (dagNodes.length === 0) {
      try {
        const rebuilt = await rebuildDagFromChain(taskId)
        if (rebuilt && rebuilt.nodes.length > 0) {
          // Persist what we rebuilt so the next reader hits SQLite, not RPC.
          taskState.seedDag(
            taskId,
            rebuilt.nodes.map(n => ({ id: n.id, subtask: n.subtask })),
          )
          for (const n of rebuilt.nodes) {
            taskState.setStatus(taskId, n.id, {
              status: n.status,
              agentId: n.agentId,
              outputHash: n.outputHash,
            })
          }
          if (rebuilt.plannerAgentId) plannerByTask.set(taskId, rebuilt.plannerAgentId)
          // Chain rebuild can't recover the reasoning payload (transcript /
          // tools / counters live only in 0G Storage at outputHash); leave
          // those undefined so the primary-path shape still matches.
          dagNodes = rebuilt.nodes.map(n => ({
            id: n.id,
            subtask: n.subtask,
            status: n.status,
            agentId: n.agentId,
            outputHash: n.outputHash,
            result: undefined,
            transcript: undefined,
            toolsUsed: undefined,
            iterations: undefined,
            stopReason: undefined,
          }))
        }
      } catch (err) {
        console.warn(`[GET /task/${taskId}] chain rebuild failed:`, err)
      }
    }

    if (!task && dagNodes.length === 0) {
      reply.code(404)
      return { error: 'Task not found in storage or DB', taskId }
    }

    // Planner resolution. Prefer the in-memory cache (live tasks), fall
    // back to the persisted column on the user_tasks row (deep-link
    // reload after restart), and last to the chain-rebuild we just did.
    // Without the DB fallback the explorer shows "Awaiting planner…"
    // forever for any task whose DAG_READY fired in a prior process.
    const indexRow = taskIndex.listForOwner(user.address, 200).find(r => r.taskId === taskId)
    const plannerAgentId =
      plannerByTask.get(taskId) ?? indexRow?.plannerId ?? undefined

    // Slash overlay. Each row tells the UI which node was slashed, why,
    // how much, and (when known) the local agentId so the explorer can
    // still resolve the agent's display name. Empty array = clean run.
    let slashes: ReturnType<typeof taskState.getSlashesForTask> = []
    try {
      slashes = taskState.getSlashesForTask(taskId)
    } catch (err) {
      console.warn(`[GET /task/${taskId}] getSlashesForTask failed:`, err)
    }
    const plannerSlashed = plannerAgentId
      ? slashes.find(s => s.agentId === plannerAgentId)
      : undefined

    return {
      ...(task as any ?? {}),
      // useSwarmEvents.fetchState reads data.dag.nodes — keep the shape.
      dag: dagNodes.length > 0
        ? { nodes: dagNodes, plannerAgentId }
        : null,
      // Historical event log for replaying terminal output in the explorer.
      events: taskState.getEvents(taskId),
      // Per-task slash overlay + planner state. Frontend renders these
      // into red node badges + a "Planner slashed: <reason>" banner
      // without needing to replay the whole event timeline.
      slashes: slashes.map(s => ({
        node_id: s.nodeId,
        agent_id: s.agentId,
        agent_address: s.agentAddress,
        amount: s.amount,
        reason: s.reason,
        slashed_at: s.slashedAt,
      })),
      planner: plannerAgentId
        ? {
            agent_id: plannerAgentId,
            slashed: !!plannerSlashed,
            slash_reason: plannerSlashed?.reason ?? null,
            slash_amount: plannerSlashed?.amount ?? null,
          }
        : null,
    };
  });

  /**
   * Reconstruct a DAG from on-chain DAGRegistry state when the in-memory
   * cache has nothing — typical after an API restart for a task whose
   * DAG_READY / SUBTASK_DONE events fired in a previous process.
   *
   * Walks each registered node, derives its UI status from the chain
   * struct, and (for nodes with a recorded outputHash) fetches the stored
   * payload to recover the subtask description. Returns null when the
   * registry has no entry for this taskId.
   */
  // Local node shape used only inside the chain-rebuild path. Same fields
  // we feed into `taskState.setStatus` afterwards so the rebuild can
  // hydrate the DB row in one pass.
  type RebuiltDagNode = {
    id: string
    subtask: string
    status: 'idle' | 'claimed' | 'pending' | 'done' | 'failed'
    agentId?: string
    outputHash?: string
  }
  async function rebuildDagFromChain(
    taskId: string,
  ): Promise<{ nodes: RebuiltDagNode[]; plannerAgentId?: string } | null> {
    const taskIdBytes32 = deriveTaskId(taskId)
    let nodeIds: string[]
    try {
      nodeIds = await readDagRegistry.getTaskNodes(taskIdBytes32) as string[]
    } catch (err) {
      console.warn(`[rebuildDag] getTaskNodes failed for ${taskId}:`, err)
      return null
    }
    if (!nodeIds || nodeIds.length === 0) return null

    const ZERO_BYTES32 = '0x' + '0'.repeat(64)
    const ZERO_ADDR = '0x' + '0'.repeat(40)

    const built: RebuiltDagNode[] = await Promise.all(nodeIds.map(async (nid: string, idx: number) => {
      // Read the on-chain DAGNode struct. Tuple positions:
      //   0: nodeId  1: taskId  2: claimedBy  3: outputHash  4: validated
      let claimedBy: string = ''
      let outputHashRaw: string = ZERO_BYTES32
      let validated = false
      try {
        const onchain = await readDagRegistry.nodes(nid) as any
        claimedBy = (onchain.claimedBy ?? onchain[2] ?? '').toString()
        outputHashRaw = (onchain.outputHash ?? onchain[3] ?? ZERO_BYTES32).toString()
        validated = !!(onchain.validated ?? onchain[4])
      } catch (err) {
        console.warn(`[rebuildDag] nodes() failed for ${nid}:`, err)
      }

      const hasOutput = outputHashRaw !== ZERO_BYTES32
      const isClaimed = claimedBy !== '' && claimedBy.toLowerCase() !== ZERO_ADDR

      let status: RebuiltDagNode['status'] = 'idle'
      if (validated) status = 'done'
      else if (hasOutput) status = 'pending'
      else if (isClaimed) status = 'claimed'

      // Subtask text isn't on-chain; recover it by reading the worker's
      // stored output payload (which contains the original subtask string)
      // when one exists. Falls back to a placeholder for un-executed nodes.
      let subtask = `(node ${idx + 1})`
      if (hasOutput) {
        try {
          const payload = await deps.storage.fetch(outputHashRaw) as any
          if (payload && typeof payload.subtask === 'string') {
            subtask = payload.subtask
          }
        } catch {
          // storage miss — keep placeholder
        }
      }

      return {
        id: nid,
        subtask,
        status,
        agentId: isClaimed ? claimedBy : undefined,
        outputHash: hasOutput ? outputHashRaw : undefined,
      }
    }))

    return { nodes: built, plannerAgentId: undefined }
  }

  /**
   * GET /result/:taskId
   * Returns the aggregated subtask results for a completed task.
   * Results are collected from SUBTASK_DONE events broadcast by agents.
   * Owner-scoped — same gate as /task/:taskId so the legacy endpoint
   * doesn't sidestep the privacy model.
   */
  fastify.get('/result/:taskId', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { taskId } = request.params as any;
    const owner = resolveTaskOwner(taskId)
    if (!owner) {
      reply.code(404)
      return { error: 'Task not found', taskId }
    }
    if (owner !== user.address.toLowerCase()) {
      reply.code(403)
      return { error: 'Forbidden — not the task owner', code: 'FORBIDDEN' }
    }
    const result = taskResultsView(taskId);
    if (!result) {
      reply.code(404)
      return { error: 'No results yet for task: ' + taskId }
    }
    // Combine all node results into a single string
    const combined = result.nodes
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(n => `=== ${n.nodeId} ===\n${n.result}`)
      .join('\n\n')
    return { taskId, nodes: result.nodes, combined }
  });

  // DELETE /agent/:id
  fastify.delete('/agent/:id', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    // Owner check — DELETE drains the wallet to the requester, so let only
    // the registered owner trigger it. Stale or external agentIds (no
    // matching secret) fall through to a best-effort container stop.
    const secret = deps.manager.getSecretMeta(id);
    if (secret?.ownerAddress &&
      secret.ownerAddress.toLowerCase() !== user.address.toLowerCase()) {
      return reply.status(403).send({ error: 'Only the owner can stop this agent' })
    }
    const result = await deps.manager.stop(id);
    return { ok: true, drained: result.drained ?? null };
  });

  /**
   * POST /agent/:id/withdraw
   * Owner pulls USDC from an agent's wallet without stopping it. Optional
   * { amount } body — omit to drain the full USDC balance. Native OG stays
   * with the agent so it can keep paying tx gas; use DELETE /agent/:id to
   * also reclaim OG.
   */
  fastify.post('/agent/:id/withdraw', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    const body = AgentWithdrawSchema.parse(request.body ?? {});
    try {
      const result = await deps.manager.withdraw(id, user.address, body.amount);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('Not authorized') ? 403
        : msg.includes('not found') ? 404
          : msg.includes('Invalid amount') || msg.includes('must be > 0') ? 400
            : 500;
      return reply.status(status).send({ error: msg });
    }
  });

  /**
   * POST /agent/:id/topup
   * Owner records a USDC deposit they just signed (USDC.transfer to
   * agentAddress). The transfer itself happens on the wallet side; this
   * endpoint just bumps the local stake floor so the surplus watchdog
   * doesn't immediately sweep the deposit back. Container is restarted
   * so the agent picks up the new floor.
   */
  fastify.post('/agent/:id/topup', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    const { id } = AgentIdParamsSchema.parse(request.params);
    const body = AgentTopupSchema.parse(request.body ?? {});
    try {
      const result = await deps.manager.recordDeposit(id, user.address, body.amount);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('Not authorized') ? 403
        : msg.includes('not found') ? 404
          : msg.includes('positive decimal') ? 400
            : 500;
      return reply.status(status).send({ error: msg });
    }
  });

  // ─── WebSocket per-task ownership cache ──────────────────────────
  // Lower-cased EOA → set of taskIds derived from TASK_SUBMITTED so WS
  // scoping doesn't hit SQLite for every forwarded event. Populated from
  // the AXL TASK_SUBMITTED handler (event.payload.submittedBy is set by
  // both /task and /v1/tasks). For tasks submitted before this process
  // started, the WS handler falls back to taskIndex.getOwner().
  const taskOwners = new Map<string, string>()

  deps.network.on(EventType.TASK_SUBMITTED, (event: any) => {
    const taskId = event.payload?.taskId
    const submittedBy = event.payload?.submittedBy
    if (typeof taskId === 'string' && typeof submittedBy === 'string') {
      taskOwners.set(taskId, submittedBy.toLowerCase())
    }
  })

  /**
   * Resolve the owner of a taskId for WS event scoping. Process cache first
   * (populated when TASK_SUBMITTED flowed through this instance), SQLite
   * fall-back for older tasks. Result cached so subsequent events for the
   * same task short-circuit. Returns null when unknown — caller decides
   * whether to broadcast or drop.
   */
  function resolveTaskOwner(taskId: string): string | null {
    const cached = taskOwners.get(taskId)
    if (cached) return cached
    const fromIndex = taskIndex.getOwner(taskId)
    if (fromIndex) {
      taskOwners.set(taskId, fromIndex)
      return fromIndex
    }
    return null
  }

  // WebSocket handler for event streaming.
  // Bridges AXL mesh events to the browser dashboard, but scopes them per
  // user so one submitter's events don't paint over every other connected
  // dashboard. JWT in `?token=` identifies the socket's owner; clients
  // subscribe to additional taskIds via `{type:'subscribe', taskId}` to
  // follow tasks they don't own (deep-link viewers, anonymous browsers).
  fastify.get('/ws', { websocket: true }, (connection: any, req) => {
    const socket = connection.socket || connection;

    // Token comes via query string because the browser WebSocket API
    // can't set Authorization headers. Anonymous (missing/invalid token)
    // is allowed — they just don't auto-receive personal events; they
    // must explicitly `subscribe` to anything they want to watch.
    let userAddress: string | null = null
    try {
      const url = new URL(req.url ?? '/ws', 'http://localhost')
      const token = url.searchParams.get('token')
      if (token) {
        const decoded = verifyJWT(token)
        if (decoded?.address) userAddress = decoded.address.toLowerCase()
      }
    } catch (err) {
      console.warn('[WS] token parse failed:', err)
    }

    const subscribedTaskIds = new Set<string>()
    console.log(`[WS] Client connected (user=${userAddress ?? 'anonymous'})`)

    const handlers: Map<string, (event: any) => void> = new Map();

    const send = (event: any) => {
      if (socket && (socket.readyState === 1 || socket.readyState === 'open')) {
        try {
          socket.send(JSON.stringify(event));
        } catch (err) {
          console.error('[WS] Send error:', err);
        }
      }
    };

    /**
     * Returns true when `event` should be delivered to this socket.
     * Events without a taskId are global (agent registry, colony
     * membership, etc.) and broadcast to everyone. Events with a taskId
     * go ONLY to the submitter or to clients that explicitly subscribed
     * to that task.
     */
    const shouldDeliver = (event: any): boolean => {
      const taskId = event?.payload?.taskId
      if (typeof taskId !== 'string' || taskId.length === 0) return true
      if (subscribedTaskIds.has(taskId)) return true
      // TASK_SUBMITTED carries submittedBy directly — use it before the
      // taskOwners cache catches up (the network.on handler above runs
      // in the same tick but order isn't guaranteed across fastify and
      // our local map writes).
      const direct = event.payload?.submittedBy
      if (typeof direct === 'string' && userAddress &&
          direct.toLowerCase() === userAddress) return true
      const owner = resolveTaskOwner(taskId)
      return owner !== null && owner === userAddress
    }

    Object.values(EventType).forEach(type => {
      const handler = (event: any) => {
        const now = Date.now();
        const diff = Math.abs(now - (event.timestamp || 0));
        if (diff >= 60000) {
          console.warn(`[WS] FILTERED: ${event.type} too old or clock drift (diff: ${diff}ms)`)
          return
        }
        if (!shouldDeliver(event)) return
        send(event);
      };
      handlers.set(type, handler);
      deps.network.on(type as EventType, handler);
    });

    socket.on('message', (raw: any) => {
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'subscribe' && typeof msg.taskId === 'string') {
        // Privacy gate: a task is visible only to its submitter. Anonymous
        // sockets can't subscribe to anything; authenticated sockets can
        // only subscribe to their own tasks. Unknown owner is treated as
        // forbidden too — without this, a probe could distinguish "task
        // doesn't exist" from "task isn't yours" via the rejection reason.
        const owner = resolveTaskOwner(msg.taskId)
        if (!owner || owner !== userAddress) {
          send({
            type: 'subscribe_rejected',
            payload: { taskId: msg.taskId, reason: 'forbidden' },
            timestamp: Date.now(),
            agentId: 'api-server',
          })
          return
        }
        subscribedTaskIds.add(msg.taskId)
      } else if (msg.type === 'unsubscribe' && typeof msg.taskId === 'string') {
        subscribedTaskIds.delete(msg.taskId)
      }
    })

    socket.on('close', () => {
      console.log('[WS] Client disconnected');
      handlers.forEach((handler, type) => {
        deps.network.off(type as EventType, handler);
      });
      handlers.clear();
      subscribedTaskIds.clear();
    });
  });

  // SDK surface — DB-backed key management + /v1/* endpoints. KeyStore
  // shares the SQLite file already opened above for taskIndex.
  const keyStore = new KeyStore({ dbPath })
  const sdkEnv: 'live' | 'test' = process.env.SDK_KEY_ENV === 'live' ? 'live' : 'test'

  // Webapp-driven (SIWE-JWT auth) — generate / list / revoke.
  await registerKeysRoutes(fastify, { keyStore, requireAuth, env: sdkEnv })

  // ColonyStore initialised early so /v1/tasks (SDK) can pass it in for
  // the privacy gate on colony-scoped task submissions. Same SQLite file
  // as KeyStore / TaskIndex.
  const colonyStore = new ColonyStore({ dbPath })

  // SDK-consumed (apiKeyAuth) — task submission, balance, agent pool.
  // Tasks/profile routes read results through `taskResultsAdapter` — same
  // `.get(taskId)` shape they used to consume, but every call hits the
  // SQLite-backed taskState instead of an in-memory map. A server crash
  // no longer drops result history; the adapter is a one-line shim.
  const taskResultsAdapter = {
    get(taskId: string) {
      return taskResultsView(taskId) ?? undefined
    },
  }

  await registerTasksRoutes(fastify, {
    keyStore,
    storage: deps.storage,
    network: deps.network,
    taskResults: taskResultsAdapter as any,
    taskIndex,
    colonyStore,
  })
  await registerBalanceRoutes(fastify, { keyStore })
  await registerAgentsRoutes(fastify, { keyStore, manager: deps.manager })

  // SIWE-JWT withdraw flow: debits Treasury on 0G, releases real USDC
  // on Base Sepolia. Operator wallet covers Base ETH gas; user pays a
  // flat USDC fee from their Treasury balance.
  await registerWithdrawRoutes(fastify, { requireAuth })

  // BridgeWatcher mirrors USDCGateway.Deposited AND CCTPDepositReceiver.Deposited
  // (Base) → Treasury.creditBalance (0G). Boots in the background — failure to
  // start is logged but does not block server startup; the watcher itself is
  // robust to disconnects/restarts.
  const bridgeWatcher = new BridgeWatcher()
  bridgeWatcher.start().catch(err => console.error('[server] BridgeWatcher start failed:', err))

  // CCTPRelayer drives Circle CCTP V2 cross-chain USDC deposits: source-chain
  // burn → Iris attestation → MessageTransmitterV2.receiveMessage on Base →
  // CCTPDepositReceiver hook emits Deposited → BridgeWatcher credits 0G.
  // We pass the BridgeWatcher reference so /v1/cctp/status can flip "relayed"
  // → "credited" based on the watcher's processedKeys set.
  const cctpRelayer = new CCTPRelayer(bridgeWatcher)
  cctpRelayer.start().catch(err => console.error('[server] CCTPRelayer start failed:', err))
  await registerCctpRoutes(fastify, { requireAuth, relayer: cctpRelayer })

  // Webapp profile (SIWE-JWT) — owner-scoped task history + per-task result.
  // taskState is passed so the DELETE routes can cascade-clean the dag /
  // events tables; onTaskDeleted prunes the in-memory caches so a deleted
  // task can't keep delivering events to its old owner over WS.
  await registerProfileRoutes(fastify, {
    taskIndex,
    requireAuth,
    taskResults: taskResultsAdapter as any,
    taskState,
    onTaskDeleted: (taskId) => {
      taskOwners.delete(taskId)
      plannerByTask.delete(taskId)
    },
  })

  // Colony surface — same SQLite file as KeyStore / TaskIndex. Two mounts:
  //   /v1/me/colonies — webapp (JWT). The resolver is a thin wrapper over
  //                     requireAuth that returns the resolved EOA, or null
  //                     if requireAuth already wrote a 401.
  //   /v1/colonies    — reserved for SDK (API-key auth). Mount it later by
  //                     calling registerColoniesRoutes again with an
  //                     apiKey-based resolveUser. The route file is
  //                     parameterised on prefix + resolver so the same
  //                     handlers serve both surfaces.
  await registerColoniesRoutes(fastify, {
    prefix: '/v1/me/colonies',
    store: colonyStore,
    manager: deps.manager,
    taskIndex,
    network: deps.network,
    resolveUser: async (req, reply) => {
      const user = requireAuth(req, reply)
      return user ? { address: user.address } : null
    },
  })

  // SDK mount — same handlers behind API-key auth. Inline resolver
  // mirrors apiKeyAuth's lookup so a missing/invalid key short-circuits
  // with the same JSON shape SDK consumers see on /v1/tasks/* errors.
  // Different prefix means the JWT and API-key surfaces never collide.
  await registerColoniesRoutes(fastify, {
    prefix: '/v1/colonies',
    store: colonyStore,
    manager: deps.manager,
    taskIndex,
    network: deps.network,
    resolveUser: async (req, reply) => {
      const header = req.headers.authorization
      if (!header || !header.startsWith('Bearer ')) {
        reply.status(401).send({ error: 'Missing API key', code: 'MISSING_KEY' })
        return null
      }
      const ctx = keyStore.lookup(header.slice(7).trim())
      if (!ctx) {
        reply.status(401).send({ error: 'Invalid or revoked API key', code: 'INVALID_KEY' })
        return null
      }
      return { address: ctx.userAddress }
    },
  })

  // SlashWatcher mirrors SwarmEscrow.Slashed events into colony cleanup —
  // a slashed agent loses trust, so we drop it from every colony it
  // belonged to and broadcast the removal so peer agents stop honouring
  // its membership immediately. Constructed here (not earlier) because we
  // need colonyStore + manager + network all initialised. Background
  // start: failure to boot is logged but does not block server startup,
  // matching BridgeWatcher's contract.
  const slashWatcher = new SlashWatcher({
    colonyStore,
    taskState,
    manager: deps.manager,
    network: deps.network,
  })
  slashWatcher.start().catch(err => console.error('[server] SlashWatcher start failed:', err))

  // Internal: agent self-reads its colony memberships every 30s. No auth —
  // only swarm_default Docker network can hit /internal/* endpoints. The
  // agentId path param is what the agent passes (it knows its own ID via
  // env); we just read SQLite by that key.
  fastify.get<{ Params: { agentId: string } }>('/internal/agents/:agentId/colonies', async (request) => {
    const { agentId } = request.params
    const colonyIds = colonyStore.listColoniesForAgent(agentId)
    return { colony_ids: colonyIds }
  })

  // Public colony discovery — no auth. Anyone (logged-in or not) can browse
  // public colonies for the explorer dropdown / pool grouping. Task
  // submission to a colony still requires auth + the visibility check
  // inside the /task and /v1/tasks handlers.
  fastify.get('/v1/colonies/public', async () => {
    const colonies = colonyStore.listPublic()
    return {
      colonies: colonies.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        owner: c.owner,
        created_at: c.createdAt,
        member_count: colonyStore.getMembers(c.id).length,
      })),
    }
  })

  console.log(`[API] SDK routes mounted (env=${sdkEnv})`)

  // Sporeise — managed-mode REST + WS for the SDK's `Spore` class. Reuses
  // the same KeyStore (apiKeyAuth) and storage port as the rest of /v1/*.
  await registerSporeiseRoutes(fastify, {
    keyStore,
    storage: deps.storage,
    dbPath,
  })

  return fastify;
}

