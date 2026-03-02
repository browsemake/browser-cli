#!/usr/bin/env node
const { program } = require('commander');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const REGISTRY_DIR = path.join(os.homedir(), '.br');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'instances.json');

class DaemonNotRunningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DaemonNotRunningError';
    this.code = 'DAEMON_NOT_RUNNING';
  }
}

// Exit codes: 0 = success, 1 = check/assertion failed, 2 = error
const EXIT_CHECK_FAILED = 1;
const EXIT_ERROR = 2;

function handleDaemonError(err) {
  if (err.code === 'DAEMON_NOT_RUNNING' || err.code === 'ECONNREFUSED') {
    console.error('Error:', err.message);
    process.exit(EXIT_ERROR);
  }
  throw err;
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    // Prune dead entries
    let changed = false;
    for (const [name, entry] of Object.entries(data)) {
      try {
        process.kill(entry.pid, 0);
      } catch {
        delete data[name];
        changed = true;
      }
    }
    if (changed) writeRegistry(data);
    return data;
  } catch {
    return {};
  }
}

function writeRegistry(data) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function registerInstance(name, port, pid) {
  const data = readRegistry();
  data[name] = { port, pid };
  writeRegistry(data);
}

function unregisterInstance(name) {
  const data = readRegistry();
  delete data[name];
  writeRegistry(data);
}

function getInstance(name) {
  const data = readRegistry();
  return data[name] || null;
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = require('net').createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port);
  });
}

async function allocatePort() {
  const data = readRegistry();
  const usedPorts = new Set(Object.values(data).map(e => e.port));
  let port = 3030;
  while (usedPorts.has(port) || !(await isPortFree(port))) port++;
  return port;
}

function getRunningPid(name) {
  const instance = getInstance(name);
  return instance ? instance.pid : null;
}

function send(urlPath, method = 'GET', body, port) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    headers['Connection'] = 'close';

    const req = http.request({
      hostname: 'localhost',
      port,
      path: urlPath,
      method,
      headers
    }, (res) => {
      let out = '';
      res.on('data', chunk => out += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(out);
        } else {
          try {
            const parsed = JSON.parse(out);
            resolve(parsed);
          } catch {
            resolve(out);
          }
        }
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        const err = new DaemonNotRunningError('Daemon is not running. Please start it with "br start".');
        reject(err);
      } else {
        console.log('Unknown error, try start the daemon with "br start":');
        console.error(e);
        reject(e);
      }
    });
    if (data) req.write(data);
    req.end();
  });
}

function asyncAction(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error('Error:', err);
      process.exit(EXIT_ERROR);
    }
  };
}

// Check daemon status for help display
function getDaemonStatus() {
  const registry = readRegistry();
  const entries = Object.entries(registry);
  if (entries.length === 0) return 'no instances running';
  return entries.map(([name, e]) => `${name} (PID: ${e.pid}, port: ${e.port})`).join(', ');
}

// Customize help to show daemon status
program.addHelpText('before', () => {
  return `\nDaemon status: ${getDaemonStatus()}\n`;
});

program.option('-n, --name <name>', 'Instance name', 'default');

function getInstanceName() {
  // Parse --name from process.argv before commander processes subcommands
  const idx = process.argv.indexOf('--name') !== -1 ? process.argv.indexOf('--name') : process.argv.indexOf('-n');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.BR_INSTANCE || 'default';
}

function getInstancePort(name) {
  const instance = getInstance(name);
  if (!instance) throw new DaemonNotRunningError(`Instance is not running. Start it with: br${name !== 'default' ? ` --name ${name}` : ''} start`);
  return instance.port;
}

async function startDaemon(name) {
  const args = [process.argv[1], '--name', name, 'start'];
  const { execFileSync } = require('child_process');
  // Unset BR_AUTOSTART to prevent recursion; BR_PARAMS flows through naturally
  execFileSync(process.execPath, args, { stdio: 'pipe', env: { ...process.env, BR_AUTOSTART: '' } });

  const instance = getInstance(name);
  if (!instance) throw new Error('Daemon failed to start.');
  return instance.port;
}

