const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const url = require('url');
const { Client } = require('ssh2');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Two WebSocket servers: browser clients & remote agents
const wssBrowser = new WebSocket.Server({ noServer: true });
const wssAgent = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3456;

app.use(express.static(path.join(__dirname, 'public')));

// ── Agent Data Store ─────────────────────────────
const agents = new Map(); // agentId -> { ws, name, platform, arch, hostname, data, lastSeen, type: 'ws'|'ssh' }

// ── SSH Server Configurations ──────────────────────
// You can add your SSH servers here
const SSH_SERVERS = [
  /*
  {
    id: 'my-remote-vps',
    name: 'My Remote VPS',
    host: 'your.remote.ip',
    port: 22,
    username: 'root',
    privateKeyPath: path.join(os.homedir(), '.ssh', 'id_rsa') // Default path
  }
  */
];

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

// ── SSH & Linux Data Parsing ──────────────────────

function parseLinuxSS(output) {
  const connections = [];
  const lines = output.split('\n');
  
  // Format we expect from: ss -ntup -H
  // Example: tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=123,fd=3))
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    const proto = parts[0].toUpperCase();
    const state = parts[1].toUpperCase();
    const local = parts[4];
    const remote = parts[5] || '';
    const userPart = parts[6] || '';

    const lastColon = local.lastIndexOf(':');
    if (lastColon === -1) continue;

    const localIP = local.substring(0, lastColon);
    const localPort = parseInt(localAddress = local.substring(lastColon + 1));

    let remoteIP = '';
    let remotePort = '';
    if (remote && remote !== '*:*') {
      const rLastColon = remote.lastIndexOf(':');
      if (rLastColon !== -1) {
        remoteIP = remote.substring(0, rLastColon);
        remotePort = remote.substring(rLastColon + 1);
      }
    }

    // Parse process name and PID: users:(("sshd",pid=123,fd=3))
    let processName = 'N/A';
    let pid = 'N/A';
    const processMatch = userPart.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (processMatch) {
      processName = processMatch[1];
      pid = processMatch[2];
    }

    connections.push({
      proto,
      localIP: localIP === '0.0.0.0' || localIP === '::' ? '*' : localIP,
      localPort,
      remoteIP,
      remotePort,
      state: state === 'UNCONN' ? 'UDP' : state,
      pid,
      processName
    });
  }
  return connections;
}

function processRawLinuxData(connections) {
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

  return { ports, connections };
}

async function collectSSHData(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      // We run ss with -ntp (TCP), -nup (UDP), -l (Listening), -H (No header)
      // Usually requires sudo to see process names for all users
      // However, we'll try without first, or user can prefix with sudo if they want
      const cmd = 'ss -ntup -l -H';
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); reject(err); return; }
        let stdout = '';
        stream.on('data', (data) => { stdout += data; });
        stream.on('close', () => {
          conn.end();
          const connections = parseLinuxSS(stdout);
          const processed = processRawLinuxData(connections);
          
          resolve({
            timestamp: new Date().toISOString(),
            systemInfo: {
              hostname: config.host,
              platform: 'linux',
              arch: 'x64' // Assume
            },
            summary: {
              totalPorts: processed.ports.length,
              totalConnections: connections.length,
              listeningPorts: processed.ports.filter(p => p.states['LISTEN'] || p.states['UDP']).length,
              establishedConnections: connections.filter(c => c.state === 'ESTAB').length
            },
            ports: processed.ports.sort((a,b) => a.port - b.port),
            connections: connections.sort((a,b) => a.localPort - b.localPort)
          });
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: config.host,
      port: config.port || 22,
      username: config.username,
      privateKey: fs.readFileSync(config.privateKeyPath)
    });
  });
}

function pollSSHServers() {
  for (const config of SSH_SERVERS) {
    collectSSHData(config)
      .then(data => {
        agents.set(config.id, {
          name: config.name,
          platform: 'linux',
          arch: 'x64',
          data,
          lastSeen: Date.now(),
          type: 'ssh'
        });
        // Notify browser clients
        broadcastDataToViewers(config.id, data);
      })
      .catch(err => {
        console.error(`[SSH] Failed to collect from ${config.name}:`, err.message);
      });
  }
}

function broadcastDataToViewers(serverId, data) {
  for (const [clientWs, clientState] of browserClients) {
    if (clientState.selectedServer === serverId && clientWs.readyState === WebSocket.OPEN) {
      const payload = {
        ...data,
        serverId,
        serverName: agents.get(serverId).name,
        serverList: getServerList()
      };
      clientWs.send(JSON.stringify(payload));
    }
  }
}

// Poll SSH every 15 seconds
setInterval(pollSSHServers, 15000);

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
    const isOnline = agent.type === 'ssh' ? true : (agent.ws && agent.ws.readyState === WebSocket.OPEN);
    list.push({
      id,
      name: agent.name,
      platform: agent.platform,
      arch: agent.arch,
      type: agent.type, // 'ws' or 'ssh'
      status: isOnline ? 'online' : 'offline',
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
          lastSeen: Date.now(),
          type: 'ws'
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
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }

  console.log(`\n  🦀 ClawPort Dashboard (Multi-Server)`);
  console.log(`  ──────────────────────────`);
  console.log(`  🌐 Dashboard: http://${localIP}:${PORT}`);
  console.log(`  📡 Agent WS:  ws://${localIP}:${PORT}/agent`);
  console.log(`  ⏱️  Refresh:   every 10 seconds`);
  console.log(`  💡 Deploy agent.js on remote servers:\n`);
  console.log(`     MASTER_URL=ws://${localIP}:${PORT}/agent node agent.js\n`);
});
