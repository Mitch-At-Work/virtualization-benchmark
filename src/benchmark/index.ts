import puppeteer from "puppeteer";

import { processMap, processMemory } from "./memory";
import { delay } from "../utils/delay";
import { calculateMean, calculateMedian } from "./math";
import { Sample } from "./sample";
import { Mode } from "../utils/configuration";
import { startProcessMetrics } from "../utils/processMetrics";
import {
  FrameObject,
  PuppeteerScreenCastFrames,
} from "../utils/PuppeteerScreenCastFrames";
import { base64ToWhitespaceAmount } from "../utils/base64ToWhitespaceAmount";
import rimraf from "rimraf";

const PROCESS_NAME = "type=renderer";

export async function scrollOverTime(
  page: puppeteer.Page,
  {
    duration = 0, // How long to scroll for [ms]
    deltaX = 0, // How much to scroll horizontally on each tick [px]
    deltaY = 0, // How much to scroll vertically on each tick [px]
    interval = 16, // Tick interval [ms]
    easingCycle = 0, // ease in/out scrolling in cycles of this duration [ms]
  } = {}
) {
  const startTime = Date.now();
  let now = Date.now();
  const cycles = easingCycle / interval;
  let i = 0;

  while (now < startTime + duration) {
    const fraction = cycles
      ? (Math.sin((2 * i * Math.PI) / cycles - Math.PI / 2) + 1) / 2
      : 1;
    i += 1;
    await Promise.race([
      page.mouse.wheel({
        deltaX: fraction * deltaX,
        deltaY: fraction * deltaY,
      }),
      delay(interval),
    ]);
    now = Date.now();
  }
}
export interface FPSMeasureOptions {
  browser: puppeteer.Browser;
  setupTest: (page: puppeteer.Page) => Promise<void>;
  url: string;
  mode: Mode;
}

// Inspired by
// https://github.com/Janpot/mui-plus/blob/master/scripts/benchmark.ts
export async function generateSamples({
  browser,
  setupTest,
  url,
  mode,
}: FPSMeasureOptions) {
  const samples: Sample[] = [];
  const frames: FrameObject[] = [];

  const processes = await processMap(PROCESS_NAME);
  for (let i = 0; i < 4; i += 1) {
    const page = await browser.newPage();
    const devtoolsProtocolClient = await page.target().createCDPSession();
    await devtoolsProtocolClient.send("Overlay.setShowFPSCounter", {
      show: true,
    });
    const imageFrames: FrameObject[] = [];
    const puppeteerScreenCastFrames = new PuppeteerScreenCastFrames();
    await puppeteerScreenCastFrames.init(devtoolsProtocolClient, (frame) => {
      imageFrames.push(frame);
    });
    await page.goto(url);
    await delay(1000);
    page.evaluate((mode) => {
      window.__setMode(mode);
    }, mode);

    const getProcessMetrics = await startProcessMetrics(
      devtoolsProtocolClient,
      300
    );
    page.evaluate(() => {
      window.__fps = [];
      window.__renders = 0;
      window.__start = window.performance.now();
      let lastFrameTime: number;
      const loop = (frameTime: number) => {
        if (typeof lastFrameTime === "number") {
          const fps = 1 / ((window.performance.now() - lastFrameTime) / 1000);
          window.__fps!.push(fps);
        }
        lastFrameTime = frameTime;
        window.requestAnimationFrame(loop);
      };
      window.requestAnimationFrame(loop);
    });

    await puppeteerScreenCastFrames.start({ maxHeight: 600, maxWidth: 800 });
    await setupTest(page);
    await puppeteerScreenCastFrames.stop();

    const fps = await page.evaluate(() => window.__fps);
    const renders = await page.evaluate(() => window.__renders)!;
    const duration = await page.evaluate(
      () => window.__lastRender! - window.__start!
    );
    const metrics = await page.metrics();
    const processMetrics = await getProcessMetrics();
    await page.close();
    const { pid, memory, cpu } = await processMemory(processes, PROCESS_NAME);
    processes[pid] = true;

    samples.push({
      process: processMetrics,
      fps: fps ?? [],
      memory: Number.parseInt(memory),
      cpu: Math.ceil(Number.parseFloat(cpu)),
      renders: renders!,
      duration,
      frames: metrics.Frames!,
      layoutCount: metrics.LayoutCount!,
      layoutDuration: metrics.LayoutDuration!,
      nodes: metrics.Nodes!,
      recalcStyleCount: metrics.RecalcStyleCount!,
      recalcStyleDuration: metrics.RecalcStyleDuration!,
      whitespaceAmount: calculateMedian(
        await Promise.all(
          imageFrames.map((frame) => base64ToWhitespaceAmount(frame.data))
        )
      ),
    });
    frames.push(...imageFrames);
  }
  return [samples, frames] as const;
}
