/**
 * Port Monitor Dashboard - Client-side Application
 * Multi-server support with Agent mode
 * Optimized for smoothness and performance
 */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────
  let currentData = null;
  let selectedPort = null;
  let currentView = 'grid';
  let sortConfig = { key: 'localPort', dir: 'asc' };
  let ws = null;
  let reconnectTimer = null;
  let currentServerId = 'local';
  let serverList = [];
  
  // Node Cache for reconciliation
  const portNodes = new Map(); // port -> element
  const serverNodes = new Map(); // serverId -> element

  // ── DOM Elements ────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elHostname = $('#hostname');
  const elStatus = $('#connectionStatus');
  const elLastUpdate = $('#lastUpdate');
  const elTotalPorts = $('#totalPorts');
  const elListeningPorts = $('#listeningPorts');
  const elEstablishedConns = $('#establishedConns');
  const elTotalConns = $('#totalConns');
  const elPortGrid = $('#portGrid');
  const elStateChart = $('#stateChart');
  const elProtoBars = $('#protoBars');
  const elProcessList = $('#processList');
  const elPortDetailSection = $('#portDetailSection');
  const elPortDetailBadge = $('#portDetailBadge');
  const elPortDetailContent = $('#portDetailContent');
  const elSysInfo = $('#sysInfo');
  const elConnCount = $('#connCount');
  const elConnTableBody = $('#connTableBody');
  const elSearchInput = $('#searchInput');
  const elStateFilter = $('#stateFilter');
  const elProtoFilter = $('#protoFilter');
  const elServerChips = $('#serverChips');
  const elServerCount = $('#serverCount');

  // ── Color Map ───────────────────────────────────
  const stateColors = {
    LISTENING: '#22c55e',
    ESTABLISHED: '#3b82f6',
    TIME_WAIT: '#f59e0b',
    CLOSE_WAIT: '#ef4444',
    FIN_WAIT_1: '#06b6d4',
    FIN_WAIT_2: '#06b6d4',
    SYN_SENT: '#a855f7',
    SYN_RECEIVED: '#a855f7',
    LAST_ACK: '#ec4899',
    CLOSING: '#ec4899',
  };

  function getStateColor(state) {
    return stateColors[state] || '#64748b';
  }

  function getStateBadgeClass(state) {
    if (state === 'LISTENING') return 'listening';
    if (state === 'ESTABLISHED') return 'established';
    if (state === 'TIME_WAIT') return 'time_wait';
    if (state === 'CLOSE_WAIT') return 'close_wait';
    if (state.includes('FIN_WAIT')) return 'fin_wait';
    return 'other';
  }

  // ── Platform Icons ──────────────────────────────
  const platformIcons = {
    'win32': '🪟',
    'linux': '🐧',
    'darwin': '🍎',
    'freebsd': '😈',
  };

  function getPlatformIcon(platform) {
    return platformIcons[platform] || '🖥️';
  }

  // ── Connection Type Icons ──────────────────────
  const typeIcons = {
    'ws': '🛰️',
    'ssh': '🔑',
    'local': '🏠'
  };

  function getConnectionTypeIcon(type, id) {
    if (id === 'local') return typeIcons['local'];
    return typeIcons[type] || '🖥️';
  }

  // ── Well-known Port Icons ─────────────────────
  const portServiceMap = {
    20: { name: 'FTP-Data', icon: '📂' },
    21: { name: 'FTP', icon: '📁' },
    22: { name: 'SSH', icon: '🔐' },
    23: { name: 'Telnet', icon: '🖥️' },
    25: { name: 'SMTP', icon: '📧' },
    53: { name: 'DNS', icon: '🌐' },
    67: { name: 'DHCP', icon: '🔗' },
    68: { name: 'DHCP', icon: '🔗' },
    80: { name: 'HTTP', icon: '🌍' },
    110: { name: 'POP3', icon: '📬' },
    123: { name: 'NTP', icon: '🕐' },
    135: { name: 'RPC', icon: '⚙️' },
    137: { name: 'NetBIOS', icon: '🖧' },
    138: { name: 'NetBIOS', icon: '🖧' },
    139: { name: 'NetBIOS', icon: '🖧' },
    143: { name: 'IMAP', icon: '📨' },
    443: { name: 'HTTPS', icon: '🔒' },
    445: { name: 'SMB', icon: '📂' },
    465: { name: 'SMTPS', icon: '📧' },
    587: { name: 'SMTP', icon: '📧' },
    993: { name: 'IMAPS', icon: '📨' },
    995: { name: 'POP3S', icon: '📬' },
    1080: { name: 'SOCKS', icon: '🧦' },
    1433: { name: 'MSSQL', icon: '🗄️' },
    1434: { name: 'MSSQL', icon: '🗄️' },
    3306: { name: 'MySQL', icon: '🐬' },
    3389: { name: 'RDP', icon: '🖥️' },
    5432: { name: 'PostgreSQL', icon: '🐘' },
    5672: { name: 'RabbitMQ', icon: '🐰' },
    5900: { name: 'VNC', icon: '📺' },
    6379: { name: 'Redis', icon: '⚡' },
    8080: { name: 'HTTP-Alt', icon: '🌍' },
    8443: { name: 'HTTPS-Alt', icon: '🔒' },
    8888: { name: 'HTTP-Alt', icon: '🌍' },
    9200: { name: 'Elastic', icon: '🔎' },
    9300: { name: 'Elastic', icon: '🔎' },
    27017: { name: 'MongoDB', icon: '🍃' },
  };

  function getPortService(port) {
    return portServiceMap[port] || null;
  }

  // ── Process Icons ────────────────────────────
  const processIcons = {
    'node.exe': '🟢', 'node': '🟢',
    'python.exe': '🐍', 'python': '🐍', 'python3': '🐍', 'python3.exe': '🐍', 'pythonw.exe': '🐍',
    'java.exe': '☕', 'java': '☕', 'javaw.exe': '☕',
    'nginx.exe': '🌐', 'nginx': '🌐',
    'httpd.exe': '🌐', 'httpd': '🌐', 'apache': '🌐', 'apache2': '🌐',
    'mysqld.exe': '🐬', 'mysqld': '🐬',
    'postgres.exe': '🐘', 'postgres': '🐘', 'postgresql': '🐘',
    'redis-server.exe': '⚡', 'redis-server': '⚡',
    'mongod.exe': '🍃', 'mongod': '🍃',
    'svchost.exe': '⚙️',
    'system': '💻',
    'msedge.exe': '🌊',
    'chrome.exe': '🟡', 'chrome': '🟡',
    'firefox.exe': '🦊', 'firefox': '🦊',
    'code.exe': '💜',
    'explorer.exe': '📁',
    'wsl.exe': '🐧',
    'docker.exe': '🐳', 'docker': '🐳', 'dockerd': '🐳',
    'powershell.exe': '💠',
    'cmd.exe': '⬛',
    'sshd': '🔐', 'ssh.exe': '🔐',
    'qq.exe': '🐧',
    'wechat.exe': '💬',
    'telegram.exe': '✈️',
    'discord.exe': '🎮',
    'spotify.exe': '🎵',
    'steam.exe': '🎮',
    'git.exe': '📋',
    'curl.exe': '🔄',
    'windowsterminal.exe': '🖥️',
    'searchhost.exe': '🔍',
    'runtimebroker.exe': '🔧',
    'lsass.exe': '🛡️',
    'csrss.exe': '🔧',
    'taskhostw.exe': '📋',
    'sihost.exe': '🖥️',
    'smartscreen.exe': '🛡️',
  };

  function getProcessIcon(processName) {
    if (!processName || processName === 'N/A') return '📦';
    const key = processName.toLowerCase();
    return processIcons[key] || '📦';
  }

  // ── WebSocket ───────────────────────────────────
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      elStatus.className = 'connection-status connected';
      updateText(elStatus.querySelector('.status-text'), '已连接');
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onclose = () => {
      elStatus.className = 'connection-status disconnected';
      updateText(elStatus.querySelector('.status-text'), '已断开');
      if (!reconnectTimer) {
        reconnectTimer = setInterval(connect, 5000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle server list updates
        if (data.type === 'server_list_update') {
          serverList = data.serverList;
          renderServerChips();
          return;
        }

        // Handle no-data state for agent
        if (data.noData) {
          if (data.serverList) {
            serverList = data.serverList;
            renderServerChips();
          }
          showNoDataState(data.serverName || data.serverId);
          return;
        }

        // Normal data
        if (data.serverList) {
          serverList = data.serverList;
          renderServerChips();
        }

        currentData = data;
        render(data);
      } catch (e) {
        console.error('Parse error:', e);
      }
    };
  }

  function switchServer(serverId) {
    if (serverId === currentServerId) return;
    currentServerId = serverId;
    selectedPort = null;
    elPortDetailSection.style.display = 'none';

    // Clear caches for new server to force full render
    portNodes.clear();
    elPortGrid.innerHTML = '';

    // Update chip active state
    $$('.server-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.serverId === serverId);
    });

    // Tell server to switch
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'select_server', serverId }));
    }

    // Show loading
    elPortGrid.innerHTML = `
      <div class="loading-placeholder">
        <div class="spinner"></div>
        <p>正在加载服务器数据...</p>
      </div>`;
  }

  function showNoDataState(serverName) {
    updateText(elHostname, serverName);
    elPortGrid.innerHTML = `
      <div class="loading-placeholder">
        <div class="spinner"></div>
        <p>等待 Agent 发送数据...</p>
      </div>`;
  }

  // ── Render Server Chips ─────────────────────────
  function renderServerChips() {
    const activeIds = new Set(serverList.map(s => String(s.id)));
    
    // Remove old ones
    serverNodes.forEach((el, id) => {
      if (!activeIds.has(id)) {
        el.remove();
        serverNodes.delete(id);
      }
    });

    serverList.forEach(s => {
      const id = String(s.id);
      const isActive = id === currentServerId;
      const statusClass = s.status === 'online' ? 'online' : 'offline';
      
      let el = serverNodes.get(id);
      if (!el) {
        el = document.createElement('button');
        el.className = 'server-chip';
        el.dataset.serverId = id;
        el.innerHTML = `
          <span class="server-chip-dot"></span>
          <span class="server-chip-icon"></span>
          <span class="server-chip-name"></span>
        `;
        el.addEventListener('click', () => switchServer(id));
        elServerChips.appendChild(el);
        serverNodes.set(id, el);
      }

      el.classList.toggle('active', isActive);
      el.title = `${s.name} (${s.platform}/${s.arch})`;
      
      const dot = el.querySelector('.server-chip-dot');
      dot.className = `server-chip-dot ${statusClass}`;
      
      updateText(el.querySelector('.server-chip-icon'), getConnectionTypeIcon(s.type, id));
      updateText(el.querySelector('.server-chip-name'), s.name);
    });

    // Update count
    const onlineCount = serverList.filter(s => s.status === 'online').length;
    updateText(elServerCount, `${onlineCount} / ${serverList.length} 在线`);
  }

  // ── Render ──────────────────────────────────────
  function render(data) {
    renderTimestamp(data.timestamp);
    renderStats(data.summary);
    renderSystemInfo(data.systemInfo);
    renderPortGrid(data.ports);
    renderStateChart(data.connections);
    renderProtoBars(data.connections);
    renderProcessList(data.ports);
    renderConnectionTable(data.connections);

    if (selectedPort) {
      const portData = data.ports.find(p => p.port === selectedPort);
      if (portData) renderPortDetail(portData, data.connections);
    }
  }

  function renderTimestamp(ts) {
    const d = new Date(ts);
    updateText(elLastUpdate, d.toLocaleTimeString('zh-CN'));
  }

  function renderStats(summary) {
    animateValue(elTotalPorts, summary.totalPorts);
    animateValue(elListeningPorts, summary.listeningPorts);
    animateValue(elEstablishedConns, summary.establishedConnections);
    animateValue(elTotalConns, summary.totalConnections);
  }

  function animateValue(el, value) {
    const currentText = el.textContent || '0';
    const targetValue = String(value);
    
    if (currentText === targetValue) return;
    
    el.textContent = targetValue;
    el.classList.remove('animate-pop');
    void el.offsetWidth; // trigger reflow
    el.classList.add('animate-pop');
  }

  function renderSystemInfo(info) {
    const memUsed = info.totalMem - info.freeMem;
    const memPercent = ((memUsed / info.totalMem) * 100).toFixed(1);
    const memTotal = (info.totalMem / 1073741824).toFixed(1);
    const hours = Math.floor(info.uptime / 3600);
    const minutes = Math.floor((info.uptime % 3600) / 60);
    const load = info.loadAvg ? info.loadAvg.map(l => l.toFixed(2)).join(' / ') : 'N/A';
    const serverName = currentData?.serverName || info.hostname;
    updateText(elHostname, serverName);

    const html = `
      <div class="sys-row"><span class="label">主机名</span><span class="value">${info.hostname}</span></div>
      <div class="sys-row"><span class="label">系统</span><span class="value">${getPlatformIcon(info.platform)} ${info.platform} / ${info.arch}</span></div>
      <div class="sys-row"><span class="label">CPU 核心</span><span class="value">${info.cpus}</span></div>
      <div class="sys-row"><span class="label">系统负载</span><span class="value">${load}</span></div>
      <div class="sys-row">
        <span class="label">内存使用</span>
        <span class="value">${memPercent}% / ${memTotal} GB
          <span class="mem-bar"><span class="mem-fill" style="width: ${memPercent}%"></span></span>
        </span>
      </div>
      <div class="sys-row"><span class="label">运行时间</span><span class="value">${hours}h ${minutes}m</span></div>
    `;
    updateHTML(elSysInfo, html);
  }

  // ── Port Grid Reconciliation ────────────────────
  function renderPortGrid(ports) {
    const search = elSearchInput.value.toLowerCase().trim();
    let filtered = ports;

    if (search) {
      filtered = ports.filter(p =>
        String(p.port).includes(search) ||
        p.processes.some(pr => pr.toLowerCase().includes(search))
      );
    }

    if (filtered.length === 0) {
      updateHTML(elPortGrid, '<div class="loading-placeholder"><p>未找到匹配的端口</p></div>');
      portNodes.clear();
      return;
    }

    // Remove old loading placeholder if exists
    const placeholder = elPortGrid.querySelector('.loading-placeholder');
    if (placeholder) elPortGrid.removeChild(placeholder);

    const activePorts = new Set(filtered.map(p => p.port));
    
    // Remove nodes that are no longer present
    portNodes.forEach((el, port) => {
      if (!activePorts.has(port)) {
        el.remove();
        portNodes.delete(port);
      }
    });

    const fragment = document.createDocumentFragment();
    let hasNew = false;

    filtered.forEach(p => {
      const port = p.port;
      const mainState = getMainState(p.states);
      const stateClass = getPortStateClass(p.states);
      const process = p.processes[0] || '';
      const service = getPortService(port);
      const procIcon = getProcessIcon(process);
      const serviceName = service ? service.name : '';
      const total = Object.values(p.states).reduce((s, v) => s + v, 0);
      
      let el = portNodes.get(port);
      const isNew = !el;

      if (isNew) {
        el = document.createElement('div');
        el.className = 'port-cell';
        el.dataset.port = port;
        el.innerHTML = `
          <span class="port-service-icon"></span>
          <span class="port-number">${port}</span>
          <span class="port-label"></span>
          <span class="port-conns"></span>
          <div class="port-state-bar"></div>
        `;
        el.addEventListener('click', () => selectPort(port));
        fragment.appendChild(el);
        portNodes.set(port, el);
        hasNew = true;
        el.classList.add('newly-added');
      }

      // Update attributes and content incrementally
      const currentClassList = `port-cell ${stateClass} ${selectedPort === port ? 'selected' : ''}`;
      if (el.className !== currentClassList) {
        if (!isNew && !el.className.includes(stateClass)) {
          el.classList.add('status-changed');
          setTimeout(() => el.classList.remove('status-changed'), 1500);
        }
        el.className = currentClassList;
      }

      el.title = `Port ${port} - ${service ? service.name : process || 'Unknown'}`;
      
      const iconWrap = el.querySelector('.port-service-icon');
      const iconHTML = service ? service.icon : procIcon;
      updateText(iconWrap, iconHTML);

      updateText(el.querySelector('.port-label'), serviceName || truncate(process, 12));
      updateText(el.querySelector('.port-conns'), String(p.connections));

      const barSegments = Object.entries(p.states)
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => {
          const w = Math.max((count / total) * 100, 5);
          return `<span class="bar-segment" style="width:${w}%;background:${getStateColor(state)}"></span>`;
        }).join('');
      updateHTML(el.querySelector('.port-state-bar'), barSegments);
    });

    if (hasNew) {
      elPortGrid.appendChild(fragment);
    }
  }

  function getMainState(states) {
    return Object.entries(states).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  function getPortStateClass(states) {
    const keys = Object.keys(states);
    if (keys.length > 1) return 'state-mixed';
    if (states['LISTENING']) return 'state-listening';
    if (states['ESTABLISHED']) return 'state-established';
    if (states['TIME_WAIT']) return 'state-timewait';
    if (states['CLOSE_WAIT']) return 'state-closewait';
    return '';
  }

  function selectPort(port) {
    selectedPort = selectedPort === port ? null : port;
    portNodes.forEach((el, p) => {
      el.classList.toggle('selected', p === selectedPort);
    });

    if (selectedPort && currentData) {
      const portData = currentData.ports.find(p => p.port === selectedPort);
      if (portData) renderPortDetail(portData, currentData.connections);
      elPortDetailSection.style.display = 'block';
    } else {
      elPortDetailSection.style.display = 'none';
    }
  }

  function renderPortDetail(portData, connections) {
    updateText(elPortDetailBadge, `:${portData.port}`);
    const stateEntries = Object.entries(portData.states)
      .map(([s, c]) => `<div class="detail-row"><span class="label">${s}</span><span class="value">${c}</span></div>`)
      .join('');

    const html = `
      <div class="detail-row"><span class="label">协议</span><span class="value">${portData.proto}</span></div>
      <div class="detail-row"><span class="label">连接数</span><span class="value">${portData.connections}</span></div>
      <div class="detail-row"><span class="label">进程</span><span class="value">${portData.processes.join(', ') || 'N/A'}</span></div>
      <div class="detail-row"><span class="label">PID</span><span class="value">${portData.pids.join(', ') || 'N/A'}</span></div>
      <div class="detail-row"><span class="label">绑定地址</span><span class="value">${portData.localIPs.join(', ')}</span></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:6px 0">
      ${stateEntries}
    `;
    updateHTML(elPortDetailContent, html);
  }

  function renderStateChart(connections) {
    const stateCounts = {};
    connections.forEach(c => { stateCounts[c.state] = (stateCounts[c.state] || 0) + 1; });
    const entries = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]);
    const total = connections.length;

    if (total === 0) {
      updateHTML(elStateChart, '<p style="color:var(--text-muted);font-size:0.8rem">暂无数据</p>');
      return;
    }

    const size = 120, cx = size / 2, cy = size / 2, r = 46, strokeWidth = 14;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    const arcs = entries.map(([state, count]) => {
      const pct = count / total, dashLength = circumference * pct, dashOffset = circumference * offset;
      offset += pct;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${getStateColor(state)}" stroke-width="${strokeWidth}" stroke-dasharray="${dashLength} ${circumference - dashLength}" stroke-dashoffset="-${dashOffset}" style="transition:all 0.5s ease"/>`;
    }).join('');

    const svgDonut = `<svg class="donut-chart" viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-surface)" stroke-width="${strokeWidth}"/>${arcs}<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="700">${total}</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="var(--text-muted)" font-size="8">总连接</text></svg>`;
    const legend = entries.slice(0, 6).map(([state, count]) => `<div class="legend-row"><span class="dot" style="background:${getStateColor(state)}"></span><span class="name">${state}</span><span class="value">${count}</span></div>`).join('');
    updateHTML(elStateChart, `${svgDonut}<div class="chart-legend">${legend}</div>`);
  }

  function renderProtoBars(connections) {
    const protoCounts = {};
    connections.forEach(c => { const proto = c.proto.split('/')[0]; protoCounts[proto] = (protoCounts[proto] || 0) + 1; });
    const total = connections.length || 1, entries = Object.entries(protoCounts).sort((a, b) => b[1] - a[1]);

    const html = entries.map(([proto, count]) => {
      const pct = (count / total * 100).toFixed(1);
      return `<div class="proto-bar-item"><span class="proto-name">${proto}</span><div class="proto-bar-track"><div class="proto-bar-fill ${proto.toLowerCase()}" style="width: ${pct}%"></div></div><span class="proto-count">${count}</span></div>`;
    }).join('');
    updateHTML(elProtoBars, html);
  }

  function renderProcessList(ports) {
    const processMap = {};
    ports.forEach(p => { p.processes.forEach(proc => { if (!processMap[proc]) processMap[proc] = { ports: new Set(), conns: 0 }; processMap[proc].ports.add(p.port); processMap[proc].conns += p.connections; }); });
    const sorted = Object.entries(processMap).sort((a, b) => b[1].conns - a[1].conns).slice(0, 10);
    const html = sorted.map(([name, data], i) => `<div class="process-item"><span class="process-icon">${getProcessIcon(name)}</span><span class="process-rank">${i + 1}</span><span class="process-name" title="${name}">${name}</span><span class="process-port-count">${data.ports.size} 端口</span></div>`).join('') || '<p style="color:var(--text-muted);font-size:0.78rem">暂无数据</p>';
    updateHTML(elProcessList, html);
  }

  function renderConnectionTable(connections) {
    const stateF = elStateFilter.value, protoF = elProtoFilter.value, search = elSearchInput.value.toLowerCase().trim();
    let filtered = connections;
    if (stateF !== 'all') filtered = filtered.filter(c => c.state === stateF);
    if (protoF !== 'all') filtered = filtered.filter(c => c.proto.includes(protoF));
    if (search) filtered = filtered.filter(c => String(c.localPort).includes(search) || c.processName.toLowerCase().includes(search) || c.localIP.includes(search) || c.remoteIP.includes(search) || (c.user || '').toLowerCase().includes(search));

    filtered.sort((a, b) => { let va = a[sortConfig.key], vb = b[sortConfig.key]; if (typeof va === 'number') return sortConfig.dir === 'asc' ? va - vb : vb - va; va = String(va); vb = String(vb); return sortConfig.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va); });

    updateText(elConnCount, String(filtered.length));
    const limit = 50, display = filtered.slice(0, limit);
    const html = display.map(c => {
      const svc = getPortService(c.localPort), svcLabel = svc ? `<span class="table-svc-badge" title="${svc.name}">${svc.icon} ${svc.name}</span>` : '', procIcon = getProcessIcon(c.processName);
      return `<tr><td>${c.proto}</td><td><strong>${c.localPort}</strong> ${svcLabel}</td><td>${c.localIP}</td><td>${c.remoteIP}${c.remotePort ? ':' + c.remotePort : ''}</td><td><span class="state-badge ${getStateBadgeClass(c.state)}">${c.state}</span></td><td>${c.pid}</td><td>${c.user || 'N/A'}</td><td>${procIcon} ${truncate(c.processName, 18)}</td></tr>`;
    }).join('');
    const moreHTML = filtered.length > limit ? `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:12px">显示前 ${limit} 条记录</td></tr>` : '';
    updateHTML(elConnTableBody, html + moreHTML);
  }

  function updateText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
  function updateHTML(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }
  function truncate(str, len) { if (!str) return ''; return str.length > len ? str.substring(0, len) + '…' : str; }

  // ── Event Listeners ───────────────────────────
  let isDark = true;
  $('#btnToggleTheme').addEventListener('click', () => { isDark = !isDark; document.documentElement.setAttribute('data-theme', isDark ? '' : 'light'); });
  $('#btnRefresh').addEventListener('click', () => { if (ws && ws.readyState === WebSocket.OPEN) { ws.close(); setTimeout(connect, 100); } });
  $('#refreshInterval').addEventListener('change', (e) => { const interval = parseInt(e.target.value); if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ interval })); });
  $('#viewToggle').addEventListener('click', (e) => { const btn = e.target.closest('.view-btn'); if (!btn) return; currentView = btn.dataset.view; $$('.view-btn').forEach(b => b.classList.toggle('active', b === btn)); elPortGrid.classList.toggle('list-view', currentView === 'list'); });
  elSearchInput.addEventListener('input', () => { if (currentData) { renderPortGrid(currentData.ports); renderConnectionTable(currentData.connections); } });
  elStateFilter.addEventListener('change', () => { if (currentData) renderConnectionTable(currentData.connections); });
  elProtoFilter.addEventListener('change', () => { if (currentData) renderConnectionTable(currentData.connections); });
  $$('.conn-table th.sortable').forEach(th => { th.addEventListener('click', () => { const key = th.dataset.sort; if (sortConfig.key === key) sortConfig.dir = sortConfig.dir === 'asc' ? 'desc' : 'asc'; else { sortConfig.key = key; sortConfig.dir = 'asc'; } if (currentData) renderConnectionTable(currentData.connections); }); });

  connect();
})();
