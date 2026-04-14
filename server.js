const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3456;

app.use(express.static(path.join(__dirname, 'public')));

// Parse netstat output for Windows
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

    // Parse local address
    const lastColon = localAddress.lastIndexOf(':');
    if (lastColon === -1) continue;

    const localIP = localAddress.substring(0, lastColon);
    const localPort = parseInt(localAddress.substring(lastColon + 1));

    if (isNaN(localPort)) continue;

    // Parse foreign address
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

// Get process name by PID
function getProcessNames(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) {
      resolve({});
      return;
    }

    const uniquePids = [...new Set(pids.filter(p => p && p !== 'N/A'))];
    if (uniquePids.length === 0) {
      resolve({});
      return;
    }

    // Use tasklist to get process names
    exec('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      const processMap = {};
      if (err) {
        resolve(processMap);
        return;
      }

      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/"([^"]+)","(\d+)"/);
        if (match) {
          processMap[match[2]] = match[1];
        }
      }
      resolve(processMap);
    });
  });
}

// Get all port info
function getPortInfo() {
  return new Promise((resolve, reject) => {
    exec('netstat -ano', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, async (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }

      const connections = parseNetstatWindows(stdout);
      const pids = connections.map(c => c.pid);
      const processMap = await getProcessNames(pids);

      // Attach process names
      for (const conn of connections) {
        conn.processName = processMap[conn.pid] || 'N/A';
      }

      // Group by port for summary
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

      // Convert sets to arrays
      const ports = Object.values(portMap).map(p => ({
        ...p,
        processes: [...p.processes],
        pids: [...p.pids],
        localIPs: [...p.localIPs]
      }));

      // System info
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

// REST API
app.get('/api/ports', async (req, res) => {
  try {
    const data = await getPortInfo();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket for real-time updates
wss.on('connection', (ws) => {
  console.log('Client connected');

  let intervalTimer;
  let refreshMs = 10000; // Default: 10 seconds

  const sendData = async () => {
    try {
      const data = await getPortInfo();
      data.refreshInterval = refreshMs;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    } catch (err) {
      console.error('Error fetching port data:', err.message);
    }
  };

  const startInterval = () => {
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(sendData, refreshMs);
  };

  // Send immediately, then at interval
  sendData();
  startInterval();

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.interval && parsed.interval >= 3000) {
        refreshMs = parsed.interval;
        startInterval();
        console.log(`Refresh interval set to ${refreshMs / 1000}s`);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clearInterval(intervalTimer);
  });

  ws.on('error', () => {
    clearInterval(intervalTimer);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🦀 ClawPort Dashboard`);
  console.log(`  ──────────────────────────`);
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log(`  📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`  ⏱️  Refresh: every 10 seconds\n`);
});
