#!/usr/bin/env node
/**
 * ClawPort Agent - Remote Server Port Monitor
 *
 * Deploy on any server to report port/connection data to the ClawPort dashboard.
 * Supports Windows and Linux.
 *
 * Usage:
 *   MASTER_URL=ws://dashboard-host:3456 node agent.js
 *
 * Environment Variables:
 *   MASTER_URL       - WebSocket URL of ClawPort dashboard (default: ws://localhost:3456)
 *   AGENT_ID         - Unique agent ID (default: hostname)
 *   AGENT_NAME       - Display name for this server (default: hostname)
 *   REFRESH_INTERVAL - Data send interval in ms (default: 10000)
 */

const WebSocket = require('ws');
const { exec } = require('child_process');
const os = require('os');

// ── Configuration ─────────────────────────────────
const CONFIG = {
  masterUrl: process.env.MASTER_URL || 'ws://localhost:3456',
  agentId: process.env.AGENT_ID || os.hostname(),
  agentName: process.env.AGENT_NAME || os.hostname(),
  refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 10000,
};

const isWindows = os.platform() === 'win32';
let ws = null;
let dataInterval = null;
let reconnectTimer = null;

// ── State Normalization ───────────────────────────
function normalizeState(state) {
  const map = {
    'LISTEN': 'LISTENING',
    'LISTENING': 'LISTENING',
    'ESTAB': 'ESTABLISHED',
    'ESTABLISHED': 'ESTABLISHED',
    'TIME-WAIT': 'TIME_WAIT',
    'TIME_WAIT': 'TIME_WAIT',
    'CLOSE-WAIT': 'CLOSE_WAIT',
    'CLOSE_WAIT': 'CLOSE_WAIT',
    'FIN-WAIT-1': 'FIN_WAIT_1',
    'FIN_WAIT_1': 'FIN_WAIT_1',
    'FIN-WAIT-2': 'FIN_WAIT_2',
    'FIN_WAIT_2': 'FIN_WAIT_2',
    'SYN-SENT': 'SYN_SENT',
    'SYN_SENT': 'SYN_SENT',
    'SYN-RECV': 'SYN_RECEIVED',
    'SYN_RECEIVED': 'SYN_RECEIVED',
    'LAST-ACK': 'LAST_ACK',
    'LAST_ACK': 'LAST_ACK',
    'CLOSING': 'CLOSING',
    'UNCONN': 'N/A',
  };
  return map[state] || state || 'N/A';
}

// ── Windows: Parse netstat -ano ───────────────────
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
      state: normalizeState(state),
      pid: pid || 'N/A',
      processName: 'N/A'
    });
  }

  return connections;
}

