const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const url = require('url');

const app = express();
const server = http.createServer(app);

// Two WebSocket servers: browser clients & remote agents
const wssBrowser = new WebSocket.Server({ noServer: true });
const wssAgent = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3456;

app.use(express.static(path.join(__dirname, 'public')));

// ── Agent Data Store ─────────────────────────────
const agents = new Map(); // agentId -> { ws, name, platform, arch, hostname, data, lastSeen }

// Track which server each browser client is viewing
const browserClients = new Map(); // ws -> { selectedServer, intervalTimer, refreshMs }

// ── Handle HTTP upgrade to route WS by path ──────
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/agent') {
    wssAgent.handleUpgrade(request, socket, head, (ws) => {
      wssAgent.emit('connection', ws, request);
    });
  } else {
    wssBrowser.handleUpgrade(request, socket, head, (ws) => {
      wssBrowser.emit('connection', ws, request);
    });
  }
});

// ── Local Port Data Collection (same as before) ──

function parseNetstatWindows(output) {
  const lines = output.split('\n');
  const connections = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Active') || trimmed.startsWith('Proto')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;

    const proto = parts[0];
    const localAddress = parts[1];
    const foreignAddress = parts[2];
    const state = parts[3] || '';
    const pid = parts.length >= 5 ? parts[4] : '';

    const lastColon = localAddress.lastIndexOf(':');
    if (lastColon === -1) continue;

    const localIP = localAddress.substring(0, lastColon);
    const localPort = parseInt(localAddress.substring(lastColon + 1));
    if (isNaN(localPort)) continue;

    let remoteIP = '';
    let remotePort = '';
    if (foreignAddress && foreignAddress !== '*:*') {
      const rLastColon = foreignAddress.lastIndexOf(':');
      if (rLastColon !== -1) {
        remoteIP = foreignAddress.substring(0, rLastColon);
        remotePort = foreignAddress.substring(rLastColon + 1);
      }
    }

    const key = `${proto}-${localPort}-${localIP}-${foreignAddress}-${state}`;
    if (seen.has(key)) continue;
    seen.add(key);

    connections.push({
      proto: proto.toUpperCase(),
      localIP,
      localPort,
      remoteIP,
      remotePort,
      state: state || 'N/A',
      pid: pid || 'N/A'
    });
  }

  return connections;
}

function getProcessNames(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) { resolve({}); return; }

    const uniquePids = [...new Set(pids.filter(p => p && p !== 'N/A'))];
    if (uniquePids.length === 0) { resolve({}); return; }

    exec('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      const processMap = {};
      if (err) { resolve(processMap); return; }

      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/"([^"]+)","(\d+)"/);
        if (match) processMap[match[2]] = match[1];
      }
      resolve(processMap);
    });
  });
}

function getPortInfo() {
  return new Promise((resolve, reject) => {
    exec('netstat -ano', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, async (err, stdout) => {
      if (err) { reject(err); return; }

      const connections = parseNetstatWindows(stdout);
      const pids = connections.map(c => c.pid);
      const processMap = await getProcessNames(pids);

      for (const conn of connections) {
        conn.processName = processMap[conn.pid] || 'N/A';
      }

      const portMap = {};
      for (const conn of connections) {
        const key = conn.localPort;
        if (!portMap[key]) {
          portMap[key] = {
            port: conn.localPort,
            proto: conn.proto,
            states: {},
            connections: 0,
            processes: new Set(),
            pids: new Set(),
            localIPs: new Set()
          };
        }
        portMap[key].connections++;
        portMap[key].states[conn.state] = (portMap[key].states[conn.state] || 0) + 1;
        if (conn.processName !== 'N/A') portMap[key].processes.add(conn.processName);
        if (conn.pid !== 'N/A') portMap[key].pids.add(conn.pid);
        portMap[key].localIPs.add(conn.localIP);
        if (conn.proto && !portMap[key].proto.includes(conn.proto)) {
          portMap[key].proto += '/' + conn.proto;
        }
      }

      const ports = Object.values(portMap).map(p => ({
        ...p,
        processes: [...p.processes],
        pids: [...p.pids],
        localIPs: [...p.localIPs]
      }));

      const systemInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        uptime: os.uptime(),
        networkInterfaces: Object.entries(os.networkInterfaces()).reduce((acc, [name, infos]) => {
          acc[name] = infos.filter(i => !i.internal).map(i => ({ address: i.address, family: i.family }));
          return acc;
        }, {})
      };

      resolve({
        timestamp: new Date().toISOString(),
        systemInfo,
        summary: {
          totalPorts: ports.length,
          totalConnections: connections.length,
          listeningPorts: ports.filter(p => p.states['LISTENING']).length,
          establishedConnections: connections.filter(c => c.state === 'ESTABLISHED').length,
          timeWaitConnections: connections.filter(c => c.state === 'TIME_WAIT').length
        },
        ports: ports.sort((a, b) => a.port - b.port),
        connections: connections.sort((a, b) => a.localPort - b.localPort)
      });
    });
  });
}

// ── REST API ──────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  try {
    const data = await getPortInfo();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers', (req, res) => {
  res.json(getServerList());
});

