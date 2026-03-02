const express = require('express');
const { chromium } = require('patchright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initAdblocker } = require('./utils');

// Optional ad blocking (off by default)
// Enable with: BR_ADBLOCK=true br start
// Base level: BR_ADBLOCK_BASE=none|adsandtrackers|full|ads
// Additional lists: BR_ADBLOCK_LISTS=https://url1.txt,https://url2.txt
let adblocker = null;

let lastIdToXPath = {}; // Global variable to store the last idToXPath mapping
let lastIdToNodeRef = {}; // Maps view-tree ID → { backendNodeId, frameUrl }
const secrets = new Set();
const history = [];
const consoleLogs = [];
const MAX_CONSOLE_LOGS = 1000;

function addConsoleLog(entry) {
  consoleLogs.push(entry);
  if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();
}

async function attachConsoleListeners(page, getTabIndex) {
  const session = await page.context().newCDPSession(page);
  await session.send('Runtime.enable');
  session.on('Runtime.consoleAPICalled', event => {
    const text = event.args.map(a => a.value !== undefined ? String(a.value) : a.description || '').join(' ');
    addConsoleLog({
      type: event.type,
      text,
      timestamp: new Date().toISOString(),
      url: page.url(),
      tab: getTabIndex()
    });
  });
  session.on('Runtime.exceptionThrown', event => {
    const desc = event.exceptionDetails.exception?.description
      || event.exceptionDetails.text || 'Unknown error';
    addConsoleLog({
      type: 'pageerror',
      text: desc,
      timestamp: new Date().toISOString(),
      url: page.url(),
      tab: getTabIndex()
    });
  });
}

function record(action, args = {}) {
  history.push({ action, args, timestamp: new Date().toISOString() });
}

function humanDelay(minMs, maxMs) {
  if (process.env.BR_HUMANLIKE !== 'true') return Promise.resolve();
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, delay));
}

const instanceName = process.env.BR_INSTANCE || 'default';
const userDataDir = instanceName === 'default'
  ? path.join(os.tmpdir(), `br_user_data_default_${Date.now()}`)
  : path.join(os.homedir(), '.config', 'br', 'profiles', instanceName);