// ── Windows: Get process names by PID ─────────────
function getProcessNamesWindows(pids) {
  return new Promise((resolve) => {
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

// ── Linux: Parse netstat -tunap ───────────────────
function parseNetstatLinux(output) {
  const lines = output.split('\n');
  const connections = [];
  const seen = new Set();

  // Detect format: netstat vs ss
  const isNetstatFormat = lines.some(l => /^tcp|^udp/i.test(l.trim()));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(State|Proto|Active|Netid|Recv-Q)/.test(trimmed)) continue;

    if (isNetstatFormat) {
      // netstat -tunap:
      // tcp  0  0  0.0.0.0:22  0.0.0.0:*  LISTEN  1234/sshd
      const parts = trimmed.split(/\s+/);
      if (parts.length < 6) continue;

      const proto = parts[0].replace('6', '').toUpperCase(); // tcp6 -> TCP
      const localAddress = parts[3];
      const foreignAddress = parts[4];
      const state = parts[5] || '';
      const pidProg = parts[6] || '';

      const lastColon = localAddress.lastIndexOf(':');
      if (lastColon === -1) continue;
      const localIP = localAddress.substring(0, lastColon) || '0.0.0.0';
      const localPort = parseInt(localAddress.substring(lastColon + 1));
      if (isNaN(localPort)) continue;

      let remoteIP = '', remotePort = '';
      if (foreignAddress && !['*:*', '0.0.0.0:*', ':::*'].includes(foreignAddress)) {
        const rLastColon = foreignAddress.lastIndexOf(':');
        if (rLastColon !== -1) {
          remoteIP = foreignAddress.substring(0, rLastColon);
          remotePort = foreignAddress.substring(rLastColon + 1);
        }
      }

      let pid = 'N/A', processName = 'N/A';
      if (pidProg && pidProg !== '-') {
        const pidMatch = pidProg.match(/^(\d+)\/(.+)$/);
        if (pidMatch) { pid = pidMatch[1]; processName = pidMatch[2]; }
      }

      const normalizedState = normalizeState(state);
      const key = `${proto}-${localPort}-${localIP}-${foreignAddress}-${normalizedState}`;
      if (seen.has(key)) continue;
      seen.add(key);

      connections.push({
        proto,
        localIP,
        localPort,
        remoteIP,
        remotePort,
        state: normalizedState,
        pid,
        processName
      });
    } else {
      // ss -tunap:
      // LISTEN  0  128  0.0.0.0:22  0.0.0.0:*  users:(("sshd",pid=1234,fd=3))
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;

      const state = parts[0];
      // Skip header rows
      if (state === 'Netid' || state === 'State') continue;

      const localAddress = parts[3];
      const foreignAddress = parts[4];
      const extra = parts.slice(5).join(' ');

      const lastColon = localAddress.lastIndexOf(':');
      if (lastColon === -1) continue;
      const localIP = localAddress.substring(0, lastColon) || '0.0.0.0';
      const localPort = parseInt(localAddress.substring(lastColon + 1));
      if (isNaN(localPort)) continue;

      let remoteIP = '', remotePort = '';
      if (foreignAddress && !['*:*', '0.0.0.0:*', ':::*'].includes(foreignAddress)) {
        const rLastColon = foreignAddress.lastIndexOf(':');
        if (rLastColon !== -1) {
          remoteIP = foreignAddress.substring(0, rLastColon);
          remotePort = foreignAddress.substring(rLastColon + 1);
        }
      }

      let pid = 'N/A', processName = 'N/A';
      const userMatch = extra.match(/\("([^"]+)",pid=(\d+)/);
      if (userMatch) { processName = userMatch[1]; pid = userMatch[2]; }

      const normalizedState = normalizeState(state);
      const proto = 'TCP';
      const key = `${proto}-${localPort}-${localIP}-${foreignAddress}-${normalizedState}`;
      if (seen.has(key)) continue;
      seen.add(key);

      connections.push({
        proto,
        localIP,
        localPort,
        remoteIP,
        remotePort,
        state: normalizedState,
        pid,
        processName
      });
    }
  }

  return connections;
}

// ── Collect Port Data ─────────────────────────────
function getPortInfo() {
  return new Promise((resolve, reject) => {
    const cmd = isWindows
      ? 'netstat -ano'
      : 'netstat -tunap 2>/dev/null || ss -tunap 2>/dev/null';

    exec(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, async (err, stdout) => {
      if (err) { reject(err); return; }

      const connections = isWindows
        ? parseNetstatWindows(stdout)
        : parseNetstatLinux(stdout);

      // Get process names (Windows only)
      if (isWindows) {
        const pids = connections.map(c => c.pid);
        const processMap = await getProcessNamesWindows(pids);
        for (const conn of connections) {
          conn.processName = processMap[conn.pid] || 'N/A';
        }
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

// ── WebSocket Connection ──────────────────────────
function connect() {
  const url = CONFIG.masterUrl.replace(/\/$/, '') + '/agent';
  console.log(`  📡 Connecting to ${url}...`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error(`  ❌ Connection error: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log(`  ✅ Connected to master dashboard`);

    // Register agent
    ws.send(JSON.stringify({
      type: 'agent_register',
      agentId: CONFIG.agentId,
      agentName: CONFIG.agentName,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname()
    }));

    // Start sending data
    sendData();
    dataInterval = setInterval(sendData, CONFIG.refreshInterval);
  });

  ws.on('close', () => {
    console.log(`  ⚠️  Disconnected from master`);
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    // Suppress ECONNREFUSED noise
    if (err.code !== 'ECONNREFUSED') {
      console.error(`  ❌ WebSocket error: ${err.message}`);
    }
    cleanup();
    scheduleReconnect();
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'set_interval' && data.interval >= 3000) {
        clearInterval(dataInterval);
        CONFIG.refreshInterval = data.interval;
        dataInterval = setInterval(sendData, CONFIG.refreshInterval);
        console.log(`  ⏱️  Refresh interval updated to ${data.interval / 1000}s`);
      }
    } catch (e) {}
  });
}

async function sendData() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const data = await getPortInfo();
    ws.send(JSON.stringify({
      type: 'agent_data',
      agentId: CONFIG.agentId,
      agentName: CONFIG.agentName,
      data
    }));
  } catch (err) {
    console.error(`  ❌ Data collection error: ${err.message}`);
  }
}

function cleanup() {
  if (dataInterval) {
    clearInterval(dataInterval);
    dataInterval = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`  🔄 Reconnecting in 5 seconds...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

// ── Start ─────────────────────────────────────────
console.log(`\n  🦀 ClawPort Agent`);
console.log(`  ──────────────────────────`);
console.log(`  🆔 Agent ID: ${CONFIG.agentId}`);
console.log(`  📛 Name: ${CONFIG.agentName}`);
console.log(`  🎯 Master: ${CONFIG.masterUrl}`);
console.log(`  ⏱️  Interval: ${CONFIG.refreshInterval / 1000}s`);
console.log(`  💻 Platform: ${os.platform()} / ${os.arch()}\n`);

connect();