async function sendToInstance(urlPath, method = 'GET', body) {
  const name = getInstanceName();
  let port;
  try {
    port = getInstancePort(name);
  } catch (err) {
    if (err.code === 'DAEMON_NOT_RUNNING' && process.env.BR_AUTOSTART) {
      port = await startDaemon(name);
      console.error(`Auto-started daemon "${name}" on port ${port}`);
    } else {
      throw err;
    }
  }
  try {
    return await send(urlPath, method, body, port);
  } catch (err) {
    if (err.code === 'DAEMON_NOT_RUNNING' && process.env.BR_AUTOSTART) {
      port = await startDaemon(name);
      console.error(`Auto-started daemon "${name}" on port ${port}`);
      return send(urlPath, method, body, port);
    }
    throw err;
  }
}

program
  .command('start')
  .description('Start the headless browser daemon process.')
  .option('--headless', 'Run the browser in headless mode (without a visible GUI)')
  .option('--viewport <size>', 'Set viewport size for headless mode (e.g., 1920x1080)', '1280x720')
  .option('--adblock', 'Enable ad blocking (blocks ads, trackers, and annoyances)')
  .option('--adblock-base <level>', 'Base filter level: none, adsandtrackers, full, or ads (default: adsandtrackers)')
  .option('--adblock-lists <paths>', 'Comma-separated list of additional filter list URLs or file paths')
  .option('--foreground', 'Run daemon in foreground (attached to terminal, not detached)')
  .option('--humanlike', 'Add random delays to simulate human-like interactions')
  .option('--remote <ws-url>', 'Connect to a remote Playwright server via WebSocket URL')
  .action(async (opts) => {
    const name = getInstanceName();
    const instance = getInstance(name);
    if (instance) {
      try {
        const health = await send('/health', 'GET', undefined, instance.port);
        if (health === 'ok') {
          console.log(`Instance "${name}" is already running (port ${instance.port}).`);
          return;
        }
      } catch (err) {
        // Health check failed, assume daemon is stale
        console.log('Found stale daemon process, attempting to stop it...');
        try {
          process.kill(instance.pid);
        } catch {}
        unregisterInstance(name);
        console.log('Stale daemon stopped.');
      }
    }

    // Allocate port (default instance prefers 3030)
    let port;
    if (name === 'default' && !getInstance('default') && await isPortFree(3030)) {
      port = 3030;
    } else {
      port = await allocatePort();
    }

    // Prepare environment variables for daemon
    const env = { ...process.env, BR_PORT: String(port), BR_INSTANCE: name };
    if (opts.headless) {
      env.BR_HEADLESS = 'true';
      console.log('Running in headless mode');

      // Parse viewport size (default: 1280x720)
      if (opts.viewport) {
        const [width, height] = opts.viewport.split('x').map(n => parseInt(n, 10));
        if (isNaN(width) || isNaN(height)) {
          console.error('Invalid viewport size format. Please use WIDTHxHEIGHT (e.g., 1920x1080)');
          process.exit(EXIT_ERROR);
        }
        env.BR_VIEWPORT_WIDTH = width.toString();
        env.BR_VIEWPORT_HEIGHT = height.toString();
        console.log(`Viewport size: ${width}x${height}`);
      }
    }
    if (opts.adblock) {
      env.BR_ADBLOCK = 'true';
      console.log('Ad blocking enabled');
    }
    if (opts.adblockBase) {
      env.BR_ADBLOCK_BASE = opts.adblockBase;
      console.log('Base filter level:', opts.adblockBase);
    }
    if (opts.adblockLists) {
      // Validate additional filter list files
      const adblockLists = opts.adblockLists.split(',');
      let invalidLists = [];

      for (const list of adblockLists) {
        const trimmedList = list.trim();
        // Skip URLs, only validate file paths
        if (!trimmedList.startsWith('http://') && !trimmedList.startsWith('https://')) {
          if (!fs.existsSync(trimmedList)) {
            invalidLists.push(trimmedList);
          }
        }
      }

      if (invalidLists.length > 0) {
        console.error(`Error: Filter list file(s) not found: ${invalidLists.join(', ')}`);
        process.exit(EXIT_ERROR);
      }

      env.BR_ADBLOCK_LISTS = opts.adblockLists;
      console.log('Additional filter lists:', opts.adblockLists);
    }
    if (opts.humanlike) {
      env.BR_HUMANLIKE = 'true';
      console.log('Human-like mode enabled');
    }
    if (opts.remote) {
      env.BR_REMOTE_WS = opts.remote;
      console.log('Remote browser:', opts.remote);
    }

    if (!opts.remote) {
      // Check that browser binary is installed
      const { chromium } = require('patchright');
      if (!fs.existsSync(chromium.executablePath())) {
        console.error('Browser not found. Run: npx patchright install chromium');
        process.exit(EXIT_ERROR);
      }
    }

    if (opts.foreground) {
      // Run in foreground - don't detach, inherit stdio
      console.log(`Starting daemon "${name}" in foreground mode on port ${port}...`);
      const child = spawn(process.execPath, [path.join(__dirname, '../daemon.js')], {
        detached: false,
        stdio: 'inherit',
        env
      });

      registerInstance(name, port, child.pid);

      child.on('exit', () => {
        unregisterInstance(name);
      });

    } else {
      // Run in background - detached mode
      const child = spawn(process.execPath, [path.join(__dirname, '../daemon.js')], {
        detached: true,
        stdio: 'ignore',
        env
      });

      child.unref();
      registerInstance(name, port, child.pid);

      // Poll health endpoint to confirm daemon is ready
      const startTime = Date.now();
      const checkHealth = async () => {
        if (Date.now() - startTime > 5000) {
          unregisterInstance(name);
          console.error('Daemon failed to start in a timely manner.');
          process.exit(EXIT_ERROR);
        }

        try {
          await send('/health', 'GET', undefined, port);
          console.log(`Daemon "${name}" started on port ${port}.`);
          process.exit(0);
        } catch (err) {
          setTimeout(checkHealth, 100);
        }
      };

      setTimeout(checkHealth, 100);
    }
  });

