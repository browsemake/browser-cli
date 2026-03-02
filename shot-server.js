const express = require('express');
const { chromium } = require('patchright');
const sharp = require('sharp');
const path = require('path');
const { waitForChallengeBypass, dismissModals, initAdblocker } = require('./utils');

const PORT = process.env.SHOT_PORT || 3031;

(async () => {
  let adblocker = null;
  if (process.env.BR_ADBLOCK === 'true') {
    adblocker = await initAdblocker();
  }

  const browser = await chromium.launch({ headless: true });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => res.send('ok'));

  app.post('/shot', async (req, res) => {
    let page;
    try {
      const { url, width, height, waitTime, output_width, output_format, output_quality } = req.body;

      if (!url) return res.status(400).json({ error: 'missing url parameter' });

      let processedUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        processedUrl = `https://${url}`;
      }

      const context = await browser.newContext();
      page = await context.newPage();
      if (adblocker) await adblocker.enableBlockingInPage(page);

      if (width || height) {
        const viewportWidth = width ? parseInt(width, 10) : 1280;
        const viewportHeight = height ? parseInt(height, 10) : 720;
        await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
      }

      await page.goto(processedUrl, { timeout: 20000 });
      await waitForChallengeBypass(page);

      await page.addStyleTag({
        content: `
          ::-webkit-scrollbar { display: none; }
          html { scrollbar-width: none; }
          html { -ms-overflow-style: none; }
        `
      });

      const additionalWait = waitTime ? parseInt(waitTime, 10) : 1000;
      await page.waitForTimeout(additionalWait);
      await dismissModals(page);

      const isFullPage = !height;
      const screenshotBuffer = await page.screenshot({ fullPage: isFullPage, type: 'png' });

      const format = output_format || 'png';
      const quality = output_quality ? parseInt(output_quality, 10) : 80;

      let processor = sharp(screenshotBuffer);

      if (output_width) {
        processor = processor.resize(parseInt(output_width, 10), null, { withoutEnlargement: true });
      }

      let processedBuffer;
      if (format === 'webp') {
        processedBuffer = await processor.webp({ quality }).toBuffer();
        res.setHeader('Content-Type', 'image/webp');
      } else if (format === 'jpeg' || format === 'jpg') {
        processedBuffer = await processor.jpeg({ quality }).toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
      } else {
        processedBuffer = await processor.png().toBuffer();
        res.setHeader('Content-Type', 'image/png');
      }

      res.setHeader('Content-Length', processedBuffer.length);
      res.send(processedBuffer);
    } catch (err) {
      res.status(500).json({ error: `Error capturing screenshot: ${err.message}` });
    } finally {
      if (page) {
        const ctx = page.context();
        await page.close();
        await ctx.close();
      }
    }
  });

  app.post('/shot-multi', async (req, res) => {
    let page;
    try {
      const { url, width, waitTime, outputs, output_format, output_quality } = req.body;

      if (!url) return res.status(400).json({ error: 'missing url parameter' });
      if (!outputs || !Array.isArray(outputs) || outputs.length === 0) {
        return res.status(400).json({ error: 'outputs must be a non-empty array' });
      }

      let processedUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        processedUrl = `https://${url}`;
      }

      const context = await browser.newContext();
      page = await context.newPage();
      if (adblocker) await adblocker.enableBlockingInPage(page);

      const maxWidth = width ? parseInt(width, 10) : 1280;
      const maxPixelHeight = outputs.reduce((max, o) => Math.max(max, parseInt(o.height) || 0), 0) || null;
      await page.setViewportSize({ width: maxWidth, height: maxPixelHeight || 720 });

      await page.goto(processedUrl, { timeout: 20000 });
      await waitForChallengeBypass(page);

      await page.addStyleTag({
        content: `
          ::-webkit-scrollbar { display: none; }
          html { scrollbar-width: none; }
          html { -ms-overflow-style: none; }
        `
      });

      const additionalWait = waitTime ? parseInt(waitTime, 10) : 1000;
      await page.waitForTimeout(additionalWait);
      await dismissModals(page);

      const format = output_format || 'png';
      const quality = output_quality ? parseInt(output_quality, 10) : 80;

      const fullPage = !maxPixelHeight;
      const screenshotBuffer = await page.screenshot({ fullPage, type: 'png' });
      const metadata = await sharp(screenshotBuffer).metadata();

      const images = await Promise.all(outputs.map(async (output) => {
        const outputHeight = output.height ? parseInt(output.height, 10) : null;
        const outputWidth = output.output_width ? parseInt(output.output_width, 10) : null;
        const outputFormat = output.output_format || format;
        const outputQuality = output.output_quality ? parseInt(output.output_quality, 10) : quality;

        let processor = sharp(screenshotBuffer);

        if (outputHeight && metadata.height > outputHeight) {
          processor = processor.extract({ left: 0, top: 0, width: metadata.width, height: outputHeight });
        }

        if (outputWidth) {
          processor = processor.resize(outputWidth, null, { withoutEnlargement: true });
        }

        let buffer;
        let contentType;
        if (outputFormat === 'webp') {
          buffer = await processor.webp({ quality: outputQuality }).toBuffer();
          contentType = 'image/webp';
        } else if (outputFormat === 'jpeg' || outputFormat === 'jpg') {
          buffer = await processor.jpeg({ quality: outputQuality }).toBuffer();
          contentType = 'image/jpeg';
        } else {
          buffer = await processor.toBuffer();
          contentType = 'image/png';
        }

        const finalMetadata = await sharp(buffer).metadata();
        return {
          data: buffer.toString('base64'),
          content_type: contentType,
          height: finalMetadata.height,
          width: finalMetadata.width
        };
      }));

      res.json({ images });
    } catch (err) {
      res.status(500).json({ error: `Error capturing screenshots: ${err.message}` });
    } finally {
      if (page) {
        const ctx = page.context();
        await page.close();
        await ctx.close();
      }
    }
  });

  app.post('/shutdown', async (req, res) => {
    res.send('Shutting down');
    await browser.close();
    process.exit(0);
  });

  app.listen(PORT, () => {
    console.log(`shot-server running on port ${PORT}`);
  });

  process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
})().catch(err => {
  console.error('shot-server error:', err);
  process.exit(1);
});