(async () => {
  // Initialize adblocker if enabled
  if (process.env.BR_ADBLOCK === 'true') {
    adblocker = await initAdblocker();
  }
  // Set viewport size for headless mode
  let viewport = null;
  if (process.env.BR_HEADLESS === 'true') {
    const width = parseInt(process.env.BR_VIEWPORT_WIDTH || '1280', 10);
    const height = parseInt(process.env.BR_VIEWPORT_HEIGHT || '720', 10);
    viewport = { width, height };
  }

  let context, browser;
  const remoteWs = process.env.BR_REMOTE_WS;

  if (remoteWs) {
    browser = await chromium.connect(remoteWs);
    context = await browser.newContext({ viewport });
    console.log('Connected to remote browser:', remoteWs);
  } else {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.BR_HEADLESS === 'true',
      viewport
    });
    browser = context.browser();
  }

  let pages = [];
  let activePage;

  const initialPage = await context.newPage();
  pages.push(initialPage);
  activePage = initialPage;
  if (adblocker) await adblocker.enableBlockingInPage(initialPage);
  await attachConsoleListeners(initialPage, () => pages.indexOf(initialPage));

  context.on('page', async newPage => {
    pages = await context.pages();
    activePage = newPage;
    if (adblocker) await adblocker.enableBlockingInPage(newPage);
    await attachConsoleListeners(newPage, () => pages.indexOf(newPage));
  });

  context.on('framenavigated', async frame => {
    if (frame === activePage.mainFrame()) {
      // The active page's main frame navigated, update activePage to ensure it's still the correct reference
      // This is a safeguard, as Playwright's page object should remain consistent across navigations
      // but it helps to re-confirm the active page in case of complex scenarios.
      activePage = frame.page();
    }
  });

  let shuttingDown = false;

  context.on('close', () => {
    if (!shuttingDown) {
      console.log('Browser context closed. Exiting daemon.');
      process.exit(0);
    }
  });

  if (browser) {
    browser.on('disconnected', () => {
      if (!shuttingDown) {
        console.log('Browser disconnected. Exiting daemon.');
        process.exit(0);
      }
    });
  }

  // Listen for page close events
  context.on('pageclose', closedPage => {
    pages = pages.filter(page => page !== closedPage);
    if (activePage === closedPage) {
      // If the active page was closed, switch to the last remaining page or null if no pages left
      activePage = pages.length > 0 ? pages[pages.length - 1] : null;
    }
  });

  const app = express();

  // Add request logging middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  app.use(express.json());

  app.get('/health', (req, res) => {
    res.send('ok');
  });

  app.get('/tabs', async (req, res) => {
    try {
      const tabInfo = await Promise.all(pages.map(async (p, i) => ({
        index: i,
        title: await p.title(),
        url: p.url(),
        isActive: p === activePage
      })));
      res.json(tabInfo);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/tabs/switch', (req, res) => {
    const { index } = req.body;
    if (index === undefined || index < 0 || index >= pages.length) {
      return res.status(400).send('invalid tab index');
    }
    activePage = pages[index];
    record('switch-tab', { index });
    res.send('ok');
  });

  app.post('/goto', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('missing url');
    try {
      const tab = pages.indexOf(activePage);
      await humanDelay(200, 400);
      await activePage.goto(url, {
        timeout: 30000,
        waitUntil: 'domcontentloaded'
      });
      // Clear console logs for this tab on navigation
      for (let i = consoleLogs.length - 1; i >= 0; i--) {
        if (consoleLogs[i].tab === tab) consoleLogs.splice(i, 1);
      }
      await humanDelay(200, 400);
      record('goto', { url });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // Resolve a view-tree ID to a Playwright ElementHandle via CDP.
  // Uses backendNodeId + data-attribute marker to bridge CDP → Playwright.
  // Works across shadow DOM and iframe boundaries.
  async function resolveBackendNode(page, nodeRef) {
    const { backendNodeId, frameUrl } = nodeRef;
    const marker = `br-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Find the Playwright frame matching the frameUrl
    let targetFrame = page.mainFrame();
    if (frameUrl) {
      const found = page.frames().find(f => f.url().split('#')[0] === frameUrl.split('#')[0]);
      if (found) targetFrame = found;
    }

    // Use page-level CDP session (backendNodeIds are resolved within the page's process)
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('DOM.enable');
      const { object } = await session.send('DOM.resolveNode', { backendNodeId });
      // Set marker attribute; for text nodes, walk up to parent element
      await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          var el = this.nodeType === 3 ? this.parentElement : this;
          if (el && el.setAttribute) el.setAttribute('data-br-id', '${marker}');
        }`,
      });
    } finally {
      await session.detach();
    }

    // Playwright CSS pierces shadow DOM by default
    const element = await targetFrame.$(`[data-br-id="${marker}"]`);
    if (element) {
      await element.evaluate(el => el.removeAttribute('data-br-id'));
    }
    return { element, frame: targetFrame };
  }

  async function resolveSelector(page, selector) {
    // Handle numeric IDs from view-tree
    if (isNumericId(selector)) {
      const nodeRef = lastIdToNodeRef[selector];
      if (!nodeRef) throw new Error(`No node ref for view-tree ID: ${selector}`);
      const { element, frame } = await resolveBackendNode(page, nodeRef);
      if (!element) throw new Error(`Element not found for view-tree ID: ${selector}`);
      return { element, actualSelector: selector, frame };
    }

    // CSS/XPath selectors — use Playwright directly
    const element = await page.$(selector);
    if (!element) throw new Error(`Element not found for selector: ${selector}`);
    return { element, actualSelector: selector, frame: page };
  }

  function isNumericId(selector) {
    return !isNaN(selector) && !isNaN(parseFloat(selector));
  }

  async function resolveAndPerformAction(req, res, actionFn, recordAction, recordArgs = {}) {
    let { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');

    try {
      const { element } = await resolveSelector(activePage, selector);
      await actionFn(element);
      record(recordAction, { selector, ...recordArgs });
      res.send('ok');
    } catch (err) {
      res.status(500).send(`Error when action: ${err.message}

Use CSS selectors (e.g., "input"), XPath (e.g., "xpath=//input"), or numeric IDs from view-tree`);
    }
  }

  app.post('/scroll-into-view', async (req, res) => {
    await resolveAndPerformAction(req, res, async (element) => {
      await element.scrollIntoViewIfNeeded();
    }, 'scrollIntoView');
  });

  app.post('/scroll-to', async (req, res) => {
    let { percentage } = req.body;
    if (percentage === undefined) return res.status(400).send('missing percentage');
    percentage = Math.max(0, Math.min(100, Number(percentage)));
    try {
      await activePage.evaluate(pct => {
        window.scrollTo(0, document.body.scrollHeight * (pct / 100));
      }, percentage);
      record('scrollTo', { percentage });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill', async (req, res) => {
    const { text } = req.body;
    if (text === undefined) return res.status(400).send('missing text');
    await resolveAndPerformAction(req, res, async (element) => {
      await element.fill(text);
    }, 'fill', { text });
  });

  app.post('/fill-secret', async (req, res) => {
    const { secret } = req.body;
    if (secret === undefined) return res.status(400).send('missing secret');
    await resolveAndPerformAction(req, res, async (element) => {
      await element.fill(secret);
      secrets.add(secret);
    }, 'fill-secret');
  });

  app.post('/type', async (req, res) => {
    const { text } = req.body;
    if (text === undefined) return res.status(400).send('missing text');
    await resolveAndPerformAction(req, res, async (element) => {
      if (process.env.BR_HUMANLIKE === 'true') {
        for (const char of text) {
          await element.type(char);
          await humanDelay(30, 80);
        }
      } else {
        await element.type(text);
      }
    }, 'type', { text });
  });

  app.post('/press', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).send('missing key');
    try {
      await activePage.keyboard.press(key);
      record('press', { key });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill-search', async (req, res) => {
    const { query, selector } = req.body;
    if (!query || !query.trim()) return res.status(400).send('missing query');

    try {
      let searchInput;
      let foundSelector = null;

      if (selector) {
        // Use explicit selector if provided
        const { element, actualSelector } = await resolveSelector(activePage, selector);
        searchInput = element;
        foundSelector = actualSelector;
      } else {
        // Smart search input detection
        const searchSelectors = [
          'input[type="search"]',
          'input[name="q"]',
          'input[name="query"]',
          'input[name="search"]',
          'input[placeholder*="search" i]',
          '[role="searchbox"]',
          'input[placeholder*="Search" i]'
        ];

        for (const sel of searchSelectors) {
          const element = await activePage.$(sel);
          if (element) {
            searchInput = element;
            foundSelector = sel;
            break;
          }
        }

        if (!searchInput) {
          return res.status(400).send('No search input found. Try again with --selector to specify the exact search input.');
        }
      }

      await humanDelay(50, 150);
      await searchInput.fill(query);
      await humanDelay(50, 150);
      await activePage.keyboard.press('Enter');

      record('search', { query, selector: foundSelector });
      res.json({ status: 'ok', selector: foundSelector });
    } catch (err) {
      res.status(500).send(`Search error: ${err.message}

Try using --selector to specify the search input explicitly.`);
    }
  });

  app.post('/next-chunk', async (req, res) => {
    try {
      await activePage.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      record('next-chunk');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/prev-chunk', async (req, res) => {
    try {
      await activePage.evaluate(() => {
        window.scrollBy(0, -window.innerHeight);
      });
      record('prev-chunk');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/click', async (req, res) => {
    await resolveAndPerformAction(req, res, async (element) => {
      await humanDelay(50, 150);
      await element.click();
    }, 'click');
  });

  app.get('/screenshot', async (req, res) => {
    try {
      const dir = path.join(os.tmpdir(), 'br_cli');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let file;
      if (req.query.path) {
        // Use custom path, resolve relative paths against current directory
        file = path.resolve(req.query.path);
      } else {
        // Generate default filename with domain
        const url = new URL(activePage.url());
        const domain = url.hostname.replace(/[^a-zA-Z0-9.-]/g, '');
        file = path.join(dir, `shot-${domain}-${Date.now()}.png`);
      }

      const fullPage = req.query.fullPage === 'true';
      await activePage.screenshot({ path: file, fullPage });
      record('screenshot', { fullPage, path: file });
      res.send(file);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/html', async (req, res) => {
    try {
      let html = await activePage.content();
      for (const secret of secrets) {
        if (!secret) continue;
        html = html.split(secret).join('***');
      }
      res.send(html);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/history', (req, res) => {
    res.json(history);
  });

  app.post('/history/clear', (req, res) => {
    history.length = 0;
    res.send('ok');
  });

  app.get('/tree', async (req, res) => {
    try {
      const page = activePage;
      const session = await page.context().newCDPSession(page);
      await session.send('DOM.enable');
      await session.send('Accessibility.enable');
      await session.send('Page.enable');

      // Get AX tree for main frame
      const { nodes: axNodes } = await session.send('Accessibility.getFullAXTree');
      // Track frame URL per AX node (null = main frame)
      const axNodeFrameUrl = new Map();
      for (const n of axNodes) axNodeFrameUrl.set(n.nodeId, null);

      // Get AX trees from child frames and graft them onto Iframe AX nodes
      const { frameTree } = await session.send('Page.getFrameTree');
      const childFrames = [];
      (function collectFrames(tree) {
        for (const child of tree.childFrames || []) {
          childFrames.push(child.frame);
          collectFrames(child);
        }
      })(frameTree);

      // Map Iframe AX nodes (childless) by backendDOMNodeId for grafting
      const iframeAxByBackendId = new Map();
      for (const n of axNodes) {
        if (n.role?.value === 'Iframe' && (!n.childIds || n.childIds.length === 0)) {
          iframeAxByBackendId.set(n.backendDOMNodeId, n);
        }
      }

      for (const childFrame of childFrames) {
        try {
          const { nodes: frameNodes } = await session.send('Accessibility.getFullAXTree', { frameId: childFrame.id });
          if (!frameNodes.length) continue;

          // Offset node IDs to avoid collisions across frames
          const offset = (childFrames.indexOf(childFrame) + 1) * 100000;
          for (const n of frameNodes) {
            n.nodeId = String(Number(n.nodeId) + offset);
            if (n.childIds) n.childIds = n.childIds.map(id => String(Number(id) + offset));
            axNodeFrameUrl.set(n.nodeId, childFrame.url);
          }

          // Find the root of this frame's AX tree
          const frameChildSet = new Set();
          for (const n of frameNodes) {
            for (const cid of n.childIds || []) frameChildSet.add(cid);
          }
          const frameRoot = frameNodes.find(n => !frameChildSet.has(n.nodeId));

          // Match frame to its parent Iframe AX node via DOM:
          // The iframe DOM node's contentDocument.frameId matches childFrame.id
          // We can also match by looking up the iframe DOM node that owns this frame
          // Use DOM.getFrameOwner to find the backendNodeId of the iframe element
          try {
            const { backendNodeId: ownerBackendId } = await session.send('DOM.getFrameOwner', { frameId: childFrame.id });
            const iframeAx = iframeAxByBackendId.get(ownerBackendId);
            if (iframeAx && frameRoot) {
              iframeAx.childIds = [frameRoot.nodeId];
            }
          } catch {}

          axNodes.push(...frameNodes);
        } catch {}
      }

      const { root: domRoot } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      await session.detach();

      const nodeIdToDomNodeMap = new Map();
      const backendIdToDomNodeMap = new Map();
      let idToXPath = {};
      function generateXPath(node, parentNode) {
        if (!node || node.nodeName === '#document') {
          return '';
        }

        const tagName = node.nodeName.toLowerCase();
        let segment = tagName;

        if (parentNode && parentNode.children) {
          const siblings = parentNode.children.filter(child => child.nodeName === node.nodeName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(node) + 1;
            segment += `[${index}]`;
          }
        }
        return segment;
      }

      function traverseDomAndMap(node, parentXPath = '', parentNode = null) {
        if (!node) return;

        nodeIdToDomNodeMap.set(node.nodeId, node);
        backendIdToDomNodeMap.set(node.backendNodeId, node);

        const currentSegment = generateXPath(node, parentNode);
        const currentXPath = parentXPath ? `${parentXPath}/${currentSegment}` : `/${currentSegment}`;

        if (node.nodeId) {
          idToXPath[node.nodeId] = currentXPath;
        }

        if (node.children) {
          for (const child of node.children) {
            traverseDomAndMap(child, currentXPath, node);
          }
        }

        // Enter iframe content documents and shadow roots
        if (node.contentDocument) {
          traverseDomAndMap(node.contentDocument, '', null);
        }
        if (node.shadowRoots) {
          for (const shadow of node.shadowRoots) {
            traverseDomAndMap(shadow, currentXPath, node);
          }
        }
      }

      traverseDomAndMap(domRoot);

      const axMap = new Map();
      const childSet = new Set();
      for (const node of axNodes) {
        axMap.set(node.nodeId, node);
        for (const childId of node.childIds || []) childSet.add(childId);
      }
      const rootAx = axNodes.find(n => !childSet.has(n.nodeId)) || axNodes[0];

      let idToNodeRef = {};

      function buildTree(nodeId) {
        const axNode = axMap.get(nodeId);
        if (!axNode) return null;

        const domNode = backendIdToDomNodeMap.get(axNode.backendDOMNodeId);
        const role = axNode.role?.value || '';
        const name = axNode.name?.value || '';
        const tag = domNode ? domNode.nodeName.toLowerCase() : null;

        // Store node reference for CDP-based element resolution
        if (axNode.backendDOMNodeId) {
          idToNodeRef[axNode.nodeId] = {
            backendNodeId: axNode.backendDOMNodeId,
            frameUrl: axNodeFrameUrl.get(nodeId) || null
          };
        }

        // Store xpath mapping for this node
        if (domNode && domNode.nodeId) {
          idToXPath[axNode.nodeId] = idToXPath[domNode.nodeId];
        }

        const node = {
          id: axNode.nodeId,
          role: role,
          name: name || null,
          tag: tag ? `<${tag}>` : null,
          xpath: idToXPath[axNode.nodeId] || null,
          children: []
        };

        // Extract options from <select> elements
        if (tag === 'select' && domNode && domNode.children) {
          const optionNodes = domNode.children.filter(c => c.nodeName === 'OPTION');
          node.totalOptions = optionNodes.length;
          node.options = optionNodes.slice(0, 10).map(opt => {
            const attrs = opt.attributes || [];
            let value = '';
            let selected = false;
            for (let i = 0; i < attrs.length; i += 2) {
              if (attrs[i] === 'value') value = attrs[i + 1];
              if (attrs[i] === 'selected') selected = true;
            }
            const textChild = opt.children?.find(c => c.nodeType === 3);
            const label = textChild?.nodeValue?.trim() || '';
            return { value, label, selected };
          });
        }

        // Recursively build children
        for (const childId of axNode.childIds || []) {
          const childNode = buildTree(childId);
          if (childNode) {
            node.children.push(childNode);
          }
        }

        return node;
      }

      const tree = buildTree(rootAx.nodeId);
      lastIdToXPath = idToXPath; // Store the mapping globally
      lastIdToNodeRef = idToNodeRef;
      res.json({ tree });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  app.post('/xpath-for-id', (req, res) => {
    const { id } = req.body;
    if (id === undefined) return res.status(400).send('missing id');
    const xpath = lastIdToXPath[id];
    if (!xpath) return res.status(400).send('XPath not found for ID');
    res.json({ xpath });
  });

  app.post('/eval', async (req, res) => {
    const { script } = req.body;
    if (!script) return res.status(400).send('missing script');
    try {
      const result = await activePage.evaluate((scriptToRun) => {
        return eval(scriptToRun);
      }, script);
      record('eval', { script });
      // Return result as JSON to handle various types (undefined, null, objects, primitives)
      res.json({ result });
    } catch (err) {
      res.status(500).send(`Error evaluating script: ${err.message}`);
    }
  });

  app.post('/extract-text', async (req, res) => {
    try {
      const page = activePage;
      const { selector } = req.body;

      let resolvedSelector = null;
      let response = { text: '' };

      if (selector) {
        const resolved = await resolveSelector(page, selector);
        resolvedSelector = resolved.actualSelector;
        response.selector = resolvedSelector;
      }

      const text = await page.evaluate((sel, maxElements = 1000, timeout = 5000) => {
        const startTime = Date.now();

        if (sel) {
          const elements = Array.from(document.querySelectorAll(sel));
          if (elements.length > maxElements) {
            throw new Error(`Too many elements found (${elements.length} > ${maxElements})`);
          }

          if (Date.now() - startTime > timeout) {
            throw new Error('Timeout during extraction');
          }

          return elements.map((el, index) => {
            const text = el.innerText || '';
            return `[Element ${index + 1}]\n${text}`;
          }).join('\n\n---\n\n');
        } else {
          return document.body.innerText || '';
        }
      }, resolvedSelector);

      response.text = text || 'No text found';
      res.json(response);

    } catch (err) {
      res.status(500).send(`Error extracting text: ${err.message}`);
    }
  });

  app.get('/console', (req, res) => {
    let logs = [...consoleLogs];
    if (req.query.type) {
      const types = req.query.type.split(',');
      logs = logs.filter(l => types.includes(l.type));
    }
    if (req.query.tab !== undefined) {
      const tab = parseInt(req.query.tab, 10);
      logs = logs.filter(l => l.tab === tab);
    }
    if (req.query.clear === 'true') consoleLogs.length = 0;
    res.json(logs);
  });

  app.post('/console/clear', (req, res) => {
    consoleLogs.length = 0;
    res.send('ok');
  });

  // --- Navigation commands ---

  app.post('/back', async (req, res) => {
    try {
      const urlBefore = activePage.url();
      await activePage.evaluate(() => history.back());
      await activePage.waitForURL(url => url.toString() !== urlBefore, { timeout: 5000 })
        .catch(() => {});
      const urlAfter = activePage.url();
      if (urlAfter === urlBefore) return res.status(400).send('No back history');
      record('back');
      res.json({ url: urlAfter });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/forward', async (req, res) => {
    try {
      const urlBefore = activePage.url();
      await activePage.evaluate(() => history.forward());
      await activePage.waitForURL(url => url.toString() !== urlBefore, { timeout: 5000 })
        .catch(() => {});
      const urlAfter = activePage.url();
      if (urlAfter === urlBefore) return res.status(400).send('No forward history');
      record('forward');
      res.json({ url: activePage.url() });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/reload', async (req, res) => {
    try {
      if (req.body.hard) {
        // Hard reload bypasses cache via CDP
        const session = await activePage.context().newCDPSession(activePage);
        await session.send('Page.reload', { ignoreCache: true });
        await session.detach();
        await activePage.waitForLoadState('domcontentloaded');
      } else {
        await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      record('reload', { hard: !!req.body.hard });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/clear-cache', async (req, res) => {
    try {
      const session = await activePage.context().newCDPSession(activePage);
      await session.send('Network.clearBrowserCache');
      await session.detach();
      record('clear-cache');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- Wait commands ---

  app.post('/wait', async (req, res) => {
    const { selector, timeout } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const timeoutMs = timeout ? Number(timeout) : 30000;
      await activePage.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
      record('wait', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/wait-load', async (req, res) => {
    try {
      await activePage.waitForLoadState('load');
      record('wait-load');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/wait-stable', async (req, res) => {
    try {
      await activePage.waitForLoadState('domcontentloaded');
      // Wait for DOM stability: no layout changes for 500ms
      await activePage.evaluate(() => {
        return new Promise((resolve) => {
          let timer;
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); resolve(); }, 500);
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(() => { observer.disconnect(); resolve(); }, 500);
        });
      });
      record('wait-stable');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/wait-idle', async (req, res) => {
    try {
      await activePage.waitForLoadState('networkidle');
      record('wait-idle');
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- DOM query commands ---

  app.post('/exists', async (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const element = await activePage.$(selector);
      res.json({ result: !!element });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/visible', async (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const element = await activePage.$(selector);
      if (!element) {
        return res.json({ result: false });
      }
      const isVisible = await element.isVisible();
      res.json({ result: isVisible });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/count', async (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const elements = await activePage.$$(selector);
      res.json({ count: elements.length });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/attr', async (req, res) => {
    const { selector, attribute } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    if (!attribute) return res.status(400).send('missing attribute');
    try {
      const { element } = await resolveSelector(activePage, selector);
      const value = await element.getAttribute(attribute);
      if (value === null) {
        return res.status(400).send(`Attribute "${attribute}" not found`);
      }
      res.json({ value });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- Select and Submit commands ---

  app.post('/select', async (req, res) => {
    const { value } = req.body;
    if (value === undefined) return res.status(400).send('missing value');
    const strValue = String(value);  // Coerce to string for toLowerCase() support
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const { element } = await resolveSelector(activePage, selector);
      const result = await element.evaluate((el, val) => {
        // Try matching by value first, then by label text (case-insensitive)
        let option = Array.from(el.options).find(o => o.value === val);
        if (!option) {
          const lowerVal = val.toLowerCase().trim();
          option = Array.from(el.options).find(o => o.textContent.trim().toLowerCase() === lowerVal);
        }
        if (!option) throw new Error(`No option matching "${val}" found`);
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: option.value, label: option.textContent.trim() };
      }, strValue);
      record('select', { selector, value });
      res.json(result);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/submit', async (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      const { element } = await resolveSelector(activePage, selector);
      await element.evaluate(el => {
        const form = el.tagName === 'FORM' ? el : el.closest('form');
        if (!form) throw new Error('No form found for selector');
        form.submit();
      });
      record('submit', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- PDF export ---

  app.get('/pdf', async (req, res) => {
    try {
      const dir = path.join(os.tmpdir(), 'br_cli');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let file;
      if (req.query.path) {
        file = path.resolve(req.query.path);
      } else {
        const url = new URL(activePage.url());
        const domain = url.hostname.replace(/[^a-zA-Z0-9.-]/g, '');
        file = path.join(dir, `page-${domain}-${Date.now()}.pdf`);
      }

      const pdfBuffer = await activePage.pdf({
        format: req.query.format || 'Letter',
        printBackground: true
      });
      fs.writeFileSync(file, pdfBuffer);
      record('pdf', { path: file });
      res.send(file);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- Download command ---

  app.post('/download', async (req, res) => {
    const { selector } = req.body;
    if (!selector) return res.status(400).send('missing selector');
    try {
      let resolvedUrl;

      // Check if the argument is already a URL
      const isUrl = /^https?:\/\//.test(selector) || selector.startsWith('data:');

      if (isUrl) {
        resolvedUrl = selector;
      } else {
        const { element } = await resolveSelector(activePage, selector);

        // Get href or src attribute
        let url = await element.getAttribute('href');
        if (!url) url = await element.getAttribute('src');
        if (!url) {
          return res.status(400).send('Element has no href or src attribute');
        }

        // Resolve relative URLs
        resolvedUrl = await activePage.evaluate((u) => {
          return new URL(u, document.baseURI).href;
        }, url);
      }

      let fileData;

      if (resolvedUrl.startsWith('data:')) {
        // Handle data URLs
        const match = resolvedUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
        if (!match) return res.status(400).send('Invalid data URL');
        const isBase64 = resolvedUrl.includes(';base64,');
        if (isBase64) {
          fileData = Buffer.from(match[2], 'base64');
        } else {
          fileData = Buffer.from(decodeURIComponent(match[2]));
        }
      } else {
        // Fetch via page context to preserve cookies/auth
        const b64 = await activePage.evaluate(async (fetchUrl) => {
          const resp = await fetch(fetchUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        }, resolvedUrl);
        fileData = Buffer.from(b64, 'base64');
      }

      // Determine output path
      const dir = path.join(os.tmpdir(), 'br_cli');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let outputPath;
      if (req.body.output) {
        outputPath = path.resolve(req.body.output);
      } else {
        const parsed = new URL(resolvedUrl);
        let filename = path.basename(parsed.pathname);
        if (!filename || filename === '/') {
          filename = `download-${Date.now()}`;
        }
        outputPath = path.join(dir, filename);
      }

      fs.writeFileSync(outputPath, fileData);
      record('download', { selector, url: resolvedUrl, path: outputPath });
      res.json({ path: outputPath, size: fileData.length, url: resolvedUrl });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // --- Assert command ---

  app.post('/assert', async (req, res) => {
    const { script, expected, message } = req.body;
    if (!script) return res.status(400).send('missing script');
    try {
      const result = await activePage.evaluate((scriptToRun) => {
        return eval(scriptToRun);
      }, script);

      // Format result for comparison
      let resultStr;
      if (result === undefined) resultStr = 'undefined';
      else if (result === null) resultStr = 'null';
      else if (typeof result === 'object') resultStr = JSON.stringify(result, null, 2);
      else resultStr = String(result);

      if (expected !== undefined) {
        // Equality mode: compare string representations
        const pass = resultStr === expected;
        res.json({
          pass,
          actual: resultStr,
          expected,
          message: message || null
        });
      } else {
        // Truthy mode: check if result is truthy
        const pass = !!result;
        res.json({
          pass,
          actual: resultStr,
          message: message || null
        });
      }
    } catch (err) {
      res.status(500).send(`Error evaluating assertion: ${err.message}`);
    }
  });

  app.post('/shutdown', (req, res) => {
    res.send('Shutting down');
    shutdown();
  });

  const port = parseInt(process.env.BR_PORT) || 3030;
  app.listen(port, () => {
    console.log(`br daemon (${instanceName}) running on port ${port}`);
    process.stdout.uncork();
  });

  async function shutdown() {
    shuttingDown = true;
    await context.close();
    if (browser) await browser.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') {
      // Silently ignore EPIPE errors from closed stdout
      return;
    }
    console.error('Uncaught Exception:', err);
    process.exit(1);
  });
})().catch(err => {
  console.error('daemon error:', err);
  process.exit(1);
});