program
  .command('stop')
  .description('Stop the headless browser daemon process.')
  .option('-a, --all', 'Stop all running instances')
  .action(async (opts) => {
    if (opts.all) {
      const registry = readRegistry();
      const names = Object.keys(registry);
      if (names.length === 0) {
        console.log('No instances running.');
        return;
      }
      for (const name of names) {
        try {
          process.kill(registry[name].pid);
          console.log(`Stopped "${name}".`);
        } catch {}
        unregisterInstance(name);
      }
      return;
    }

    const name = getInstanceName();
    const instance = getInstance(name);
    if (instance) {
      try { process.kill(instance.pid); } catch {}
      unregisterInstance(name);
      console.log(`Instance "${name}" stopped.`);
      return;
    }
    console.log(`Instance "${name}" is not running.`);
  });

program
  .command('list')
  .alias('ls')
  .description('List all running browser instances.')
  .action(() => {
    const registry = readRegistry();
    const entries = Object.entries(registry);
    if (entries.length === 0) {
      console.log('No instances running.');
      return;
    }
    console.log('NAME'.padEnd(16) + 'PORT'.padEnd(8) + 'PID'.padEnd(10) + 'STATUS');
    for (const [name, entry] of entries) {
      console.log(name.padEnd(16) + String(entry.port).padEnd(8) + String(entry.pid).padEnd(10) + 'running');
    }
  });

program
  .command('goto')
  .description('Navigate the browser to a specific URL.')
  .argument('<url>', 'The full URL to navigate to (e.g., "https://example.com").')
  .action(async (url) => {
    // Auto-add https:// if no protocol is specified
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    try {
      await sendToInstance('/goto', 'POST', { url });
      console.log('Navigated to', url);
    } catch (err) {
      handleDaemonError(err);
    }
  });

program
  .command('scrollIntoView')
  .description('Scroll the page until a specific element is in view.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .action(asyncAction(async (selector) => {
    await sendToInstance('/scroll-into-view', 'POST', { selector });
    console.log('Scrolled', selector, 'into view.');
  }));

program
  .command('scrollTo')
  .description('Scroll the page to a given percentage of its total height.')
  .argument('<percentage>', 'A number from 0 to 100.')
  .action(asyncAction(async (percentage) => {
    await sendToInstance('/scroll-to', 'POST', { percentage });
    console.log(`Scrolled to ${percentage}%.`);
  }));

program
  .command('fill')
  .description('Fill a form field with the provided text.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<text>', 'The text to fill the field with.')
  .action(asyncAction(async (selector, text) => {
    await sendToInstance('/fill', 'POST', { selector, text });
    console.log('Filled', selector);
  }));

