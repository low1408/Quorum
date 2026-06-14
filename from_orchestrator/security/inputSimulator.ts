import type { Page } from 'playwright';

// QWERTY keyboard matrix to find adjacent keys for typo injection
const QWERTY_MAP: Record<string, string[]> = {
  'a': ['q', 'w', 's', 'z'],
  'b': ['v', 'g', 'h', 'n'],
  'c': ['x', 'd', 'f', 'v'],
  'd': ['s', 'e', 'r', 'f', 'c', 'x'],
  'e': ['w', 'r', 'd', 's'],
  'f': ['d', 'r', 't', 'g', 'v', 'c'],
  'g': ['f', 't', 'y', 'h', 'b', 'v'],
  'h': ['g', 'y', 'u', 'j', 'n', 'b'],
  'i': ['u', 'o', 'k', 'j'],
  'j': ['h', 'u', 'i', 'k', 'm', 'n'],
  'k': ['j', 'i', 'o', 'l', 'm'],
  'l': ['k', 'o', 'p', 'm'],
  'm': ['n', 'j', 'k', 'l'],
  'n': ['b', 'h', 'j', 'm'],
  'o': ['i', 'p', 'l', 'k'],
  'p': ['o', 'l'],
  'q': ['1', '2', 'w', 'a'],
  'r': ['e', 't', 'f', 'd'],
  's': ['a', 'w', 'e', 'd', 'x', 'z'],
  't': ['r', 'y', 'g', 'f'],
  'u': ['y', 'i', 'j', 'h'],
  'v': ['c', 'f', 'g', 'b'],
  'w': ['q', 'e', 's', 'a'],
  'x': ['z', 's', 'd', 'c'],
  'y': ['t', 'u', 'h', 'g'],
  'z': ['a', 's', 'x']
};

/**
 * Simulates genuine, biometric human mouse and keyboard behaviors
 * to defeat advanced heuristic-based anti-bot detection platforms.
 */
export class HumanInputSimulator {
  private static getRandomRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  /**
   * Generates a realistic Fitts's Law-compliant Bézier curve between start and end points
   * with velocity variation and micro-corrections.
   */
  private static generateBezierPoints(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps: number = 30
  ): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    
    // Calculate adaptive deviations
    const deviationX = (endX - startX) * 0.15;
    const deviationY = (endY - startY) * 0.15;
    
    // Control points to skew the curve organically
    const cp1x = startX + (endX - startX) * 0.25 + (Math.random() - 0.5) * deviationX * 2;
    const cp1y = startY + (endY - startY) * 0.25 + (Math.random() - 0.5) * deviationY * 2;
    
    const cp2x = startX + (endX - startX) * 0.75 + (Math.random() - 0.5) * deviationX * 4;
    const cp2y = startY + (endY - startY) * 0.75 + (Math.random() - 0.5) * deviationY * 4;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Cubic Bezier interpolation
      const x = Math.round(
        Math.pow(1 - t, 3) * startX +
        3 * Math.pow(1 - t, 2) * t * cp1x +
        3 * (1 - t) * Math.pow(t, 2) * cp2x +
        Math.pow(t, 3) * endX
      );
      const y = Math.round(
        Math.pow(1 - t, 3) * startY +
        3 * Math.pow(1 - t, 2) * t * cp1y +
        3 * (1 - t) * Math.pow(t, 2) * cp2y +
        Math.pow(t, 3) * endY
      );
      points.push({ x, y });
    }
    return points;
  }

  /**
   * Moves mouse in an organic Bézier path to target element and executes a human click.
   */
  public static async humanClick(page: Page, selector: string): Promise<void> {
    const element = page.locator(selector).first();
    await element.waitFor({ state: 'visible', timeout: 15000 });

    const box = await element.boundingBox();
    if (!box) {
      // Fallback to direct Playwright click if bounding box unavailable
      await element.click();
      return;
    }

    // Slightly randomize target coords within element dimensions to avoid clicking dead-center
    const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
    const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

    // Dynamic starting point originating from offscreen or viewport boundary
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const startX = Math.random() < 0.5 ? 0 : viewport.width;
    const startY = Math.random() * viewport.height;

    const steps = this.getRandomRange(20, 35);
    const path = this.generateBezierPoints(startX, startY, targetX, targetY, steps);

    // Navigate mouse coordinates along organic path
    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(this.getRandomRange(6, 14));
    }

    // Cognitive hesitation pause before click
    await page.waitForTimeout(this.getRandomRange(50, 150));

    // Execute mouse press with brief natural hold duration
    await page.mouse.down();
    await page.waitForTimeout(this.getRandomRange(60, 120));
    await page.mouse.up();
  }

  /**
   * Enters text character-by-character with realistic micro-pauses, boundary breaks,
   * 2% probability QWERTY typos, and correction Backspace sequences.
   */
  public static async typeHumanLike(page: Page, selector: string, text: string): Promise<void> {
    // 1. Move to element naturally and click it to focus
    await this.humanClick(page, selector);
    
    const element = page.locator(selector).first();
    await element.focus();

    for (let i = 0; i < text.length; i++) {
      const char = text[i].toLowerCase();
      const isAlpha = /[a-z]/.test(char);

      // Typo generation: 2% chance on alphabetical characters to hit an adjacent key
      if (isAlpha && Math.random() < 0.02 && QWERTY_MAP[char]) {
        const adjacentKeys = QWERTY_MAP[char];
        const typoChar = adjacentKeys[Math.floor(Math.random() * adjacentKeys.length)];

        // Type typo character
        await page.keyboard.type(typoChar);

        // Pause 150ms-350ms reflecting surprise/frustration
        await page.waitForTimeout(this.getRandomRange(150, 350));

        // Perform Backspace deletion
        await page.keyboard.press('Backspace');

        // Correction delay before typing true value (100ms-250ms)
        await page.waitForTimeout(this.getRandomRange(100, 250));
      }

      // Type genuine character value
      if (text[i] === '\n') {
        await page.keyboard.press('Shift+Enter');
      } else {
        await page.keyboard.type(text[i]);
      }

      // Baseline keystroke transition delay (40ms-120ms)
      let delay = this.getRandomRange(40, 120);

      // Punctuation boundary rules
      if (['.', '?', '!'].includes(char)) {
        delay = this.getRandomRange(400, 900); // Macroscopic pause after sentence boundary
      } else if ([',', ';', ':'].includes(char)) {
        delay = this.getRandomRange(200, 500); // Clause marker pause
      }

      await page.waitForTimeout(delay);
    }
  }
}
