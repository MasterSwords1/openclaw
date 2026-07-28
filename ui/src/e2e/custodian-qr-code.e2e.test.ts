// Control UI tests cover system-agent QR presentation through the mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import { chromium, type Browser, type Page } from "playwright";
import qrcode from "qrcode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "custodian-qr-code");

let browser: Browser;
let server: ControlUiE2eServer;

async function capture(page: Page, name: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI system-agent QR presentation", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("advertises support and renders a non-skippable QR step responsively", async () => {
    const qrPayload = "https://openclaw.ai/system-agent-qr-proof";
    const qrDataUrl = await qrcode.toDataURL(qrPayload, { margin: 2, width: 560 });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
      methodResponses: {
        "openclaw.chat": {
          sessionId: "e2e-system-agent-qr",
          reply: "Scan this code to continue setup.",
          action: "none",
          wizardInputPending: true,
          question: {
            id: "setup-qr",
            header: "Scan QR code",
            question: "Scan the code, then continue.",
            options: [{ label: "Continue" }],
            allowSkip: false,
          },
          qrDataUrl,
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}custodian?onboarding=1`);
      expect(response?.status()).toBe(200);
      const image = page.getByAltText("Setup QR code");
      await image.waitFor();

      const connect = await gateway.waitForRequest("connect");
      expect(connect.params).toMatchObject({
        caps: expect.arrayContaining([GATEWAY_CLIENT_CAPS.SYSTEM_AGENT_QR_CODE]),
      });
      const request = await gateway.waitForRequest("openclaw.chat");
      expect(request.params).not.toHaveProperty("capabilities");
      expect(await image.getAttribute("src")).toBe(qrDataUrl);
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      const continueButton = page.getByRole("button", { name: "Continue" });
      expect(await continueButton.isVisible()).toBe(true);
      expect(await continueButton.getAttribute("role")).toBeNull();
      expect(await continueButton.getAttribute("aria-checked")).toBeNull();
      expect(await page.getByRole("button", { name: "Skip for now" }).count()).toBe(0);

      for (const viewport of [
        { height: 844, width: 390, name: "mobile-390x844.png" },
        { height: 1024, width: 768, name: "tablet-768x1024.png" },
        { height: 900, width: 1440, name: "desktop-1440x900.png" },
      ]) {
        await page.setViewportSize(viewport);
        const [actionGridBox, continueButtonBox] = await Promise.all([
          page.locator(".option-card__choices").boundingBox(),
          continueButton.boundingBox(),
        ]);
        if (!actionGridBox || !continueButtonBox) {
          throw new Error(`missing QR action geometry at ${viewport.width}x${viewport.height}`);
        }
        expect(Math.abs(continueButtonBox.x - actionGridBox.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(continueButtonBox.width - actionGridBox.width)).toBeLessThanOrEqual(1);
        expect(continueButtonBox.x + continueButtonBox.width).toBeLessThanOrEqual(viewport.width);
        await expect
          .poll(() =>
            page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          )
          .toBe(true);
        await capture(page, viewport.name);
      }
    } finally {
      await context.close();
    }
  });
});