program
  .command('fill-secret')
  .description('Fill a form field with a value from a specified environment variable. The value is masked in logs.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<envVar>', 'The name of the environment variable containing the secret.')
  .action(asyncAction(async (selector, envVar) => {
    const secret = process.env[envVar];
    if (!secret) {
      console.error(`Error: Environment variable "${envVar}" is not set.`);
      process.exit(EXIT_ERROR);
    }
    await sendToInstance('/fill-secret', 'POST', { selector, secret });
    console.log('Filled secret value into', selector);
  }));

program
  .command('type')
  .description('Simulate typing text into a form field, character by character.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<text>', 'The text to type into the field.')
  .action(asyncAction(async (selector, text) => {
    await sendToInstance('/type', 'POST', { selector, text });
    console.log('Typed text into', selector);
  }));

program
  .command('press')
  .description("Simulate a single key press (e.g., 'Enter', 'Tab').")
  .argument('<key>', "The key to press, as defined in Playwright's documentation.")
  .action(asyncAction(async (key) => {
    await sendToInstance('/press', 'POST', { key });
    console.log('Pressed', key);
  }));

program
  .command('fill-search')
  .description('Fill a search input and submit the query.')
  .argument('<query>', 'The search query to enter.')
  .option('-s, --selector <selector>', 'Explicit CSS selector, XPath expression, or numeric ID from view-tree for the search input')
  .action(asyncAction(async (query, opts) => {
    const body = { query };
    if (opts.selector) body.selector = opts.selector;
    const response = await sendToInstance('/fill-search', 'POST', body);
    console.log('Searched for:', query);
    if (response.selector) {
      console.log('Used selector:', response.selector);
    }
  }));

program
  .command('nextChunk')
  .description('Scroll down by one viewport height to view the next chunk of content.')
  .action(asyncAction(async () => {
    await sendToInstance('/next-chunk', 'POST');
    console.log('Scrolled to the next chunk.');
  }));

program
  .command('prevChunk')
  .description('Scroll up by one viewport height to view the previous chunk of content.')
  .action(asyncAction(async () => {
    await sendToInstance('/prev-chunk', 'POST');
    console.log('Scrolled to the previous chunk.');
  }));

program
  .command('click')
  .description('Click an element. Supports CSS selectors, XPath, and view-tree IDs.')
  .argument('<selectorOrId>', 'CSS selector (e.g., "input"), XPath expression, or numeric ID from view-tree.')
  .action(asyncAction(async (selector) => {
    await sendToInstance('/click', 'POST', { selector });
    console.log('Clicked', selector);
  }));

program
  .command('screenshot')
  .description('Capture a screenshot of the current page and save it to a file.')
  .option('-f, --full-page', 'Capture the full scrollable page instead of just the viewport')
  .option('-o, --output <path>', 'Custom file path for the screenshot')
  .action(async (opts) => {
    const fullPage = opts.fullPage || false;
    const params = new URLSearchParams({ fullPage });
    if (opts.output) params.append('path', opts.output);
    const file = await sendToInstance(`/screenshot?${params}`);
    console.log('Screenshot saved to:', file);
    console.log('Tip: view-tree can be a much more efficient way to extract info from a page.');
  });