// ── Server List Helper ────────────────────────────
function getServerList() {
  const list = [{
    id: 'local',
    name: os.hostname() + ' (本机)',
    platform: os.platform(),
    arch: os.arch(),
    status: 'online'
  }];

  for (const [id, agent] of agents) {
    list.push({
      id,
      name: agent.name,
      platform: agent.platform,
      arch: agent.arch,
      status: agent.ws.readyState === WebSocket.OPEN ? 'online' : 'offline',
      lastSeen: agent.lastSeen
    });
  }

  return list;
}

// Broadcast server list changes to all browser clients
function broadcastServerList() {
  const serverList = getServerList();
  wssBrowser.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'server_list_update',
        serverList
      }));
    }
  });
}

// ── Agent WebSocket Handling ──────────────────────
wssAgent.on('connection', (ws) => {
  let agentId = null;

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);

      if (parsed.type === 'agent_register') {
        agentId = parsed.agentId;
        agents.set(agentId, {
          ws,
          name: parsed.agentName,
          platform: parsed.platform,
          arch: parsed.arch,
          hostname: parsed.hostname,
          data: null,
          lastSeen: Date.now()
        });
        console.log(`  🔗 Agent connected: ${parsed.agentName} (${agentId})`);
        broadcastServerList();
      }

      if (parsed.type === 'agent_data' && agentId) {
        const agent = agents.get(agentId);
        if (agent) {
          agent.data = parsed.data;
          agent.lastSeen = Date.now();
          agent.name = parsed.agentName;

          // Push to browsers currently viewing this agent
          for (const [clientWs, clientState] of browserClients) {
            if (clientState.selectedServer === agentId && clientWs.readyState === WebSocket.OPEN) {
              const payload = {
                ...agent.data,
                serverId: agentId,
                serverName: agent.name,
                serverList: getServerList()
              };
              clientWs.send(JSON.stringify(payload));
            }
          }
        }
      }
    } catch (e) {
      console.error('Agent message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (agentId) {
      console.log(`  ❌ Agent disconnected: ${agentId}`);
      agents.delete(agentId);
      broadcastServerList();
    }
  });

  ws.on('error', () => {
    if (agentId) {
      agents.delete(agentId);
      broadcastServerList();
    }
  });
});

// ── Browser WebSocket Handling ────────────────────
wssBrowser.on('connection', (ws) => {
  console.log('  🌐 Browser client connected');

  const clientState = {
    selectedServer: 'local',
    intervalTimer: null,
    refreshMs: 10000
  };
  browserClients.set(ws, clientState);

  const sendData = async () => {
    try {
      let payload;

      if (clientState.selectedServer === 'local') {
        payload = await getPortInfo();
        payload.serverId = 'local';
        payload.serverName = os.hostname() + ' (本机)';
      } else {
        const agent = agents.get(clientState.selectedServer);
        if (agent && agent.data) {
          payload = { ...agent.data };
          payload.serverId = clientState.selectedServer;
          payload.serverName = agent.name;
        } else {
          // No data yet for this agent
          payload = {
            serverId: clientState.selectedServer,
            serverName: agent ? agent.name : clientState.selectedServer,
            noData: true,
            timestamp: new Date().toISOString()
          };
        }
      }

      payload.refreshInterval = clientState.refreshMs;
      payload.serverList = getServerList();

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    } catch (err) {
      console.error('Error sending data to browser:', err.message);
    }
  };

  const startInterval = () => {
    if (clientState.intervalTimer) clearInterval(clientState.intervalTimer);
    clientState.intervalTimer = setInterval(sendData, clientState.refreshMs);
  };

  // Send immediately, then at interval
  sendData();
  startInterval();

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);

      // Server switching
      if (parsed.type === 'select_server') {
        clientState.selectedServer = parsed.serverId;
        console.log(`  🔀 Browser switched to: ${parsed.serverId}`);
        sendData(); // Immediately send data for the new server

        // For agent servers, data is pushed when agent sends it
        // For local, keep the interval
        if (parsed.serverId === 'local') {
          startInterval();
        } else {
          // Still poll periodically in case we miss agent pushes
          startInterval();
        }
      }

      // Refresh interval change
      if (parsed.interval && parsed.interval >= 3000) {
        clientState.refreshMs = parsed.interval;
        startInterval();
        console.log(`  ⏱️  Browser refresh interval: ${clientState.refreshMs / 1000}s`);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('  🌐 Browser client disconnected');
    if (clientState.intervalTimer) clearInterval(clientState.intervalTimer);
    browserClients.delete(ws);
  });

  ws.on('error', () => {
    if (clientState.intervalTimer) clearInterval(clientState.intervalTimer);
    browserClients.delete(ws);
  });
});

// ── Start Server ──────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🦀 ClawPort Dashboard (Multi-Server)`);
  console.log(`  ──────────────────────────`);
  console.log(`  🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`  📡 Agent WS:  ws://localhost:${PORT}/agent`);
  console.log(`  ⏱️  Refresh:   every 10 seconds`);
  console.log(`  💡 Deploy agent.js on remote servers:\n`);
  console.log(`     MASTER_URL=ws://<this-ip>:${PORT} node agent.js\n`);
});