program
  .command('view-html')
  .description('Output the full HTML source of the current page (paginated, 5000 chars per page).')
  .option('-p, --page <number>', 'Page number to view', '1')
  .action(async (opts) => {
    const page = Number(opts.page) || 1;
    const html = await sendToInstance(`/html?page=${page}`);
    if (html.length === 0) {
      console.log('No HTML content found for this page.');
      return;
    }
    const PAGE_SIZE = 5000;
    const totalPages = Math.ceil(html.length / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const chunk = html.slice(start, end);
    console.log(chunk);
    console.log(`\n--- Page ${page} of ${totalPages} ---`);
    if (totalPages > 1) {
      console.log('Use --page <n> to view a different page.');
    }
    if (html.length > PAGE_SIZE) {
      console.log('Hint: If the HTML is too large to view comfortably, try the "view-tree" command for a structured overview.');
    }
  });

program
  .command('history')
  .alias('hist')
  .description('Display the history of actions performed in the current session.')
  .action(async () => {
    const hist = await sendToInstance('/history');
    console.log(hist);
  });

program
  .command('clear-history')
  .description("Clear the session's action history.")
  .action(async () => {
    await sendToInstance('/history/clear', 'POST');
    console.log('History cleared.');
  });

program
  .command('view-tree')
  .description("Display a hierarchical tree of the page's accessibility and DOM nodes.")
  .action(async () => {
    const response = await sendToInstance('/tree');
    let tree = response.tree;

    // Handle the case where tree is still a string (daemon not restarted yet)
    if (typeof tree === 'string') {
      console.log(tree);
      return;
    }

    function displayNode(node, indent = 0) {
      const parts = [`${'  '.repeat(indent)}[${node.id}]`];
      if (node.role) parts.push(node.role);
      if (node.tag) parts.push(node.tag);
      if (node.name) parts.push(`: ${node.name}`);
      console.log(parts.join(' '));

      if (node.options && node.options.length > 0) {
        const shown = node.options.map(o => `${o.value}="${o.label}"${o.selected ? '*' : ''}`).join(', ');
        const more = node.totalOptions > node.options.length ? ` (+${node.totalOptions - node.options.length} more)` : '';
        console.log(`${'  '.repeat(indent + 1)}options: ${shown}${more}`);
      }

      if (node.children && node.children.length > 0) {
        node.children.forEach(child => displayNode(child, indent + 1));
      }
    }

    if (tree) {
      displayNode(tree);
    } else {
      console.log('No tree data found');
    }
  });

program
  .command('tabs')
  .description('List all open tabs (pages) in the browser daemon.')
  .action(async () => {
    const tabs = await sendToInstance('/tabs');
    tabs.forEach(tab => {
      console.log(`${tab.isActive ? '*' : ' '}${tab.index}: ${tab.title} (${tab.url})`);
    });
  });

program
  .command('switch-tab')
  .description('Switch to a different open tab by its index.')
  .argument('<index>', 'The index of the tab to switch to.')
  .action(async (index) => {
    await sendToInstance('/tabs/switch', 'POST', { index: Number(index) });
    console.log('Switched to tab', index);
  });

program
  .command('eval')
  .description('Execute JavaScript in the browser context and return the result.')
  .argument('[script]', 'JavaScript code to execute (if not using --file).')
  .option('-f, --file <path>', 'Path to a JavaScript file to execute.')
  .action(asyncAction(async (script, opts) => {
    let scriptToRun = script;

    if (opts.file) {
      // Read JavaScript from file
      if (!fs.existsSync(opts.file)) {
        console.error(`Error: File not found: ${opts.file}`);
        process.exit(EXIT_ERROR);
      }
      scriptToRun = fs.readFileSync(opts.file, 'utf8');
    }

    if (!scriptToRun) {
      console.error('Error: No script provided. Use either a script argument or --file option.');
      process.exit(EXIT_ERROR);
    }

    const response = await sendToInstance('/eval', 'POST', { script: scriptToRun });
    const { result } = response;

    // Pretty print the result
    if (result === undefined) {
      console.log('undefined');
    } else if (result === null) {
      console.log('null');
    } else if (typeof result === 'object') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result);
    }
  }));

program
  .command('extract-text')
  .description('Extract visible text from the page or specific elements.')
  .option('-s, --selector <selector>', 'CSS selector, XPath expression, or numeric ID from view-tree to extract text from specific elements')
  .action(asyncAction(async (opts) => {
    const body = {};
    if (opts.selector) body.selector = opts.selector;
    const response = await sendToInstance('/extract-text', 'POST', body);
    console.log(response.text);
    if (response.selector) {
      console.log('(using selector:', response.selector + ')');
    }
  }));

// --- Navigation commands ---

program
  .command('back')
  .description('Navigate back in browser history.')
  .action(asyncAction(async () => {
    const response = await sendToInstance('/back', 'POST');
    console.log('Navigated back to', response.url);
  }));

program
  .command('forward')
  .description('Navigate forward in browser history.')
  .action(asyncAction(async () => {
    const response = await sendToInstance('/forward', 'POST');
    console.log('Navigated forward to', response.url);
  }));

program
  .command('reload')
  .description('Reload the current page.')
  .option('--hard', 'Hard reload (bypass cache)')
  .action(asyncAction(async (opts) => {
    await sendToInstance('/reload', 'POST', { hard: !!opts.hard });
    console.log(opts.hard ? 'Hard reloaded (cache bypassed).' : 'Reloaded.');
  }));

program
  .command('clear-cache')
  .description('Clear the browser cache.')
  .action(asyncAction(async () => {
    await sendToInstance('/clear-cache', 'POST');
    console.log('Browser cache cleared.');
  }));

// --- Wait commands ---

program
  .command('wait')
  .description('Wait for an element to appear and become visible.')
  .argument('<selector>', 'CSS selector or XPath expression.')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds (default: 30000)')
  .action(asyncAction(async (selector, opts) => {
    const body = { selector };
    if (opts.timeout) body.timeout = opts.timeout;
    await sendToInstance('/wait', 'POST', body);
    console.log('Element visible:', selector);
  }));

program
  .command('wait-load')
  .description('Wait for the page load event to fire.')
  .action(asyncAction(async () => {
    await sendToInstance('/wait-load', 'POST');
    console.log('Page loaded.');
  }));

program
  .command('wait-stable')
  .description('Wait for the DOM to stabilize (no mutations for 500ms).')
  .action(asyncAction(async () => {
    await sendToInstance('/wait-stable', 'POST');
    console.log('DOM stable.');
  }));

program
  .command('wait-idle')
  .description('Wait for the network to become idle.')
  .action(asyncAction(async () => {
    await sendToInstance('/wait-idle', 'POST');
    console.log('Network idle.');
  }));

// --- DOM query commands ---

program
  .command('exists')
  .description('Check if an element exists in the DOM. Exits with code 1 if not found.')
  .argument('<selector>', 'CSS selector or XPath expression.')
  .action(asyncAction(async (selector) => {
    const response = await sendToInstance('/exists', 'POST', { selector });
    console.log(response.result);
    if (!response.result) process.exit(EXIT_CHECK_FAILED);
  }));

program
  .command('visible')
  .description('Check if an element is visible. Exits with code 1 if not visible.')
  .argument('<selector>', 'CSS selector or XPath expression.')
  .action(asyncAction(async (selector) => {
    const response = await sendToInstance('/visible', 'POST', { selector });
    console.log(response.result);
    if (!response.result) process.exit(EXIT_CHECK_FAILED);
  }));

program
  .command('count')
  .description('Count the number of elements matching a selector.')
  .argument('<selector>', 'CSS selector or XPath expression.')
  .action(asyncAction(async (selector) => {
    const response = await sendToInstance('/count', 'POST', { selector });
    console.log(response.count);
  }));

program
  .command('attr')
  .description('Get the value of an attribute from an element.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<attribute>', 'The attribute name to read.')
  .action(asyncAction(async (selector, attribute) => {
    const response = await sendToInstance('/attr', 'POST', { selector, attribute });
    console.log(response.value);
  }));

// --- Select and Submit commands ---

program
  .command('select')
  .description('Select a value in a <select> dropdown element.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .argument('<value>', 'The value to select.')
  .action(asyncAction(async (selector, value) => {
    const response = await sendToInstance('/select', 'POST', { selector, value });
    console.log(`Selected: "${response.value}" (${response.label})`);
  }));

program
  .command('submit')
  .description('Submit a form. The selector can point to the form or any element inside it.')
  .argument('<selectorOrId>', 'CSS selector, XPath expression, or numeric ID from view-tree.')
  .action(asyncAction(async (selector) => {
    await sendToInstance('/submit', 'POST', { selector });
    console.log('Form submitted.');
  }));

// --- PDF export ---

program
  .command('pdf')
  .description('Export the current page as a PDF file.')
  .option('-o, --output <path>', 'Custom file path for the PDF')
  .option('--format <size>', 'Page format: Letter, A4, etc. (default: Letter)')
  .action(asyncAction(async (opts) => {
    const params = new URLSearchParams();
    if (opts.output) params.append('path', opts.output);
    if (opts.format) params.append('format', opts.format);
    const file = await sendToInstance(`/pdf?${params}`);
    console.log('PDF saved to:', file);
  }));

// --- Download command ---

program
  .command('download')
  .description("Download a file by URL, or from an element's href/src attribute, using the page's cookies/auth.")
  .argument('<selectorOrIdOrUrl>', 'CSS selector, XPath, numeric ID from view-tree, or a URL.')
  .option('-o, --output <path>', 'Custom file path for the download')
  .action(asyncAction(async (selector, opts) => {
    const body = { selector };
    if (opts.output) body.output = opts.output;
    const response = await sendToInstance('/download', 'POST', body);
    console.log(`Downloaded ${response.url}`);
    console.log(`Saved to: ${response.path} (${response.size} bytes)`);
  }));

// --- Assert command ---

program
  .command('assert')
  .description('Evaluate a JavaScript expression and assert on its result. Exits with code 1 on failure.')
  .argument('<script>', 'JavaScript expression to evaluate.')
  .argument('[expected]', 'Expected value (string comparison). If omitted, asserts truthiness.')
  .option('-m, --message <msg>', 'Custom failure message')
  .action(asyncAction(async (script, expected, opts) => {
    const body = { script };
    if (expected !== undefined) body.expected = expected;
    if (opts.message) body.message = opts.message;
    const response = await sendToInstance('/assert', 'POST', body);

    if (response.pass) {
      console.log('pass');
    } else {
      const msg = response.message ? `${response.message}: ` : '';
      if (response.expected !== undefined) {
        console.log(`fail: ${msg}got ${JSON.stringify(response.actual)}, expected ${JSON.stringify(response.expected)}`);
      } else {
        console.log(`fail: ${msg}got ${JSON.stringify(response.actual)}`);
      }
      process.exit(EXIT_CHECK_FAILED);
    }
  }));

const consoleCmd = program
  .command('console')
  .description('Show captured browser console logs and errors.')
  .option('-t, --type <types>', 'Filter by type(s), comma-separated (log,warning,error,info,debug,pageerror)')
  .option('--tab <index>', 'Filter by tab index')
  .option('-l, --limit <n>', 'Max entries to show (default: 50)')
  .option('-c, --clear', 'Clear logs after displaying')
  .action(asyncAction(async (opts) => {
    const params = new URLSearchParams();
    if (opts.type) params.append('type', opts.type);
    if (opts.tab !== undefined) params.append('tab', opts.tab);
    if (opts.clear) params.append('clear', 'true');
    const allLogs = await sendToInstance(`/console?${params}`);
    if (allLogs.length === 0) {
      console.log('No console logs captured.');
      return;
    }
    const limit = parseInt(opts.limit, 10) || 50;
    const logs = allLogs.slice(-limit);
    const colors = { error: '\x1b[31m', warning: '\x1b[33m', pageerror: '\x1b[31m', info: '\x1b[36m', debug: '\x1b[90m' };
    const reset = '\x1b[0m';
    for (const entry of logs) {
      const color = colors[entry.type] || '';
      const ts = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      const tab = entry.tab >= 0 ? `[tab ${entry.tab}] ` : '';
      console.log(`${color}[${ts}] ${tab}[${entry.type.toUpperCase()}] ${entry.text}${color ? reset : ''}`);
    }
    const remaining = allLogs.length - logs.length;
    if (remaining > 0) {
      console.log(`\n${logs.length} shown, ${remaining} more. Use --limit to see more.`);
    }
  }));

consoleCmd
  .command('clear')
  .description('Clear captured console logs.')
  .action(asyncAction(async () => {
    await sendToInstance('/console/clear', 'POST');
    console.log('Console logs cleared.');
  }));

// Show help for unknown commands
program.on('command:*', (operands) => {
  console.error(`error: unknown command '${operands[0]}'`);
  console.log();
  program.outputHelp();
  process.exit(EXIT_ERROR);
});

// Inject BR_PARAMS env var as default flags for "br start"
if (process.env.BR_PARAMS) {
  const subcommandIdx = process.argv.findIndex(a => a === 'start');
  if (subcommandIdx !== -1) {
    const extra = process.env.BR_PARAMS.split(/\s+/).filter(Boolean);
    // Insert after "start" so commander sees them as start's options
    process.argv.splice(subcommandIdx + 1, 0, ...extra);
  }
}

try {
  program.parse();
} catch (err) {
  if (err.code === 'commander.unknownOption') {
    console.log();
    program.outputHelp();
  }
}
